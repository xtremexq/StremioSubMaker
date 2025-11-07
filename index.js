// Load logger utility first to intercept all console methods with timestamps
require('./src/utils/logger');

const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { LRUCache } = require('lru-cache');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { parseConfig, getDefaultConfig, buildManifest } = require('./src/utils/config');
const { getAllLanguages, getLanguageName } = require('./src/utils/languages');
const { createSubtitleHandler, handleSubtitleDownload, handleTranslation, getAvailableSubtitlesForTranslation, hasCachedTranslation, purgeTranslationCache } = require('./src/handlers/subtitles');
const GeminiService = require('./src/services/gemini');
const {
    validateRequest,
    subtitleParamsSchema,
    translationParamsSchema,
    translationSelectorParamsSchema,
    fileTranslationBodySchema
} = require('./src/utils/validation');
const { getSessionManager } = require('./src/utils/sessionManager');

const PORT = process.env.PORT || 7001;

// Initialize session manager with environment-based configuration
const sessionManager = getSessionManager({
    maxSessions: parseInt(process.env.MAX_SESSIONS) || 1000,
    maxAge: parseInt(process.env.SESSION_MAX_AGE) || 90 * 24 * 60 * 60 * 1000, // 90 days (3 months)
    autoSaveInterval: parseInt(process.env.SESSION_SAVE_INTERVAL) || 5 * 60 * 1000, // 5 minutes
    persistencePath: process.env.SESSION_PERSISTENCE_PATH || path.join(process.cwd(), 'data', 'sessions.json')
});

// Security: LRU cache for routers to avoid creating them on every request (max 100 entries)
const routerCache = new LRUCache({
    max: 100, // Max 100 different configs cached
    ttl: 1000 * 60 * 60, // 1 hour TTL
    updateAgeOnGet: true,
});

// Security: LRU cache for request deduplication to prevent duplicate processing (max 500 entries)
const inFlightRequests = new LRUCache({
    max: 500, // Max 500 in-flight requests
    ttl: 180000, // 3 minutes (translations can take a while)
    updateAgeOnGet: false,
});

// Security: LRU cache for first-click tracking (max 1000 entries)
const firstClickTracker = new LRUCache({
    max: 1000, // Max 1000 tracked clicks
    ttl: 300000, // 5 minutes
    updateAgeOnGet: false,
});

/**
 * Deduplicates requests by caching in-flight promises
 * @param {string} key - Unique key for the request
 * @param {Function} fn - Function to execute if not already in flight
 * @returns {Promise} - Promise result
 */
async function deduplicate(key, fn) {
    // Check if request is already in flight
    const cached = inFlightRequests.get(key);
    if (cached) {
        // Don't log here - let caller handle logging for clearer context
        return cached.promise;
    }

    // Create new promise and cache it
    console.log(`[Dedup] Starting new operation for: ${key}`);
    const promise = fn();

    inFlightRequests.set(key, { promise });

    try {
        const result = await promise;
        console.log(`[Dedup] Operation completed successfully: ${key}`);
        return result;
    } catch (error) {
        console.error(`[Dedup] Operation failed: ${key}`, error.message);
        throw error;
    } finally {
        // Clean up immediately after completion
        inFlightRequests.delete(key);
    }
}

// Create Express app
const app = express();
app.set('trust proxy', 1)

// Helper: compute a short hash for a config string (used to scope temp cache per user/config)
function computeConfigHash(configStr) {
    try {
        return crypto.createHash('sha256').update(String(configStr)).digest('hex').slice(0, 16);
    } catch (_) {
        return '';
    }
}

// Helper: Check if request is from localhost
function isLocalhost(req) {
    const host = req.get('host') || '';
    return host.startsWith('localhost') || host.startsWith('127.0.0.1');
}

// Security: Add security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"], // Allow inline styles for HTML pages
            scriptSrc: ["'self'", "'unsafe-inline'"], // Allow inline scripts for HTML pages
            imgSrc: ["'self'", "data:"],
            // Don't upgrade insecure requests for localhost (would break HTTP logo loading)
            upgradeInsecureRequests: null,
        },
    },
    crossOriginEmbedderPolicy: false, // Disable for Stremio compatibility
    crossOriginResourcePolicy: false, // Disable to allow Stremio to load logo/images
    strictTransportSecurity: false, // Disable HSTS for localhost (allows HTTP)
}));

// Security: Rate limiting for subtitle searches and translations
const searchLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 20, // 20 requests per minute
    message: 'Too many subtitle requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Security: Rate limiting for file translations (more restrictive)
const fileTranslationLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 5, // 5 file translations per minute
    message: 'Too many file translation requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Enable gzip compression for all responses
app.use(compression({
    threshold: 1024, // Only compress responses larger than 1KB
    level: 6 // Compression level (0-9, 6 is a good balance)
}));

// Security: Restrict CORS to prevent browser-based CSRF attacks
// Stremio native clients don't send Origin headers, so we block browser requests for sensitive API routes
// This prevents malicious websites from triggering expensive API calls
app.use((req, res, next) => {
    const origin = req.get('origin');

    // Routes that MUST be accessible from browsers (configuration UI, file upload, etc.)
    const browserAllowedRoutes = [
        '/',
        '/configure',
        '/file-upload',
        '/api/languages',
        '/api/test-opensubtitles',
        '/api/gemini-models',
        '/api/translate-file',
        '/addon/:config/translate-selector/',
        '/addon/:config/file-translate/'
    ];

    // Allow static files and browser-accessible routes
    const isBrowserAllowed =
        req.path.startsWith('/public/') ||
        req.path.endsWith('.css') ||
        req.path.endsWith('.js') ||
        req.path.endsWith('.html') ||
        browserAllowedRoutes.some(route => req.path === route || req.path.startsWith(route));

    if (isBrowserAllowed) {
        return cors()(req, res, next);
    }

    // For sensitive API routes (/addon/:config/subtitle/, /addon/:config/translate/, etc.):
    // Allow requests with no origin (Stremio native clients, curl, direct access)
    if (!origin) {
        return cors()(req, res, next);
    }

    // Block browser-based requests to sensitive API routes (they send Origin header)
    // This prevents cross-site cost abuse attacks from malicious websites
    return res.status(403).json({
        error: 'Browser-based cross-origin requests to this API route are not allowed. Please use the Stremio client.'
    });
});

// Security: Limit JSON payload size to 1MB (for file uploads)
app.use(express.json({ limit: '1mb' }));

// Serve static files with caching enabled
// CSS and JS files get 1 year cache (bust with version in filename if needed)
// Other static files get 1 year cache as well
app.use(express.static('public', {
    maxAge: '1y',  // 1 year in milliseconds = 31536000000
    etag: true     // Enable ETag for cache validation
}));

// Serve configuration page with caching enabled
app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year cache for HTML
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

app.get('/configure', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year cache for HTML
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// API endpoint to get all languages
app.get('/api/languages', (req, res) => {
    try {
        const languages = getAllLanguages();
        res.json(languages);
    } catch (error) {
        console.error('[API] Error getting languages:', error);
        res.status(500).json({ error: 'Failed to get languages' });
    }
});

// Test endpoint for OpenSubtitles API
app.get('/api/test-opensubtitles', async (req, res) => {
    try {
        const OpenSubtitlesService = require('./src/services/opensubtitles');
        const opensubtitles = new OpenSubtitlesService();
        
        // Test with a known movie (The Matrix - tt0133093)
        const testParams = {
            imdb_id: 'tt0133093',
            type: 'movie',
            languages: ['eng', 'spa']
        };
        
        console.log('[Test] Testing OpenSubtitles with:', testParams);
        const results = await opensubtitles.searchSubtitles(testParams);
        
        res.json({
            success: true,
            count: results.length,
            results: results.slice(0, 5) // Return first 5 results
        });
    } catch (error) {
        console.error('[Test] Error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message
        });
    }
});

// API endpoint to fetch Gemini models
app.post('/api/gemini-models', async (req, res) => {
    try {
        const { apiKey } = req.body;

        if (!apiKey) {
            return res.status(400).json({ error: 'API key is required' });
        }

        const gemini = new GeminiService(apiKey);
        const models = await gemini.getAvailableModels();

        res.json(models);
    } catch (error) {
        console.error('[API] Error fetching Gemini models:', error);
        res.status(500).json({ error: 'Failed to fetch models' });
    }
});

// API endpoint to create a session (production mode)
app.post('/api/create-session', async (req, res) => {
    try {
        const config = req.body;

        if (!config) {
            return res.status(400).json({ error: 'Configuration is required' });
        }

        // For localhost, can use either session or base64 (backward compatibility)
        const localhost = isLocalhost(req);

        if (localhost && process.env.FORCE_SESSIONS !== 'true') {
            // For localhost, return base64 encoded config (old method)
            const configStr = Buffer.from(JSON.stringify(config), 'utf-8').toString('base64');
            console.log('[Session API] Localhost detected - using base64 encoding');
            return res.json({
                token: configStr,
                type: 'base64',
                message: 'Using base64 encoding for localhost'
            });
        }

        // Production mode: create session
        const token = sessionManager.createSession(config);
        console.log(`[Session API] Created session token: ${token}`);

        res.json({
            token,
            type: 'session',
            expiresIn: process.env.SESSION_MAX_AGE || 90 * 24 * 60 * 60 * 1000
        });
    } catch (error) {
        console.error('[Session API] Error creating session:', error);
        res.status(500).json({ error: 'Failed to create session' });
    }
});

