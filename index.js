// Load environment variables from .env file FIRST (before anything else)
require('dotenv').config();

// Load logger utility first to intercept all console methods with timestamps
const log = require('./src/utils/logger');

const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { LRUCache } = require('lru-cache');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { parseConfig, getDefaultConfig, buildManifest } = require('./src/utils/config');
const { version } = require('./src/utils/version');
const { getAllLanguages, getLanguageName } = require('./src/utils/languages');
const { generateCacheKeys } = require('./src/utils/cacheKeys');
const { getCached: getDownloadCached, saveCached: saveDownloadCached, getCacheStats: getDownloadCacheStats } = require('./src/utils/downloadCache');
const { createSubtitleHandler, handleSubtitleDownload, handleTranslation, getAvailableSubtitlesForTranslation, createLoadingSubtitle, createSessionTokenErrorSubtitle, readFromPartialCache, readFromBypassCache, hasCachedTranslation, purgeTranslationCache, translationStatus, canUserStartTranslation } = require('./src/handlers/subtitles');
const GeminiService = require('./src/services/gemini');
const { translateInParallel } = require('./src/utils/parallelTranslation');
const syncCache = require('./src/utils/syncCache');
const { generateSubtitleSyncPage } = require('./src/utils/syncPageGenerator');
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
// Limit to 50,000 sessions to prevent unbounded memory growth while allowing for production scale
const sessionManager = getSessionManager({
    maxSessions: parseInt(process.env.SESSION_MAX_SESSIONS) || 50000, // Limit to 50k concurrent sessions
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

// Download cache is now in src/utils/downloadCache.js (shared with translation flow)

/**
 * Deduplicates requests by caching in-flight promises
 * @param {string} key - Unique key for the request
 * @param {Function} fn - Function to execute if not already in flight
 * @returns {Promise} - Promise result
 */
async function deduplicate(key, fn) {
    // Helper: Create short key hash for logging (first 8 chars of SHA1)
    const shortKey = (() => {
        try {
            return crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 8);
        } catch (_) {
            const s = String(key || '');
            return s.length > 12 ? s.slice(0, 12) + '…' : s;
        }
    })();

    // Check if request is already in flight
    const cached = inFlightRequests.get(key);
    if (cached) {
        log.debug(() => `[Dedup] Returning cached promise for duplicate request: ${shortKey}`);
        const result = await cached.promise;
        log.debug(() => `[Dedup] Duplicate request completed with result length: ${result ? result.length : 'undefined/null'}`);
        return result;
    }

    // Create new promise and cache it
    log.debug(() => `[Dedup] Starting new operation: ${shortKey}`);
    const promise = fn();

    inFlightRequests.set(key, { promise });

    try {
        const result = await promise;
        log.debug(() => `[Dedup] Operation completed: ${shortKey}, result length: ${result ? result.length : 'undefined/null'}`);
        return result;
    } catch (error) {
        log.error(() => `[Dedup] Operation failed: ${shortKey}`, error.message);
        throw error;
    } finally {
        // Clean up immediately after completion
        inFlightRequests.delete(key);
    }
}

// Create Express app
const app = express();
app.set('trust proxy', 1)

// Helper: compute a short hash for a config string (used to scope bypass cache per user/config)
function computeConfigHash(configStr) {
    try {
        // Validate input - empty/undefined configs should get a consistent but identifiable hash
        if (!configStr || configStr === 'undefined' || configStr === 'null' || String(configStr).trim().length === 0) {
            log.warn(() => '[ConfigHash] Received empty/invalid config string for hashing');
            // Return a special marker hash for empty configs instead of empty string
            // This ensures they don't collide with failed hash generation
            return 'empty_config_00';
        }

        const hash = crypto.createHash('sha256').update(String(configStr)).digest('hex').slice(0, 16);

        if (!hash || hash.length === 0) {
            throw new Error('Hash generation returned empty result');
        }

        return hash;
    } catch (error) {
        log.error(() => ['[ConfigHash] Failed to compute config hash:', error.message]);
        // Return a fallback hash that indicates failure but is still unique enough
        // Use timestamp to ensure different failures don't collide
        return `hash_error_${Date.now().toString(36).slice(-8)}`;
    }
}

// Helper: Check if request is from localhost or private network
function isLocalhost(req) {
    const host = req.get('host') || '';
    const hostname = host.split(':')[0]; // Extract hostname without port

    return (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        // Private network ranges (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
        hostname.startsWith('192.168.') ||
        hostname.startsWith('10.') ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)
    );
}

/**
 * Safety check for 3-click cache reset during active translation
 * Prevents cache reset if translation is currently in progress OR if user cannot start a new translation
 *
 * This checks BOTH translationStatus AND inFlightTranslations to ensure
 * we catch translations that just started but haven't set status yet.
 * Also checks the concurrency limit to prevent purging cache when re-translation would fail.
 *
 * @param {string} clickKey - The click tracker key (includes config and fileId)
 * @param {string} sourceFileId - The subtitle file ID
 * @param {object} config - The user's config object
 * @param {string} targetLang - The target language
 * @returns {boolean} - True if the 3-click cache reset should be BLOCKED
 */
function shouldBlockCacheReset(clickKey, sourceFileId, config, targetLang) {
    try {
        const clickEntry = firstClickTracker.get(clickKey);

        if (!clickEntry || !clickEntry.times || clickEntry.times.length < 3) {
            return false; // Not enough clicks yet
        }

        // Determine which cache type the user is using
        const bypass = config && config.bypassCache === true;
        const bypassCfg = (config && (config.bypassCacheConfig || config.tempCache)) || {};
        const bypassEnabled = bypass && (bypassCfg.enabled !== false);

        const configHash = (config && typeof config.__configHash === 'string' && config.__configHash.length > 0)
            ? config.__configHash
            : '';

        const baseCacheKey = `${sourceFileId}_${targetLang}`;

        // SAFETY CHECK 1: Check if the user is at their concurrency limit
        // If they are, don't allow the 3-click reset because re-translation would fail with rate limit error
        if (!canUserStartTranslation(configHash)) {
            log.warn(() => `[SafetyBlock] BLOCKING 3-click reset: User at concurrency limit, re-translation would fail (user: ${configHash || 'anonymous'})`);
            return true;
        }

        if (bypassEnabled && configHash) {
            // USER IS USING BYPASS CACHE
            // Only block if THIS user's bypass translation is in progress
            const userScopedKey = `${baseCacheKey}__u_${configHash}`;

            // Check BOTH translationStatus AND inFlightTranslations for maximum safety
            const status = translationStatus.get(userScopedKey);
            const inFlight = inFlightTranslations.has(userScopedKey);

            if (!status && !inFlight) {
                return false; // Not in progress, allow reset
            }

            if (status && status.inProgress) {
                log.warn(() => `[SafetyBlock] BLOCKING bypass cache reset: User's translation IN PROGRESS for ${sourceFileId}/${targetLang} (user: ${configHash})`);
                return true;
            }

            if (inFlight) {
                log.warn(() => `[SafetyBlock] BLOCKING bypass cache reset: User's translation IN-FLIGHT for ${sourceFileId}/${targetLang} (user: ${configHash})`);
                return true;
            }

        } else {
            // USER IS USING PERMANENT CACHE (shared between all users)
            // Block if ANY permanent cache translation is in progress
            const status = translationStatus.get(baseCacheKey);
            const inFlight = inFlightTranslations.has(baseCacheKey);

            if (!status && !inFlight) {
                return false; // Not in progress, allow reset
            }

            if (status && status.inProgress) {
                log.warn(() => `[SafetyBlock] BLOCKING permanent cache reset: Shared translation IN PROGRESS for ${sourceFileId}/${targetLang}`);
                return true;
            }

            if (inFlight) {
                log.warn(() => `[SafetyBlock] BLOCKING permanent cache reset: Shared translation IN-FLIGHT for ${sourceFileId}/${targetLang}`);
                return true;
            }
        }

        return false;
    } catch (e) {
        log.warn(() => '[SafetyBlock] Error checking cache reset safety:', e.message);
        return false; // On error, allow the reset to proceed
    }
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
// Uses session ID or config hash instead of IP for better HA deployment support
// This prevents all users behind a load balancer from sharing the same rate limit
const searchLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute per user (increased from 20 for HA support)
    message: 'Too many subtitle requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        // Try session ID first (if sessions are enabled)
        if (req.session?.id) {
            return `session:${req.session.id}`;
        }
        // Try config hash from params (most common for Stremio addons)
        if (req.params?.config) {
            try {
                return `config:${computeConfigHash(req.params.config)}`;
            } catch (e) {
                // Fall through to IP if config parsing fails
            }
        }
        // Try config from body (for API endpoints)
        if (req.body?.configStr) {
            try {
                return `config:${computeConfigHash(req.body.configStr)}`;
            } catch (e) {
                // Fall through to IP if config parsing fails
            }
        }
        // Fallback to IP address for non-authenticated requests
        // Use ipKeyGenerator to properly handle IPv6 subnet masking
        return `ip:${ipKeyGenerator(req.ip)}`;
    },
    skip: (req) => {
        // Skip rate limiting for cached subtitle search results
        // This check is performed after cache lookup in the handler
        return req.fromSubtitleCache === true;
    }
});

// Security: Rate limiting for file translations (more restrictive)
// Uses session ID or config hash instead of IP for better HA deployment support
const fileTranslationLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 10, // 10 file translations per minute per user (increased from 5 for HA support)
    message: 'Too many file translation requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        // Try session ID first (if sessions are enabled)
        if (req.session?.id) {
            return `session:${req.session.id}`;
        }
        // Try config hash from request body
        if (req.body?.configStr) {
            try {
                return `config:${computeConfigHash(req.body.configStr)}`;
            } catch (e) {
                // Fall through to IP if config parsing fails
            }
        }
        // Fallback to IP address for non-authenticated requests
        // Use ipKeyGenerator to properly handle IPv6 subnet masking
        return `ip:${ipKeyGenerator(req.ip)}`;
    }
});

// Enable gzip compression for all responses
// SRT files compress extremely well (typically 5-10x reduction)
// Use maximum compression (level 9) for best bandwidth savings
app.use(compression({
    threshold: 512, // Compress responses larger than 512 bytes (was 1KB)
    level: 9, // Maximum compression for SRT files (10-15x reduction)
    filter: (req, res) => {
        // Only compress text-based responses
        const contentType = res.getHeader('content-type');
        if (typeof contentType === 'string' &&
            (contentType.includes('text/') || contentType.includes('application/json') || contentType.includes('application/javascript'))) {
            return true;
        }
        // Default compression filter
        return compression.filter(req, res);
    }
}));

// Expose version on all responses
app.use((req, res, next) => {
    try { res.setHeader('X-SubMaker-Version', version); } catch (_) {}
    next();
});

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
        // Allow config page to call validation/test endpoints from browser
        '/api/validate-gemini',
        '/api/validate-subsource',
        '/api/validate-subdl',
        '/api/validate-opensubtitles',
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

// CRITICAL FIX: Ensure session manager is ready before handling requests
// This prevents "session not found" errors on server startup
// Applies to ALL routes that may access sessions
let sessionManagerReady = false;
sessionManager.waitUntilReady().then(() => {
    sessionManagerReady = true;
    log.info(() => '[Server] Session manager is ready to accept requests');
}).catch(err => {
    log.error(() => ['[Server] Session manager failed to initialize:', err.message]);
    // Mark as ready anyway to prevent blocking startup indefinitely
    sessionManagerReady = true;
});

// Middleware: Wait for session manager to be ready (for production use)
// Skip for localhost to allow local testing without session persistence
if (process.env.FORCE_SESSION_READY !== 'false') {
    app.use(async (req, res, next) => {
        // Skip static files, HTML, and public API endpoints
        if (req.path.startsWith('/public/') ||
            req.path.endsWith('.css') ||
            req.path.endsWith('.js') ||
            req.path.endsWith('.html') ||
            req.path === '/' ||
            req.path === '/configure') {
            return next();
        }

        // For other routes, ensure sessions are ready
        if (!sessionManagerReady) {
            try {
                await sessionManager.waitUntilReady();
                sessionManagerReady = true;
            } catch (err) {
                log.error(() => ['[SessionReadiness] Failed to wait for session manager:', err.message]);
                sessionManagerReady = true;
            }
        }

        next();
    });
}

