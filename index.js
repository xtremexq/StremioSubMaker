// Load environment variables from .env file FIRST (before anything else)
require('dotenv').config();

// Load logger utility first to intercept all console methods with timestamps
const log = require('./src/utils/logger');

// Initialize Sentry for error tracking (must be early to catch all errors)
// Set SENTRY_DSN in environment to enable
const sentry = require('./src/utils/sentry');
sentry.init();

// Global error handlers to catch unhandled errors and report to Sentry
process.on('unhandledRejection', (reason, promise) => {
    log.error(() => ['[Process] Unhandled Promise Rejection:', reason]);
    sentry.captureErrorForced(reason instanceof Error ? reason : new Error(String(reason)), {
        module: 'UnhandledRejection',
        type: 'unhandledRejection'
    });
});

process.on('uncaughtException', (error) => {
    log.error(() => ['[Process] Uncaught Exception:', error]);
    sentry.captureErrorForced(error, {
        module: 'UncaughtException',
        type: 'uncaughtException'
    });
    // Give Sentry time to send the error before crashing
    setTimeout(() => process.exit(1), 1000);
});

const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { RedisStore: RateLimitRedisStore } = require('rate-limit-redis');
const { LRUCache } = require('lru-cache');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const Joi = require('joi');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { pipeline } = require('stream/promises');

const { parseConfig, getDefaultConfig, buildManifest, normalizeConfig, getLanguageSelectionLimits, getDefaultProviderParameters, mergeProviderParameters, selectGeminiApiKey, getEffectiveGeminiModel } = require('./src/utils/config');
const { parseSRT, toSRT, sanitizeSubtitleText, srtPairToWebVTT, ensureSRTForTranslation, detectASSFormat } = require('./src/utils/subtitle');
const { version } = require('./src/utils/version');
const { redactToken } = require('./src/utils/security');
const { getAllLanguages, getAllTranslationLanguages, getLanguageName, toISO6392, findISO6391ByName, canonicalSyncLanguageCode } = require('./src/utils/languages');
const { generateCacheKeys } = require('./src/utils/cacheKeys');
const { getCached: getDownloadCached, saveCached: saveDownloadCached, getCacheStats: getDownloadCacheStats } = require('./src/utils/downloadCache');
const { createSubtitleHandler, handleSubtitleDownload, handleTranslation, createLoadingSubtitle, createSessionTokenErrorSubtitle, createOpenSubtitlesAuthErrorSubtitle, createOpenSubtitlesQuotaExceededSubtitle, createCredentialDecryptionErrorSubtitle, createTranslationErrorSubtitle, readFromPartialCache, hasCachedTranslation, purgeTranslationCache, translationStatus, inFlightTranslations, canUserStartTranslation, getHistoryForUser, migrateHistoryNamespace, resolveHistoryUserHash, saveRequestToHistory, resolveHistoryTitle, enrichHistoryEntriesBackground, maybeConvertToSRT } = require('./src/handlers/subtitles');
const GeminiService = require('./src/services/gemini');
const TranslationEngine = require('./src/services/translationEngine');
const { createProviderInstance, createTranslationProvider, resolveCfWorkersCredentials } = require('./src/services/translationProviderFactory');
const { quickNavScript } = require('./src/utils/quickNav');
const streamActivity = require('./src/utils/streamActivity');
// parallelTranslation is now handled internally by TranslationEngine
const syncCache = require('./src/utils/syncCache');
const autoSubCache = require('./src/utils/autoSubCache');
const { warmUpConnections, startKeepAlivePings, stopKeepAlivePings, getPoolStats } = require('./src/utils/httpAgents');
const embeddedCache = require('./src/utils/embeddedCache');
const { detectEmbeddedSubtitleFormat, prepareEmbeddedSubtitleDelivery } = require('./src/utils/embeddedSubtitleDelivery');
const { buildEmbeddedHistoryContext, normalizeEmbeddedHistoryValue } = require('./src/utils/embeddedHistoryContext');
const { generateSubtitleSyncPage } = require('./src/utils/syncPageGenerator');
const { generateSubToolboxPage, generateEmbeddedSubtitlePage, generateAutoSubtitlePage } = require('./src/utils/toolboxPageGenerator');
const { generateHistoryPage, renderHistoryContent } = require('./src/utils/historyPageGenerator');
const { generateSmdbPage } = require('./src/utils/smdbPageGenerator');
const { generateConfigurePage } = require('./src/utils/configurePageGenerator');
const smdbCache = require('./src/utils/smdbCache');
const { deriveVideoHash } = require('./src/utils/videoHash');
const { registerFileUploadRoutes } = require('./src/routes/fileUploadRoutes');
const {
    validateRequest,
    subtitleParamsSchema,
    subtitleContentParamsSchema,
    translationParamsSchema,
    fileTranslationBodySchema,
    configStringSchema,
    validateInput
} = require('./src/utils/validation');
const { MAX_SESSION_BRIEF_BATCH, getSessionManager, stripInternalFlags } = require('./src/utils/sessionManager');
const { runStartupValidation } = require('./src/utils/startupValidation');
const { StorageUnavailableError } = require('./src/storage/errors');
const StorageFactory = require('./src/storage/StorageFactory');
const { loadLocale, getTranslator, DEFAULT_LANG } = require('./src/utils/i18n');
const { incrementCounter, CACHE_PREFIXES, CACHE_TTLS } = require('./src/utils/sharedCache');
const { loadChangelog } = require('./src/utils/changelog');

// Cache-buster path segment for temporary HA cache invalidation
// Default to current package version so it auto-advances on releases
const CACHE_BUSTER_VERSION = process.env.CACHE_BUSTER_VERSION || version;
const CACHE_BUSTER_PATH = `/v${CACHE_BUSTER_VERSION}`;

log.info(() => `[Startup] Cache buster active: ${CACHE_BUSTER_PATH}`);

const SUBTITLE_EXTRA_QUERY_KEYS = new Set(['filename', 'videoHash', 'videoSize']);

const PORT = process.env.PORT || 7001;
// Reject suspicious host headers early (defense against host header injection)
// Allow alphanumeric, dots, hyphens, underscores, and optional port
const HOST_HEADER_REGEX = /^[A-Za-z0-9._-]+(?::\d+)?$/;
const TRACE_CONFIG_RESOLVE = process.env.TRACE_CONFIG_RESOLVE === 'true';

function normalizeSubtitleQueryExtras(req) {
    if (!req || typeof req.url !== 'string') return false;

    const queryIndex = req.url.indexOf('?');
    if (queryIndex === -1) return false;

    const pathPart = req.url.slice(0, queryIndex);
    const queryPart = req.url.slice(queryIndex + 1);
    if (!pathPart.includes('/subtitles/')) return false;

    // Only rewrite requests that use the SDK-incompatible query-string variant:
    //   /subtitles/{type}/{id}.json?filename=...&videoHash=...
    if (!/\/subtitles\/[^/]+\/[^/]+\.json$/i.test(pathPart)) return false;

    const params = new URLSearchParams(queryPart);
    const normalizedEntries = [];
    const passthroughEntries = [];
    const seenExtraKeys = new Set();

    for (const [key, value] of params.entries()) {
        if (SUBTITLE_EXTRA_QUERY_KEYS.has(key) && !seenExtraKeys.has(key)) {
            seenExtraKeys.add(key);
            if (typeof value === 'string' && value.length > 0) {
                normalizedEntries.push([key, value]);
                continue;
            }
        }
        passthroughEntries.push([key, value]);
    }

    if (normalizedEntries.length === 0) return false;

    const extraSegment = normalizedEntries
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
    const rebuiltPath = pathPart.replace(/\.json$/i, `/${extraSegment}.json`);
    const passthroughQuery = passthroughEntries.length
        ? `?${new URLSearchParams(passthroughEntries).toString()}`
        : '';

    req.url = `${rebuiltPath}${passthroughQuery}`;
    req.__subtitleQueryExtraNormalized = normalizedEntries.map(([key]) => key);
    log.debug(() => `[Subtitle Extra Normalize] Rewrote query-style subtitle extras for ${pathPart.substring(0, 120)} (keys: ${req.__subtitleQueryExtraNormalized.join(',')})`);
    return true;
}

// Initialize session manager with environment-based configuration
// Memory limit: 30,000 sessions (LRU eviction) - reduced from 50k to balance memory usage
// Storage limit: 60,000 sessions (oldest-accessed purge at 90 days) - new cap to prevent unbounded growth
const sessionOptions = {
    maxSessions: parseInt(process.env.SESSION_MAX_SESSIONS) || 30000, // Limit to 30k concurrent in-memory sessions
    maxAge: parseInt(process.env.SESSION_MAX_AGE) || 90 * 24 * 60 * 60 * 1000, // 90 days (3 months)
    persistencePath: process.env.SESSION_PERSISTENCE_PATH || path.join(process.cwd(), 'data', 'sessions.json'),
    storageMaxSessions: parseInt(process.env.SESSION_STORAGE_MAX_SESSIONS) || 60000, // Limit to 60k sessions in storage
    storageMaxAge: parseInt(process.env.SESSION_STORAGE_MAX_AGE) || 90 * 24 * 60 * 60 * 1000 // 90 days storage retention
};
// Only override autoSaveInterval if explicitly provided via env; otherwise let SessionManager default apply
if (process.env.SESSION_SAVE_INTERVAL) {
    const parsed = parseInt(process.env.SESSION_SAVE_INTERVAL, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
        sessionOptions.autoSaveInterval = parsed;
    }
}
const sessionManager = getSessionManager(sessionOptions);

// Deployment warning: In multi-instance/Redis mode, require stable encryption key
if ((process.env.STORAGE_TYPE || 'redis') === 'redis' && !process.env.ENCRYPTION_KEY) {
    log.warn(() => '[Startup] WARNING: STORAGE_TYPE=redis without ENCRYPTION_KEY. Multiple instances must share the same encryption key to read sessions.');
}

// Security: LRU cache for routers to avoid creating them on every request (max 100 entries)
const routerCache = new LRUCache({
    max: 100, // Max 100 different configs cached
    ttl: 1000 * 60 * 60, // 1 hour TTL
    updateAgeOnGet: true,
});

// Small LRU for resolved configs to avoid re-normalizing on chatty endpoints (e.g., stream-activity polling)
const resolveConfigCache = new LRUCache({
    max: 1000,
    ttl: 1000 * 120, // 2 minutes
    updateAgeOnGet: true
});

function isStorageUnavailableError(error) {
    return error instanceof StorageUnavailableError || error?.isStorageUnavailable;
}

function respondStorageUnavailable(res, error, contextLabel = 'Storage', translator) {
    if (!res) return false;
    if (!isStorageUnavailableError(error)) {
        return false;
    }
    log.error(() => [`${contextLabel} temporarily unavailable:`, error?.message || error]);
    const tFunc = (() => {
        if (typeof translator === 'function') return translator;
        if (typeof translator === 'string') return getTranslator(translator);
        if (res?.locals?.t && typeof res.locals.t === 'function') return res.locals.t;
        return getTranslator(DEFAULT_LANG);
    })();
    res.status(503).json({
        error: tFunc('server.errors.storageUnavailable', {}, 'Session storage temporarily unavailable, please retry.')
    });
    return true;
}

// SECURITY: Strict validation to ensure a string is DEFINITELY NOT a session token
// This provides defense-in-depth against tokens accidentally being cached
function isDefinitelyNotToken(str) {
    if (!str || typeof str !== 'string') {
        return false; // Invalid input - treat as unsafe
    }
    // A string is definitely NOT a token if:
    // 1. It's not exactly 32 characters, OR
    // 2. It contains non-hex characters, OR
    // 3. It contains uppercase letters (tokens are lowercase hex)
    const is32HexChars = /^[a-f0-9]{32}$/.test(str);
    return !is32HexChars; // Return true if it's NOT a token pattern
}

// SECURITY: Validate that a cache entry doesn't contain sensitive session data
// Returns true if the config is safe to cache, false if it might contain user secrets
function isSafeToCache(config) {
    if (!config || typeof config !== 'object') {
        return false;
    }
    // Never cache configs with error flags (these are default/fallback configs)
    if (config.__sessionTokenError === true) {
        return false;
    }
    // Never cache configs that have an original token reference (sign of failed session)
    if (config.__originalToken) {
        return false;
    }
    return true;
}

async function resolveConfigGuarded(configStr, req, res, contextLabel = '[ConfigResolver]', translator = null) {
    try {
        const config = await resolveConfigAsync(configStr, req);
        if (config && config.__sessionDisabled === true) {
            respondDisabledSession(req, res, config, translator);
            return null;
        }
        return config;
    } catch (error) {
        if (respondStorageUnavailable(res, error, contextLabel, translator || res?.locals?.t)) {
            return null;
        }
        throw error;
    }
}

// Centralized helper to invalidate router cache when session configs change
function invalidateRouterCache(token, reason = '') {
    if (!token) return;
    const removed = routerCache.delete(token);
    if (removed) {
        log.debug(() => `[RouterCache] Invalidated router for ${redactToken(token)}${reason ? ` (${reason})` : ''}`);
    }
}

function invalidateResolveConfigCache(token) {
    if (!token) return;
    const removed = resolveConfigCache.delete(token);
    if (removed) {
        log.debug(() => `[ResolveConfigCache] Invalidated config for ${redactToken(token)}`);
    }
}

// SECURITY: Scan caches for contamination and purge suspicious entries
// This runs on startup to clean up any stale/contaminated cache entries
function cleanupCachesOnStartup() {
    log.info(() => '[Security] Running startup cache cleanup...');
    let routersPurged = 0;
    let configsPurged = 0;

    // Clean up router cache
    for (const [key, router] of routerCache.entries()) {
        let shouldPurge = false;
        let reason = '';

        // Purge routers with session token patterns
        if (/^[a-f0-9]{32}$/.test(key)) {
            shouldPurge = true;
            reason = 'session token in router cache';
        }
        // Purge routers missing required metadata
        else if (!router || !router.__configStr || !router.__createdAt) {
            shouldPurge = true;
            reason = 'missing metadata';
        }
        // Purge routers with mismatched config strings
        else if (router.__configStr !== key) {
            shouldPurge = true;
            reason = 'config string mismatch';
        }

        if (shouldPurge) {
            routerCache.delete(key);
            routersPurged++;
            log.warn(() => `[Security] Purged contaminated router: ${redactToken(key)} (${reason})`);
        }
    }

    // Clean up resolve config cache
    for (const [key, config] of resolveConfigCache.entries()) {
        let shouldPurge = false;
        let reason = '';

        // Purge configs with session token patterns
        if (/^[a-f0-9]{32}$/.test(key)) {
            shouldPurge = true;
            reason = 'session token in config cache';
        }
        // Purge configs with error flags
        else if (config && (config.__sessionTokenError || config.__originalToken)) {
            shouldPurge = true;
            reason = 'has error flags';
        }

        if (shouldPurge) {
            resolveConfigCache.delete(key);
            configsPurged++;
            log.warn(() => `[Security] Purged contaminated config: ${redactToken(key)} (${reason})`);
        }
    }

    if (routersPurged > 0 || configsPurged > 0) {
        log.warn(() => `[Security] Startup cache cleanup complete: purged ${routersPurged} routers, ${configsPurged} configs`);
    } else {
        log.info(() => '[Security] Startup cache cleanup complete: no contamination detected');
    }
}

function deriveStreamHashFromUrlServer(streamUrl, fallback = {}) {
    let filename = (fallback.filename || fallback.streamFilename || '').trim();
    let streamVideoId = (fallback.videoId || '').trim();
    if (streamUrl) {
        try {
            const url = new URL(streamUrl);
            // First, check for explicit filename-type params (these are reliable)
            const explicitParams = ['filename', 'file', 'download', 'dn'];
            let foundFilename = '';
            for (const key of explicitParams) {
                const val = url.searchParams.get(key);
                if (val && val.trim()) {
                    foundFilename = decodeURIComponent(val.trim().split('/').pop());
                    break;
                }
            }
            // Next, check pathname for a real filename (has extension)
            if (!foundFilename) {
                const parts = (url.pathname || '').split('/').filter(Boolean);
                if (parts.length) {
                    const lastPart = decodeURIComponent(parts[parts.length - 1]);
                    // If it looks like a real filename (has extension), use it
                    if (/\.[a-z0-9]{2,5}$/i.test(lastPart)) {
                        foundFilename = lastPart;
                    }
                }
            }
            // Then check 'name' param as fallback (often just title, not filename)
            if (!foundFilename) {
                const nameVal = url.searchParams.get('name');
                if (nameVal && nameVal.trim()) {
                    foundFilename = decodeURIComponent(nameVal.trim().split('/').pop());
                }
            }
            // Last resort: use pathname last part even without extension
            if (!foundFilename) {
                const parts = (url.pathname || '').split('/').filter(Boolean);
                if (parts.length) {
                    foundFilename = decodeURIComponent(parts[parts.length - 1]);
                }
            }
            if (foundFilename) {
                filename = foundFilename;
            }
            const idKeys = ['videoId', 'video', 'id', 'mediaid', 'imdb', 'tmdb', 'kitsu', 'anidb', 'mal', 'myanimelist', 'anilist', 'tvdb', 'simkl', 'livechart', 'anisearch'];
            for (const key of idKeys) {
                const val = url.searchParams.get(key);
                if (val && val.trim()) {
                    streamVideoId = val.trim();
                    break;
                }
            }
            if (!streamVideoId) {
                const parts = (url.pathname || '').split('/').filter(Boolean);
                const directId = parts.find((p) => /^tt\d+/i.test(p) || p.includes(':'));
                if (directId) streamVideoId = directId.trim();
            }
        } catch (_) {
            /* ignore parse errors */
        }
    }
    const hash = deriveVideoHash(filename, streamVideoId);
    return {
        hash,
        filename,
        videoId: streamVideoId,
        source: 'stream-url'
    };
}


function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const scaled = bytes / Math.pow(1024, idx);
    return `${scaled.toFixed(scaled >= 10 ? 0 : 1)}${units[idx]}`;
}


function formatTimestamp(seconds = 0) {
    const clamped = Math.max(0, Number(seconds) || 0);
    const hrs = Math.floor(clamped / 3600);
    const mins = Math.floor((clamped % 3600) / 60);
    const secs = Math.floor(clamped % 60);
    const ms = Math.floor((clamped - Math.floor(clamped)) * 1000);
    const pad = (v, len = 2) => String(v).padStart(len, '0');
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
}

function segmentsToSrt(segments = []) {
    if (!Array.isArray(segments) || segments.length === 0) return '';
    const lines = [];
    segments.forEach((seg, idx) => {
        const start = formatTimestamp(seg.start || seg.start_time || 0);
        const end = formatTimestamp(seg.end || seg.end_time || (Number(seg.start || 0) + 4));
        const text = (seg.text || seg.transcript || '').toString().trim() || '[...]';
        lines.push(String(idx + 1));
        lines.push(`${start} --> ${end}`);
        lines.push(text);
        lines.push('');
    });
    return lines.join('\n');
}

function stripSpeakerLabelPrefix(line = '') {
    if (typeof line !== 'string' || line.length === 0) return line;
    // Remove typical diarization prefixes like "Speaker 1:" or "[SPEAKER_00]"
    const pattern = /^\s*(?:<v\s+[^>]+>\s*)?(?:\[\s*)?(?:speaker|spk|spkr)\s*[._\-\s]*[0-9a-z]*\s*[:.)\]-]?\s*/i;
    if (!pattern.test(line)) return line;
    const withoutClosingTag = line.replace(/<\/v>/gi, '').trimEnd();
    return withoutClosingTag.replace(pattern, '').trimStart();
}

function stripSpeakerLabelsFromSrt(srt = '') {
    if (typeof srt !== 'string' || !srt) return srt || '';
    const lines = srt.split(/\r?\n/);
    return lines.map(stripSpeakerLabelPrefix).join('\n');
}

function srtTimecodeToMs(tc = '') {
    const m = /^\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/.exec(String(tc || '').trim());
    if (!m) return null;
    const toMs = (h, mm, s, ms) => (((parseInt(h, 10) || 0) * 60 + (parseInt(mm, 10) || 0)) * 60 + (parseInt(s, 10) || 0)) * 1000 + (parseInt(ms, 10) || 0);
    return {
        startMs: toMs(m[1], m[2], m[3], m[4]),
        endMs: toMs(m[5], m[6], m[7], m[8])
    };
}

function wrapSrtText(text = '', maxLineLength = 42, maxLines = 2) {
    const clean = sanitizeSubtitleText(text).replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    const words = clean.split(/\s+/);
    const lines = [''];
    words.forEach((word) => {
        const current = lines[lines.length - 1];
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length > maxLineLength && lines.length < maxLines) {
            lines.push(word);
        } else {
            lines[lines.length - 1] = candidate;
        }
    });
    return lines.join('\n');
}

function shouldMergeAutoSubEntries(prev, next, opts = {}) {
    if (!prev || !next) return false;
    const gap = (next.startMs ?? 0) - (prev.endMs ?? 0);
    const mergeGapMs = Number.isFinite(opts.mergeGapMs) ? opts.mergeGapMs : 500;
    if (gap > mergeGapMs || gap < -500) return false;
    const prevText = (prev.text || '').trim();
    const nextText = (next.text || '').trim();
    if (!prevText || !nextText) return false;
    if (/[.!?…]['"]?$/.test(prevText)) return false;
    // Only block on obvious speaker/section markers, not just any capital letter
    // (sentence boundaries are already caught by the punctuation check above)
    if (/^[-–—♪]/.test(nextText)) return false;
    const combinedLength = (prevText + ' ' + nextText).length;
    const maxChars = Number.isFinite(opts.maxMergedChars) ? opts.maxMergedChars : 180;
    if (combinedLength > maxChars) return false;
    const mergedDuration = Math.max(prev.endMs || 0, next.endMs || 0) - Math.min(prev.startMs || 0, next.startMs || 0);
    const maxDuration = Number.isFinite(opts.maxMergedDurationMs) ? opts.maxMergedDurationMs : 9000;
    if (mergedDuration > maxDuration) return false;
    return true;
}

function splitLongEntry(entry, opts = {}) {
    const maxChars = Number.isFinite(opts.maxEntryChars) ? opts.maxEntryChars : 160;
    const maxDuration = Number.isFinite(opts.maxEntryDurationMs) ? opts.maxEntryDurationMs : 9000;
    const duration = (entry.endMs || 0) - (entry.startMs || 0);
    const text = (entry.text || '').trim();
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    const parts = sentences.length ? sentences : text.split(/\s+(?=[A-Z])/).filter(Boolean);
    const needsSentenceSplit = parts.length > 1 && (duration > 1500 || text.length > 80);
    if (!text || ((text.length <= maxChars && duration <= maxDuration) && !needsSentenceSplit)) {
        return [entry];
    }

    const segments = parts.length ? parts : [text];
    const totalWeight = segments.reduce((sum, part) => sum + (part.length || 1), 0);
    const result = [];
    let cursor = entry.startMs || 0;
    segments.forEach((part, idx) => {
        const weight = part.length || 1;
        let slice = totalWeight ? Math.round((duration || 0) * (weight / totalWeight)) : Math.round((duration || 0) / segments.length);
        slice = Math.max(slice || 0, 800);
        const start = cursor;
        let end = start + slice;
        const last = idx === segments.length - 1;
        if (last || end > (entry.endMs || end)) {
            end = entry.endMs || end;
        }
        // Prevent zero-duration entries
        if (end <= start) end = start + 800;
        cursor = end;
        result.push({
            startMs: start,
            endMs: end,
            text: part.trim()
        });
    });
    return result;
}

function normalizeAutoSubSrt(srt = '', opts = {}) {
    try {
        const parsed = parseSRT(stripSpeakerLabelsFromSrt(srt || ''));
        const entries = parsed
            .map((entry) => {
                const times = srtTimecodeToMs(entry.timecode);
                if (!times) return null;
                const text = sanitizeSubtitleText(entry.text || '').replace(/\s+/g, ' ').trim();
                if (!text) return null;
                return {
                    startMs: times.startMs,
                    endMs: times.endMs,
                    text
                };
            })
            .filter(Boolean)
            .sort((a, b) => (a.startMs - b.startMs) || (a.endMs - b.endMs));

        if (!entries.length) return stripSpeakerLabelsFromSrt(srt || '').trim();
        if (opts && opts.preserveTiming === true) {
            const minDurationMs = Number.isFinite(opts.minDurationMs) ? opts.minDurationMs : 120;
            const maxLineLength = opts.maxLineLength || 42;
            const maxLines = opts.maxLines || 2;
            const preservedEntries = [];
            let lastEndMs = 0;
            entries.forEach((entry) => {
                const safeText = wrapSrtText(entry.text, maxLineLength, maxLines);
                if (!safeText) return;
                let startMs = Math.max(0, entry.startMs || 0);
                let endMs = Math.max(startMs + minDurationMs, entry.endMs || (startMs + minDurationMs));
                if (startMs < lastEndMs) startMs = lastEndMs;
                if (endMs <= startMs) endMs = startMs + minDurationMs;
                preservedEntries.push({
                    id: preservedEntries.length + 1,
                    timecode: `${formatTimestamp(startMs / 1000)} --> ${formatTimestamp(endMs / 1000)}`,
                    text: safeText
                });
                lastEndMs = endMs;
            });
            if (preservedEntries.length) {
                return toSRT(preservedEntries).trim();
            }
            return stripSpeakerLabelsFromSrt(srt || '').trim();
        }

        const merged = [];
        for (const entry of entries) {
            const last = merged[merged.length - 1];
            if (last && shouldMergeAutoSubEntries(last, entry, opts)) {
                last.endMs = Math.max(last.endMs, entry.endMs);
                last.text = `${last.text} ${entry.text}`.replace(/\s+/g, ' ').trim();
            } else {
                merged.push({ ...entry });
            }
        }

        const expanded = merged.flatMap((entry) => splitLongEntry(entry, opts));
        const finalEntries = expanded.map((entry, idx) => {
            // Ensure minimum duration of 800ms for each subtitle entry
            let endMs = entry.endMs || entry.startMs || 0;
            if (endMs <= (entry.startMs || 0)) endMs = (entry.startMs || 0) + 800;
            return {
                id: idx + 1,
                timecode: `${formatTimestamp((entry.startMs || 0) / 1000)} --> ${formatTimestamp(endMs / 1000)}`,
                text: wrapSrtText(entry.text, opts.maxLineLength || 42, opts.maxLines || 2)
            };
        });

        return toSRT(finalEntries).trim();
    } catch (_) {
        return stripSpeakerLabelsFromSrt(srt || '').trim();
    }
}

function safeModelKey(model) {
    if (!model) return 'auto';
    return String(model).toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 64) || 'auto';
}


function normalizeSyncLang(lang) {
    const val = (lang || '').toString().trim().toLowerCase();
    if (!val) return 'und';
    return canonicalSyncLanguageCode(val) || val || 'und';
}

async function resolveAutoSubTranslationProvider(config, providerKeyOverride, modelOverride) {
    const providers = (config && config.providers) || {};
    const mergedParams = mergeProviderParameters(getDefaultProviderParameters(), config?.providerParameters || {});
    const normalizeKey = (key) => String(key || '').trim().toLowerCase();
    const desiredKey = normalizeKey(providerKeyOverride || config?.mainProvider || 'gemini');
    const maybeBuildProvider = async (key, cfgOverride = null) => {
        const params = mergedParams[key] || mergedParams.default || {};
        const cfg = cfgOverride || (providers[key] || {});
        const provider = await createProviderInstance(key, cfg, params);
        if (!provider) return null;
        return {
            provider,
            providerName: key,
            providerModel: cfg.model,
            fallbackProviderName: ''
        };
    };
    const findProviderConfig = async () => {
        if (providers[desiredKey]) return providers[desiredKey];
        const match = Object.keys(providers || {}).find((k) => normalizeKey(k) === desiredKey);
        if (match) return providers[match];
        if (desiredKey === 'gemini') {
            return {
                enabled: true,
                apiKey: await selectGeminiApiKey(config),
                model: modelOverride || getEffectiveGeminiModel(config)
            };
        }
        return null;
    };
    const providerConfig = await findProviderConfig();
    if (providerConfig && providerConfig.enabled !== false) {
        const params = mergedParams[desiredKey] || mergedParams.default || {};
        const cfg = { ...providerConfig, model: modelOverride || providerConfig.model || getEffectiveGeminiModel(config) };
        const provider = await createProviderInstance(desiredKey, cfg, params);
        if (provider) {
            return {
                provider,
                providerName: desiredKey,
                providerModel: cfg.model,
                fallbackProviderName: ''
            };
        }
    }
    // Fallback: try any enabled provider with a key (Gemini first)
    const geminiKey = await selectGeminiApiKey(config);
    if (geminiKey) {
        const fallback = await maybeBuildProvider('gemini', {
            enabled: true,
            apiKey: geminiKey,
            model: modelOverride || getEffectiveGeminiModel(config)
        });
        if (fallback) {
            fallback.fallbackProviderName = desiredKey || 'gemini';
            return fallback;
        }
    }
    const firstAvailable = Object.keys(providers || {}).find((k) => {
        const cfg = providers[k];
        return cfg && cfg.apiKey && cfg.enabled !== false;
    });
    if (firstAvailable) {
        const fallback = await maybeBuildProvider(firstAvailable);
        if (fallback) {
            fallback.fallbackProviderName = desiredKey;
            return fallback;
        }
    }
    return null;
}

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

// Configurable rate limits for 3-click cache resets (defaults: 6/15m permanent, 12/15m bypass)
const CACHE_RESET_WINDOW_MS = Math.max(1, parseInt(process.env.CACHE_RESET_WINDOW_MINUTES, 10) || 15) * 60 * 1000;
const CACHE_RESET_LIMIT_PERMANENT = (() => {
    const parsed = parseInt(process.env.CACHE_RESET_LIMIT_TRANSLATION || process.env.CACHE_RESET_LIMIT_PERMANENT, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 6;
})();
const CACHE_RESET_LIMIT_BYPASS = (() => {
    const parsed = parseInt(process.env.CACHE_RESET_LIMIT_BYPASS, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 12;
})();
const cacheResetHistory = new LRUCache({
    max: 5000, // Track up to 5k users/configs per window
    ttl: CACHE_RESET_WINDOW_MS * 2, // Auto-expire idle counters
    updateAgeOnGet: false,
});

// Feature toggle: keep embedded original tracks in cache (default ON; set to "false" to opt out)
const KEEP_EMBEDDED_ORIGINALS = String(process.env.KEEP_EMBEDDED_ORIGINALS || 'true').toLowerCase() !== 'false';

/**
 * Translation Prefetch/Burst Detection
 *
 * Stremio/libmpv prefetches ALL subtitle URLs when the subtitle menu opens.
 * This includes translation URLs, which would trigger multiple translations at once.
 *
 * This tracker detects "burst" patterns (many requests within a short window) and
 * prevents starting actual translations during prefetch. The first request after
 * a burst (when user actually selects a subtitle) will trigger the translation.
 *
 * Environment variables:
 * - TRANSLATION_BURST_WINDOW_MS: Time window for burst detection (default: 300ms)
 * - TRANSLATION_BURST_THRESHOLD: Number of requests to trigger burst mode (default: 3)
 * - DISABLE_TRANSLATION_BURST_DETECTION: Set to 'true' to disable this feature
 */
const TRANSLATION_BURST_WINDOW_MS = parseInt(process.env.TRANSLATION_BURST_WINDOW_MS, 10) || 300;
const TRANSLATION_BURST_THRESHOLD = parseInt(process.env.TRANSLATION_BURST_THRESHOLD, 10) || 3;
const DISABLE_TRANSLATION_BURST_DETECTION = process.env.DISABLE_TRANSLATION_BURST_DETECTION === 'true';

// Track translation requests per config hash to detect bursts
const translationBurstTracker = new LRUCache({
    max: 5000, // Track up to 5k users
    ttl: 10000, // 10 second TTL - burst detection window
    updateAgeOnGet: false,
});

/**
 * Check if a translation request is part of a prefetch burst
 * @param {string} configKey - User's config hash
 * @param {string} sourceFileId - Subtitle file being translated
 * @param {string} targetLang - Target language
 * @returns {{ isBurst: boolean, count: number, firstSourceId: string|null }}
 */
function checkTranslationBurst(configKey, sourceFileId, targetLang) {
    if (DISABLE_TRANSLATION_BURST_DETECTION) {
        return { isBurst: false, count: 0, firstSourceId: null };
    }

    const now = Date.now();
    const burstKey = `burst:${configKey}`;
    let entry = translationBurstTracker.get(burstKey) || { requests: [], firstSourceId: null };

    // Clean up old requests outside the window
    entry.requests = entry.requests.filter(r => now - r.timestamp < TRANSLATION_BURST_WINDOW_MS);

    // Add this request
    entry.requests.push({ sourceFileId, targetLang, timestamp: now });

    // Track the first request in the window (this one will be allowed to proceed)
    if (entry.requests.length === 1) {
        entry.firstSourceId = sourceFileId;
    }

    translationBurstTracker.set(burstKey, entry);

    const isBurst = entry.requests.length >= TRANSLATION_BURST_THRESHOLD;
    const isFirstInBurst = sourceFileId === entry.firstSourceId;

    // A request is considered "burst blocked" if:
    // 1. We're in burst mode (many requests in window)
    // 2. This is NOT the first request in the burst
    return {
        isBurst: isBurst && !isFirstInBurst,
        count: entry.requests.length,
        firstSourceId: entry.firstSourceId
    };
}

// Separate tracker for download bursts (lower threshold since downloads are less expensive)
const DOWNLOAD_BURST_WINDOW_MS = parseInt(process.env.DOWNLOAD_BURST_WINDOW_MS, 10) || 500;
const DOWNLOAD_BURST_THRESHOLD = parseInt(process.env.DOWNLOAD_BURST_THRESHOLD, 10) || 5;
const DISABLE_DOWNLOAD_BURST_DETECTION = process.env.DISABLE_DOWNLOAD_BURST_DETECTION === 'true';

const downloadBurstTracker = new LRUCache({
    max: 5000,
    ttl: 10000,
    updateAgeOnGet: false,
});

/**
 * Check if a download request is part of a prefetch burst
 * Only tracks downloads that are NOT in cache (cache hits don't count toward burst)
 * @param {string} configKey - User's config hash
 * @param {string} fileId - Subtitle file ID
 * @returns {{ isBurst: boolean, count: number }}
 */
function checkDownloadBurst(configKey, fileId) {
    if (DISABLE_DOWNLOAD_BURST_DETECTION) {
        return { isBurst: false, count: 0 };
    }

    const now = Date.now();
    const burstKey = `dl-burst:${configKey}`;
    let entry = downloadBurstTracker.get(burstKey) || { requests: [], firstFileId: null };

    // Clean up old requests outside the window
    entry.requests = entry.requests.filter(r => now - r.timestamp < DOWNLOAD_BURST_WINDOW_MS);

    // Add this request
    entry.requests.push({ fileId, timestamp: now });

    // Track the first request
    if (entry.requests.length === 1) {
        entry.firstFileId = fileId;
    }

    downloadBurstTracker.set(burstKey, entry);

    const isBurst = entry.requests.length >= DOWNLOAD_BURST_THRESHOLD;
    const isFirstInBurst = fileId === entry.firstFileId;

    return {
        isBurst: isBurst && !isFirstInBurst,
        count: entry.requests.length,
        firstFileId: entry.firstFileId
    };
}

/**
 * Stremio Community Prefetch Cooldown
 *
 * Stremio Community (https://stremio.zarg.me) using libmpv aggressively prefetches ALL subtitle
 * URLs returned in the manifest. When we return a subtitle list, libmpv immediately fires
 * parallel requests to download every single subtitle.
 *
 * This system tracks when we serve a subtitle list to a Stremio Community client and blocks
 * subsequent download/translate requests during a cooldown period (default: 2.5 seconds).
 *
 * Detection: We identify Stremio Community clients by:
 * - Origin containing "zarg" (e.g., https://stremio.zarg.me)
 * - User-Agent containing "StremioShell" (desktop app wrapper)
 *
 * The cooldown allows the first user-selected subtitle to proceed normally while blocking
 * the automatic prefetch storm.
 *
 * Environment variables:
 * - STREMIO_COMMUNITY_COOLDOWN_MS: Cooldown window after serving subtitle list (default: 2500ms)
 * - DISABLE_STREMIO_COMMUNITY_COOLDOWN: Set to 'true' to disable this feature
 */
const STREMIO_COMMUNITY_COOLDOWN_MS = parseInt(process.env.STREMIO_COMMUNITY_COOLDOWN_MS, 10) || 2500;
const DISABLE_STREMIO_COMMUNITY_COOLDOWN = process.env.DISABLE_STREMIO_COMMUNITY_COOLDOWN === 'true';

// Track when we served a subtitle list to a Stremio Community client
const stremioCommunityPrefetchTracker = new LRUCache({
    max: 10000,    // Track up to 10k config hashes
    ttl: 10000,    // 10 second TTL (cooldown is typically 2.5s but we keep entry around for debugging)
    updateAgeOnGet: false,
});

/**
 * Detect if a request is from Stremio Community.
 *
 * IMPORTANT: Do not classify generic libmpv requests as Stremio Community.
 * Native Stremio Android/Android TV clients also use libmpv, and putting them
 * on the Stremio Community cooldown path can delay the first real subtitle load
 * during playback startup.
 * @param {Object} req - Express request object
 * @returns {boolean} - True if request is from Stremio Community
 */
function isStremioCommunityRequest(req) {
    if (!req) return false;

    const origin = (req.get('origin') || req.get('referer') || '').toLowerCase();
    const userAgent = (req.get('user-agent') || '').toLowerCase();

    // Detect Stremio Community by:
    // - Origin containing "zarg" (web version: https://stremio.zarg.me)
    // - User-agent containing "stremioshell" (desktop app wrapper)
    const isZargOrigin = origin.includes('zarg');
    const isStremioShell = userAgent.includes('stremioshell');

    return isZargOrigin || isStremioShell;
}

/**
 * Detect if a request is from libmpv (the player that does prefetching)
 * @param {Object} req - Express request object
 * @returns {boolean} - True if request is from libmpv
 */
function isLibmpvRequest(req) {
    if (!req) return false;
    const userAgent = (req.get('user-agent') || '').toLowerCase();
    return userAgent.includes('libmpv');
}

/**
 * Mark that we served a subtitle list to a Stremio Community client
 * Should be called after serving a subtitle manifest response
 * @param {string} configHash - User's config hash
 * @param {number} subtitleCount - Number of subtitles returned (for logging)
 */
function setStremioCommunityPrefetchCooldown(configHash, subtitleCount = 0) {
    if (DISABLE_STREMIO_COMMUNITY_COOLDOWN || !configHash) return;

    const now = Date.now();
    stremioCommunityPrefetchTracker.set(configHash, {
        timestamp: now,
        expiresAt: now + STREMIO_COMMUNITY_COOLDOWN_MS,
        subtitleCount
    });

    log.debug(() => `[Prefetch Cooldown] Set cooldown for config ${redactToken(configHash)}: ${STREMIO_COMMUNITY_COOLDOWN_MS}ms (${subtitleCount} subtitles served)`);
}

/**
 * Check if a download/translate request should be blocked due to prefetch cooldown
 * @param {string} configHash - User's config hash
 * @param {Object} req - Express request object (to check if it's libmpv)
 * @returns {{ blocked: boolean, reason: string, remainingMs: number }}
 */
function checkStremioCommunityPrefetchCooldown(configHash, req) {
    if (DISABLE_STREMIO_COMMUNITY_COOLDOWN || !configHash) {
        return { blocked: false, reason: null, remainingMs: 0 };
    }

    const entry = stremioCommunityPrefetchTracker.get(configHash);
    if (!entry) {
        return { blocked: false, reason: null, remainingMs: 0 };
    }

    const now = Date.now();
    const remainingMs = entry.expiresAt - now;

    // Cooldown expired
    if (remainingMs <= 0) {
        return { blocked: false, reason: null, remainingMs: 0 };
    }

    // Cooldown active - but only block libmpv requests (the prefetcher)
    // Allow non-libmpv requests (user actually selected a subtitle)
    if (!isLibmpvRequest(req)) {
        return { blocked: false, reason: 'non-libmpv request allowed', remainingMs };
    }

    // libmpv prefetch during cooldown - block it
    return {
        blocked: true,
        reason: `prefetch cooldown (${remainingMs}ms remaining)`,
        remainingMs
    };
}

// Keep router cache aligned with latest session config across updates/deletes (including Redis pub/sub events)
if (typeof sessionManager.on === 'function') {
    sessionManager.on('sessionUpdated', ({ token, source }) => {
        invalidateRouterCache(token, `${source || 'local'} update`);
        invalidateResolveConfigCache(token);
    });
    sessionManager.on('sessionDeleted', ({ token, source }) => {
        invalidateRouterCache(token, `${source || 'local'} delete`);
        invalidateResolveConfigCache(token);
    });
    sessionManager.on('sessionInvalidated', ({ token, action, source }) => {
        invalidateRouterCache(token, `${action || 'invalidate'} via ${source || 'pubsub'}`);
        invalidateResolveConfigCache(token);
    });
}

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
        log.warn(() => `[Dedup] Operation failed: ${shortKey}`, error.message);
        throw error;
    } finally {
        // Clean up immediately after completion
        inFlightRequests.delete(key);
    }
}

function isInvalidSessionConfig(config) {
    return !!(config && config.__sessionTokenError === true);
}

function isDisabledSessionConfig(config) {
    return !!(config && config.__sessionDisabled === true);
}

function buildConfigRecoveryUrl(req, token = '') {
    const normalizedToken = /^[a-f0-9]{32}$/.test(String(token || '').trim().toLowerCase())
        ? String(token).trim().toLowerCase()
        : '';
    const host = getSafeHost(req);
    const localhost = isLocalhost(req);
    const protocol = localhost
        ? (req.get('x-forwarded-proto') || req.protocol || 'http')
        : (req.get('x-forwarded-proto') || 'https');
    const baseUrl = `${protocol}://${host}`;
    return `${baseUrl}/configure${normalizedToken ? `?config=${encodeURIComponent(normalizedToken)}` : ''}`;
}

function respondDisabledSession(req, res, config, translator = null) {
    if (!res || res.headersSent) return;

    setNoStore(res);
    const t = translator || res.locals?.t || getTranslatorFromRequest(req, res, config);
    const message = t('server.errors.sessionDisabled', {}, 'This token is disabled. Open the configuration page to re-enable it.');
    const configureUrl = buildConfigRecoveryUrl(
        req,
        config?.__originalToken || req?.params?.config || req?.query?.config || ''
    );
    const pathName = String(req?.path || req?.originalUrl || '').toLowerCase();

    if (
        pathName.includes('/subtitle') ||
        pathName.includes('/translate') ||
        pathName.includes('/learn') ||
        pathName.includes('/error-subtitle') ||
        pathName.includes('/xsync') ||
        pathName.includes('/auto/') ||
        pathName.includes('/xembedded')
    ) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.status(403).end(`${message}\n${configureUrl}`);
        return;
    }

    if (pathName.includes('/manifest.json') || pathName.startsWith('/api/')) {
        res.status(403).json({
            error: message,
            disabled: true,
            configureUrl
        });
        return;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(403).end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Token Disabled</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at top,#243b6b 0%,#0f172a 55%,#020617 100%);color:#e2e8f0;font:16px/1.5 Segoe UI,system-ui,sans-serif}
    .card{max-width:560px;margin:24px;padding:28px 24px;border-radius:24px;background:rgba(15,23,42,.82);border:1px solid rgba(148,163,184,.24);box-shadow:0 24px 60px rgba(2,6,23,.45)}
    h1{margin:0 0 10px;font-size:1.5rem}
    p{margin:0 0 18px;color:#cbd5e1}
    a{display:inline-flex;align-items:center;justify-content:center;padding:12px 18px;border-radius:999px;background:linear-gradient(135deg,#f8b84e,#ff6d7a);color:#111827;font-weight:700;text-decoration:none}
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(t('server.errors.sessionDisabledTitle', {}, 'Token Disabled'))}</h1>
    <p>${escapeHtml(message)}</p>
    <a href="${escapeHtml(configureUrl)}">${escapeHtml(t('server.errors.sessionDisabledCta', {}, 'Open configuration'))}</a>
  </div>
</body>
</html>`);
}

// Create Express app
const app = express();
// SECURITY: trust proxy is configurable via TRUST_PROXY env var.
// Set TRUST_PROXY=1 (or loopback, linklocal, uniquelocal) when behind a reverse proxy.
// Defaults to false (no proxy trust) to prevent IP spoofing when directly exposed.
const trustProxySetting = process.env.TRUST_PROXY;
if (trustProxySetting !== undefined && trustProxySetting !== '') {
    // Support numeric (1, 2), boolean-like (true/false), and named values (loopback, linklocal, uniquelocal)
    const numeric = parseInt(trustProxySetting, 10);
    if (!isNaN(numeric)) {
        app.set('trust proxy', numeric);
    } else if (trustProxySetting.toLowerCase() === 'true') {
        app.set('trust proxy', true);
    } else if (trustProxySetting.toLowerCase() === 'false') {
        app.set('trust proxy', false);
    } else {
        // Named values like 'loopback', 'linklocal', 'uniquelocal' or comma-separated subnets
        app.set('trust proxy', trustProxySetting);
    }
} else {
    // Default behavior:
    // - Redis storage (production): default to true (production deployments are ALWAYS behind a reverse proxy)
    // - Local storage (development): default to false (safe when directly exposed)
    // Can always be overridden by setting TRUST_PROXY explicitly.
    const isProduction = (process.env.STORAGE_TYPE || 'redis') === 'redis';
    const defaultTrust = isProduction ? 1 : false;
    app.set('trust proxy', defaultTrust);
    if (isProduction) {
        log.info(() => '[Server] Production mode detected (Redis storage) - defaulting trust proxy to 1. Set TRUST_PROXY=false to disable.');
    }
}
app.disable('x-powered-by'); // Hide framework fingerprint in responses
// CRITICAL: Disable ETags globally to prevent any conditional caching
// ETags can cause proxies/CDNs to serve stale user-specific content
app.set('etag', false);

// Security: Enable CORS for all routes (required for Stremio Web/Desktop)
// app.use(cors());

// Performance: Enable GZIP compression
// app.use(compression());

// Helper: compute a short hash for a config string (used to scope bypass cache per user/config)
function computeConfigHash(configStr) {
    try {
        const seen = new WeakSet();
        // Runtime/session activity fields that should never affect translation cache identity.
        // These can change during playback (stream pings, UI metadata refresh) and were
        // causing user-scoped bypass keys to drift mid-translation.
        const volatileHashKeys = new Set([
            'laststream',
            'streamfilename',
            'videofilename',
            'videoid',
            'videohash',
            'streamurl',
            'linkedtitle',
            'lastlinkedtitle'
        ]);

        const sanitizeForHash = (value) => {
            if (value === null) return null;
            const t = typeof value;
            if (t === 'string' || t === 'number' || t === 'boolean') return value;
            if (t !== 'object') return String(value);

            if (seen.has(value)) return undefined;
            seen.add(value);

            if (Array.isArray(value)) {
                return value.map((v) => sanitizeForHash(v));
            }

            const result = {};
            for (const key of Object.keys(value).sort()) {
                // Ignore internal/runtime metadata so the hash only depends on user-facing config
                if (String(key).startsWith('__')) continue;
                if (volatileHashKeys.has(String(key).toLowerCase())) continue;
                const sanitized = sanitizeForHash(value[key]);
                if (sanitized !== undefined) {
                    result[key] = sanitized;
                }
            }
            return result;
        };

        const serializeConfig = (input) => {
            if (input && typeof input === 'object') {
                return JSON.stringify(sanitizeForHash(input)) || '';
            }
            if (input === undefined || input === null) return '';
            return String(input);
        };

        let hashSource = serializeConfig(configStr);

        // Validate input - empty/undefined configs should get a consistent but identifiable hash
        if (!hashSource || hashSource === 'undefined' || hashSource === 'null' || String(hashSource).trim().length === 0) {
            log.warn(() => '[ConfigHash] Received empty/invalid config payload for hashing');
            // Return a special marker hash for empty configs instead of empty string
            // This ensures they don't collide with failed hash generation
            return 'empty_config_00';
        }

        const hash = crypto.createHash('sha256').update(String(hashSource)).digest('hex').slice(0, 16);

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

// Helper: derive a scoped hash that mixes the base hash with a session-specific seed
function scopeConfigHash(baseHash, scopeSeed) {
    if (!baseHash) return baseHash;
    if (!scopeSeed) return baseHash;
    try {
        return crypto.createHash('sha256').update(String(baseHash)).update('|').update(String(scopeSeed)).digest('hex').slice(0, 16);
    } catch (error) {
        log.warn(() => ['[ConfigHash] Failed to scope hash:', error.message]);
        return baseHash;
    }
}

// Hash scope seed so tokens/config strings are never exposed directly
function computeConfigScope(scopeSeed) {
    if (!scopeSeed) return '';
    try {
        return crypto.createHash('sha256').update(String(scopeSeed)).digest('hex').slice(0, 12);
    } catch (error) {
        log.warn(() => ['[ConfigHash] Failed to compute scope seed hash:', error.message]);
        return '';
    }
}

// Helper: ensure a config object has a stable hash attached (derived from normalized payload)
function ensureConfigHash(config, fallbackSeed = '') {
    if (!config || typeof config !== 'object') {
        return 'anonymous';
    }

    // If the stored hash was computed with the same scope, keep it; otherwise recompute to avoid cross-user collisions.
    const scopeSeed = (typeof fallbackSeed === 'string' && fallbackSeed.length) ? fallbackSeed : '';
    const scopeTag = computeConfigScope(scopeSeed);
    const storedHash = (typeof config.__configHash === 'string' && config.__configHash.length > 0) ? config.__configHash : '';
    const storedScope = (typeof config.__configHashScope === 'string' && config.__configHashScope.length > 0) ? config.__configHashScope : '';
    if (storedHash && (!scopeTag || storedScope === scopeTag)) {
        return storedHash;
    }

    let hash = computeConfigHash(config || fallbackSeed || 'empty_config_00');

    // If the payload normalized to an empty/invalid hash (e.g., corrupted session),
    // re-hash with a token-specific seed so different users never collide.
    if (hash === 'empty_config_00' && fallbackSeed) {
        hash = computeConfigHash(`fallback:${fallbackSeed}`);
    }

    const scopedHash = scopeTag ? scopeConfigHash(hash, scopeTag) : hash;
    config.__configHash = scopedHash;
    if (scopeTag) {
        // Track the scope seed we used (hashed) so we can detect outdated hashes on the next request
        config.__configHashScope = scopeTag;
    }
    // Preserve the unscoped hash when we had to add a scope so future code can differentiate if needed
    if (scopedHash !== hash) {
        config.__configBaseHash = hash;
    }
    return scopedHash;
}

// Helper: Deep clone config object to prevent shared references between users
// CRITICAL: This prevents cross-user contamination in multi-pod deployments
function deepCloneConfig(config) {
    if (!config || typeof config !== 'object') {
        return config;
    }
    try {
        // Try structuredClone first (fastest and most reliable)
        if (typeof structuredClone === 'function') {
            return structuredClone(config);
        }
    } catch (err) {
        log.debug(() => `[ConfigClone] structuredClone failed, falling back to JSON: ${err.message}`);
    }
    try {
        // Fallback to JSON clone (works for most configs)
        return JSON.parse(JSON.stringify(config));
    } catch (err) {
        log.error(() => `[ConfigClone] JSON clone failed: ${err.message}`);
        // Last resort: return original (may have shared references, but better than crash)
        return config;
    }
}

function resolveRequestLanguage(req, config, fallback = DEFAULT_LANG) {
    try {
        const candidates = [];
        const pick = (value) => {
            if (!value) return;
            const normalized = String(value).split(',')[0].trim().toLowerCase();
            if (normalized) candidates.push(normalized);
        };

        pick(config && config.uiLanguage);
        pick(req?.query?.uiLang || req?.query?.lang);
        pick(req?.headers?.['accept-language']);

        const chosen = candidates.find(Boolean) || fallback;
        const locale = loadLocale(chosen);
        return locale?.lang || fallback;
    } catch (_) {
        return fallback;
    }
}

function getTranslatorFromRequest(req, res, config, fallback = DEFAULT_LANG) {
    const lang = resolveRequestLanguage(req, config, fallback);
    const t = getTranslator(lang);
    if (res && res.locals) {
        res.locals.t = t;
        res.locals.uiLanguage = lang;
    }
    return t;
}

// Helper: validate config path parameter early to avoid expensive parsing on garbage payloads
const configParamSchema = Joi.object({
    config: configStringSchema
});
function validateConfigParam(configStr) {
    if (typeof configStr !== 'string') return false;
    if (configStr.length > 12000 || /[\r\n]/.test(configStr)) return false;
    const { error } = validateInput({ config: configStr }, configParamSchema);
    return !error;
}

// Enforce config validation for any :config param route (stops malformed/oversized tokens)
app.param('config', (req, res, next, value) => {
    if (!validateConfigParam(value)) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        return res.status(400).send(t('server.errors.invalidConfigId', {}, 'Invalid addon configuration identifier'));
    }
    req.params.config = value;
    next();
});

const MAX_CONFIG_BYTES = 120 * 1024; // guardrail against oversized session payloads
function enforceConfigPayloadSize(req, res, next) {
    try {
        const serialized = JSON.stringify(req.body || {});
        const size = Buffer.byteLength(serialized, 'utf8');
        if (size > MAX_CONFIG_BYTES) {
            const t = res.locals?.t || getTranslatorFromRequest(req, res);
            return res.status(413).json({ error: t('server.errors.configPayloadTooLarge', {}, 'Configuration payload too large') });
        }
    } catch (err) {
        log.warn(() => ['[Security] Failed to measure config payload size:', err.message]);
    }
    next();
}

// Helper: Convert JSON/string to URL-safe base64 (no padding) for use in paths
function toBase64Url(input) {
    const base64 = Buffer.from(String(input), 'utf-8').toString('base64');
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

// Helper: force browsers/proxies to avoid caching sensitive responses
function setNoStore(res) {
    // Standard HTTP cache prevention
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');

    // Proxy/CDN cache prevention
    res.setHeader('X-Accel-Expires', '0'); // Nginx proxy cache
    res.setHeader('CDN-Cache-Control', 'no-store'); // Fastly/generic CDN

    // CRITICAL: Cloudflare-specific cache prevention (for Warp/Workers)
    // Cloudflare Workers and Warp cache aggressively - these headers force bypass
    res.setHeader('CF-Cache-Status', 'BYPASS'); // Signal to Cloudflare to bypass cache
    res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store, max-age=0'); // Cloudflare-specific

    // CRITICAL: Vary header MUST include all per-user identifiers
    // Without this, Cloudflare will serve cached User A response to User B
    res.setHeader('Vary', '*'); // Tell Cloudflare every request is unique

    // Add unique timestamp to ensure response is never cached
    res.setHeader('X-Cache-Buster', Date.now().toString());
}

// Helper: caching policy for subtitle payloads
// - loading/partial/error responses stay no-store to avoid caching placeholders
// - final subtitle payloads also stay no-store to avoid stale subtitle reuse on some clients
function setSubtitleCacheHeaders(res, mode = 'final') {
    if (mode === 'loading') {
        setNoStore(res);
        return;
    }

    setNoStore(res);
}

// Normalize subtitle route params to strip optional extensions (e.g., ".srt", ".vtt", ".sub") from :targetLang
// This keeps validation/dedup logic stable while allowing extension-bearing URLs for player MIME detection.
function normalizeSubtitleFormatParams(req, _res, next) {
    try {
        if (req.params && typeof req.params.targetLang === 'string') {
            req.params.targetLang = req.params.targetLang.replace(/\.(srt|vtt|sub|ass|ssa)$/i, '');
        }
    } catch (_) { }
    next();
}

// Helper: controlled CORS - allow only same-host (http/https) or explicit allowlist
const normalizeOrigin = (origin) => {
    if (!origin) return '';
    const trimmed = origin.trim();
    return trimmed.endsWith('/') ? trimmed.slice(0, -1).toLowerCase() : trimmed.toLowerCase();
};
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
const DEFAULT_STREMIO_WEB_ORIGINS = [
    // Official Stremio web app origins
    'https://app.strem.io',
    'https://app.stremio.one',
    'https://strem.io',
    'https://stremio.one',
    'https://www.strem.io',
    'https://www.stremio.one',
    'https://staging.strem.io',
    // Alternative official domain (used by web app)
    'https://web.stremio.com',
    'https://web.stremio.one',
    'https://www.stremio.com',
    'https://stremio.com',
    'https://app.stremio.com',
    // Stremio web shell hosted on GitHub Pages
    'https://stremio.github.io',
    // Third-party Stremio web frontends
    'https://stremio-neo.aayushcodes.eu',
    'https://peario.xyz'
];
const allowedOriginsNormalized = Array.from(new Set([
    ...allowedOrigins.map(normalizeOrigin),
    ...DEFAULT_STREMIO_WEB_ORIGINS.map(normalizeOrigin)
]));
const STREMIO_ORIGIN_WILDCARD_SUFFIXES = ['.strem.io', '.stremio.one', '.stremio.com'];
// Allow additional wildcard domain suffixes via env (comma-separated, e.g. ".example.com,.other.org")
const extraWildcardSuffixes = (process.env.ALLOWED_ORIGIN_WILDCARD_SUFFIXES || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .map(s => s.startsWith('.') ? s : `.${s}`);
// Always allow these hosting domains
for (const suffix of ['.elfhosted.com', '.midnightignite.me', '.fortheweak.cloud', '.nhyira.dev']) {
    if (!extraWildcardSuffixes.includes(suffix)) extraWildcardSuffixes.push(suffix);
}
const STREMIO_ORIGIN_PREFIXES = ['stremio://', 'capacitor://', 'app://', 'file://'];
const STREMIO_ORIGIN_EQUALS = ['capacitor://localhost', 'app://strem.io'];
const DEFAULT_STREMIO_UA_HINTS = [
    'stremio', // Standard Stremio UA on most platforms/forks
    'needle/'  // Stremio desktop HTTP client (addon fetcher) default UA
];
const extraStremioUaHints = (process.env.STREMIO_USER_AGENT_HINTS || '')
    .split(',')
    .map(h => h.trim().toLowerCase())
    .filter(Boolean);
const STREMIO_USER_AGENT_HINTS = Array.from(new Set([...DEFAULT_STREMIO_UA_HINTS, ...extraStremioUaHints]));
function isStremioUserAgent(userAgent) {
    if (!userAgent) return false;
    const ua = userAgent.toLowerCase();
    return STREMIO_USER_AGENT_HINTS.some(hint => ua.includes(hint));
}
function isLocalhostOrigin(origin) {
    const host = extractHostnameFromOrigin(origin);
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    // Private/LAN IPs (RFC 1918 + link-local)
    if (/^10\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^169\.254\./.test(host)) return true;
    return false;
}
function extractHostnameFromOrigin(origin) {
    if (!origin) return '';
    const normalized = normalizeOrigin(origin);
    try {
        return (new URL(normalized).hostname || '').toLowerCase();
    } catch (_) {
        // Fallback parsing for origins without protocol or with non-standard schemes
        const withoutScheme = normalized.replace(/^[a-z]+:\/\//i, '');
        const hostPort = withoutScheme.split('/')[0] || '';
        return hostPort.split(':')[0].toLowerCase();
    }
}
function isStremioWildcardDomain(origin) {
    const host = extractHostnameFromOrigin(origin);
    if (!host) return false;
    return STREMIO_ORIGIN_WILDCARD_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
}
function isStremioOrigin(origin) {
    if (!origin) return false;
    const normalized = normalizeOrigin(origin);
    if (STREMIO_ORIGIN_EQUALS.includes(normalized)) return true;
    // Accept any official Stremio-hosted subdomain (e.g., addon edge hosts)
    if (isStremioWildcardDomain(origin)) return true;
    // Allow official Stremio web origins (desktop/mobile shells render web views from these hosts)
    if (DEFAULT_STREMIO_WEB_ORIGINS.some(o => normalized === normalizeOrigin(o) || normalized.startsWith(`${normalizeOrigin(o)}/`))) {
        return true;
    }
    return STREMIO_ORIGIN_PREFIXES.some(prefix => normalized.startsWith(prefix));
}
const COMMUNITY_V5_BLOCKED_HOSTS = [
    'stremio.zarg.me',
    'zaarrg.github.io'
];
function isBlockedCommunityV5Request(req) {
    if (!req) return false;
    const origin = req.get('origin') || '';
    const referer = req.get('referer') || '';
    const originHost = extractHostnameFromOrigin(origin);
    const refererHost = extractHostnameFromOrigin(referer);
    const normalizedOrigin = normalizeOrigin(origin);
    const normalizedReferer = normalizeOrigin(referer);

    const hostBlocked = COMMUNITY_V5_BLOCKED_HOSTS.some(host =>
        originHost === host ||
        refererHost === host ||
        originHost.endsWith(`.${host}`) ||
        refererHost.endsWith(`.${host}`)
    );

    // Backup fingerprint: their fallback UI URL path contains this slug.
    const knownPathHint =
        normalizedOrigin.includes('stremio-web-shell-fixes') ||
        normalizedReferer.includes('stremio-web-shell-fixes');

    return hostBlocked || knownPathHint;
}
function isStremioClient(req) {
    const origin = req.get('origin');
    const userAgent = (req.headers['user-agent'] || '').toLowerCase();
    return isStremioOrigin(origin) || isStremioUserAgent(userAgent);
}
function isOriginAllowed(origin, req) {
    if (!origin) return true; // Native apps/curl without Origin header
    const normalizedOrigin = normalizeOrigin(origin);
    // SECURITY: Handle "null" origin string, but only when combined with Stremio detection
    // Browsers/Stremio send Origin: null (the string "null") for certain contexts (sandboxed iframes, local files)
    // We allow this ONLY if the request is from Stremio (via user-agent) to prevent abuse
    if (normalizedOrigin === 'null') {
        const userAgent = (req.headers['user-agent'] || '').toLowerCase();
        return isStremioUserAgent(userAgent);
    }
    if (allowedOriginsNormalized.includes(normalizedOrigin)) return true;
    if (isLocalhostOrigin(origin)) return true; // Local/LAN origins (e.g. http://localhost:11470, http://192.168.1.15:8080)
    if (isStremioOrigin(origin)) return true; // Trust official Stremio app origins (capacitor/app/stremio schemes)
    if (extractHostnameFromOrigin(origin).includes('zarg')) return false;
    // Trust Stremio clients regardless of origin (e.g. StremioShell from self-hosted web instances)
    if (isStremioUserAgent((req.headers['user-agent'] || ''))) return true;
    // Check extra wildcard domain suffixes (e.g. .elfhosted.com via ALLOWED_ORIGIN_WILDCARD_SUFFIXES env)
    if (extraWildcardSuffixes.length > 0) {
        const host = extractHostnameFromOrigin(origin);
        if (host && extraWildcardSuffixes.some(suffix => host === suffix.slice(1) || host.endsWith(suffix))) {
            return true;
        }
    }
    const host = getSafeHost(req);
    return normalizedOrigin === normalizeOrigin(`https://${host}`) || normalizedOrigin === normalizeOrigin(`http://${host}`);
}
function applySafeCors(req, res, next) {
    const origin = req.get('origin');
    if (origin && !isOriginAllowed(origin, req)) {
        const userAgent = req.headers['user-agent'] || '';
        log.error(() => `[Security] Blocked request (origin not allowed) - origin: ${origin}, user-agent: ${userAgent}, path: ${req.path}`);
        sentry.captureMessage(
            `[Security] Blocked request (origin not allowed) - origin: ${origin}, user-agent: ${userAgent}, path: ${req.path}`,
            'error',
            {
                module: 'SecurityMiddleware',
                blockReason: 'origin_not_allowed',
                origin,
                userAgent,
                path: req.path,
                method: req.method,
                ip: req.ip,
                tags: { security: 'blocked_origin' }
            }
        );
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        return res.status(403).json({ error: t('server.errors.originNotAllowed', {}, 'Origin not allowed') });
    }
    return cors()(req, res, next);
}

function getForwardedForIp(xffHeader) {
    if (!xffHeader || typeof xffHeader !== 'string') return '';
    const first = xffHeader.split(',')[0];
    return first ? first.trim() : '';
}

function getClientIp(req) {
    const cf = req.get('cf-connecting-ip');
    const xff = getForwardedForIp(req.get('x-forwarded-for'));
    const xri = req.get('x-real-ip');
    const direct = req.ip || req?.connection?.remoteAddress || '';
    return cf || xff || xri || direct || 'unknown';
}

// Helper: sanitize and normalize host header to avoid header injection / poisoned manifests
function getSafeHost(req) {
    const rawHost = req.get('host') || '';
    if (!rawHost || /[\r\n]/.test(rawHost) || !HOST_HEADER_REGEX.test(rawHost)) {
        const fallback = req.hostname || 'localhost';
        log.warn(() => `[Security] Rejected unsafe Host header "${rawHost}", using fallback "${fallback}"`);
        return fallback;
    }
    return rawHost;
}

// Helper: Check if request is from localhost or private network
function isLocalhost(req) {
    const host = getSafeHost(req);
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

// Helper: resolve cache type for rate limiting and logging
function resolveCacheType(config) {
    const bypass = config && config.bypassCache === true;
    const bypassCfg = (config && (config.bypassCacheConfig || config.tempCache)) || {};
    const bypassEnabled = bypass && (bypassCfg.enabled !== false);
    return bypassEnabled ? 'bypass' : 'permanent';
}

// Helper: consistent config hash for logging/rate limits
function getConfigHashSafe(config) {
    return (config && typeof config.__configHash === 'string' && config.__configHash.length > 0)
        ? config.__configHash
        : 'anonymous';
}

// Rate limit tracker for 3-click cache resets (per user/config + cache type)
// Set consume=false to perform a dry-run check without recording usage
function checkCacheResetRateLimit(config, { consume = true } = {}) {
    const cacheType = resolveCacheType(config);
    const limit = cacheType === 'bypass' ? CACHE_RESET_LIMIT_BYPASS : CACHE_RESET_LIMIT_PERMANENT;

    // Limit disabled or misconfigured -> allow
    if (!limit || limit <= 0) {
        return { blocked: false, cacheType, remaining: Infinity, limit };
    }

    const now = Date.now();
    const key = `reset:${cacheType}:${getConfigHashSafe(config)}`;
    const history = cacheResetHistory.get(key) || [];

    // Sliding window filter
    const recent = history.filter((ts) => now - ts <= CACHE_RESET_WINDOW_MS);

    // If already at limit, block without counting the new attempt
    if (recent.length >= limit) {
        cacheResetHistory.set(key, recent);
        return { blocked: true, cacheType, remaining: 0, limit };
    }

    // Record successful reset only when consuming
    if (consume) {
        recent.push(now);
    }
    cacheResetHistory.set(key, recent);

    return { blocked: false, cacheType, remaining: Math.max(0, limit - recent.length), limit };
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
 * @returns {Promise<boolean>} - True if the 3-click cache reset should be BLOCKED
 */
async function shouldBlockCacheReset(clickKey, sourceFileId, config, targetLang) {
    try {
        const clickEntry = firstClickTracker.get(clickKey);

        if (!clickEntry || !clickEntry.times || clickEntry.times.length < 3) {
            return false; // Not enough clicks yet
        }

        // Determine which cache type the user is using
        const { cacheKey, bypass, bypassEnabled, userHash, baseKey } = generateCacheKeys(config, sourceFileId, targetLang);
        const configHash = userHash || (config && config.__configHash) || '';

        // SAFETY CHECK 1: Check if the user is at their concurrency limit
        // If they are, don't allow the 3-click reset because re-translation would fail with rate limit error
        if (!(await canUserStartTranslation(configHash, config))) {
            log.warn(() => `[SafetyBlock] BLOCKING 3-click reset: User at concurrency limit, re-translation would fail (user: ${configHash || 'anonymous'})`);
            return true;
        }

        if (bypassEnabled && configHash) {
            // USER IS USING BYPASS CACHE
            // Only block if THIS user's bypass translation is in progress
            // Check BOTH translationStatus AND inFlightTranslations for maximum safety
            const status = translationStatus.get(cacheKey);
            const inFlight = inFlightTranslations.has(cacheKey);

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
            const status = translationStatus.get(cacheKey);
            const inFlight = inFlightTranslations.has(cacheKey);

            if (!status && !inFlight) {
                return false; // Not in progress, allow reset
            }

            if (status && status.inProgress) {
                log.warn(() => `[SafetyBlock] BLOCKING permanent cache reset: Shared translation IN PROGRESS for ${baseKey}`);
                return true;
            }

            if (inFlight) {
                log.warn(() => `[SafetyBlock] BLOCKING permanent cache reset: Shared translation IN-FLIGHT for ${baseKey}`);
                return true;
            }
        }

        return false;
    } catch (e) {
        log.warn(() => '[SafetyBlock] Error checking cache reset safety:', e.message);
        return false; // On error, allow the reset to proceed
    }
}

// FIRST-IN-CHAIN request trace: fires BEFORE any middleware (helmet, CORS, compression, etc.)
// If a subtitle request doesn't produce this log, it truly never reached the server.
app.use((req, res, next) => {
    const p = req.path || '';
    if (p.includes('/subtitles/') || p.includes('/manifest.json')) {
        log.warn(() => `[Request Trace] >>> ${req.method} ${req.originalUrl?.substring(0, 120) || p.substring(0, 120)}`);
    }
    next();
});

// Security: Add security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"], // Allow inline styles and Google Fonts
            scriptSrc: ["'self'", "'unsafe-inline'", "https://static.cloudflareinsights.com"], // Allow inline scripts for HTML pages + CF beacon
            connectSrc: [
                "'self'",
                "https://v3-cinemeta.strem.io", // Needed for linked title lookup on embedded subtitles page
                "https://*.strem.io",
                "https://cloudflareinsights.com",
                "https://static.cloudflareinsights.com",
                "https://fonts.googleapis.com",
                "https://fonts.gstatic.com"
            ],
            imgSrc: ["'self'", "data:"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"], // Allow Google Fonts
            // Don't upgrade insecure requests for localhost (would break HTTP logo loading)
            upgradeInsecureRequests: null,
        },
    },
    // Prevent leaking query params (like ?config= tokens) via referrers
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false, // Disable for Stremio compatibility
    crossOriginResourcePolicy: false, // Disable to allow Stremio to load logo/images
    strictTransportSecurity: false, // Disable HSTS for localhost (allows HTTP)
}));

// Redis-backed store for express-rate-limit (cross-instance accuracy)
// The sendCommand wrapper lazily resolves the Redis client so limiters can be
// defined at module level before the async startup initializes storage.
// During startup, SCRIPT LOAD calls are queued and resolved once Redis connects.
// The readiness middleware gates all real requests until storage is ready,
// so actual rate-limit checks will always have a live Redis client.
function createRateLimitRedisStore(prefix) {
    // When storage type is not Redis, skip Redis-backed rate limiting entirely
    // and let express-rate-limit use its built-in in-memory store (returns undefined).
    // This avoids 30s timeout errors and log spam when running without Redis (e.g. local dev).
    const storageType = (process.env.STORAGE_TYPE || 'redis').toLowerCase();
    if (storageType !== 'redis') {
        return undefined;
    }

    // Queue for commands issued before Redis is available (SCRIPT LOAD at construction time)
    const pendingQueue = [];
    let redisReady = false;
    let pollTimer = null;
    let timeoutTimer = null;

    // Drain all queued commands once Redis client becomes available
    function drainQueue() {
        if (redisReady) return;
        const client = StorageFactory.getRedisClient();
        if (!client) return;
        redisReady = true;
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
        for (const { args, resolve, reject } of pendingQueue.splice(0)) {
            client.call(...args).then(resolve, reject);
        }
    }

    // Start single poll timer on first queued command; cleared on drain or timeout
    function ensurePolling() {
        if (pollTimer || redisReady) return;
        pollTimer = setInterval(() => {
            try { drainQueue(); } catch (_) { /* ignore */ }
        }, 250);
        // Safety: stop polling after 30s and reject if still not ready
        timeoutTimer = setTimeout(() => {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            if (!redisReady) {
                for (const pending of pendingQueue.splice(0)) {
                    pending.reject(new Error('Redis not available for rate limiting after 30s'));
                }
            }
        }, 30000);
    }

    const store = new RateLimitRedisStore({
        prefix: prefix || 'rl:',
        sendCommand: (...args) => {
            const client = StorageFactory.getRedisClient();
            if (client) {
                redisReady = true;
                return client.call(...args);
            }
            // Redis not ready yet — queue the command (used for SCRIPT LOAD at construction)
            return new Promise((resolve, reject) => {
                pendingQueue.push({ args, resolve, reject });
                ensurePolling();
            });
        },
    });

    // Swallow constructor's SCRIPT LOAD rejections to avoid unhandledRejection noise
    // (scripts will be re-loaded on first real request via rate-limit-redis retry logic)
    store.incrementScriptSha?.catch?.(() => { });
    store.getScriptSha?.catch?.(() => { });

    return store;
}

// Security: Rate limiting for subtitle searches and translations
// Uses session ID or config hash instead of IP for better HA deployment support
// This prevents all users behind a load balancer from sharing the same rate limit
const searchLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute per user (increased from 20 for HA support)
    message: 'Too many subtitle requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    store: createRateLimitRedisStore('rl:search:'),
    passOnStoreError: true, // Fail open if Redis is unavailable — don't block requests
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
        // Try config from query (GET API endpoints like stream metadata/title resolvers)
        if (req.query?.config) {
            try {
                return `config:${computeConfigHash(req.query.config)}`;
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
    store: createRateLimitRedisStore('rl:filetrans:'),
    passOnStoreError: true,
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

// Security: Rate limiting for embedded translations (client-side extractor workflow)
const embeddedTranslationLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 12, // Slightly higher to allow multiple targets, still constrained
    message: 'Too many embedded translation requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    store: createRateLimitRedisStore('rl:embedded:'),
    passOnStoreError: true,
    keyGenerator: (req) => {
        if (req.session?.id) {
            return `session:${req.session.id}`;
        }
        if (req.body?.configStr) {
            try {
                return `config:${computeConfigHash(req.body.configStr)}`;
            } catch (e) {
                // Fall through
            }
        }
        return `ip:${ipKeyGenerator(req.ip)}`;
    }
});

// Security: Rate limiting for automatic subtitles pipeline
const autoSubLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 6,
    message: 'Too many auto-subtitle requests, please slow down.',
    standardHeaders: true,
    legacyHeaders: false,
    store: createRateLimitRedisStore('rl:autosub:'),
    passOnStoreError: true,
    keyGenerator: (req) => {
        if (req.session?.id) {
            return `session:${req.session.id}`;
        }
        if (req.body?.configStr) {
            try {
                return `config:${computeConfigHash(req.body.configStr)}`;
            } catch (_) { /* fall through */ }
        }
        return `ip:${ipKeyGenerator(req.ip)}`;
    }
});

// Security: Rate limiting for user data writes (synced/embedded subtitle saves)
const userDataWriteLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 40,
    message: 'Too many write requests, please slow down.',
    standardHeaders: true,
    legacyHeaders: false,
    store: createRateLimitRedisStore('rl:write:'),
    passOnStoreError: true,
    keyGenerator: (req) => {
        if (req.session?.id) {
            return `session:${req.session.id}`;
        }
        if (req.body?.configStr) {
            try {
                return `config:${computeConfigHash(req.body.configStr)}`;
            } catch (_) { /* fall through */ }
        }
        return `ip:${ipKeyGenerator(req.ip)}`;
    }
});

// Security: Rate limiting for session creation (prevents session flooding attacks)
// CRITICAL: Uses IP-based limiting to prevent single user from monopolizing global session pool
const sessionCreationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // 10 session creations per hour per IP
    message: 'Too many session creation requests from this IP. Please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    store: createRateLimitRedisStore('rl:sesscreate:'),
    passOnStoreError: true,
    // Always use IP for session creation rate limiting (not config hash)
    // This prevents attackers from bypassing the limit by changing configs
    keyGenerator: (req) => {
        return `session-create:${ipKeyGenerator(req.ip)}`;
    }
});

// Security: Rate limiting for session updates (more permissive than creation)
// Updates are the normal save flow and should not share the strict creation limit.
// The creation limiter (10/hour) was previously applied here, causing saves to
// exhaust the creation quota and lock users out with 429 after ~10 saves.
const sessionUpdateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 60, // 60 session updates per hour per IP
    message: 'Too many session update requests from this IP. Please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    store: createRateLimitRedisStore('rl:sessupdate:'),
    passOnStoreError: true,
    keyGenerator: (req) => {
        return `session-update:${ipKeyGenerator(req.ip)}`;
    }
});

// Security: Rate limiting for session brief metadata lookups used by the config Token Vault UI.
// Keep this loose enough for normal page refreshes while preventing storage hot-spot abuse.
const sessionBriefsLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 60, // 60 metadata refreshes per minute per IP
    message: 'Too many session brief requests from this IP. Please try again shortly.',
    standardHeaders: true,
    legacyHeaders: false,
    store: createRateLimitRedisStore('rl:sessbrief:'),
    passOnStoreError: true,
    keyGenerator: (req) => {
        return `session-briefs:${ipKeyGenerator(req.ip)}`;
    }
});

// Security: Rate limiting for stats endpoint (prevents abuse and monitoring)
const statsLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute per IP
    message: 'Too many stats requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    store: createRateLimitRedisStore('rl:stats:'),
    passOnStoreError: true,
    keyGenerator: (req) => {
        return `stats:${ipKeyGenerator(req.ip)}`;
    }
});

// Security: Rate limiting for API credential validation endpoints
// Shared across all validation endpoints (OpenSubtitles, Gemini, SubDL, etc.)
// Prevents users from hammering external APIs during validation
const validationLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 15, // 15 validation attempts per 5 minutes per IP
    message: 'Too many validation requests. Please wait a few minutes before trying again.',
    standardHeaders: true,
    legacyHeaders: false,
    store: createRateLimitRedisStore('rl:validation:'),
    passOnStoreError: true,
    keyGenerator: (req) => {
        return `validation:${ipKeyGenerator(req.ip)}`;
    }
});

// Enable gzip compression for all responses
// SRT files compress extremely well (typically 5-10x reduction)
// Use maximum compression (level 9) for best bandwidth savings
app.use(compression({
    threshold: 512, // Compress responses larger than 512 bytes (was 1KB)
    level: 9, // Maximum compression for SRT files (10-15x reduction)
    filter: (req, res) => {
        const accept = req.headers?.accept || '';
        const contentTypeHeader = res.getHeader('content-type') || '';

        // Never compress SSE to avoid proxy buffering and extra CPU
        if (accept.includes('text/event-stream') || String(contentTypeHeader).includes('text/event-stream')) {
            return false;
        }

        // Only compress text-based responses
        if (typeof contentTypeHeader === 'string' &&
            (contentTypeHeader.includes('text/') || contentTypeHeader.includes('application/json') || contentTypeHeader.includes('application/javascript'))) {
            return true;
        }
        // Default compression filter
        return compression.filter(req, res);
    }
}));

// Expose version on all responses
app.use((req, res, next) => {
    try { res.setHeader('X-SubMaker-Version', version); } catch (_) { }
    next();
});

// Security: Restrict CORS to prevent browser-based CSRF attacks
// Stremio native clients don't send Origin headers, so we block browser requests for sensitive API routes
// This prevents malicious websites from triggering expensive API calls
app.use((req, res, next) => {
    const t = res.locals?.t || getTranslatorFromRequest(req, res);
    const origin = req.get('origin');

    // Routes that MUST be accessible from browsers (configuration UI, file upload, etc.)
    const browserAllowedRoutes = [
        '/',
        '/configure',
        '/file-upload',
        '/subtitle-sync',
        '/api/languages',
        '/api/languages/translation',
        '/api/test-opensubtitles',
        '/api/gemini-models',
        // Session management endpoints (needed for config page to save/update/retrieve configs)
        '/api/get-session',
        '/api/create-session',
        '/api/update-session',
        // Allow config page to call validation/test endpoints from browser
        '/api/validate-gemini',
        '/api/validate-subsource',
        '/api/validate-subdl',
        '/api/validate-wyzie',
        '/api/validate-opensubtitles',
        '/api/validate-subsro',
        // Stream metadata endpoints for tool pages
        '/api/stream-activity',
        '/api/resolve-linked-title',
        '/api/translate-file',
        '/api/save-synced-subtitle',
        '/api/save-embedded-subtitle',
        '/api/translate-embedded',
        '/sub-toolbox',
        '/sub-history',
        '/embedded-subtitles',
        '/auto-subtitles',
        '/smdb',
        '/api/smdb/list',
        '/api/smdb/download',
        '/api/smdb/upload',
        '/api/smdb/translate',
        '/api/smdb/resolve-hashes'
    ];

    const stremioClient = isStremioClient(req);
    const isAddonBrowserPage =
        req.path.startsWith('/addon/') && (
            req.path.includes('/file-translate/') ||
            req.path.includes('/sync-subtitles/') ||
            req.path.includes('/sub-toolbox/') ||
            req.path.includes('/sub-history/') ||
            req.path.includes('/embedded-subtitles/') ||
            req.path.includes('/auto-subtitles/') ||
            req.path.includes('/smdb/')
        );

    // CRITICAL FIX: Always allow manifest.json requests (needed for Stremio addon installation)
    const isManifestRequest = req.path.includes('/manifest.json');

    // Allow static files and browser-accessible routes
    const isStaticAsset =
        req.path.endsWith('.png') ||
        req.path.endsWith('.svg') ||
        req.path.endsWith('.ico') ||
        req.path.endsWith('.jpg') ||
        req.path.endsWith('.jpeg') ||
        req.path.endsWith('.webp') ||
        req.path.endsWith('.woff') ||
        req.path.endsWith('.woff2') ||
        req.path.endsWith('.ttf');
    const isBrowserAllowed =
        req.path.startsWith('/public/') ||
        req.path.endsWith('.css') ||
        req.path.endsWith('.js') ||
        req.path.endsWith('.html') ||
        isStaticAsset ||
        browserAllowedRoutes.some(route => req.path === route || req.path.startsWith(route)) ||
        isAddonBrowserPage;

    // Manifest requests bypass strict origin checks (use regular CORS)
    if (isManifestRequest) {
        return cors()(req, res, next);
    }

    // Addon API routes (subtitle, translate, learn, xsync, xembed, error-subtitle, etc.)
    // These are Stremio's core addon routes that must work with Origin: null
    // Security: Allow only if origin is null/missing OR from Stremio client
    const isAddonApiRoute = req.path.startsWith('/addon/') && !isAddonBrowserPage;

    if (isAddonApiRoute) {
        const userAgent = req.headers['user-agent'] || '';

        // Hard block known Stremio Community v5 web-shell origins/referers.
        // This is a targeted deny that leaves null-origin and generic StremioShell
        // handling intact for all other clients.
        if (isBlockedCommunityV5Request(req)) {
            const blockOrigin = origin || 'none';
            const blockReferer = req.get('referer') || 'none';
            log.error(() => `[Security] Blocked addon API request (community-v5 origin) - origin: ${blockOrigin}, referer: ${blockReferer}, user-agent: ${userAgent}, path: ${req.path}`);
            return res.status(403).json({
                error: t('server.errors.originNotAllowed', {}, 'Origin not allowed')
            });
        }

        // Allow requests with no origin (Stremio native) or "null" origin (Stremio web/sandboxed contexts)
        if (!origin || origin === 'null') {
            log.debug(() => `[Security] Allowed addon API request: origin=${origin || 'none'}, user-agent=${userAgent}`);
            return cors()(req, res, next);
        }
        // Allow requests from known Stremio origins (web app, capacitor, etc.)
        if (isStremioOrigin(origin)) {
            log.debug(() => `[Security] Allowed addon API request (known origin): origin=${origin}, user-agent=${userAgent}`);
            return cors()(req, res, next);
        }
        // Allow localhost origins (development/browser on same machine), any port
        if (isLocalhostOrigin(origin)) {
            log.debug(() => `[Security] Allowed addon API request (localhost origin): origin=${origin}, user-agent=${userAgent}`);
            return cors()(req, res, next);
        }
        // Allow extra wildcard domain suffixes (e.g. *.elfhosted.com, *.midnightignite.me)
        if (extraWildcardSuffixes.length > 0) {
            const originHost = extractHostnameFromOrigin(origin);
            if (originHost && extraWildcardSuffixes.some(suffix => originHost === suffix.slice(1) || originHost.endsWith(suffix))) {
                log.debug(() => `[Security] Allowed addon API request (wildcard suffix): origin=${origin}, user-agent=${userAgent}`);
                return cors()(req, res, next);
            }
        }
        // Allow if user-agent identifies as Stremio (mobile apps, etc.)
        if (stremioClient) {
            log.debug(() => `[Security] Allowed addon API request (Stremio user-agent): origin=${origin}, user-agent=${userAgent}`);
            return cors()(req, res, next);
        }
        // Block other origins to prevent browser-based abuse from arbitrary websites
        log.error(() => `[Security] Blocked addon API request - origin: ${origin}, user-agent: ${userAgent}, path: ${req.path}`);
        sentry.captureMessage(
            `[Security] Blocked addon API request - origin: ${origin}, user-agent: ${userAgent}, path: ${req.path}`,
            'error',
            {
                module: 'SecurityMiddleware',
                blockReason: 'unknown_origin_addon_api',
                origin,
                userAgent,
                path: req.path,
                method: req.method,
                ip: req.ip,
                tags: { security: 'blocked_origin' }
            }
        );
        return res.status(403).json({
            error: t('server.errors.stremioOnly', {}, 'Access denied. This addon must be accessed through Stremio.'),
            hint: t('server.errors.stremioHint', {}, 'If you are using Stremio and seeing this error, please report it as a bug.')
        });
    }

    // Static assets (images, fonts) — allow from any origin, no CORS restriction
    if (isStaticAsset) {
        return cors()(req, res, next);
    }

    if (isBrowserAllowed || stremioClient) {
        return applySafeCors(req, res, next);
    }

    // For other routes: Allow requests with no origin (Stremio native clients, curl, direct access)
    // Also treat "null" origin string as no origin (Stremio sends this in some contexts)
    if (!origin || origin === 'null') {
        return applySafeCors(req, res, next);
    }

    // Block browser-based requests to sensitive API routes (they send Origin header)
    // This prevents cross-site cost abuse attacks from malicious websites
    const blockedUserAgent = req.headers['user-agent'] || '';
    log.error(() => `[Security] Blocked browser CORS request - origin: ${origin}, user-agent: ${blockedUserAgent}, path: ${req.path}`);
    sentry.captureMessage(
        `[Security] Blocked browser CORS request - origin: ${origin}, user-agent: ${blockedUserAgent}, path: ${req.path}`,
        'error',
        {
            module: 'SecurityMiddleware',
            blockReason: 'browser_cors_blocked',
            origin,
            userAgent: blockedUserAgent,
            path: req.path,
            method: req.method,
            ip: req.ip,
            tags: { security: 'blocked_origin' }
        }
    );
    return res.status(403).json({
        error: t('server.errors.browserCorsBlocked', {}, 'Browser-based cross-origin requests to this API route are not allowed. Please use the Stremio client.')
    });
});

// Security: Limit JSON payload size (raised to handle embedded subtitle uploads up to ~5MB)
// NOTE: Embedded extraction uploads the entire SRT from the browser; keep this modest but above 5MB allowance.
app.use(express.json({ limit: '6mb' }));

// Note: CSRF protection is not needed for this addon because:
// 1. Authentication uses config tokens in URLs/request body, not session cookies
// 2. CORS restrictions already block cross-origin browser requests
// 3. CSRF attacks exploit session cookies, which this addon doesn't use

// Install a request-scoped translator based on UI language hints (query/header)
app.use((req, res, next) => {
    try {
        getTranslatorFromRequest(req, res);
    } catch (_) { }
    next();
});

// Temporary cache-busting: add versioned path segment for addon routes
// Redirect unversioned addon API routes to versioned equivalents to invalidate stale edge caches,
// then strip the version segment before downstream routing so handlers remain unchanged.
app.use('/addon/:config', async (req, res, next) => {
    // Defense-in-depth: force no-store BEFORE any redirects so proxies/CDNs never cache
    // user-specific addon paths (this was still a gap when only the destination response
    // had no-store headers).
    setNoStore(res);
    res.removeHeader('ETag');

    // Use originalUrl so version detection works even after Express trims the mount path
    const rawPath = req.originalUrl || req.path;
    // If request already includes the cache-buster segment, strip it for internal routing
    const versionMatch = rawPath.match(/\/addon\/[^/]+\/v([0-9.]+)(\/|$)/);
    if (versionMatch) {
        const versionSegment = `/v${versionMatch[1]}`;
        // req.url is the path with the mount stripped, so trim the leading version segment safely
        if (req.url.startsWith(versionSegment)) {
            req.url = req.url.slice(versionSegment.length) || '/';
        } else {
            req.url = req.url.replace(versionSegment, '');
        }
        normalizeSubtitleQueryExtras(req);
        return next();
    }

    normalizeSubtitleQueryExtras(req);

    // Android compatibility dev mode: allow direct subtitle paths (no 307 hop)
    // for players that silently drop external subtitle URLs when a redirect is required.
    const subtitleCompatBypassCandidate = [
        '/subtitles',   // subtitle list JSON
        '/subtitle/',   // provider subtitle downloads
        '/xsync',       // synced subtitles
        '/auto/',       // auto subtitles cache
        '/xembedded',   // embedded subtitles cache
        '/smdb/'        // SMDB subtitle downloads
    ].some(fragment => req.path.includes(fragment));

    if (subtitleCompatBypassCandidate) {
        try {
            const cfg = await resolveConfigAsync(req.params.config, req);
            const mode = String(cfg?.androidSubtitleCompatMode || 'off').toLowerCase();
            if (mode === 'aggressive') {
                log.debug(() => `[CacheBuster] Android compat aggressive: bypass redirect for ${req.path.substring(0, 100)}`);
                return next();
            }
        } catch (e) {
            log.debug(() => `[CacheBuster] Android compat check failed, falling back to redirect logic: ${e.message}`);
        }
    }

    // Only redirect addon API routes (skip bare /addon/:config redirect handler)
    const needsRedirect = [
        '/manifest.json',       // addon install
        '/subtitles',           // SDK subtitles handler
        '/subtitle/',           // custom subtitle download
        '/subtitle-resolve/',   // test C subtitle resolver
        '/subtitle-content/',   // test C typed subtitle content
        '/translate',           // translate downloads
        '/learn',               // learn mode
        '/xsync',               // synced subtitles
        '/auto/',               // automatic subtitles cache
        '/xembedded',           // embedded subtitles (xEmbed cache)
        '/error-subtitle',      // error subtitles
        '/file-translate',      // toolbox file translation
        '/translate-embedded',  // embedded translation API
        '/sync-subtitles',      // sync tool
        '/sub-toolbox',         // toolbox page
        '/sub-history',         // history page
        '/embedded-subtitles',  // embedded extractor
        '/auto-subtitles',      // auto subtitles tool
        '/smdb'                 // SubMaker Database
    ].some(fragment => req.path.includes(fragment));

    if (needsRedirect) {
        const suffix = req.url.replace(`/addon/${req.params.config}`, '');
        const redirectTarget = `/addon/${encodeURIComponent(req.params.config)}${CACHE_BUSTER_PATH}${suffix || ''}`;
        log.debug(() => `[CacheBuster] 307 redirect: ${req.path.substring(0, 80)} -> versioned path`);
        return res.redirect(307, redirectTarget);
    }

    return next();
});

// Custom caching middleware for different file types
app.use((req, res, next) => {
    // Config UI assets must always be fresh to avoid stale layouts across hosts
    const configUiAssets = [
        '/css/configure.css',
        '/css/combobox.css',
        '/js/init.js',
        '/js/combobox.js',
        '/js/combobox-init.js',
        '/js/config-loader.js',
        '/js/ui-widgets.js',
        '/js/theme-toggle.js',
        '/js/sw-register.js',
        '/js/subtitle-menu.js',
        '/sw.js'
    ];
    const configUiPartials = [
        '/partials/main.html',
        '/partials/footer.html',
        '/partials/overlays.html'
    ];
    const configUiFonts = [
        '/fonts/Twemoji.ttf'
    ];
    const isConfigUiAsset =
        configUiAssets.includes(req.path) ||
        configUiPartials.includes(req.path) ||
        configUiFonts.includes(req.path);

    if (isConfigUiAsset) {
        // Force a cache-busting query so stale CDN copies (e.g. elfhosted) are bypassed
        if (!Object.prototype.hasOwnProperty.call(req.query || {}, '_cb')) {
            try {
                const url = new URL(req.originalUrl, `http://${req.headers.host || 'localhost'}`);
                url.searchParams.set('_cb', CACHE_BUSTER_VERSION);
                return res.redirect(307, url.pathname + url.search);
            } catch (err) {
                log.warn(() => ['[Cache] Failed to build cache-buster redirect:', err.message]);
            }
        }
        // Even with a cache-busted URL, mark the response as no-store to prevent future staleness
        setNoStore(res);
    }

    // Never cache session/config endpoints or configure assets (prevents cross-user bleed)
    const noStorePaths = [
        '/config.js',
        '/configure.html',
        '/configure',
        '/api/get-session',
        '/api/create-session',
        '/api/update-session',
        '/api/gemini-models',
        '/api/models',
        '/api/validate-gemini',
        '/api/validate-subsource',
        '/api/validate-subdl',
        '/api/validate-wyzie',
        '/api/validate-opensubtitles',
        '/api/translate-file',
        '/api/save-synced-subtitle',
        '/api/save-embedded-subtitle',
        '/api/translate-embedded',
        '/api/stream-activity',
        '/api/resolve-linked-title',
        '/addon',  // CRITICAL: Prevent caching of ALL addon routes (manifest, subtitles, translations)
        '/file-upload',
        '/subtitle-sync',
        '/sub-toolbox',
        '/embedded-subtitles',
        '/auto-subtitles',
        '/smdb',
        '/api/smdb',
        ...configUiAssets
    ];

    if (noStorePaths.some(p => req.path === p || req.path.startsWith(`${p}/`))) {
        setNoStore(res);
    }
    // Other static assets (CSS, JS, images) can use long-term caching
    // assuming they're versioned or immutable by name
    next();
});

// Service worker must always be fetched fresh to pick up cache-busting logic
app.get('/sw.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.setHeader('Service-Worker-Allowed', '/');
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

function sendConfigurePage(res) {
    setNoStore(res);
    res.type('html').send(generateConfigurePage());
}

app.get('/', (req, res) => {
    sendConfigurePage(res);
});

app.get('/configure', (req, res) => {
    sendConfigurePage(res);
});

app.get('/configure/', (req, res) => {
    sendConfigurePage(res);
});

app.get('/configure.html', (req, res) => {
    sendConfigurePage(res);
});


// Serve static files with caching enabled
// CSS and JS files get 1 year cache (bust with version in filename if needed)
// Other static files get 1 year cache as well
app.use(express.static('public', {
    maxAge: '1y',  // 1 year in milliseconds = 31536000000
    etag: false,   // Keep ETag disabled globally to avoid conditional caching bleed
    // Respect no-store headers set by earlier middleware for sensitive routes.
    // Without this, serve-static would overwrite Cache-Control and allow proxies
    // to cache config-bearing pages or API responses that pass through /public.
    setHeaders: (res, servedPath) => {
        // HTML must never be cached to avoid leaking user-specific pages/configs
        if (servedPath && servedPath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            return;
        }
        if (res.getHeader('Cache-Control')) return; // Preserve explicit no-store
        res.setHeader('Cache-Control', 'public, max-age=31536000000, immutable');
    }
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
        // Skip static files, HTML, health checks, and public API endpoints
        if (req.path.startsWith('/public/') ||
            req.path === '/health' ||
            req.path.endsWith('.css') ||
            req.path.endsWith('.js') ||
            req.path.endsWith('.html') ||
            req.path === '/' ||
            req.path === '/configure' ||
            req.path.startsWith('/configure/')) {
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

app.get('/configure/:config/', (req, res) => {
    const params = new URLSearchParams(req.query || {});
    if (req.params.config) {
        params.set('config', req.params.config);
    }
    const qs = params.toString();
    res.redirect(302, `/configure${qs ? `?${qs}` : ''}`);
});

app.get('/configure/:config', (req, res) => {
    // CRITICAL: Prevent caching to avoid cross-user config contamination (supports path-style config tokens)
    setNoStore(res);
    const params = new URLSearchParams(req.query || {});
    if (req.params.config) {
        params.set('config', req.params.config);
    }
    const qs = params.toString();
    res.redirect(302, `/configure${qs ? `?${qs}` : ''}`);
});


// Health check endpoint for Kubernetes/Docker readiness and liveness probes
// Startup probes get a simple 200 OK immediately (server is alive).
// Full health details are available once sessions are loaded.
app.get('/health', async (req, res) => {
    try {
        // If session manager isn't ready yet, return a lightweight "starting" response
        // so Kubernetes startup/liveness probes pass while heavy init is still running
        if (!sessionManagerReady) {
            return res.status(200).json({
                status: 'starting',
                timestamp: new Date().toISOString(),
                uptime: Math.floor(process.uptime()),
                message: 'Server is alive, session manager still initializing'
            });
        }

        const { getStorageAdapter } = require('./src/storage/StorageFactory');
        const { StorageAdapter } = require('./src/storage');

        // Check storage health
        let storageHealthy = false;
        let storageType = process.env.STORAGE_TYPE || 'redis';

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
            sessions: await sessionManager.getStats(),
            sentry: {
                initialized: sentry.isInitialized(),
                environment: process.env.SENTRY_ENVIRONMENT || 'production'
            }
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

// ── Changelog API ───────────────────────────────────────────────────────
// Parses CHANGELOG.md once at startup and caches the result.
// Re-parses every 5 minutes to pick up hot-reload changes during dev.
const CHANGELOG_MAX_ENTRIES = 15;
let _changelogCache = null;
let _changelogCacheTime = 0;
const CHANGELOG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function parseChangelog() {
    return loadChangelog({
        currentVersion: version,
        baseDir: __dirname,
        maxEntries: CHANGELOG_MAX_ENTRIES,
        logger: log
    });
}

app.get('/api/changelog', (req, res) => {
    const now = Date.now();
    if (!_changelogCache || (now - _changelogCacheTime) > CHANGELOG_CACHE_TTL) {
        _changelogCache = parseChangelog();
        _changelogCacheTime = now;
    }
    // Allow long-term caching — changelog only changes on deploy
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(_changelogCache);
});

// API endpoint to get all languages
app.get('/api/languages', (req, res) => {
    try {
        const languages = getAllLanguages();
        res.json(languages);
    } catch (error) {
        log.error(() => '[API] Error getting languages:', error);
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        res.status(500).json({ error: t('server.errors.languagesFailed', {}, 'Failed to get languages') });
    }
});

// API endpoint to get all translation target languages (includes regional variants and extended languages)
// Used by config page for target/learn language selection where AI can translate to specific regional variants
app.get('/api/languages/translation', (req, res) => {
    try {
        const languages = getAllTranslationLanguages();
        res.json(languages);
    } catch (error) {
        log.error(() => '[API] Error getting translation languages:', error);
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        res.status(500).json({ error: t('server.errors.languagesFailed', {}, 'Failed to get languages') });
    }
});

// API endpoint to fetch UI locale messages
app.get('/api/locale', async (req, res) => {
    try {
        setNoStore(res);
        const requestedLang = (req.query.lang || '').toString().trim().toLowerCase();
        let lang = requestedLang || DEFAULT_LANG;
        const configStr = req.query.config;
        let t = res.locals?.t || getTranslatorFromRequest(req, res);

        // If config token is provided, prefer explicit lang param; otherwise fall back to saved uiLanguage
        if (configStr) {
            const resolved = await resolveConfigGuarded(configStr, req, res, '[Locale] config', t);
            if (!resolved) return;
            const configLang = (resolved.uiLanguage || '').toString().trim().toLowerCase();
            lang = requestedLang || configLang || lang || DEFAULT_LANG;
            // Ensure translator matches the effective language, not just the stored config value
            t = getTranslatorFromRequest(req, res, { ...resolved, uiLanguage: lang });
        }

        const locale = loadLocale(lang || DEFAULT_LANG);
        res.json(locale);
    } catch (error) {
        log.error(() => ['[API] Error getting locale:', error]);
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        res.status(500).json({ error: t('server.errors.localeFailed', {}, 'Failed to load locale') });
    }
});

// Stream activity updates (SSE + snapshot)
app.get('/api/stream-activity', async (req, res) => {
    // Prevent caching to avoid leaking stream info across users
    setNoStore(res);
    let t = res.locals?.t || getTranslatorFromRequest(req, res);

    const { config: configStr } = req.query || {};
    if (!configStr) {
        return res.status(400).json({ error: t('server.errors.missingConfig', {}, 'Missing config') });
    }

    try {
        const resolvedConfig = await resolveConfigGuarded(configStr, req, res, '[API] stream-activity config', t);
        if (!resolvedConfig) return;
        if (resolvedConfig?.__sessionTokenError === true) {
            t = getTranslatorFromRequest(req, res, resolvedConfig);
            return res.status(401).json({ error: t('server.errors.invalidConfig', {}, 'Invalid or expired config') });
        }
        t = getTranslatorFromRequest(req, res, resolvedConfig);

        const configHash = ensureConfigHash(resolvedConfig, configStr);
        const wantsSse = (req.headers.accept || '').includes('text/event-stream');

        if (wantsSse) {
            // Keep-alive stream
            streamActivity.subscribe(configHash, res);
        } else {
            // Snapshot response for polling fallback
            const latest = streamActivity.getLatestStreamActivity(configHash);
            if (!latest) return res.status(204).end();
            res.json(latest);
        }
    } catch (error) {
        if (respondStorageUnavailable(res, error, '[API] stream-activity')) return;
        log.error(() => ['[API] stream-activity error:', error.message]);
        res.status(500).json({ error: t('server.errors.streamActivityFailed', {}, 'Failed to read stream activity') });
    }
});

// Resolve a user-facing linked stream title (anime + imdb/tmdb) for tool UIs
app.get('/api/resolve-linked-title', searchLimiter, async (req, res) => {
    setNoStore(res);
    let t = res.locals?.t || getTranslatorFromRequest(req, res);
    const { config: configStr, videoId } = req.query || {};

    if (!configStr) {
        return res.status(400).json({ error: t('server.errors.missingConfig', {}, 'Missing config') });
    }
    const safeVideoId = String(videoId || '').trim();
    if (!safeVideoId) {
        return res.status(400).json({ error: t('server.errors.missingVideoId', {}, 'Missing video ID') });
    }
    if (safeVideoId.length > 512) {
        return res.status(400).json({ error: t('server.errors.invalidVideoId', {}, 'Invalid video ID') });
    }

    try {
        const resolvedConfig = await resolveConfigGuarded(configStr, req, res, '[API] resolve-linked-title config', t);
        if (!resolvedConfig) return;
        if (resolvedConfig?.__sessionTokenError === true) {
            t = getTranslatorFromRequest(req, res, resolvedConfig);
            return res.status(401).json({ error: t('server.errors.invalidConfig', {}, 'Invalid or expired config') });
        }
        t = getTranslatorFromRequest(req, res, resolvedConfig);

        const resolved = await resolveHistoryTitle(safeVideoId, '');
        const title = String(resolved?.title || '').trim();
        const normalizedTitle = title && title !== safeVideoId ? title : null;
        const season = Number.isFinite(Number(resolved?.season)) ? Number(resolved.season) : null;
        const episode = Number.isFinite(Number(resolved?.episode)) ? Number(resolved.episode) : null;
        return res.json({ title: normalizedTitle, season, episode });
    } catch (error) {
        if (respondStorageUnavailable(res, error, '[API] resolve-linked-title')) return;
        log.error(() => ['[API] resolve-linked-title error:', error.message]);
        return res.status(500).json({ error: t('server.errors.metadataFailed', {}, 'Failed to resolve stream metadata') });
    }
});

// Test endpoint for OpenSubtitles API
app.get('/api/test-opensubtitles', async (req, res) => {
    try {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
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
            results: results.slice(0, 5), // Return first 5 results
            message: t('server.validation.apiKeyValid', {}, 'API key is valid')
        });
    } catch (error) {
        log.error(() => '[Test] Error:', error);
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        res.status(500).json({
            success: false,
            error: t('server.validation.apiError', { reason: error.message }, error.message)
        });
    }
});

// API endpoint to fetch Gemini models
app.post('/api/gemini-models', async (req, res) => {
    // CRITICAL: Prevent caching to avoid cross-user config contamination (user credentials in request body)
    setNoStore(res);

    try {
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { apiKey, configStr } = req.body || {};
        let resolvedConfig = null;

        let geminiApiKey = apiKey;

        // Allow fetching models using the user's saved config (session token)
        if (!geminiApiKey && configStr) {
            resolvedConfig = await resolveConfigGuarded(configStr, req, res, '[API] gemini-models config', t);
            if (!resolvedConfig) return;
            if (isInvalidSessionConfig(resolvedConfig)) {
                t = getTranslatorFromRequest(req, res, resolvedConfig);
                return res.status(401).json({ error: t('server.errors.invalidSessionToken', {}, 'Invalid or expired session token') });
            }
            t = getTranslatorFromRequest(req, res, resolvedConfig);
            geminiApiKey = await selectGeminiApiKey(resolvedConfig) || process.env.GEMINI_API_KEY;
        }

        if (!geminiApiKey) {
            return res.status(400).json({ error: t('server.errors.apiKeyRequired', {}, 'API key is required') });
        }

        const gemini = new GeminiService(
            String(geminiApiKey).trim(),
            getEffectiveGeminiModel(resolvedConfig),
            resolvedConfig?.advancedSettings || {}
        );
        const models = await gemini.getAvailableModels({ silent: true });

        // Filter to only show translation-capable Gemini models (pro/flash/gemma variants).
        // Include Gemma family (e.g., tgemma) for advanced override use cases.
        const filteredModels = models.filter(model => {
            const nameLower = model.name.toLowerCase();
            return nameLower.includes('pro') || nameLower.includes('flash') || nameLower.includes('gemma');
        });

        res.json(filteredModels);
    } catch (error) {
        log.error(() => '[API] Error fetching Gemini models:', error);
        // Surface upstream error details if available for easier debugging in UI
        const message = error?.response?.data?.error || error?.response?.data?.message || error.message || 'Failed to fetch models';
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        res.status(500).json({ error: t('server.errors.modelsFailed', { reason: message }, message) });
    }
});

// Generic model discovery endpoint for alternative providers
app.post('/api/models/:provider', async (req, res) => {
    // CRITICAL: Prevent caching to avoid cross-user config contamination (user-specific config in request body)
    setNoStore(res);

    try {
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const providerKey = String(req.params.provider || '').toLowerCase();
        const { apiKey, configStr } = req.body || {};
        const providerDefaults = getDefaultProviderParameters();
        let resolvedConfig = null;

        // Allow using the user's saved config (session token) instead of passing API keys in the request body
        const getProviderConfigFromSession = async () => {
            if (!configStr) return null;
            resolvedConfig = resolvedConfig || await resolveConfigGuarded(configStr, req, res, '[API] models config', t);
            if (!resolvedConfig) return null;
            if (isInvalidSessionConfig(resolvedConfig)) {
                return { __invalidSession: true };
            }
            t = getTranslatorFromRequest(req, res, resolvedConfig);

            if (providerKey === 'gemini') {
                return {
                    apiKey: await selectGeminiApiKey(resolvedConfig) || process.env.GEMINI_API_KEY,
                    model: getEffectiveGeminiModel(resolvedConfig),
                    params: resolvedConfig?.advancedSettings || {}
                };
            }

            const providers = resolvedConfig?.providers || {};
            const matchKey = Object.keys(providers).find(k => String(k).toLowerCase() === providerKey);
            const providerCfg = matchKey ? providers[matchKey] : null;
            if (!providerCfg) return null;

            const mergedParams = mergeProviderParameters(providerDefaults, resolvedConfig?.providerParameters || {});
            const params = mergedParams?.[providerKey] || mergedParams?.[matchKey] || {};

            return {
                apiKey: providerCfg.apiKey,
                model: providerCfg.model || '',
                params
            };
        };

        const sessionProvider = await getProviderConfigFromSession();

        if (sessionProvider?.__invalidSession === true) {
            return res.status(401).json({ error: t('server.errors.invalidSessionToken', {}, 'Invalid or expired session token') });
        }

        let providerApiKey = apiKey || sessionProvider?.apiKey;
        let providerModel = sessionProvider?.model || '';
        let providerParams = sessionProvider?.params || {};

        if (providerKey === 'gemini') {
            providerApiKey = providerApiKey || process.env.GEMINI_API_KEY;
            if (!providerApiKey) {
                return res.status(400).json({ error: t('server.errors.apiKeyRequired', {}, 'API key is required') });
            }

            const gemini = new GeminiService(
                String(providerApiKey || '').trim(),
                providerModel,
                providerParams
            );
            const models = await gemini.getAvailableModels({ silent: true });
            return res.json(models);
        }

        // For custom provider, API key is optional (local LLMs don't require it)
        // but baseUrl is required and must be validated for SSRF
        if (providerKey === 'custom') {
            const baseUrl = req.body.baseUrl || sessionProvider?.baseUrl || '';
            if (!baseUrl) {
                return res.status(400).json({ error: t('server.errors.baseUrlRequired', {}, 'Base URL is required for custom provider') });
            }

            // SSRF protection: validate baseUrl before making external requests
            const { validateCustomBaseUrl } = require('./src/utils/ssrfProtection');
            const validation = await validateCustomBaseUrl(baseUrl);
            if (!validation.valid) {
                return res.status(400).json({ error: validation.error });
            }

            const provider = await createProviderInstance(
                providerKey,
                {
                    apiKey: providerApiKey || '',
                    model: providerModel,
                    baseUrl: validation.sanitized
                },
                providerParams
            );

            if (!provider || typeof provider.getAvailableModels !== 'function') {
                return res.status(400).json({ error: t('server.errors.unsupportedProvider', {}, 'Unsupported provider') });
            }

            const models = await provider.getAvailableModels();
            return res.json(models);
        }

        if (!providerApiKey) {
            return res.status(400).json({ error: t('server.errors.apiKeyRequired', {}, 'API key is required') });
        }

        if (providerKey === 'cfworkers') {
            const creds = resolveCfWorkersCredentials(providerApiKey);
            if (!creds.token) {
                return res.status(400).json({ error: t('server.errors.cloudflareTokenRequired', {}, 'Cloudflare Workers AI token is required') });
            }
            if (!creds.accountId) {
                return res.status(400).json({
                    error: t('server.errors.cloudflareAccountRequired', {}, 'Cloudflare Workers AI account ID is required. Provide API key as ACCOUNT_ID|TOKEN.')
                });
            }
            providerApiKey = `${creds.accountId}|${creds.token}`;
        }

        const provider = await createProviderInstance(
            providerKey,
            {
                apiKey: providerApiKey,
                model: providerModel
            },
            providerParams
        );

        if (!provider || typeof provider.getAvailableModels !== 'function') {
            const unsupportedMessage = providerKey === 'cfworkers'
                ? t('server.errors.cloudflareCredentialsMissing', {}, 'Cloudflare Workers AI is missing credentials. Use ACCOUNT_ID|TOKEN.')
                : t('server.errors.unsupportedProvider', {}, 'Unsupported provider');
            return res.status(400).json({ error: unsupportedMessage });
        }

        const models = await provider.getAvailableModels();
        res.json(models);
    } catch (error) {
        log.error(() => ['[API] Error fetching provider models:', error]);
        const message = error?.response?.data?.error || error?.response?.data?.message || error.message || 'Failed to fetch models';
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        res.status(500).json({ error: t('server.errors.modelsFailed', { reason: message }, message) });
    }
});

app.post('/api/validate-subsource', validationLimiter, async (req, res) => {
    // CRITICAL: Prevent caching to avoid cross-user config contamination (user credentials in request body)
    setNoStore(res);

    try {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { apiKey } = req.body || {};

        if (!apiKey || !String(apiKey).trim()) {
            return res.status(400).json({
                valid: false,
                error: t('server.errors.apiKeyRequired', {}, 'API key is required')
            });
        }

        // Reuse the dedicated SubSourceService which already
        // sets all required headers, agents, DNS cache, and timeouts.
        const SubSourceService = require('./src/services/subsource');
        const subsource = new SubSourceService(String(apiKey).trim());

        try {
            // A single lightweight movie search is enough to validate the key
            // (The Matrix — imdb: tt0133093). This uses the service's axios client
            // and inherits robust headers and a ~7s timeout with retries.
            const resp = await subsource.client.get('/movies/search', {
                params: { searchType: 'imdb', imdb: 'tt0133093' },
                headers: subsource.defaultHeaders,
                responseType: 'json'
            });

            const movies = Array.isArray(resp.data) ? resp.data : (resp.data?.data || []);

            return res.json({
                valid: true,
                message: t('server.validation.apiKeyValid', {}, 'API key is valid'),
                resultsCount: movies.length || 0
            });
        } catch (apiError) {
            const status = apiError.response?.status;
            const code = apiError.code;
            const msg = apiError.message || '';

            // Show a concise, formatted timeout message instead of axios' lowercase default
            const isTimeout = code === 'ECONNABORTED' || /timeout/i.test(msg);
            if (isTimeout) {
                return res.json({ valid: false, error: t('server.errors.requestTimedOut', {}, 'Request timed out (7s)') });
            }

            if (status === 401 || status === 403) {
                return res.json({ valid: false, error: t('server.errors.invalidApiKeyAuth', {}, 'Invalid API key - authentication failed') });
            }

            // Surface upstream error if present; otherwise the axios message
            const upstream = apiError.response?.data?.error || apiError.response?.data?.message;
            return res.json({ valid: false, error: upstream || msg || t('server.errors.requestFailed', {}, 'Request failed') });
        }
    } catch (error) {
        res.json({
            valid: false,
            error: (res.locals?.t || getTranslatorFromRequest(req, res))('server.validation.apiError', { reason: error.message }, `API error: ${error.message}`)
        });
    }
});

// API endpoint to validate SubDL API key
app.post('/api/validate-subdl', validationLimiter, async (req, res) => {
    // CRITICAL: Prevent caching to avoid cross-user config contamination (user credentials in request body)
    setNoStore(res);

    try {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { apiKey } = req.body;

        if (!apiKey) {
            return res.status(400).json({
                valid: false,
                error: t('server.errors.apiKeyRequired', {}, 'API key is required')
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
                    message: t('server.validation.apiKeyValid', {}, 'API key is valid'),
                    resultsCount: subtitles.length
                });
            } else if (response.data && response.data.status === false) {
                // API returned error status
                res.json({
                    valid: false,
                    error: response.data.error || t('server.errors.invalidApiKey', {}, 'Invalid API key')
                });
            } else {
                // Unexpected response format
                res.json({
                    valid: true,
                    message: t('server.validation.apiKeyAppearsValid', {}, 'API key appears valid'),
                    resultsCount: 0
                });
            }
        } catch (apiError) {
            // Check for authentication errors
            if (apiError.response?.status === 401 || apiError.response?.status === 403) {
                res.json({
                    valid: false,
                    error: t('server.errors.invalidApiKeyAuth', {}, 'Invalid API key - authentication failed')
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
            error: (res.locals?.t || getTranslatorFromRequest(req, res))('server.validation.apiError', { reason: error.message }, `API error: ${error.message}`)
        });
    }
});

// API endpoint to validate OpenSubtitles credentials
// Rate limiting is handled internally by the OpenSubtitlesService login() method
// which uses distributed locking across pods to enforce 1 req/sec
app.post('/api/validate-opensubtitles', async (req, res) => {
    // CRITICAL: Prevent caching to avoid cross-user config contamination (user credentials in request body)
    setNoStore(res);

    try {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                valid: false,
                error: t('server.errors.usernamePasswordRequired', {}, 'Username and password are required')
            });
        }

        // Fast path: if we already have a valid cached token for these credentials,
        // they were already proven valid — skip OpenSubtitles entirely
        const { OpenSubtitlesService, getCachedToken, getCredentialsCacheKey } = require('./src/services/opensubtitles');
        const cacheKey = getCredentialsCacheKey(username, password);
        if (cacheKey) {
            const cached = await getCachedToken(cacheKey);
            if (cached && cached.token) {
                log.debug(() => '[Validate-OS] Credentials validated via cached token (no /login call needed)');
                return res.json({
                    valid: true,
                    message: t('server.validation.credentialsValid', {}, 'Credentials are valid')
                });
            }
        }

        // No cached token — need to actually login
        // The login() method handles all rate limiting internally (local + distributed)
        const osService = new OpenSubtitlesService({ username, password });
        const token = await osService.login(20000); // 20s timeout to allow for queue wait

        if (token) {
            res.json({
                valid: true,
                message: t('server.validation.credentialsValid', {}, 'Credentials are valid')
            });
        } else {
            res.json({
                valid: false,
                error: t('server.errors.noTokenReceived', {}, 'No token received - credentials may be invalid')
            });
        }
    } catch (apiError) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        // Check for authentication errors
        if (apiError.statusCode === 401 || apiError.authError) {
            res.json({
                valid: false,
                error: t('server.errors.invalidCredentials', {}, 'Invalid username or password')
            });
        } else if (apiError.statusCode === 406) {
            res.json({
                valid: false,
                error: t('server.errors.invalidRequestFormat', {}, 'Invalid request format')
            });
        } else if (apiError.statusCode === 429 || apiError.type === 'rate_limit') {
            res.json({
                valid: false,
                error: t('server.errors.opensubtitlesRateLimited', {},
                    'OpenSubtitles login server is rate-limiting requests. This is a temporary server-side issue, not a credentials problem. Please wait 1-2 minutes and try again.')
            });
        } else if (apiError.message && (apiError.message.includes('queue timeout') || apiError.message.includes('queue congestion'))) {
            // Handle internal queue congestion errors from our distributed lock system
            // This is different from OpenSubtitles rate limiting - it's our internal queue being busy
            res.json({
                valid: false,
                error: t('server.errors.loginQueueBusy', {},
                    'Login queue is busy with multiple concurrent requests. Please wait a few seconds and try again.')
            });
        } else if (apiError.message && apiError.message.includes('rate limit')) {
            // Legacy catch for any other rate limit messages
            res.json({
                valid: false,
                error: t('server.errors.opensubtitlesRateLimited', {},
                    'OpenSubtitles login server is rate-limiting requests. This is a temporary server-side issue, not a credentials problem. Please wait 1-2 minutes and try again.')
            });
        } else if (apiError.response?.data?.message) {
            res.json({
                valid: false,
                error: apiError.response.data.message
            });
        } else {
            res.json({
                valid: false,
                error: t('server.validation.apiError', { reason: apiError.message }, `API error: ${apiError.message}`)
            });
        }
    }
});

// API endpoint to validate Gemini API key
app.post('/api/validate-gemini', validationLimiter, async (req, res) => {
    // CRITICAL: Prevent caching to avoid cross-user config contamination (user credentials in request body)
    setNoStore(res);

    try {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { apiKey } = req.body || {};

        if (!apiKey) {
            return res.status(400).json({
                valid: false,
                error: t('server.errors.apiKeyRequired', {}, 'API key is required')
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
                    message: t('server.validation.apiKeyValid', {}, 'API key is valid')
                });
            } else {
                res.json({
                    valid: true,
                    message: t('server.validation.apiKeyValid', {}, 'API key is valid')
                });
            }
        } catch (apiError) {
            // Check for authentication errors
            if (apiError.response?.status === 401 || apiError.response?.status === 403) {
                res.json({
                    valid: false,
                    error: t('server.errors.invalidApiKeyAuth', {}, 'Invalid API key - authentication failed')
                });
            } else if (apiError.response?.status === 400) {
                // Extract error message, handling both string and object responses
                let errorMessage = 'Invalid API key';
                const errorData = apiError.response?.data?.error || apiError.response?.data?.message;
                if (typeof errorData === 'string') {
                    errorMessage = errorData;
                } else if (errorData && typeof errorData === 'object') {
                    errorMessage = errorData.message || JSON.stringify(errorData);
                }
                res.json({
                    valid: false,
                    error: t('server.errors.invalidApiKey', {}, errorMessage)
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
            error: isAuthError
                ? (res.locals?.t || getTranslatorFromRequest(req, res))('server.errors.invalidApiKey', {}, 'Invalid API key')
                : (res.locals?.t || getTranslatorFromRequest(req, res))('server.validation.apiError', { reason: error.message }, `API error: ${error.message}`)
        });
    }
});

// API endpoint to validate Subs.ro API key
app.post('/api/validate-subsro', validationLimiter, async (req, res) => {
    // CRITICAL: Prevent caching to avoid cross-user config contamination (user credentials in request body)
    setNoStore(res);

    try {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { apiKey } = req.body || {};

        if (!apiKey || !String(apiKey).trim()) {
            return res.status(400).json({
                valid: false,
                error: t('server.errors.apiKeyRequired', {}, 'API key is required')
            });
        }

        const axios = require('axios');
        const { httpAgent, httpsAgent, dnsLookup } = require('./src/utils/httpAgents');
        const { version } = require('./src/utils/version');

        // Test API key by fetching quota information
        const quotaUrl = 'https://subs.ro/api/v1.0/quota';

        try {
            const response = await axios.get(quotaUrl, {
                headers: {
                    'User-Agent': `SubMaker v${version}`,
                    'Accept': 'application/json',
                    'X-Subs-Api-Key': String(apiKey).trim()
                },
                timeout: 10000,
                httpAgent,
                httpsAgent,
                lookup: dnsLookup
            });

            // Check if we got a valid response with quota info
            if (response.data && response.data.status === 200 && response.data.quota) {
                const quota = response.data.quota;
                return res.json({
                    valid: true,
                    message: t('server.validation.apiKeyValid', {}, 'API key is valid'),
                    // Include quota info in response
                    quota: {
                        remaining: quota.remaining_quota,
                        total: quota.total_quota,
                        type: quota.quota_type
                    }
                });
            } else if (response.data && response.data.status !== 200) {
                // API returned non-200 status in body
                return res.json({
                    valid: false,
                    error: response.data.message || t('server.errors.invalidApiKey', {}, 'Invalid API key')
                });
            } else {
                // Unexpected response format but no error - assume valid
                return res.json({
                    valid: true,
                    message: t('server.validation.apiKeyAppearsValid', {}, 'API key appears valid')
                });
            }
        } catch (apiError) {
            const status = apiError.response?.status;
            const msg = apiError.message || '';

            // Handle authentication errors
            if (status === 401 || status === 403) {
                return res.json({
                    valid: false,
                    error: t('server.errors.invalidApiKeyAuth', {}, 'Invalid API key - authentication failed')
                });
            }

            // Handle timeout
            if (apiError.code === 'ECONNABORTED' || /timeout/i.test(msg)) {
                return res.json({
                    valid: false,
                    error: t('server.errors.requestTimedOut', {}, 'Request timed out')
                });
            }

            // Surface upstream error if present
            const upstream = apiError.response?.data?.message || apiError.response?.data?.error;
            return res.json({
                valid: false,
                error: upstream || msg || t('server.errors.requestFailed', {}, 'Request failed')
            });
        }
    } catch (error) {
        res.json({
            valid: false,
            error: (res.locals?.t || getTranslatorFromRequest(req, res))('server.validation.apiError', { reason: error.message }, `API error: ${error.message}`)
        });
    }
});

// API endpoint to validate Wyzie API key
app.post('/api/validate-wyzie', validationLimiter, async (req, res) => {
    setNoStore(res);

    try {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        const apiKey = String(req.body?.apiKey || '').trim();

        if (!apiKey) {
            return res.status(400).json({
                valid: false,
                error: t('server.errors.apiKeyRequired', {}, 'API key is required')
            });
        }

        const WyzieSubsService = require('./src/services/wyzieSubs');
        const wyzie = new WyzieSubsService(apiKey);
        const result = await wyzie.validateApiKey({ timeout: 10000 });

        if (result.valid) {
            const payload = {
                valid: true,
                message: result.message || t('server.validation.apiKeyValid', {}, 'API key is valid')
            };

            if (Number.isFinite(result.resultsCount)) {
                payload.resultsCount = result.resultsCount;
            }

            return res.json(payload);
        }

        const normalizedError = String(result.error || '').trim();
        const lowerError = normalizedError.toLowerCase();
        let translatedError = normalizedError || t('server.errors.requestFailed', {}, 'Request failed');

        if (lowerError.includes('api key required')) {
            translatedError = t('server.errors.apiKeyRequired', {}, 'API key is required');
        } else if (lowerError.includes('invalid api key')) {
            translatedError = t('server.errors.invalidApiKeyAuth', {}, 'Invalid API key - authentication failed');
        } else if (lowerError.includes('timeout')) {
            translatedError = t('server.errors.requestTimedOut', {}, 'Request timed out');
        }

        return res.json({
            valid: false,
            error: translatedError
        });
    } catch (error) {
        res.json({
            valid: false,
            error: (res.locals?.t || getTranslatorFromRequest(req, res))('server.validation.apiError', { reason: error.message }, `API error: ${error.message}`)
        });
    }
});

// API endpoint to validate AssemblyAI API key
app.post('/api/validate-assemblyai', async (req, res) => {
    setNoStore(res);
    try {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        const apiKey = (req.body?.apiKey || '').trim();
        if (!apiKey) {
            return res.status(400).json({
                valid: false,
                error: t('server.errors.apiKeyRequired', {}, 'API key is required')
            });
        }
        const axios = require('axios');
        const { httpAgent, httpsAgent } = require('./src/utils/httpAgents');
        try {
            const response = await axios.get('https://api.assemblyai.com/v2/account', {
                headers: { Authorization: apiKey },
                timeout: 10000,
                httpAgent,
                httpsAgent
            });
            if (response.status === 200) {
                return res.json({
                    valid: true,
                    message: t('server.validation.apiKeyValid', {}, 'API key is valid')
                });
            }
            return res.json({
                valid: false,
                error: t('server.validation.apiError', { reason: response.statusText || 'Unknown error' }, `API error: ${response.statusText || 'Unknown error'}`)
            });
        } catch (apiError) {
            if (apiError.response?.status === 401 || apiError.response?.status === 403) {
                return res.json({
                    valid: false,
                    error: t('server.errors.invalidApiKeyAuth', {}, 'Invalid API key - authentication failed')
                });
            }
            throw apiError;
        }
    } catch (error) {
        res.json({
            valid: false,
            error: (res.locals?.t || getTranslatorFromRequest(req, res))('server.validation.apiError', { reason: error.message }, `API error: ${error.message}`)
        });
    }
});

// API endpoint to create a session (production mode)
// Apply rate limiting to prevent session flooding attacks
app.post('/api/create-session', sessionCreationLimiter, enforceConfigPayloadSize, async (req, res) => {
    try {
        setNoStore(res); // prevent any caching of session tokens
        const config = req.body;
        const t = res.locals?.t || getTranslatorFromRequest(req, res, config);

        if (!config) {
            return res.status(400).json({ error: t('server.session.configRequired', {}, 'Configuration is required') });
        }

        const localhost = isLocalhost(req);
        const storageType = process.env.STORAGE_TYPE || 'redis';
        const forceSessions = process.env.FORCE_SESSIONS === 'true';
        const allowBase64 = process.env.ALLOW_BASE64_CONFIG === 'true';

        // Base64 configs are deprecated; only allow when explicitly enabled.
        const shouldUseBase64 = allowBase64 && localhost && !forceSessions && storageType !== 'redis';
        if (shouldUseBase64) {
            // Defensive: strip any internal flags that shouldn't come from client
            stripInternalFlags(config);
            const configStr = toBase64Url(JSON.stringify(config));
            log.debug(() => '[Session API] Localhost detected and ALLOW_BASE64_CONFIG enabled - using base64 encoding');
            return res.json({
                token: configStr,
                type: 'base64',
                message: t('server.session.usingBase64Localhost', {}, 'Using base64 encoding for localhost')
            });
        }

        // Defensive: strip any internal flags that shouldn't come from client
        stripInternalFlags(config);

        // Production mode: create session
        const token = await sessionManager.createSession(config);
        const sessionBrief = await sessionManager.getSessionBrief(token);
        log.debug(() => `[Session API] Created session token: ${redactToken(token)}`);

        res.json({
            token,
            type: 'session',
            expiresIn: process.env.SESSION_MAX_AGE || 90 * 24 * 60 * 60 * 1000,
            session: sessionBrief
        });
    } catch (error) {
        // Respond with 503 if storage is temporarily unavailable to signal retry-ability
        // instead of 500 which might cause clients to give up or discard the config
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Session API]', t)) {
            return;
        }
        log.error(() => '[Session API] Error creating session:', error);
        res.status(500).json({ error: t('server.errors.sessionCreateFailed', {}, 'Failed to create session') });
    }
});

// API endpoint to update an existing session
// Uses sessionUpdateLimiter (60/hour) instead of sessionCreationLimiter (10/hour)
// because updates are the normal save flow and should not exhaust the creation quota
app.post('/api/update-session/:token', sessionUpdateLimiter, enforceConfigPayloadSize, async (req, res) => {
    try {
        setNoStore(res); // prevent any caching of session tokens
        const { token } = req.params;
        const config = req.body;
        const t = res.locals?.t || getTranslatorFromRequest(req, res, config);

        if (!config) {
            return res.status(400).json({ error: t('server.session.configRequired', {}, 'Configuration is required') });
        }

        if (!token) {
            return res.status(400).json({ error: t('server.session.tokenRequired', {}, 'Session token is required') });
        }

        const localhost = isLocalhost(req);
        const storageType = process.env.STORAGE_TYPE || 'redis';
        const forceSessions = process.env.FORCE_SESSIONS === 'true';
        const allowBase64 = process.env.ALLOW_BASE64_CONFIG === 'true';
        const isBase64Token = !/^[a-f0-9]{32}$/.test(token);

        // Base64 configs are deprecated; only allow when explicitly enabled.
        const shouldUseBase64 = allowBase64 && localhost && isBase64Token && !forceSessions && storageType !== 'redis';
        if (shouldUseBase64) {
            // For localhost base64, just return new encoded config
            const configStr = toBase64Url(JSON.stringify(config));
            log.debug(() => '[Session API] Localhost detected and ALLOW_BASE64_CONFIG enabled - creating new base64 token');
            invalidateRouterCache(token, 'base64 config update');
            return res.json({
                token: configStr,
                type: 'base64',
                updated: true,
                message: t('server.session.createdBase64Localhost', {}, 'Created new base64 token for localhost')
            });
        }

        if (isBase64Token) {
            return res.status(400).json({ error: t('server.errors.sessionTokenFormat', {}, 'Invalid session token format') });
        }

        // Defensive: strip any internal flags that shouldn't come from client
        stripInternalFlags(config);

        // Try to update existing session (now checks Redis if not in cache)
        const updated = await sessionManager.updateSession(token, config);

        if (!updated) {
            // Session doesn't exist - create new one instead
            log.debug(() => `[Session API] Session not found, creating new one`);
            const newToken = await sessionManager.createSession(config);
            const sessionBrief = await sessionManager.getSessionBrief(newToken);
            invalidateRouterCache(token, 'session token expired');
            return res.json({
                token: newToken,
                type: 'session',
                updated: false,
                created: true,
                message: t('server.session.expiredCreated', {}, 'Session expired or not found, created new session'),
                expiresIn: process.env.SESSION_MAX_AGE || 90 * 24 * 60 * 60 * 1000,
                session: sessionBrief
            });
        }

        const sessionBrief = await sessionManager.getSessionBrief(token);
        log.debug(() => `[Session API] Updated session token: ${redactToken(token)}`);
        invalidateRouterCache(token, 'session update via API');

        res.json({
            token,
            type: 'session',
            updated: true,
            message: t('server.session.updateSuccess', {}, 'Session configuration updated successfully'),
            session: sessionBrief
        });
    } catch (error) {
        // CRITICAL: Respond with 503 if storage is temporarily unavailable.
        // This prevents silently regenerating a new token (which loses the user's existing
        // state) during transient Redis hiccups. The 503 signals to clients that they should
        // retry with the same token instead of discarding it.
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Session API]', t)) {
            return;
        }
        log.error(() => '[Session API] Error updating session:', error);
        res.status(500).json({ error: t('server.errors.sessionUpdateFailed', {}, 'Failed to update session') });
    }
});

// API endpoint to get session statistics (for monitoring)
app.get('/api/session-stats', statsLimiter, async (req, res) => {
    const t = res.locals?.t || getTranslatorFromRequest(req, res);
    try {
        const stats = await sessionManager.getStats();
        const limits = getLanguageSelectionLimits();
        res.json({ ...stats, version, limits });
    } catch (error) {
        log.error(() => '[Session API] Error getting stats:', error);
        res.status(500).json({ error: t('server.errors.sessionStatsFailed', {}, 'Failed to get session statistics') });
    }
});

// API endpoint to validate session and check for contamination
app.get('/api/validate-session/:token', async (req, res) => {
    try {
        setNoStore(res);
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { token } = req.params;

        if (!token || !/^[a-f0-9]{32}$/.test(token)) {
            return res.status(400).json({ error: t('server.errors.sessionTokenFormat', {}, 'Invalid session token format') });
        }

        const config = await sessionManager.getSession(token);
        if (!config) {
            return res.status(404).json({ error: t('server.errors.sessionNotFound', {}, 'Session not found') });
        }
        const sessionBrief = await sessionManager.getSessionBrief(token);

        // Return diagnostic information
        const clientIP = req.ip || req.connection?.remoteAddress || 'unknown';
        const cachedRouter = routerCache.has(token);
        const cachedConfig = resolveConfigCache.has(token);

        res.json({
            valid: true,
            token: redactToken(token),
            targetLanguages: config.targetLanguages || [],
            sourceLanguages: config.sourceLanguages || [],
            hasRouterCache: cachedRouter,
            hasConfigCache: cachedConfig,
            clientIP: clientIP,
            serverTime: new Date().toISOString(),
            session: sessionBrief
        });

        log.info(() => `[Session Validation] Token ${redactToken(token)} validated from IP ${clientIP}, targets: ${JSON.stringify(config.targetLanguages || [])}`);
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Session API] validate-session', t)) return;
        log.error(() => '[Session API] Error validating session:', error);
        res.status(500).json({ error: t('server.errors.sessionValidateFailed', {}, 'Failed to validate session') });
    }
});

app.get('/api/session-brief/:token', async (req, res) => {
    try {
        setNoStore(res);
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { token } = req.params;

        if (!token || !/^[a-f0-9]{32}$/.test(token)) {
            return res.status(400).json({ error: t('server.errors.sessionTokenFormat', {}, 'Invalid session token format') });
        }

        const brief = await sessionManager.getSessionBrief(token);
        if (!brief) {
            return res.status(404).json({ error: t('server.errors.sessionNotFound', {}, 'Session not found') });
        }

        res.json({ session: brief });
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Session API] session-brief', t)) return;
        log.error(() => '[Session API] Error fetching session brief:', error);
        res.status(500).json({ error: t('server.errors.sessionFetchFailed', {}, 'Failed to fetch session configuration') });
    }
});

app.post('/api/session-briefs', sessionBriefsLimiter, async (req, res) => {
    try {
        setNoStore(res);
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        const tokens = Array.isArray(req.body?.tokens) ? req.body.tokens : [];
        if (tokens.length > MAX_SESSION_BRIEF_BATCH) {
            return res.status(400).json({
                error: t('server.errors.tooManySessionBriefTokens', { max: MAX_SESSION_BRIEF_BATCH }, `Too many tokens requested at once (max ${MAX_SESSION_BRIEF_BATCH})`)
            });
        }
        const sessions = await sessionManager.getSessionBriefs(tokens, { maxTokens: MAX_SESSION_BRIEF_BATCH });
        res.json({ sessions });
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Session API] session-briefs', t)) return;
        log.error(() => '[Session API] Error fetching session briefs:', error);
        res.status(500).json({ error: t('server.errors.sessionFetchFailed', {}, 'Failed to fetch session configuration') });
    }
});

app.post('/api/session-state/:token', async (req, res) => {
    try {
        setNoStore(res);
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { token } = req.params;
        const disabled = req.body?.disabled === true;

        if (!token || !/^[a-f0-9]{32}$/.test(token)) {
            return res.status(400).json({ error: t('server.errors.sessionTokenFormat', {}, 'Invalid session token format') });
        }

        const brief = await sessionManager.setSessionDisabled(token, disabled);
        if (!brief) {
            return res.status(404).json({ error: t('server.errors.sessionNotFound', {}, 'Session not found') });
        }

        invalidateRouterCache(token, disabled ? 'session disabled' : 'session enabled');
        invalidateResolveConfigCache(token);

        res.json({
            success: true,
            session: brief,
            message: disabled
                ? t('server.session.disabled', {}, 'Session disabled')
                : t('server.session.enabled', {}, 'Session enabled')
        });
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Session API] session-state', t)) return;
        log.error(() => '[Session API] Error updating session state:', error);
        res.status(500).json({ error: t('server.errors.sessionUpdateFailed', {}, 'Failed to update session') });
    }
});

// API endpoint to fetch a stored session configuration by token (for UI prefill)
// Supports autoRegenerate=true query param to create a fresh default session if the stored one is missing/corrupted
app.get('/api/get-session/:token', async (req, res) => {
    try {
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { token } = req.params;
        const autoRegenerate = req.query.autoRegenerate === 'true';

        if (!token || !/^[a-f0-9]{32}$/.test(token)) {
            return res.status(400).json({ error: t('server.errors.sessionTokenFormat', {}, 'Invalid session token format') });
        }

        // CRITICAL: Set aggressive cache prevention headers to avoid cross-user config contamination
        // Without these headers, browsers/proxies can cache User A's config and serve it to User B
        setNoStore(res);

        // getSession now automatically falls back to storage if not in cache
        const cfg = await sessionManager.getSession(token);

        if (!cfg) {
            // Session not found - check if we should auto-regenerate
            if (autoRegenerate) {
                log.info(() => `[Session API] Session not found for ${redactToken(token)}, auto-regenerating fresh default config`);

                const { config: freshConfig, token: freshToken } = await regenerateDefaultConfig();
                t = getTranslatorFromRequest(req, res, freshConfig);

                // Invalidate any cached routers for the old token
                invalidateRouterCache(token, 'session not found, regenerated');

                return res.json({
                    config: freshConfig,
                    token: freshToken,
                    regenerated: true,
                    reason: t('server.errors.sessionNotFoundReason', {}, 'Session not found or expired'),
                    session: await sessionManager.getSessionBrief(freshToken)
                });
            }

            return res.status(404).json({ error: t('server.errors.sessionNotFound', {}, 'Session not found') });
        }

        // Check if this config resolves to empty_config_00 (corrupted payload)
        const normalized = normalizeConfig(cfg);
        const configHash = ensureConfigHash(normalized, token);

        if (configHash === 'empty_config_00' && autoRegenerate) {
            log.warn(() => `[Session API] Session ${redactToken(token)} resolved to empty_config_00, auto-regenerating`);

            const { config: freshConfig, token: freshToken } = await regenerateDefaultConfig();
            t = getTranslatorFromRequest(req, res, freshConfig);

            // Invalidate cached router for the old token
            invalidateRouterCache(token, 'empty_config_00 detected, regenerated');

            return res.json({
                config: freshConfig,
                token: freshToken,
                regenerated: true,
                reason: t('server.errors.sessionConfigCorrupted', {}, 'Config payload was empty or corrupted (empty_config_00)'),
                session: await sessionManager.getSessionBrief(freshToken)
            });
        }

        return res.json({
            config: normalized,
            token,
            regenerated: false,
            session: await sessionManager.getSessionBrief(token)
        });
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Session API] get-session', t)) return;
        log.error(() => '[Session API] Error fetching session:', error);
        res.status(500).json({ error: t('server.errors.sessionFetchFailed', {}, 'Failed to fetch session configuration') });
    }
});

// API endpoint to translate uploaded subtitle file
app.post('/api/translate-file', fileTranslationLimiter, validateRequest(fileTranslationBodySchema, 'body'), async (req, res) => {
    try {
        // Prevent caching of user-specific translation results
        setNoStore(res);
        let t = res.locals?.t || getTranslatorFromRequest(req, res);

        const { content, targetLanguage, sourceLanguage, configStr, advancedSettings, overrides } = req.body;

        if (!content) {
            return res.status(400).send(t('server.errors.translateFileMissingContent', {}, 'Subtitle content is required'));
        }

        if (!targetLanguage) {
            return res.status(400).send(t('server.errors.translateFileMissingTarget', {}, 'Target language is required'));
        }

        if (!configStr) {
            return res.status(400).send(t('server.errors.translateFileMissingConfig', {}, 'Configuration is required'));
        }

        log.debug(() => `[File Translation API] Translating to ${targetLanguage}`);

        // Parse config
        const config = await resolveConfigGuarded(configStr, req, res, '[API] translate-file config', t);
        if (!config) return;
        if (isInvalidSessionConfig(config)) {
            t = getTranslatorFromRequest(req, res, config);
            return res.status(401).send(t('server.errors.invalidSessionToken', {}, 'Invalid or expired session token'));
        }
        t = getTranslatorFromRequest(req, res, config);
        const providerDefaults = getDefaultProviderParameters();
        const optionalProviders = new Set(['googletranslate']);
        const normalizeProviderKey = (key) => String(key || '').toLowerCase();
        const enabledProviders = await (async () => {
            const providers = [];
            const providerConfigs = config.providers || {};
            Object.entries(providerConfigs).forEach(([key, cfg]) => {
                const normalized = normalizeProviderKey(key);
                const optional = optionalProviders.has(normalized);
                const hasCreds = optional ? !!cfg?.model : !!(cfg?.apiKey && cfg?.model);
                if (cfg && cfg.enabled === true && hasCreds) {
                    providers.push(normalized);
                }
            });
            // Check if Gemini is configured (handles both single key and rotation modes)
            const geminiKey = await selectGeminiApiKey(config);
            if (geminiKey && getEffectiveGeminiModel(config)) {
                providers.push('gemini');
            } else if (config.multiProviderEnabled !== true) {
                // Legacy single-provider configs default to Gemini
                providers.push('gemini');
            }
            return Array.from(new Set(providers));
        })();
        const requestedProvider = normalizeProviderKey(overrides?.provider || advancedSettings?.provider);
        let activeProvider = (config.multiProviderEnabled === true && config.mainProvider)
            ? normalizeProviderKey(config.mainProvider)
            : 'gemini';

        if (requestedProvider && enabledProviders.includes(requestedProvider)) {
            activeProvider = requestedProvider;
            config.multiProviderEnabled = true;
            config.mainProvider = requestedProvider;
        }
        if (!enabledProviders.includes(activeProvider) && enabledProviders.length > 0) {
            activeProvider = enabledProviders[0];
            config.multiProviderEnabled = true;
            config.mainProvider = activeProvider;
        }
        if (config.multiProviderEnabled === true) {
            config.bypassCache = true;
            config.bypassCacheConfig = config.bypassCacheConfig || {};
            config.bypassCacheConfig.enabled = true;
        }

        // Apply advanced settings overrides (Gemini-focused, kept for backward compatibility)
        const sanitizeAdvancedSettings = (incoming = {}) => {
            const parsed = {};
            const clampNumber = (value, min, max) => {
                const num = typeof value === 'number' ? value : parseFloat(value);
                if (!Number.isFinite(num)) return null;
                if (min !== undefined && num < min) return min;
                if (max !== undefined && num > max) return max;
                return num;
            };

            const thinking = clampNumber(incoming.thinkingBudget, -1, 200000);
            if (thinking !== null) parsed.thinkingBudget = thinking;

            const temperature = clampNumber(incoming.temperature, 0, 2);
            if (temperature !== null) parsed.temperature = temperature;

            const topP = clampNumber(incoming.topP, 0, 1);
            if (topP !== null) parsed.topP = topP;

            const topK = clampNumber(incoming.topK, 1, 100);
            if (topK !== null) parsed.topK = topK;

            const maxTokens = clampNumber(incoming.maxOutputTokens, 1, 200000);
            if (maxTokens !== null) parsed.maxOutputTokens = maxTokens;

            const timeout = clampNumber(incoming.translationTimeout, 5, 720);
            if (timeout !== null) parsed.translationTimeout = timeout;

            const maxRetries = clampNumber(incoming.maxRetries, 0, 5);
            if (maxRetries !== null) parsed.maxRetries = Math.max(0, Math.min(5, parseInt(maxRetries, 10)));

            return Object.keys(parsed).length ? parsed : null;
        };

        const parsedAdvanced = sanitizeAdvancedSettings(advancedSettings);
        if (parsedAdvanced) {
            config.advancedSettings = {
                ...config.advancedSettings,
                ...parsedAdvanced
            };
        }
        if (advancedSettings && typeof advancedSettings.geminiModel === 'string' && advancedSettings.geminiModel.trim()) {
            const requestedGeminiModel = advancedSettings.geminiModel.trim();
            config.geminiModel = requestedGeminiModel;
            config.advancedSettings = {
                ...config.advancedSettings,
                enabled: true,
                geminiModel: requestedGeminiModel
            };
        }
        if (advancedSettings && typeof advancedSettings.translationPrompt === 'string') {
            const prompt = advancedSettings.translationPrompt.trim();
            if (prompt) {
                config.translationPrompt = prompt;
            }
        }

        // Apply provider-aware overrides (model/parameters/prompt) from the upload page
        if (overrides && typeof overrides === 'object') {
            // Prompt override
            if (typeof overrides.translationPrompt === 'string') {
                const promptOverride = overrides.translationPrompt.trim();
                if (promptOverride) {
                    config.translationPrompt = promptOverride;
                }
            }

            // Model override for the active provider
            if (typeof overrides.providerModel === 'string' && overrides.providerModel.trim()) {
                const modelOverride = overrides.providerModel.trim();
                if (activeProvider === 'gemini') {
                    config.geminiModel = modelOverride;
                    config.advancedSettings = {
                        ...config.advancedSettings,
                        enabled: true,
                        geminiModel: modelOverride
                    };
                } else {
                    config.providers = config.providers || {};
                    const current = config.providers[activeProvider] || {};
                    config.providers[activeProvider] = {
                        ...current,
                        model: modelOverride
                    };
                }
            }

            // Advanced settings override (still Gemini-focused; optional)
            const overrideAdvanced = sanitizeAdvancedSettings(overrides.advancedSettings);
            if (overrideAdvanced) {
                config.advancedSettings = {
                    ...config.advancedSettings,
                    ...overrideAdvanced
                };
            }

            // Provider parameter overrides (temperature, timeout, etc.) - scoped to active provider
            if (overrides.providerParameters && typeof overrides.providerParameters === 'object') {
                const scopedParams = {};
                Object.keys(overrides.providerParameters).forEach(key => {
                    if (String(key).toLowerCase() === activeProvider) {
                        scopedParams[key] = overrides.providerParameters[key];
                    }
                });

                if (Object.keys(scopedParams).length > 0) {
                    const merged = mergeProviderParameters(
                        providerDefaults,
                        { ...(config.providerParameters || {}), ...scopedParams }
                    );
                    config.providerParameters = merged;
                }
            }
        }

        // Resolve translation workflow/timing options (per-request overrides win over config defaults)
        const options = req.body.options || {};

        // Translation workflow (xml/json/original/ai) — per-request override wins over saved config
        const validWorkflows = ['xml', 'json', 'original', 'ai'];
        const requestedWorkflow = typeof options.translationWorkflow === 'string'
            ? options.translationWorkflow.trim().toLowerCase() : '';
        const translationWorkflow = validWorkflows.includes(requestedWorkflow)
            ? requestedWorkflow : '';

        // Single batch mode — per-request override
        const singleBatchRequested = typeof options.singleBatchMode === 'boolean'
            ? options.singleBatchMode : false;
        const singleBatchMode = singleBatchRequested || config.singleBatchMode === true;

        // Batch context — per-request override
        const enableBatchContextRequested = typeof options.enableBatchContext === 'boolean'
            ? options.enableBatchContext : null;

        // Derive sendTimestampsToAI from the workflow (only 'ai' workflow uses it)
        const sendTimestampsToAI = translationWorkflow
            ? translationWorkflow === 'ai'
            : (config.advancedSettings?.sendTimestampsToAI === true);

        config.singleBatchMode = singleBatchMode;
        const advanced = { ...(config.advancedSettings || {}) };

        // Forward translation workflow to engine
        if (translationWorkflow) {
            advanced.translationWorkflow = translationWorkflow;
            // Sync the legacy sendTimestampsToAI flag with workflow choice
            if (translationWorkflow === 'ai') {
                advanced.sendTimestampsToAI = true;
            } else {
                delete advanced.sendTimestampsToAI;
            }
        } else if (sendTimestampsToAI) {
            advanced.sendTimestampsToAI = true;
        } else {
            delete advanced.sendTimestampsToAI;
        }

        // Forward batch context setting
        if (enableBatchContextRequested !== null) {
            advanced.enableBatchContext = enableBatchContextRequested;
        }

        config.advancedSettings = advanced;

        // Get language names for better translation context
        const targetLangName = getLanguageName(targetLanguage) || targetLanguage;
        const sourceLangName = sourceLanguage ? (getLanguageName(sourceLanguage) || sourceLanguage) : 'detected source language';

        // Convert non-SRT uploads (VTT, ASS/SSA) to SRT for translation
        let workingContent = ensureSRTForTranslation(content, '[File Translation API]');

        // Initialize translation provider (Gemini by default, alternative providers when enabled)
        const { provider: translationProvider, providerName, model, fallbackProviderName } = await createTranslationProvider(config);
        if (!translationProvider || typeof translationProvider.translateSubtitle !== 'function') {
            throw new Error('Translation provider is not configured correctly');
        }
        const effectiveModel = model || getEffectiveGeminiModel(config);
        log.debug(() => `[File Translation API] Using provider=${providerName} model=${effectiveModel}`);

        const effectiveWorkflow = config.advancedSettings?.translationWorkflow || 'xml';
        let translatedContent = null;

        // --- Keepalive streaming to prevent Cloudflare 524 timeouts ---
        // Cloudflare kills connections after 100s of no data from origin.
        // Send periodic newline bytes to reset the timer while translation runs.
        // SRT parsers ignore leading blank lines, so this is safe.
        const KEEPALIVE_INTERVAL_MS = parseInt(process.env.FILE_UPLOAD_KEEPALIVE_INTERVAL) || 30000;
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        let keepaliveTimer = null;
        let keepaliveCount = 0;
        try {
            keepaliveTimer = setInterval(() => {
                try {
                    if (!res.writableEnded) {
                        res.write('\n');
                        if (typeof res.flush === 'function') res.flush();
                        keepaliveCount++;
                        log.debug(() => `[File Translation API] Keepalive #${keepaliveCount} sent`);
                    }
                } catch (_) { /* response already closed */ }
            }, KEEPALIVE_INTERVAL_MS);

            // Always use TranslationEngine — it handles batching, parallel translation,
            // and all workflows (xml/json/original/ai) internally.
            const engine = new TranslationEngine(
                translationProvider,
                effectiveModel,
                config.advancedSettings || {},
                { singleBatchMode, providerName, fallbackProviderName, enableStreaming: false }
            );
            log.debug(() => `[File Translation API] Using TranslationEngine (workflow=${effectiveWorkflow}, singleBatch=${singleBatchMode}, batchContext=${!!config.advancedSettings?.enableBatchContext})`);
            translatedContent = await engine.translateSubtitle(
                workingContent,
                targetLangName,
                config.translationPrompt,
                null
            );

            log.debug(() => '[File Translation API] Translation completed via TranslationEngine');

            // Send translated content and end the response
            log.debug(() => `[File Translation API] Sending result (${keepaliveCount} keepalives sent during translation)`);
            res.end(translatedContent);

        } finally {
            if (keepaliveTimer) clearInterval(keepaliveTimer);
        }

    } catch (error) {
        log.error(() => '[File Translation API] Error:', error);
        if (res.headersSent) {
            // Headers already committed (keepalive started) — send error marker in the body
            // The client detects [TRANSLATION_ERROR] and extracts the message
            try {
                const t = res.locals?.t || getTranslatorFromRequest(req, res);
                const msg = t('server.errors.translateFileError', { reason: error.message }, `Translation failed: ${error.message}`);
                res.end('\n[TRANSLATION_ERROR]\n' + msg);
            } catch (_) {
                try { res.end('\n[TRANSLATION_ERROR]\nTranslation failed: ' + (error.message || 'Unknown error')); } catch (__) { /* response closed */ }
            }
        } else {
            // Headers not sent yet (early failure before keepalive) — use standard error response
            const t = res.locals?.t || getTranslatorFromRequest(req, res);
            res.status(500).send(t('server.errors.translateFileError', { reason: error.message }, `Translation failed: ${error.message}`));
        }
    }
});

// API endpoint to trigger retranslation (mirrors the 3-click cache reset mechanism)
// This allows the history page to offer a "Retranslate" button that does exactly
// what triple-clicking a subtitle does: purge cache and re-trigger translation
app.get('/api/retranslate', searchLimiter, async (req, res) => {
    try {
        setNoStore(res);
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const {
            config: configStr,
            sourceFileId,
            targetLanguage,
            title,
            filename,
            videoId,
            sourceLanguage,
            videoHash,
            season,
            episode
        } = req.query;

        if (!configStr) {
            return res.status(400).json({ success: false, error: t('server.errors.missingConfig', {}, 'Missing config') });
        }
        if (!sourceFileId) {
            return res.status(400).json({ success: false, error: t('server.errors.missingSourceFileId', {}, 'Missing sourceFileId') });
        }
        if (!targetLanguage) {
            return res.status(400).json({ success: false, error: t('server.errors.missingTargetLanguage', {}, 'Missing targetLanguage') });
        }

        const config = await resolveConfigGuarded(configStr, req, res, '[Retranslate API] config', t);
        if (!config) return;
        if (isInvalidSessionConfig(config)) {
            return res.status(401).json({ success: false, error: t('server.errors.invalidSessionToken', {}, 'Invalid or expired session token') });
        }
        t = getTranslatorFromRequest(req, res, config);
        ensureConfigHash(config, configStr);
        const userHash = config.__configHash || config.userHash || '';
        const cleanText = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
        const parseOptionalInt = (value) => {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        };
        const matchProviderKey = (providerName) => {
            if (!providerName || !config?.providers || typeof config.providers !== 'object') return '';
            const target = String(providerName).toLowerCase();
            return Object.keys(config.providers).find(key => String(key).toLowerCase() === target) || '';
        };

        const normalizedTitle = cleanText(title, 200);
        const normalizedFilename = cleanText(filename, 200);
        const normalizedVideoId = cleanText(videoId, 200);
        const normalizedSourceLanguage = cleanText(sourceLanguage, 24).toLowerCase();
        const normalizedVideoHash = cleanText(videoHash, 128);
        const normalizedSourceFileId = cleanText(sourceFileId, 240);
        const normalizedTargetLanguage = cleanText(targetLanguage, 24).toLowerCase();
        const seasonNumber = parseOptionalInt(season);
        const episodeNumber = parseOptionalInt(episode);
        const initialProvider = (config.multiProviderEnabled === true ? String(config.mainProvider || '').trim() : 'gemini') || 'gemini';
        const matchedProviderKey = matchProviderKey(initialProvider);
        const initialModel = String(initialProvider).toLowerCase() === 'gemini'
            ? (getEffectiveGeminiModel(config) || 'default')
            : (matchedProviderKey ? (config.providers?.[matchedProviderKey]?.model || 'default') : 'default');

        if (!normalizedSourceFileId) {
            return res.status(400).json({ success: false, error: t('server.errors.missingSourceFileId', {}, 'Missing sourceFileId') });
        }
        if (!normalizedTargetLanguage) {
            return res.status(400).json({ success: false, error: t('server.errors.missingTargetLanguage', {}, 'Missing targetLanguage') });
        }

        // SAFETY CHECK 1: Block if user is at concurrency limit
        if (!(await canUserStartTranslation(userHash, config))) {
            log.warn(() => `[Retranslate API] BLOCKED: User at concurrency limit (user: ${userHash || 'anonymous'})`);
            return res.status(429).json({
                success: false,
                error: t('server.errors.retranslateConcurrencyLimit', {}, 'Cannot retranslate: you have too many translations in progress. Please wait for them to complete.')
            });
        }

        // SAFETY CHECK 2: Block if translation is currently in progress for this subtitle
        const { cacheKey, runtimeKey, bypass, bypassEnabled } = generateCacheKeys(config, normalizedSourceFileId, normalizedTargetLanguage);
        const translationInProgress = (() => {
            if (bypassEnabled && userHash) {
                const status = translationStatus.get(cacheKey);
                const inFlight = inFlightTranslations.has(cacheKey);
                return (status && status.inProgress) || inFlight;
            } else {
                // For permanent cache, check both user-scoped and base keys
                const status = translationStatus.get(runtimeKey) || translationStatus.get(cacheKey);
                const inFlight = inFlightTranslations.has(runtimeKey) || inFlightTranslations.has(cacheKey);
                return (status && status.inProgress) || inFlight;
            }
        })();

        if (translationInProgress) {
            log.warn(() => `[Retranslate API] BLOCKED: Translation already in progress for ${normalizedSourceFileId}/${normalizedTargetLanguage} (user: ${userHash})`);
            return res.status(409).json({
                success: false,
                error: t('server.errors.retranslateInProgress', {}, 'Cannot retranslate: translation is already in progress for this subtitle. Please wait for it to complete.')
            });
        }

        // RATE LIMIT CHECK (dry-run first to give user feedback)
        const rateLimitStatus = checkCacheResetRateLimit(config, { consume: false });
        if (rateLimitStatus.blocked) {
            log.warn(() => `[Retranslate API] BLOCKED: Rate limit reached for ${rateLimitStatus.cacheType} cache (${rateLimitStatus.limit}/${Math.round(CACHE_RESET_WINDOW_MS / 60000)}m) (user: ${userHash})`);
            return res.status(429).json({
                success: false,
                error: t('server.errors.retranslateRateLimit', {
                    limit: rateLimitStatus.limit,
                    window: Math.round(CACHE_RESET_WINDOW_MS / 60000)
                }, `Rate limit reached: you can only retranslate ${rateLimitStatus.limit} times per ${Math.round(CACHE_RESET_WINDOW_MS / 60000)} minutes.`)
            });
        }

        // Check if there's actually something to purge
        const hadCache = await hasCachedTranslation(normalizedSourceFileId, normalizedTargetLanguage, config);
        const partial = (!hadCache) ? await readFromPartialCache(runtimeKey) : null;
        const hasResetTarget = hadCache || (partial && typeof partial.content === 'string' && partial.content.length > 0);
        let remainingResets = rateLimitStatus.remaining;

        if (!hasResetTarget) {
            log.debug(() => `[Retranslate API] No cache found for ${normalizedSourceFileId}/${normalizedTargetLanguage} - proceeding without purge`);
        } else {
            // Consume rate limit slot and purge cache
            const consumeStatus = checkCacheResetRateLimit(config);
            if (consumeStatus.blocked) {
                // Race condition: limit was reached between dry-run and consume
                return res.status(429).json({
                    success: false,
                    error: t('server.errors.retranslateRateLimit', {
                        limit: consumeStatus.limit,
                        window: Math.round(CACHE_RESET_WINDOW_MS / 60000)
                    }, `Rate limit reached.`)
                });
            }

            remainingResets = consumeStatus.remaining;
            log.debug(() => `[Retranslate API] Purging cache for ${normalizedSourceFileId}/${normalizedTargetLanguage}. Remaining resets this window: ${consumeStatus.remaining}`);
            const purged = await purgeTranslationCache(normalizedSourceFileId, normalizedTargetLanguage, config);
            if (!purged) {
                throw new Error('Failed to clear cached translation');
            }
        }

        const historyRequestId = crypto.randomUUID();
        const historyUserHash = resolveHistoryUserHash(config, userHash);
        const historyTitle = normalizedTitle || normalizedFilename || normalizedSourceFileId;
        const historyFilename = normalizedFilename || historyTitle || normalizedSourceFileId;
        const historyVideoId = normalizedVideoId || 'unknown';
        const historySourceLanguage = normalizedSourceLanguage
            || (Array.isArray(config.sourceLanguages) && config.sourceLanguages[0])
            || 'auto';
        const historySeed = {
            id: historyRequestId,
            status: 'processing',
            scope: 'history',
            title: historyTitle,
            filename: historyFilename,
            videoId: historyVideoId,
            videoHash: normalizedVideoHash || deriveVideoHash(historyFilename, historyVideoId || normalizedSourceFileId || ''),
            sourceFileId: normalizedSourceFileId,
            sourceLanguage: historySourceLanguage,
            targetLanguage: normalizedTargetLanguage,
            createdAt: Date.now(),
            provider: initialProvider,
            model: initialModel
        };
        if (seasonNumber !== null) historySeed.season = seasonNumber;
        if (episodeNumber !== null) historySeed.episode = episodeNumber;

        if (historyUserHash) {
            await saveRequestToHistory(historyUserHash, historySeed);
        }

        const translateUrl = `/addon/${encodeURIComponent(configStr)}/translate/${encodeURIComponent(normalizedSourceFileId)}/${encodeURIComponent(normalizedTargetLanguage)}`;
        void handleTranslation(normalizedSourceFileId, normalizedTargetLanguage, config, {
            waitForFullTranslation: false,
            sourceFileId: normalizedSourceFileId,
            targetLanguage: normalizedTargetLanguage,
            filename: historyFilename,
            videoId: normalizedVideoId,
            sourceLanguage: historySourceLanguage,
            from: 'history',
            season: seasonNumber,
            episode: episodeNumber,
            historyRequestId,
            historySeed
        }).catch(error => {
            log.warn(() => `[Retranslate API] Background retranslation failed for ${normalizedSourceFileId}/${normalizedTargetLanguage}: ${error.message}`);
        });

        log.info(() => `[Retranslate API] Fresh translation started for ${normalizedSourceFileId}/${normalizedTargetLanguage}, remaining resets: ${remainingResets}`);

        return res.json({
            success: true,
            message: t('server.retranslate.success', {}, 'Fresh translation started.'),
            translateUrl,
            historyEntryId: historyRequestId,
            remaining: Math.max(0, remainingResets)
        });

    } catch (error) {
        log.error(() => ['[Retranslate API] Error:', error]);
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Retranslate API]', t)) return;
        res.status(500).json({
            success: false,
            error: t('server.errors.retranslateFailed', { reason: error.message }, `Retranslation failed: ${error.message}`)
        });
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

/**
 * Helper: Regenerate a fresh default config session
 * Used when a config is corrupted (empty_config_00) or session token is missing/expired
 * @returns {Object} { config: Object, token: string } - Fresh default config and new session token
 */
async function regenerateDefaultConfig() {
    const defaultConfig = getDefaultConfig();
    // Tag with metadata so downstream handlers know this came from regeneration
    // Note: These flags are stripped before session creation to avoid fingerprint pollution
    defaultConfig.__regenerated = true;
    defaultConfig.__regeneratedAt = new Date().toISOString();

    // Strip internal flags before creating session to ensure clean fingerprint
    const cleanConfig = { ...defaultConfig };
    stripInternalFlags(cleanConfig);

    // Create a fresh session for this default config
    const newToken = await sessionManager.createSession(cleanConfig);

    log.info(() => `[ConfigRegeneration] Created fresh default config session: ${redactToken(newToken)}`);

    return {
        config: defaultConfig,
        token: newToken
    };
}

// Resolve config synchronously for base64, and asynchronously for session tokens
async function resolveConfigAsync(configStr, req) {
    const localhost = isLocalhost(req);
    const isToken = /^[a-f0-9]{32}$/.test(configStr);
    if (TRACE_CONFIG_RESOLVE) {
        const pathLabel = req?.path || req?.originalUrl || req?.url || 'unknown';
        const ip = req?.ip || req?.connection?.remoteAddress || 'unknown';
        log.debug(() => `[ConfigTrace] resolveConfigAsync path=${pathLabel} ip=${ip} key=${redactToken(configStr)}`);
    }

    // SECURITY CRITICAL: Fast path cache lookup with TRIPLE-LAYER DEFENSE
    // IMPORTANT: Only cache base64 configs. Session tokens must always re-fetch from
    // storage to avoid serving another user's config from a stale in-memory cache
    // when instances are behind a load balancer. This was observed as "random language"
    // swaps because the cached config outlived a session regen/eviction.
    if (!isToken) {
        // DEFENSE LAYER 1: Verify the cache key is definitely not a token using strict validation
        if (isDefinitelyNotToken(configStr)) {
            const cachedConfig = resolveConfigCache.get(configStr);
            if (cachedConfig) {
                // DEFENSE LAYER 2: Verify cached config doesn't contain contamination markers
                if (cachedConfig.__sessionTokenError || cachedConfig.__originalToken) {
                    log.error(() => `[SECURITY] Cache contamination detected in resolveConfigCache for key ${redactToken(configStr)} - purging entry`);
                    resolveConfigCache.delete(configStr);
                } else {
                    // DEFENSE LAYER 3: Deep clone to prevent shared references
                    return deepCloneConfig(cachedConfig);
                }
            }
        } else {
            // SECURITY ALERT: A potential token passed the initial !isToken check
            log.error(() => `[SECURITY CRITICAL] Potential token ${redactToken(configStr)} passed !isToken check but failed strict validation - REFUSING cache lookup`);
        }
    }

    // Detect Stremio Kai
    const userAgent = (req.headers['user-agent'] || '').toLowerCase();
    const isStremioKai = userAgent.includes('stremio') && (userAgent.includes('kai') || userAgent.includes('kaios'));

    if (isStremioKai) {
        log.debug(() => `[Stremio Kai] Detected Stremio Kai request - User-Agent: ${userAgent}`);
    }

    if (!isToken) {
        const allowBase64 = process.env.ALLOW_BASE64_CONFIG === 'true' && localhost;
        const config = await parseConfig(configStr, { allowBase64 });
        // Attach deterministic config hash derived from normalized payload
        ensureConfigHash(config, configStr);

        // SECURITY CRITICAL: Triple-check before caching
        // DEFENSE LAYER 1: Verify key is definitely not a token
        // DEFENSE LAYER 2: Verify config is safe to cache (no error flags)
        // DEFENSE LAYER 3: Verify key has reasonable length
        if (isDefinitelyNotToken(configStr) && isSafeToCache(config) && configStr.length > 0) {
            // Deep clone before caching to prevent shared references
            resolveConfigCache.set(configStr, config);
        } else {
            // SECURITY ALERT: Prevented unsafe caching
            if (!isDefinitelyNotToken(configStr)) {
                log.error(() => `[SECURITY] BLOCKED caching - key ${redactToken(configStr)} failed token validation`);
            } else if (!isSafeToCache(config)) {
                log.warn(() => `[SECURITY] BLOCKED caching - config for ${redactToken(configStr)} has error flags`);
            } else {
                log.warn(() => `[SECURITY] BLOCKED caching - invalid key length for ${redactToken(configStr)}`);
            }
        }

        return deepCloneConfig(config);
    }

    // Token path: getSession now automatically checks cache first, then storage
    const cfg = await sessionManager.getSession(configStr);
    if (cfg) {
        if (isStremioKai) {
            log.debug(() => `[Stremio Kai] Successfully resolved session token for config`);
        }
        const normalized = normalizeConfig(cfg);

        // Check if normalizeConfig flagged that the config was auto-corrected and should be persisted
        // This happens when e.g. OpenSubtitles Auth was selected without credentials and we switch to V3
        // By persisting the fix, we prevent the warning from appearing on every single request
        if (normalized.__needsSessionPersist === true) {
            const persistReason = normalized.__persistReason || 'config-auto-correction';

            // CRITICAL FIX: Create a clean copy for persistence to avoid fingerprint pollution.
            // We must NOT mutate `normalized` because downstream handlers need the flags
            // (e.g., __credentialDecryptionFailed for showing error messages to users).
            const configForPersistence = { ...normalized };
            stripInternalFlags(configForPersistence);

            // Persist the corrected config asynchronously (fire-and-forget, don't block the response)
            // This updates the stored session so future requests won't trigger the same warning
            sessionManager.updateSession(configStr, configForPersistence)
                .then(updated => {
                    if (updated) {
                        log.info(() => `[ConfigResolver] Persisted auto-corrected config to session: ${redactToken(configStr)} (reason: ${persistReason})`);
                    } else {
                        log.warn(() => `[ConfigResolver] Failed to persist auto-corrected config - session not found: ${redactToken(configStr)}`);
                    }
                })
                .catch(err => {
                    log.error(() => `[ConfigResolver] Error persisting auto-corrected config: ${err?.message || err}`);
                });
        }

        // CRITICAL: Deep clone to prevent shared references between concurrent requests
        ensureConfigHash(normalized, configStr);
        try {
            const sessionBrief = await sessionManager.getSessionBrief(configStr);
            if (sessionBrief && sessionBrief.disabled === true) {
                normalized.__sessionDisabled = true;
            }
        } catch (metaErr) {
            log.debug(() => `[ConfigResolver] Failed to inspect session state for ${redactToken(configStr)}: ${metaErr.message}`);
        }
        // SECURITY: NEVER cache configs retrieved via session tokens
        return deepCloneConfig(normalized);
    }

    if (isStremioKai) {
        log.warn(() => `[Stremio Kai] Session token not found: ${configStr.substring(0, 8)}...`);
    }

    // Session token not found - return default config with error flag
    // NOTE: We do NOT create a new session here - that should only happen via /api/get-session?autoRegenerate=true
    // Creating tokens here would result in multiple tokens being generated during page load
    log.warn(() => `[ConfigResolver] Session token not found: ${configStr.substring(0, 8)}..., returning default config with error flag`);

    const defaultConfig = getDefaultConfig();
    defaultConfig.__sessionTokenError = true;
    defaultConfig.__originalToken = configStr; // Keep track of the failed token
    ensureConfigHash(defaultConfig, configStr);
    // SECURITY: Do NOT cache error/fallback configs
    return defaultConfig;
}

// Custom route: Download subtitle (BEFORE SDK router to take precedence)
// Support multiple URL extensions for ASS/SSA compatibility testing:
// - .srt (default)
// - .sub (Option A - generic subtitle extension)
// - no extension (Option B - rely on Content-Type header)
function detectSubtitlePayloadFormat(content) {
    const trimmed = (content || '').trimStart();
    const isVtt = trimmed.startsWith('WEBVTT');
    const detectedAss = detectASSFormat(trimmed);
    const isAss = detectedAss.isASS && detectedAss.format !== 'ssa';
    const isSsa = detectedAss.isASS && detectedAss.format === 'ssa';
    const ext = isVtt ? 'vtt' : (isSsa ? 'ssa' : (isAss ? 'ass' : 'srt'));
    return { isVtt, isAss, isSsa, ext };
}

const subtitleDownloadHandler = async (req, res) => {
    try {
        let t = res.locals?.t || getTranslatorFromRequest(req, res);

        const { config: configStr, fileId } = req.params;
        // Language may include extension (e.g., "eng.srt", "eng.sub", "eng")
        let language = req.params.language || '';
        // Strip any extension from language parameter
        language = language.replace(/\.(srt|sub|vtt|ass|ssa)$/i, '');

        const config = await resolveConfigGuarded(configStr, req, res, '[Download] config', t);
        if (!config) return;
        if (isInvalidSessionConfig(config)) {
            log.warn(() => `[Download] Blocked subtitle download due to invalid session token ${redactToken(configStr)}`);
            const errorSubtitle = createSessionTokenErrorSubtitle(null, null, config?.uiLanguage || 'en');
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename=\"session-token-not-found.srt\"');
            setSubtitleCacheHeaders(res, 'loading');
            return res.status(401).send(errorSubtitle);
        }
        t = getTranslatorFromRequest(req, res, config);
        const configKey = ensureConfigHash(config, configStr);
        const downloadCacheVariant = (config.convertAssToVtt === false && config.forceSRTOutput !== true)
            ? 'download_raw_ass'
            : 'download_converted';
        const assHeaderTestMode = config.devMode === true
            && config.convertAssToVtt === false
            && config.forceSRTOutput !== true;
        const androidCompatMode = String(config.androidSubtitleCompatMode || 'off').toLowerCase();
        const strictSrtHeaders = androidCompatMode === 'aggressive';

        // Language is already cleaned (extension stripped at handler entry)
        const langCode = language;

        // Create deduplication key (includes config+language to separate concurrent user requests)
        const dedupKey = `download:${configKey}:${fileId}:${langCode}`;

        // STEP 1: Check download cache first (fastest path - shared with translation flow)
        const cachedContent = getDownloadCached(fileId, downloadCacheVariant);
        if (cachedContent) {
            const cacheStats = getDownloadCacheStats();
            log.debug(() => `[Download Cache] HIT for ${fileId} in ${langCode} (${cachedContent.length} bytes) - Cache: ${cacheStats.size}/${cacheStats.max} entries, ${cacheStats.sizeMB}/${cacheStats.maxSizeMB}MB`);

            // Validate cached content isn't corrupted (same check as download flow)
            const minSize = Number(config.minSubtitleSizeBytes) || 200;
            if (cachedContent.length < minSize) {
                log.warn(() => `[Download Cache] Cached content too small (${cachedContent.length} bytes < ${minSize}). Serving corruption warning.`);
                const { createInvalidSubtitleMessage } = require('./src/handlers/subtitles');
                const errorMessage = createInvalidSubtitleMessage('The subtitle file is too small and seems corrupted.', config?.uiLanguage || 'en');
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${fileId}.srt"`);
                setSubtitleCacheHeaders(res, 'loading');
                res.send(errorMessage);
                return;
            }

            // Decide headers based on content (serve VTT, ASS/SSA, or SRT with appropriate MIME types)
            const { isVtt, isAss, isSsa } = detectSubtitlePayloadFormat(cachedContent);

            if (isVtt) {
                res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${fileId}.vtt"`);
            } else if (isAss && !isSsa) {
                // ASS format (Advanced SubStation Alpha)
                if (assHeaderTestMode) {
                    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                    res.setHeader('Content-Disposition', `inline; filename="${fileId}.ass"`);
                } else {
                    res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
                    res.setHeader('Content-Disposition', `attachment; filename="${fileId}.ass"`);
                }
            } else if (isSsa) {
                // SSA format (SubStation Alpha v4)
                if (assHeaderTestMode) {
                    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                    res.setHeader('Content-Disposition', `inline; filename="${fileId}.ssa"`);
                } else {
                    res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
                    res.setHeader('Content-Disposition', `attachment; filename="${fileId}.ssa"`);
                }
            } else {
                if (strictSrtHeaders) {
                    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
                    res.setHeader('Content-Disposition', `inline; filename="${fileId}.srt"`);
                } else {
                    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                    res.setHeader('Content-Disposition', `attachment; filename="${fileId}.srt"`);
                }
            }
            const requestExt = ((req.originalUrl || '').match(/\.(srt|sub|vtt|ass|ssa)(?:\?|$)/i)?.[1] || 'none').toLowerCase();
            const payloadFormat = isVtt ? 'vtt' : isSsa ? 'ssa' : (isAss ? 'ass' : 'srt');
            if ((requestExt === 'srt' || requestExt === 'sub') && (payloadFormat === 'ass' || payloadFormat === 'ssa')) {
                log.debug(() => `[Download] Extension/payload mismatch file=${fileId} ext=${requestExt} payload=${payloadFormat} cache=hit`);
            }
            setSubtitleCacheHeaders(res, 'final');
            res.send(cachedContent);
            return;
        }

        // STEP 2: Cache miss - check for Stremio Community prefetch cooldown
        // This blocks libmpv prefetch requests during cooldown window after subtitle list is served
        // NOTE: Use configStr (session token) here, NOT configKey (computed hash) - the cooldown is set
        // using the session token from req.params.config in the subtitle list response middleware
        const prefetchCooldown = checkStremioCommunityPrefetchCooldown(configStr, req);
        if (prefetchCooldown.blocked) {
            log.debug(() => `[Download] Blocked by prefetch cooldown: ${prefetchCooldown.reason} for ${fileId}`);
            const { createInvalidSubtitleMessage } = require('./src/handlers/subtitles');
            const cooldownMessage = createInvalidSubtitleMessage('Click again to load this subtitle.', config?.uiLanguage || 'en');
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${fileId}.srt"`);
            setSubtitleCacheHeaders(res, 'loading');
            return res.send(cooldownMessage);
        }

        // STEP 3: Check for burst (many downloads in short window = prefetch)
        const downloadBurst = checkDownloadBurst(configKey, fileId);
        if (downloadBurst.isBurst) {
            // Stremio is prefetching all subtitles - return empty to save API quota
            // User can click again to actually download
            log.debug(() => `[Download] Burst detected: ${downloadBurst.count} downloads in ${DOWNLOAD_BURST_WINDOW_MS}ms. Deferring ${fileId} (first was ${downloadBurst.firstFileId})`);
            const { createInvalidSubtitleMessage } = require('./src/handlers/subtitles');
            const deferMessage = createInvalidSubtitleMessage('Click again to load this subtitle.', config?.uiLanguage || 'en');
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${fileId}.srt"`);
            setSubtitleCacheHeaders(res, 'loading');
            return res.send(deferMessage);
        }

        // STEP 4: Check if already in flight
        const isAlreadyInFlight = inFlightRequests.has(dedupKey);

        if (isAlreadyInFlight) {
            log.debug(() => `[Download Cache] MISS for ${fileId} in ${langCode} - Duplicate in-flight request detected, waiting...`);
        } else {
            log.debug(() => `[Download Cache] MISS for ${fileId} in ${langCode} - Starting new download`);
        }

        // STEP 5: Download with deduplication (prevents concurrent downloads of same subtitle)
        const content = await deduplicate(dedupKey, () =>
            handleSubtitleDownload(fileId, langCode, config)
        );

        // STEP 6: Save to cache for future requests (shared with translation flow)
        saveDownloadCached(fileId, content, downloadCacheVariant);

        // Decide headers based on content (serve VTT, ASS/SSA, or SRT with appropriate MIME types)
        const { isVtt, isAss, isSsa } = detectSubtitlePayloadFormat(content);

        if (isVtt) {
            res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${fileId}.vtt"`);
        } else if (isAss && !isSsa) {
            // ASS format (Advanced SubStation Alpha)
            if (assHeaderTestMode) {
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Content-Disposition', `inline; filename="${fileId}.ass"`);
            } else {
                res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${fileId}.ass"`);
            }
        } else if (isSsa) {
            // SSA format (SubStation Alpha v4)
            if (assHeaderTestMode) {
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Content-Disposition', `inline; filename="${fileId}.ssa"`);
            } else {
                res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${fileId}.ssa"`);
            }
        } else {
            if (strictSrtHeaders) {
                res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
                res.setHeader('Content-Disposition', `inline; filename="${fileId}.srt"`);
            } else {
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${fileId}.srt"`);
            }
        }
        const requestExt = ((req.originalUrl || '').match(/\.(srt|sub|vtt|ass|ssa)(?:\?|$)/i)?.[1] || 'none').toLowerCase();
        const payloadFormat = isVtt ? 'vtt' : isSsa ? 'ssa' : (isAss ? 'ass' : 'srt');
        if ((requestExt === 'srt' || requestExt === 'sub') && (payloadFormat === 'ass' || payloadFormat === 'ssa')) {
            log.debug(() => `[Download] Extension/payload mismatch file=${fileId} ext=${requestExt} payload=${payloadFormat} cache=miss`);
        }
        setSubtitleCacheHeaders(res, 'final');
        res.send(content);

    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Download]', t)) return;
        log.error(() => '[Download] Error:', error);
        res.status(404).send(t('server.errors.subtitleNotFound', {}, 'Subtitle not found'));
    }
};

// Test C route: resolve unknown subtitle format at click time and redirect to a typed URL.
const subtitleResolveHandler = async (req, res) => {
    try {
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { config: configStr, fileId } = req.params;
        let language = req.params.language || '';
        language = language.replace(/\.(srt|sub|vtt|ass|ssa)$/i, '');

        const config = await resolveConfigGuarded(configStr, req, res, '[Resolve] config', t);
        if (!config) return;
        if (isInvalidSessionConfig(config)) {
            const errorSubtitle = createSessionTokenErrorSubtitle(null, null, config?.uiLanguage || 'en');
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename=\"session-token-not-found.srt\"');
            setSubtitleCacheHeaders(res, 'loading');
            return res.status(401).send(errorSubtitle);
        }

        const downloadCacheVariant = (config.convertAssToVtt === false && config.forceSRTOutput !== true)
            ? 'download_raw_ass'
            : 'download_converted';
        let content = getDownloadCached(fileId, downloadCacheVariant);
        if (!content) {
            content = await handleSubtitleDownload(fileId, language, config);
            saveDownloadCached(fileId, content, downloadCacheVariant);
        }

        const { ext } = detectSubtitlePayloadFormat(content);
        const redirectUrl = `/addon/${encodeURIComponent(configStr)}/subtitle-content/${encodeURIComponent(fileId)}/${encodeURIComponent(language)}.${ext}`;
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        return res.redirect(302, redirectUrl);
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Resolve]', t)) return;
        log.error(() => '[Resolve] Error:', error);
        res.status(404).send(t('server.errors.subtitleNotFound', {}, 'Subtitle not found'));
    }
};

// Typed content route for Test C. Reuse existing download path by re-injecting extension into :language.
const subtitleContentHandler = async (req, res) => {
    req.params.language = `${req.params.language}.${req.params.ext}`;
    return subtitleDownloadHandler(req, res);
};

// Register subtitle download routes for all supported extensions
// Route priority: Express matches routes in order of registration
app.get('/addon/:config/subtitle/:fileId/:language.srt', searchLimiter, validateRequest(subtitleParamsSchema, 'params'), subtitleDownloadHandler);
app.get('/addon/:config/subtitle/:fileId/:language.sub', searchLimiter, validateRequest(subtitleParamsSchema, 'params'), subtitleDownloadHandler);
app.get('/addon/:config/subtitle/:fileId/:language', searchLimiter, validateRequest(subtitleParamsSchema, 'params'), subtitleDownloadHandler);
app.get('/addon/:config/subtitle-resolve/:fileId/:language', searchLimiter, validateRequest(subtitleParamsSchema, 'params'), subtitleResolveHandler);
app.get('/addon/:config/subtitle-content/:fileId/:language.:ext', searchLimiter, validateRequest(subtitleContentParamsSchema, 'params'), subtitleContentHandler);

// Custom route: Serve error subtitles for config errors (BEFORE SDK router to take precedence)
app.get('/addon/:config/error-subtitle/:errorType.srt', async (req, res) => {
    try {
        // Defense-in-depth: Prevent caching (already set by early middleware, but explicit is safer)
        setNoStore(res);
        let t = res.locals?.t || getTranslatorFromRequest(req, res);

        const { config: configStr, errorType } = req.params;

        log.debug(() => `[Error Subtitle] Serving error subtitle for: ${errorType}`);

        // Resolve config to check if this is a session token error
        const config = await resolveConfigGuarded(configStr, req, res, '[Error Subtitle] config', t);
        if (!config) return;
        t = getTranslatorFromRequest(req, res, config);

        // Build base URL for reinstall links
        const baseUrl = `${req.protocol}://${req.get('host')}`;

        // For session token errors, optionally generate a fresh token for the reinstall link
        // Only do this when explicitly allowed to avoid spawning new sessions during in-app playback.
        const allowRegenerate = String(req.query.regenerate || req.query.regen || '').toLowerCase() === 'true';
        let regeneratedToken = null;
        if (config.__sessionTokenError === true && errorType === 'session-token-not-found') {
            if (allowRegenerate) {
                const { token } = await regenerateDefaultConfig();
                regeneratedToken = token;
                log.info(() => `[Error Subtitle] Generated fresh token for error subtitle reinstall link: ${redactToken(token)}`);
            } else {
                log.debug(() => `[Error Subtitle] Skipping token regeneration for reinstall link (no regenerate flag)`);
            }
        }

        let content;
        switch (errorType) {
            case 'session-token-not-found':
                content = createSessionTokenErrorSubtitle(regeneratedToken, baseUrl, config?.uiLanguage || 'en');
                break;
            case 'opensubtitles-auth':
                content = createOpenSubtitlesAuthErrorSubtitle(config?.uiLanguage || 'en');
                break;
            case 'opensubtitles-quota':
                content = createOpenSubtitlesQuotaExceededSubtitle(config?.uiLanguage || 'en');
                break;
            case 'credential-decryption-failed':
                // Credential decryption failed - this happens when encryption keys don't match across server instances
                const failedFields = config?.__credentialDecryptionFailedFields || [];
                content = createCredentialDecryptionErrorSubtitle(failedFields, config?.uiLanguage || 'en');
                break;
            default:
                content = createSessionTokenErrorSubtitle(regeneratedToken, baseUrl, config?.uiLanguage || 'en'); // Default to session token error
                break;
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${errorType}.srt"`);
        res.send(content);

    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Error Subtitle]', t)) return;
        log.error(() => '[Error Subtitle] Error:', error);
        res.status(500).send(t('server.errors.errorSubtitleUnavailable', {}, 'Error subtitle unavailable'));
    }
});

// Custom route: Perform translation (BEFORE SDK router to take precedence)
app.get('/addon/:config/translate/:sourceFileId/:targetLang', normalizeSubtitleFormatParams, searchLimiter, validateRequest(translationParamsSchema, 'params'), async (req, res) => {
    try {
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { config: configStr, sourceFileId, targetLang } = req.params;
        const config = await resolveConfigGuarded(configStr, req, res, '[Translation] config', t);
        if (!config) return;
        if (isInvalidSessionConfig(config)) {
            log.warn(() => `[Translation] Blocked translation due to invalid session token ${redactToken(configStr)}`);
            const errorSubtitle = createSessionTokenErrorSubtitle(null, null, config?.uiLanguage || 'en');
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename=\"session-token-not-found.srt\"');
            setSubtitleCacheHeaders(res, 'loading');
            return res.status(401).send(errorSubtitle);
        }
        t = getTranslatorFromRequest(req, res, config);
        const configKey = ensureConfigHash(config, configStr);
        const mobileQuery = String(req.query.mobileMode || req.query.mobile || '').toLowerCase();
        const queryForcesMobile = ['1', 'true', 'yes', 'on'].includes(mobileQuery);
        // Mobile mode is now ONLY enabled when explicitly configured or forced via query string
        // Automatic Android detection has been removed for consistency across all devices
        const waitForFullTranslation = (config.mobileMode === true) || queryForcesMobile;

        // Create deduplication key based on source file and target language
        const dedupKey = `translate:${configKey}:${sourceFileId}:${targetLang}`;

        // Unusual purge: if same translated subtitle is loaded 3 times in < 5s, purge and retrigger
        // SAFETY BLOCK: Only purge if translation is NOT currently in progress
        try {
            const clickKey = `translate-click:${configKey}:${sourceFileId}:${targetLang}`;
            const now = Date.now();
            const windowMs = 5_000; // 5 seconds
            const entry = firstClickTracker.get(clickKey) || { times: [] };
            // Keep only clicks within window
            entry.times = (entry.times || []).filter(t => now - t <= windowMs);
            entry.times.push(now);
            firstClickTracker.set(clickKey, entry);

            if (entry.times.length >= 3) {
                // SAFETY CHECK: Block cache reset if translation is in progress
                const shouldBlock = await shouldBlockCacheReset(clickKey, sourceFileId, config, targetLang);

                if (shouldBlock) {
                    log.debug(() => `[PurgeTrigger] 3 rapid loads detected but BLOCKED: Translation in progress for ${sourceFileId}/${targetLang} (user: ${config.__configHash})`);
                } else {
                    const rateLimitStatus = checkCacheResetRateLimit(config, { consume: false });

                    if (rateLimitStatus.blocked) {
                        log.warn(() => `[PurgeTrigger] BLOCKING 3-click reset: Rate limit reached for ${rateLimitStatus.cacheType} cache (${rateLimitStatus.limit}/${Math.round(CACHE_RESET_WINDOW_MS / 60000)}m) on ${sourceFileId}/${targetLang} (user: ${getConfigHashSafe(config)})`);
                    } else {
                        // Reset the counter immediately to avoid loops
                        firstClickTracker.set(clickKey, { times: [] });
                        const { runtimeKey } = generateCacheKeys(config, sourceFileId, targetLang);
                        const hadCache = await hasCachedTranslation(sourceFileId, targetLang, config);
                        const partial = (!hadCache) ? await readFromPartialCache(runtimeKey) : null;
                        const hasResetTarget = hadCache || (partial && typeof partial.content === 'string' && partial.content.length > 0);

                        if (!hasResetTarget) {
                            log.debug(() => `[PurgeTrigger] 3 rapid loads detected but no cached translation or partial found for ${sourceFileId}/${targetLang}. Skipping purge and rate-limit consumption.`);
                        } else {
                            // Consume rate-limit slot only when we actually purge
                            const consumeStatus = checkCacheResetRateLimit(config);
                            if (consumeStatus.blocked) {
                                log.warn(() => `[PurgeTrigger] BLOCKING 3-click reset: Rate limit reached for ${consumeStatus.cacheType} cache (${consumeStatus.limit}/${Math.round(CACHE_RESET_WINDOW_MS / 60000)}m) on ${sourceFileId}/${targetLang} (user: ${getConfigHashSafe(config)})`);
                            } else {
                                log.debug(() => `[PurgeTrigger] 3 rapid loads detected (<5s) for ${sourceFileId}/${targetLang}. Purging ${hadCache ? 'cached translation' : 'partial translation cache'} and re-triggering translation. Remaining resets this window: ${consumeStatus.remaining}`);
                                await purgeTranslationCache(sourceFileId, targetLang, config);
                            }
                        }
                    }
                }
            }
        } catch (e) {
            log.warn(() => '[PurgeTrigger] Click tracking error:', e.message);
        }

        // Prefetch Cooldown: Block libmpv prefetch requests during cooldown window after subtitle list is served
        // This is more targeted than burst detection - specifically for Stremio Community clients
        // NOTE: Use configStr (session token) here, NOT configKey (computed hash) - the cooldown is set
        // using the session token from req.params.config in the subtitle list response middleware
        const prefetchCooldown = checkStremioCommunityPrefetchCooldown(configStr, req);
        if (prefetchCooldown.blocked) {
            log.debug(() => `[Translation] Blocked by prefetch cooldown: ${prefetchCooldown.reason} for ${sourceFileId}`);
            const cooldownMsg = createLoadingSubtitle(config?.uiLanguage || 'en');
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="click_to_translate_${targetLang}.srt"`);
            setSubtitleCacheHeaders(res, 'loading');
            return res.send(cooldownMsg);
        }

        // Burst Detection: Detect when Stremio/libmpv prefetches ALL translation URLs at once
        // This prevents starting multiple expensive translations during prefetch
        const burstCheck = checkTranslationBurst(configKey, sourceFileId, targetLang);
        if (burstCheck.isBurst) {
            // This is part of a prefetch burst - return a "click to translate" message
            // The first request in the burst (firstSourceId) is allowed through
            log.debug(() => `[Translation] Burst detected: ${burstCheck.count} requests in ${TRANSLATION_BURST_WINDOW_MS}ms. Blocking prefetch for ${sourceFileId} (first was ${burstCheck.firstSourceId})`);
            const clickToTranslateMsg = createLoadingSubtitle(config?.uiLanguage || 'en');
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="click_to_translate_${targetLang}.srt"`);
            setSubtitleCacheHeaders(res, 'loading');
            return res.send(clickToTranslateMsg);
        }

        // Check if already in flight BEFORE logging to reduce confusion
        const isAlreadyInFlight = inFlightRequests.has(dedupKey);

        if (isAlreadyInFlight && waitForFullTranslation) {
            // Don't keep piling up long-held connections in mobile mode; the first request will deliver the final SRT
            // IMPORTANT: Use 200 (not 202) and NO Retry-After header to prevent Stremio/libmpv from
            // continuously polling. 202 + Retry-After causes exponential request spam when libmpv
            // prefetches all translation URLs simultaneously.
            log.debug(() => `[Translation] Mobile mode duplicate request for ${sourceFileId} to ${targetLang} - returning loading message (primary request in progress)`);
            setSubtitleCacheHeaders(res, 'loading');
            return res.send(t('server.errors.translationInProgress', {}, 'Translation already in progress; waiting on primary request.'));
        } else if (isAlreadyInFlight) {
            log.debug(() => `[Translation] Duplicate request detected for ${sourceFileId} to ${targetLang} - checking for partial results`);

            // Generate cache keys using shared utility (single source of truth for cache key scoping)
            const { cacheKey, runtimeKey, bypass, bypassEnabled, userHash, allowPermanent } = generateCacheKeys(config, sourceFileId, targetLang);

            // For duplicate requests, check partial cache FIRST (in-flight translations)
            // Partials are saved under runtimeKey (see performTranslation), so read with the same key
            const partialCached = await readFromPartialCache(runtimeKey);
            if (partialCached && typeof partialCached.content === 'string' && partialCached.content.length > 0) {
                log.debug(() => `[Translation] Found in-flight partial in partial cache for ${sourceFileId} (${partialCached.content.length} chars)`);
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="translating_${targetLang}.srt"`);
                setSubtitleCacheHeaders(res, 'loading');
                return res.send(partialCached.content);
            }

            // Then check bypass cache for user-controlled bypass cache behavior
            const { StorageAdapter } = require('./src/storage');
            const { getStorageAdapter } = require('./src/storage/StorageFactory');
            const adapter = await getStorageAdapter();
            if (bypass && bypassEnabled) {
                const bypassCached = await adapter.get(cacheKey, StorageAdapter.CACHE_TYPES.BYPASS);
                if (bypassCached && bypassCached.configHash && bypassCached.configHash !== userHash) {
                    log.warn(() => `[Translation] Bypass cache configHash mismatch for duplicate request key=${cacheKey}`);
                } else if (bypassCached && !bypassCached.configHash) {
                    log.warn(() => `[Translation] Bypass cache entry missing configHash for duplicate request key=${cacheKey}`);
                }
                if (bypassCached && bypassCached.configHash && bypassCached.configHash === userHash) {
                    if (bypassCached.isError === true) {
                        log.debug(() => `[Translation] Found bypass cached error for ${sourceFileId}`);
                        const errSrt = createTranslationErrorSubtitle(
                            bypassCached.errorType || 'other',
                            bypassCached.errorMessage || 'Translation failed',
                            config?.uiLanguage || 'en',
                            bypassCached.errorProvider || null
                        );
                        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                        res.setHeader('Content-Disposition', `attachment; filename="translated_${targetLang}.srt"`);
                        setSubtitleCacheHeaders(res, 'final');
                        return res.send(errSrt);
                    }
                    if (typeof bypassCached.content === 'string' && bypassCached.content.length > 0) {
                        log.debug(() => `[Translation] Found bypass cache result for ${sourceFileId} (${bypassCached.content.length} chars)`);
                        const { isAss: bIsAss, isSsa: bIsSsa } = detectSubtitlePayloadFormat(bypassCached.content);
                        const bExt = bIsSsa ? 'ssa' : (bIsAss ? 'ass' : 'srt');
                        res.setHeader('Content-Type', (bIsAss || bIsSsa) ? 'text/x-ssa; charset=utf-8' : 'text/plain; charset=utf-8');
                        res.setHeader('Content-Disposition', `attachment; filename="translated_${targetLang}.${bExt}"`);
                        setSubtitleCacheHeaders(res, 'final');
                        return res.send(bypassCached.content);
                    }
                }
            }

            if (!bypassEnabled && allowPermanent && process.env.ENABLE_PERMANENT_TRANSLATIONS !== 'false') {
                const permanentKey = `t2s__${cacheKey}`;
                const permanentCached = await adapter.get(permanentKey, StorageAdapter.CACHE_TYPES.TRANSLATION);
                if (permanentCached) {
                    if (permanentCached.isError === true) {
                        log.debug(() => `[Translation] Found permanent cached error for ${sourceFileId}`);
                        const errSrt = createTranslationErrorSubtitle(
                            permanentCached.errorType || 'other',
                            permanentCached.errorMessage || 'Translation failed',
                            config?.uiLanguage || 'en',
                            permanentCached.errorProvider || null
                        );
                        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                        res.setHeader('Content-Disposition', `attachment; filename="translated_${targetLang}.srt"`);
                        setSubtitleCacheHeaders(res, 'final');
                        return res.send(errSrt);
                    }
                    if (typeof permanentCached.content === 'string' && permanentCached.content.length > 0) {
                        log.debug(() => `[Translation] Found permanent cache result for ${sourceFileId} (${permanentCached.content.length} chars)`);
                        const { isAss: pIsAss, isSsa: pIsSsa } = detectSubtitlePayloadFormat(permanentCached.content);
                        const pExt = pIsSsa ? 'ssa' : (pIsAss ? 'ass' : 'srt');
                        res.setHeader('Content-Type', (pIsAss || pIsSsa) ? 'text/x-ssa; charset=utf-8' : 'text/plain; charset=utf-8');
                        res.setHeader('Content-Disposition', `attachment; filename="translated_${targetLang}.${pExt}"`);
                        setSubtitleCacheHeaders(res, 'final');
                        return res.send(permanentCached.content);
                    }
                }
            }

            // No partial yet, serve loading message
            log.debug(() => `[Translation] No partial found yet, serving loading message to duplicate request for ${sourceFileId}`);
            const loadingMsg = createLoadingSubtitle(config?.uiLanguage || 'en');
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="translating_${targetLang}.srt"`);
            setSubtitleCacheHeaders(res, 'loading');
            return res.send(loadingMsg);
        } else {
            log.debug(() => `[Translation] New request to translate ${sourceFileId} to ${targetLang}`);
        }

        // Deduplicate translation requests - handles the first request
        const subtitleContent = await deduplicate(dedupKey, () =>
            handleTranslation(sourceFileId, targetLang, config, {
                waitForFullTranslation,
                sourceFileId,
                targetLanguage: targetLang,
                filename: req.query.filename || req.query.file || req.query.name || '',
                videoId: req.query.videoId || req.query.id || '',
                sourceLanguage: req.query.sourceLanguage || req.query.lang || (config.sourceLanguages?.[0] || 'auto'),
                from: 'addon'
            })
        );

        // Validate content before processing
        if (!subtitleContent || typeof subtitleContent !== 'string') {
            log.error(() => `[Translation] Invalid subtitle content returned: ${typeof subtitleContent}, value: ${subtitleContent}`);
            return res.status(500).send(t('server.errors.translationInvalidContent', {}, 'Translation returned invalid content'));
        }

        // Distinguish placeholder loading SRT from in-progress partial SRT.
        // Partial payloads include a "TRANSLATION IN PROGRESS" tail cue, so that marker
        // alone is not sufficient to classify as loading.
        const cueCount = (subtitleContent.match(/(?:^|\n)\d+\n\d{2}:\d{2}:\d{2},\d{3}\s+-->/g) || []).length;
        const hasProgressTail = subtitleContent.includes('TRANSLATION IN PROGRESS');
        const isLoadingMessage = subtitleContent.includes('Please wait while the selected subtitle is being translated') ||
            subtitleContent.includes('Translation is happening in the background') ||
            subtitleContent.includes('Click this subtitle again to confirm translation') ||
            (hasProgressTail && cueCount <= 1);
        const isPartialMessage = hasProgressTail && cueCount > 1;
        log.debug(() => `[Translation] Serving ${isLoadingMessage ? 'loading message' : (isPartialMessage ? 'partial content' : 'translated content')} for ${sourceFileId} (was duplicate: ${isAlreadyInFlight})`);
        log.debug(() => `[Translation] Content length: ${subtitleContent.length} characters, first 200 chars: ${subtitleContent.substring(0, 200)}`);

        // Detect payload format for correct headers (ASS/SSA or SRT)
        const { isAss: tIsAss, isSsa: tIsSsa } = detectSubtitlePayloadFormat(subtitleContent);
        const tExt = tIsSsa ? 'ssa' : (tIsAss ? 'ass' : 'srt');
        res.setHeader('Content-Type', (tIsAss || tIsSsa) ? 'text/x-ssa; charset=utf-8' : 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${(isLoadingMessage || isPartialMessage) ? 'translating' : 'translated'}_${targetLang}.${tExt}"`);

        // Disable caching for loading/partial messages so Stremio can poll for updates
        if (isLoadingMessage || isPartialMessage) {
            setSubtitleCacheHeaders(res, 'loading');
            log.debug(() => `[Translation] Set no-store headers for ${isPartialMessage ? 'partial message' : 'loading message'}`);
        } else {
            // Final translations are no-store to avoid stale subtitle reuse in clients.
            setSubtitleCacheHeaders(res, 'final');
            log.debug(() => `[Translation] Set no-store headers for final translation`);
        }

        res.send(maybeConvertToSRT(subtitleContent, config));
        log.debug(() => `[Translation] Response sent successfully for ${sourceFileId}`);

    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Translation]', t)) return;
        log.error(() => ['[Translation] Error:', error]);
        res.status(500).send(t('server.errors.translationFailed', { reason: error.message }, `Translation failed: ${error.message}`));
    }
});

// Custom route: Learn Mode (dual-language VTT)
app.get('/addon/:config/learn/:sourceFileId/:targetLang', normalizeSubtitleFormatParams, searchLimiter, validateRequest(translationParamsSchema, 'params'), async (req, res) => {
    try {
        // Defense-in-depth: Prevent caching of learn-mode responses
        setNoStore(res);
        let t = res.locals?.t || getTranslatorFromRequest(req, res);

        const { config: configStr, sourceFileId, targetLang } = req.params;
        const baseConfig = await resolveConfigGuarded(configStr, req, res, '[Learn] config', t);
        if (!baseConfig) return;
        if (isInvalidSessionConfig(baseConfig)) {
            log.warn(() => `[Learn] Blocked request due to invalid session token ${redactToken(configStr)}`);
            const errorSubtitle = createSessionTokenErrorSubtitle(null, null, baseConfig?.uiLanguage || 'en');
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename=\"session-token-not-found.srt\"');
            setSubtitleCacheHeaders(res, 'loading');
            return res.status(401).send(errorSubtitle);
        }
        t = getTranslatorFromRequest(req, res, baseConfig);
        const configKey = ensureConfigHash(baseConfig, configStr);

        // Force bypass cache for Learn Mode translations only (does not affect normal translations)
        // NOTE: normalizeConfig() disables bypassCacheConfig when bypassCache is false, so we must
        // explicitly re-enable both bypassCacheConfig/tempCache when forcing bypass for Learn mode.
        const config = {
            ...baseConfig,
            bypassCache: true,
            bypassCacheConfig: {
                ...(baseConfig.bypassCacheConfig || {}),
                enabled: true
            },
            tempCache: {
                ...(baseConfig.tempCache || baseConfig.bypassCacheConfig || {}),
                enabled: true
            }
        };
        const videoId = req.query?.videoId || req.query?.id || config.videoId || config.lastStream?.videoId || '';

        const { cacheKey, runtimeKey } = generateCacheKeys(config, sourceFileId, targetLang);

        // Unusual purge: if same Learn subtitle is loaded 3 times in < 5s, purge cache and retrigger
        try {
            const clickKey = `learn-click:${configKey}:${sourceFileId}:${targetLang}`;
            const now = Date.now();
            const windowMs = 5_000; // 5 seconds
            const entry = firstClickTracker.get(clickKey) || { times: [] };
            // Keep only clicks within window
            entry.times = (entry.times || []).filter(t => now - t <= windowMs);
            entry.times.push(now);
            firstClickTracker.set(clickKey, entry);

            if (entry.times.length >= 3) {
                // SAFETY CHECK: Block cache reset if translation is in progress
                const shouldBlock = await shouldBlockCacheReset(clickKey, sourceFileId, config, targetLang);

                if (shouldBlock) {
                    log.debug(() => `[LearnPurgeTrigger] 3 rapid loads detected but BLOCKED: Translation in progress for ${sourceFileId}/${targetLang} (user: ${config.__configHash})`);
                } else {
                    const rateLimitStatus = checkCacheResetRateLimit(config, { consume: false });

                    if (rateLimitStatus.blocked) {
                        log.warn(() => `[LearnPurgeTrigger] BLOCKING 3-click reset: Rate limit reached for ${rateLimitStatus.cacheType} cache (${rateLimitStatus.limit}/${Math.round(CACHE_RESET_WINDOW_MS / 60000)}m) on ${sourceFileId}/${targetLang} (user: ${getConfigHashSafe(config)})`);
                    } else {
                        // Reset the counter immediately to avoid loops
                        firstClickTracker.set(clickKey, { times: [] });
                        const partialKey = runtimeKey || cacheKey;
                        const hadCache = await hasCachedTranslation(sourceFileId, targetLang, config);
                        const partial = (!hadCache) ? await readFromPartialCache(partialKey) : null;
                        const hasResetTarget = hadCache || (partial && typeof partial.content === 'string' && partial.content.length > 0);

                        if (!hasResetTarget) {
                            log.debug(() => `[LearnPurgeTrigger] 3 rapid loads detected but no cached translation or partial found for ${sourceFileId}/${targetLang}. Skipping purge and rate-limit consumption.`);
                        } else {
                            const consumeStatus = checkCacheResetRateLimit(config);
                            if (consumeStatus.blocked) {
                                log.warn(() => `[LearnPurgeTrigger] BLOCKING 3-click reset: Rate limit reached for ${consumeStatus.cacheType} cache (${consumeStatus.limit}/${Math.round(CACHE_RESET_WINDOW_MS / 60000)}m) on ${sourceFileId}/${targetLang} (user: ${getConfigHashSafe(config)})`);
                            } else {
                                log.debug(() => `[LearnPurgeTrigger] 3 rapid loads detected (<5s) for ${sourceFileId}/${targetLang}. Purging ${hadCache ? 'cached translation' : 'partial translation cache'} and re-triggering translation. Remaining resets this window: ${consumeStatus.remaining}`);
                                await purgeTranslationCache(sourceFileId, targetLang, config);
                            }
                        }
                    }
                }
            }
        } catch (e) {
            log.warn(() => '[LearnPurgeTrigger] Click tracking error:', e.message);
        }

        // Always obtain source content
        let sourceContent = await getDownloadCached(sourceFileId, 'translate_source');
        if (!sourceContent) {
            sourceContent = await handleSubtitleDownload(sourceFileId, 'und', config);
            saveDownloadCached(sourceFileId, sourceContent, 'translate_source');
        }

        // Normalize source to SRT for pairing (handles VTT, ASS/SSA, and other formats)
        sourceContent = ensureSRTForTranslation(sourceContent, '[Learn Mode]');

        // If we have partial translation, serve partial VTT immediately
        // Partials are saved under runtimeKey (see performTranslation), so read with the same key
        const partial = await readFromPartialCache(runtimeKey);
        if (partial && partial.content) {
            const vtt = srtPairToWebVTT(sourceContent, partial.content, (config.learnOrder || 'source-top'), (config.learnPlacement || 'stacked'), { learnItalic: config.learnItalic, learnItalicTarget: config.learnItalicTarget });
            const output = maybeConvertToSRT(vtt, config);
            const isSrt = config.forceSRTOutput;
            res.setHeader('Content-Type', isSrt ? 'text/plain; charset=utf-8' : 'text/vtt; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="learn_${targetLang}.${isSrt ? 'srt' : 'vtt'}"`);
            setSubtitleCacheHeaders(res, 'loading');
            return res.send(output);
        }

        // If we already have cached full translation, fetch it quickly via translation handler
        const hasCache = await hasCachedTranslation(sourceFileId, targetLang, config);
        if (hasCache) {
            const translatedSrt = await handleTranslation(sourceFileId, targetLang, config, {
                filename: sourceContent ? `learn_${targetLang}.srt` : 'unknown',
                videoId: videoId || 'unknown',
                sourceLanguage: 'und',
                from: 'learn'
            });
            // handleTranslation may return ASS content when ASS passthrough is enabled
            // srtPairToWebVTT requires SRT input, so ensure conversion
            const translatedSrtForPairing = ensureSRTForTranslation(translatedSrt, '[Learn Mode]');
            const vtt = srtPairToWebVTT(sourceContent, translatedSrtForPairing, (config.learnOrder || 'source-top'), (config.learnPlacement || 'stacked'), { learnItalic: config.learnItalic, learnItalicTarget: config.learnItalicTarget });
            const output = maybeConvertToSRT(vtt, config);
            const isSrt = config.forceSRTOutput;
            res.setHeader('Content-Type', isSrt ? 'text/plain; charset=utf-8' : 'text/vtt; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="learn_${targetLang}.${isSrt ? 'srt' : 'vtt'}"`);
            return res.send(output);
        }

        // Start translation in background and serve a loading VTT (source on top, status on bottom)
        handleTranslation(sourceFileId, targetLang, config, {
            filename: sourceContent ? `learn_${targetLang}.srt` : 'unknown',
            videoId: videoId || 'unknown',
            sourceLanguage: 'und',
            from: 'learn'
        }).catch(() => { });

        const loadingSrt = createLoadingSubtitle(config?.uiLanguage || baseConfig?.uiLanguage || 'en');
        const vtt = srtPairToWebVTT(sourceContent, loadingSrt, (config.learnOrder || 'source-top'), (config.learnPlacement || 'stacked'), { learnItalic: config.learnItalic, learnItalicTarget: config.learnItalicTarget });
        const output = maybeConvertToSRT(vtt, config);
        const isSrt = config.forceSRTOutput;
        res.setHeader('Content-Type', isSrt ? 'text/plain; charset=utf-8' : 'text/vtt; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="learn_${targetLang}.${isSrt ? 'srt' : 'vtt'}"`);
        return res.send(output);

    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Learn]', t)) return;
        log.error(() => ['[Learn] Error:', error]);
        res.status(500).send(t('server.errors.learnFailed', {}, 'Failed to build learning subtitles'));
    }
});

// Register file upload page routes (redirect + standalone page)
registerFileUploadRoutes(app, { log, resolveConfigGuarded, computeConfigHash, setNoStore, respondStorageUnavailable });

// Custom route: Sub Toolbox homepage (BEFORE SDK router)
app.get('/addon/:config/sub-toolbox/:videoId', async (req, res) => {
    try {
        // Ensure the redirect carrying user token never caches
        setNoStore(res);
        const t = res.locals?.t || getTranslatorFromRequest(req, res);

        const { config: configStr, videoId } = req.params;
        const { filename } = req.query;
        // Validate config to ensure token is valid before redirect
        const resolvedConfig = await resolveConfigGuarded(configStr, req, res, '[Sub Toolbox] config', t);
        if (!resolvedConfig) return;
        log.debug(() => `[Sub Toolbox] Request for video ${videoId}, filename: ${filename || 'n/a'}`);
        res.redirect(302, `/sub-toolbox?config=${encodeURIComponent(configStr)}&videoId=${encodeURIComponent(videoId)}&filename=${encodeURIComponent(filename || '')}`);
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Sub Toolbox]', t)) return;
        log.error(() => '[Sub Toolbox] Error:', error);
        res.status(500).send(t('server.errors.subToolboxLoadFailed', {}, 'Failed to load Sub Toolbox'));
    }
});

// Sub Toolbox standalone page (HTML)
app.get('/sub-toolbox', async (req, res) => {
    try {
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { config: configStr, videoId, filename } = req.query;

        if (!configStr || !videoId) {
            return res.status(400).send(t('server.errors.missingConfigOrVideo', {}, 'Missing config or videoId'));
        }

        const config = await resolveConfigGuarded(configStr, req, res, '[Sub Toolbox Page] config', t);
        if (!config) return;
        t = getTranslatorFromRequest(req, res, config);
        ensureConfigHash(config, configStr);

        log.debug(() => `[Sub Toolbox Page] Loading toolbox for video ${videoId}`);

        // Defense-in-depth: prevent caching of page embedding user config/videoId
        setNoStore(res);
        const html = generateSubToolboxPage(configStr, videoId, filename, config);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Sub Toolbox Page]', t)) return;
        log.error(() => '[Sub Toolbox Page] Error:', error);
        res.status(500).send(t('server.errors.subToolboxPageFailed', {}, 'Failed to load Sub Toolbox page'));
    }
});

// ── SMDB (SubMaker Database) Routes ─────────────────────────────────────────
// Redirect from Stremio addon path to standalone SMDB page
app.get('/addon/:config/smdb/:videoId', async (req, res) => {
    try {
        setNoStore(res);
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { config: configStr, videoId } = req.params;
        const { filename } = req.query;
        const resolvedConfig = await resolveConfigGuarded(configStr, req, res, '[SMDB] config', t);
        if (!resolvedConfig) return;
        res.redirect(302, `/smdb?config=${encodeURIComponent(configStr)}&videoId=${encodeURIComponent(videoId)}&filename=${encodeURIComponent(filename || '')}`);
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[SMDB]', t)) return;
        log.error(() => '[SMDB] Redirect error:', error);
        res.status(500).send('Failed to load SMDB');
    }
});

// SMDB standalone page (HTML)
app.get('/smdb', async (req, res) => {
    try {
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { config: configStr, videoId, filename } = req.query;

        if (!configStr) {
            return res.status(400).send(t('server.errors.missingConfig', {}, 'Missing config'));
        }

        const config = await resolveConfigGuarded(configStr, req, res, '[SMDB Page] config', t);
        if (!config) return;
        t = getTranslatorFromRequest(req, res, config);
        ensureConfigHash(config, configStr);

        setNoStore(res);
        const html = await generateSmdbPage(configStr, videoId || '', filename || '', config);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[SMDB Page]', t)) return;
        log.error(() => '[SMDB Page] Error:', error);
        res.status(500).send(t('server.errors.smdbPageFailed', {}, 'Failed to load SMDB page'));
    }
});

// SMDB API: List available subtitles for a video hash
app.get('/api/smdb/list', async (req, res) => {
    try {
        setNoStore(res);
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { videoHash, config: configStr } = req.query;

        if (!videoHash || !configStr) {
            return res.status(400).json({ error: t('server.errors.missingFields', {}, 'Missing videoHash or config') });
        }

        const resolvedConfig = await resolveConfigGuarded(configStr, req, res, '[SMDB API List] config', t);
        if (!resolvedConfig) return;

        // Input sanitization
        const safeVideoHash = (typeof videoHash === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(videoHash)) ? videoHash : null;
        if (!safeVideoHash) {
            return res.status(400).json({ error: t('server.errors.invalidSmdbParams', {}, 'Invalid SMDB parameters') });
        }

        const subtitles = await smdbCache.listSubtitles(safeVideoHash);
        const enriched = subtitles.map(sub => ({
            ...sub,
            languageName: getLanguageName(sub.languageCode) || sub.languageCode
        }));

        res.json({ videoHash: safeVideoHash, subtitles: enriched });
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[SMDB API List]', t)) return;
        log.error(() => ['[SMDB API List] Error:', error.message]);
        res.status(500).json({ error: 'Failed to list subtitles' });
    }
});

// SMDB API: Download subtitle content
app.get('/api/smdb/download', async (req, res) => {
    try {
        setNoStore(res);
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { videoHash, lang, config: configStr } = req.query;

        if (!videoHash || !lang || !configStr) {
            return res.status(400).json({ error: t('server.errors.missingFields', {}, 'Missing videoHash, lang, or config') });
        }

        const resolvedConfig = await resolveConfigGuarded(configStr, req, res, '[SMDB API Download] config', t);
        if (!resolvedConfig) return;

        // Input sanitization
        const safeVideoHash = (typeof videoHash === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(videoHash)) ? videoHash : null;
        const safeLang = (typeof lang === 'string' && /^[a-zA-Z0-9_-]{1,24}$/.test(lang)) ? lang.toLowerCase() : null;
        if (!safeVideoHash || !safeLang) {
            return res.status(400).json({ error: t('server.errors.invalidSmdbParams', {}, 'Invalid SMDB parameters') });
        }

        const subtitle = await smdbCache.getSubtitle(safeVideoHash, safeLang);
        if (!subtitle) {
            return res.status(404).json({ error: t('server.errors.smdbSubtitleNotFound', {}, 'Subtitle not found') });
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="smdb_${safeLang}.srt"`);
        res.send(subtitle.content);
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[SMDB API Download]', t)) return;
        log.error(() => ['[SMDB API Download] Error:', error.message]);
        res.status(500).json({ error: 'Failed to download subtitle' });
    }
});

// SMDB API: Upload subtitle
app.post('/api/smdb/upload', userDataWriteLimiter, async (req, res) => {
    try {
        setNoStore(res);
        let t = res.locals?.t || getTranslatorFromRequest(req, res, req.body);
        const { config: configStr } = req.query;

        if (!configStr) {
            return res.status(400).json({ error: t('server.errors.missingFields', {}, 'Missing config') });
        }

        const resolvedConfig = await resolveConfigGuarded(configStr, req, res, '[SMDB API Upload] config', t);
        if (!resolvedConfig) return;

        // Reject writes when session token is missing/invalid
        if (resolvedConfig.__sessionTokenError === true) {
            log.warn(() => '[SMDB API Upload] Rejected write due to invalid/missing session token');
            t = getTranslatorFromRequest(req, res, resolvedConfig);
            return res.status(401).json({ error: t('server.errors.invalidSessionToken', {}, 'Invalid or expired session token') });
        }
        t = getTranslatorFromRequest(req, res, resolvedConfig);
        const configHash = ensureConfigHash(resolvedConfig, configStr);

        const { videoHash, languageCode, content, forceOverride } = req.body || {};

        if (!videoHash || !languageCode || !content) {
            return res.status(400).json({ error: t('server.errors.missingFields', {}, 'Missing videoHash, languageCode, or content') });
        }

        // Input sanitization
        const safeVideoHash = (typeof videoHash === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(videoHash)) ? videoHash : null;
        const safeLangCode = (typeof languageCode === 'string' && /^[a-zA-Z0-9_-]{1,24}$/.test(languageCode)) ? languageCode.toLowerCase() : null;
        if (!safeVideoHash || !safeLangCode) {
            return res.status(400).json({ error: t('server.errors.invalidSmdbParams', {}, 'Invalid SMDB parameters') });
        }

        // Content must be a string
        if (typeof content !== 'string') {
            return res.status(400).json({ error: t('server.errors.missingFields', {}, 'Invalid subtitle content') });
        }

        // Content size guard (max 2MB per subtitle)
        if (content.length > 2 * 1024 * 1024) {
            return res.status(413).json({ error: t('server.errors.embeddedTooLarge', {}, 'Subtitle content too large (max 2MB)') });
        }

        // Check if subtitle already exists
        const existing = await smdbCache.exists(safeVideoHash, safeLangCode);
        if (existing && !forceOverride) {
            const limit = smdbCache.checkOverrideLimit(configHash);
            return res.status(409).json({
                error: t('server.errors.smdbSubtitleExists', {}, 'Subtitle already exists for this language'),
                exists: true,
                allowed: limit.allowed,
                remaining: limit.remaining
            });
        }

        const result = await smdbCache.saveSubtitle(safeVideoHash, safeLangCode, content, configHash);

        if (result.success) {
            res.json({ success: true, isOverride: result.isOverride });
        } else if (result.error && result.error.includes('Override limit')) {
            res.status(429).json({ error: result.error, remaining: result.remaining || 0 });
        } else {
            res.status(500).json({ error: result.error || 'Upload failed' });
        }
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[SMDB API Upload]', t)) return;
        log.error(() => ['[SMDB API Upload] Error:', error.message]);
        res.status(500).json({ error: 'Failed to upload subtitle' });
    }
});

// SMDB API: Resolve associated hashes (stremioHash ↔ derivedHash mapping)
app.get('/api/smdb/resolve-hashes', async (req, res) => {
    try {
        setNoStore(res);
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { videoHash, config: configStr } = req.query;

        if (!videoHash || !configStr) {
            return res.status(400).json({ error: t('server.errors.missingFields', {}, 'Missing videoHash or config') });
        }

        const resolvedConfig = await resolveConfigGuarded(configStr, req, res, '[SMDB API Resolve] config', t);
        if (!resolvedConfig) return;

        // Input sanitization
        const safeVideoHash = (typeof videoHash === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(videoHash)) ? videoHash : null;
        if (!safeVideoHash) {
            return res.status(400).json({ error: t('server.errors.invalidSmdbParams', {}, 'Invalid SMDB parameters') });
        }

        const allHashes = await smdbCache.getAssociatedHashes(safeVideoHash);
        res.json({ hashes: allHashes });
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[SMDB API Resolve]', t)) return;
        log.error(() => ['[SMDB API Resolve] Error:', error.message]);
        res.status(500).json({ error: 'Failed to resolve hashes' });
    }
});

// SMDB API: Translate an existing SMDB subtitle to a target language and save back
app.post('/api/smdb/translate', userDataWriteLimiter, async (req, res) => {
    try {
        setNoStore(res);
        let t = res.locals?.t || getTranslatorFromRequest(req, res, req.body);
        const { config: configStr } = req.query;

        if (!configStr) {
            return res.status(400).json({ error: t('server.errors.missingFields', {}, 'Missing config') });
        }

        const resolvedConfig = await resolveConfigGuarded(configStr, req, res, '[SMDB API Translate] config', t);
        if (!resolvedConfig) return;

        // Reject writes when session token is missing/invalid
        if (resolvedConfig.__sessionTokenError === true) {
            log.warn(() => '[SMDB API Translate] Rejected write due to invalid/missing session token');
            t = getTranslatorFromRequest(req, res, resolvedConfig);
            return res.status(401).json({ error: t('server.errors.invalidSessionToken', {}, 'Invalid or expired session token') });
        }
        t = getTranslatorFromRequest(req, res, resolvedConfig);
        const configHash = ensureConfigHash(resolvedConfig, configStr);

        const { videoHash, sourceLangCode, targetLangCode, forceOverride } = req.body || {};

        if (!videoHash || !sourceLangCode || !targetLangCode) {
            return res.status(400).json({ error: t('server.errors.missingFields', {}, 'Missing videoHash, sourceLangCode, or targetLangCode') });
        }

        // Input sanitization
        const safeVideoHash = (typeof videoHash === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(videoHash)) ? videoHash : null;
        const safeSourceLang = (typeof sourceLangCode === 'string' && /^[a-zA-Z0-9_-]{1,24}$/.test(sourceLangCode)) ? sourceLangCode.toLowerCase() : null;
        const safeTargetLang = (typeof targetLangCode === 'string' && /^[a-zA-Z0-9_-]{1,24}$/.test(targetLangCode)) ? targetLangCode.toLowerCase() : null;
        if (!safeVideoHash || !safeSourceLang || !safeTargetLang) {
            return res.status(400).json({ error: t('server.errors.invalidSmdbParams', {}, 'Invalid SMDB parameters') });
        }

        if (safeSourceLang === safeTargetLang) {
            return res.status(400).json({ error: t('server.errors.missingFields', {}, 'Source and target languages must be different') });
        }

        log.info(() => `[SMDB Translate] Request: ${safeSourceLang} → ${safeTargetLang} for hash ${safeVideoHash.slice(0, 16)}...`);

        // 1. Fetch the source subtitle from SMDB
        const sourceEntry = await smdbCache.getSubtitle(safeVideoHash, safeSourceLang);
        if (!sourceEntry || !sourceEntry.content) {
            return res.status(404).json({ error: t('server.errors.missingFields', {}, 'Source subtitle not found in SMDB') });
        }

        // 2. Check if target language already exists (override check)
        const targetExists = await smdbCache.exists(safeVideoHash, safeTargetLang);
        if (targetExists && !forceOverride) {
            const limit = smdbCache.checkOverrideLimit(configHash);
            return res.status(409).json({
                error: t('server.errors.smdbSubtitleExists', {}, 'Subtitle already exists for target language'),
                exists: true,
                allowed: limit.allowed,
                remaining: limit.remaining
            });
        }

        // 3. Normalize source content to SRT
        let sourceContent = ensureSRTForTranslation(sourceEntry.content, '[SMDB Translate]');

        // 4. Create translation provider and engine (same as Stremio "Make" workflow)
        const { provider, providerName, model, fallbackProviderName } = await createTranslationProvider(resolvedConfig);
        const effectiveModel = model || getEffectiveGeminiModel(resolvedConfig);

        const keyRotationConfig = (resolvedConfig.geminiKeyRotationEnabled === true && providerName === 'gemini') ? {
            enabled: true,
            mode: resolvedConfig.geminiKeyRotationMode || 'per-batch',
            keys: Array.isArray(resolvedConfig.geminiApiKeys) ? resolvedConfig.geminiApiKeys.filter(k => typeof k === 'string' && k.trim()) : [],
            advancedSettings: resolvedConfig.advancedSettings || {}
        } : null;

        const translationEngine = new TranslationEngine(
            provider,
            effectiveModel,
            resolvedConfig.advancedSettings || {},
            {
                singleBatchMode: resolvedConfig.singleBatchMode === true,
                providerName,
                fallbackProviderName,
                keyRotationConfig
            }
        );

        // 5. Get target language name for translation context
        const targetLangName = getLanguageName(safeTargetLang) || safeTargetLang;
        log.debug(() => `[SMDB Translate] Translating ${sourceContent.length} chars to ${targetLangName} using ${providerName}/${effectiveModel}`);

        // 6. Perform translation
        const translatedContent = await translationEngine.translateSubtitle(
            sourceContent,
            targetLangName,
            null, // customPrompt
            null  // onProgress (synchronous, no streaming needed)
        );

        if (!translatedContent || typeof translatedContent !== 'string' || translatedContent.length < 10) {
            log.error(() => `[SMDB Translate] Translation returned empty/invalid content`);
            return res.status(500).json({ error: t('server.errors.translationFailed', {}, 'Translation returned invalid content') });
        }

        log.info(() => `[SMDB Translate] Translation complete: ${translatedContent.length} chars`);

        // 7. Save translated subtitle to SMDB
        const result = await smdbCache.saveSubtitle(safeVideoHash, safeTargetLang, translatedContent, configHash);

        if (result.success) {
            log.info(() => `[SMDB Translate] Saved ${safeSourceLang} → ${safeTargetLang} for ${safeVideoHash.slice(0, 16)}... (override: ${result.isOverride})`);
            res.json({ success: true, isOverride: result.isOverride });
        } else if (result.error && result.error.includes('Override limit')) {
            res.status(429).json({ error: result.error, remaining: result.remaining || 0 });
        } else {
            res.status(500).json({ error: result.error || t('server.errors.translationFailed', {}, 'Failed to save translated subtitle') });
        }
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[SMDB API Translate]', t)) return;
        log.error(() => ['[SMDB API Translate] Error:', error.message]);
        res.status(500).json({ error: t('server.errors.translationFailed', {}, 'Translation failed') });
    }
});

// SMDB: Serve subtitle SRT to Stremio player (addon-prefixed route for {{ADDON_URL}} expansion)
app.get('/addon/:config/smdb/:videoHash/:langCode.srt', async (req, res) => {
    try {
        const { config: configStr, videoHash, langCode } = req.params;
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const config = await resolveConfigGuarded(configStr, req, res, '[SMDB SRT Serve] config', t);
        if (!config) return;
        if (config.__sessionTokenError === true) {
            log.warn(() => '[SMDB SRT Serve] Rejected due to invalid/missing session token');
            t = getTranslatorFromRequest(req, res, config);
            setSubtitleCacheHeaders(res, 'loading');
            return res.status(401).send(t('server.errors.invalidSessionToken', {}, 'Invalid or expired session token'));
        }
        t = getTranslatorFromRequest(req, res, config);

        // Input sanitization (match xsync/xembedded patterns)
        const safeVideoHash = (typeof videoHash === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(videoHash)) ? videoHash : null;
        const safeLangCode = (typeof langCode === 'string' && /^[a-zA-Z0-9_-]{1,24}$/.test(langCode)) ? langCode.toLowerCase() : null;

        if (!safeVideoHash || !safeLangCode) {
            return res.status(400).send(t('server.errors.invalidSmdbParams', {}, 'Invalid SMDB subtitle parameters'));
        }

        log.debug(() => `[SMDB SRT Serve] Request for ${safeVideoHash}/${safeLangCode}`);

        const subtitle = await smdbCache.getSubtitle(safeVideoHash, safeLangCode);
        if (!subtitle) {
            return res.status(404).send(t('server.errors.smdbSubtitleNotFound', {}, 'SMDB subtitle not found'));
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="smdb_${safeLangCode}.srt"`);
        res.setHeader('Access-Control-Allow-Origin', '*');
        setSubtitleCacheHeaders(res, 'final');
        res.send(maybeConvertToSRT(subtitle.content, config));
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[SMDB SRT Serve]', t)) return;
        log.error(() => ['[SMDB SRT Serve] Error:', error.message]);
        res.status(500).send(t('server.errors.smdbServeFailed', {}, 'Failed to serve SMDB subtitle'));
    }
});

// SMDB: Serve subtitle SRT (bare route fallback)
app.get('/smdb/:videoHash/:langCode.srt', async (req, res) => {
    try {
        const { videoHash, langCode } = req.params;
        if (!videoHash || !langCode) {
            return res.status(400).send('Missing videoHash or langCode');
        }

        const subtitle = await smdbCache.getSubtitle(videoHash, langCode);
        if (!subtitle) {
            return res.status(404).send('Subtitle not found');
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(subtitle.content);
    } catch (error) {
        log.error(() => ['[SMDB SRT Serve] Error:', error.message]);
        res.status(500).send('Failed to serve subtitle');
    }
});

// Translation History Page
function buildHistoryContentEndpoint(configStr, videoId, filename) {
    const params = new URLSearchParams({ config: String(configStr || '') });
    if (videoId) params.set('videoId', String(videoId));
    if (filename) params.set('filename', String(filename));
    return `/api/sub-history-content?${params.toString()}`;
}

async function loadHistoryEntriesForPage(config) {
    const historyUserHash = resolveHistoryUserHash(config);
    const stableHistoryUserHash = (typeof config.__historyUserHash === 'string' && config.__historyUserHash.trim())
        ? config.__historyUserHash.trim()
        : '';

    let history = await getHistoryForUser(historyUserHash, {
        allowSlowScan: !(stableHistoryUserHash && historyUserHash === stableHistoryUserHash)
    });

    if (
        history.length === 0
        && stableHistoryUserHash
        && historyUserHash === stableHistoryUserHash
        && typeof config.__configHash === 'string'
        && config.__configHash.trim()
        && config.__configHash.trim() !== stableHistoryUserHash
    ) {
        const legacyHistoryUserHash = config.__configHash.trim();
        const legacyHistory = await getHistoryForUser(legacyHistoryUserHash, { allowSlowScan: false });
        if (legacyHistory.length > 0) {
            log.info(() => `[Sub History Page] Migrating ${legacyHistory.length} legacy history entr${legacyHistory.length === 1 ? 'y' : 'ies'} from ${legacyHistoryUserHash} to ${stableHistoryUserHash}`);
            history = await migrateHistoryNamespace(legacyHistoryUserHash, stableHistoryUserHash, legacyHistory);
        }
    }

    return { history, historyUserHash };
}

app.get('/sub-history', async (req, res) => {
    try {
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { config: configStr, videoId, filename } = req.query;

        if (!configStr) {
            return res.status(400).send(t('server.errors.missingConfig', {}, 'Missing config'));
        }

        const config = await resolveConfigGuarded(configStr, req, res, '[Sub History Page] config', t);
        if (!config) return;
        t = getTranslatorFromRequest(req, res, config);
        ensureConfigHash(config, configStr);

        setNoStore(res);

        const historyContentEndpoint = buildHistoryContentEndpoint(configStr, videoId, filename);
        const html = generateHistoryPage(configStr, [], config, videoId, filename, {
            deferHistoryLoad: true,
            historyContentEndpoint
        });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Sub History Page]', t)) return;
        log.error(() => '[Sub History Page] Error:', error);
        res.status(500).send(t('server.errors.historyPageFailed', {}, 'Failed to load History page'));
    }
});

app.get('/api/sub-history-content', async (req, res) => {
    try {
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { config: configStr, videoId, filename } = req.query;

        if (!configStr) {
            return res.status(400).send(t('server.errors.missingConfig', {}, 'Missing config'));
        }

        const config = await resolveConfigGuarded(configStr, req, res, '[Sub History Content] config', t);
        if (!config) return;
        t = getTranslatorFromRequest(req, res, config);
        ensureConfigHash(config, configStr);

        setNoStore(res);

        const historyUserHash = resolveHistoryUserHash(config);
        if (!historyUserHash) {
            log.warn(() => '[Sub History Content] Missing config hash for history request - rejecting');
            return res.status(400).send(t('server.errors.missingHistoryHash', {}, 'Missing user hash for history requests'));
        }

        log.debug(() => `[Sub History Content] Loading history for user ${historyUserHash}`);

        const { history } = await loadHistoryEntriesForPage(config);
        const html = renderHistoryContent(configStr, history, config, videoId, filename);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);

        enrichHistoryEntriesBackground(history, historyUserHash, videoId, filename, config)
            .catch(e => log.debug(() => ['[Sub History Content] Background enrichment error:', e.message]));
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Sub History Content]', t)) return;
        log.error(() => '[Sub History Content] Error:', error);
        res.status(500).send(t('server.errors.historyPageFailed', {}, 'Failed to load History page'));
    }
});

// Addon route: History (redirects to standalone page)
app.get('/addon/:config/sub-history', async (req, res) => {
    try {
        setNoStore(res);
        const t = res.locals?.t || getTranslatorFromRequest(req, res);

        const { config: configStr } = req.params;
        const resolvedConfig = await resolveConfigGuarded(configStr, req, res, '[Sub History Addon] config', t);
        if (!resolvedConfig) return;

        log.debug(() => `[Sub History] Addon redirect for config hash ${resolvedConfig.userHash}`);

        res.redirect(302, `/sub-history?config=${encodeURIComponent(configStr)}`);
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Sub History Addon Route]', t)) return;
        log.error(() => '[Sub History Addon Route] Error:', error);
        res.status(500).send(t('server.errors.historyAddonFailed', {}, 'Failed to load History page'));
    }
});

// Addon route: Embedded subtitles extractor (redirects to standalone page)
app.get('/addon/:config/embedded-subtitles/:videoId', async (req, res) => {
    try {
        setNoStore(res);
        const t = res.locals?.t || getTranslatorFromRequest(req, res);

        const { config: configStr, videoId } = req.params;
        const { filename } = req.query;
        const resolvedConfig = await resolveConfigGuarded(configStr, req, res, '[Embedded Subs Addon] config', t);
        if (!resolvedConfig) return;

        log.debug(() => `[Embedded Subs] Addon redirect for video ${videoId}, filename: ${filename}`);

        res.redirect(302, `/embedded-subtitles?config=${encodeURIComponent(configStr)}&videoId=${encodeURIComponent(videoId)}&filename=${encodeURIComponent(filename || '')}`);
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Embedded Subs Addon Route]', t)) return;
        log.error(() => '[Embedded Subs Addon Route] Error:', error);
        res.status(500).send(t('server.errors.embeddedPageFailed', {}, 'Failed to load embedded subtitles page'));
    }
});

// Placeholder page: Embedded subtitle extractor
app.get('/embedded-subtitles', async (req, res) => {
    try {
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { config: configStr, videoId, filename } = req.query;
        if (!configStr || !videoId) {
            return res.status(400).send(t('server.errors.missingConfigOrVideo', {}, 'Missing config or videoId'));
        }

        const config = await resolveConfigGuarded(configStr, req, res, '[Embedded Subs Page] config', t);
        if (!config) return;
        t = getTranslatorFromRequest(req, res, config);
        ensureConfigHash(config, configStr);
        log.debug(() => `[Embedded Subs Page] Loading extractor for video ${videoId}`);

        // Defense-in-depth: prevent caching of page embedding user config/videoId
        setNoStore(res);
        const html = await generateEmbeddedSubtitlePage(configStr, videoId, filename, config);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Embedded Subs Page]', t)) return;
        log.error(() => '[Embedded Subs Page] Error:', error);
        res.status(500).send(t('server.errors.embeddedPageFailed', {}, 'Failed to load embedded subtitles page'));
    }
});

// Addon route: Automatic subtitles (redirects to standalone page)
app.get('/addon/:config/auto-subtitles/:videoId', async (req, res) => {
    try {
        // CRITICAL: Prevent caching to avoid cross-user config contamination (defense-in-depth)
        setNoStore(res);
        const t = res.locals?.t || getTranslatorFromRequest(req, res);

        const { config: configStr, videoId } = req.params;
        const { filename } = req.query;
        const resolvedConfig = await resolveConfigGuarded(configStr, req, res, '[Auto Subs Addon] config', t);
        // If storage was unavailable, the response has already been handled
        if (!resolvedConfig) return;

        log.debug(() => `[Auto Subs] Addon redirect for video ${videoId}, filename: ${filename}`);

        res.redirect(302, `/auto-subtitles?config=${encodeURIComponent(configStr)}&videoId=${encodeURIComponent(videoId)}&filename=${encodeURIComponent(filename || '')}`);
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Auto Subs Addon Route]', t)) return;
        log.error(() => '[Auto Subs Addon Route] Error:', error);
        res.status(500).send(t('server.errors.autoSubsPageFailed', {}, 'Failed to load automatic subtitles page'));
    }
});

// Auto-subtitles page (standalone UI)
app.get('/auto-subtitles', async (req, res) => {
    try {
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { config: configStr, videoId, filename, streamUrl } = req.query;
        if (!configStr || !videoId) {
            return res.status(400).send(t('server.errors.missingConfigOrVideo', {}, 'Missing config or videoId'));
        }

        // Defense-in-depth: prevent caching of page embedding user config/videoId
        setNoStore(res);

        const config = await resolveConfigGuarded(configStr, req, res, '[Auto Subs Page] config', t);
        // If storage is unavailable, response was already sent
        if (!config) return;
        t = getTranslatorFromRequest(req, res, config);
        ensureConfigHash(config, configStr);

        log.debug(() => `[Auto Subs Page] Loading auto-subtitling tool for video ${videoId}`);

        const html = await generateAutoSubtitlePage(
            configStr,
            videoId,
            filename,
            config,
            streamUrl
        );
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Auto Subs Page]', t)) return;
        log.error(() => '[Auto Subs Page] Error:', error);
        res.status(500).send(t('server.errors.autoSubsPageFailed', {}, 'Failed to load automatic subtitles page'));
    }
});

// Live auto-subtitles log streaming (SSE + polling-friendly JSON)
const LIVE_AUTOSUB_LOG_TTL_MS = 10 * 60 * 1000;
const liveAutoSubLogChannels = new Map();
function getAutoSubLogChannel(jobId) {
    const id = (jobId && String(jobId).trim()) ? String(jobId).trim().slice(0, 128) : null;
    if (!id) return null;
    let channel = liveAutoSubLogChannels.get(id);
    if (!channel) {
        channel = {
            logs: [],
            listeners: new Set(),
            done: false,
            createdAt: Date.now(),
            expiresAt: Date.now() + LIVE_AUTOSUB_LOG_TTL_MS
        };
        liveAutoSubLogChannels.set(id, channel);
    } else {
        channel.expiresAt = Date.now() + LIVE_AUTOSUB_LOG_TTL_MS;
    }
    return channel;
}
function broadcastAutoSubLog(jobId, entry) {
    if (!entry || !entry.message) return entry;
    const channel = getAutoSubLogChannel(jobId);
    if (channel) {
        channel.logs.push(entry);
        channel.expiresAt = Date.now() + LIVE_AUTOSUB_LOG_TTL_MS;
        for (const res of Array.from(channel.listeners || [])) {
            try {
                res.write('data: ' + JSON.stringify(entry) + '\n\n');
            } catch (_) {
                try { res.end(); } catch (_) { /* ignore */ }
                channel.listeners.delete(res);
            }
        }
    }
    return entry;
}
function finalizeAutoSubLog(jobId, logTrail = []) {
    const channel = getAutoSubLogChannel(jobId);
    if (!channel) return;
    if (Array.isArray(logTrail) && logTrail.length) {
        channel.logs = logTrail.slice(-250);
    }
    channel.done = true;
    channel.expiresAt = Date.now() + 2 * 60 * 1000;
    for (const res of Array.from(channel.listeners || [])) {
        try {
            res.write('event: done\ndata: {}\n\n');
            res.end();
        } catch (_) { /* ignore */ }
        channel.listeners.delete(res);
    }
}
setInterval(() => {
    const now = Date.now();
    for (const [jobId, channel] of liveAutoSubLogChannels.entries()) {
        if (!channel) {
            liveAutoSubLogChannels.delete(jobId);
            continue;
        }
        if (channel.expiresAt && channel.expiresAt < now) {
            try {
                for (const res of Array.from(channel.listeners || [])) {
                    try { res.end(); } catch (_) { /* ignore */ }
                }
            } catch (_) { /* ignore */ }
            liveAutoSubLogChannels.delete(jobId);
        }
    }
}, LIVE_AUTOSUB_LOG_TTL_MS).unref?.();

app.get('/api/auto-subtitles/logs', (req, res) => {
    try {
        const { jobId, since, format, replay = '1' } = req.query;
        const channel = getAutoSubLogChannel(jobId);
        if (!jobId || !channel) {
            return res.status(400).json({ error: 'jobId is required' });
        }
        const sinceTs = Number(since);
        const entries = Array.isArray(channel.logs)
            ? channel.logs.filter((entry) => {
                const ts = Number(entry?.ts);
                if (!Number.isFinite(sinceTs)) return true;
                if (!Number.isFinite(ts)) return false;
                return ts > sinceTs;
            }).slice(-250)
            : [];
        const wantsSse = (req.headers.accept || '').includes('text/event-stream') && format !== 'json';
        if (wantsSse) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.setHeader('Content-Encoding', 'identity');
            res.flushHeaders?.();
            if (replay !== '0' && entries.length) {
                entries.forEach((entry) => {
                    res.write('data: ' + JSON.stringify(entry) + '\n\n');
                });
            }
            if (channel.done) {
                res.write('event: done\ndata: {}\n\n');
                return res.end();
            }
            channel.listeners.add(res);
            req.on('close', () => {
                channel.listeners.delete(res);
            });
            return;
        }
        return res.json({
            logs: entries,
            done: channel.done === true
        });
    } catch (error) {
        log.error(() => ['[Auto Subs Logs] Error handling stream:', error]);
        res.status(500).json({ error: 'Failed to stream logs' });
    }
});

// API: Automatic subtitles (Cloudflare Workers AI transcription + optional translation)
// All transcription happens client-side via xSync extension - server only receives transcripts
app.post('/api/auto-subtitles/run', autoSubLimiter, async (req, res) => {
    let logTrail = [];
    const jobId = (req.body?.jobId || '').toString().trim();
    let logFinalized = false;
    const finalizeLogs = (trail = logTrail) => {
        if (logFinalized) return;
        finalizeAutoSubLog(jobId, trail);
        logFinalized = true;
    };
    const logStep = (message, level = 'info') => {
        const entry = { ts: Date.now(), level, message: String(message || '') };
        logTrail.push(entry);
        return broadcastAutoSubLog(jobId, entry);
    };
    const respond = (statusCode, payload) => {
        finalizeLogs(payload?.logTrail || logTrail);
        return res.status(statusCode).json(payload);
    };
    try {
        setNoStore(res);
        let t = res.locals?.t || getTranslatorFromRequest(req, res, req.body);
        let {
            configStr,
            streamUrl,
            videoId,
            filename,
            engine = 'remote',
            model,
            sourceLanguage,
            targetLanguages,
            translate = true,
            translationProvider,
            translationModel,
            sendTimestampsToAI = false,
            singleBatchMode = false,
            enableBatchContext = false,
            translationPrompt,
            sendFullVideo = false,
            diarization = false
        } = req.body || {};
        const options = (req.body && typeof req.body.options === 'object' && req.body.options) ? req.body.options : {};
        const hasLegacySendTimestamps = typeof req.body?.sendTimestampsToAI === 'boolean';
        const hasLegacySingleBatch = typeof req.body?.singleBatchMode === 'boolean';
        const hasLegacyBatchContext = typeof req.body?.enableBatchContext === 'boolean';
        // Force diarization for all auto-subs modes (labels are stripped from outputs)
        diarization = true;

        if (!configStr || !streamUrl || !videoId) {
            logStep('Missing required fields for auto-subs request', 'error');
            return respond(400, {
                error: t('server.errors.missingFields', {}, 'Missing required fields: configStr, streamUrl, videoId'),
                logTrail
            });
        }

        const config = await resolveConfigGuarded(configStr, req, res, '[Auto Subs API] config', t);
        // If storage is unavailable, respondStorageUnavailable already replied
        if (!config) {
            finalizeAutoSubLog(jobId, logTrail);
            return;
        }
        if (!config || config.__sessionTokenError === true) {
            log.warn(() => '[Auto Subs API] Rejected due to invalid/missing session token');
            t = getTranslatorFromRequest(req, res, config);
            return respond(401, {
                error: t('server.errors.invalidSessionToken', {}, 'Invalid or expired session token'),
                logTrail
            });
        }
        t = getTranslatorFromRequest(req, res, config);

        const validWorkflows = ['xml', 'json', 'original', 'ai'];
        const requestedWorkflow = (typeof options.translationWorkflow === 'string')
            ? options.translationWorkflow.trim().toLowerCase()
            : ((typeof req.body?.translationWorkflow === 'string') ? req.body.translationWorkflow.trim().toLowerCase() : '');
        const savedWorkflow = (() => {
            const raw = String(config.advancedSettings?.translationWorkflow || '').trim().toLowerCase();
            return validWorkflows.includes(raw) ? raw : '';
        })();
        const translationWorkflow = validWorkflows.includes(requestedWorkflow)
            ? requestedWorkflow
            : (((options.sendTimestampsToAI === true) || (hasLegacySendTimestamps && sendTimestampsToAI === true))
                ? 'ai'
                : (savedWorkflow || (config.advancedSettings?.sendTimestampsToAI === true ? 'ai' : 'xml')));
        singleBatchMode = (typeof options.singleBatchMode === 'boolean')
            ? options.singleBatchMode
            : (hasLegacySingleBatch ? singleBatchMode === true : config.singleBatchMode === true);
        enableBatchContext = (typeof options.enableBatchContext === 'boolean')
            ? options.enableBatchContext
            : (hasLegacyBatchContext ? enableBatchContext === true : config.advancedSettings?.enableBatchContext === true);
        sendTimestampsToAI = translationWorkflow === 'ai';
        config.singleBatchMode = singleBatchMode === true;
        config.advancedSettings = { ...(config.advancedSettings || {}) };
        config.advancedSettings.translationWorkflow = translationWorkflow;
        config.advancedSettings.enableBatchContext = enableBatchContext === true;
        if (sendTimestampsToAI) {
            config.advancedSettings.sendTimestampsToAI = true;
        } else {
            delete config.advancedSettings.sendTimestampsToAI;
        }

        const linkedHash = deriveVideoHash(filename || '', videoId || '');
        const streamHashInfo = deriveStreamHashFromUrlServer(streamUrl, { filename, videoId });
        const cacheBlocked = Boolean(streamHashInfo.hash && linkedHash && streamHashInfo.hash !== linkedHash);
        const videoHash = linkedHash || streamHashInfo.hash || deriveVideoHash(streamHashInfo.filename || filename || '', streamHashInfo.videoId || videoId || '');
        logStep(`Starting auto-subs run (engine=${engine || 'remote'}, translate=${translate !== false}, diarization=${diarization === true})`, 'info');
        logStep(`Video hash derived as ${videoHash || 'n/a'} (linked=${linkedHash || 'n/a'}, stream=${streamHashInfo.hash || 'n/a'})`, cacheBlocked ? 'warn' : 'info');

        const engineKey = String(engine || 'remote').toLowerCase();
        if (engineKey === 'local') {
            logStep('Local engine requested but not available in hosted mode', 'warn');
            return respond(400, {
                error: t('server.errors.autoSubsLocalUnavailable', {}, 'Local Whisper (extension) is not available yet. Use Remote (Cloudflare Workers AI).'),
                cacheBlocked,
                hashes: { linked: linkedHash, stream: streamHashInfo.hash || '' },
                logTrail
            });
        }

        const providerKey = (translationProvider || config.mainProvider || 'gemini').toString().toLowerCase();
        let transcription = null;
        const transcriptDiagnostics = {};
        const transcriptPayload = (req.body && typeof req.body.transcript === 'object') ? req.body.transcript : {};
        const transcriptSrtRaw = (typeof transcriptPayload.srt === 'string' && transcriptPayload.srt.trim())
            ? transcriptPayload.srt
            : ((typeof req.body?.transcriptSrt === 'string' && req.body.transcriptSrt.trim()) ? req.body.transcriptSrt : '');
        const preserveAutoSubTiming = engineKey === 'assemblyai'
            || String(transcriptPayload.model || '').toLowerCase() === 'assemblyai'
            || String(model || '').toLowerCase() === 'assemblyai';
        const normalizeOpts = preserveAutoSubTiming ? { preserveTiming: true } : {};
        const transcriptSrt = normalizeAutoSubSrt(transcriptSrtRaw, normalizeOpts);
        const transcriptLang = (transcriptPayload.languageCode || transcriptPayload.language || req.body?.transcriptLanguage || sourceLanguage || '').toString().trim();
        const cfStatus = Number.isFinite(transcriptPayload.cfStatus) ? transcriptPayload.cfStatus : (Number.isFinite(req.body?.cfStatus) ? req.body.cfStatus : null);
        const cfBody = (transcriptPayload.cfBody || req.body?.cfBody || '').toString();
        const audioMeta = (typeof transcriptPayload.audio === 'object') ? transcriptPayload.audio : {};
        const audioBytes = Number.isFinite(transcriptPayload.audioBytes) ? transcriptPayload.audioBytes
            : Number.isFinite(audioMeta.bytes) ? audioMeta.bytes
                : (Array.isArray(audioMeta.windows) ? audioMeta.windows.reduce((sum, w) => sum + (Number(w.bytes) || 0), 0) : null);
        const audioSource = transcriptPayload.audioSource || audioMeta.source || (engineKey === 'assemblyai' ? 'assemblyai-extension' : 'extension');
        const audioContentType = transcriptPayload.contentType || audioMeta.contentType || (engineKey === 'assemblyai' ? 'audio/wav' : 'audio/wav');
        const transcriptModel = transcriptPayload.model || model || '@cf/openai/whisper';
        const requestedAssemblySpeechModel = (transcriptPayload.speechModel || req.body?.assemblySpeechModel || '')
            .toString()
            .trim()
            .toLowerCase();
        const assemblySpeechModel = (requestedAssemblySpeechModel === 'universal-3-pro' || requestedAssemblySpeechModel === 'universal-2')
            ? requestedAssemblySpeechModel
            : 'universal-3-pro';

        if (engineKey === 'assemblyai' && transcriptSrt) {
            const transcriptBytes = Buffer.byteLength(transcriptSrt, 'utf8');
            logStep(`Using client AssemblyAI transcript (${formatBytes(transcriptBytes)}) from ${audioSource} (speech_model=${assemblySpeechModel})`, 'info');
            transcription = {
                srt: transcriptSrt,
                languageCode: transcriptLang || sourceLanguage || 'und',
                model: assemblySpeechModel,
                assemblyId: transcriptPayload.assemblyId || null
            };
            transcriptDiagnostics.audioBytes = audioBytes;
            transcriptDiagnostics.audioSource = audioSource;
            transcriptDiagnostics.contentType = audioContentType;
            transcriptDiagnostics.assemblyId = transcriptPayload.assemblyId || null;
            transcriptDiagnostics.usedFullVideo = transcriptPayload.usedFullVideo === true;
        } else if (engineKey === 'assemblyai') {
            // AssemblyAI without client-provided transcript is not supported
            // All transcription must happen client-side via the xSync extension
            logStep('AssemblyAI engine requires client-provided transcript (xSync extension)', 'error');
            return respond(400, {
                error: t('server.errors.autoSubsClientRequired', {}, 'AssemblyAI transcription requires the xSync extension to provide the transcript.'),
                hint: 'The xSync extension handles audio extraction and AssemblyAI API calls client-side.',
                logTrail
            });
        } else {
            // Client-supplied transcription (xSync extension, Cloudflare Workers AI)
            if (!transcriptSrt) {
                logStep('Client transcript missing; built-in fetch/transcribe is disabled for auto-subs', 'error');
                return respond(400, {
                    error: t('server.errors.autoSubsClientRequired', {}, 'Automatic subtitles now require a client-provided transcript (xSync extension).'),
                    logTrail
                });
            }
            const transcriptBytes = Buffer.byteLength(transcriptSrt, 'utf8');
            logStep(
                `Using client transcript (${formatBytes(transcriptBytes)}) from ${audioSource}`,
                'info'
            );
            if (cfStatus) {
                logStep(`Cloudflare transcription status ${cfStatus}${cfBody ? ' | Snippet: ' + cfBody.toString().slice(0, 200).replace(/\s+/g, ' ') : ''}`, cfStatus >= 500 ? 'warn' : 'info');
            }
            transcription = {
                srt: transcriptSrt,
                languageCode: transcriptLang || 'und',
                model: transcriptModel,
                cfStatus: cfStatus || null
            };
            transcriptDiagnostics.audioBytes = audioBytes;
            transcriptDiagnostics.audioSource = audioSource;
            transcriptDiagnostics.contentType = audioContentType;
            transcriptDiagnostics.cfStatus = cfStatus || null;
            transcriptDiagnostics.cfBody = cfBody || '';
        }

        if (!transcription || !transcription.srt) {
            logStep('Transcription returned no content', 'error');
            return respond(500, {
                error: t('server.errors.transcriptionEmpty', {}, 'Transcription returned no content'),
                logTrail
            });
        }
        const originalSrt = normalizeAutoSubSrt((transcription && transcription.srt) ? transcription.srt : '', normalizeOpts);
        if (!originalSrt || !originalSrt.trim()) {
            logStep('Transcription returned no content', 'error');
            return respond(500, {
                error: t('server.errors.transcriptionEmpty', {}, 'Transcription returned no content'),
                logTrail
            });
        }
        const originalLang = normalizeSyncLang(sourceLanguage || transcription.languageCode || 'und');
        const chosenModel = transcription?.model || model || (engineKey === 'assemblyai' ? 'assemblyai' : '@cf/openai/whisper');
        const modelKey = safeModelKey(chosenModel);
        const originalSourceId = `autosub_${modelKey}_orig`;
        logStep('Aligning segments and generating SRT/VTT outputs', 'info');
        const originalVtt = srtPairToWebVTT(originalSrt);

        const providerLabel = engineKey === 'assemblyai' ? 'assemblyai' : 'cloudflare-workers';
        const baseMetadata = {
            source: 'auto-subtitles',
            provider: providerLabel,
            model: chosenModel,
            streamHash: streamHashInfo.hash || '',
            linkedHash,
            cacheBlocked,
            diarization: diarization === true,
            createdAt: Date.now()
        };
        if (transcriptDiagnostics.assemblyId) baseMetadata.assemblyId = transcriptDiagnostics.assemblyId;
        if (transcriptDiagnostics.usedFullVideo) baseMetadata.usedFullVideo = true;

        let originalDownloadUrl = null;
        let autoCacheUpdated = false;
        if (!cacheBlocked) {
            try {
                await autoSubCache.saveAutoSubtitle(videoHash, originalLang, originalSourceId, {
                    content: originalSrt,
                    originalSubId: originalSourceId,
                    metadata: baseMetadata
                });
                originalDownloadUrl = `/addon/${encodeURIComponent(configStr)}/auto/${videoHash}/${originalLang}/${originalSourceId}`;
                autoCacheUpdated = true;
            } catch (error) {
                log.warn(() => ['[Auto Subs API] Failed to persist original to Auto cache:', error.message]);
            }
        }

        const translations = [];
        const normalizedTargets = Array.isArray(targetLanguages)
            ? targetLanguages.map(l => normalizeSyncLang(l)).filter(Boolean)
            : [];

        if (translate !== false && normalizedTargets.length > 0) {
            const providerBundle = await resolveAutoSubTranslationProvider(config, providerKey, translationModel);
            if (!providerBundle || !providerBundle.provider) {
                log.warn(() => '[Auto Subs API] No translation provider resolved; skipping translations');
                logStep('No translation provider configured; skipping translations', 'warn');
            } else {
                const providerLabelFull = providerBundle.fallbackProviderName
                    ? `${providerBundle.providerName} (fallback from ${providerBundle.fallbackProviderName})`
                    : providerBundle.providerName;
                logStep(`Using translation provider ${providerLabelFull} (${providerBundle.providerModel || 'default model'})`, 'info');
                logStep(`Translation workflow=${translationWorkflow}, singleBatch=${singleBatchMode === true}, batchContext=${enableBatchContext === true}`, 'info');
                const translationEngine = new TranslationEngine(
                    providerBundle.provider,
                    providerBundle.providerModel,
                    config.advancedSettings || {},
                    {
                        singleBatchMode: singleBatchMode === true,
                        providerName: providerBundle.providerName,
                        fallbackProviderName: providerBundle.fallbackProviderName,
                        enableStreaming: false
                    }
                );

                for (const targetLang of normalizedTargets) {
                    try {
                        logStep(`Translating to ${targetLang}`, 'info');
                        const translated = await translationEngine.translateSubtitle(
                            originalSrt,
                            getLanguageName(targetLang) || targetLang,
                            translationPrompt || config.translationPrompt || '',
                            null
                        );
                        const translatedVtt = srtPairToWebVTT(originalSrt, translated);
                        const sourceId = `autosub_${modelKey}_${targetLang}`;
                        let downloadUrl = null;
                        if (!cacheBlocked) {
                            try {
                                await autoSubCache.saveAutoSubtitle(videoHash, targetLang, sourceId, {
                                    content: translated,
                                    originalSubId: originalSourceId,
                                    metadata: {
                                        ...baseMetadata,
                                        provider: providerBundle.providerName,
                                        model: providerBundle.providerModel || providerBundle.providerName,
                                        targetLanguage: targetLang,
                                        translationWorkflow,
                                        singleBatchMode: singleBatchMode === true,
                                        enableBatchContext: enableBatchContext === true,
                                        sendTimestampsToAI: sendTimestampsToAI === true
                                    }
                                });
                                downloadUrl = `/addon/${encodeURIComponent(configStr)}/auto/${videoHash}/${targetLang}/${sourceId}`;
                                autoCacheUpdated = true;
                            } catch (error) {
                                log.warn(() => ['[Auto Subs API] Failed to persist translated Auto subtitle:', error.message]);
                            }
                        }
                        translations.push({
                            languageCode: targetLang,
                            srt: translated,
                            vtt: translatedVtt,
                            downloadUrl,
                            sourceId
                        });
                        logStep(`Translation complete for ${targetLang} (${translated.length} chars)`, 'info');
                    } catch (error) {
                        log.warn(() => ['[Auto Subs API] Translation failed for', targetLang, ':', error.message]);
                        logStep(`Translation failed for ${targetLang}: ${error.message || 'Unknown error'}`, 'warn');
                        translations.push({
                            languageCode: targetLang,
                            error: error.message || 'Translation failed'
                        });
                    }
                }
            }
        }

        logStep(
            `Delivering subtitles (${originalLang || 'und'}) with ${translations.length} translation(s)` +
            (cacheBlocked ? ' [cache upload skipped due to hash mismatch]' : ''),
            cacheBlocked ? 'warn' : 'success'
        );

        if (autoCacheUpdated) {
            await bumpUserSubtitleSearchRevision(config);
        }

        return respond(200, {
            success: true,
            cacheBlocked,
            hashes: { linked: linkedHash, stream: streamHashInfo.hash || '' },
            videoHash,
            logTrail,
            original: {
                languageCode: originalLang,
                srt: originalSrt,
                vtt: originalVtt,
                downloadUrl: originalDownloadUrl,
                sourceId: originalSourceId
            },
            translations,
            diagnostics: {
                engine: engineKey === 'assemblyai' ? 'assemblyai' : 'cloudflare',
                cfStatus: engineKey === 'assemblyai' ? null : (transcription?.cfStatus || transcriptDiagnostics.cfStatus || null),
                model: chosenModel,
                audioBytes: transcriptDiagnostics.audioBytes || null,
                audioSource: transcriptDiagnostics.audioSource || '',
                contentType: transcriptDiagnostics.contentType || '',
                translationTargets: normalizedTargets,
                assemblyId: transcriptDiagnostics.assemblyId || null,
                usedFullVideo: transcriptDiagnostics.usedFullVideo === true
            }
        });
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Auto Subs API]', t)) return;
        log.error(() => '[Auto Subs API] Error:', error);
        respond(500, {
            error: t('server.errors.autoSubsFailed', {}, `Automatic subtitles failed: ${error.message}`),
            logTrail: (Array.isArray(logTrail) && logTrail.length)
                ? logTrail
                : [{ ts: Date.now(), level: 'error', message: error.message || 'Automatic subtitles failed' }]
        });
    } finally {
        finalizeLogs(logTrail);
    }
});

// Custom route: Addon configuration page (BEFORE SDK router to take precedence)
// This handles both /addon/:config/configure and /addon/:config (base path)
app.get('/addon/:config/configure', (req, res) => {
    try {
        // CRITICAL: Prevent caching to avoid cross-user config contamination (defense-in-depth)
        setNoStore(res);
        const t = res.locals?.t || getTranslatorFromRequest(req, res);

        const { config: configStr } = req.params;

        log.debug(() => `[Configure] Redirecting to configure page with config`);
        // Redirect to main configure page with config parameter
        res.redirect(302, `/configure?config=${encodeURIComponent(configStr)}`);
    } catch (error) {
        log.error(() => '[Configure] Error:', error);
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        res.status(500).send(t('server.errors.configPageFailed', {}, 'Failed to load configuration page'));
    }
});

// Custom route: Sync subtitles page (BEFORE SDK router to take precedence)
app.get('/addon/:config/sync-subtitles/:videoId', async (req, res) => {
    try {
        // Defense-in-depth: Prevent caching (carries session token in query)
        setNoStore(res);
        const t = res.locals?.t || getTranslatorFromRequest(req, res);

        const { config: configStr, videoId } = req.params;
        const { filename } = req.query;
        const config = await resolveConfigGuarded(configStr, req, res, '[Sync Subtitles] config', t);
        if (!config) return;

        log.debug(() => `[Sync Subtitles] Request for video ${videoId}, filename: ${filename}`);

        // Redirect to the actual sync page
        res.redirect(302, `/subtitle-sync?config=${encodeURIComponent(configStr)}&videoId=${encodeURIComponent(videoId)}&filename=${encodeURIComponent(filename || '')}`);

    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Sync Subtitles]', t)) return;
        log.error(() => '[Sync Subtitles] Error:', error);
        res.status(500).send(t('server.errors.subtitleSyncPageFailed', {}, 'Failed to load subtitle sync page'));
    }
});

// Actual subtitle sync page (standalone, not under /addon route)
app.get('/subtitle-sync', async (req, res) => {
    // CRITICAL: Prevent caching to avoid cross-user config contamination (user-specific config in query params)
    setNoStore(res);

    try {
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { config: configStr, videoId, filename } = req.query;

        if (!configStr || !videoId) {
            return res.status(400).send(t('server.errors.missingConfigOrVideo', {}, 'Missing config or videoId'));
        }

        const config = await resolveConfigGuarded(configStr, req, res, '[Subtitle Sync Page] config', t);
        if (!config) return;
        t = getTranslatorFromRequest(req, res, config);
        ensureConfigHash(config, configStr);

        log.debug(() => `[Subtitle Sync Page] Loading page for video ${videoId}`);

        // Generate HTML page for subtitle syncing
        const html = await generateSubtitleSyncPage([], videoId, filename, configStr, config);

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);

    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Subtitle Sync Page]', t)) return;
        log.error(() => '[Subtitle Sync Page] Error:', error);
        res.status(500).send(t('server.errors.subtitleSyncPageFailed', {}, 'Failed to load subtitle sync page'));
    }
});

// API endpoint: Download xSync subtitle
app.get('/addon/:config/xsync/:videoHash/:lang/:sourceSubId', async (req, res) => {
    try {
        let t = res.locals?.t || getTranslatorFromRequest(req, res);

        const { config: configStr, videoHash, lang, sourceSubId } = req.params;
        const config = await resolveConfigGuarded(configStr, req, res, '[xSync Download] config', t);
        if (!config) return;
        if (!config || config.__sessionTokenError === true) {
            log.warn(() => '[xSync Download] Rejected due to invalid/missing session token');
            t = getTranslatorFromRequest(req, res, config);
            setSubtitleCacheHeaders(res, 'loading');
            return res.status(401).send(t('server.errors.invalidSessionToken', {}, 'Invalid or expired session token'));
        }
        t = getTranslatorFromRequest(req, res, config);

        log.debug(() => `[xSync Download] Request for ${videoHash}_${lang}_${sourceSubId}`);

        // Get synced subtitle from cache
        const syncedSub = await syncCache.getSyncedSubtitle(videoHash, lang, sourceSubId);

        if (!syncedSub || !syncedSub.content) {
            log.debug(() => '[xSync Download] Not found in cache');
            return res.status(404).send(t('server.errors.syncedSubtitleNotFound', {}, 'Synced subtitle not found'));
        }

        log.debug(() => '[xSync Download] Serving synced subtitle from cache');
        const strictSrtHeaders = String(config.androidSubtitleCompatMode || 'off').toLowerCase() === 'aggressive';
        if (strictSrtHeaders) {
            res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
            res.setHeader('Content-Disposition', `inline; filename="${videoHash}_${lang}_synced.srt"`);
        } else {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${videoHash}_${lang}_synced.srt"`);
        }
        setSubtitleCacheHeaders(res, 'final');
        res.send(maybeConvertToSRT(syncedSub.content, config));

    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[xSync Download]', t)) return;
        log.error(() => '[xSync Download] Error:', error);
        res.status(500).send(t('server.errors.downloadSyncedFailed', {}, 'Failed to download synced subtitle'));
    }
});

// Async subtitle list for /subtitle-sync page to avoid blocking first paint
app.get('/api/subtitle-sync/subtitles', async (req, res) => {
    setNoStore(res);
    try {
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { config: configStr, videoId, filename } = req.query;
        if (!configStr || !videoId) {
            return res.status(400).json({
                success: false,
                error: t('server.errors.missingConfigOrVideo', {}, 'Missing config or videoId')
            });
        }

        const config = await resolveConfigGuarded(configStr, req, res, '[Sync Subtitle List] config', t);
        if (!config) return;
        t = getTranslatorFromRequest(req, res, config);

        const subtitleHandler = createSubtitleHandler(config);
        const subtitlesData = await subtitleHandler({
            type: 'movie',
            id: videoId,
            extra: { filename }
        });

        return res.json({
            success: true,
            subtitles: subtitlesData?.subtitles || []
        });
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Sync Subtitle List]', t)) return;
        log.error(() => '[Sync Subtitle List] Error:', error);
        return res.status(500).json({
            success: false,
            error: t('server.errors.subtitleSyncPageFailed', {}, 'Failed to load subtitle sync page')
        });
    }
});

// API endpoint: Download Auto subtitle
app.get('/addon/:config/auto/:videoHash/:lang/:sourceSubId', async (req, res) => {
    try {
        let t = res.locals?.t || getTranslatorFromRequest(req, res);

        const { config: configStr, videoHash, lang, sourceSubId } = req.params;
        const config = await resolveConfigGuarded(configStr, req, res, '[Auto Download] config', t);
        if (!config) return;
        if (!config || config.__sessionTokenError === true) {
            log.warn(() => '[Auto Download] Rejected due to invalid/missing session token');
            t = getTranslatorFromRequest(req, res, config);
            setSubtitleCacheHeaders(res, 'loading');
            return res.status(401).send(t('server.errors.invalidSessionToken', {}, 'Invalid or expired session token'));
        }
        t = getTranslatorFromRequest(req, res, config);

        const safeVideoHash = (typeof videoHash === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(videoHash)) ? videoHash : null;
        const safeSourceSubId = (typeof sourceSubId === 'string' || typeof sourceSubId === 'number') && /^[a-zA-Z0-9._-]{1,120}$/.test(String(sourceSubId)) ? String(sourceSubId) : null;
        const safeLang = (typeof lang === 'string' && /^[a-zA-Z0-9_-]{1,24}$/.test(lang)) ? lang.toLowerCase() : null;
        if (!safeVideoHash || !safeSourceSubId || !safeLang) {
            return res.status(400).send(t('server.errors.invalidEmbeddedParams', {}, 'Invalid embedded subtitle parameters'));
        }

        log.debug(() => `[Auto Download] Request for ${safeVideoHash}_${safeLang}_${safeSourceSubId}`);

        let autoSub = await autoSubCache.getAutoSubtitle(safeVideoHash, safeLang, safeSourceSubId);
        if (!autoSub || !autoSub.content) {
            // Backward compatibility: older AutoSubs were stored in syncCache.
            // Only serve fallback entries that explicitly came from AutoSubs.
            const legacy = await syncCache.getSyncedSubtitle(safeVideoHash, safeLang, safeSourceSubId);
            if (legacy?.content && String(legacy?.metadata?.source || '').toLowerCase() === 'auto-subtitles') {
                autoSub = legacy;
            }
        }
        if (!autoSub || !autoSub.content) {
            log.debug(() => '[Auto Download] Not found in cache');
            return res.status(404).send(t('server.errors.syncedSubtitleNotFound', {}, 'Synced subtitle not found'));
        }

        log.debug(() => '[Auto Download] Serving auto subtitle from cache');
        const strictSrtHeaders = String(config.androidSubtitleCompatMode || 'off').toLowerCase() === 'aggressive';
        if (strictSrtHeaders) {
            res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
            res.setHeader('Content-Disposition', `inline; filename="${safeVideoHash}_${safeLang}_auto.srt"`);
        } else {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${safeVideoHash}_${safeLang}_auto.srt"`);
        }
        setSubtitleCacheHeaders(res, 'final');
        res.send(maybeConvertToSRT(autoSub.content, config));
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Auto Download]', t)) return;
        log.error(() => '[Auto Download] Error:', error);
        res.status(500).send(t('server.errors.downloadSyncedFailed', {}, 'Failed to download synced subtitle'));
    }
});

function normalizeSyncLanguageCode(raw) {
    const val = (raw || '').toString().trim().toLowerCase();
    if (!val) return '';

    // Prefer canonical ISO-639-2/custom code to keep sync keys consistent (e.g., en -> eng, pt-br -> pob)
    const canonical = canonicalSyncLanguageCode(val);
    if (canonical) return canonical;

    // Fallback: return normalized value (avoid empty writes)
    return val;
}

async function bumpUserSubtitleSearchRevision(config) {
    try {
        const userHash = (config && typeof config.__configHash === 'string' && config.__configHash.length > 0)
            ? config.__configHash
            : 'default';
        const key = `${CACHE_PREFIXES.SUBTITLE_SEARCH_REV}${userHash}`;
        await incrementCounter(key, CACHE_TTLS.SUBTITLE_SEARCH_REV || (7 * 24 * 60 * 60));
    } catch (error) {
        log.warn(() => `[Subtitle Cache] Failed to bump search revision: ${error?.message || error}`);
    }
}

// API endpoint: Save synced subtitle to cache
app.post('/api/save-synced-subtitle', userDataWriteLimiter, async (req, res) => {
    try {
        // CRITICAL: Prevent caching to avoid cross-user config contamination (user config in body)
        setNoStore(res);
        let t = res.locals?.t || getTranslatorFromRequest(req, res, req.body);

        const { configStr, videoHash, languageCode, sourceSubId, content, originalSubId, metadata } = req.body;

        if (!configStr || !videoHash || !languageCode || !sourceSubId || !content) {
            return res.status(400).json({ error: t('server.errors.missingFields', {}, 'Missing required fields') });
        }

        // Validate config
        const config = await resolveConfigGuarded(configStr, req, res, '[Save Synced] config');
        if (!config) return;

        // Reject writes when session token is missing/invalid to prevent cross-user pollution of shared sync cache
        if (!config || config.__sessionTokenError === true) {
            log.warn(() => '[Save Synced] Rejected write due to invalid/missing session token');
            t = getTranslatorFromRequest(req, res, config);
            return res.status(401).json({ error: t('server.errors.invalidSessionToken', {}, 'Invalid or expired session token') });
        }
        t = getTranslatorFromRequest(req, res, config);

        log.debug(() => `[Save Synced] Saving synced subtitle: ${videoHash}_${languageCode}_${sourceSubId}`);

        const normalizedLanguage = normalizeSyncLanguageCode(languageCode);
        const safeMetadata = (metadata && typeof metadata === 'object') ? metadata : {};

        // Save to sync cache
        await syncCache.saveSyncedSubtitle(videoHash, normalizedLanguage, sourceSubId, {
            content,
            originalSubId: originalSubId || sourceSubId,
            metadata: {
                ...safeMetadata,
                originalLanguageCode: languageCode,
                normalizedLanguageCode: normalizedLanguage
            }
        });

        // Invalidate user-scoped subtitle search cache so fresh xSync entries appear immediately.
        await bumpUserSubtitleSearchRevision(config);

        res.json({ success: true, message: t('server.sync.saveSuccess', {}, 'Synced subtitle saved successfully') });

    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Save Synced]', t)) return;
        log.error(() => '[Save Synced] Error:', error);
        res.status(500).json({ error: t('server.errors.saveSyncedFailed', {}, 'Failed to save synced subtitle') });
    }
});

// API endpoint: Download translated embedded subtitle
app.get('/addon/:config/xembedded/:videoHash/:lang/:trackId', async (req, res) => {
    try {
        const { config: configStr, videoHash, lang, trackId } = req.params;
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const config = await resolveConfigGuarded(configStr, req, res, '[xEmbed Download] config', t);
        if (!config) return;
        if (!config || config.__sessionTokenError === true) {
            log.warn(() => '[xEmbed Download] Rejected due to invalid/missing session token');
            t = getTranslatorFromRequest(req, res, config);
            setSubtitleCacheHeaders(res, 'loading');
            return res.status(401).send(t('server.errors.invalidSessionToken', {}, 'Invalid or expired session token'));
        }
        t = getTranslatorFromRequest(req, res, config);

        const safeVideoHash = (typeof videoHash === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(videoHash)) ? videoHash : null;
        const safeTrackId = (typeof trackId === 'string' || typeof trackId === 'number') && /^[a-zA-Z0-9._-]{1,120}$/.test(String(trackId)) ? String(trackId) : null;
        const safeLang = (typeof lang === 'string' && /^[a-zA-Z0-9_-]{1,24}$/.test(lang)) ? lang.toLowerCase() : null;

        if (!safeVideoHash || !safeTrackId || !safeLang) {
            return res.status(400).send(t('server.errors.invalidEmbeddedParams', {}, 'Invalid embedded subtitle parameters'));
        }

        log.debug(() => `[xEmbed Download] Request for ${safeVideoHash}_${safeLang}_${safeTrackId}`);

        const translations = await embeddedCache.listEmbeddedTranslations(safeVideoHash);
        const match = translations.find(t =>
            String(t.trackId) === String(safeTrackId) &&
            String(t.targetLanguageCode || t.languageCode || '').toLowerCase() === safeLang
        );

        if (!match || !match.content) {
            return res.status(404).send(t('server.errors.translatedEmbeddedMissing', {}, 'Translated embedded subtitle not found'));
        }

        const metadata = match.metadata || {};
        const strictSrtHeaders = String(config.androidSubtitleCompatMode || 'off').toLowerCase() === 'aggressive';
        const prepared = prepareEmbeddedSubtitleDelivery({
            content: match.content,
            codec: metadata.codec,
            mime: metadata.mime,
            label: metadata.label,
            originalLabel: metadata.originalLabel,
            name: metadata.name,
            sourceFormat: metadata.storedFormat || metadata.sourceFormat,
            metadata
        }, config, { logPrefix: '[xEmbed Download]' });

        if (prepared.conversionFailed) {
            log.warn(() => `[xEmbed Download] Requested SRT delivery but conversion fell back to ${prepared.sourceFormat || 'original'} for ${safeVideoHash}_${safeLang}_${safeTrackId}`);
        }

        if (prepared.deliveryFormat === 'vtt') {
            res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${safeVideoHash}_${safeLang}_xembed.vtt"`);
        } else if (prepared.deliveryFormat === 'ass' || prepared.deliveryFormat === 'ssa') {
            res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${safeVideoHash}_${safeLang}_xembed.${prepared.ext}"`);
        } else if (strictSrtHeaders) {
            res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
            res.setHeader('Content-Disposition', `inline; filename="${safeVideoHash}_${safeLang}_xembed.srt"`);
        } else {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${safeVideoHash}_${safeLang}_xembed.srt"`);
        }
        setSubtitleCacheHeaders(res, 'final');
        res.send(prepared.content);
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[xEmbed Download]', t)) return;
        log.error(() => '[xEmbed Download] Error:', error);
        res.status(500).send(t('server.errors.downloadEmbeddedFailed', {}, 'Failed to download embedded subtitle'));
    }
});

// API endpoint: Download original embedded subtitle
app.get('/addon/:config/xembedded/:videoHash/:lang/:trackId/original', async (req, res) => {
    try {
        const { config: configStr, videoHash, lang, trackId } = req.params;
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const config = await resolveConfigGuarded(configStr, req, res, '[xEmbed Original] config', t);
        if (!config) return;
        if (!config || config.__sessionTokenError === true) {
            log.warn(() => '[xEmbed Original] Rejected due to invalid/missing session token');
            t = getTranslatorFromRequest(req, res, config);
            setSubtitleCacheHeaders(res, 'loading');
            return res.status(401).send(t('server.errors.invalidSessionToken', {}, 'Invalid or expired session token'));
        }
        t = getTranslatorFromRequest(req, res, config);

        const safeVideoHash = (typeof videoHash === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(videoHash)) ? videoHash : null;
        const safeTrackId = (typeof trackId === 'string' || typeof trackId === 'number') && /^[a-zA-Z0-9._-]{1,120}$/.test(String(trackId)) ? String(trackId) : null;
        const safeLang = (typeof lang === 'string' && /^[a-zA-Z0-9_-]{1,24}$/.test(lang)) ? lang.toLowerCase() : null;

        if (!safeVideoHash || !safeTrackId || !safeLang) {
            return res.status(400).send(t('server.errors.invalidEmbeddedParams', {}, 'Invalid embedded subtitle parameters'));
        }

        log.debug(() => `[xEmbed Original] Request for ${safeVideoHash}_${safeLang}_${safeTrackId}`);

        const originals = await embeddedCache.listEmbeddedOriginals(safeVideoHash);
        const match = originals.find(t =>
            String(t.trackId) === String(safeTrackId) &&
            String(t.languageCode || '').toLowerCase() === safeLang
        );

        if (!match || !match.content) {
            return res.status(404).send(t('server.errors.originalEmbeddedMissing', {}, 'Original embedded subtitle not found'));
        }

        const metadata = match.metadata || {};
        const encoding = String(metadata.encoding || 'text').toLowerCase();
        if (encoding === 'base64') {
            const binaryMime = metadata.mime || 'application/octet-stream';
            const binaryExt = /matroska/i.test(binaryMime) ? 'mkv' : 'bin';
            res.setHeader('Content-Type', binaryMime);
            res.setHeader('Content-Disposition', `attachment; filename="${safeVideoHash}_${safeLang}_original.${binaryExt}"`);
            setSubtitleCacheHeaders(res, 'final');
            return res.send(Buffer.from(String(match.content || ''), 'base64'));
        }

        const strictSrtHeaders = String(config.androidSubtitleCompatMode || 'off').toLowerCase() === 'aggressive';
        const prepared = prepareEmbeddedSubtitleDelivery({
            content: match.content,
            codec: metadata.codec,
            mime: metadata.mime,
            label: metadata.label,
            originalLabel: metadata.originalLabel,
            name: metadata.name,
            sourceFormat: metadata.sourceFormat,
            metadata
        }, config, { logPrefix: '[xEmbed Original]' });

        if (prepared.conversionFailed) {
            log.warn(() => `[xEmbed Original] Requested SRT delivery but conversion fell back to ${prepared.sourceFormat || 'original'} for ${safeVideoHash}_${safeLang}_${safeTrackId}`);
        }

        if (prepared.deliveryFormat === 'vtt') {
            res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${safeVideoHash}_${safeLang}_original.vtt"`);
        } else if (prepared.deliveryFormat === 'ass' || prepared.deliveryFormat === 'ssa') {
            res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${safeVideoHash}_${safeLang}_original.${prepared.ext}"`);
        } else if (strictSrtHeaders) {
            res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
            res.setHeader('Content-Disposition', `inline; filename="${safeVideoHash}_${safeLang}_original.srt"`);
        } else {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${safeVideoHash}_${safeLang}_original.srt"`);
        }
        setSubtitleCacheHeaders(res, 'final');
        res.send(prepared.content);
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[xEmbed Original]', t)) return;
        log.error(() => '[xEmbed Original] Error:', error);
        res.status(500).send(t('server.errors.downloadEmbeddedOriginalFailed', {}, 'Failed to download original embedded subtitle'));
    }
});

app.post('/api/prepare-embedded-track-delivery', async (req, res) => {
    try {
        setNoStore(res);
        let t = res.locals?.t || getTranslatorFromRequest(req, res, req.body);
        const { configStr, tracks } = req.body || {};

        if (!configStr || !Array.isArray(tracks) || tracks.length === 0) {
            return res.status(400).json({ error: t('server.errors.missingOrInvalidFields', {}, 'Missing or invalid required fields') });
        }
        if (tracks.length > 40) {
            return res.status(413).json({ error: t('server.errors.embeddedTooLarge', {}, 'Embedded subtitle is too large') });
        }

        const config = await resolveConfigGuarded(configStr, req, res, '[Embedded Delivery] config', t);
        if (!config) return;
        if (!config || config.__sessionTokenError === true) {
            log.warn(() => '[Embedded Delivery] Rejected due to invalid/missing session token');
            t = getTranslatorFromRequest(req, res, config);
            return res.status(401).json({ error: t('server.errors.invalidSessionToken', {}, 'Invalid or expired session token') });
        }
        t = getTranslatorFromRequest(req, res, config);

        let totalChars = 0;
        const preparedTracks = tracks.map((track, index) => {
            const safeTrackId = (typeof track?.id === 'string' || typeof track?.id === 'number')
                ? String(track.id)
                : String(index);
            const content = typeof track?.content === 'string' ? track.content : '';
            totalChars += content.length;
            return {
                id: safeTrackId,
                content,
                codec: track?.codec,
                mime: track?.mime,
                label: track?.label,
                originalLabel: track?.originalLabel,
                name: track?.name,
                sourceFormat: track?.sourceFormat
            };
        });

        if (totalChars > 8 * 1024 * 1024) {
            return res.status(413).json({ error: t('server.errors.embeddedTooLarge', {}, 'Embedded subtitle is too large') });
        }

        const results = preparedTracks.map((track) => ({
            id: track.id,
            ...prepareEmbeddedSubtitleDelivery(track, config, { logPrefix: '[Embedded Delivery]' })
        }));

        return res.json({ success: true, tracks: results });
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        log.error(() => ['[Embedded Delivery] Error:', error]);
        res.status(500).json({ error: t('server.errors.downloadEmbeddedOriginalFailed', {}, 'Failed to prepare embedded subtitle delivery') });
    }
});

// API endpoint: Save extracted embedded subtitle to cache
app.post('/api/save-embedded-subtitle', userDataWriteLimiter, async (req, res) => {
    try {
        setNoStore(res); // prevent caching of user-config-bearing request/response
        let t = res.locals?.t || getTranslatorFromRequest(req, res, req.body);
        const { configStr, videoHash, trackId, languageCode, content, metadata } = req.body || {};

        const normalizedVideoHash = typeof videoHash === 'string' ? videoHash.trim() : '';
        const normalizedTrackId = (typeof trackId === 'string' || typeof trackId === 'number') ? String(trackId).trim() : '';
        const normalizedLang = typeof languageCode === 'string' ? languageCode.trim().toLowerCase() : '';
        const canonicalLang = canonicalSyncLanguageCode(normalizedLang);
        const subtitleContent = typeof content === 'string' ? content : '';

        const hashIsSafe = normalizedVideoHash && normalizedVideoHash.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(normalizedVideoHash);
        const trackIsSafe = normalizedTrackId && normalizedTrackId.length <= 120 && /^[a-zA-Z0-9._-]+$/.test(normalizedTrackId);
        const langIsSafe = canonicalLang && canonicalLang.length <= 24;

        if (!configStr || !hashIsSafe || !trackIsSafe || !langIsSafe || !subtitleContent) {
            return res.status(400).json({ error: t('server.errors.missingOrInvalidFields', {}, 'Missing or invalid required fields') });
        }
        if (subtitleContent.length > 5 * 1024 * 1024) {
            return res.status(413).json({ error: t('server.errors.embeddedTooLarge', {}, 'Embedded subtitle is too large') });
        }

        const config = await resolveConfigGuarded(configStr, req, res, '[Save Embedded] config', t);
        if (!config) return;
        if (!config || config.__sessionTokenError === true) {
            log.warn(() => '[Save Embedded] Rejected write due to invalid/missing session token');
            t = getTranslatorFromRequest(req, res, config);
            return res.status(401).json({ error: t('server.errors.invalidSessionToken', {}, 'Invalid or expired session token') });
        }
        t = getTranslatorFromRequest(req, res, config);

        let kept = false;
        let cacheKey = null;
        let normalizedMetadata = (metadata && typeof metadata === 'object') ? { ...metadata } : {};

        if (KEEP_EMBEDDED_ORIGINALS) {
            const saveResult = await embeddedCache.saveOriginalEmbedded(
                normalizedVideoHash,
                normalizedTrackId,
                canonicalLang,
                subtitleContent,
                normalizedMetadata
            );
            kept = true;
            cacheKey = saveResult.cacheKey;
            normalizedMetadata = saveResult.entry.metadata || normalizedMetadata;
        } else {
            // Respect opt-out, but still acknowledge success
            log.debug(() => `[Save Embedded] Discarded original for ${normalizedVideoHash}_${normalizedLang}_${normalizedTrackId} (KEEP_EMBEDDED_ORIGINALS disabled)`);
        }

        if (kept) {
            await bumpUserSubtitleSearchRevision(config);
        }

        return res.json({ success: true, kept, cacheKey, metadata: normalizedMetadata });
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Save Embedded]', t)) return;
        log.error(() => '[Save Embedded] Error:', error);
        res.status(500).json({ error: t('server.errors.saveEmbeddedFailed', {}, 'Failed to save embedded subtitle') });
    }
});

// API endpoint: Translate embedded subtitle (with TranslationEngine options)
app.post('/api/translate-embedded', embeddedTranslationLimiter, async (req, res) => {
    let historyEntry = null;
    let historyUserHash = '';
    let historyEnabled = false;
    let revisionConfig = null;
    let embeddedCacheUpdated = false;
    const persistHistory = (status, extra = {}) => {
        if (!historyEnabled || !historyEntry || !historyUserHash) return;
        const nextEntry = { ...historyEntry };
        if (extra && typeof extra === 'object') {
            Object.assign(nextEntry, extra);
        }
        if (status) {
            nextEntry.status = status;
            if (status === 'completed' || status === 'failed') {
                nextEntry.completedAt = Date.now();
            }
        }
        historyEntry = nextEntry;
        return saveRequestToHistory(historyUserHash, nextEntry).catch(err => {
            log.warn(() => [`[History] Failed to persist embedded translation history:`, err.message]);
        });
    };
    try {
        setNoStore(res); // prevent caching of user-config-bearing request/response
        let t = res.locals?.t || getTranslatorFromRequest(req, res, req.body);
        const {
            configStr,
            videoHash,
            trackId,
            videoId: requestVideoId,
            filename: requestFilename,
            sourceLanguageCode,
            targetLanguage,
            content,
            metadata,
            options,
            overrides,
            forceRetranslate,
            skipCache
        } = req.body || {};

        const normalizedVideoHash = typeof videoHash === 'string' ? videoHash.trim() : '';
        const normalizedTrackId = (typeof trackId === 'string' || typeof trackId === 'number') ? String(trackId).trim() : '';
        const normalizedRequestVideoId = normalizeEmbeddedHistoryValue(requestVideoId, '', 200);
        const normalizedRequestFilename = normalizeEmbeddedHistoryValue(requestFilename, '', 200);
        const normalizedTargetLang = typeof targetLanguage === 'string' ? targetLanguage.trim().toLowerCase() : '';
        const normalizedSourceLang = typeof sourceLanguageCode === 'string' ? sourceLanguageCode.trim().toLowerCase() : 'und';
        const subtitleContent = typeof content === 'string' ? content : '';
        let mergedMetadata = (metadata && typeof metadata === 'object') ? { ...metadata } : {};
        if (normalizedRequestVideoId) mergedMetadata.videoId = normalizedRequestVideoId;
        if (normalizedRequestFilename) mergedMetadata.filename = normalizedRequestFilename;
        const incomingBatchId = Number(mergedMetadata.batchId);
        const skipCacheWrites = skipCache === true;

        const hashIsSafe = normalizedVideoHash && normalizedVideoHash.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(normalizedVideoHash);
        const trackIsSafe = normalizedTrackId && normalizedTrackId.length <= 120 && /^[a-zA-Z0-9._-]+$/.test(normalizedTrackId);
        const langIsSafe = normalizedTargetLang && normalizedTargetLang.length <= 24;

        if (!configStr || !hashIsSafe || !trackIsSafe || !langIsSafe) {
            return res.status(400).json({ error: t('server.errors.missingOrInvalidFields', {}, 'Invalid or missing required fields') });
        }
        if (subtitleContent && subtitleContent.length > 5 * 1024 * 1024) {
            return res.status(413).json({ error: t('server.errors.subtitleTooLarge', {}, 'Subtitle content is too large') });
        }

        const safeVideoHash = normalizedVideoHash;
        const safeTrackId = normalizedTrackId;
        const safeTargetLanguage = normalizedTargetLang;
        const safeSourceLanguage = normalizedSourceLang || 'und';

        const baseConfig = await resolveConfigGuarded(configStr, req, res, '[Embedded Translate] config', t);
        if (!baseConfig) return;
        if (!baseConfig || baseConfig.__sessionTokenError === true) {
            log.warn(() => '[Embedded Translate] Rejected due to invalid/missing session token');
            t = getTranslatorFromRequest(req, res, baseConfig);
            return res.status(401).json({ error: t('server.errors.invalidSessionToken', {}, 'Invalid or expired session token') });
        }
        ensureConfigHash(baseConfig, configStr);
        revisionConfig = baseConfig;
        t = getTranslatorFromRequest(req, res, baseConfig);
        const workingConfig = {
            ...baseConfig,
            advancedSettings: { ...(baseConfig.advancedSettings || {}) }
        };

        // Apply TranslationEngine-specific toggles
        const validWorkflows = ['xml', 'json', 'original', 'ai'];
        const requestedWorkflow = (options && typeof options.translationWorkflow === 'string')
            ? options.translationWorkflow.trim().toLowerCase()
            : '';
        const savedWorkflow = (() => {
            const raw = String(workingConfig.advancedSettings?.translationWorkflow || '').trim().toLowerCase();
            return validWorkflows.includes(raw) ? raw : '';
        })();
        const translationWorkflow = validWorkflows.includes(requestedWorkflow)
            ? requestedWorkflow
            : ((options && options.sendTimestampsToAI === true)
                ? 'ai'
                : (savedWorkflow || (workingConfig.advancedSettings.sendTimestampsToAI === true ? 'ai' : 'xml')));
        const singleBatchMode = (options && typeof options.singleBatchMode === 'boolean')
            ? options.singleBatchMode
            : workingConfig.singleBatchMode === true;
        const enableBatchContext = (options && typeof options.enableBatchContext === 'boolean')
            ? options.enableBatchContext
            : workingConfig.advancedSettings.enableBatchContext === true;
        const sendTimestampsToAI = translationWorkflow === 'ai';

        workingConfig.singleBatchMode = singleBatchMode;
        workingConfig.advancedSettings.translationWorkflow = translationWorkflow;
        workingConfig.advancedSettings.enableBatchContext = enableBatchContext;
        if (sendTimestampsToAI) {
            workingConfig.advancedSettings.sendTimestampsToAI = true;
        } else {
            delete workingConfig.advancedSettings.sendTimestampsToAI;
        }

        // Provider/model overrides (mirrors file upload behavior)
        const sanitizeAdvancedSettings = (incoming = {}) => {
            const parsed = {};
            const clampNumber = (value, min, max) => {
                const num = typeof value === 'number' ? value : parseFloat(value);
                if (!Number.isFinite(num)) return null;
                if (min !== undefined && num < min) return min;
                if (max !== undefined && num > max) return max;
                return num;
            };

            const thinking = clampNumber(incoming.thinkingBudget, -1, 200000);
            if (thinking !== null) parsed.thinkingBudget = thinking;

            const temperature = clampNumber(incoming.temperature, 0, 2);
            if (temperature !== null) parsed.temperature = temperature;

            const topP = clampNumber(incoming.topP, 0, 1);
            if (topP !== null) parsed.topP = topP;

            const topK = clampNumber(incoming.topK, 1, 100);
            if (topK !== null) parsed.topK = topK;

            const maxTokens = clampNumber(incoming.maxOutputTokens, 1, 200000);
            if (maxTokens !== null) parsed.maxOutputTokens = maxTokens;

            const timeout = clampNumber(incoming.translationTimeout, 5, 720);
            if (timeout !== null) parsed.translationTimeout = timeout;

            const maxRetries = clampNumber(incoming.maxRetries, 0, 5);
            if (maxRetries !== null) parsed.maxRetries = Math.max(0, Math.min(5, parseInt(maxRetries, 10)));

            return Object.keys(parsed).length ? parsed : null;
        };

        const parsedAdvanced = sanitizeAdvancedSettings(overrides?.advancedSettings || overrides?.options || {});
        if (parsedAdvanced) {
            workingConfig.advancedSettings = { ...workingConfig.advancedSettings, ...parsedAdvanced };
        }
        if (overrides && typeof overrides.translationPrompt === 'string' && overrides.translationPrompt.trim()) {
            workingConfig.translationPrompt = overrides.translationPrompt.trim();
        }

        // Provider selection overrides
        if (overrides && typeof overrides.providerName === 'string' && overrides.providerName.trim()) {
            workingConfig.multiProviderEnabled = true;
            workingConfig.mainProvider = overrides.providerName.trim();
        }
        if (overrides && typeof overrides.providerModel === 'string' && overrides.providerModel.trim()) {
            const providerKey = (workingConfig.multiProviderEnabled === true && workingConfig.mainProvider)
                ? String(workingConfig.mainProvider).toLowerCase()
                : 'gemini';
            if (providerKey === 'gemini') {
                const geminiModelOverride = overrides.providerModel.trim();
                workingConfig.geminiModel = geminiModelOverride;
                workingConfig.advancedSettings = {
                    ...workingConfig.advancedSettings,
                    enabled: true,
                    geminiModel: geminiModelOverride
                };
            } else {
                workingConfig.providers = workingConfig.providers || {};
                const current = workingConfig.providers[providerKey] || {};
                workingConfig.providers[providerKey] = { ...current, model: overrides.providerModel.trim() };
            }
        }

        // Resolve requested provider/model for cache compatibility checks
        const requestedProviderName = (overrides?.providerName && overrides.providerName.trim())
            ? overrides.providerName.trim().toLowerCase()
            : ((workingConfig.multiProviderEnabled === true && workingConfig.mainProvider)
                ? String(workingConfig.mainProvider).toLowerCase()
                : 'gemini');
        const resolveRequestedModel = () => {
            if (overrides?.providerModel && overrides.providerModel.trim()) {
                return overrides.providerModel.trim();
            }
            if (requestedProviderName === 'gemini') {
                return getEffectiveGeminiModel(workingConfig);
            }
            const providers = workingConfig.providers || {};
            const matchKey = Object.keys(providers).find(k => String(k).toLowerCase() === requestedProviderName);
            return matchKey ? (providers[matchKey]?.model || '') : '';
        };
        const requestedModel = resolveRequestedModel();
        const promptSignature = workingConfig.translationPrompt
            ? crypto.createHash('sha1').update(String(workingConfig.translationPrompt)).digest('hex')
            : '';

        // History tracking (Sub Toolbox translations previously skipped history)
        const normalizeHistoryLabel = (value, fallback) => {
            return normalizeEmbeddedHistoryValue(value, fallback, 200);
        };
        historyUserHash = resolveHistoryUserHash(baseConfig);
        historyEnabled = !!historyUserHash;
        if (!historyEnabled) {
            log.warn(() => '[History] Skipping history for embedded translation: missing user hash');
        }
        const ensureHistoryEntry = () => {
            if (!historyEnabled) return false;
            if (historyEntry) return true;
            const historyContext = buildEmbeddedHistoryContext({
                videoHash: safeVideoHash,
                trackId: safeTrackId,
                requestVideoId: normalizedRequestVideoId,
                requestFilename: normalizedRequestFilename,
                metadata: mergedMetadata
            });
            historyEntry = {
                id: crypto.randomUUID(),
                status: 'processing',
                title: historyContext.title,
                filename: historyContext.filename,
                videoId: historyContext.videoId,
                videoHash: historyContext.videoHash,
                trackId: safeTrackId,
                trackLabel: historyContext.trackLabel,
                sourceLanguage: safeSourceLanguage || 'und',
                targetLanguage: safeTargetLanguage,
                createdAt: Date.now(),
                provider: requestedProviderName || workingConfig.mainProvider || 'unknown',
                model: requestedModel || getEffectiveGeminiModel(workingConfig) || 'default',
                scope: 'embedded'
            };
            persistHistory('processing');
            return true;
        };

        const cacheMatchesOptions = (meta = {}) => {
            const metaWorkflow = typeof meta.translationWorkflow === 'string'
                ? meta.translationWorkflow.trim().toLowerCase()
                : '';
            if (metaWorkflow) {
                if (metaWorkflow !== translationWorkflow) {
                    return false;
                }
            } else if (translationWorkflow === 'ai') {
                if (meta.sendTimestampsToAI !== true) {
                    return false;
                }
            } else {
                // Older embedded cache entries do not record non-AI workflows,
                // so they are ambiguous between XML/original/JSON modes.
                return false;
            }

            if (meta.singleBatchMode !== undefined && meta.singleBatchMode !== singleBatchMode) {
                return false;
            }
            if (meta.sendTimestampsToAI !== undefined && meta.sendTimestampsToAI !== sendTimestampsToAI) {
                return false;
            }
            if (meta.enableBatchContext !== undefined && meta.enableBatchContext !== enableBatchContext) {
                return false;
            }
            if (enableBatchContext && meta.enableBatchContext !== true) {
                return false;
            }

            const metaProvider = meta.provider ? String(meta.provider).toLowerCase() : '';
            const metaModel = meta.model ? String(meta.model).toLowerCase() : '';
            const requestedModelLower = requestedModel ? String(requestedModel).toLowerCase() : '';

            if (requestedProviderName && metaProvider && metaProvider !== requestedProviderName) {
                return false;
            }
            if (requestedProviderName && !metaProvider && overrides?.providerName) {
                return false;
            }
            if (requestedModelLower && metaModel && metaModel !== requestedModelLower) {
                return false;
            }
            if (requestedModelLower && !metaModel && overrides?.providerModel) {
                return false;
            }
            if (promptSignature && meta.promptSignature && meta.promptSignature !== promptSignature) {
                return false;
            }
            if (promptSignature && !meta.promptSignature) {
                return false;
            }
            if (!promptSignature && meta.promptSignature) {
                return false;
            }
            if (sendTimestampsToAI && meta.sendTimestampsToAI !== true) {
                return false;
            }
            if (singleBatchMode && meta.singleBatchMode !== true) {
                return false;
            }
            return true;
        };

        // Return cached translation when available unless force requested
        if (!forceRetranslate && !skipCacheWrites) {
            try {
                let cachedTranslation = await embeddedCache.getTranslatedEmbedded(
                    safeVideoHash,
                    safeTrackId,
                    safeSourceLanguage,
                    safeTargetLanguage
                );
                if (!cachedTranslation || !cachedTranslation.content || !cacheMatchesOptions(cachedTranslation.metadata || {})) {
                    const translations = await embeddedCache.listEmbeddedTranslations(safeVideoHash);
                    cachedTranslation = translations.find(t =>
                        String(t.trackId) === String(safeTrackId) &&
                        String(t.targetLanguageCode || t.languageCode || '').toLowerCase() === String(safeTargetLanguage).toLowerCase() &&
                        cacheMatchesOptions(t.metadata || {})
                    );
                }
                if (cachedTranslation && cachedTranslation.content) {
                    return res.json({
                        success: true,
                        cached: true,
                        cacheKey: cachedTranslation.cacheKey,
                        translatedContent: cachedTranslation.content,
                        metadata: cachedTranslation.metadata || {}
                    });
                }
            } catch (e) {
                log.warn(() => ['[Embedded Translate] Cache lookup failed, continuing:', e.message]);
            }
        }

        ensureHistoryEntry();

        // Load original if not provided
        let sourceContent = subtitleContent;
        let originalEntry = null;
        if (!sourceContent) {
            if (!KEEP_EMBEDDED_ORIGINALS || skipCacheWrites) {
                persistHistory('failed', { error: t('server.errors.originalEmbeddedRequired', {}, 'Original embedded subtitle required: send content or enable KEEP_EMBEDDED_ORIGINALS=true') });
                return res.status(400).json({ error: t('server.errors.originalEmbeddedRequired', {}, 'Original embedded subtitle required: send content or enable KEEP_EMBEDDED_ORIGINALS=true') });
            }
            originalEntry = await embeddedCache.getOriginalEmbedded(safeVideoHash, safeTrackId, safeSourceLanguage);
            if (!originalEntry || !originalEntry.content) {
                persistHistory('failed', { error: t('server.errors.originalEmbeddedMissing', {}, 'Original embedded subtitle not found') });
                return res.status(404).json({ error: t('server.errors.originalEmbeddedMissing', {}, 'Original embedded subtitle not found') });
            }
            sourceContent = originalEntry.content;
        } else if (KEEP_EMBEDDED_ORIGINALS && !skipCacheWrites) {
            try {
                const existingOriginal = await embeddedCache.getOriginalEmbedded(safeVideoHash, safeTrackId, safeSourceLanguage);
                if (!existingOriginal || !existingOriginal.content) {
                    const persisted = await embeddedCache.saveOriginalEmbedded(
                        safeVideoHash,
                        safeTrackId,
                        safeSourceLanguage,
                        sourceContent,
                        mergedMetadata || {}
                    );
                    embeddedCacheUpdated = true;
                    originalEntry = persisted.entry;
                    log.debug(() => `[Embedded Translate] Persisted inline original ${safeTrackId} for ${safeVideoHash}`);
                } else {
                    originalEntry = existingOriginal;
                }
            } catch (e) {
                log.warn(() => ['[Embedded Translate] Failed to persist inline original:', e.message]);
            }
        }

        if (originalEntry && originalEntry.metadata) {
            mergedMetadata = { ...(originalEntry.metadata || {}), ...mergedMetadata };
        }

        if (Number.isFinite(Number(originalEntry?.metadata?.batchId))) {
            mergedMetadata.batchId = Number(originalEntry.metadata.batchId);
        } else if (Number.isFinite(incomingBatchId)) {
            mergedMetadata.batchId = incomingBatchId;
        } else if (!mergedMetadata.batchId) {
            mergedMetadata.batchId = Date.now();
        }

        // Convert any subtitle format (VTT, ASS/SSA) to SRT for translation
        sourceContent = ensureSRTForTranslation(sourceContent, '[Embedded Translate]');

        const targetLangName = getLanguageName(safeTargetLanguage) || safeTargetLanguage;
        const { provider, providerName, model, fallbackProviderName } = await createTranslationProvider(workingConfig);
        if (historyEntry) {
            historyEntry.provider = providerName || fallbackProviderName || historyEntry.provider || requestedProviderName || 'unknown';
            historyEntry.model = model || requestedModel || historyEntry.model || getEffectiveGeminiModel(workingConfig) || 'default';
            persistHistory('processing');
        }
        const engine = new TranslationEngine(
            provider,
            model || getEffectiveGeminiModel(workingConfig),
            workingConfig.advancedSettings || {},
            { singleBatchMode, providerName, fallbackProviderName, enableStreaming: false }
        );

        log.debug(() => `[Embedded Translate] Translating track ${safeTrackId} to ${targetLangName} (workflow=${translationWorkflow}, singleBatch=${singleBatchMode}, batchContext=${enableBatchContext}, timestamps=${sendTimestampsToAI})`);
        const translatedContent = await engine.translateSubtitle(
            sourceContent,
            targetLangName,
            workingConfig.translationPrompt,
            null
        );

        const storedFormat = detectEmbeddedSubtitleFormat({ content: translatedContent });
        const saveMeta = {
            ...(mergedMetadata || {}),
            provider: providerName,
            model: model || requestedModel || getEffectiveGeminiModel(workingConfig),
            translatedAt: Date.now(),
            storedFormat,
            translationWorkflow,
            singleBatchMode,
            enableBatchContext,
            sendTimestampsToAI,
            promptSignature
        };
        let saveResult = { cacheKey: null, entry: null };
        if (!skipCacheWrites) {
            saveResult = await embeddedCache.saveTranslatedEmbedded(
                safeVideoHash,
                safeTrackId,
                safeSourceLanguage,
                safeTargetLanguage,
                translatedContent,
                saveMeta
            );
            embeddedCacheUpdated = true;
        } else {
            log.debug(() => `[Embedded Translate] Skipped cache write for ${safeVideoHash}_${safeTargetLanguage}_${safeTrackId} (skipCache=true)`);
        }

        persistHistory('completed', {
            provider: providerName || historyEntry?.provider || 'unknown',
            model: model || requestedModel || historyEntry?.model || getEffectiveGeminiModel(workingConfig) || 'default',
            cached: false,
            // Spread engine translationStats so embedded history cards get full diagnostics
            // (secondary provider use, error types, rate limits, batch details, etc.)
            ...(engine.translationStats || {})
        });

        if (embeddedCacheUpdated && revisionConfig) {
            await bumpUserSubtitleSearchRevision(revisionConfig);
        }

        res.json({
            success: true,
            cached: false,
            cacheKey: skipCacheWrites ? null : saveResult.cacheKey,
            translatedContent,
            metadata: { ...saveMeta, skipCache: skipCacheWrites || undefined }
        });
    } catch (error) {
        if (embeddedCacheUpdated && revisionConfig) {
            await bumpUserSubtitleSearchRevision(revisionConfig);
        }
        persistHistory('failed', { error: error?.message || 'Unknown error' });
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Embedded Translate]', t)) return;
        log.error(() => ['[Embedded Translate] Error:', error]);
        res.status(500).json({ error: t('server.errors.translateEmbeddedFailed', { reason: error.message || '' }, error.message || 'Failed to translate embedded subtitle') });
    }
});

// Basic HTML escaping for inline HTML pages
function escapeHtml(text) {
    if (text == null) return '';
    const str = String(text);
    const escaped = str.replace(/[&<>"'`=\/]/g, m => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#x27;',
        '/': '&#x2F;',
        '`': '&#x60;',
        '=': '&#x3D;'
    }[m] || m));
    return escaped.replace(/[\u0000-\u001F\u007F-\u009F]/g, ch => `&#${ch.charCodeAt(0)};`);
}

// Middleware to replace {{ADDON_URL}} placeholder in responses
// This is CRITICAL because Stremio SDK uses res.end() not res.json()
app.use('/addon/:config', (req, res, next) => {
    const requestPath = req.originalUrl || req.url || req.path || 'unknown';
    const isSubtitlesRequest = requestPath.includes('/subtitles/');
    const isManifestRequest = requestPath.includes('/manifest.json');
    const isDownloadRequest = requestPath.includes('/subtitle/')
        || requestPath.includes('/subtitle-resolve/')
        || requestPath.includes('/subtitle-content/')
        || requestPath.includes('/translate/');

    // REQUEST TRACE: Log all incoming addon requests (helps diagnose "Stremio not sending requests" issues)
    // This runs BEFORE any processing, so if this doesn't log, the request never reached the server
    if (isSubtitlesRequest || isManifestRequest) {
        log.info(() => `[Addon Request] ${req.method} ${requestPath.substring(0, 100)} (UA: ${(req.get('user-agent') || 'none').substring(0, 50)})`);
    } else if (isDownloadRequest) {
        // Log download requests at DEBUG level (these are frequent)
        log.debug(() => `[Addon Request] ${req.method} ${requestPath.substring(0, 100)}`);
    }

    if (req.__subtitleQueryExtraNormalized?.length) {
        log.debug(() => `[Addon Request] Subtitle extras normalized from query string (${req.__subtitleQueryExtraNormalized.join(',')})`);
    }

    // CRITICAL: Prevent caching to avoid cross-user config contamination
    setNoStore(res);

    const config = req.params.config;

    // Construct base URL from request (same logic as manifest route)
    const host = getSafeHost(req);
    const localhost = isLocalhost(req);
    // For remote hosts, enforce HTTPS unless proxy header specifies otherwise
    const protocol = localhost
        ? (req.get('x-forwarded-proto') || req.protocol)
        : (req.get('x-forwarded-proto') || 'https');
    const addonUrl = `${protocol}://${host}/addon/${encodeURIComponent(config)}${CACHE_BUSTER_PATH}`;

    // Track if response has ended to prevent double-calling res.end()
    let responseEnded = false;

    // Intercept both res.json() and res.end() to replace {{ADDON_URL}} placeholder
    const originalJson = res.json;
    res.json = function (obj) {
        const jsonStr = JSON.stringify(obj);
        const replaced = jsonStr.replace(/\{\{ADDON_URL\}\}/g, addonUrl);
        const parsed = JSON.parse(replaced);

        // Trigger prefetch cooldown for Stremio Community subtitle responses
        // When we serve a subtitle list to a Stremio Community client, set a cooldown
        // to block the subsequent libmpv prefetch storm
        if (isSubtitlesRequest && isStremioCommunityRequest(req)) {
            try {
                // Extract config hash from the request/response for cooldown tracking
                const configHash = res.locals?.configHash || config || 'unknown';
                const subtitleCount = parsed?.subtitles?.length || 0;
                if (subtitleCount > 0) {
                    setStremioCommunityPrefetchCooldown(configHash, subtitleCount);
                }
            } catch (e) {
                log.warn(() => `[Prefetch Cooldown] Failed to set cooldown: ${e.message}`);
            }
        }

        return originalJson.call(this, parsed);
    };

    const originalEnd = res.end;
    res.end = function (chunk, encoding) {
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

            // Trigger prefetch cooldown for Stremio Community subtitle responses (via res.end)
            // SDK uses res.end() with JSON string for subtitle responses
            if (isSubtitlesRequest && isStremioCommunityRequest(req)) {
                try {
                    const parsed = JSON.parse(chunk);
                    const configHash = res.locals?.configHash || config || 'unknown';
                    const subtitleCount = parsed?.subtitles?.length || 0;
                    if (subtitleCount > 0) {
                        setStremioCommunityPrefetchCooldown(configHash, subtitleCount);
                    }
                } catch (e) {
                    // Not JSON or parsing failed - ignore
                }
            }
        }
        // Handle Buffer chunks (convert to string, replace, convert back)
        else if (chunk && Buffer.isBuffer(chunk)) {
            try {
                let str = chunk.toString('utf-8');
                str = str.replace(/\{\{ADDON_URL\}\}/g, addonUrl);

                // Trigger prefetch cooldown for Stremio Community subtitle responses (via Buffer)
                if (isSubtitlesRequest && isStremioCommunityRequest(req)) {
                    try {
                        const parsed = JSON.parse(str);
                        const configHash = res.locals?.configHash || config || 'unknown';
                        const subtitleCount = parsed?.subtitles?.length || 0;
                        if (subtitleCount > 0) {
                            setStremioCommunityPrefetchCooldown(configHash, subtitleCount);
                        }
                    } catch (e) {
                        // Not JSON or parsing failed - ignore
                    }
                }

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

// Bare manifest route for Stremio Community addon list
// This returns a generic manifest without user-specific config, directing users to configure
app.get('/manifest.json', (req, res) => {
    try {
        setNoStore(res);
        const host = getSafeHost(req);
        const localhost = isLocalhost(req);
        const protocol = localhost
            ? (req.get('x-forwarded-proto') || req.protocol)
            : (req.get('x-forwarded-proto') || 'https');
        const baseUrl = `${protocol}://${host}`;

        const isElfHosted = process.env.ELFHOSTED === 'true';
        const addonName = isElfHosted
            ? 'SubMaker | ElfHosted'
            : 'SubMaker - Subtitle Translator';

        const manifest = {
            id: 'com.stremio.submaker',
            version: version,
            name: addonName,
            description: 'Take control of your subtitles! Fetch and translate subtitles from OpenSubtitles, SubScene, and SubDL with AI translation powered by Gemini, OpenAI, Anthropic, and more. Configure the addon to get started.',
            logo: `${baseUrl}/logo.png`,
            icon: `${baseUrl}/logo.png`,
            background: `${baseUrl}/background.svg`,
            catalogs: [],
            resources: ['subtitles'],
            types: ['movie', 'series', 'anime'],
            // Leave idPrefixes unset so Stremio still calls the addon and the
            // server can log + filter unsupported IDs explicitly.
            behaviorHints: {
                configurable: true,
                configurationRequired: true
            },
            contactEmail: 'support@submaker.example.com'
        };

        log.info(() => `[Manifest] Bare manifest request from ${getClientIp(req)}`);
        res.json(manifest);
    } catch (error) {
        log.error(() => ['[Manifest] Bare manifest error:', error]);
        res.status(500).json({ error: 'Failed to generate manifest' });
    }
});

// Stremio addon manifest route (AFTER middleware so URLs get replaced)
app.get('/addon/:config/manifest.json', async (req, res) => {
    try {
        // CRITICAL: Prevent caching to avoid cross-user config contamination
        // Without these headers, proxies/CDNs can cache User A's manifest and serve it to User B
        // This was causing the "random language in Make button" bug reported in v1.4.1
        setNoStore(res);
        let t = res.locals?.t || getTranslatorFromRequest(req, res);

        const rawUrl = req.originalUrl || req.url || '';
        const hasVersionSegment = /\/v[0-9.]+(\/|$)/.test(rawUrl);
        log.info(() => `[Manifest] Request meta ip=${getClientIp(req)} cf=${req.get('cf-connecting-ip') || 'n/a'} xff=${req.get('x-forwarded-for') || 'n/a'} xri=${req.get('x-real-ip') || 'n/a'} ua=${req.get('user-agent') || 'n/a'} origin=${req.get('origin') || 'n/a'} referer=${req.get('referer') || 'n/a'} host=${req.get('host') || 'n/a'} url=${rawUrl || 'n/a'} versioned=${hasVersionSegment}`);
        log.debug(() => `[Manifest] Parsing config for manifest request`);
        const config = await resolveConfigGuarded(req.params.config, req, res, '[Manifest] config', t);
        if (!config) return;
        t = getTranslatorFromRequest(req, res, config);
        ensureConfigHash(config, req.params.config);

        // Construct base URL from request
        const host = getSafeHost(req);
        const localhost = isLocalhost(req);
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
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Manifest]', t)) return;
        log.error(() => ['[Manifest] Error:', error]);
        res.status(500).json({ error: t('server.errors.manifestFailed', {}, 'Failed to generate manifest') });
    }
});

// Custom route: Handle base addon path (when user clicks config in Stremio)
// This route handles /addon/:config (with no trailing path) and redirects to configure
// It must be placed AFTER all specific routes but BEFORE the SDK router
app.get('/addon/:config', (req, res, next) => {
    try {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { config: configStr } = req.params;
        // Defense-in-depth: Prevent caching (redirect includes session token)
        setNoStore(res);
        log.debug(() => `[Addon Base] Request to base addon path, redirecting to configure page`);
        // Redirect to main configure page with config parameter
        res.redirect(302, `/configure?config=${encodeURIComponent(configStr)}`);
    } catch (error) {
        log.error(() => ['[Addon Base] Error:', error]);
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        res.status(500).send(t('server.errors.configPageFailed', {}, 'Failed to load configuration page'));
    }
});

// Mount Stremio SDK router for each configuration
app.use('/addon/:config', async (req, res, next) => {
    try {
        const configStr = req.params.config;
        const isSessionToken = /^[a-f0-9]{32}$/.test(configStr);

        // CRITICAL: Prevent caching of all addon responses (subtitles, manifests, etc.)
        // This ensures users always get their own config, not cached responses from other users
        setNoStore(res);

        // PERFORMANCE: Check cache FIRST (cheap lookup) before fetching config
        // IMPORTANT: Never serve routers from cache for session tokens. If a token is evicted or
        // regenerated, a stale cached router could leak another user's config. Base64 configs are
        // deterministic and safe to cache.
        let router = isSessionToken ? null : routerCache.get(configStr);

        // SECURITY CRITICAL: Multi-layer validation of cached router to prevent contamination
        if (router) {
            let contaminationDetected = false;
            let contaminationReason = '';

            // VALIDATION LAYER 1: Config string must match exactly
            if (router.__configStr !== configStr) {
                contaminationDetected = true;
                contaminationReason = `config mismatch - expected ${redactToken(configStr)}, got ${redactToken(router.__configStr || 'unknown')}`;
            }

            // VALIDATION LAYER 2: Router must have required metadata
            if (!contaminationDetected && (!router.__configStr || !router.__createdAt)) {
                contaminationDetected = true;
                contaminationReason = 'missing required metadata (__configStr or __createdAt)';
            }

            // VALIDATION LAYER 3: Detect if cached router is for a session token (should NEVER happen)
            if (!contaminationDetected && /^[a-f0-9]{32}$/.test(router.__configStr || '')) {
                contaminationDetected = true;
                contaminationReason = `cached router has session token pattern: ${redactToken(router.__configStr)}`;
            }

            // VALIDATION LAYER 4: Check router age - refuse to serve routers older than cache TTL
            if (!contaminationDetected && router.__createdAt) {
                const ageMs = Date.now() - router.__createdAt;
                const maxAgeMs = 1000 * 60 * 60; // 1 hour (matches cache TTL)
                if (ageMs > maxAgeMs * 1.1) { // Allow 10% grace period
                    contaminationDetected = true;
                    contaminationReason = `router age (${Math.round(ageMs / 1000 / 60)}min) exceeds TTL`;
                }
            }

            if (contaminationDetected) {
                log.error(() => `[SECURITY] Router cache CONTAMINATION DETECTED: ${contaminationReason}`);
                routerCache.delete(configStr);
                router = null;
                // Also invalidate the resolve config cache for this key as a safety measure
                if (!isSessionToken) {
                    resolveConfigCache.delete(configStr);
                }
            }
        }

        if (!router) {
            // CRITICAL FIX: Deduplicate concurrent router creation to prevent race conditions
            const dedupKey = `router-creation:${configStr}`;
            router = await deduplicate(dedupKey, async () => {
                // Double-check cache inside deduplication (only for cacheable configs)
                if (!isSessionToken) {
                    const cachedRouter = routerCache.get(configStr);
                    if (cachedRouter) {
                        return cachedRouter;
                    }
                }

                // Cache miss: fetch config (only happens when creating new router)
                const config = await resolveConfigGuarded(configStr, req, res, '[Router] config');
                if (!config) return null;

                // Defensive validation
                if (!config || typeof config !== 'object') {
                    log.error(() => '[Router] CRITICAL: Config invalid, using default');
                    const defaultConfig = getDefaultConfig();
                    defaultConfig.__sessionTokenError = true;
                    ensureConfigHash(defaultConfig, configStr);
                    config = defaultConfig;
                } else {
                    ensureConfigHash(config, configStr);
                }

                // Add tracking metadata
                config.__fetchedAt = Date.now();

                // Log when creating router (helps debug contamination issues)
                log.info(() => `[Router] Creating router for ${redactToken(configStr)}: targets=${JSON.stringify(config.targetLanguages || [])}, sources=${JSON.stringify(config.sourceLanguages || [])}`);

                // CRITICAL DEBUG: Log request details to trace contamination
                const clientIP = req.ip || req.connection?.remoteAddress || 'unknown';
                const userAgent = req.get('user-agent') || 'unknown';
                log.info(() => `[Router] Request details - IP: ${clientIP}, UA: ${userAgent.substring(0, 50)}, ConfigHash: ${config.__configHash || 'none'}`);

                // CRITICAL: Deep clone to prevent shared references between router closures
                const freshConfig = deepCloneConfig(config);

                // Build router
                const host = getSafeHost(req);
                const localhost = isLocalhost(req);
                const protocol = localhost
                    ? (req.get('x-forwarded-proto') || req.protocol)
                    : (req.get('x-forwarded-proto') || 'https');
                const baseUrl = `${protocol}://${host}`;

                const builder = createAddonWithConfig(freshConfig, baseUrl);
                const newRouter = getRouter(builder.getInterface());

                // CRITICAL: Tag router with config string and hash for validation
                newRouter.__configStr = configStr;
                newRouter.__targetLanguages = JSON.stringify(freshConfig.targetLanguages || []);
                newRouter.__createdAt = Date.now();
                newRouter.__configHash = freshConfig.__configHash || 'unknown';

                // SECURITY: Cache router ONLY if all safety checks pass
                // DEFENSE LAYER 1: Must not be a session token
                // DEFENSE LAYER 2: Config must not have error flags
                // DEFENSE LAYER 3: Config string must pass strict validation
                const safeToCache = !isSessionToken
                    && !(freshConfig && freshConfig.__sessionTokenError === true)
                    && isDefinitelyNotToken(configStr)
                    && isSafeToCache(freshConfig);

                if (safeToCache) {
                    routerCache.set(configStr, newRouter);
                    log.debug(() => `[Router] Cached router for ${redactToken(configStr)} with targets: ${newRouter.__targetLanguages}, hash: ${newRouter.__configHash}`);
                } else {
                    // SECURITY ALERT: Prevented unsafe router caching
                    if (isSessionToken) {
                        log.debug(() => `[Router] NOT caching router for session token ${redactToken(configStr)} (expected behavior)`);
                    } else if (freshConfig && freshConfig.__sessionTokenError) {
                        log.warn(() => `[SECURITY] NOT caching router for ${redactToken(configStr)} - has error flag`);
                    } else if (!isDefinitelyNotToken(configStr)) {
                        log.error(() => `[SECURITY] BLOCKED router caching - ${redactToken(configStr)} failed strict token validation`);
                    } else {
                        log.warn(() => `[SECURITY] NOT caching router for ${redactToken(configStr)} - failed safety check`);
                    }
                }

                return newRouter;
            });
        } else {
            // Router served from cache - log for debugging
            log.debug(() => `[Router] Serving cached router for ${redactToken(configStr)}, targets: ${router.__targetLanguages || 'unknown'}, age: ${Date.now() - (router.__createdAt || 0)}ms`);
        }

        if (!router) return; // Storage unavailable response already sent upstream
        router(req, res, next);
    } catch (error) {
        if (respondStorageUnavailable(res, error, '[Router]')) return;
        log.error(() => ['[Router] Error:', error]);
        next(error);
    }
});

// Error handling middleware - Route-specific handlers
// Error handler for /addon/:config/subtitle/* routes (returns SRT format)
app.use('/addon/:config/subtitle', (error, req, res, next) => {
    const t = res.locals?.t || getTranslatorFromRequest(req, res);
    log.error(() => ['[Server] Subtitle Error:', error]);
    sentry.captureError(error, { module: 'SubtitleErrorHandler', path: req.path, method: req.method });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(500).end(`${t('server.errors.subtitleUnavailable', {}, 'ERROR: Subtitle unavailable')}\n\n`);
});

// Error handler for /addon/:config/translate/* routes (returns SRT format)
app.use('/addon/:config/translate', (error, req, res, next) => {
    const t = res.locals?.t || getTranslatorFromRequest(req, res);
    log.error(() => ['[Server] Translation Error:', error]);
    sentry.captureError(error, { module: 'TranslationErrorHandler', path: req.path, method: req.method });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(500).end(`${t('server.errors.translationUnavailable', {}, 'ERROR: Translation unavailable')}\n\n`);
});

// Error handler for /addon/:config/file-translate/* routes (returns redirect/HTML format)
app.use('/addon/:config/file-translate', (error, req, res, next) => {
    const t = res.locals?.t || getTranslatorFromRequest(req, res);
    log.error(() => ['[Server] File Translation Error:', error]);
    sentry.captureError(error, { module: 'FileTranslateErrorHandler', path: req.path, method: req.method });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const message = escapeHtml(t('server.errors.fileTranslationPageFailed', {}, 'Failed to load file translation page'));
    res.status(500).end(`<html><body><p>${message}</p></body></html>`);
});

// Error handler for /addon/:config/sub-toolbox/* routes (returns redirect/HTML format)
app.use('/addon/:config/sub-toolbox', (error, req, res, next) => {
    const t = res.locals?.t || getTranslatorFromRequest(req, res);
    log.error(() => ['[Server] Sub Toolbox Error:', error]);
    sentry.captureError(error, { module: 'SubToolboxErrorHandler', path: req.path, method: req.method });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const message = escapeHtml(t('server.errors.subToolboxPageFailed', {}, 'Failed to load Sub Toolbox page'));
    res.status(500).end(`<html><body><p>${message}</p></body></html>`);
});

// Default error handler for manifest/router and other routes (JSON responses)
app.use((error, req, res, next) => {
    const t = res.locals?.t || getTranslatorFromRequest(req, res);
    log.error(() => ['[Server] General Error:', error]);

    // Send error to Sentry
    sentry.captureError(error, {
        module: 'ExpressErrorHandler',
        path: req.path,
        method: req.method
    });

    res.status(500).json({ error: t('server.errors.internalServerError', {}, 'Internal server error') });
});

// Initialize caches and session manager, then start server
(async () => {
    // =========================================================================
    // PHASE 1: Bind HTTP server IMMEDIATELY so Kubernetes startup probes pass.
    // The readiness middleware (FORCE_SESSION_READY) already gates all
    // session-dependent routes, so no requests will be served with missing
    // sessions — but the port will be open and /health will respond.
    // =========================================================================
    const server = app.listen(PORT, () => {
        log.info(() => `[Startup] HTTP server listening on port ${PORT} (accepting probe connections)`);
    });

    // Setup graceful shutdown handlers right away
    sessionManager.setupShutdownHandlers(server);
    process.on('SIGTERM', () => stopKeepAlivePings());
    process.on('SIGINT', () => stopKeepAlivePings());

    // =========================================================================
    // PHASE 2: Run all the heavy initialization in the background.
    // The server is already accepting connections (probes pass), but the
    // readiness middleware will hold real requests until sessions are loaded.
    // =========================================================================

    try {
        // Initialize sync cache
        await syncCache.initSyncCache();
        log.debug(() => '[Startup] Sync cache initialized successfully');
    } catch (error) {
        log.error(() => '[Startup] Failed to initialize sync cache:', error.message);
    }
    try {
        // Initialize dedicated AutoSub cache
        await autoSubCache.initAutoSubCache();
        log.debug(() => '[Startup] AutoSub cache initialized successfully');
    } catch (error) {
        log.error(() => '[Startup] Failed to initialize AutoSub cache:', error.message);
    }

    // Warm up connections to subtitle providers in background
    // This establishes TLS connections before users need them (saves 150-500ms per provider)
    try {
        log.info(() => '[Startup] Pre-warming connections to subtitle providers...');
        // Run warmup in background, don't block startup
        warmUpConnections().then(results => {
            const successCount = results.filter(r => r.success).length;
            log.info(() => `[Startup] Connection warm-up finished: ${successCount}/${results.length} providers ready`);
        }).catch(error => {
            log.warn(() => `[Startup] Connection warm-up encountered errors: ${error.message}`);
        });
    } catch (error) {
        log.warn(() => '[Startup] Failed to start connection warm-up:', error.message);
    }

    // Start keep-alive pings to maintain warm connections during idle periods
    try {
        startKeepAlivePings();
    } catch (error) {
        log.error(() => '[Startup] Failed to start keep-alive pings:', error.message);
    }

    // Wait for session manager to be ready (this is the slow part with 21K+ Redis sessions)
    try {
        log.info(() => '[Startup] Waiting for session manager to be ready...');
        await sessionManager.waitUntilReady();
        log.info(() => '[Startup] Session manager is ready - sessions loaded successfully');
    } catch (error) {
        log.error(() => ['[Startup] Session manager initialization failed:', error.message]);
        log.warn(() => '[Startup] Continuing startup anyway, but sessions may not be available');
    }

    // SECURITY: Clean up any contaminated cache entries from previous runs
    try {
        cleanupCachesOnStartup();
    } catch (error) {
        log.error(() => ['[Startup] Cache cleanup failed:', error.message]);
    }

    // Initialize Redis pub/sub for cross-instance stream activity (SMDB page linking)
    try {
        await streamActivity.initPubSub();
    } catch (error) {
        log.warn(() => `[Startup] Stream activity pub/sub init failed (non-fatal): ${error.message}`);
    }

    // Run comprehensive startup validation
    try {
        log.info(() => '[Startup] Running infrastructure validation...');
        const validation = await runStartupValidation();
        if (!validation.success) {
            log.error(() => ['[Startup] CRITICAL: Infrastructure validation failed']);
            log.error(() => '[Startup] Server startup ABORTED due to validation errors');
            log.error(() => '[Startup] Please review the validation errors above and fix your configuration');
            process.exit(1);
        }
    } catch (error) {
        log.error(() => ['[Startup] Validation check failed unexpectedly:', error.message]);
        log.warn(() => '[Startup] Continuing startup anyway, but configuration may be invalid');
    }

    // =========================================================================
    // PHASE 3: Print startup banner now that everything is initialized.
    // =========================================================================

    // Get log level and file logging status
    const logLevel = (process.env.LOG_LEVEL || 'warn').toUpperCase();
    const logToFile = process.env.LOG_TO_FILE !== 'false' ? 'ENABLED' : 'DISABLED';
    const logDir = process.env.LOG_DIR || 'logs/';
    const storageType = (process.env.STORAGE_TYPE || 'redis').toUpperCase();
    // Session stats (after readiness, so counts are accurate)
    const activeSessions = sessionManager.cache.size;
    const maxSessions = sessionManager.maxSessions;
    const sessionsInfo = maxSessions ? `${activeSessions} / ${maxSessions}` : String(activeSessions);

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

    // Also print a concise session count line
    console.startup(`Active sessions: ${sessionsInfo}`);

    // =========================================================================
    // Periodic health monitoring (every 5 minutes)
    // Logs key operational metrics so you can spot pressure before users notice.
    // =========================================================================
    const HEALTH_LOG_INTERVAL_MS = parseInt(process.env.HEALTH_LOG_INTERVAL_MS, 10) || (5 * 60 * 1000);
    setInterval(() => {
        try {
            const mem = process.memoryUsage();
            const heapMB = (mem.heapUsed / (1024 * 1024)).toFixed(1);
            const rssMB = (mem.rss / (1024 * 1024)).toFixed(1);
            const localInFlight = inFlightRequests.size;
            const localTranslations = inFlightTranslations.size;
            const sessions = sessionManager.cache.size;
            const pool = getPoolStats();
            const httpSockets = pool?.http?.totalSockets ?? '?';
            const httpsSockets = pool?.https?.totalSockets ?? '?';

            log.warn(() =>
                `[Health] heap=${heapMB}MB rss=${rssMB}MB inflight=${localInFlight} translations=${localTranslations} sessions=${sessions} sockets=${httpSockets}/${httpsSockets} uptime=${Math.floor(process.uptime())}s`
            );
        } catch (err) {
            log.warn(() => `[Health] Periodic health log failed: ${err.message}`);
        }
    }, HEALTH_LOG_INTERVAL_MS).unref?.();
})();

module.exports = app;