// API endpoint to update an existing session
app.post('/api/update-session/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const config = req.body;

        if (!config) {
            return res.status(400).json({ error: 'Configuration is required' });
        }

        if (!token) {
            return res.status(400).json({ error: 'Session token is required' });
        }

        // For localhost with base64, we can't update (create new instead)
        const localhost = isLocalhost(req);
        const isBase64Token = !/^[a-f0-9]{32}$/.test(token);

        if (localhost && isBase64Token && process.env.FORCE_SESSIONS !== 'true') {
            // For localhost base64, just return new encoded config
            const configStr = Buffer.from(JSON.stringify(config), 'utf-8').toString('base64');
            console.log('[Session API] Localhost detected - creating new base64 token');
            return res.json({
                token: configStr,
                type: 'base64',
                updated: true,
                message: 'Created new base64 token for localhost'
            });
        }

        // Try to update existing session
        const updated = sessionManager.updateSession(token, config);

        if (!updated) {
            // Session doesn't exist - create new one instead
            console.log(`[Session API] Session not found, creating new one`);
            const newToken = sessionManager.createSession(config);
            return res.json({
                token: newToken,
                type: 'session',
                updated: false,
                created: true,
                message: 'Session expired or not found, created new session',
                expiresIn: process.env.SESSION_MAX_AGE || 90 * 24 * 60 * 60 * 1000
            });
        }

        console.log(`[Session API] Updated session token: ${token}`);

        res.json({
            token,
            type: 'session',
            updated: true,
            message: 'Session configuration updated successfully'
        });
    } catch (error) {
        console.error('[Session API] Error updating session:', error);
        res.status(500).json({ error: 'Failed to update session' });
    }
});

// API endpoint to get session statistics (for monitoring)
app.get('/api/session-stats', (req, res) => {
    try {
        const stats = sessionManager.getStats();
        res.json(stats);
    } catch (error) {
        console.error('[Session API] Error getting stats:', error);
        res.status(500).json({ error: 'Failed to get session statistics' });
    }
});

// API endpoint to translate uploaded subtitle file
app.post('/api/translate-file', fileTranslationLimiter, validateRequest(fileTranslationBodySchema, 'body'), async (req, res) => {
    try {
        const { content, targetLanguage, configStr } = req.body;

        if (!content) {
            return res.status(400).send('Subtitle content is required');
        }

        if (!targetLanguage) {
            return res.status(400).send('Target language is required');
        }

        if (!configStr) {
            return res.status(400).send('Configuration is required');
        }

        console.log(`[File Translation API] Translating to ${targetLanguage}`);

        // Parse config
        const config = parseConfig(configStr, { isLocalhost: isLocalhost(req) });

        // Get language name for better translation context
        const targetLangName = getLanguageName(targetLanguage) || targetLanguage;

        // Initialize Gemini service with advanced settings
        const gemini = new GeminiService(
          config.geminiApiKey, 
          config.geminiModel,
          config.advancedSettings || {}
        );

        // Estimate token count
        const estimatedTokens = gemini.estimateTokenCount(content);
        console.log(`[File Translation API] Estimated tokens: ${estimatedTokens}`);

        // Translate
        let translatedContent;
        if (estimatedTokens > 7000) {
            // Use chunked translation for large files
            console.log('[File Translation API] Using chunked translation');
            translatedContent = await gemini.translateSubtitleInChunks(
                content,
                'detected source language',
                targetLangName,
                config.translationPrompt
            );
        } else {
            translatedContent = await gemini.translateSubtitle(
                content,
                'detected source language',
                targetLangName,
                config.translationPrompt
            );
        }

        console.log('[File Translation API] Translation completed');

        // Return translated content as plain text
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(translatedContent);

    } catch (error) {
        console.error('[File Translation API] Error:', error);
        res.status(500).send(`Translation failed: ${error.message}`);
    }
});

// Create addon builder with config
function createAddonWithConfig(config, baseUrl = '') {
    const manifest = buildManifest(config, baseUrl);

    const builder = new addonBuilder(manifest);

    // Define subtitle handler
    builder.defineSubtitlesHandler(createSubtitleHandler(config));

    return builder;
}