// Serve configuration page with caching enabled
app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year cache for HTML
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

app.get('/configure', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year cache for HTML
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Health check endpoint for Kubernetes/Docker readiness and liveness probes
app.get('/health', async (req, res) => {
    try {
        const { getStorageAdapter } = require('./src/storage/StorageFactory');
        const { StorageAdapter } = require('./src/storage');

        // Check storage health
        let storageHealthy = false;
        let storageType = process.env.STORAGE_TYPE || 'filesystem';

        try {
            const adapter = await getStorageAdapter();
            storageHealthy = await adapter.healthCheck();
        } catch (error) {
            log.warn(() => `[Health] Storage health check failed: ${error.message}`);
        }

        // Get cache sizes if storage is healthy
        let cacheSizes = {};
        if (storageHealthy) {
            try {
                const adapter = await getStorageAdapter();
                for (const [name, type] of Object.entries(StorageAdapter.CACHE_TYPES)) {
                    const sizeBytes = await adapter.size(type);
                    const limitBytes = StorageAdapter.SIZE_LIMITS[type];
                    cacheSizes[type] = {
                        current: sizeBytes,
                        currentMB: (sizeBytes / (1024 * 1024)).toFixed(2),
                        limit: limitBytes,
                        limitMB: limitBytes ? (limitBytes / (1024 * 1024)).toFixed(2) : 'unlimited',
                        utilizationPercent: limitBytes ? ((sizeBytes / limitBytes) * 100).toFixed(1) : 0
                    };
                }
            } catch (error) {
                log.warn(() => `[Health] Cache size check failed: ${error.message}`);
            }
        }

        // Get memory usage
        const memUsage = process.memoryUsage();
        const memory = {
            rss: (memUsage.rss / (1024 * 1024)).toFixed(2) + ' MB',
            heapUsed: (memUsage.heapUsed / (1024 * 1024)).toFixed(2) + ' MB',
            heapTotal: (memUsage.heapTotal / (1024 * 1024)).toFixed(2) + ' MB',
            external: (memUsage.external / (1024 * 1024)).toFixed(2) + ' MB'
        };

        const healthy = storageHealthy;
        const status = healthy ? 'healthy' : 'unhealthy';
        const statusCode = healthy ? 200 : 503;

        res.status(statusCode).json({
            status,
            timestamp: new Date().toISOString(),
            uptime: Math.floor(process.uptime()),
            uptimeHuman: formatUptime(process.uptime()),
            version,
            storage: {
                type: storageType,
                healthy: storageHealthy,
                caches: cacheSizes
            },
            memory,
            sessions: sessionManager.getStats()
        });
    } catch (error) {
        log.error(() => `[Health] Error: ${error.message}`);
        res.status(503).json({
            status: 'unhealthy',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Helper function to format uptime in human-readable format
function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

    return parts.join(' ');
}

// API endpoint to get all languages
app.get('/api/languages', (req, res) => {
    try {
        const languages = getAllLanguages();
        res.json(languages);
    } catch (error) {
        log.error(() => '[API] Error getting languages:', error);
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
        
        log.debug(() => '[Test] Testing OpenSubtitles with:', testParams);
        const results = await opensubtitles.searchSubtitles(testParams);

        res.json({
            success: true,
            count: results.length,
            results: results.slice(0, 5) // Return first 5 results
        });
    } catch (error) {
        log.error(() => '[Test] Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// API endpoint to fetch Gemini models
app.post('/api/gemini-models', async (req, res) => {
    try {
        const { apiKey } = req.body || {};

        if (!apiKey) {
            return res.status(400).json({ error: 'API key is required' });
        }

        const gemini = new GeminiService(String(apiKey).trim());
        const models = await gemini.getAvailableModels({ silent: true });

        // Filter to only show models containing "pro" or "flash" (case-insensitive)
        const filteredModels = models.filter(model => {
            const nameLower = model.name.toLowerCase();
            return nameLower.includes('pro') || nameLower.includes('flash');
        });

        res.json(filteredModels);
    } catch (error) {
        log.error(() => '[API] Error fetching Gemini models:', error);
        // Surface upstream error details if available for easier debugging in UI
        const message = error?.response?.data?.error || error?.response?.data?.message || error.message || 'Failed to fetch models';
        res.status(500).json({ error: message });
    }
});

app.post('/api/validate-subsource', async (req, res) => {
    try {
        const { apiKey } = req.body;

        if (!apiKey) {
            return res.status(400).json({
                valid: false,
                error: 'API key is required'
            });
        }

        const axios = require('axios');
        const { httpAgent, httpsAgent } = require('./src/utils/httpAgents');

        // Make direct API call to test the key
        // First get movie ID
        const searchUrl = 'https://api.subsource.net/api/v1/movies/search?searchType=imdb&imdb=tt0133093';

        try {
            const movieResponse = await axios.get(searchUrl, {
                headers: {
                    'X-API-Key': apiKey.trim(),
                    'api-key': apiKey.trim(),
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 10000,
                httpAgent,
                httpsAgent
            });

            const movies = Array.isArray(movieResponse.data) ? movieResponse.data : (movieResponse.data.data || []);

            if (movies.length > 0) {
                const movieId = movies[0].id || movies[0].movieId;

                // Try to fetch subtitles with the movie ID
                const subtitlesUrl = `https://api.subsource.net/api/v1/subtitles?movieId=${movieId}&language=english`;
                const subtitlesResponse = await axios.get(subtitlesUrl, {
                    headers: {
                        'X-API-Key': apiKey.trim(),
                        'api-key': apiKey.trim(),
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    timeout: 10000,
                    httpAgent,
                    httpsAgent
                });

                // If we got here without errors, API key is valid
                const subtitles = Array.isArray(subtitlesResponse.data) ? subtitlesResponse.data : (subtitlesResponse.data.subtitles || subtitlesResponse.data.data || []);

                res.json({
                    valid: true,
                    message: 'API key is valid',
                    resultsCount: subtitles.length
                });
            } else {
                // No movies found, but API key worked (no auth error)
                res.json({
                    valid: true,
                    message: 'API key is valid',
                    resultsCount: 0
                });
            }
        } catch (apiError) {
            // Check for authentication errors
            if (apiError.response?.status === 401 || apiError.response?.status === 403) {
                res.json({
                    valid: false,
                    error: 'Invalid API key - authentication failed'
                });
            } else {
                throw apiError;
            }
        }
    } catch (error) {
        res.json({
            valid: false,
            error: `API error: ${error.message}`
        });
    }
});

// API endpoint to validate SubDL API key
app.post('/api/validate-subdl', async (req, res) => {
    try {
        const { apiKey } = req.body;

        if (!apiKey) {
            return res.status(400).json({
                valid: false,
                error: 'API key is required'
            });
        }

        const axios = require('axios');
        const { httpAgent, httpsAgent } = require('./src/utils/httpAgents');

        // Make direct API call to SubDL
        const subdlUrl = 'https://api.subdl.com/api/v1/subtitles';

        try {
            const response = await axios.get(subdlUrl, {
                params: {
                    api_key: apiKey.trim(),
                    imdb_id: 'tt0133093',
                    languages: 'EN',
                    type: 'movie'
                },
                headers: {
                    'User-Agent': 'StremioSubtitleTranslator v1.0',
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 10000,
                httpAgent,
                httpsAgent
            });

            // Check if response indicates success
            if (response.data && response.data.status === true) {
                const subtitles = response.data.subtitles || [];
                res.json({
                    valid: true,
                    message: 'API key is valid',
                    resultsCount: subtitles.length
                });
            } else if (response.data && response.data.status === false) {
                // API returned error status
                res.json({
                    valid: false,
                    error: response.data.error || 'Invalid API key'
                });
            } else {
                // Unexpected response format
                res.json({
                    valid: true,
                    message: 'API key appears valid',
                    resultsCount: 0
                });
            }
        } catch (apiError) {
            // Check for authentication errors
            if (apiError.response?.status === 401 || apiError.response?.status === 403) {
                res.json({
                    valid: false,
                    error: 'Invalid API key - authentication failed'
                });
            } else if (apiError.response?.data?.error) {
                // SubDL may return error in response body
                res.json({
                    valid: false,
                    error: apiError.response.data.error
                });
            } else {
                throw apiError;
            }
        }
    } catch (error) {
        res.json({
            valid: false,
            error: `API error: ${error.message}`
        });
    }
});

// API endpoint to validate OpenSubtitles credentials
app.post('/api/validate-opensubtitles', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                valid: false,
                error: 'Username and password are required'
            });
        }

        const axios = require('axios');
        const { httpAgent, httpsAgent } = require('./src/utils/httpAgents');
        const { version } = require('./src/utils/version');

        // Make direct login API call
        const loginUrl = 'https://api.opensubtitles.com/api/v1/login';

        // Get API key from environment
        const apiKey = process.env.OPENSUBTITLES_API_KEY || '';
        const headers = {
            'User-Agent': `SubMaker v${version}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };

        if (apiKey) {
            headers['Api-Key'] = apiKey;
        }

        try {
            const response = await axios.post(loginUrl, {
                username: username,
                password: password
            }, {
                headers: headers,
                timeout: 15000,
                httpAgent,
                httpsAgent
            });

            // Check if we got a token
            if (response.data && response.data.token) {
                res.json({
                    valid: true,
                    message: 'Credentials are valid'
                });
            } else {
                res.json({
                    valid: false,
                    error: 'No token received - credentials may be invalid'
                });
            }
        } catch (apiError) {
            // Check for authentication errors
            if (apiError.response?.status === 401) {
                res.json({
                    valid: false,
                    error: 'Invalid username or password'
                });
            } else if (apiError.response?.status === 406) {
                res.json({
                    valid: false,
                    error: 'Invalid request format'
                });
            } else if (apiError.response?.data?.message) {
                res.json({
                    valid: false,
                    error: apiError.response.data.message
                });
            } else {
                throw apiError;
            }
        }
    } catch (error) {
        res.json({
            valid: false,
            error: `API error: ${error.message}`
        });
    }
});

// API endpoint to validate Gemini API key
app.post('/api/validate-gemini', async (req, res) => {
    try {
        const { apiKey } = req.body || {};

        if (!apiKey) {
            return res.status(400).json({
                valid: false,
                error: 'API key is required'
            });
        }

        const axios = require('axios');
        const { httpAgent, httpsAgent } = require('./src/utils/httpAgents');

        // Use v1 endpoint and API key header for validation
        const geminiUrl = 'https://generativelanguage.googleapis.com/v1/models';

        try {
            const response = await axios.get(geminiUrl, {
                headers: { 'x-goog-api-key': String(apiKey || '').trim() },
                timeout: 10000,
                httpAgent,
                httpsAgent
            });

            // If we got here without errors, API key is valid
            if (response.data && response.data.models) {
                res.json({
                    valid: true,
                    message: 'API key is valid'
                });
            } else {
                res.json({
                    valid: true,
                    message: 'API key is valid'
                });
            }
        } catch (apiError) {
            // Check for authentication errors
            if (apiError.response?.status === 401 || apiError.response?.status === 403) {
                res.json({
                    valid: false,
                    error: 'Invalid API key - authentication failed'
                });
            } else if (apiError.response?.status === 400) {
                res.json({
                    valid: false,
                    error: apiError.response?.data?.error || apiError.response?.data?.message || 'Invalid API key'
                });
            } else {
                throw apiError;
            }
        }
    } catch (error) {
        const isAuthError = error.response?.status === 401 ||
                           error.response?.status === 403 ||
                           error.message?.toLowerCase().includes('api key') ||
                           error.message?.toLowerCase().includes('invalid') ||
                           error.message?.toLowerCase().includes('permission');

        res.json({
            valid: false,
            error: isAuthError ? 'Invalid API key' : `API error: ${error.message}`
        });
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
        const storageType = process.env.STORAGE_TYPE || 'filesystem';

        // Use base64 only if: localhost AND not forced sessions AND not using Redis storage
        // Redis storage should always use sessions for proper data persistence
        if (localhost && process.env.FORCE_SESSIONS !== 'true' && storageType !== 'redis') {
            // For localhost, return base64 encoded config (old method)
            const configStr = Buffer.from(JSON.stringify(config), 'utf-8').toString('base64');
            log.debug(() => '[Session API] Localhost detected - using base64 encoding');
            return res.json({
                token: configStr,
                type: 'base64',
                message: 'Using base64 encoding for localhost'
            });
        }

        // Production mode: create session
        const token = sessionManager.createSession(config);
        log.debug(() => `[Session API] Created session token: ${token}`);

        res.json({
            token,
            type: 'session',
            expiresIn: process.env.SESSION_MAX_AGE || 90 * 24 * 60 * 60 * 1000
        });
    } catch (error) {
        log.error(() => '[Session API] Error creating session:', error);
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
        const storageType = process.env.STORAGE_TYPE || 'filesystem';
        const isBase64Token = !/^[a-f0-9]{32}$/.test(token);

        // Use base64 only if: localhost AND base64 token AND not forced sessions AND not using Redis storage
        // Redis storage should always use sessions for proper data persistence
        if (localhost && isBase64Token && process.env.FORCE_SESSIONS !== 'true' && storageType !== 'redis') {
            // For localhost base64, just return new encoded config
            const configStr = Buffer.from(JSON.stringify(config), 'utf-8').toString('base64');
            log.debug(() => '[Session API] Localhost detected - creating new base64 token');
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
            log.debug(() => `[Session API] Session not found, creating new one`);
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

        log.debug(() => `[Session API] Updated session token: ${token}`);

        res.json({
            token,
            type: 'session',
            updated: true,
            message: 'Session configuration updated successfully'
        });
    } catch (error) {
        log.error(() => '[Session API] Error updating session:', error);
        res.status(500).json({ error: 'Failed to update session' });
    }
});

// API endpoint to get session statistics (for monitoring)
app.get('/api/session-stats', (req, res) => {
    try {
        const stats = sessionManager.getStats();
        res.json({ ...stats, version });
    } catch (error) {
        log.error(() => '[Session API] Error getting stats:', error);
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

        log.debug(() => `[File Translation API] Translating to ${targetLanguage}`);

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
        log.debug(() => `[File Translation API] Estimated tokens: ${estimatedTokens}`);

        // Use parallel translation for large files (>threshold tokens)
        // Parallel translation provides:
        // - Faster processing through concurrent API calls
        // - Better context preservation with chunk overlap
        // - Improved reliability with per-chunk retries
        const parallelThreshold = parseInt(process.env.PARALLEL_TRANSLATION_THRESHOLD) || 15000;
        const useParallel = estimatedTokens > parallelThreshold;
        let translatedContent;

        if (useParallel) {
            log.debug(() => `[File Translation API] Using parallel translation (${estimatedTokens} tokens)`);

            // Parallel translation configuration (environment variables with fallbacks)
            const maxConcurrency = parseInt(process.env.PARALLEL_MAX_CONCURRENCY) || 3;
            const targetChunkTokens = parseInt(process.env.PARALLEL_CHUNK_SIZE) || 12000;
            const contextSize = parseInt(process.env.PARALLEL_CONTEXT_SIZE) || 3;

            // Parallel translation with context preservation
            translatedContent = await translateInParallel(
                content,
                gemini,
                targetLangName,
                {
                    customPrompt: config.translationPrompt,
                    maxConcurrency,
                    targetChunkTokens,
                    contextSize,
                    onProgress: (current, total) => {
                        log.debug(() => `[File Translation API] Progress: ${current}/${total} chunks (concurrency: ${maxConcurrency})`);
                    }
                }
            );
        } else {
            log.debug(() => `[File Translation API] Using single-call translation (${estimatedTokens} tokens)`);

            // Single API call for smaller files
            translatedContent = await gemini.translateSubtitle(
                content,
                'detected source language',
                targetLangName,
                config.translationPrompt
            );
        }

        log.debug(() => `[File Translation API] Translation completed (${useParallel ? 'parallel' : 'single-call'})`);


        // Return translated content as plain text
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(translatedContent);

    } catch (error) {
        log.error(() => '[File Translation API] Error:', error);
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

        // Create deduplication key (includes config+language to separate concurrent user requests)
        const dedupKey = `download:${configStr}:${fileId}:${langCode}`;

        // STEP 1: Check download cache first (fastest path - shared with translation flow)
        const cachedContent = getDownloadCached(fileId);
        if (cachedContent) {
            const cacheStats = getDownloadCacheStats();
            log.debug(() => `[Download Cache] HIT for ${fileId} in ${langCode} (${cachedContent.length} bytes) - Cache: ${cacheStats.size}/${cacheStats.max} entries, ${cacheStats.sizeMB}/${cacheStats.maxSizeMB}MB`);

            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${fileId}.srt"`);
            res.send(cachedContent);
            return;
        }

        // STEP 2: Cache miss - check if already in flight
        const isAlreadyInFlight = inFlightRequests.has(dedupKey);

        if (isAlreadyInFlight) {
            log.debug(() => `[Download Cache] MISS for ${fileId} in ${langCode} - Duplicate in-flight request detected, waiting...`);
        } else {
            log.debug(() => `[Download Cache] MISS for ${fileId} in ${langCode} - Starting new download`);
        }

        // STEP 3: Download with deduplication (prevents concurrent downloads of same subtitle)
        const content = await deduplicate(dedupKey, () =>
            handleSubtitleDownload(fileId, langCode, config)
        );

        // STEP 4: Save to cache for future requests (shared with translation flow)
        saveDownloadCached(fileId, content);

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fileId}.srt"`);
        res.send(content);

    } catch (error) {
        log.error(() => '[Download] Error:', error);
        res.status(404).send('Subtitle not found');
    }
});

// Custom route: Serve error subtitles for config errors (BEFORE SDK router to take precedence)
app.get('/addon/:config/error-subtitle/:errorType.srt', (req, res) => {
    try {
        const { errorType } = req.params;

        log.debug(() => `[Error Subtitle] Serving error subtitle for: ${errorType}`);

        let content;
        switch (errorType) {
            case 'session-token-not-found':
                content = createSessionTokenErrorSubtitle();
                break;
            default:
                content = createSessionTokenErrorSubtitle(); // Default to session token error
                break;
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${errorType}.srt"`);
        res.send(content);

    } catch (error) {
        log.error(() => '[Error Subtitle] Error:', error);
        res.status(500).send('Error subtitle unavailable');
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
            log.debug(() => `[Translation Selector] Duplicate request detected for ${videoId} to ${targetLang}`);
        } else {
            log.debug(() => `[Translation Selector] New request for ${videoId} to ${targetLang}`);
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
        log.error(() => '[Translation Selector] Error:', error);
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

        // Unusual purge: if same translated subtitle is loaded 3 times in < 5s, purge and retrigger
        // SAFETY BLOCK: Only purge if translation is NOT currently in progress
        try {
            const clickKey = `translate-click:${configStr}:${sourceFileId}:${targetLang}`;
            const now = Date.now();
            const windowMs = 5_000; // 5 seconds
            const entry = firstClickTracker.get(clickKey) || { times: [] };
            // Keep only clicks within window
            entry.times = (entry.times || []).filter(t => now - t <= windowMs);
            entry.times.push(now);
            firstClickTracker.set(clickKey, entry);

            if (entry.times.length >= 3) {
                // SAFETY CHECK: Block cache reset if translation is in progress
                const shouldBlock = shouldBlockCacheReset(clickKey, sourceFileId, config, targetLang);

                if (shouldBlock) {
                    log.debug(() => `[PurgeTrigger] 3 rapid loads detected but BLOCKED: Translation in progress for ${sourceFileId}/${targetLang} (user: ${config.__configHash})`);
                } else {
                    // Reset the counter immediately to avoid loops
                    firstClickTracker.set(clickKey, { times: [] });
                    const hadCache = await hasCachedTranslation(sourceFileId, targetLang, config);
                    if (hadCache) {
                        log.debug(() => `[PurgeTrigger] 3 rapid loads detected (<5s) for ${sourceFileId}/${targetLang}. Purging cache and re-triggering translation.`);
                        await purgeTranslationCache(sourceFileId, targetLang, config);
                    } else {
                        log.debug(() => `[PurgeTrigger] 3 rapid loads detected but no cached translation found for ${sourceFileId}/${targetLang}. Skipping purge.`);
                    }
                }
            }
        } catch (e) {
            log.warn(() => '[PurgeTrigger] Click tracking error:', e.message);
        }

        // Check if already in flight BEFORE logging to reduce confusion
        const isAlreadyInFlight = inFlightRequests.has(dedupKey);

        if (isAlreadyInFlight) {
            log.debug(() => `[Translation] Duplicate request detected for ${sourceFileId} to ${targetLang} - checking for partial results`);

            // Generate cache keys using shared utility (single source of truth for cache key scoping)
            const { cacheKey } = generateCacheKeys(config, sourceFileId, targetLang);

            // For duplicate requests, check partial cache FIRST (in-flight translations)
            // Both partial cache and bypass cache use the same scoped key (cacheKey)
            const partialCached = await readFromPartialCache(cacheKey);
            if (partialCached && typeof partialCached.content === 'string' && partialCached.content.length > 0) {
                log.debug(() => `[Translation] Found in-flight partial in partial cache for ${sourceFileId} (${partialCached.content.length} chars)`);
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache, must-revalidate');
                res.setHeader('Pragma', 'no-cache');
                return res.send(partialCached.content);
            }

            // Then check bypass cache for user-controlled bypass cache behavior
            const { StorageAdapter } = require('./src/storage');
            const { getStorageAdapter } = require('./src/storage/StorageFactory');
            const adapter = await getStorageAdapter();
            const bypassCached = await adapter.get(cacheKey, StorageAdapter.CACHE_TYPES.BYPASS);
            if (bypassCached && typeof bypassCached.content === 'string' && bypassCached.content.length > 0) {
                log.debug(() => `[Translation] Found bypass cache result for ${sourceFileId} (${bypassCached.content.length} chars)`);
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache, must-revalidate');
                res.setHeader('Pragma', 'no-cache');
                return res.send(bypassCached.content);
            }

            // No partial yet, serve loading message
            log.debug(() => `[Translation] No partial found yet, serving loading message to duplicate request for ${sourceFileId}`);
            const loadingMsg = createLoadingSubtitle();
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            return res.send(loadingMsg);
        } else {
            log.debug(() => `[Translation] New request to translate ${sourceFileId} to ${targetLang}`);
        }

        // Deduplicate translation requests - handles the first request
        const subtitleContent = await deduplicate(dedupKey, () =>
            handleTranslation(sourceFileId, targetLang, config)
        );

        // Validate content before processing
        if (!subtitleContent || typeof subtitleContent !== 'string') {
            log.error(() => `[Translation] Invalid subtitle content returned: ${typeof subtitleContent}, value: ${subtitleContent}`);
            return res.status(500).send('Translation returned invalid content');
        }

        // Check if this is a loading message or actual translation
        const isLoadingMessage = subtitleContent.includes('Please wait while the selected subtitle is being translated') ||
                                 subtitleContent.includes('Translation is happening in the background') ||
                                 subtitleContent.includes('Click this subtitle again to confirm translation') ||
                                 subtitleContent.includes('TRANSLATION IN PROGRESS');
        log.debug(() => `[Translation] Serving ${isLoadingMessage ? 'loading message' : 'translated content'} for ${sourceFileId} (was duplicate: ${isAlreadyInFlight})`);
        log.debug(() => `[Translation] Content length: ${subtitleContent.length} characters, first 200 chars: ${subtitleContent.substring(0, 200)}`);

        // Don't use 'attachment' for loading messages - we want them to display inline
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');

        // Disable caching for loading messages so Stremio can poll for updates
        if (isLoadingMessage) {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            log.debug(() => `[Translation] Set no-cache headers for loading message`);
        } else {
            res.setHeader('Content-Disposition', `attachment; filename="translated_${targetLang}.srt"`);
        }

        res.send(subtitleContent);
        log.debug(() => `[Translation] Response sent successfully for ${sourceFileId}`);

    } catch (error) {
        log.error(() => '[Translation] Error:', error);
        res.status(500).send(`Translation failed: ${error.message}`);
    }
});

// Custom route: File translation page (BEFORE SDK router to take precedence)
app.get('/addon/:config/file-translate/:videoId', async (req, res) => {
    try {
        const { config: configStr, videoId } = req.params;
        const config = parseConfig(configStr, { isLocalhost: isLocalhost(req) });

        log.debug(() => `[File Translation] Request for video ${videoId}`);

        // Redirect to the actual upload page
        // Using a separate non-addon route so browser opens it directly
        res.redirect(302, `/file-upload?config=${encodeURIComponent(configStr)}&videoId=${encodeURIComponent(videoId)}`);

    } catch (error) {
        log.error(() => '[File Translation] Error:', error);
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

        log.debug(() => `[File Upload Page] Loading page for video ${videoId}`);

        // Generate HTML page for file upload and translation
        const html = generateFileTranslationPage(videoId, configStr, config);

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);

    } catch (error) {
        log.error(() => '[File Upload Page] Error:', error);
        res.status(500).send('Failed to load file translation page');
    }
});

// Custom route: Addon configuration page (BEFORE SDK router to take precedence)
// This handles both /addon/:config/configure and /addon/:config (base path)
app.get('/addon/:config/configure', (req, res) => {
    try {
        const { config: configStr } = req.params;
        log.debug(() => `[Configure] Redirecting to configure page with config`);
        // Redirect to main configure page with config parameter
        res.redirect(302, `/configure?config=${encodeURIComponent(configStr)}`);
    } catch (error) {
        log.error(() => '[Configure] Error:', error);
        res.status(500).send('Failed to load configuration page');
    }
});

// Custom route: Sync subtitles page (BEFORE SDK router to take precedence)
app.get('/addon/:config/sync-subtitles/:videoId', async (req, res) => {
    try {
        const { config: configStr, videoId } = req.params;
        const { filename } = req.query;
        const config = parseConfig(configStr, { isLocalhost: isLocalhost(req) });

        log.debug(() => `[Sync Subtitles] Request for video ${videoId}, filename: ${filename}`);

        // Redirect to the actual sync page
        res.redirect(302, `/subtitle-sync?config=${encodeURIComponent(configStr)}&videoId=${encodeURIComponent(videoId)}&filename=${encodeURIComponent(filename || '')}`);

    } catch (error) {
        log.error(() => '[Sync Subtitles] Error:', error);
        res.status(500).send('Failed to load subtitle sync page');
    }
});

// Actual subtitle sync page (standalone, not under /addon route)
app.get('/subtitle-sync', async (req, res) => {
    try {
        const { config: configStr, videoId, filename } = req.query;

        if (!configStr || !videoId) {
            return res.status(400).send('Missing config or videoId');
        }

        const config = parseConfig(configStr, { isLocalhost: isLocalhost(req) });
        config.__configHash = computeConfigHash(configStr);

        log.debug(() => `[Subtitle Sync Page] Loading page for video ${videoId}`);

        // Get available subtitles for this video
        const subtitleHandler = createSubtitleHandler(config);
        const subtitlesData = await subtitleHandler({ type: 'movie', id: videoId, extra: { filename
} });

        // Generate HTML page for subtitle syncing
        const html = generateSubtitleSyncPage(subtitlesData.subtitles ||
[], videoId, filename, configStr, config);

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);

    } catch (error) {
        log.error(() => '[Subtitle Sync Page] Error:', error);
        res.status(500).send('Failed to load subtitle sync page');
    }
});

// API endpoint: Download xSync subtitle
app.get('/addon/:config/xsync/:videoHash/:lang/:sourceSubId', async (req, res) => {
    try {
        const { config: configStr, videoHash, lang, sourceSubId } = req.params;
        const config = parseConfig(configStr, { isLocalhost: isLocalhost(req) });

        log.debug(() => `[xSync Download] Request for ${videoHash}_${lang}_${sourceSubId}`);

        // Get synced subtitle from cache
        const syncedSub = await syncCache.getSyncedSubtitle(videoHash, lang, sourceSubId);

        if (!syncedSub || !syncedSub.content) {
            log.debug(() => '[xSync Download] Not found in cache');
            return res.status(404).send('Synced subtitle not found');
        }

        log.debug(() => '[xSync Download] Serving synced subtitle from cache');

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${videoHash}_${lang}_synced.srt"`);
        res.send(syncedSub.content);

    } catch (error) {
        log.error(() => '[xSync Download] Error:', error);
        res.status(500).send('Failed to download synced subtitle');
    }
});

// API endpoint: Save synced subtitle to cache
app.post('/api/save-synced-subtitle', async (req, res) => {
    try {
        const { configStr, videoHash, languageCode, sourceSubId, content, originalSubId, metadata } = req.body;

        if (!configStr || !videoHash || !languageCode || !sourceSubId || !content) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Validate config
        const config = parseConfig(configStr, { isLocalhost: isLocalhost(req) });

        log.debug(() => `[Save Synced] Saving synced subtitle: ${videoHash}_${languageCode}_${sourceSubId}`);

        // Save to sync cache
        await syncCache.saveSyncedSubtitle(videoHash, languageCode, sourceSubId, {
            content,
            originalSubId: originalSubId || sourceSubId,
            metadata: metadata || {}
        });

        res.json({ success: true, message: 'Synced subtitle saved successfully' });

    } catch (error) {
        log.error(() => '[Save Synced] Error:', error);
        res.status(500).json({ error: 'Failed to save synced subtitle' });
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

        :root {
            --bg-gradient-start: #0A0E27;
            --bg-gradient-end: #1a1f3a;
            --text-primary: #E8EAED;
            --text-secondary: #9AA0A6;
            --card-bg: #141931;
            --card-border: #2A3247;
            --card-hover-border: #7B68EE;
            --card-hover-shadow: rgba(123, 104, 238, 0.3);
            --badge-bg: #2A3247;
            --badge-text: #9AA0A6;
            --badge-border: #2A3247;
            --primary-gradient-start: #9B88FF;
            --primary-gradient-end: #7B68EE;
        }

        [data-theme="light"] {
            --bg-gradient-start: #f7fafc;
            --bg-gradient-end: #ffffff;
            --text-primary: #0f172a;
            --text-secondary: #475569;
            --card-bg: #ffffff;
            --card-border: #dbe3ea;
            --card-hover-border: #08A4D5;
            --card-hover-shadow: rgba(8, 164, 213, 0.3);
            --badge-bg: rgba(8, 164, 213, 0.1);
            --badge-text: #068DB7;
            --badge-border: rgba(8, 164, 213, 0.3);
            --primary-gradient-start: #08A4D5;
            --primary-gradient-end: #33B9E1;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', sans-serif;
            background: linear-gradient(135deg, var(--bg-gradient-start) 0%, var(--bg-gradient-end) 100%);
            color: var(--text-primary);
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
            background: linear-gradient(135deg, var(--primary-gradient-start) 0%, var(--primary-gradient-end) 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .version-badge {
            display: inline-block;
            background: var(--badge-bg);
            color: var(--badge-text);
            border: 1px solid var(--badge-border);
            border-radius: 999px;
            padding: 0.15rem 0.6rem;
            font-size: 0.8rem;
            margin-left: 0.5rem;
            vertical-align: middle;
        }

        .subtitle-header {
            text-align: center;
            margin-bottom: 2rem;
            color: var(--text-secondary);
            font-size: 0.95rem;
        }

        .subtitle-option {
            background: var(--card-bg);
            border: 2px solid var(--card-border);
            border-radius: 12px;
            margin-bottom: 1rem;
            transition: all 0.3s ease;
        }

        .subtitle-option:hover {
            border-color: var(--card-hover-border);
            transform: translateY(-2px);
            box-shadow: 0 8px 20px var(--card-hover-shadow);
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
            color: var(--text-secondary);
        }

        .no-subtitles {
            text-align: center;
            padding: 3rem;
            color: var(--text-secondary);
        }

        /* Theme Toggle Button */
        .theme-toggle {
            position: fixed;
            top: 2rem;
            right: 2rem;
            width: 48px;
            height: 48px;
            background: var(--card-bg);
            border: 2px solid var(--card-border);
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: all 0.3s ease;
            z-index: 9999;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        }

        .theme-toggle:hover {
            transform: translateY(-2px) scale(1.05);
            border-color: var(--card-hover-border);
            box-shadow: 0 8px 20px var(--card-hover-shadow);
        }

        .theme-toggle:active {
            transform: translateY(0) scale(0.98);
        }

        .theme-toggle-icon {
            font-size: 1.5rem;
            transition: all 0.3s ease;
        }

        .theme-toggle-icon.sun {
            display: none;
        }

        .theme-toggle-icon.moon {
            display: block;
        }

        [data-theme="light"] .theme-toggle-icon.sun {
            display: block;
        }

        [data-theme="light"] .theme-toggle-icon.moon {
            display: none;
        }

        @media (max-width: 768px) {
            .theme-toggle {
                top: 1rem;
                right: 1rem;
                width: 42px;
                height: 42px;
            }

            .theme-toggle-icon {
                font-size: 1.25rem;
            }
        }
    </style>
</head>
<body>
    <!-- Theme Toggle Button -->
    <button class="theme-toggle" id="themeToggle" aria-label="Toggle theme">
        <span class="theme-toggle-icon sun">☀️</span>
        <span class="theme-toggle-icon moon">🌙</span>
    </button>

    <div class="container">
        <h1>Translate to ${targetLangName} <span class="version-badge">v${version}</span></h1>
        <div class="subtitle-header">Select a ${sourceLangs} subtitle to translate</div>
        ${subtitles.length > 0 ? subtitleOptions : `<div class="no-subtitles">No ${sourceLangs} subtitles available</div>`}
    </div>

    <script>
    // Theme switching functionality
    (function() {
        const html = document.documentElement;
        const themeToggle = document.getElementById('themeToggle');

        // Check for saved theme preference or default to system preference
        function getPreferredTheme() {
            const savedTheme = localStorage.getItem('theme');
            if (savedTheme) {
                return savedTheme;
            }

            // Check system preference (default to dark for this page)
            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
                return 'light';
            }

            return 'dark';
        }

        // Apply theme
        function setTheme(theme) {
            if (theme === 'light') {
                html.setAttribute('data-theme', 'light');
            } else {
                html.removeAttribute('data-theme');
            }
            localStorage.setItem('theme', theme);
        }

        // Initialize theme on page load
        const initialTheme = getPreferredTheme();
        setTheme(initialTheme);

        // Toggle theme on button click
        if (themeToggle) {
            themeToggle.addEventListener('click', function() {
                const currentTheme = html.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
                const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
                setTheme(newTheme);
            });
        }

        // Listen for system theme changes
        if (window.matchMedia) {
            window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function(e) {
                // Only auto-switch if user hasn't manually set a preference
                if (!localStorage.getItem('theme')) {
                    setTheme(e.matches ? 'light' : 'dark');
                }
            });
        }
    })();
    </script>
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

    // Comprehensive language list for Gemini (no mapping needed)
    const allLanguages = [
        { code: 'af', name: 'Afrikaans' },
        { code: 'sq', name: 'Albanian' },
        { code: 'am', name: 'Amharic' },
        { code: 'ar', name: 'Arabic' },
        { code: 'ar-DZ', name: 'Arabic (Algeria)' },
        { code: 'ar-BH', name: 'Arabic (Bahrain)' },
        { code: 'ar-EG', name: 'Arabic (Egypt)' },
        { code: 'ar-IQ', name: 'Arabic (Iraq)' },
        { code: 'ar-JO', name: 'Arabic (Jordan)' },
        { code: 'ar-KW', name: 'Arabic (Kuwait)' },
        { code: 'ar-LB', name: 'Arabic (Lebanon)' },
        { code: 'ar-LY', name: 'Arabic (Libya)' },
        { code: 'ar-MA', name: 'Arabic (Morocco)' },
        { code: 'ar-OM', name: 'Arabic (Oman)' },
        { code: 'ar-QA', name: 'Arabic (Qatar)' },
        { code: 'ar-SA', name: 'Arabic (Saudi Arabia)' },
        { code: 'ar-SY', name: 'Arabic (Syria)' },
        { code: 'ar-TN', name: 'Arabic (Tunisia)' },
        { code: 'ar-AE', name: 'Arabic (UAE)' },
        { code: 'ar-YE', name: 'Arabic (Yemen)' },
        { code: 'hy', name: 'Armenian' },
        { code: 'az', name: 'Azerbaijani' },
        { code: 'eu', name: 'Basque' },
        { code: 'be', name: 'Belarusian' },
        { code: 'bn', name: 'Bengali' },
        { code: 'bs', name: 'Bosnian' },
        { code: 'bg', name: 'Bulgarian' },
        { code: 'my', name: 'Burmese' },
        { code: 'ca', name: 'Catalan' },
        { code: 'ceb', name: 'Cebuano' },
        { code: 'zh', name: 'Chinese' },
        { code: 'zh-CN', name: 'Chinese (Simplified)' },
        { code: 'zh-TW', name: 'Chinese (Traditional)' },
        { code: 'zh-HK', name: 'Chinese (Hong Kong)' },
        { code: 'zh-SG', name: 'Chinese (Singapore)' },
        { code: 'co', name: 'Corsican' },
        { code: 'hr', name: 'Croatian' },
        { code: 'cs', name: 'Czech' },
        { code: 'da', name: 'Danish' },
        { code: 'nl', name: 'Dutch' },
        { code: 'nl-BE', name: 'Dutch (Belgium)' },
        { code: 'nl-NL', name: 'Dutch (Netherlands)' },
        { code: 'en', name: 'English' },
        { code: 'en-AU', name: 'English (Australia)' },
        { code: 'en-CA', name: 'English (Canada)' },
        { code: 'en-IN', name: 'English (India)' },
        { code: 'en-IE', name: 'English (Ireland)' },
        { code: 'en-NZ', name: 'English (New Zealand)' },
        { code: 'en-PH', name: 'English (Philippines)' },
        { code: 'en-SG', name: 'English (Singapore)' },
        { code: 'en-ZA', name: 'English (South Africa)' },
        { code: 'en-GB', name: 'English (UK)' },
        { code: 'en-US', name: 'English (US)' },
        { code: 'eo', name: 'Esperanto' },
        { code: 'et', name: 'Estonian' },
        { code: 'fi', name: 'Finnish' },
        { code: 'fr', name: 'French' },
        { code: 'fr-BE', name: 'French (Belgium)' },
        { code: 'fr-CA', name: 'French (Canada)' },
        { code: 'fr-FR', name: 'French (France)' },
        { code: 'fr-CH', name: 'French (Switzerland)' },
        { code: 'fy', name: 'Frisian' },
        { code: 'gl', name: 'Galician' },
        { code: 'ka', name: 'Georgian' },
        { code: 'de', name: 'German' },
        { code: 'de-AT', name: 'German (Austria)' },
        { code: 'de-DE', name: 'German (Germany)' },
        { code: 'de-CH', name: 'German (Switzerland)' },
        { code: 'el', name: 'Greek' },
        { code: 'gu', name: 'Gujarati' },
        { code: 'ht', name: 'Haitian Creole' },
        { code: 'ha', name: 'Hausa' },
        { code: 'haw', name: 'Hawaiian' },
        { code: 'he', name: 'Hebrew' },
        { code: 'hi', name: 'Hindi' },
        { code: 'hmn', name: 'Hmong' },
        { code: 'hu', name: 'Hungarian' },
        { code: 'is', name: 'Icelandic' },
        { code: 'ig', name: 'Igbo' },
        { code: 'id', name: 'Indonesian' },
        { code: 'ga', name: 'Irish' },
        { code: 'it', name: 'Italian' },
        { code: 'it-IT', name: 'Italian (Italy)' },
        { code: 'it-CH', name: 'Italian (Switzerland)' },
        { code: 'ja', name: 'Japanese' },
        { code: 'jv', name: 'Javanese' },
        { code: 'kn', name: 'Kannada' },
        { code: 'kk', name: 'Kazakh' },
        { code: 'km', name: 'Khmer' },
        { code: 'rw', name: 'Kinyarwanda' },
        { code: 'ko', name: 'Korean' },
        { code: 'ko-KR', name: 'Korean (South Korea)' },
        { code: 'ko-KP', name: 'Korean (North Korea)' },
        { code: 'ku', name: 'Kurdish' },
        { code: 'ky', name: 'Kyrgyz' },
        { code: 'lo', name: 'Lao' },
        { code: 'la', name: 'Latin' },
        { code: 'lv', name: 'Latvian' },
        { code: 'lt', name: 'Lithuanian' },
        { code: 'lb', name: 'Luxembourgish' },
        { code: 'mk', name: 'Macedonian' },
        { code: 'mg', name: 'Malagasy' },
        { code: 'ms', name: 'Malay' },
        { code: 'ml', name: 'Malayalam' },
        { code: 'mt', name: 'Maltese' },
        { code: 'mi', name: 'Maori' },
        { code: 'mr', name: 'Marathi' },
        { code: 'mn', name: 'Mongolian' },
        { code: 'ne', name: 'Nepali' },
        { code: 'no', name: 'Norwegian' },
        { code: 'nb', name: 'Norwegian (Bokmål)' },
        { code: 'nn', name: 'Norwegian (Nynorsk)' },
        { code: 'ny', name: 'Nyanja (Chichewa)' },
        { code: 'or', name: 'Odia (Oriya)' },
        { code: 'ps', name: 'Pashto' },
        { code: 'fa', name: 'Persian (Farsi)' },
        { code: 'pl', name: 'Polish' },
        { code: 'pt', name: 'Portuguese' },
        { code: 'pt-BR', name: 'Portuguese (Brazil)' },
        { code: 'pt-PT', name: 'Portuguese (Portugal)' },
        { code: 'pa', name: 'Punjabi' },
        { code: 'ro', name: 'Romanian' },
        { code: 'ru', name: 'Russian' },
        { code: 'sm', name: 'Samoan' },
        { code: 'gd', name: 'Scottish Gaelic' },
        { code: 'sr', name: 'Serbian' },
        { code: 'sr-Cyrl', name: 'Serbian (Cyrillic)' },
        { code: 'sr-Latn', name: 'Serbian (Latin)' },
        { code: 'st', name: 'Sesotho' },
        { code: 'sn', name: 'Shona' },
        { code: 'sd', name: 'Sindhi' },
        { code: 'si', name: 'Sinhala' },
        { code: 'sk', name: 'Slovak' },
        { code: 'sl', name: 'Slovenian' },
        { code: 'so', name: 'Somali' },
        { code: 'es', name: 'Spanish' },
        { code: 'es-AR', name: 'Spanish (Argentina)' },
        { code: 'es-BO', name: 'Spanish (Bolivia)' },
        { code: 'es-CL', name: 'Spanish (Chile)' },
        { code: 'es-CO', name: 'Spanish (Colombia)' },
        { code: 'es-CR', name: 'Spanish (Costa Rica)' },
        { code: 'es-CU', name: 'Spanish (Cuba)' },
        { code: 'es-DO', name: 'Spanish (Dominican Republic)' },
        { code: 'es-EC', name: 'Spanish (Ecuador)' },
        { code: 'es-SV', name: 'Spanish (El Salvador)' },
        { code: 'es-GT', name: 'Spanish (Guatemala)' },
        { code: 'es-HN', name: 'Spanish (Honduras)' },
        { code: 'es-MX', name: 'Spanish (Mexico)' },
        { code: 'es-NI', name: 'Spanish (Nicaragua)' },
        { code: 'es-PA', name: 'Spanish (Panama)' },
        { code: 'es-PY', name: 'Spanish (Paraguay)' },
        { code: 'es-PE', name: 'Spanish (Peru)' },
        { code: 'es-PR', name: 'Spanish (Puerto Rico)' },
        { code: 'es-ES', name: 'Spanish (Spain)' },
        { code: 'es-UY', name: 'Spanish (Uruguay)' },
        { code: 'es-VE', name: 'Spanish (Venezuela)' },
        { code: 'su', name: 'Sundanese' },
        { code: 'sw', name: 'Swahili' },
        { code: 'sv', name: 'Swedish' },
        { code: 'sv-FI', name: 'Swedish (Finland)' },
        { code: 'sv-SE', name: 'Swedish (Sweden)' },
        { code: 'tl', name: 'Tagalog (Filipino)' },
        { code: 'tg', name: 'Tajik' },
        { code: 'ta', name: 'Tamil' },
        { code: 'tt', name: 'Tatar' },
        { code: 'te', name: 'Telugu' },
        { code: 'th', name: 'Thai' },
        { code: 'tr', name: 'Turkish' },
        { code: 'tk', name: 'Turkmen' },
        { code: 'uk', name: 'Ukrainian' },
        { code: 'ur', name: 'Urdu' },
        { code: 'ug', name: 'Uyghur' },
        { code: 'uz', name: 'Uzbek' },
        { code: 'vi', name: 'Vietnamese' },
        { code: 'cy', name: 'Welsh' },
        { code: 'xh', name: 'Xhosa' },
        { code: 'yi', name: 'Yiddish' },
        { code: 'yo', name: 'Yoruba' },
        { code: 'zu', name: 'Zulu' }
    ];

    const allLanguageOptions = allLanguages.map(lang =>
        `<option value="${escapeHtml(lang.code)}">${escapeHtml(lang.name)}</option>`
    ).join('');

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>File Translation - SubMaker</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        html {
            scroll-behavior: smooth;
        }

        :root {
            --primary: #08A4D5;
            --primary-light: #33B9E1;
            --primary-dark: #068DB7;
            --secondary: #33B9E1;
            --success: #10b981;
            --danger: #ef4444;
            --bg-primary: #f7fafc;
            --surface: #ffffff;
            --surface-light: #f3f7fb;
            --text-primary: #0f172a;
            --text-secondary: #475569;
            --border: #dbe3ea;
            --shadow: rgba(0, 0, 0, 0.08);
            --glow: rgba(8, 164, 213, 0.25);
        }

        [data-theme="dark"] {
            --primary: #08A4D5;
            --primary-light: #33B9E1;
            --primary-dark: #068DB7;
            --secondary: #33B9E1;
            --success: #10b981;
            --danger: #ef4444;
            --bg-primary: #0A0E27;
            --surface: #141931;
            --surface-light: #1E2539;
            --text-primary: #E8EAED;
            --text-secondary: #9AA0A6;
            --border: #2A3247;
            --shadow: rgba(0, 0, 0, 0.3);
            --glow: rgba(8, 164, 213, 0.35);
        }

        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, var(--bg-primary) 0%, #ffffff 60%, var(--bg-primary) 100%);
            color: var(--text-primary);
            min-height: 100vh;
            overflow-x: hidden;
            position: relative;
        }

        [data-theme="dark"] body {
            background: linear-gradient(135deg, var(--bg-primary) 0%, #141931 60%, var(--bg-primary) 100%);
        }

        body::before {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background:
                radial-gradient(circle at 20% 50%, rgba(8, 164, 213, 0.12) 0%, transparent 50%),
                radial-gradient(circle at 80% 50%, rgba(51, 185, 225, 0.12) 0%, transparent 50%);
            pointer-events: none;
            z-index: 0;
        }

        [data-theme="dark"] body::before {
            background:
                radial-gradient(circle at 20% 50%, rgba(8, 164, 213, 0.15) 0%, transparent 50%),
                radial-gradient(circle at 80% 50%, rgba(51, 185, 225, 0.15) 0%, transparent 50%);
        }

        .container {
            max-width: 800px;
            margin: 0 auto;
            padding: 3rem 1.5rem;
            position: relative;
            z-index: 1;
        }

        .header {
            text-align: center;
            margin-bottom: 3rem;
            animation: fadeInDown 0.6s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .logo-icon {
            width: 80px;
            height: 80px;
            margin: 0 auto 1.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            border-radius: 20px;
            font-size: 2.5rem;
            box-shadow: 0 20px 60px var(--glow);
            animation: float 3s ease-in-out infinite;
        }

        @keyframes float {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-10px); }
        }

        @keyframes fadeInDown {
            from {
                opacity: 0;
                transform: translateY(-20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        @keyframes fadeInUp {
            from {
                opacity: 0;
                transform: translateY(20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        h1 {
            font-size: 2.5rem;
            font-weight: 800;
            background: linear-gradient(135deg, var(--primary-light) 0%, var(--secondary) 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 0.5rem;
            letter-spacing: -0.02em;
        }

        .subtitle {
            color: var(--text-secondary);
            font-size: 1.125rem;
            font-weight: 500;
        }

        .card {
            background: rgba(255, 255, 255, 0.85);
            backdrop-filter: blur(12px);
            border-radius: 20px;
            padding: 2rem;
            margin-bottom: 1.5rem;
            border: 1px solid var(--border);
            box-shadow: 0 8px 24px var(--shadow);
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            animation: fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) backwards;
        }

        .card:hover {
            border-color: var(--primary);
            box-shadow: 0 12px 48px var(--glow);
            transform: translateY(-2px);
        }

        /* Instructions Popup Modal */
        .instructions-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(8px);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 9999;
            padding: 2rem;
            animation: fadeIn 0.3s ease;
        }

        .instructions-overlay.show {
            display: flex;
        }

        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        .instructions-modal {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(20px);
            border-radius: 24px;
            padding: 2.5rem;
            max-width: 600px;
            width: 100%;
            box-shadow: 0 24px 64px rgba(0, 0, 0, 0.3);
            position: relative;
            animation: slideInScale 0.4s cubic-bezier(0.16, 1, 0.3, 1);
            border: 2px solid var(--primary);
        }

        @keyframes slideInScale {
            from {
                opacity: 0;
                transform: scale(0.9) translateY(20px);
            }
            to {
                opacity: 1;
                transform: scale(1) translateY(0);
            }
        }

        .instructions-modal-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 1.5rem;
            padding-bottom: 1rem;
            border-bottom: 2px solid var(--border);
        }

        .instructions-modal-title {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            font-size: 1.75rem;
            font-weight: 700;
            color: var(--primary);
        }

        .instructions-modal-close {
            background: transparent;
            border: none;
            font-size: 2rem;
            color: var(--text-secondary);
            cursor: pointer;
            transition: all 0.2s ease;
            width: 40px;
            height: 40px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 8px;
        }

        .instructions-modal-close:hover {
            background: rgba(239, 68, 68, 0.1);
            color: var(--danger);
            transform: rotate(90deg);
        }

        .instructions-modal-content {
            color: var(--text-secondary);
            line-height: 1.8;
        }

        .instructions-modal-content strong {
            color: var(--text-primary);
            font-weight: 600;
        }

        .instructions-modal-content ol {
            margin-left: 1.5rem;
            margin-top: 1rem;
        }

        .instructions-modal-content li {
            margin: 0.75rem 0;
            padding-left: 0.5rem;
        }

        .instructions-modal-footer {
            padding-top: 1.5rem;
            margin-top: 1.5rem;
            border-top: 2px solid var(--border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 1rem;
        }

        .instructions-modal-checkbox {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            cursor: pointer;
            user-select: none;
            color: var(--text-secondary);
            font-size: 0.9rem;
        }

        .instructions-modal-checkbox input[type="checkbox"] {
            cursor: pointer;
            width: 18px;
            height: 18px;
        }

        .instructions-modal-btn {
            padding: 0.75rem 1.5rem;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            color: white;
            border: none;
            border-radius: 10px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            box-shadow: 0 4px 12px var(--glow);
        }

        .instructions-modal-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 20px var(--glow);
        }

        .help-button {
            position: fixed;
            bottom: 2rem;
            right: 2rem;
            width: 60px;
            height: 60px;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            color: white;
            border: none;
            border-radius: 50%;
            font-size: 1.75rem;
            cursor: pointer;
            box-shadow: 0 8px 24px var(--glow);
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            z-index: 1000;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .help-button:hover {
            transform: scale(1.1) rotate(15deg);
            box-shadow: 0 12px 32px var(--glow);
        }

        .form-group {
            margin-bottom: 1.5rem;
        }

        label {
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 600;
            font-size: 0.95rem;
            color: var(--text-primary);
        }

        .label-description {
            display: block;
            font-size: 0.875rem;
            color: var(--text-secondary);
            font-weight: 400;
            margin-top: 0.25rem;
        }

        .file-input-wrapper {
            position: relative;
            display: block;
        }

        .file-input-wrapper input[type=file] {
            display: none;
        }

        .file-input-label {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 2.5rem 2rem;
            background: var(--surface);
            color: var(--primary);
            border: 2px dashed var(--border);
            border-radius: 12px;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            text-align: center;
            gap: 0.5rem;
        }

        .file-input-label:hover {
            background: var(--surface-light);
            border-color: var(--primary);
            transform: translateY(-2px);
        }

        .file-input-label .icon {
            font-size: 3rem;
            margin-bottom: 0.5rem;
        }

        .file-input-label .main-text {
            font-weight: 600;
            font-size: 1.05rem;
        }

        .file-input-label .sub-text {
            font-size: 0.875rem;
            color: var(--text-secondary);
        }

        .file-name {
            margin-top: 0.75rem;
            padding: 0.75rem 1rem;
            background: rgba(8, 164, 213, 0.08);
            border-radius: 8px;
            font-size: 0.95rem;
            color: var(--text-primary);
            font-weight: 500;
            display: none;
        }

        .file-name.active {
            display: block;
        }

        select {
            width: 100%;
            padding: 0.875rem 1rem;
            background: var(--surface);
            border: 2px solid var(--border);
            border-radius: 12px;
            color: var(--text-primary);
            font-size: 1rem;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            font-family: inherit;
        }

        select:hover {
            border-color: var(--primary);
        }

        select:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 4px var(--glow);
            transform: translateY(-1px);
        }

        .language-toggle {
            display: flex;
            align-items: center;
            gap: 0.625rem;
            margin-top: 0.75rem;
            padding: 0.625rem 0;
            cursor: pointer;
            user-select: none;
            color: var(--text-secondary);
            font-size: 0.9rem;
            transition: color 0.2s ease;
        }

        .language-toggle:hover {
            color: var(--primary);
        }

        .language-toggle input[type="checkbox"] {
            width: 18px;
            height: 18px;
            cursor: pointer;
            accent-color: var(--primary);
        }

        .btn {
            width: 100%;
            padding: 1rem 1.5rem;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            color: white;
            border: none;
            border-radius: 12px;
            font-size: 1.05rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            box-shadow: 0 4px 12px var(--glow);
        }

        .btn:hover:not(:disabled) {
            transform: translateY(-2px);
            box-shadow: 0 8px 24px var(--glow);
        }

        .btn:active:not(:disabled) {
            transform: translateY(0);
        }

        .btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }

        .progress {
            display: none;
            text-align: center;
            padding: 2rem;
        }

        .progress.active {
            display: block;
        }

        .spinner {
            border: 4px solid var(--surface-light);
            border-top: 4px solid var(--primary);
            border-radius: 50%;
            width: 50px;
            height: 50px;
            animation: spin 0.8s linear infinite;
            margin: 0 auto 1.5rem;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .progress-text {
            color: var(--text-primary);
            font-weight: 600;
            font-size: 1.05rem;
            margin-bottom: 0.5rem;
        }

        .progress-subtext {
            color: var(--text-secondary);
            font-size: 0.95rem;
        }

        .result {
            display: none;
            text-align: center;
        }

        .result.active {
            display: block;
        }

        .result-icon {
            width: 80px;
            height: 80px;
            margin: 0 auto 1.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, var(--success) 0%, #059669 100%);
            border-radius: 20px;
            font-size: 2.5rem;
            animation: scaleIn 0.5s cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes scaleIn {
            from {
                transform: scale(0);
                opacity: 0;
            }
            to {
                transform: scale(1);
                opacity: 1;
            }
        }

        .result h2 {
            color: var(--text-primary);
            font-size: 1.75rem;
            margin-bottom: 0.5rem;
        }

        .result p {
            color: var(--text-secondary);
            margin-bottom: 1.5rem;
        }

        .download-btn {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            padding: 1rem 2rem;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            color: white;
            text-decoration: none;
            border-radius: 12px;
            font-weight: 600;
            font-size: 1.05rem;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            box-shadow: 0 4px 12px var(--glow);
        }

        .download-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 24px var(--glow);
        }

        .error {
            display: none;
            background: rgba(239, 68, 68, 0.1);
            border: 2px solid var(--danger);
            border-radius: 12px;
            padding: 1.25rem;
            margin-top: 1rem;
            color: var(--danger);
            font-weight: 500;
        }

        .error.active {
            display: block;
            animation: fadeInUp 0.3s ease;
        }

        /* Advanced Settings Section */
        .advanced-settings {
            margin-top: 2rem;
            padding: 0;
            background: var(--surface-light);
            border: 2px solid var(--border);
            border-radius: 16px;
            overflow: hidden;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .advanced-settings-header {
            padding: 1.25rem 1.5rem;
            cursor: pointer;
            user-select: none;
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: linear-gradient(135deg, rgba(8, 164, 213, 0.05) 0%, rgba(51, 185, 225, 0.05) 100%);
            transition: background 0.2s ease;
        }

        .advanced-settings-header:hover {
            background: linear-gradient(135deg, rgba(8, 164, 213, 0.1) 0%, rgba(51, 185, 225, 0.1) 100%);
        }

        .advanced-settings-title {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            font-size: 1.05rem;
            font-weight: 600;
            color: var(--text-primary);
        }

        .advanced-settings-icon {
            font-size: 1.25rem;
        }

        .advanced-settings-toggle {
            font-size: 1.5rem;
            color: var(--text-secondary);
            transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .advanced-settings.expanded .advanced-settings-toggle {
            transform: rotate(180deg);
        }

        .advanced-settings-content {
            max-height: 0;
            overflow: hidden;
            transition: max-height 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .advanced-settings.expanded .advanced-settings-content {
            max-height: 2000px;
        }

        .advanced-settings-inner {
            padding: 1.5rem;
            border-top: 2px solid var(--border);
        }

        .highlight-box {
            background: rgba(255, 165, 0, 0.1);
            border: 2px solid rgba(255, 165, 0, 0.3);
            border-radius: 12px;
            padding: 1rem;
            margin-bottom: 1.5rem;
        }

        .highlight-box p {
            margin: 0;
            font-size: 0.9rem;
            color: var(--text-primary);
        }

        .highlight-box strong {
            color: var(--text-primary);
            font-weight: 600;
        }

        .highlight-box em {
            color: var(--warning);
            font-style: normal;
            font-weight: 600;
        }

        textarea {
            width: 100%;
            min-height: 120px;
            padding: 0.875rem 1rem;
            background: var(--surface);
            border: 2px solid var(--border);
            border-radius: 12px;
            color: var(--text-primary);
            font-size: 0.9rem;
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            resize: vertical;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        textarea:hover {
            border-color: var(--primary);
        }

        textarea:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 4px var(--glow);
        }

        input[type="number"] {
            width: 100%;
            padding: 0.875rem 1rem;
            background: var(--surface);
            border: 2px solid var(--border);
            border-radius: 12px;
            color: var(--text-primary);
            font-size: 1rem;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        input[type="number"]:hover {
            border-color: var(--primary);
        }

        input[type="number"]:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 4px var(--glow);
        }

        .btn-secondary {
            background: var(--surface-light);
            color: var(--text-primary);
            border: 2px solid var(--border);
            box-shadow: none;
        }

        .btn-secondary:hover:not(:disabled) {
            background: var(--surface);
            border-color: var(--primary);
        }

        .model-status {
            margin-top: 0.5rem;
            font-size: 0.875rem;
            padding: 0.5rem;
            border-radius: 8px;
        }

        .model-status.fetching {
            color: var(--primary);
            background: rgba(8, 164, 213, 0.1);
        }

        .model-status.success {
            color: #10b981;
            background: rgba(16, 185, 129, 0.1);
        }

        .model-status.error {
            color: var(--danger);
            background: rgba(239, 68, 68, 0.1);
        }

        .spinner-small {
            display: inline-block;
            width: 12px;
            height: 12px;
            border: 2px solid rgba(8, 164, 213, 0.2);
            border-top-color: var(--primary);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }

        /* Dark mode overrides */
        [data-theme="dark"] .card {
            background: rgba(20, 25, 49, 0.85);
        }

        [data-theme="dark"] .instructions-modal {
            background: rgba(20, 25, 49, 0.95);
        }

        [data-theme="dark"] .instructions-overlay {
            background: rgba(0, 0, 0, 0.7);
        }

        [data-theme="dark"] input[type="file"],
        [data-theme="dark"] select,
        [data-theme="dark"] textarea,
        [data-theme="dark"] input[type="number"] {
            background: var(--surface-light);
            color: var(--text-primary);
        }

        [data-theme="dark"] .file-input-label {
            background: var(--surface-light);
        }

        [data-theme="dark"] .btn-secondary {
            background: var(--surface);
        }

        /* Theme Toggle Button */
        .theme-toggle {
            position: fixed;
            top: 2rem;
            right: 2rem;
            width: 48px;
            height: 48px;
            background: rgba(255, 255, 255, 0.9);
            border: 2px solid var(--border);
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            z-index: 9999;
            box-shadow: 0 4px 12px var(--shadow);
            backdrop-filter: blur(10px);
        }

        [data-theme="dark"] .theme-toggle {
            background: rgba(20, 25, 49, 0.9);
            border-color: var(--border);
        }

        .theme-toggle:hover {
            transform: translateY(-2px) scale(1.05);
            box-shadow: 0 8px 20px var(--shadow);
            border-color: var(--primary);
        }

        .theme-toggle:active {
            transform: translateY(0) scale(0.98);
        }

        .theme-toggle-icon {
            font-size: 1.5rem;
            transition: all 0.3s ease;
        }

        .theme-toggle-icon.sun {
            display: block;
        }

        .theme-toggle-icon.moon {
            display: none;
        }

        [data-theme="dark"] .theme-toggle-icon.sun {
            display: none;
        }

        [data-theme="dark"] .theme-toggle-icon.moon {
            display: block;
        }

        @media (max-width: 768px) {
            .theme-toggle {
                top: 1rem;
                right: 1rem;
                width: 42px;
                height: 42px;
            }

            .theme-toggle-icon {
                font-size: 1.25rem;
            }
        }
    </style>
</head>
<body>
    <!-- Theme Toggle Button -->
    <button class="theme-toggle" id="themeToggle" aria-label="Toggle theme">
        <span class="theme-toggle-icon sun">☀️</span>
        <span class="theme-toggle-icon moon">🌙</span>
    </button>

    <div class="container">
        <div class="header">
            <div class="logo-icon">📄</div>
            <h1>File Translation</h1>
            <div class="subtitle">Upload and translate your subtitle files</div>
        </div>

        <!-- Instructions Modal -->
        <div class="instructions-overlay" id="instructionsOverlay">
            <div class="instructions-modal">
                <div class="instructions-modal-header">
                    <div class="instructions-modal-title">
                        <span>📝</span>
                        <span>How It Works</span>
                    </div>
                    <button class="instructions-modal-close" id="closeInstructions">×</button>
                </div>
                <div class="instructions-modal-content">
                    <p><strong>✨ Supported formats:</strong> SRT, VTT, ASS, SSA</p>
                    <br>
                    <p><strong>📋 Steps:</strong></p>
                    <ol>
                        <li>Upload your subtitle file (any supported format)</li>
                        <li>Select your target language</li>
                        <li>Click "Translate" and wait for the magic ✨</li>
                        <li>Download your translated subtitle</li>
                        <li>Drag it to Stremio 🎬</li>
                    </ol>
                    <div class="instructions-modal-footer">
                        <label class="instructions-modal-checkbox">
                            <input type="checkbox" id="dontShowInstructions">
                            Don't show this again
                        </label>
                        <button class="instructions-modal-btn" id="gotItBtn">Got it!</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- Floating Help Button -->
        <button class="help-button" id="showInstructions" title="Show Instructions">?</button>

        <div class="card">
            <form id="translationForm">
                <div class="form-group">
                    <label for="fileInput">
                        Subtitle File
                        <span class="label-description">Choose a subtitle file to translate</span>
                    </label>
                    <div class="file-input-wrapper">
                        <input type="file" id="fileInput" accept=".srt,.vtt,.ass,.ssa" required>
                        <label for="fileInput" class="file-input-label">
                            <div class="icon">📁</div>
                            <div class="main-text">Click to browse files</div>
                            <div class="sub-text">or drag and drop here</div>
                        </label>
                    </div>
                    <div class="file-name" id="fileName"></div>
                </div>

                <div class="form-group">
                    <label for="targetLang">
                        Target Language
                        <span class="label-description">Select the language to translate to</span>
                    </label>
                    <select id="targetLang" required>
                        <option value="">Choose a language...</option>
                        ${languageOptions}
                    </select>
                    <label class="language-toggle">
                        <input type="checkbox" id="showAllLanguages">
                        <span>Show all languages</span>
                    </label>
                </div>

                <!-- Advanced Settings -->
                <div class="advanced-settings" id="advancedSettings">
                    <div class="advanced-settings-header" id="advancedSettingsHeader">
                        <div class="advanced-settings-title">
                            <span class="advanced-settings-icon">🔬</span>
                            <span>Advanced Settings (EXPERIMENTAL)</span>
                        </div>
                        <div class="advanced-settings-toggle">▼</div>
                    </div>
                    <div class="advanced-settings-content">
                        <div class="advanced-settings-inner">
                            <div class="highlight-box">
                                <p>
                                    <strong>Fine-tune AI behavior for this translation only:</strong> Override model and parameters.
                                    <em>These settings are temporary and won't be saved to your config.</em>
                                </p>
                            </div>

                            <div class="form-group">
                                <label for="advancedModel">
                                    Translation Model Override
                                    <span class="label-description">Override the default model for this translation only.</span>
                                </label>
                                <select id="advancedModel">
                                    <option value="">Use Default Model (${config.geminiModel || 'gemini-2.5-flash-lite-preview-09-2025'})</option>
                                </select>
                                <div class="model-status" id="modelStatus"></div>
                            </div>

                            <div class="form-group">
                                <label for="customPrompt">
                                    Custom Translation Prompt
                                    <span class="label-description">Custom prompt template. Use {target_language} as placeholder. Leave empty for default.</span>
                                </label>
                                <textarea id="customPrompt" placeholder="Example: Translate the following subtitles to {target_language}..."></textarea>
                            </div>

                            <div class="form-group">
                                <label for="advancedThinkingBudget">
                                    Thinking Budget (Extended Reasoning)
                                    <span class="label-description">0 = disabled, -1 = dynamic (auto-adjust), or fixed token count (1-32768).</span>
                                </label>
                                <input type="number" id="advancedThinkingBudget" min="-1" max="32768" step="1" value="0" placeholder="0">
                            </div>

                            <div class="form-group">
                                <label for="advancedTemperature">
                                    Temperature (Creativity)
                                    <span class="label-description">Controls randomness (0.0-2.0). Lower = deterministic, Higher = creative. Default: 0.8</span>
                                </label>
                                <input type="number" id="advancedTemperature" min="0" max="2" step="0.1" value="0.8" placeholder="0.8">
                            </div>

                            <div class="form-group">
                                <label for="advancedTopP">
                                    Top-P (Nucleus Sampling)
                                    <span class="label-description">Probability threshold (0.0-1.0). Lower = focused, Higher = diverse. Default: 0.95</span>
                                </label>
                                <input type="number" id="advancedTopP" min="0" max="1" step="0.05" value="0.95" placeholder="0.95">
                            </div>

                            <div class="form-group">
                                <label for="advancedTopK">
                                    Top-K (Token Selection)
                                    <span class="label-description">Number of top tokens to consider (1-100). Default: 40</span>
                                </label>
                                <input type="number" id="advancedTopK" min="1" max="100" step="1" value="40" placeholder="40">
                            </div>

                            <div class="form-group">
                                <label for="advancedMaxTokens">
                                    Max Output Tokens
                                    <span class="label-description">Maximum tokens in output (1024-65536). Default: 65536</span>
                                </label>
                                <input type="number" id="advancedMaxTokens" min="1024" max="65536" step="1024" value="65536" placeholder="65536">
                            </div>

                            <div class="form-group">
                                <label for="advancedTimeout">
                                    Translation Timeout (seconds)
                                    <span class="label-description">Maximum time to wait for translation (60-1200). Default: 600</span>
                                </label>
                                <input type="number" id="advancedTimeout" min="60" max="1200" step="30" value="600" placeholder="600">
                            </div>

                            

                            <button type="button" class="btn btn-secondary" id="resetDefaultsBtn">
                                🔄 Reset to Defaults
                            </button>
                        </div>
                    </div>
                </div>

                <button type="submit" class="btn" id="translateBtn">
                    🚀 Start Translation
                </button>
            </form>

            <div class="progress" id="progress">
                <div class="spinner"></div>
                <div class="progress-text">Translating your subtitle...</div>
                <div class="progress-subtext">This may take 1-4 minutes depending on file size</div>
            </div>

            <div class="result" id="result">
                <div class="result-icon">✓</div>
                <h2>Translation Complete!</h2>
                <p>Your subtitle has been successfully translated.</p>
                <a href="#" id="downloadLink" class="download-btn" download="translated.srt">
                    ⬇️ Download Translated Subtitle
                </a>
                <button type="button" class="btn btn-secondary" id="translateAnotherBtn" style="margin-top: 1rem;">
                    🔄 Translate Another One
                </button>
            </div>

            <div class="error" id="error"></div>
        </div>
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
        const showAllLanguagesCheckbox = document.getElementById('showAllLanguages');

        // Language lists
        const configuredLanguages = \`<option value="">Choose a language...</option>${languageOptions}\`;
        const allLanguagesList = \`<option value="">Choose a language...</option>${allLanguageOptions}\`;

        // Language toggle functionality
        showAllLanguagesCheckbox.addEventListener('change', function() {
            const currentValue = targetLang.value; // Save current selection

            if (this.checked) {
                // Switch to all languages
                targetLang.innerHTML = allLanguagesList;
            } else {
                // Switch back to configured languages
                targetLang.innerHTML = configuredLanguages;
            }

            // Restore selection if it exists in the new list
            if (currentValue) {
                const optionExists = Array.from(targetLang.options).some(opt => opt.value === currentValue);
                if (optionExists) {
                    targetLang.value = currentValue;
                }
            }
        });

        // Advanced settings elements
        const advancedSettings = document.getElementById('advancedSettings');
        const advancedSettingsHeader = document.getElementById('advancedSettingsHeader');
        const advancedModel = document.getElementById('advancedModel');
        const customPrompt = document.getElementById('customPrompt');
        const advancedThinkingBudget = document.getElementById('advancedThinkingBudget');
        const advancedTemperature = document.getElementById('advancedTemperature');
        const advancedTopP = document.getElementById('advancedTopP');
        const advancedTopK = document.getElementById('advancedTopK');
        const advancedMaxTokens = document.getElementById('advancedMaxTokens');
        const advancedTimeout = document.getElementById('advancedTimeout');
        
        const resetDefaultsBtn = document.getElementById('resetDefaultsBtn');
        const translateAnotherBtn = document.getElementById('translateAnotherBtn');
        const modelStatus = document.getElementById('modelStatus');

        // Advanced settings toggle
        advancedSettingsHeader.addEventListener('click', () => {
            advancedSettings.classList.toggle('expanded');
        });

        // Default values for reset
        const defaults = {
            thinkingBudget: 0,
            temperature: 0.8,
            topP: 0.95,
            topK: 40,
            maxTokens: 65536,
            timeout: 600
        };

        // Reset to defaults
        resetDefaultsBtn.addEventListener('click', () => {
            advancedModel.value = '';
            customPrompt.value = '';
            advancedThinkingBudget.value = defaults.thinkingBudget;
            advancedTemperature.value = defaults.temperature;
            advancedTopP.value = defaults.topP;
            advancedTopK.value = defaults.topK;
            advancedMaxTokens.value = defaults.maxTokens;
            advancedTimeout.value = defaults.timeout;
        });

        // Translate another one button
        translateAnotherBtn.addEventListener('click', () => {
            // Hide result
            result.classList.remove('active');
            // Show form
            form.style.display = 'block';
            // Clear file input
            fileInput.value = '';
            fileName.textContent = '';
            fileName.classList.remove('active');
            // Scroll to top
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });

        // Fetch models from API
        async function fetchModels() {
            const geminiApiKey = '${config.geminiApiKey || ''}';

            if (!geminiApiKey || geminiApiKey.length < 10) {
                return;
            }

            modelStatus.innerHTML = '<div class="spinner-small"></div> Fetching models...';
            modelStatus.className = 'model-status fetching';

            try {
                const response = await fetch('/api/gemini-models', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ apiKey: geminiApiKey })
                });

                if (!response.ok) {
                    throw new Error('Failed to fetch models');
                }

                const models = await response.json();

                modelStatus.innerHTML = '✓ Models loaded!';
                modelStatus.className = 'model-status success';

                setTimeout(() => {
                    modelStatus.innerHTML = '';
                    modelStatus.className = 'model-status';
                }, 3000);

                // Populate model dropdown
                advancedModel.innerHTML = '<option value="">Use Default Model (${config.geminiModel || 'gemini-2.5-flash-lite-preview-09-2025'})</option>';

                models.forEach(model => {
                    const option = document.createElement('option');
                    option.value = model.name;
                    option.textContent = model.displayName || model.name;
                    advancedModel.appendChild(option);
                });

            } catch (error) {
                console.error('Failed to fetch models:', error);
                modelStatus.innerHTML = '✗ Failed to fetch models';
                modelStatus.className = 'model-status error';

                setTimeout(() => {
                    modelStatus.innerHTML = '';
                    modelStatus.className = 'model-status';
                }, 5000);
            }
        }

        // Auto-fetch models when advanced settings are opened
        let modelsFetched = false;
        advancedSettingsHeader.addEventListener('click', () => {
            if (!modelsFetched && advancedSettings.classList.contains('expanded')) {
                modelsFetched = true;
                fetchModels();
            }
        });

        // Instructions modal handlers
        const instructionsOverlay = document.getElementById('instructionsOverlay');
        const showInstructionsBtn = document.getElementById('showInstructions');
        const closeInstructionsBtn = document.getElementById('closeInstructions');
        const gotItBtn = document.getElementById('gotItBtn');
        const dontShowAgainCheckbox = document.getElementById('dontShowInstructions');

        // Function to close modal with checkbox check
        function closeInstructionsModal() {
            if (dontShowAgainCheckbox && dontShowAgainCheckbox.checked) {
                localStorage.setItem('submaker_file_upload_dont_show_instructions', 'true');
            }
            instructionsOverlay.classList.remove('show');
        }

        // Show modal on first visit
        const dontShowInstructions = localStorage.getItem('submaker_file_upload_dont_show_instructions');
        if (!dontShowInstructions) {
            setTimeout(() => {
                instructionsOverlay.classList.add('show');
            }, 500);
        }

        // Show instructions button click
        showInstructionsBtn.addEventListener('click', () => {
            instructionsOverlay.classList.add('show');
        });

        // Close instructions button click
        closeInstructionsBtn.addEventListener('click', closeInstructionsModal);

        // Got it button click
        gotItBtn.addEventListener('click', closeInstructionsModal);

        // Close modal when clicking outside
        instructionsOverlay.addEventListener('click', (e) => {
            if (e.target === instructionsOverlay) {
                closeInstructionsModal();
            }
        });

        // Close modal with Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && instructionsOverlay.classList.contains('show')) {
                closeInstructionsModal();
            }
        });

        // Handle file selection
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                const file = e.target.files[0];
                fileName.textContent = '📄 ' + file.name;
                fileName.classList.add('active');
            } else {
                fileName.textContent = '';
                fileName.classList.remove('active');
            }
        });

        // Handle drag and drop
        const fileLabel = document.querySelector('.file-input-label');

        fileLabel.addEventListener('dragover', (e) => {
            e.preventDefault();
            fileLabel.style.borderColor = 'var(--primary)';
            fileLabel.style.background = 'var(--surface-light)';
        });

        fileLabel.addEventListener('dragleave', (e) => {
            e.preventDefault();
            fileLabel.style.borderColor = 'var(--border)';
            fileLabel.style.background = 'var(--surface)';
        });

        fileLabel.addEventListener('drop', (e) => {
            e.preventDefault();
            fileLabel.style.borderColor = 'var(--border)';
            fileLabel.style.background = 'var(--surface)';

            if (e.dataTransfer.files.length > 0) {
                fileInput.files = e.dataTransfer.files;
                const event = new Event('change');
                fileInput.dispatchEvent(event);
            }
        });

        // Handle form submission
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

                // Build config with advanced settings
                const baseConfig = ${JSON.stringify(config)};

                // Apply advanced settings if any are changed from defaults
                const selectedModel = advancedModel.value;
                const selectedPrompt = customPrompt.value.trim();
                const thinkingBudget = parseInt(advancedThinkingBudget.value);
                const temperature = parseFloat(advancedTemperature.value);
                const topP = parseFloat(advancedTopP.value);
                const topK = parseInt(advancedTopK.value);
                const maxTokens = parseInt(advancedMaxTokens.value);
                const timeout = parseInt(advancedTimeout.value);
                

                // Create modified config with advanced settings
                const modifiedConfig = { ...baseConfig };

                // Override model if selected
                if (selectedModel) {
                    modifiedConfig.geminiModel = selectedModel;
                }

                // Override prompt if provided
                if (selectedPrompt) {
                    modifiedConfig.translationPrompt = selectedPrompt;
                }

                // Apply advanced settings
                modifiedConfig.advancedSettings = {
                    ...baseConfig.advancedSettings,
                    geminiModel: selectedModel || '',
                    thinkingBudget: thinkingBudget,
                    temperature: temperature,
                    topP: topP,
                    topK: topK,
                    maxOutputTokens: maxTokens,
                    translationTimeout: timeout
                };

                // Serialize config (proper UTF-8 to base64 encoding)
                const configStr = btoa(unescape(encodeURIComponent(JSON.stringify(modifiedConfig))));

                // Send to translation API
                const response = await fetch('/api/translate-file', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        content: fileContent,
                        targetLanguage: targetLang.value,
                        configStr: configStr
                    })
                });

                if (!response.ok) {
                    throw new Error('Translation failed: ' + await response.text());
                }

                const translatedContent = await response.text();

                // Get file extension
                const originalExt = file.name.split('.').pop().toLowerCase();
                const downloadExt = originalExt || 'srt';

                // Create download link
                const blob = new Blob([translatedContent], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                downloadLink.href = url;
                downloadLink.download = 'translated_' + targetLang.value + '.' + downloadExt;

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
            error.textContent = '⚠️ ' + message;
            error.classList.add('active');
        }

        // Theme switching functionality
        (function() {
            const html = document.documentElement;
            const themeToggle = document.getElementById('themeToggle');

            // Check for saved theme preference or default to system preference
            function getPreferredTheme() {
                const savedTheme = localStorage.getItem('theme');
                if (savedTheme) {
                    return savedTheme;
                }

                // Check system preference
                if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                    return 'dark';
                }

                return 'light';
            }

            // Apply theme
            function setTheme(theme) {
                html.setAttribute('data-theme', theme);
                localStorage.setItem('theme', theme);
            }

            // Initialize theme on page load
            const initialTheme = getPreferredTheme();
            setTheme(initialTheme);

            // Toggle theme on button click
            if (themeToggle) {
                themeToggle.addEventListener('click', function() {
                    const currentTheme = html.getAttribute('data-theme');
                    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
                    setTheme(newTheme);
                });
            }

            // Listen for system theme changes
            if (window.matchMedia) {
                window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
                    // Only auto-switch if user hasn't manually set a preference
                    if (!localStorage.getItem('theme')) {
                        setTheme(e.matches ? 'dark' : 'light');
                    }
                });
            }
        })();
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

    // Track if response has ended to prevent double-calling res.end()
    let responseEnded = false;

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
        // Prevent res.end() from being called multiple times
        if (responseEnded) {
            log.warn(() => '[Server] res.end() called multiple times on response');
            return;
        }
        responseEnded = true;

        // Handle string chunks
        if (chunk && typeof chunk === 'string') {
            // Replace {{ADDON_URL}} with actual addon URL
            chunk = chunk.replace(/\{\{ADDON_URL\}\}/g, addonUrl);
        }
        // Handle Buffer chunks (convert to string, replace, convert back)
        else if (chunk && Buffer.isBuffer(chunk)) {
            try {
                let str = chunk.toString('utf-8');
                str = str.replace(/\{\{ADDON_URL\}\}/g, addonUrl);
                chunk = Buffer.from(str, 'utf-8');
            } catch (e) {
                log.error(() => '[Server] Failed to process buffer chunk:', e.message);
                // Continue with original chunk if processing fails
            }
        }

        originalEnd.call(this, chunk, encoding);
    };

    next();
});

// Stremio addon manifest route (AFTER middleware so URLs get replaced)
app.get('/addon/:config/manifest.json', (req, res) => {
    try {
        log.debug(() => `[Manifest] Parsing config for manifest request`);
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
        log.debug(() => `[Manifest] Using base URL: ${baseUrl}`);

        const builder = createAddonWithConfig(config, baseUrl);
        const manifest = builder.getInterface().manifest;

        res.json(manifest);
    } catch (error) {
        log.error(() => '[Manifest] Error:', error);
        res.status(500).json({ error: 'Failed to generate manifest' });
    }
});

// Custom route: Handle base addon path (when user clicks config in Stremio)
// This route handles /addon/:config (with no trailing path) and redirects to configure
// It must be placed AFTER all specific routes but BEFORE the SDK router
app.get('/addon/:config', (req, res, next) => {
    try {
        const { config: configStr } = req.params;
        log.debug(() => `[Addon Base] Request to base addon path, redirecting to configure page`);
        // Redirect to main configure page with config parameter
        res.redirect(302, `/configure?config=${encodeURIComponent(configStr)}`);
    } catch (error) {
        log.error(() => '[Addon Base] Error:', error);
        res.status(500).send('Failed to load configuration page');
    }
});

// Mount Stremio SDK router for each configuration
app.use('/addon/:config', (req, res, next) => {
    try {
        const configStr = req.params.config;

        // Check cache first
        if (!routerCache.has(configStr)) {
            log.debug(() => `[Router] Parsing config for new router (path: ${req.path})`);
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
            log.debug(() => `[Router] Created and cached router for config`);
        }

        const router = routerCache.get(configStr);
        router(req, res, next);
    } catch (error) {
        log.error(() => '[Router] Error:', error);
        next(error);
    }
});

// Error handling middleware - Route-specific handlers
// Error handler for /addon/:config/subtitle/* routes (returns SRT format)
app.use('/addon/:config/subtitle', (error, req, res, next) => {
    log.error(() => '[Server] Subtitle Error:', error.message);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(500).end('ERROR: Subtitle unavailable\n\n');
});

// Error handler for /addon/:config/translate/* routes (returns SRT format)
app.use('/addon/:config/translate', (error, req, res, next) => {
    log.error(() => '[Server] Translation Error:', error.message);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(500).end('ERROR: Translation unavailable\n\n');
});

// Error handler for /addon/:config/translate-selector/* routes (returns HTML format)
app.use('/addon/:config/translate-selector', (error, req, res, next) => {
    log.error(() => '[Server] Translation Selector Error:', error.message);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(500).end('<html><body><p>Error: Failed to load subtitle selector</p></body></html>');
});

// Error handler for /addon/:config/file-translate/* routes (returns redirect/HTML format)
app.use('/addon/:config/file-translate', (error, req, res, next) => {
    log.error(() => '[Server] File Translation Error:', error.message);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(500).end('<html><body><p>Error: Failed to load file translation page</p></body></html>');
});

// Default error handler for manifest/router and other routes (JSON responses)
app.use((error, req, res, next) => {
    log.error(() => '[Server] General Error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
});

// Initialize sync cache
(async () => {
    try {
        await syncCache.initSyncCache();
        log.debug(() => '[Startup] Sync cache initialized successfully');
    } catch (error) {
        log.error(() => '[Startup] Failed to initialize sync cache:', error.message);
    }
})();

// Start server and setup graceful shutdown
const server = app.listen(PORT, () => {
    // Get log level and file logging status
    const logLevel = (process.env.LOG_LEVEL || 'warn').toUpperCase();
    const logToFile = process.env.LOG_TO_FILE !== 'false' ? 'ENABLED' : 'DISABLED';
    const logDir = process.env.LOG_DIR || 'logs/';
    const storageType = (process.env.STORAGE_TYPE || 'filesystem').toUpperCase();

    // Use console.startup to ensure banner always shows regardless of log level
    console.startup(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🎬 SubMaker - Subtitle Translator Addon                ║
║                                                           ║
║   Server running on: http://localhost:${PORT}            ║
║                                                           ║
║   Configure addon: http://localhost:${PORT}/configure    ║
║                                                           ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║   Version:        v${version.padEnd(35)}║
║   Log Level:      ${logLevel.padEnd(35)}║
║   File Logging:   ${logToFile.padEnd(35)}║
║   Log Directory:  ${logDir.padEnd(35)}║
║   Storage Type:   ${storageType.padEnd(35)}║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
    `);

    // Setup graceful shutdown handlers now that server is running
    sessionManager.setupShutdownHandlers(server);
});

module.exports = app;