// Custom route: Download subtitle (BEFORE SDK router to take precedence)
app.get('/addon/:config/subtitle/:fileId/:language.srt', searchLimiter, validateRequest(subtitleParamsSchema, 'params'), async (req, res) => {
    try {
        const { config: configStr, fileId, language } = req.params;
        const config = parseConfig(configStr, { isLocalhost: isLocalhost(req) });
        config.__configHash = computeConfigHash(configStr);

        const langCode = language.replace('.srt', '');
        
        // Create deduplication key based on file ID and language
        const dedupKey = `download:${configStr}:${fileId}:${langCode}`;

        // Check if already in flight BEFORE logging
        const isAlreadyInFlight = inFlightRequests.has(dedupKey);
        
        if (isAlreadyInFlight) {
            console.log(`[Download] Duplicate request detected for ${fileId} in ${langCode} - waiting for in-flight download`);
        } else {
            console.log(`[Download] New request for subtitle ${fileId} in ${langCode}`);
        }

        // Deduplicate download requests
        const content = await deduplicate(dedupKey, () =>
            handleSubtitleDownload(fileId, langCode, config)
        );

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fileId}.srt"`);
        res.send(content);

    } catch (error) {
        console.error('[Download] Error:', error);
        res.status(404).send('Subtitle not found');
    }
});

// Custom route: Translation selector page (BEFORE SDK router to take precedence)
app.get('/addon/:config/translate-selector/:videoId/:targetLang', searchLimiter, validateRequest(translationSelectorParamsSchema, 'params'), async (req, res) => {
    try {
        const { config: configStr, videoId, targetLang } = req.params;
        const config = parseConfig(configStr, { isLocalhost: isLocalhost(req) });
        config.__configHash = computeConfigHash(configStr);

        // Create deduplication key based on video ID and config
        const dedupKey = `translate-selector:${configStr}:${videoId}:${targetLang}`;

        // Check if already in flight BEFORE logging
        const isAlreadyInFlight = inFlightRequests.has(dedupKey);
        
        if (isAlreadyInFlight) {
            console.log(`[Translation Selector] Duplicate request detected for ${videoId} to ${targetLang}`);
        } else {
            console.log(`[Translation Selector] New request for ${videoId} to ${targetLang}`);
        }

        // Get available subtitles with deduplication
        const subtitles = await deduplicate(dedupKey, () =>
            getAvailableSubtitlesForTranslation(videoId, config)
        );

        // Generate HTML page for subtitle selection
        const html = generateTranslationSelectorPage(subtitles, videoId, targetLang, configStr, config);

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);

    } catch (error) {
        console.error('[Translation Selector] Error:', error);
        res.status(500).send('Failed to load subtitle selector');
    }
});

// Custom route: Perform translation (BEFORE SDK router to take precedence)
app.get('/addon/:config/translate/:sourceFileId/:targetLang', searchLimiter, validateRequest(translationParamsSchema, 'params'), async (req, res) => {
    try {
        const { config: configStr, sourceFileId, targetLang } = req.params;
        const config = parseConfig(configStr, { isLocalhost: isLocalhost(req) });
        config.__configHash = computeConfigHash(configStr);

        // Create deduplication key based on source file and target language
        const dedupKey = `translate:${configStr}:${sourceFileId}:${targetLang}`;

        // Unusual purge: if same translated subtitle is loaded 5 times in < 10s, purge and retrigger
        try {
            const clickKey = `translate-click:${configStr}:${sourceFileId}:${targetLang}`;
            const now = Date.now();
            const windowMs = 10_000; // 10 seconds
            const entry = firstClickTracker.get(clickKey) || { times: [] };
            // Keep only clicks within window
            entry.times = (entry.times || []).filter(t => now - t <= windowMs);
            entry.times.push(now);
            firstClickTracker.set(clickKey, entry);

            if (entry.times.length >= 5) {
                // Reset the counter immediately to avoid loops
                firstClickTracker.set(clickKey, { times: [] });
                const hadCache = hasCachedTranslation(sourceFileId, targetLang, config);
                if (hadCache) {
                    console.log(`[PurgeTrigger] 5 rapid loads detected (<10s) for ${sourceFileId}/${targetLang}. Purging cache and re-triggering translation.`);
                    purgeTranslationCache(sourceFileId, targetLang, config);
                } else {
                    console.log(`[PurgeTrigger] 5 rapid loads detected but no cached translation found for ${sourceFileId}/${targetLang}. Skipping purge.`);
                }
            }
        } catch (e) {
            console.warn('[PurgeTrigger] Click tracking error:', e.message);
        }

        // Check if already in flight BEFORE logging to reduce confusion
        const isAlreadyInFlight = inFlightRequests.has(dedupKey);

        if (isAlreadyInFlight) {
            console.log(`[Translation] Duplicate request detected for ${sourceFileId} to ${targetLang} - waiting for in-flight translation`);
        } else {
            console.log(`[Translation] New request to translate ${sourceFileId} to ${targetLang}`);
        }

        // Deduplicate translation requests
        const subtitleContent = await deduplicate(dedupKey, () =>
            handleTranslation(sourceFileId, targetLang, config)
        );

        // Check if this is a loading message or actual translation
        const isLoadingMessage = subtitleContent.includes('Please wait while the selected subtitle is being translated') ||
                                 subtitleContent.includes('Translation is happening in the background') ||
                                 subtitleContent.includes('Click this subtitle again to confirm translation') ||
                                 subtitleContent.includes('TRANSLATION IN PROGRESS');
        console.log(`[Translation] Serving ${isLoadingMessage ? 'loading message' : 'translated content'} for ${sourceFileId} (was duplicate: ${isAlreadyInFlight})`);
        console.log(`[Translation] Content length: ${subtitleContent.length} characters, first 200 chars: ${subtitleContent.substring(0, 200)}`);

        // Don't use 'attachment' for loading messages - we want them to display inline
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        
        // Disable caching for loading messages so Stremio can poll for updates
        if (isLoadingMessage) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            console.log(`[Translation] Set no-cache headers for loading message`);
        } else {
            res.setHeader('Content-Disposition', `attachment; filename="translated_${targetLang}.srt"`);
        }
        
        res.send(subtitleContent);
        console.log(`[Translation] Response sent successfully for ${sourceFileId}`);

    } catch (error) {
        console.error('[Translation] Error:', error);
        res.status(500).send(`Translation failed: ${error.message}`);
    }
});

// Custom route: File translation page (BEFORE SDK router to take precedence)
app.get('/addon/:config/file-translate/:videoId', async (req, res) => {
    try {
        const { config: configStr, videoId } = req.params;
        const config = parseConfig(configStr, { isLocalhost: isLocalhost(req) });

        console.log(`[File Translation] Request for video ${videoId}`);

        // Redirect to the actual upload page
        // Using a separate non-addon route so browser opens it directly
        res.redirect(302, `/file-upload?config=${encodeURIComponent(configStr)}&videoId=${encodeURIComponent(videoId)}`);

    } catch (error) {
        console.error('[File Translation] Error:', error);
        res.status(500).send('Failed to load file translation page');
    }
});

// Actual file translation upload page (standalone, not under /addon route)
app.get('/file-upload', async (req, res) => {
    try {
        const { config: configStr, videoId } = req.query;

        if (!configStr || !videoId) {
            return res.status(400).send('Missing config or videoId');
        }

        const config = parseConfig(configStr, { isLocalhost: isLocalhost(req) });
        config.__configHash = computeConfigHash(configStr);

        console.log(`[File Upload Page] Loading page for video ${videoId}`);

        // Generate HTML page for file upload and translation
        const html = generateFileTranslationPage(videoId, configStr, config);

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);

    } catch (error) {
        console.error('[File Upload Page] Error:', error);
        res.status(500).send('Failed to load file translation page');
    }
});

// Generate HTML page for translation selector
function generateTranslationSelectorPage(subtitles, videoId, targetLang, configStr, config) {
    const targetLangName = getLanguageName(targetLang) || targetLang;
    const sourceLangs = config.sourceLanguages.map(lang => getLanguageName(lang) || lang).join(', ');

    const subtitleOptions = subtitles.map(sub => `
        <div class="subtitle-option">
            <a href="/addon/${configStr}/translate/${sub.fileId}/${targetLang}" class="subtitle-link">
                <div class="subtitle-info">
                    <div class="subtitle-name">${escapeHtml(sub.name)}</div>
                    <div class="subtitle-meta">
                        ${sub.language} • Downloads: ${sub.downloads} • Rating: ${sub.rating.toFixed(1)}
                    </div>
                </div>
            </a>
        </div>
    `).join('');

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Select Subtitle to Translate</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', sans-serif;
            background: linear-gradient(135deg, #0A0E27 0%, #1a1f3a 100%);
            color: #E8EAED;
            min-height: 100vh;
            padding: 2rem 1rem;
        }

        .container {
            max-width: 800px;
            margin: 0 auto;
        }

        h1 {
            text-align: center;
            margin-bottom: 0.5rem;
            font-size: 2rem;
            background: linear-gradient(135deg, #9B88FF 0%, #7B68EE 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .subtitle-header {
            text-align: center;
            margin-bottom: 2rem;
            color: #9AA0A6;
            font-size: 0.95rem;
        }

        .subtitle-option {
            background: #141931;
            border: 2px solid #2A3247;
            border-radius: 12px;
            margin-bottom: 1rem;
            transition: all 0.3s ease;
        }

        .subtitle-option:hover {
            border-color: #7B68EE;
            transform: translateY(-2px);
            box-shadow: 0 8px 20px rgba(123, 104, 238, 0.3);
        }

        .subtitle-link {
            display: block;
            padding: 1.5rem;
            text-decoration: none;
            color: inherit;
        }

        .subtitle-name {
            font-size: 1.1rem;
            font-weight: 600;
            margin-bottom: 0.5rem;
        }

        .subtitle-meta {
            font-size: 0.9rem;
            color: #9AA0A6;
        }

        .no-subtitles {
            text-align: center;
            padding: 3rem;
            color: #9AA0A6;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Translate to ${targetLangName}</h1>
        <div class="subtitle-header">Select a ${sourceLangs} subtitle to translate</div>
        ${subtitles.length > 0 ? subtitleOptions : `<div class="no-subtitles">No ${sourceLangs} subtitles available</div>`}
    </div>
</body>
</html>
    `;
}

// Security: Enhanced HTML escaping to prevent XSS attacks
function escapeHtml(text) {
    if (text == null) return '';

    // Convert to string
    text = String(text);

    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#x27;',
        '/': '&#x2F;',
        '`': '&#x60;',
        '=': '&#x3D;'
    };

    // Escape basic HTML entities
    text = text.replace(/[&<>"'`=\/]/g, m => map[m]);

    // Additional protection: Escape unicode control characters
    text = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, ch => {
        return '&#' + ch.charCodeAt(0) + ';';
    });

    return text;
}

// Generate HTML page for file translation
function generateFileTranslationPage(videoId, configStr, config) {
    const targetLangs = config.targetLanguages.map(lang => {
        const langName = getLanguageName(lang) || lang;
        return { code: lang, name: langName };
    });

    const languageOptions = targetLangs.map(lang =>
        `<option value="${escapeHtml(lang.code)}">${escapeHtml(lang.name)}</option>`
    ).join('');

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>File Translation</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', sans-serif;
            background: linear-gradient(135deg, #0A0E27 0%, #1a1f3a 100%);
            color: #E8EAED;
            min-height: 100vh;
            padding: 2rem 1rem;
        }

        .container {
            max-width: 600px;
            margin: 0 auto;
        }

        h1 {
            text-align: center;
            margin-bottom: 0.5rem;
            font-size: 2rem;
            background: linear-gradient(135deg, #9B88FF 0%, #7B68EE 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .subtitle-header {
            text-align: center;
            margin-bottom: 2rem;
            color: #9AA0A6;
            font-size: 0.95rem;
        }

        .form-section {
            background: #141931;
            border: 2px solid #2A3247;
            border-radius: 12px;
            padding: 2rem;
            margin-bottom: 1.5rem;
        }

        .form-group {
            margin-bottom: 1.5rem;
        }

        .form-group:last-child {
            margin-bottom: 0;
        }

        label {
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 600;
            color: #E8EAED;
        }

        .file-input-wrapper {
            position: relative;
            overflow: hidden;
            display: inline-block;
            width: 100%;
        }

        .file-input-wrapper input[type=file] {
            position: absolute;
            left: -9999px;
        }

        .file-input-label {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 1rem;
            background: #2A3247;
            color: #9B88FF;
            border: 2px dashed #7B68EE;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.3s ease;
            text-align: center;
        }

        .file-input-label:hover {
            background: #323A52;
            border-color: #9B88FF;
        }

        .file-name {
            margin-top: 0.5rem;
            font-size: 0.9rem;
            color: #9AA0A6;
        }

        select {
            width: 100%;
            padding: 0.75rem;
            background: #2A3247;
            color: #E8EAED;
            border: 2px solid #2A3247;
            border-radius: 8px;
            font-size: 1rem;
            cursor: pointer;
            transition: all 0.3s ease;
        }

        select:hover {
            border-color: #7B68EE;
        }

        select:focus {
            outline: none;
            border-color: #9B88FF;
        }

        .btn {
            width: 100%;
            padding: 1rem;
            background: linear-gradient(135deg, #9B88FF 0%, #7B68EE 100%);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 1.1rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
        }

        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 20px rgba(123, 104, 238, 0.4);
        }

        .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }

        .progress {
            display: none;
            text-align: center;
            padding: 1.5rem;
            color: #9AA0A6;
        }

        .progress.active {
            display: block;
        }

        .spinner {
            border: 3px solid #2A3247;
            border-top: 3px solid #7B68EE;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto 1rem;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .result {
            display: none;
            background: #141931;
            border: 2px solid #2A3247;
            border-radius: 12px;
            padding: 2rem;
            text-align: center;
        }

        .result.active {
            display: block;
        }

        .result h2 {
            color: #9B88FF;
            margin-bottom: 1rem;
        }

        .result .download-btn {
            display: inline-block;
            margin-top: 1rem;
            padding: 0.75rem 2rem;
            background: linear-gradient(135deg, #9B88FF 0%, #7B68EE 100%);
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-weight: 600;
            transition: all 0.3s ease;
        }

        .result .download-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 20px rgba(123, 104, 238, 0.4);
        }

        .error {
            display: none;
            background: #2A1F1F;
            border: 2px solid #D32F2F;
            border-radius: 12px;
            padding: 1.5rem;
            margin-top: 1rem;
            color: #FF6B6B;
        }

        .error.active {
            display: block;
        }

        .info-box {
            background: #1a2332;
            border-left: 4px solid #7B68EE;
            padding: 1rem;
            margin-bottom: 1.5rem;
            border-radius: 4px;
            font-size: 0.9rem;
            color: #9AA0A6;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📁 File Translation</h1>
        <div class="subtitle-header">Upload your subtitle file and translate it</div>

        <div class="info-box">
            <strong>How to use:</strong>
            <ol style="margin-left: 1.5rem; margin-top: 0.5rem;">
                <li>Upload your .srt subtitle file</li>
                <li>Select the target language</li>
                <li>Click "Translate"</li>
                <li>Download the translated subtitle</li>
                <li>Load the downloaded file into Stremio manually</li>
            </ol>
        </div>

        <form id="translationForm" class="form-section">
            <div class="form-group">
                <label for="fileInput">Select Subtitle File (.srt)</label>
                <div class="file-input-wrapper">
                    <input type="file" id="fileInput" accept=".srt" required>
                    <label for="fileInput" class="file-input-label">
                        📄 Click to select .srt file
                    </label>
                </div>
                <div class="file-name" id="fileName"></div>
            </div>

            <div class="form-group">
                <label for="targetLang">Target Language</label>
                <select id="targetLang" required>
                    <option value="">Select a language...</option>
                    ${languageOptions}
                </select>
            </div>

            <button type="submit" class="btn" id="translateBtn">Translate</button>
        </form>

        <div class="progress" id="progress">
            <div class="spinner"></div>
            <p>Translating your subtitle file...</p>
            <p style="font-size: 0.9rem; margin-top: 0.5rem;">This may take a minute depending on the file size.</p>
        </div>

        <div class="result" id="result">
            <h2>✓ Translation Complete!</h2>
            <p>Your subtitle has been translated successfully.</p>
            <a href="#" id="downloadLink" class="download-btn" download="translated.srt">Download Translated Subtitle</a>
            <p style="margin-top: 1rem; font-size: 0.9rem; color: #9AA0A6;">
                After downloading, go to Stremio and manually load this subtitle file.
            </p>
        </div>

        <div class="error" id="error"></div>
    </div>

    <script>
        const form = document.getElementById('translationForm');
        const fileInput = document.getElementById('fileInput');
        const fileName = document.getElementById('fileName');
        const targetLang = document.getElementById('targetLang');
        const translateBtn = document.getElementById('translateBtn');
        const progress = document.getElementById('progress');
        const result = document.getElementById('result');
        const error = document.getElementById('error');
        const downloadLink = document.getElementById('downloadLink');

        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                fileName.textContent = '📄 ' + e.target.files[0].name;
            } else {
                fileName.textContent = '';
            }
        });

        form.addEventListener('submit', async (e) => {
            e.preventDefault();

            const file = fileInput.files[0];
            if (!file) {
                showError('Please select a subtitle file');
                return;
            }

            if (!targetLang.value) {
                showError('Please select a target language');
                return;
            }

            // Hide previous results/errors
            result.classList.remove('active');
            error.classList.remove('active');
            form.style.display = 'none';
            progress.classList.add('active');

            try {
                // Read file content
                const fileContent = await file.text();

                // Send to translation API
                const response = await fetch('/api/translate-file', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        content: fileContent,
                        targetLanguage: targetLang.value,
                        configStr: '${configStr}'
                    })
                });

                if (!response.ok) {
                    throw new Error('Translation failed: ' + await response.text());
                }

                const translatedContent = await response.text();

                // Create download link
                const blob = new Blob([translatedContent], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                downloadLink.href = url;
                downloadLink.download = 'translated_' + targetLang.value + '.srt';

                // Show result
                progress.classList.remove('active');
                result.classList.add('active');

            } catch (err) {
                console.error('Translation error:', err);
                progress.classList.remove('active');
                form.style.display = 'block';
                showError(err.message);
            }
        });

        function showError(message) {
            error.textContent = '⚠ ' + message;
            error.classList.add('active');
        }
    </script>
</body>
</html>
    `;
}

// Middleware to replace {{ADDON_URL}} placeholder in responses
// This is CRITICAL because Stremio SDK uses res.end() not res.json()
app.use('/addon/:config', (req, res, next) => {
    const config = req.params.config;

    // Construct base URL from request (same logic as manifest route)
    const host = req.get('host');
    const localhost = isLocalhost(req);
    // For remote hosts, enforce HTTPS unless proxy header specifies otherwise
    const protocol = localhost
        ? (req.get('x-forwarded-proto') || req.protocol)
        : (req.get('x-forwarded-proto') || 'https');
    const addonUrl = `${protocol}://${host}/addon/${config}`;

    // Intercept both res.json() and res.end() to replace {{ADDON_URL}} placeholder
    const originalJson = res.json;
    res.json = function(obj) {
        const jsonStr = JSON.stringify(obj);
        const replaced = jsonStr.replace(/\{\{ADDON_URL\}\}/g, addonUrl);
        const parsed = JSON.parse(replaced);
        return originalJson.call(this, parsed);
    };

    const originalEnd = res.end;
    res.end = function(chunk, encoding) {
        if (chunk && typeof chunk === 'string') {
            // Replace {{ADDON_URL}} with actual addon URL
            chunk = chunk.replace(/\{\{ADDON_URL\}\}/g, addonUrl);
        }
        originalEnd.call(this, chunk, encoding);
    };

    next();
});

// Stremio addon manifest route (AFTER middleware so URLs get replaced)
app.get('/addon/:config/manifest.json', (req, res) => {
    try {
        console.log(`[Manifest] Parsing config for manifest request`);
        const localhost = isLocalhost(req);
        const config = parseConfig(req.params.config, { isLocalhost: localhost });
        config.__configHash = computeConfigHash(req.params.config);

        // Construct base URL from request
        const host = req.get('host');
        // For remote hosts, enforce HTTPS unless proxy header specifies otherwise.
        const protocol = localhost
            ? (req.get('x-forwarded-proto') || req.protocol)
            : (req.get('x-forwarded-proto') || 'https');
        const baseUrl = `${protocol}://${host}`;
        console.log(`[Manifest] Using base URL: ${baseUrl}`);

        const builder = createAddonWithConfig(config, baseUrl);
        const manifest = builder.getInterface().manifest;

        res.json(manifest);
    } catch (error) {
        console.error('[Manifest] Error:', error);
        res.status(500).json({ error: 'Failed to generate manifest' });
    }
});

// Mount Stremio SDK router for each configuration
app.use('/addon/:config', (req, res, next) => {
    try {
        const configStr = req.params.config;

        // Check cache first
        if (!routerCache.has(configStr)) {
            console.log(`[Router] Parsing config for new router (path: ${req.path})`);
            const localhost = isLocalhost(req);
            const config = parseConfig(configStr, { isLocalhost: localhost });
            config.__configHash = computeConfigHash(configStr);

            // Construct base URL from request
            const host = req.get('host');
            // For remote hosts, enforce HTTPS unless proxy header specifies otherwise.
            const protocol = localhost
                ? (req.get('x-forwarded-proto') || req.protocol)
                : (req.get('x-forwarded-proto') || 'https');
            const baseUrl = `${protocol}://${host}`;

            const builder = createAddonWithConfig(config, baseUrl);
            const router = getRouter(builder.getInterface());
            routerCache.set(configStr, router);
            console.log(`[Router] Created and cached router for config`);
        }

        const router = routerCache.get(configStr);
        router(req, res, next);
    } catch (error) {
        console.error('[Router] Error:', error);
        next(error);
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('[Server] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🎬 SubMaker - Subtitle Translator Addon                ║
║                                                           ║
║   Server running on: http://localhost:${PORT}            ║
║                                                           ║
║   Configure addon: http://localhost:${PORT}/configure    ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
    `);
});

module.exports = app;
