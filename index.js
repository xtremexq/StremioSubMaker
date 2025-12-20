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
const Joi = require('joi');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { pipeline } = require('stream/promises');

const { parseConfig, getDefaultConfig, buildManifest, normalizeConfig, getLanguageSelectionLimits, getDefaultProviderParameters, mergeProviderParameters, selectGeminiApiKey } = require('./src/utils/config');
const { parseSRT, toSRT, sanitizeSubtitleText, srtPairToWebVTT } = require('./src/utils/subtitle');
const { version } = require('./src/utils/version');
const { redactToken } = require('./src/utils/security');
const { getAllLanguages, getLanguageName, toISO6392, findISO6391ByName, canonicalSyncLanguageCode } = require('./src/utils/languages');
const { generateCacheKeys } = require('./src/utils/cacheKeys');
const { getCached: getDownloadCached, saveCached: saveDownloadCached, getCacheStats: getDownloadCacheStats } = require('./src/utils/downloadCache');
const { createSubtitleHandler, handleSubtitleDownload, handleTranslation, getAvailableSubtitlesForTranslation, createLoadingSubtitle, createSessionTokenErrorSubtitle, createOpenSubtitlesAuthErrorSubtitle, createOpenSubtitlesQuotaExceededSubtitle, readFromPartialCache, hasCachedTranslation, purgeTranslationCache, translationStatus, inFlightTranslations, canUserStartTranslation, getHistoryForUser, resolveHistoryUserHash, saveRequestToHistory, resolveHistoryTitle } = require('./src/handlers/subtitles');
const GeminiService = require('./src/services/gemini');
const TranslationEngine = require('./src/services/translationEngine');
const { createProviderInstance, createTranslationProvider, resolveCfWorkersCredentials } = require('./src/services/translationProviderFactory');
const { quickNavScript } = require('./src/utils/quickNav');
const streamActivity = require('./src/utils/streamActivity');
const { translateInParallel } = require('./src/utils/parallelTranslation');
const syncCache = require('./src/utils/syncCache');
const embeddedCache = require('./src/utils/embeddedCache');
const { generateSubtitleSyncPage } = require('./src/utils/syncPageGenerator');
const { generateSubToolboxPage, generateEmbeddedSubtitlePage, generateAutoSubtitlePage } = require('./src/utils/toolboxPageGenerator');
const { generateHistoryPage } = require('./src/utils/historyPageGenerator');
const { deriveVideoHash } = require('./src/utils/videoHash');
const { registerFileUploadRoutes } = require('./src/routes/fileUploadRoutes');
const {
    validateRequest,
    subtitleParamsSchema,
    translationParamsSchema,
    translationSelectorParamsSchema,
    fileTranslationBodySchema,
    configStringSchema,
    validateInput
} = require('./src/utils/validation');
const { getSessionManager } = require('./src/utils/sessionManager');
const { runStartupValidation } = require('./src/utils/startupValidation');
const { StorageUnavailableError } = require('./src/storage/errors');
const { loadLocale, getTranslator, DEFAULT_LANG } = require('./src/utils/i18n');

// Cache-buster path segment for temporary HA cache invalidation
// Default to current package version so it auto-advances on releases
const CACHE_BUSTER_VERSION = process.env.CACHE_BUSTER_VERSION || version;
const CACHE_BUSTER_PATH = `/v${CACHE_BUSTER_VERSION}`;

log.info(() => `[Startup] Cache buster active: ${CACHE_BUSTER_PATH}`);

const PORT = process.env.PORT || 7001;
// Reject suspicious host headers early (defense against host header injection)
// Allow alphanumeric, dots, hyphens, underscores, and optional port
const HOST_HEADER_REGEX = /^[A-Za-z0-9._-]+(?::\d+)?$/;
const TRACE_CONFIG_RESOLVE = process.env.TRACE_CONFIG_RESOLVE === 'true';

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
        return await resolveConfigAsync(configStr, req);
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
            const idKeys = ['videoId', 'video', 'id', 'mediaid', 'imdb', 'tmdb', 'kitsu', 'anidb', 'mal', 'anilist'];
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

const AUTOSUB_MAX_AUDIO_BYTES = parseInt(process.env.AUTOSUB_MAX_AUDIO_BYTES, 10) || 120 * 1024 * 1024; // 120MB cap
const ASSEMBLY_MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024; // 5GB hard limit (AssemblyAI)
const ASSEMBLY_FETCH_TIMEOUT_MS = parseInt(process.env.ASSEMBLY_FETCH_TIMEOUT_MS, 10) || 8 * 60 * 1000;
const ASSEMBLY_POLL_INTERVAL_MS = parseInt(process.env.ASSEMBLY_POLL_INTERVAL_MS, 10) || 5000;
const ASSEMBLY_POLL_TIMEOUT_MS = parseInt(process.env.ASSEMBLY_POLL_TIMEOUT_MS, 10) || 12 * 60 * 1000;
const AUTOSUB_FETCH_TIMEOUT_MS = parseInt(process.env.AUTOSUB_FETCH_TIMEOUT_MS, 10) || 45_000;
const AUTOSUB_CF_TIMEOUT_MS = parseInt(process.env.AUTOSUB_CF_TIMEOUT_MS, 10) || 60_000;

function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const scaled = bytes / Math.pow(1024, idx);
    return `${scaled.toFixed(scaled >= 10 ? 0 : 1)}${units[idx]}`;
}

function looksLikePlaylist(buffer) {
    if (!buffer || buffer.length === 0) return false;
    const slice = buffer.slice(0, 2048).toString('utf8').trim();
    if (!slice) return false;
    return /^#EXTM3U/i.test(slice) || slice.includes('#EXTINF') || slice.includes('EXT-X-STREAM-INF');
}

function looksLikeHtml(buffer) {
    if (!buffer || buffer.length === 0) return false;
    const slice = buffer.slice(0, 1024).toString('utf8').trim();
    if (!slice) return false;
    return /^<!doctype html/i.test(slice) || /^<html/i.test(slice);
}

function isLikelyAudioContentType(contentType = '') {
    const lower = (contentType || '').toLowerCase();
    if (!lower) return false;
    if (lower.startsWith('audio/')) return true;
    return /(aac|wav|flac|ogg|opus|mp3|mpeg|mpga|m4a|weba|webm)/.test(lower);
}

function isLikelyAudioUrl(urlStr = '') {
    const lower = (urlStr || '').toLowerCase();
    return /\.(mp3|aac|m4a|flac|wav|ogg|oga|opus|weba|webm|mpga)(\?|$)/.test(lower);
}

function inferAudioFilename(contentType = '', fallback = 'audio') {
    const lower = (contentType || '').toLowerCase();
    const map = {
        'audio/wav': 'wav',
        'audio/x-wav': 'wav',
        'audio/flac': 'flac',
        'audio/mpeg': 'mp3',
        'audio/mp3': 'mp3',
        'audio/mp4': 'm4a',
        'audio/aac': 'aac',
        'audio/ogg': 'ogg',
        'audio/opus': 'opus',
        'audio/webm': 'webm'
    };
    const ext = map[lower] || (lower.includes('mpeg') ? 'mp3' : '');
    return `${fallback}.${ext || 'bin'}`;
}

async function extractAudioWithFfmpeg(streamUrl, options = {}, logger = null) {
    const logStep = (message, level = 'info') => {
        try {
            if (typeof logger === 'function') logger(message, level);
        } catch (_) { /* ignore logger errors */ }
    };
    // FFmpeg support disabled outside SubMaker xSync to avoid bundled binary installs
    logStep('FFmpeg extraction is disabled in this build', 'warn');
    const error = new Error('FFmpeg extraction is disabled in this build');
    error.code = 'FFMPEG_DISABLED';
    throw error;
}

async function downloadStreamAudio(streamUrl, options = {}, logger = null) {
    const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : AUTOSUB_MAX_AUDIO_BYTES;
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : AUTOSUB_FETCH_TIMEOUT_MS;
    const forceFfmpeg = options.forceFfmpeg === true;
    const filenameHint = (options.filename || '').toString();
    const logStep = (message, level = 'info') => {
        try {
            if (typeof logger === 'function') logger(message, level);
        } catch (_) { /* swallow logger errors */ }
    };
    const urlStr = String(streamUrl || '');
    const looksAdaptive = /\.m3u8(\?|$)/i.test(urlStr) || /\.mpd(\?|$)/i.test(urlStr);
    if (!forceFfmpeg && !looksAdaptive) {
        logStep(`Fetching audio via HTTP range (limit ${formatBytes(maxBytes)})`, 'info');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
            response = await fetch(streamUrl, {
                headers: { Range: `bytes=0-${maxBytes - 1}` },
                signal: controller.signal
            });
        } catch (error) {
            clearTimeout(timeout);
            logStep(`HTTP fetch failed: ${error.message || error}`, 'warn');
            response = null;
        }
        if (response && response.ok && response.body) {
            const contentType = (response.headers.get('content-type') || '').toLowerCase();
            const chunks = [];
            let total = 0;
            try {
                for await (const chunk of response.body) {
                    total += chunk.length;
                    if (total > maxBytes) {
                        throw new Error(`Audio exceeds maximum allowed size (${formatBytes(maxBytes)})`);
                    }
                    chunks.push(chunk);
                }
            } catch (error) {
                clearTimeout(timeout);
                if (error.name === 'AbortError') {
                    logStep('HTTP fetch aborted due to timeout', 'warn');
                } else {
                    logStep(`HTTP fetch stream failed: ${error.message || error}`, 'warn');
                }
            }
            clearTimeout(timeout);
            const buffer = Buffer.concat(chunks);
            const playlistLike = looksLikePlaylist(buffer);
            const htmlLike = looksLikeHtml(buffer);
            const isPlaylistContentType = /mpegurl|m3u8|dash|mpd/.test(contentType);
            const looksAudioType = isLikelyAudioContentType(contentType);
            const looksAudioByUrl = isLikelyAudioUrl(urlStr) || isLikelyAudioUrl(filenameHint);
            const usableAudio = !playlistLike && !htmlLike && !isPlaylistContentType && buffer.length > 0 && (looksAudioType || looksAudioByUrl);
            if (usableAudio) {
                const baseName = (() => {
                    if (!filenameHint) return 'audio';
                    const last = filenameHint.split(/[\\/]/).pop() || '';
                    return (last.split('.').shift() || 'audio').trim() || 'audio';
                })();
                logStep(`Fetched ${formatBytes(buffer.length)} via HTTP range (${contentType || 'unknown'})`, 'info');
                return {
                    buffer,
                    bytes: buffer.length,
                    source: 'http-range',
                    contentType: contentType || '',
                    filename: inferAudioFilename(contentType, baseName)
                };
            }
            const reasons = [];
            if (playlistLike || isPlaylistContentType) reasons.push('playlist/manifest detected');
            if (htmlLike) reasons.push('HTML response detected');
            if (!looksAudioType && !looksAudioByUrl) reasons.push('content is not recognised as audio');
            logStep(`HTTP fetch not usable (${reasons.join('; ') || 'untrusted response'}); FFmpeg fallback is disabled`, 'warn');
        } else if (response) {
            clearTimeout(timeout);
            logStep(`HTTP fetch failed (status ${response.status})`, 'warn');
        }
    }

    // FFmpeg fallback disabled; if we reach here, we cannot fetch audio safely
    const err = new Error('Unable to fetch audio stream without FFmpeg support');
    err.code = 'FFMPEG_DISABLED';
    throw err;
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
    // If next starts with a capitalized word, treat as a likely new sentence/speaker
    if (/^[A-Z]/.test(nextText)) return false;
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
        slice = Math.max(slice || 0, 1200);
        const start = cursor;
        let end = start + slice;
        const last = idx === segments.length - 1;
        if (last || end > (entry.endMs || end)) {
            end = entry.endMs || end;
        }
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
        const finalEntries = expanded.map((entry, idx) => ({
            id: idx + 1,
            timecode: `${formatTimestamp((entry.startMs || 0) / 1000)} --> ${formatTimestamp((entry.endMs || entry.startMs || 0) / 1000)}`,
            text: wrapSrtText(entry.text, opts.maxLineLength || 42, opts.maxLines || 2)
        }));

        return toSRT(finalEntries).trim();
    } catch (_) {
        return stripSpeakerLabelsFromSrt(srt || '').trim();
    }
}

function safeModelKey(model) {
    if (!model) return 'auto';
    return String(model).toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 64) || 'auto';
}

async function transcribeWithCloudflare(audioBuffer, opts = {}) {
    const accountId = (opts.accountId || '').trim();
    const token = (opts.token || '').trim();
    if (!accountId || !token) {
        throw new Error('Cloudflare Workers AI credentials are missing');
    }
    const model = (opts.model || '@cf/openai/whisper').trim();
    // Cloudflare expects the model path with slashes preserved (e.g. @cf/openai/whisper); do not encode slashes
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${encodeURI(model)}`;
    const FormDataCtor = typeof FormData !== 'undefined' ? FormData : global.FormData;
    const BlobCtor = typeof Blob !== 'undefined' ? Blob : require('buffer').Blob;
    if (!FormDataCtor || !BlobCtor) {
        throw new Error('FormData/Blob not available in this environment');
    }
    const formData = new FormDataCtor();
    const blobType = opts.contentType || 'audio/wav';
    const blobName = opts.filename || 'audio.wav';
    formData.append('file', new BlobCtor([audioBuffer], { type: blobType }), blobName);
    if (opts.sourceLanguage) formData.append('language', opts.sourceLanguage);
    // Force diarization for Cloudflare transcription
    formData.append('diarization', 'true');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AUTOSUB_CF_TIMEOUT_MS);
    let response;
    let responseStatus = null;
    try {
        response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json'
            },
            body: formData,
            signal: controller.signal
        });
        responseStatus = response?.status || null;
    } catch (error) {
        clearTimeout(timeout);
        if (error.name === 'AbortError') {
            throw new Error('Cloudflare transcription timed out');
        }
        throw new Error(`Cloudflare transcription failed: ${error.message || error}`);
    }
    clearTimeout(timeout);

    let raw = '';
    let data = null;
    try {
        raw = await response.text();
        data = raw ? JSON.parse(raw) : null;
    } catch (_) {
        data = null;
    }

    if (!response.ok) {
        const cfMessage =
            data?.errors?.[0]?.message ||
            data?.result?.errors?.[0]?.message ||
            data?.error ||
            data?.message ||
            (raw ? raw.slice(0, 400) : '');
        const error = new Error(cfMessage || `Cloudflare Workers AI request failed (${response.status})`);
        error.cfStatus = response.status;
        error.cfBody = raw || '';
        throw error;
    }

    const result = data?.result || data?.data || data;
    if (!result) {
        throw new Error('Cloudflare Workers AI returned an empty response');
    }
    const segments = Array.isArray(result.segments) ? result.segments : [];
    const language = result.language || result.detected_language || result.detectedLanguage || '';
    const text = result.text || result.transcript || '';
    const srtRaw = segments.length ? segmentsToSrt(segments) : (text ? `1\n00:00:00,000 --> 00:00:05,000\n${text}\n` : '');
    const srt = stripSpeakerLabelsFromSrt(srtRaw);

    return {
        srt: srt || '',
        languageCode: (language || '').toString().toLowerCase(),
        model,
        cfStatus: responseStatus,
        segmentCount: Array.isArray(segments) ? segments.length : null,
        raw: result
    };
}

async function downloadFullStreamToFile(streamUrl, options = {}, logger = null) {
    const logStep = (message, level = 'info') => {
        try {
            if (typeof logger === 'function') logger(message, level);
        } catch (_) { /* ignore logger errors */ }
    };
    const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : ASSEMBLY_MAX_UPLOAD_BYTES;
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : ASSEMBLY_FETCH_TIMEOUT_MS;
    const tempPath = path.join(os.tmpdir(), `submaker_assembly_${Date.now()}_${Math.random().toString(16).slice(2)}.bin`);
    let response = null;
    let bytes = 0;
    let writer = null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        logStep(`Downloading full stream locally (limit ${formatBytes(maxBytes)})`, 'info');
        response = await fetch(streamUrl, { signal: controller.signal });
        if (!response || !response.ok || !response.body) {
            throw new Error(`Failed to fetch stream (${response ? response.status : 'no response'})`);
        }
        const declaredLength = Number(response.headers?.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            const err = new Error(`Stream exceeds ${formatBytes(maxBytes)} limit`);
            err.code = 'SIZE_LIMIT';
            throw err;
        }
        writer = fs.createWriteStream(tempPath);
        for await (const chunk of response.body) {
            bytes += chunk.length;
            if (bytes > maxBytes) {
                const err = new Error(`Stream exceeded ${formatBytes(maxBytes)} limit`);
                err.code = 'SIZE_LIMIT';
                throw err;
            }
            if (!writer.write(chunk)) {
                await new Promise((resolve) => writer.once('drain', resolve));
            }
        }
        await new Promise((resolve, reject) => {
            writer.end(() => resolve());
            writer.on('error', reject);
        });
        logStep(`Saved ${formatBytes(bytes)} to temp file for AssemblyAI upload`, 'info');
        const contentType = response.headers?.get('content-type') || '';
        const filename = (() => {
            try {
                const url = new URL(streamUrl);
                const last = (url.pathname || '').split('/').pop() || 'video';
                return last || 'video';
            } catch (_) {
                return 'video';
            }
        })();
        return { path: tempPath, bytes, contentType, filename, source: 'video' };
    } catch (error) {
        if (writer) {
            try { writer.destroy(); } catch (_) { }
        }
        try {
            if (fs.existsSync(tempPath)) fs.unlink(tempPath, () => { });
        } catch (_) { /* ignore cleanup errors */ }
        if (error.name === 'AbortError') {
            throw new Error(`Stream download timed out after ${Math.round(timeoutMs / 1000)}s`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function uploadToAssembly(apiKey, uploadSource = {}, logger = null) {
    if (!apiKey) {
        throw new Error('AssemblyAI API key is missing');
    }
    const logStep = (message, level = 'info') => {
        try {
            if (typeof logger === 'function') logger(message, level);
        } catch (_) { /* ignore logger errors */ }
    };
    const headers = {
        Authorization: apiKey
    };
    if (uploadSource.contentType) headers['Content-Type'] = uploadSource.contentType;
    if (Number.isFinite(uploadSource.bytes)) headers['Content-Length'] = uploadSource.bytes;
    const body = uploadSource.path ? fs.createReadStream(uploadSource.path) : uploadSource.buffer;
    if (!body) throw new Error('No upload source provided for AssemblyAI');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ASSEMBLY_FETCH_TIMEOUT_MS);
    let response;
    let raw = '';
    try {
        logStep(`Uploading ${formatBytes(uploadSource.bytes || 0)} to AssemblyAI`, 'info');
        response = await fetch('https://api.assemblyai.com/v2/upload', {
            method: 'POST',
            headers,
            body,
            signal: controller.signal,
            duplex: uploadSource.path ? 'half' : undefined
        });
        raw = await response.text();
    } catch (error) {
        clearTimeout(timeout);
        if (error.name === 'AbortError') {
            throw new Error('AssemblyAI upload timed out');
        }
        throw error;
    }
    clearTimeout(timeout);

    let data = null;
    try {
        data = raw ? JSON.parse(raw) : null;
    } catch (_) {
        data = null;
    }

    if (!response.ok || !data?.upload_url) {
        const msg = data?.error || data?.message || raw || `AssemblyAI upload failed (${response?.status || 'no status'})`;
        const err = new Error(msg);
        err.responseBody = raw;
        throw err;
    }

    return data.upload_url;
}

/**
 * Normalize language codes to AssemblyAI's supported format.
 * AssemblyAI uses mostly ISO 639-1 codes with some regional variants.
 * @param {string} lang - Input language code (e.g., 'jpn', 'ja', 'japanese', 'chi', 'zh')
 * @returns {string|null} - AssemblyAI-compatible code or null if not supported
 */
function normalizeToAssemblyAILanguage(lang) {
    if (!lang) return null;
    const input = String(lang).toLowerCase().trim();
    if (!input) return null;

    // AssemblyAI supported language codes (direct matches)
    const ASSEMBLYAI_SUPPORTED = new Set([
        'en', 'en_au', 'en_uk', 'en_us', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'hi', 'ja', 'zh',
        'fi', 'ko', 'pl', 'ru', 'tr', 'uk', 'vi', 'af', 'sq', 'am', 'ar', 'hy', 'as', 'az',
        'ba', 'eu', 'be', 'bn', 'bs', 'br', 'bg', 'my', 'ca', 'hr', 'cs', 'da', 'et', 'fo',
        'gl', 'ka', 'el', 'gu', 'ht', 'ha', 'haw', 'he', 'hu', 'is', 'id', 'jw', 'kn', 'kk',
        'km', 'lo', 'la', 'lv', 'ln', 'lt', 'lb', 'mk', 'mg', 'ms', 'ml', 'mt', 'mi', 'mr',
        'mn', 'ne', 'no', 'nn', 'oc', 'pa', 'ps', 'fa', 'ro', 'sa', 'sr', 'sn', 'sd', 'si',
        'sk', 'sl', 'so', 'su', 'sw', 'sv', 'tl', 'tg', 'ta', 'tt', 'te', 'th', 'bo', 'tk',
        'ur', 'uz', 'cy', 'yi', 'yo'
    ]);

    // ISO 639-2/B and ISO 639-2/T to AssemblyAI code mappings
    const ISO_639_2_TO_ASSEMBLY = {
        'jpn': 'ja', 'jap': 'ja', 'japanese': 'ja',
        'zho': 'zh', 'chi': 'zh', 'chinese': 'zh', 'cmn': 'zh', 'mandarin': 'zh',
        'kor': 'ko', 'korean': 'ko',
        'deu': 'de', 'ger': 'de', 'german': 'de',
        'fra': 'fr', 'fre': 'fr', 'french': 'fr',
        'spa': 'es', 'spanish': 'es',
        'por': 'pt', 'portuguese': 'pt',
        'rus': 'ru', 'russian': 'ru',
        'ara': 'ar', 'arabic': 'ar',
        'hin': 'hi', 'hindi': 'hi',
        'ita': 'it', 'italian': 'it',
        'nld': 'nl', 'dut': 'nl', 'dutch': 'nl',
        'pol': 'pl', 'polish': 'pl',
        'tur': 'tr', 'turkish': 'tr',
        'ukr': 'uk', 'ukrainian': 'uk',
        'vie': 'vi', 'vietnamese': 'vi',
        'fin': 'fi', 'finnish': 'fi',
        'afr': 'af', 'afrikaans': 'af',
        'sqi': 'sq', 'alb': 'sq', 'albanian': 'sq',
        'amh': 'am', 'amharic': 'am',
        'hye': 'hy', 'arm': 'hy', 'armenian': 'hy',
        'asm': 'as', 'assamese': 'as',
        'aze': 'az', 'azerbaijani': 'az',
        'bak': 'ba', 'bashkir': 'ba',
        'eus': 'eu', 'baq': 'eu', 'basque': 'eu',
        'bel': 'be', 'belarusian': 'be',
        'ben': 'bn', 'bengali': 'bn',
        'bos': 'bs', 'bosnian': 'bs',
        'bre': 'br', 'breton': 'br',
        'bul': 'bg', 'bulgarian': 'bg',
        'mya': 'my', 'bur': 'my', 'burmese': 'my',
        'cat': 'ca', 'catalan': 'ca',
        'hrv': 'hr', 'croatian': 'hr',
        'ces': 'cs', 'cze': 'cs', 'czech': 'cs',
        'dan': 'da', 'danish': 'da',
        'est': 'et', 'estonian': 'et',
        'fao': 'fo', 'faroese': 'fo',
        'glg': 'gl', 'galician': 'gl',
        'kat': 'ka', 'geo': 'ka', 'georgian': 'ka',
        'ell': 'el', 'gre': 'el', 'greek': 'el',
        'guj': 'gu', 'gujarati': 'gu',
        'hat': 'ht', 'haitian': 'ht',
        'hau': 'ha', 'hausa': 'ha',
        'heb': 'he', 'hebrew': 'he',
        'hun': 'hu', 'hungarian': 'hu',
        'isl': 'is', 'ice': 'is', 'icelandic': 'is',
        'ind': 'id', 'indonesian': 'id',
        'jav': 'jw', 'javanese': 'jw',
        'kan': 'kn', 'kannada': 'kn',
        'kaz': 'kk', 'kazakh': 'kk',
        'khm': 'km', 'khmer': 'km', 'cambodian': 'km',
        'lao': 'lo',
        'lat': 'la', 'latin': 'la',
        'lav': 'lv', 'latvian': 'lv',
        'lin': 'ln', 'lingala': 'ln',
        'lit': 'lt', 'lithuanian': 'lt',
        'ltz': 'lb', 'luxembourgish': 'lb',
        'mkd': 'mk', 'mac': 'mk', 'macedonian': 'mk',
        'mlg': 'mg', 'malagasy': 'mg',
        'msa': 'ms', 'may': 'ms', 'malay': 'ms',
        'mal': 'ml', 'malayalam': 'ml',
        'mlt': 'mt', 'maltese': 'mt',
        'mri': 'mi', 'mao': 'mi', 'maori': 'mi',
        'mar': 'mr', 'marathi': 'mr',
        'mon': 'mn', 'mongolian': 'mn',
        'nep': 'ne', 'nepali': 'ne',
        'nor': 'no', 'norwegian': 'no',
        'nno': 'nn',
        'oci': 'oc', 'occitan': 'oc',
        'pan': 'pa', 'panjabi': 'pa', 'punjabi': 'pa',
        'pus': 'ps', 'pashto': 'ps',
        'fas': 'fa', 'per': 'fa', 'persian': 'fa', 'farsi': 'fa',
        'ron': 'ro', 'rum': 'ro', 'romanian': 'ro',
        'san': 'sa', 'sanskrit': 'sa',
        'srp': 'sr', 'serbian': 'sr',
        'sna': 'sn', 'shona': 'sn',
        'snd': 'sd', 'sindhi': 'sd',
        'sin': 'si', 'sinhala': 'si', 'sinhalese': 'si',
        'slk': 'sk', 'slo': 'sk', 'slovak': 'sk',
        'slv': 'sl', 'slovenian': 'sl',
        'som': 'so', 'somali': 'so',
        'sun': 'su', 'sundanese': 'su',
        'swa': 'sw', 'swahili': 'sw',
        'swe': 'sv', 'swedish': 'sv',
        'tgl': 'tl', 'tagalog': 'tl', 'fil': 'tl', 'filipino': 'tl',
        'tgk': 'tg', 'tajik': 'tg',
        'tam': 'ta', 'tamil': 'ta',
        'tat': 'tt', 'tatar': 'tt',
        'tel': 'te', 'telugu': 'te',
        'tha': 'th', 'thai': 'th',
        'bod': 'bo', 'tib': 'bo', 'tibetan': 'bo',
        'tuk': 'tk', 'turkmen': 'tk',
        'urd': 'ur', 'urdu': 'ur',
        'uzb': 'uz', 'uzbek': 'uz',
        'cym': 'cy', 'wel': 'cy', 'welsh': 'cy',
        'yid': 'yi', 'yiddish': 'yi',
        'yor': 'yo', 'yoruba': 'yo',
        'eng': 'en', 'english': 'en',
        'und': null, 'unknown': null, 'undetermined': null
    };

    // Check if already a supported code
    if (ASSEMBLYAI_SUPPORTED.has(input)) {
        return input;
    }

    // Check if it's an ISO 639-2 code or language name that needs mapping
    if (Object.prototype.hasOwnProperty.call(ISO_639_2_TO_ASSEMBLY, input)) {
        return ISO_639_2_TO_ASSEMBLY[input];
    }

    // Handle regional variants (e.g., 'en-US' -> 'en_us', 'pt-BR' -> 'pt')
    const dashMatch = input.match(/^([a-z]{2,3})[-_]([a-z]{2})$/i);
    if (dashMatch) {
        const base = dashMatch[1].toLowerCase();
        const region = dashMatch[2].toLowerCase();
        // Check for specific English variants
        if (base === 'en') {
            if (region === 'au') return 'en_au';
            if (region === 'gb' || region === 'uk') return 'en_uk';
            if (region === 'us') return 'en_us';
            return 'en';
        }
        // For other languages, just use the base code
        const normalizedBase = ISO_639_2_TO_ASSEMBLY[base] || (ASSEMBLYAI_SUPPORTED.has(base) ? base : null);
        if (normalizedBase) return normalizedBase;
    }

    // Not found - return null to trigger auto-detection
    return null;
}

async function createAssemblyTranscript(apiKey, payload = {}, logger = null) {
    const logStep = (message, level = 'info') => {
        try {
            if (typeof logger === 'function') logger(message, level);
        } catch (_) { /* ignore logger errors */ }
    };

    // Normalize language code to AssemblyAI format
    const rawLangCode = (payload.language_code || payload.languageCode || '').toString().trim();
    const normalizedLang = normalizeToAssemblyAILanguage(rawLangCode);

    // Keep payload compliant with AssemblyAI's transcript schema (unknown keys trigger schema errors)
    const requestBody = {
        punctuate: true,
        format_text: true,
        // Request speaker labels to force diarization (labels are stripped from output)
        speaker_labels: true,
        filter_profanity: false,
        auto_chapters: false,
        disfluencies: true,
        audio_url: payload.audio_url
    };

    // Use normalized language if available, otherwise enable auto-detection
    if (normalizedLang) {
        requestBody.language_code = normalizedLang;
        logStep(`Using language code: ${normalizedLang}${rawLangCode !== normalizedLang ? ` (normalized from: ${rawLangCode})` : ''}`, 'info');
    } else {
        requestBody.language_detection = true;
        if (rawLangCode) {
            logStep(`Language '${rawLangCode}' not supported by AssemblyAI, using auto-detection`, 'warn');
        }
    }
    if (payload.word_boost && Array.isArray(payload.word_boost) && payload.word_boost.length > 0) {
        requestBody.word_boost = payload.word_boost;
    }
    if (typeof payload.boost_param === 'string' && payload.boost_param) {
        requestBody.boost_param = payload.boost_param;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ASSEMBLY_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch('https://api.assemblyai.com/v2/transcript', {
            method: 'POST',
            headers: {
                Authorization: apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.id) {
            const errorDetails = [];
            if (Array.isArray(data?.invalid_keys) && data.invalid_keys.length) {
                errorDetails.push(`invalid keys: ${data.invalid_keys.join(', ')}`);
            }
            if (Array.isArray(data?.valid_keys) && data.valid_keys.length) {
                errorDetails.push(`expected keys include: ${data.valid_keys.slice(0, 8).join(', ')}`);
            }
            const msg = [data?.error || data?.message || `AssemblyAI transcript request failed (${response.status})`, errorDetails.join(' | ')]
                .filter(Boolean)
                .join(' - ');
            const err = new Error(msg);
            err.details = data;
            throw err;
        }
        logStep(`AssemblyAI transcript id: ${data.id}`, 'info');
        return data.id;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('AssemblyAI transcript request timed out');
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function pollAssemblyTranscript(apiKey, transcriptId, logger = null) {
    const logStep = (message, level = 'info') => {
        try {
            if (typeof logger === 'function') logger(message, level);
        } catch (_) { /* ignore logger errors */ }
    };
    const start = Date.now();
    while (Date.now() - start < ASSEMBLY_POLL_TIMEOUT_MS) {
        const response = await fetch(`https://api.assemblyai.com/v2/transcript/${encodeURIComponent(transcriptId)}`, {
            headers: { Authorization: apiKey }
        });
        const data = await response.json().catch(() => null);
        const status = (data?.status || '').toLowerCase();
        if (status === 'completed') {
            logStep('AssemblyAI transcription completed', 'info');
            return data;
        }
        if (status === 'error') {
            const message = data?.error || data?.message || 'AssemblyAI returned an error status';
            const err = new Error(message);
            err.details = data;
            throw err;
        }
        logStep(`AssemblyAI status: ${status || 'pending'}...`, 'info');
        await new Promise((resolve) => setTimeout(resolve, ASSEMBLY_POLL_INTERVAL_MS));
    }
    throw new Error('AssemblyAI transcription timed out');
}

async function fetchAssemblySrt(apiKey, transcriptId, logger = null) {
    const logStep = (message, level = 'info') => {
        try {
            if (typeof logger === 'function') logger(message, level);
        } catch (_) { /* ignore logger errors */ }
    };
    const response = await fetch(`https://api.assemblyai.com/v2/transcript/${encodeURIComponent(transcriptId)}/srt`, {
        headers: { Authorization: apiKey }
    });
    if (!response.ok) {
        logStep(`AssemblyAI SRT fetch failed (${response.status})`, 'warn');
        return '';
    }
    const text = await response.text();
    logStep('Fetched SRT from AssemblyAI', 'info');
    return text || '';
}

function normalizeAssemblyTimeSec(raw) {
    const n = Number(raw ?? 0);
    if (!Number.isFinite(n)) return 0;
    // AssemblyAI returns milliseconds; some clients might already send seconds (floats).
    if (n >= 1000) return n / 1000;
    if (Number.isInteger(n) && n > 10) return n / 1000; // integer but small -> likely ms
    return n; // assume already in seconds (float)
}

function formatAssemblySpeakerLabel(label) {
    if (label === null || label === undefined) return '';
    const raw = String(label).trim();
    if (!raw) return '';
    return /^speaker/i.test(raw) ? raw : `Speaker ${raw}`;
}

function assemblyWordsToSegments(words = [], fallbackText = '', opts = {}) {
    const includeSpeakers = opts.includeSpeakers === true;
    const useSpeakerTurns = opts.useSpeakerTurns !== false;
    if (!Array.isArray(words) || words.length === 0) {
        if (fallbackText) return [{ start: 0, end: Math.max(2, Math.min(8, fallbackText.split(' ').length / 2)), text: fallbackText }];
        return [];
    }
    const segments = [];
    let buffer = [];
    let segStart = null;
    let lastEnd = null;
    let bufferSpeaker = null;
    const flush = () => {
        if (!buffer.length) return;
        const text = buffer.join(' ').trim();
        if (!text) {
            buffer = [];
            return;
        }
        const endTime = lastEnd || (segStart || 0) + 2;
        const speakerLabel = includeSpeakers ? formatAssemblySpeakerLabel(bufferSpeaker) : '';
        const line = speakerLabel ? `${speakerLabel}: ${text}` : text;
        segments.push({
            start: Math.max(0, segStart || 0),
            end: endTime,
            text: line
        });
        buffer = [];
        segStart = null;
        lastEnd = null;
        bufferSpeaker = null;
    };
    words.forEach((word) => {
        const startSec = normalizeAssemblyTimeSec(word.start ?? word.start_time ?? word.offset_start_ms ?? 0);
        const endSec = normalizeAssemblyTimeSec(word.end ?? word.end_time ?? word.offset_end_ms ?? 0);
        const wordSpeaker = useSpeakerTurns ? (word.speaker ?? word.speaker_label ?? word.speaker_id ?? null) : null;
        const speakerChanged = useSpeakerTurns && buffer.length && wordSpeaker !== null && bufferSpeaker !== null && wordSpeaker !== bufferSpeaker;
        if (speakerChanged) {
            flush();
        }
        if (useSpeakerTurns && bufferSpeaker === null && wordSpeaker !== null) {
            bufferSpeaker = wordSpeaker;
        }
        if (segStart === null) segStart = startSec;
        lastEnd = endSec || startSec;
        buffer.push((word.text || word.word || '').toString());
        const text = (word.text || word.word || '').toString();
        const punctuationBreak = /[.?!]/.test(text.slice(-1));
        const hardBreak = buffer.length >= 12 || ((lastEnd - segStart) >= 8);
        if (punctuationBreak || hardBreak) {
            flush();
        }
    });
    flush();
    return segments;
}

function assemblySpeakerSegments(transcriptionData = {}) {
    const utterances = Array.isArray(transcriptionData?.utterances) ? transcriptionData.utterances : [];
    if (utterances.length) {
        return utterances.map((utt) => {
            const start = normalizeAssemblyTimeSec(utt.start ?? utt.start_time ?? utt.offset_start_ms ?? 0);
            const end = normalizeAssemblyTimeSec(utt.end ?? utt.end_time ?? utt.offset_end_ms ?? start + 2);
            const textBody = (utt.text || utt.transcript || '').toString().trim();
            if (!textBody) return null;
            return {
                start: Math.max(0, start),
                end: Math.max(end || start + 2, start + 0.5),
                text: textBody
            };
        }).filter(Boolean);
    }
    return assemblyWordsToSegments(transcriptionData?.words || [], transcriptionData?.text || '', { useSpeakerTurns: true });
}

async function transcribeWithAssemblyAi(streamUrl, opts = {}, logger = null) {
    const logStep = (message, level = 'info') => {
        try {
            if (typeof logger === 'function') logger(message, level);
        } catch (_) { /* ignore logger errors */ }
    };
    const apiKey = (opts.apiKey || '').trim();
    if (!apiKey) {
        throw new Error('AssemblyAI API key is missing');
    }
    let upload = null;
    let transcriptionData = null;
    try {
        if (opts.sendFullVideo === true) {
            try {
                upload = await downloadFullStreamToFile(streamUrl, { maxBytes: ASSEMBLY_MAX_UPLOAD_BYTES, timeoutMs: ASSEMBLY_FETCH_TIMEOUT_MS }, logger);
                upload.source = 'video';
            } catch (error) {
                const fallbackMsg = error?.code === 'SIZE_LIMIT'
                    ? `Full video exceeds ${formatBytes(ASSEMBLY_MAX_UPLOAD_BYTES)}; falling back to audio extraction`
                    : `Full video fetch failed (${error.message}); falling back to audio extraction`;
                logStep(fallbackMsg, 'warn');
                upload = null;
            }
        }

        if (!upload) {
            const audio = await downloadStreamAudio(streamUrl, { maxBytes: AUTOSUB_MAX_AUDIO_BYTES, timeoutMs: Math.max(AUTOSUB_FETCH_TIMEOUT_MS, ASSEMBLY_FETCH_TIMEOUT_MS), filename: opts.filename }, logger);
            upload = {
                buffer: audio.buffer,
                bytes: audio.bytes,
                contentType: audio.contentType || 'audio/wav',
                filename: audio.filename || 'audio.wav',
                source: audio.source || 'audio'
            };
        }

        const uploadUrl = await uploadToAssembly(apiKey, upload, logger);
        const transcriptId = await createAssemblyTranscript(apiKey, {
            audio_url: uploadUrl,
            language_code: opts.sourceLanguage || opts.languageCode || '', // Will be normalized to AssemblyAI format
            // Always request speaker labels to preserve turn splits (labels are removed from the final text)
            speaker_labels: true
        }, logger);
        transcriptionData = await pollAssemblyTranscript(apiKey, transcriptId, logger);
        const diarizedSegments = assemblySpeakerSegments(transcriptionData);
        let srt = diarizedSegments.length ? segmentsToSrt(diarizedSegments) : '';
        const assemblySrt = await fetchAssemblySrt(apiKey, transcriptId, logger);
        if (!srt && assemblySrt) {
            srt = stripSpeakerLabelsFromSrt(assemblySrt);
        }
        if (!srt) {
            const segments = assemblyWordsToSegments(transcriptionData?.words || [], transcriptionData?.text || '');
            srt = segmentsToSrt(segments);
        }
        if (!srt && assemblySrt) {
            srt = stripSpeakerLabelsFromSrt(assemblySrt);
        }
        srt = normalizeAutoSubSrt(srt || '');
        const language = (transcriptionData?.language_code || transcriptionData?.language || transcriptionData?.detected_language || '').toString().toLowerCase();
        return {
            transcription: {
                srt: srt || '',
                // Use detected/specified language; fallback to 'und' if not available
                languageCode: language || opts.sourceLanguage || 'und',
                model: 'assemblyai',
                assemblyId: transcriptId
            },
            meta: {
                assemblyId: transcriptId,
                uploadSource: upload?.source || 'audio',
                uploadedBytes: upload?.bytes || null,
                contentType: upload?.contentType || '',
                usedFullVideo: upload?.source === 'video'
            }
        };
    } finally {
        if (upload && upload.path) {
            try {
                fs.unlink(upload.path, () => { });
            } catch (_) { /* ignore cleanup errors */ }
        }
    }
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
    const maybeBuildProvider = (key, cfgOverride = null) => {
        const params = mergedParams[key] || mergedParams.default || {};
        const cfg = cfgOverride || (providers[key] || {});
        const provider = createProviderInstance(key, cfg, params);
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
                model: modelOverride || config?.geminiModel
            };
        }
        return null;
    };
    const providerConfig = await findProviderConfig();
    if (providerConfig && providerConfig.enabled !== false) {
        const params = mergedParams[desiredKey] || mergedParams.default || {};
        const cfg = { ...providerConfig, model: modelOverride || providerConfig.model || config?.geminiModel };
        const provider = createProviderInstance(desiredKey, cfg, params);
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
        const fallback = maybeBuildProvider('gemini', {
            enabled: true,
            apiKey: geminiKey,
            model: modelOverride || config?.geminiModel
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
        const fallback = maybeBuildProvider(firstAvailable);
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
        log.error(() => `[Dedup] Operation failed: ${shortKey}`, error.message);
        throw error;
    } finally {
        // Clean up immediately after completion
        inFlightRequests.delete(key);
    }
}

function isInvalidSessionConfig(config) {
    return !!(config && config.__sessionTokenError === true);
}

// Create Express app
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by'); // Hide framework fingerprint in responses
// CRITICAL: Disable ETags globally to prevent any conditional caching
// ETags can cause proxies/CDNs to serve stale user-specific content
app.set('etag', false);

// Helper: compute a short hash for a config string (used to scope bypass cache per user/config)
function computeConfigHash(configStr) {
    try {
        const seen = new WeakSet();

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
// - final subtitles get a private, short-lived cache so players (Android) don't keep reloading and resetting offsets
function setSubtitleCacheHeaders(res, mode = 'final') {
    if (mode === 'loading') {
        setNoStore(res);
        return;
    }

    // Remove no-store style headers if they were set earlier in the pipeline
    const headersToClear = [
        'Pragma',
        'Expires',
        'Surrogate-Control',
        'CF-Cache-Status',
        'Cloudflare-CDN-Cache-Control',
        'X-Accel-Expires',
        'X-Cache-Buster'
    ];
    headersToClear.forEach((h) => res.removeHeader(h));

    // Allow only private (device) caching; explicitly block shared/CDN caching
    res.setHeader('Cache-Control', 'private, max-age=86400, s-maxage=0, stale-while-revalidate=300, no-transform');
    res.setHeader('CDN-Cache-Control', 'private, max-age=0, s-maxage=0, no-store');
    res.setHeader('Cloudflare-CDN-Cache-Control', 'private, max-age=0, s-maxage=0, no-store');
    res.setHeader('CF-Cache-Status', 'BYPASS');
    res.setHeader('Vary', 'Accept-Encoding');
}

// Normalize subtitle route params to strip optional extensions (e.g., ".srt" or ".vtt") from :targetLang
// This keeps validation/dedup logic stable while allowing extension-bearing URLs for player MIME detection.
function normalizeSubtitleFormatParams(req, _res, next) {
    try {
        if (req.params && typeof req.params.targetLang === 'string') {
            req.params.targetLang = req.params.targetLang.replace(/\.(srt|vtt)$/i, '');
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
    'https://app.stremio.com'
];
const allowedOriginsNormalized = Array.from(new Set([
    ...allowedOrigins.map(normalizeOrigin),
    ...DEFAULT_STREMIO_WEB_ORIGINS.map(normalizeOrigin)
]));
const STREMIO_ORIGIN_WILDCARD_SUFFIXES = ['.strem.io', '.stremio.one', '.stremio.com'];
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
    return host === 'localhost' || host === '127.0.0.1';
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
    if (isStremioOrigin(origin)) return true; // Trust official Stremio app origins (capacitor/app/stremio schemes)
    const host = getSafeHost(req);
    return normalizedOrigin === normalizeOrigin(`https://${host}`) || normalizedOrigin === normalizeOrigin(`http://${host}`);
}
function applySafeCors(req, res, next) {
    const origin = req.get('origin');
    if (origin && !isOriginAllowed(origin, req)) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        return res.status(403).json({ error: t('server.errors.originNotAllowed', {}, 'Origin not allowed') });
    }
    return cors()(req, res, next);
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
 * @returns {boolean} - True if the 3-click cache reset should be BLOCKED
 */
function shouldBlockCacheReset(clickKey, sourceFileId, config, targetLang) {
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
        if (!canUserStartTranslation(configHash)) {
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

// Security: Rate limiting for embedded translations (client-side extractor workflow)
const embeddedTranslationLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 12, // Slightly higher to allow multiple targets, still constrained
    message: 'Too many embedded translation requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
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
    // Always use IP for session creation rate limiting (not config hash)
    // This prevents attackers from bypassing the limit by changing configs
    keyGenerator: (req) => {
        return `session-create:${ipKeyGenerator(req.ip)}`;
    }
});

// Security: Rate limiting for stats endpoint (prevents abuse and monitoring)
const statsLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute per IP
    message: 'Too many stats requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        return `stats:${ipKeyGenerator(req.ip)}`;
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
        '/api/validate-opensubtitles',
        // Stream change watcher for tool pages (SSE + polling)
        '/api/stream-activity',
        '/api/translate-file',
        '/api/save-synced-subtitle',
        '/api/save-embedded-subtitle',
        '/api/translate-embedded',
        '/sub-toolbox',
        '/sub-history',
        '/embedded-subtitles',
        '/auto-subtitles'
    ];

    const stremioClient = isStremioClient(req);
    const isAddonBrowserPage =
        req.path.startsWith('/addon/') && (
            req.path.includes('/translate-selector/') ||
            req.path.includes('/file-translate/') ||
            req.path.includes('/sync-subtitles/') ||
            req.path.includes('/sub-toolbox/') ||
            req.path.includes('/sub-history/') ||
            req.path.includes('/embedded-subtitles/') ||
            req.path.includes('/auto-subtitles/')
        );

    // CRITICAL FIX: Always allow manifest.json requests (needed for Stremio addon installation)
    const isManifestRequest = req.path.includes('/manifest.json');

    // Allow static files and browser-accessible routes
    const isBrowserAllowed =
        req.path.startsWith('/public/') ||
        req.path.endsWith('.css') ||
        req.path.endsWith('.js') ||
        req.path.endsWith('.html') ||
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
        // Allow if user-agent identifies as Stremio (mobile apps, etc.)
        if (stremioClient) {
            log.debug(() => `[Security] Allowed addon API request (Stremio user-agent): origin=${origin}, user-agent=${userAgent}`);
            return cors()(req, res, next);
        }
        // Block other origins to prevent browser-based abuse from arbitrary websites
        log.warn(() => `[Security] Blocked addon API request - origin: ${origin}, user-agent: ${userAgent}`);
        return res.status(403).json({
            error: t('server.errors.stremioOnly', {}, 'Access denied. This addon must be accessed through Stremio.'),
            hint: t('server.errors.stremioHint', {}, 'If you are using Stremio and seeing this error, please report it as a bug.')
        });
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
    return res.status(403).json({
        error: t('server.errors.browserCorsBlocked', {}, 'Browser-based cross-origin requests to this API route are not allowed. Please use the Stremio client.')
    });
});

// Security: Limit JSON payload size (raised to handle embedded subtitle uploads up to ~5MB)
// NOTE: Embedded extraction uploads the entire SRT from the browser; keep this modest but above 5MB allowance.
app.use(express.json({ limit: '6mb' }));

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
app.use('/addon/:config', (req, res, next) => {
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
        return next();
    }

    // Only redirect addon API routes (skip bare /addon/:config redirect handler)
    const needsRedirect = [
        '/manifest.json',       // addon install
        '/subtitles',           // SDK subtitles handler
        '/subtitle/',           // custom subtitle download
        '/translate',           // translate + translate-selector
        '/learn',               // learn mode
        '/xsync',               // synced subtitles
        '/xembedded',           // embedded subtitles (xEmbed cache)
        '/error-subtitle',      // error subtitles
        '/file-translate',      // toolbox file translation
        '/translate-embedded',  // embedded translation API
        '/sync-subtitles',      // sync tool
        '/sub-toolbox',         // toolbox page
        '/sub-history',         // history page
        '/embedded-subtitles',  // embedded extractor
        '/auto-subtitles'       // auto subtitles tool
    ].some(fragment => req.path.includes(fragment));

    if (needsRedirect) {
        const suffix = req.url.replace(`/addon/${req.params.config}`, '');
        const redirectTarget = `/addon/${encodeURIComponent(req.params.config)}${CACHE_BUSTER_PATH}${suffix || ''}`;
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
        '/js/help-modal.js',
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
        '/api/validate-opensubtitles',
        '/api/translate-file',
        '/api/save-synced-subtitle',
        '/api/save-embedded-subtitle',
        '/api/translate-embedded',
        '/api/stream-activity',
        '/addon',  // CRITICAL: Prevent caching of ALL addon routes (manifest, subtitles, translations)
        '/file-upload',
        '/subtitle-sync',
        '/sub-toolbox',
        '/embedded-subtitles',
        '/auto-subtitles',
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

// Serve configuration page with no-cache to ensure users always get latest version
app.get('/', (req, res) => {
    // CRITICAL: Prevent caching to avoid cross-user config contamination
    setNoStore(res);
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

app.get('/configure', (req, res) => {
    // CRITICAL: Prevent caching to avoid cross-user config contamination (can receive config via query params)
    setNoStore(res);
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Health check endpoint for Kubernetes/Docker readiness and liveness probes
app.get('/health', async (req, res) => {
    try {
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
            sessions: await sessionManager.getStats()
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
            resolvedConfig?.geminiModel || '',
            resolvedConfig?.advancedSettings || {}
        );
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
                    model: resolvedConfig?.geminiModel || '',
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

        const provider = createProviderInstance(
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

app.post('/api/validate-subsource', async (req, res) => {
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
app.post('/api/validate-subdl', async (req, res) => {
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
                    message: t('server.validation.credentialsValid', {}, 'Credentials are valid')
                });
            } else {
                res.json({
                    valid: false,
                    error: t('server.errors.noTokenReceived', {}, 'No token received - credentials may be invalid')
                });
            }
        } catch (apiError) {
            // Check for authentication errors
            if (apiError.response?.status === 401) {
                res.json({
                    valid: false,
                    error: t('server.errors.invalidCredentials', {}, 'Invalid username or password')
                });
            } else if (apiError.response?.status === 406) {
                res.json({
                    valid: false,
                    error: t('server.errors.invalidRequestFormat', {}, 'Invalid request format')
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
            error: (res.locals?.t || getTranslatorFromRequest(req, res))('server.validation.apiError', { reason: error.message }, `API error: ${error.message}`)
        });
    }
});

// API endpoint to validate Gemini API key
app.post('/api/validate-gemini', async (req, res) => {
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
            const configStr = toBase64Url(JSON.stringify(config));
            log.debug(() => '[Session API] Localhost detected and ALLOW_BASE64_CONFIG enabled - using base64 encoding');
            return res.json({
                token: configStr,
                type: 'base64',
                message: t('server.session.usingBase64Localhost', {}, 'Using base64 encoding for localhost')
            });
        }

        // Production mode: create session
        const token = await sessionManager.createSession(config);
        log.debug(() => `[Session API] Created session token: ${redactToken(token)}`);

        res.json({
            token,
            type: 'session',
            expiresIn: process.env.SESSION_MAX_AGE || 90 * 24 * 60 * 60 * 1000
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
// Apply rate limiting to prevent session flooding attacks (update can create new sessions)
app.post('/api/update-session/:token', sessionCreationLimiter, enforceConfigPayloadSize, async (req, res) => {
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

        // Try to update existing session (now checks Redis if not in cache)
        const updated = await sessionManager.updateSession(token, config);

        if (!updated) {
            // Session doesn't exist - create new one instead
            log.debug(() => `[Session API] Session not found, creating new one`);
            const newToken = await sessionManager.createSession(config);
            invalidateRouterCache(token, 'session token expired');
            return res.json({
                token: newToken,
                type: 'session',
                updated: false,
                created: true,
                message: t('server.session.expiredCreated', {}, 'Session expired or not found, created new session'),
                expiresIn: process.env.SESSION_MAX_AGE || 90 * 24 * 60 * 60 * 1000
            });
        }

        log.debug(() => `[Session API] Updated session token: ${redactToken(token)}`);
        invalidateRouterCache(token, 'session update via API');

        res.json({
            token,
            type: 'session',
            updated: true,
            message: t('server.session.updateSuccess', {}, 'Session configuration updated successfully')
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
            serverTime: new Date().toISOString()
        });

        log.info(() => `[Session Validation] Token ${redactToken(token)} validated from IP ${clientIP}, targets: ${JSON.stringify(config.targetLanguages || [])}`);
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Session API] validate-session', t)) return;
        log.error(() => '[Session API] Error validating session:', error);
        res.status(500).json({ error: t('server.errors.sessionValidateFailed', {}, 'Failed to validate session') });
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
                    reason: t('server.errors.sessionNotFoundReason', {}, 'Session not found or expired')
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
                reason: t('server.errors.sessionConfigCorrupted', {}, 'Config payload was empty or corrupted (empty_config_00)')
            });
        }

        return res.json({ config: normalized, token, regenerated: false });
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
            if (geminiKey && config.geminiModel) {
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

            const timeout = clampNumber(incoming.translationTimeout, 5, 600);
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
            config.geminiModel = advancedSettings.geminiModel.trim();
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
        const workflowMode = typeof options.workflow === 'string' ? options.workflow.trim().toLowerCase() : '';
        const timingMode = typeof options.timingMode === 'string' ? options.timingMode.trim().toLowerCase() : '';
        const singleBatchRequested = typeof options.singleBatchMode === 'boolean'
            ? options.singleBatchMode
            : (workflowMode === 'single-pass' || workflowMode === 'single-batch' || workflowMode === 'one-pass');
        const timestampsRequested = typeof options.sendTimestampsToAI === 'boolean'
            ? options.sendTimestampsToAI
            : (timingMode === 'ai-timing' || timingMode === 'ai-timestamps');
        const singleBatchMode = singleBatchRequested || config.singleBatchMode === true;
        const sendTimestampsToAI = (() => {
            if (typeof timestampsRequested === 'boolean') return timestampsRequested;
            return config.advancedSettings?.sendTimestampsToAI === true;
        })();

        config.singleBatchMode = singleBatchMode;
        const advanced = { ...(config.advancedSettings || {}) };
        if (sendTimestampsToAI) {
            advanced.sendTimestampsToAI = true;
        } else {
            delete advanced.sendTimestampsToAI;
        }
        config.advancedSettings = advanced;

        // Get language names for better translation context
        const targetLangName = getLanguageName(targetLanguage) || targetLanguage;
        const sourceLangName = sourceLanguage ? (getLanguageName(sourceLanguage) || sourceLanguage) : 'detected source language';

        // Detect and convert non-SRT uploads to SRT for translation
        let workingContent = content;
        try {
            const trimmed = String(content || '').trimStart();
            const looksLikeVTT = trimmed.startsWith('WEBVTT');
            const looksLikeASS = /\[script info\]/i.test(content) || /\[v4\+? styles\]/i.test(content) || /\[events\]/i.test(content) || /^dialogue\s*:/im.test(content);
            const looksLikeSSA = /\[v4 styles\]/i.test(content) || /\[events\]/i.test(content) || /^dialogue\s*:/im.test(content);

            if (looksLikeVTT) {
                const subsrt = require('subsrt-ts');
                workingContent = subsrt.convert(content, { to: 'srt' });
                log.debug(() => '[File Translation API] Detected VTT upload; converted to SRT');
            } else if (looksLikeASS || looksLikeSSA) {
                // Try enhanced ASS/SSA -> VTT first, then VTT -> SRT
                const assConverter = require('./src/utils/assConverter');
                const format = looksLikeASS ? 'ass' : 'ssa';
                const result = assConverter.convertASSToVTT(content, format);
                if (result && result.success) {
                    const subsrt = require('subsrt-ts');
                    workingContent = subsrt.convert(result.content, { to: 'srt' });
                    log.debug(() => '[File Translation API] Detected ASS/SSA upload; converted to VTT then SRT');
                } else {
                    // Fallback: direct conversion via subsrt-ts if possible
                    try {
                        const subsrt = require('subsrt-ts');
                        workingContent = subsrt.convert(content, { to: 'srt', from: looksLikeASS ? 'ass' : 'ssa' });
                        log.debug(() => '[File Translation API] Fallback ASS/SSA direct conversion to SRT succeeded');
                    } catch (convErr) {
                        log.warn(() => ['[File Translation API] ASS/SSA conversion failed; proceeding with raw content:', (result && result.error) || convErr.message]);
                        workingContent = content;
                    }
                }
            }
        } catch (convError) {
            log.warn(() => ['[File Translation API] Format detection/conversion error; proceeding with original content:', convError.message]);
            workingContent = content;
        }

        // Initialize translation provider (Gemini by default, alternative providers when enabled)
        const { provider: translationProvider, providerName, model, fallbackProviderName } = await createTranslationProvider(config);
        if (!translationProvider || typeof translationProvider.translateSubtitle !== 'function') {
            throw new Error('Translation provider is not configured correctly');
        }
        const effectiveModel = model || config.geminiModel;
        log.debug(() => `[File Translation API] Using provider=${providerName} model=${effectiveModel}`);

        const shouldUseEngine = singleBatchMode || sendTimestampsToAI || process.env.FILE_UPLOAD_FORCE_ENGINE === 'true';
        let translatedContent = null;

        if (shouldUseEngine) {
            try {
                const engine = new TranslationEngine(
                    translationProvider,
                    effectiveModel,
                    config.advancedSettings || {},
                    { singleBatchMode, providerName, fallbackProviderName, enableStreaming: false }
                );
                log.debug(() => `[File Translation API] Using TranslationEngine (singleBatch=${singleBatchMode}, timestamps=${sendTimestampsToAI})`);
                translatedContent = await engine.translateSubtitle(
                    workingContent,
                    targetLangName,
                    config.translationPrompt,
                    null
                );
            } catch (engineErr) {
                if (singleBatchMode || sendTimestampsToAI) {
                    throw engineErr;
                }
                log.warn(() => ['[File Translation API] TranslationEngine failed, falling back to legacy path:', engineErr.message]);
                translatedContent = null;
            }
        }

        if (translatedContent === null) {
            // Estimate token count (prefer real count when the provider supports it)
            let tokenCount = null;
            if (typeof translationProvider.countTokensForTranslation === 'function') {
                try {
                    tokenCount = await translationProvider.countTokensForTranslation(
                        workingContent,
                        targetLangName,
                        config.translationPrompt
                    );
                } catch (err) {
                    log.debug(() => ['[File Translation API] Token count request failed, using estimate:', err.message]);
                }
            }

            const estimatedTokens = tokenCount
                || (typeof translationProvider.estimateTokenCount === 'function'
                    ? translationProvider.estimateTokenCount(workingContent)
                    : Math.ceil(String(workingContent || '').length / 3));
            log.debug(() => `[File Translation API] Estimated tokens: ${estimatedTokens}${tokenCount ? ' (actual)' : ''}`);

            // Use parallel translation for large files (>threshold tokens)
            // Parallel translation provides:
            // - Faster processing through concurrent API calls
            // - Better context preservation with chunk overlap
            // - Improved reliability with per-chunk retries
            const parallelThreshold = parseInt(process.env.PARALLEL_TRANSLATION_THRESHOLD) || 15000;
            const useParallel = estimatedTokens > parallelThreshold;

            if (useParallel) {
                log.debug(() => `[File Translation API] Using parallel translation (${estimatedTokens} tokens)`);

                // Parallel translation configuration (environment variables with fallbacks)
                const maxConcurrency = parseInt(process.env.PARALLEL_MAX_CONCURRENCY) || 3;
                const targetChunkTokens = parseInt(process.env.PARALLEL_CHUNK_SIZE) || 12000;
                const contextSize = parseInt(process.env.PARALLEL_CONTEXT_SIZE) || 3;

                // Parallel translation with context preservation
                translatedContent = await translateInParallel(
                    workingContent,
                    translationProvider,
                    targetLangName,
                    {
                        sourceLanguage: sourceLangName,
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
                translatedContent = await translationProvider.translateSubtitle(
                    workingContent,
                    sourceLangName,
                    targetLangName,
                    config.translationPrompt
                );
            }

            log.debug(() => `[File Translation API] Translation completed (${useParallel ? 'parallel' : 'single-call'})`);
        } else {
            log.debug(() => '[File Translation API] Translation completed via TranslationEngine');
        }


        // Return translated content as plain text
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(translatedContent);

    } catch (error) {
        log.error(() => '[File Translation API] Error:', error);
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        res.status(500).send(t('server.errors.translateFileError', { reason: error.message }, `Translation failed: ${error.message}`));
    }
});

// API endpoint to trigger retranslation (mirrors the 3-click cache reset mechanism)
// This allows the history page to offer a "Retranslate" button that does exactly
// what triple-clicking a subtitle does: purge cache and re-trigger translation
app.get('/api/retranslate', searchLimiter, async (req, res) => {
    try {
        setNoStore(res);
        let t = res.locals?.t || getTranslatorFromRequest(req, res);
        const { config: configStr, sourceFileId, targetLanguage } = req.query;

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
        const configKey = ensureConfigHash(config, configStr);
        const userHash = config.__configHash || config.userHash || '';

        // SAFETY CHECK 1: Block if user is at concurrency limit
        if (!canUserStartTranslation(userHash)) {
            log.warn(() => `[Retranslate API] BLOCKED: User at concurrency limit (user: ${userHash || 'anonymous'})`);
            return res.status(429).json({
                success: false,
                error: t('server.errors.retranslateConcurrencyLimit', {}, 'Cannot retranslate: you have too many translations in progress. Please wait for them to complete.')
            });
        }

        // SAFETY CHECK 2: Block if translation is currently in progress for this subtitle
        const { cacheKey, runtimeKey, bypass, bypassEnabled } = generateCacheKeys(config, sourceFileId, targetLanguage);
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
            log.warn(() => `[Retranslate API] BLOCKED: Translation already in progress for ${sourceFileId}/${targetLanguage} (user: ${userHash})`);
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
        const hadCache = await hasCachedTranslation(sourceFileId, targetLanguage, config);
        const partial = (!hadCache) ? await readFromPartialCache(runtimeKey) : null;
        const hasResetTarget = hadCache || (partial && typeof partial.content === 'string' && partial.content.length > 0);

        if (!hasResetTarget) {
            log.debug(() => `[Retranslate API] No cache found for ${sourceFileId}/${targetLanguage} - proceeding without purge`);
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

            log.debug(() => `[Retranslate API] Purging cache for ${sourceFileId}/${targetLanguage}. Remaining resets this window: ${consumeStatus.remaining}`);
            await purgeTranslationCache(sourceFileId, targetLanguage, config);
        }

        // Build the translation URL that the client should redirect to
        const translateUrl = `/addon/${encodeURIComponent(configStr)}/translate/${encodeURIComponent(sourceFileId)}/${encodeURIComponent(targetLanguage)}`;

        log.info(() => `[Retranslate API] Cache purged for ${sourceFileId}/${targetLanguage}, remaining resets: ${rateLimitStatus.remaining - 1}`);

        return res.json({
            success: true,
            message: t('server.retranslate.success', {}, 'Cache cleared. Translation will restart on next load.'),
            translateUrl,
            remaining: Math.max(0, rateLimitStatus.remaining - 1)
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
    defaultConfig.__regenerated = true;
    defaultConfig.__regeneratedAt = new Date().toISOString();

    // Create a fresh session for this default config
    const newToken = await sessionManager.createSession(defaultConfig);

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
        // CRITICAL: Deep clone to prevent shared references between concurrent requests
        ensureConfigHash(normalized, configStr);
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
app.get('/addon/:config/subtitle/:fileId/:language.srt', searchLimiter, validateRequest(subtitleParamsSchema, 'params'), async (req, res) => {
    try {
        let t = res.locals?.t || getTranslatorFromRequest(req, res);

        const { config: configStr, fileId, language } = req.params;
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

        const langCode = language.replace('.srt', '');

        // Create deduplication key (includes config+language to separate concurrent user requests)
        const dedupKey = `download:${configKey}:${fileId}:${langCode}`;

        // STEP 1: Check download cache first (fastest path - shared with translation flow)
        const cachedContent = getDownloadCached(fileId);
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

            // Decide headers based on content (serve VTT originals when applicable)
            const isVtt = (cachedContent || '').trimStart().startsWith('WEBVTT');
            if (isVtt) {
                res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${fileId}.vtt"`);
            } else {
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${fileId}.srt"`);
            }
            setSubtitleCacheHeaders(res, 'final');
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

        // Decide headers based on content (serve VTT originals when applicable)
        const isVtt = (content || '').trimStart().startsWith('WEBVTT');
        if (isVtt) {
            res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${fileId}.vtt"`);
        } else {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${fileId}.srt"`);
        }
        setSubtitleCacheHeaders(res, 'final');
        res.send(content);

    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Download]', t)) return;
        log.error(() => '[Download] Error:', error);
        res.status(404).send(t('server.errors.subtitleNotFound', {}, 'Subtitle not found'));
    }
});

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

// Custom route: Translation selector page (BEFORE SDK router to take precedence)
app.get('/addon/:config/translate-selector/:videoId/:targetLang', searchLimiter, validateRequest(translationSelectorParamsSchema, 'params'), async (req, res) => {
    try {
        // Defense-in-depth: Prevent caching (already set by early middleware, but explicit is safer)
        setNoStore(res);
        let t = res.locals?.t || getTranslatorFromRequest(req, res);

        const { config: configStr, videoId, targetLang } = req.params;
        const config = await resolveConfigGuarded(configStr, req, res, '[Translation Selector] config', t);
        if (!config) return;
        if (isInvalidSessionConfig(config)) {
            log.warn(() => `[Translation Selector] Blocked due to invalid session token ${redactToken(configStr)}`);
            t = getTranslatorFromRequest(req, res, config);
            return res.status(401).send(t('server.errors.invalidSessionToken', {}, 'Invalid or expired session token'));
        }
        t = getTranslatorFromRequest(req, res, config);
        const configKey = ensureConfigHash(config, configStr);
        const streamFilename = req.query.filename || req.query.file || config?.lastStream?.filename || '';

        // Create deduplication key based on video ID and config
        const dedupKey = `translate-selector:${configKey}:${videoId}:${targetLang}`;

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
        const html = generateTranslationSelectorPage(subtitles, videoId, targetLang, configStr, config, t, res.locals?.uiLanguage, streamFilename);

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);

    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Translation Selector]', t)) return;
        log.error(() => '[Translation Selector] Error:', error);
        res.status(500).send(t('server.errors.subtitleSelectorFailed', {}, 'Failed to load subtitle selector'));
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
        const userAgent = (req.headers['user-agent'] || '').toLowerCase();
        const isAndroid = userAgent.includes('android');
        const mobileQuery = String(req.query.mobileMode || req.query.mobile || '').toLowerCase();
        const queryForcesMobile = ['1', 'true', 'yes', 'on'].includes(mobileQuery);
        const waitForFullTranslation = (config.mobileMode === true) || queryForcesMobile || (isAndroid && config.mobileMode !== false);

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
                const shouldBlock = shouldBlockCacheReset(clickKey, sourceFileId, config, targetLang);

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

        // Check if already in flight BEFORE logging to reduce confusion
        const isAlreadyInFlight = inFlightRequests.has(dedupKey);

        if (isAlreadyInFlight && waitForFullTranslation) {
            // Don't keep piling up long-held connections in mobile mode; the first request will deliver the final SRT
            log.debug(() => `[Translation] Mobile mode duplicate request for ${sourceFileId} to ${targetLang} - short-circuiting with 202 while primary request is held`);
            res.status(202);
            setSubtitleCacheHeaders(res, 'loading');
            res.setHeader('Retry-After', '3');
            return res.send(t('server.errors.translationInProgress', {}, 'Translation already in progress; waiting on primary request.'));
        } else if (isAlreadyInFlight) {
            log.debug(() => `[Translation] Duplicate request detected for ${sourceFileId} to ${targetLang} - checking for partial results`);

            // Generate cache keys using shared utility (single source of truth for cache key scoping)
            const { cacheKey } = generateCacheKeys(config, sourceFileId, targetLang);

            // For duplicate requests, check partial cache FIRST (in-flight translations)
            // Both partial cache and bypass cache use the same scoped key (cacheKey)
            const partialCached = await readFromPartialCache(cacheKey);
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
            const bypassCached = await adapter.get(cacheKey, StorageAdapter.CACHE_TYPES.BYPASS);
            if (bypassCached && typeof bypassCached.content === 'string' && bypassCached.content.length > 0) {
                log.debug(() => `[Translation] Found bypass cache result for ${sourceFileId} (${bypassCached.content.length} chars)`);
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="translated_${targetLang}.srt"`);
                setSubtitleCacheHeaders(res, 'final');
                return res.send(bypassCached.content);
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

        // Check if this is a loading message or actual translation
        const isLoadingMessage = subtitleContent.includes('Please wait while the selected subtitle is being translated') ||
            subtitleContent.includes('Translation is happening in the background') ||
            subtitleContent.includes('Click this subtitle again to confirm translation') ||
            subtitleContent.includes('TRANSLATION IN PROGRESS');
        log.debug(() => `[Translation] Serving ${isLoadingMessage ? 'loading message' : 'translated content'} for ${sourceFileId} (was duplicate: ${isAlreadyInFlight})`);
        log.debug(() => `[Translation] Content length: ${subtitleContent.length} characters, first 200 chars: ${subtitleContent.substring(0, 200)}`);

        // Always use 'attachment' header for Android compatibility
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${isLoadingMessage ? 'translating' : 'translated'}_${targetLang}.srt"`);

        // Disable caching for loading messages so Stremio can poll for updates
        if (isLoadingMessage) {
            setSubtitleCacheHeaders(res, 'loading');
            log.debug(() => `[Translation] Set no-store headers for loading message`);
        } else {
            // Final translations: allow private caching so Android players don't keep reloading and resetting offsets
            setSubtitleCacheHeaders(res, 'final');
            log.debug(() => `[Translation] Set private caching headers for final translation`);
        }

        res.send(subtitleContent);
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
                const shouldBlock = shouldBlockCacheReset(clickKey, sourceFileId, config, targetLang);

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
        let sourceContent = await getDownloadCached(sourceFileId);
        if (!sourceContent) {
            sourceContent = await handleSubtitleDownload(sourceFileId, 'und', config);
            saveDownloadCached(sourceFileId, sourceContent);
        }

        // Normalize source to SRT for pairing
        try {
            const trimmed = (sourceContent || '').trimStart();
            if (trimmed.startsWith('WEBVTT')) {
                const subsrt = require('subsrt-ts');
                sourceContent = subsrt.convert(sourceContent, { to: 'srt' });
            }
        } catch (_) { }

        // If we have partial translation, serve partial VTT immediately
        const partial = await readFromPartialCache(cacheKey);
        if (partial && partial.content) {
            const vtt = srtPairToWebVTT(sourceContent, partial.content, (config.learnOrder || 'source-top'), (config.learnPlacement || 'stacked'));
            res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="learn_${targetLang}.vtt"`);
            return res.send(vtt);
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
            const vtt = srtPairToWebVTT(sourceContent, translatedSrt, (config.learnOrder || 'source-top'), (config.learnPlacement || 'stacked'));
            res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="learn_${targetLang}.vtt"`);
            return res.send(vtt);
        }

        // Start translation in background and serve a loading VTT (source on top, status on bottom)
        handleTranslation(sourceFileId, targetLang, config, {
            filename: sourceContent ? `learn_${targetLang}.srt` : 'unknown',
            videoId: videoId || 'unknown',
            sourceLanguage: 'und',
            from: 'learn'
        }).catch(() => { });

        const loadingSrt = createLoadingSubtitle(config?.uiLanguage || baseConfig?.uiLanguage || 'en');
        const vtt = srtPairToWebVTT(sourceContent, loadingSrt, (config.learnOrder || 'source-top'), (config.learnPlacement || 'stacked'));
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="learn_${targetLang}.vtt"`);
        return res.send(vtt);

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

// Translation History Page
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

        const historyUserHash = resolveHistoryUserHash(config);
        if (!historyUserHash) {
            log.warn(() => '[Sub History Page] Missing config hash for history request - rejecting');
            return res.status(400).send(t('server.errors.missingHistoryHash', {}, 'Missing user hash for history requests'));
        }

        log.debug(() => `[Sub History Page] Loading history for user ${historyUserHash}`);

        const history = await getHistoryForUser(historyUserHash);

        const isPlaceholder = (val) => {
            const v = (val || '').toString().trim().toLowerCase();
            return !v || v === 'unknown' || v === 'stream and refresh' || v === 'streamandrefresh';
        };
        const pickBest = (...candidates) => {
            for (const c of candidates) {
                if (c === undefined || c === null) continue;
                const str = c.toString().trim();
                if (!str || isPlaceholder(str)) continue;
                return str;
            }
            return '';
        };

        // Opportunistic enrichment: use provided/query metadata to fill missing titles/videoIds/filenames
        const fallbackVideoId = pickBest(videoId, config?.videoId, config?.lastStream?.videoId);
        const fallbackFilename = pickBest(filename, config?.lastStream?.filename, config?.streamFilename);
        for (const entry of history) {
            const needsVideo = !entry.videoId || entry.videoId === 'unknown';
            const needsTitle = !entry.title || entry.title === 'unknown' || entry.title === entry.filename;
            const needsFilename = !entry.filename || entry.filename === 'unknown' || isPlaceholder(entry.filename);
            if (!needsVideo && !needsTitle && !needsFilename) continue;
            try {
                const effectiveVideoId = !needsVideo ? entry.videoId : pickBest(fallbackVideoId, entry.videoId);
                const effectiveFilename = !needsFilename ? entry.filename : pickBest(fallbackFilename, entry.filename, entry.title);
                const meta = await resolveHistoryTitle(effectiveVideoId || entry.videoId || '', effectiveFilename || entry.title || entry.filename || '');
                entry.videoId = pickBest(effectiveVideoId, meta.videoId, entry.videoId) || 'unknown';
                entry.filename = pickBest(effectiveFilename, entry.filename, meta.title) || 'unknown';
                entry.title = pickBest(meta.title, entry.title, entry.filename) || 'Unknown title';
                if (meta.season != null) entry.season = meta.season;
                if (meta.episode != null) entry.episode = meta.episode;
                if (!entry.videoHash || entry.videoHash === 'unknown') {
                    entry.videoHash = deriveVideoHash(entry.filename || entry.title || '', entry.videoId);
                }
                await saveRequestToHistory(historyUserHash, entry);
            } catch (e) {
                log.debug(() => [`[Sub History Page] Enrichment skipped:`, e.message]);
            }
        }
        const html = generateHistoryPage(configStr, history, config, videoId, filename);

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[Sub History Page]', t)) return;
        log.error(() => '[Sub History Page] Error:', error);
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
            translationPrompt,
            sendFullVideo = false,
            diarization = false
        } = req.body || {};
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
        const transcriptSrt = normalizeAutoSubSrt(transcriptSrtRaw);
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

        if (engineKey === 'assemblyai' && transcriptSrt) {
            const transcriptBytes = Buffer.byteLength(transcriptSrt, 'utf8');
            logStep(`Using client AssemblyAI transcript (${formatBytes(transcriptBytes)}) from ${audioSource}`, 'info');
            transcription = {
                srt: transcriptSrt,
                languageCode: transcriptLang || sourceLanguage || 'und',
                model: 'assemblyai',
                assemblyId: transcriptPayload.assemblyId || null
            };
            transcriptDiagnostics.audioBytes = audioBytes;
            transcriptDiagnostics.audioSource = audioSource;
            transcriptDiagnostics.contentType = audioContentType;
            transcriptDiagnostics.assemblyId = transcriptPayload.assemblyId || null;
            transcriptDiagnostics.usedFullVideo = transcriptPayload.usedFullVideo === true;
        } else if (engineKey === 'assemblyai') {
            if (!config.assemblyAiApiKey) {
                logStep('AssemblyAI API key missing in config', 'error');
                return respond(400, {
                    error: t('server.errors.apiKeyRequired', {}, 'API key is required'),
                    logTrail
                });
            }
            try {
                logStep(`Running AssemblyAI transcription (sendFullVideo=${sendFullVideo === true})`, 'info');
                const assemblyResult = await transcribeWithAssemblyAi(streamUrl, {
                    apiKey: config.assemblyAiApiKey,
                    sourceLanguage,
                    diarization,
                    sendFullVideo: sendFullVideo === true,
                    filename,
                    videoId
                }, (message, level) => logStep(message, level));
                transcription = assemblyResult?.transcription || null;
                transcriptDiagnostics.audioBytes = assemblyResult?.meta?.uploadedBytes || null;
                transcriptDiagnostics.audioSource = assemblyResult?.meta?.uploadSource || 'assemblyai';
                transcriptDiagnostics.contentType = assemblyResult?.meta?.contentType || '';
                transcriptDiagnostics.assemblyId = assemblyResult?.meta?.assemblyId || '';
                transcriptDiagnostics.usedFullVideo = assemblyResult?.meta?.usedFullVideo === true;
            } catch (error) {
                logStep(`AssemblyAI transcription failed: ${error.message || error}`, 'error');
                return res.status(500).json({
                    error: t('server.errors.transcriptionFailed', {}, `Automatic subtitles failed: ${error.message}`),
                    logTrail
                });
            }
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
        const originalSrt = normalizeAutoSubSrt((transcription && transcription.srt) ? transcription.srt : '');
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
        if (!cacheBlocked) {
            try {
                await syncCache.saveSyncedSubtitle(videoHash, originalLang, originalSourceId, {
                    content: originalSrt,
                    originalSubId: originalSourceId,
                    metadata: baseMetadata
                });
                originalDownloadUrl = `/addon/${encodeURIComponent(configStr)}/xsync/${videoHash}/${originalLang}/${originalSourceId}`;
            } catch (error) {
                log.warn(() => ['[Auto Subs API] Failed to persist original to xSync:', error.message]);
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
                const translationEngine = new TranslationEngine(
                    providerBundle.provider,
                    providerBundle.providerModel,
                    { ...(config.advancedSettings || {}), sendTimestampsToAI: sendTimestampsToAI === true },
                    { singleBatchMode: singleBatchMode === true, providerName: providerBundle.providerName, fallbackProviderName: providerBundle.fallbackProviderName }
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
                                await syncCache.saveSyncedSubtitle(videoHash, targetLang, sourceId, {
                                    content: translated,
                                    originalSubId: originalSourceId,
                                    metadata: {
                                        ...baseMetadata,
                                        provider: providerBundle.providerName,
                                        model: providerBundle.providerModel || providerBundle.providerName,
                                        targetLanguage: targetLang
                                    }
                                });
                                downloadUrl = `/addon/${encodeURIComponent(configStr)}/xsync/${videoHash}/${targetLang}/${sourceId}`;
                            } catch (error) {
                                log.warn(() => ['[Auto Subs API] Failed to persist translated subtitle:', error.message]);
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

        // Get available subtitles for this video
        const subtitleHandler = createSubtitleHandler(config);
        const subtitlesData = await subtitleHandler({
            type: 'movie', id: videoId, extra: {
                filename
            }
        });

        // Generate HTML page for subtitle syncing
        const html = await generateSubtitleSyncPage(subtitlesData.subtitles ||
            [], videoId, filename, configStr, config);

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

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${videoHash}_${lang}_synced.srt"`);
        setSubtitleCacheHeaders(res, 'final');
        res.send(syncedSub.content);

    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[xSync Download]', t)) return;
        log.error(() => '[xSync Download] Error:', error);
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

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${safeVideoHash}_${safeLang}_xembed.srt"`);
        setSubtitleCacheHeaders(res, 'final');
        res.send(match.content);
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

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${safeVideoHash}_${safeLang}_original.srt"`);
        setSubtitleCacheHeaders(res, 'final');
        res.send(match.content);
    } catch (error) {
        const t = res.locals?.t || getTranslatorFromRequest(req, res);
        if (respondStorageUnavailable(res, error, '[xEmbed Original]', t)) return;
        log.error(() => '[xEmbed Original] Error:', error);
        res.status(500).send(t('server.errors.downloadEmbeddedOriginalFailed', {}, 'Failed to download original embedded subtitle'));
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
        const normalizedTargetLang = typeof targetLanguage === 'string' ? targetLanguage.trim().toLowerCase() : '';
        const normalizedSourceLang = typeof sourceLanguageCode === 'string' ? sourceLanguageCode.trim().toLowerCase() : 'und';
        const subtitleContent = typeof content === 'string' ? content : '';
        let mergedMetadata = (metadata && typeof metadata === 'object') ? { ...metadata } : {};
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
        t = getTranslatorFromRequest(req, res, baseConfig);
        const workingConfig = {
            ...baseConfig,
            advancedSettings: { ...(baseConfig.advancedSettings || {}) }
        };

        // Apply TranslationEngine-specific toggles
        const singleBatchMode = (options && typeof options.singleBatchMode === 'boolean')
            ? options.singleBatchMode
            : workingConfig.singleBatchMode === true;
        const sendTimestampsToAI = (options && typeof options.sendTimestampsToAI === 'boolean')
            ? options.sendTimestampsToAI
            : workingConfig.advancedSettings.sendTimestampsToAI === true;
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

            const timeout = clampNumber(incoming.translationTimeout, 5, 600);
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
                workingConfig.geminiModel = overrides.providerModel.trim();
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
                return workingConfig.geminiModel || '';
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
            if (typeof value === 'string') {
                const trimmed = value.trim();
                if (trimmed) return trimmed.slice(0, 200);
            }
            return fallback;
        };
        historyUserHash = resolveHistoryUserHash(baseConfig);
        historyEnabled = !!historyUserHash;
        if (!historyEnabled) {
            log.warn(() => '[History] Skipping history for embedded translation: missing user hash');
        }
        const ensureHistoryEntry = () => {
            if (!historyEnabled) return false;
            if (historyEntry) return true;
            const videoHash = deriveVideoHash(
                normalizeHistoryLabel(mergedMetadata.label || metadata?.label || '', '') || safeVideoHash,
                safeVideoHash || ''
            );
            historyEntry = {
                id: crypto.randomUUID(),
                status: 'processing',
                title: normalizeHistoryLabel(mergedMetadata.label || metadata?.label, `Track ${safeTrackId}`),
                filename: normalizeHistoryLabel(mergedMetadata.label || metadata?.label, `Track ${safeTrackId}`),
                videoId: safeVideoHash || 'unknown',
                videoHash,
                trackId: safeTrackId,
                sourceLanguage: safeSourceLanguage || 'und',
                targetLanguage: safeTargetLanguage,
                createdAt: Date.now(),
                provider: requestedProviderName || workingConfig.mainProvider || 'unknown',
                model: requestedModel || workingConfig.geminiModel || 'default',
                scope: 'embedded'
            };
            persistHistory('processing');
            return true;
        };

        const cacheMatchesOptions = (meta = {}) => {
            if (meta.singleBatchMode !== undefined && meta.singleBatchMode !== singleBatchMode) {
                return false;
            }
            if (meta.sendTimestampsToAI !== undefined && meta.sendTimestampsToAI !== sendTimestampsToAI) {
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

        // Convert VTT to SRT if needed
        try {
            const trimmed = (sourceContent || '').trimStart();
            if (trimmed.startsWith('WEBVTT')) {
                const subsrt = require('subsrt-ts');
                sourceContent = subsrt.convert(sourceContent, { to: 'srt' });
                log.debug(() => '[Embedded Translate] Converted VTT source to SRT for translation');
            }
        } catch (e) {
            log.warn(() => ['[Embedded Translate] VTT to SRT conversion failed; proceeding with original content:', e.message]);
        }

        const targetLangName = getLanguageName(safeTargetLanguage) || safeTargetLanguage;
        const { provider, providerName, model, fallbackProviderName } = await createTranslationProvider(workingConfig);
        if (historyEntry) {
            historyEntry.provider = providerName || fallbackProviderName || historyEntry.provider || requestedProviderName || 'unknown';
            historyEntry.model = model || requestedModel || historyEntry.model || workingConfig.geminiModel || 'default';
            persistHistory('processing');
        }
        const engine = new TranslationEngine(
            provider,
            model || workingConfig.geminiModel,
            workingConfig.advancedSettings || {},
            { singleBatchMode, providerName, fallbackProviderName, enableStreaming: false }
        );

        log.debug(() => `[Embedded Translate] Translating track ${safeTrackId} to ${targetLangName} (singleBatch=${singleBatchMode}, timestamps=${sendTimestampsToAI})`);
        const translatedContent = await engine.translateSubtitle(
            sourceContent,
            targetLangName,
            workingConfig.translationPrompt,
            null
        );

        const saveMeta = {
            ...(mergedMetadata || {}),
            provider: providerName,
            model: model || requestedModel || workingConfig.geminiModel,
            translatedAt: Date.now(),
            singleBatchMode,
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
        } else {
            log.debug(() => `[Embedded Translate] Skipped cache write for ${safeVideoHash}_${safeTargetLanguage}_${safeTrackId} (skipCache=true)`);
        }

        persistHistory('completed', {
            provider: providerName || historyEntry?.provider || 'unknown',
            model: model || requestedModel || historyEntry?.model || workingConfig.geminiModel || 'default',
            cached: false
        });

        res.json({
            success: true,
            cached: false,
            cacheKey: skipCacheWrites ? null : saveResult.cacheKey,
            translatedContent,
            metadata: { ...saveMeta, skipCache: skipCacheWrites || undefined }
        });
    } catch (error) {
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

// Generate HTML page for translation selector
function generateTranslationSelectorPage(subtitles, videoId, targetLang, configStr, config, t, lang, streamFilename = '') {
    const selectedLang = lang || (config && config.uiLanguage) || DEFAULT_LANG;
    const tx = typeof t === 'function' ? t : getTranslator(selectedLang);
    const targetLangName = getLanguageName(targetLang) || targetLang;
    const sourceLangs = config.sourceLanguages.map(lang => getLanguageName(lang) || lang).join(', ');
    const translateQueryParts = [];
    if (videoId) translateQueryParts.push(`videoId=${encodeURIComponent(videoId)}`);
    if (streamFilename) translateQueryParts.push(`filename=${encodeURIComponent(streamFilename)}`);
    const translateQuery = translateQueryParts.length ? `?${translateQueryParts.join('&')}` : '';

    const subtitleOptions = subtitles.map(sub => `
        <div class="subtitle-option">
            <a href="/addon/${encodeURIComponent(configStr)}/translate/${sub.fileId}/${targetLang}.srt${translateQuery}" class="subtitle-link">
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
<html lang="${escapeHtml(selectedLang)}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(tx('server.selector.title', { target: targetLangName }, `Select Subtitle to Translate`))}</title>
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
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.5rem;
            transition: all 0.3s ease;
            width: 100%;
            height: 100%;
        }

        .theme-toggle-icon svg {
            display: block;
            margin: auto;
        }

        .theme-toggle-icon.sun {
            display: block;
        }

        .theme-toggle-icon.moon {
            display: none;
        }

        .theme-toggle-icon.blackhole {
            display: none;
        }

        [data-theme="dark"] .theme-toggle-icon.sun {
            display: none;
        }

        [data-theme="dark"] .theme-toggle-icon.moon {
            display: block;
        }

        [data-theme="dark"] .theme-toggle-icon.blackhole {
            display: none;
        }

        [data-theme="true-dark"] .theme-toggle-icon.sun {
            display: none;
        }

        [data-theme="true-dark"] .theme-toggle-icon.moon {
            display: none;
        }

        [data-theme="true-dark"] .theme-toggle-icon.blackhole {
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
    <style>
        /* Mario-style block + coin animation (perf-friendly: transforms only) */
        .theme-toggle.mario {
            background: linear-gradient(180deg, #f7d13e 0%, #e6b526 60%, #d49c1d 100%);
            border-color: #8a5a00;
            box-shadow:
                inset 0 2px 0 #fff3b0,
                inset 0 -3px 0 #b47a11,
                0 6px 0 #7a4d00,
                0 10px 16px rgba(0,0,0,0.35);
            position: fixed;
        }
        .theme-toggle.mario::before {
            content: '';
            position: absolute;
            width: 5px; height: 5px; border-radius: 50%;
            background: #b47a11;
            top: 6px; left: 6px;
            box-shadow:
                calc(100% - 12px) 0 0 #b47a11,
                0 calc(100% - 12px) 0 #b47a11,
                calc(100% - 12px) calc(100% - 12px) 0 #b47a11;
            opacity: .9;
        }
        .theme-toggle.mario:active { transform: translateY(2px) scale(0.98); box-shadow:
            inset 0 1px 0 #fff3b0,
            inset 0 -1px 0 #b47a11,
            0 4px 0 #7a4d00,
            0 8px 14px rgba(0,0,0,0.3);
        }
        .theme-toggle-icon {
            transition: transform 0.25s ease;
            display: grid;
            place-items: center;
            width: 100%;
            height: 100%;
        }
        .theme-toggle-icon svg {
            display: block;
            filter: drop-shadow(0 2px 0 rgba(0,0,0,0.2));
            margin: auto;
        }
        /* Coin effect */
        .coin { position: fixed; left: 0; top: 0; width: 22px; height: 22px; pointer-events: none; z-index: 10000; transform: translate(-50%, -50%); will-change: transform, opacity; contain: layout paint style; }
        .coin::before { content: ''; display: block; width: 100%; height: 100%; border-radius: 50%;
            background:
                linear-gradient(90deg, rgba(0,0,0,0) 45%, rgba(0,0,0,0.2) 55%) ,
                radial-gradient(40% 40% at 35% 30%, #fff6bf 0%, rgba(255,255,255,0) 70%),
                linear-gradient(180deg, #ffd24a 0%, #ffc125 50%, #e2a415 100%);
            border: 2px solid #8a5a00; box-shadow: 0 2px 0 #7a4d00, inset 0 1px 0 #fff8c6;
        }
        @keyframes coin-pop {
            0% { opacity: 0; transform: translate(-50%, -50%) translateY(0) scale(0.9) rotateY(0deg); }
            10% { opacity: 1; }
            60% { transform: translate(-50%, -50%) translateY(-52px) scale(1.0) rotateY(360deg); }
            100% { opacity: 0; transform: translate(-50%, -50%) translateY(-70px) scale(0.95) rotateY(540deg); }
        }
        .coin.animate { animation: coin-pop 0.7s cubic-bezier(.2,.8,.2,1) forwards; }
        @media (prefers-reduced-motion: reduce) { .coin.animate { animation: none; opacity: 0; } }

        /* Theme variants for subtitle-selection page (light vs default=dark) */
        [data-theme="light"] .theme-toggle.mario {
            background: linear-gradient(180deg, #f7d13e 0%, #e6b526 60%, #d49c1d 100%);
            border-color: #8a5a00;
            box-shadow:
                inset 0 2px 0 #fff3b0,
                inset 0 -3px 0 #b47a11,
                0 6px 0 #7a4d00,
                0 10px 16px rgba(0,0,0,0.35);
        }
        :not([data-theme="light"]) .theme-toggle.mario {
            background: linear-gradient(180deg, #4c6fff 0%, #2f4ed1 60%, #1e2f8a 100%);
            border-color: #1b2a78;
            box-shadow:
                inset 0 2px 0 #b3c4ff,
                inset 0 -3px 0 #213a9a,
                0 6px 0 #16246a,
                0 10px 16px rgba(20,25,49,0.6);
        }
        [data-theme="light"] .theme-toggle.mario::before { background: #b47a11; box-shadow:
            calc(100% - 12px) 0 0 #b47a11,
            0 calc(100% - 12px) 0 #b47a11,
            calc(100% - 12px) calc(100% - 12px) 0 #b47a11;
        }
        :not([data-theme="light"]) .theme-toggle.mario::before { background: #213a9a; box-shadow:
            calc(100% - 12px) 0 0 #213a9a,
            0 calc(100% - 12px) 0 #213a9a,
            calc(100% - 12px) calc(100% - 12px) 0 #213a9a;
        }
    </style>
    <style>
        /* Mario-style block + coin animation (perf-friendly: transforms only) */
        .theme-toggle.mario {
            background: linear-gradient(180deg, #f7d13e 0%, #e6b526 60%, #d49c1d 100%);
            border-color: #8a5a00;
            box-shadow:
                inset 0 2px 0 #fff3b0,
                inset 0 -3px 0 #b47a11,
                0 6px 0 #7a4d00,
                0 10px 16px rgba(0,0,0,0.35);
            position: fixed;
        }
        .theme-toggle.mario::before {
            content: '';
            position: absolute;
            width: 5px; height: 5px; border-radius: 50%;
            background: #b47a11;
            top: 6px; left: 6px;
            box-shadow:
                calc(100% - 12px) 0 0 #b47a11,
                0 calc(100% - 12px) 0 #b47a11,
                calc(100% - 12px) calc(100% - 12px) 0 #b47a11;
            opacity: .9;
        }
        .theme-toggle.mario:active { transform: translateY(2px) scale(0.98); box-shadow:
            inset 0 1px 0 #fff3b0,
            inset 0 -1px 0 #b47a11,
            0 4px 0 #7a4d00,
            0 8px 14px rgba(0,0,0,0.3);
        }
        .theme-toggle-icon {
            transition: transform 0.25s ease;
            display: grid;
            place-items: center;
            width: 100%;
            height: 100%;
        }
        .theme-toggle-icon svg {
            display: block;
            filter: drop-shadow(0 2px 0 rgba(0,0,0,0.2));
            margin: auto;
        }
        /* Coin effect */
        .coin { position: fixed; left: 0; top: 0; width: 22px; height: 22px; pointer-events: none; z-index: 10000; transform: translate(-50%, -50%); will-change: transform, opacity; contain: layout paint style; }
        .coin::before { content: ''; display: block; width: 100%; height: 100%; border-radius: 50%;
            background:
                linear-gradient(90deg, rgba(0,0,0,0) 45%, rgba(0,0,0,0.2) 55%) ,
                radial-gradient(40% 40% at 35% 30%, #fff6bf 0%, rgba(255,255,255,0) 70%),
                linear-gradient(180deg, #ffd24a 0%, #ffc125 50%, #e2a415 100%);
            border: 2px solid #8a5a00; box-shadow: 0 2px 0 #7a4d00, inset 0 1px 0 #fff8c6;
        }
        @keyframes coin-pop {
            0% { opacity: 0; transform: translate(-50%, -50%) translateY(0) scale(0.9) rotateY(0deg); }
            10% { opacity: 1; }
            60% { transform: translate(-50%, -50%) translateY(-52px) scale(1.0) rotateY(360deg); }
            100% { opacity: 0; transform: translate(-50%, -50%) translateY(-70px) scale(0.95) rotateY(540deg); }
        }
        .coin.animate { animation: coin-pop 0.7s cubic-bezier(.2,.8,.2,1) forwards; }
        @media (prefers-reduced-motion: reduce) { .coin.animate { animation: none; opacity: 0; } }

        /* Theme variants for file-translation page (light/dark) */
        [data-theme="light"] .theme-toggle.mario {
            background: linear-gradient(180deg, #f7d13e 0%, #e6b526 60%, #d49c1d 100%);
            border-color: #8a5a00;
            box-shadow:
                inset 0 2px 0 #fff3b0,
                inset 0 -3px 0 #b47a11,
                0 6px 0 #7a4d00,
                0 10px 16px rgba(0,0,0,0.35);
        }
        [data-theme="dark"] .theme-toggle.mario {
            background: linear-gradient(180deg, #4c6fff 0%, #2f4ed1 60%, #1e2f8a 100%);
            border-color: #1b2a78;
            box-shadow:
                inset 0 2px 0 #b3c4ff,
                inset 0 -3px 0 #213a9a,
                0 6px 0 #16246a,
                0 10px 16px rgba(20,25,49,0.6);
        }
        [data-theme="true-dark"] .theme-toggle.mario {
            background: linear-gradient(180deg, #1b1029 0%, #110b1a 60%, #0b0711 100%);
            border-color: #3b2a5d;
            box-shadow:
                inset 0 2px 0 #6b65ff33,
                inset 0 -3px 0 #2b2044,
                0 6px 0 #2a1e43,
                0 0 18px rgba(107,101,255,0.35);
        }
        [data-theme="light"] .theme-toggle.mario::before { background: #b47a11; box-shadow:
            calc(100% - 12px) 0 0 #b47a11,
            0 calc(100% - 12px) 0 #b47a11,
            calc(100% - 12px) calc(100% - 12px) 0 #b47a11;
        }
        [data-theme="dark"] .theme-toggle.mario::before { background: #213a9a; box-shadow:
            calc(100% - 12px) 0 0 #213a9a,
            0 calc(100% - 12px) 0 #213a9a,
            calc(100% - 12px) calc(100% - 12px) 0 #213a9a;
        }
        [data-theme="true-dark"] .theme-toggle.mario::before { background: #2b2044; box-shadow:
            calc(100% - 12px) 0 0 #2b2044,
            0 calc(100% - 12px) 0 #2b2044,
            calc(100% - 12px) calc(100% - 12px) 0 #2b2044;
        }
    </style>
</head>
<body>
    <!-- Theme Toggle Button -->
    <button class="theme-toggle mario" id="themeToggle" aria-label="Toggle theme">
        <span class="theme-toggle-icon sun" aria-hidden="true">
            <svg viewBox="0 0 64 64" width="28" height="28" role="img">
                <defs>
                    <radialGradient id="gSun" cx="50%" cy="50%" r="60%">
                        <stop offset="0%" stop-color="#fff4b0"/>
                        <stop offset="60%" stop-color="#f7d13e"/>
                        <stop offset="100%" stop-color="#e0a81e"/>
                    </radialGradient>
                </defs>
                <g fill="none" stroke="#8a5a00" stroke-linecap="round">
                    <circle cx="32" cy="32" r="13" fill="url(#gSun)" stroke-width="3"/>
                    <g stroke-width="3">
                        <line x1="32" y1="6" x2="32" y2="14"/>
                        <line x1="32" y1="50" x2="32" y2="58"/>
                        <line x1="6" y1="32" x2="14" y2="32"/>
                        <line x1="50" y1="32" x2="58" y2="32"/>
                        <line x1="13" y1="13" x2="19" y2="19"/>
                        <line x1="45" y1="45" x2="51" y2="51"/>
                        <line x1="13" y1="51" x2="19" y2="45"/>
                        <line x1="45" y1="19" x2="51" y2="13"/>
                    </g>
                </g>
            </svg>
        </span>
        <span class="theme-toggle-icon moon" aria-hidden="true">
            <svg viewBox="0 0 64 64" width="28" height="28" role="img">
                <defs>
                    <radialGradient id="gMoon" cx="40%" cy="35%" r="65%">
                        <stop offset="0%" stop-color="#fff7cc"/>
                        <stop offset="70%" stop-color="#f1c93b"/>
                        <stop offset="100%" stop-color="#d19b16"/>
                    </radialGradient>
                    <mask id="mMoon">
                        <rect width="100%" height="100%" fill="#ffffff"/>
                        <circle cx="44" cy="22" r="18" fill="#000000"/>
                    </mask>
                </defs>
                <g fill="none" stroke="#8a5a00">
                    <circle cx="32" cy="32" r="22" fill="url(#gMoon)" stroke-width="3" mask="url(#mMoon)"/>
                </g>
            </svg>
        </span>
        <span class="theme-toggle-icon blackhole" aria-hidden="true">
            <svg viewBox="0 0 64 64" width="28" height="28" role="img">
                <defs>
                    <radialGradient id="gRing" cx="50%" cy="50%" r="50%">
                        <stop offset="0%" stop-color="#6b65ff"/>
                        <stop offset="60%" stop-color="#4b2ed6"/>
                        <stop offset="100%" stop-color="#1a103a"/>
                    </radialGradient>
                </defs>
                <circle cx="32" cy="32" r="12" fill="#000"/>
                <circle cx="32" cy="32" r="20" fill="none" stroke="url(#gRing)" stroke-width="6"/>
            </svg>
        </span>
    </button>
    <div id="episodeToast" class="episode-toast" role="status" aria-live="polite">
        <div class="icon">!</div>
        <div class="content">
            <p class="title" id="episodeToastTitle">${escapeHtml(tx('toolbox.toast.title', {}, 'New stream detected'))}</p>
            <p class="meta" id="episodeToastMeta">${escapeHtml(tx('toolbox.toast.meta', {}, 'A different episode is playing in Stremio.'))}</p>
        </div>
        <button class="close" id="episodeToastDismiss" type="button" aria-label="${escapeHtml(tx('toolbox.toast.dismiss', {}, 'Dismiss notification'))}">×</button>
        <button class="action" id="episodeToastUpdate" type="button">${escapeHtml(tx('toolbox.toast.update', {}, 'Update'))}</button>
    </div>

    <div class="container">
        <h1>${escapeHtml(tx('server.selector.heading', { target: targetLangName }, `Translate to ${targetLangName}`))} <span class="version-badge">v${version}</span></h1>
        <div class="subtitle-header">${escapeHtml(tx('server.selector.subheader', { sources: sourceLangs }, `Select a ${sourceLangs} subtitle to translate`))}</div>
        ${subtitles.length > 0 ? subtitleOptions : `<div class="no-subtitles">${escapeHtml(tx('server.selector.empty', { sources: sourceLangs }, `No ${sourceLangs} subtitles available`))}</div>`}
    </div>

    <script>
    const PAGE = { configStr: ${JSON.stringify(configStr)}, videoId: ${JSON.stringify(videoId)}, filename: ${JSON.stringify(streamFilename || config?.lastStream?.filename || '')}, videoHash: ${JSON.stringify(config?.videoHash || '')} };
    ${quickNavScript()}
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
            } else if (theme === 'dark') {
                html.setAttribute('data-theme', 'dark');
            } else if (theme === 'true-dark') {
                html.setAttribute('data-theme', 'true-dark');
            } else {
                html.setAttribute('data-theme', 'dark');
            }
            localStorage.setItem('theme', theme);
        }

        // Initialize theme on page load
        const initialTheme = getPreferredTheme();
        setTheme(initialTheme);

        // Toggle theme on button click
        function spawnCoin(x, y) {
            try {
                const c = document.createElement('div');
                c.className = 'coin animate';
                c.style.left = x + 'px';
                c.style.top = y + 'px';
                document.body.appendChild(c);
                c.addEventListener('animationend', () => c.remove(), { once: true });
                setTimeout(() => { if (c && c.parentNode) c.remove(); }, 1200);
            } catch (_) {}
        }

        if (themeToggle) {
            themeToggle.addEventListener('click', function(e) {
                const currentTheme = html.getAttribute('data-theme');
                let newTheme;
                if (currentTheme === 'light') {
                    newTheme = 'dark';
                } else if (currentTheme === 'dark') {
                    newTheme = 'true-dark';
                } else {
                    newTheme = 'light';
                }
                setTheme(newTheme);
                if (e && e.clientX != null && e.clientY != null) {
                    spawnCoin(e.clientX, e.clientY);
                }
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

    // Episode change watcher (shared quick-nav version)
    if (typeof window.initStreamWatcher === 'function') {
        window.initStreamWatcher({
            configStr: PAGE.configStr,
            current: { videoId: PAGE.videoId, filename: PAGE.filename, videoHash: PAGE.videoHash },
            buildUrl: (payload) => {
                return '/file-upload?config=' + encodeURIComponent(PAGE.configStr) +
                    '&videoId=' + encodeURIComponent(payload.videoId || '') +
                    '&filename=' + encodeURIComponent(payload.filename || '');
            }
        });
    }
    </script>
</body>
</html>
    `;
}

// Middleware to replace {{ADDON_URL}} placeholder in responses
// This is CRITICAL because Stremio SDK uses res.end() not res.json()
app.use('/addon/:config', (req, res, next) => {
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
app.get('/addon/:config/manifest.json', async (req, res) => {
    try {
        // CRITICAL: Prevent caching to avoid cross-user config contamination
        // Without these headers, proxies/CDNs can cache User A's manifest and serve it to User B
        // This was causing the "random language in Make button" bug reported in v1.4.1
        setNoStore(res);
        let t = res.locals?.t || getTranslatorFromRequest(req, res);

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
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(500).end(`${t('server.errors.subtitleUnavailable', {}, 'ERROR: Subtitle unavailable')}\n\n`);
});

// Error handler for /addon/:config/translate/* routes (returns SRT format)
app.use('/addon/:config/translate', (error, req, res, next) => {
    const t = res.locals?.t || getTranslatorFromRequest(req, res);
    log.error(() => ['[Server] Translation Error:', error]);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(500).end(`${t('server.errors.translationUnavailable', {}, 'ERROR: Translation unavailable')}\n\n`);
});

// Error handler for /addon/:config/translate-selector/* routes (returns HTML format)
app.use('/addon/:config/translate-selector', (error, req, res, next) => {
    const t = res.locals?.t || getTranslatorFromRequest(req, res);
    log.error(() => ['[Server] Translation Selector Error:', error]);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const message = escapeHtml(t('server.errors.subtitleSelectorFailed', {}, 'Failed to load subtitle selector'));
    res.status(500).end(`<html><body><p>${message}</p></body></html>`);
});

// Error handler for /addon/:config/file-translate/* routes (returns redirect/HTML format)
app.use('/addon/:config/file-translate', (error, req, res, next) => {
    const t = res.locals?.t || getTranslatorFromRequest(req, res);
    log.error(() => ['[Server] File Translation Error:', error]);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const message = escapeHtml(t('server.errors.fileTranslationPageFailed', {}, 'Failed to load file translation page'));
    res.status(500).end(`<html><body><p>${message}</p></body></html>`);
});

// Error handler for /addon/:config/sub-toolbox/* routes (returns redirect/HTML format)
app.use('/addon/:config/sub-toolbox', (error, req, res, next) => {
    const t = res.locals?.t || getTranslatorFromRequest(req, res);
    log.error(() => ['[Server] Sub Toolbox Error:', error]);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const message = escapeHtml(t('server.errors.subToolboxPageFailed', {}, 'Failed to load Sub Toolbox page'));
    res.status(500).end(`<html><body><p>${message}</p></body></html>`);
});

// Default error handler for manifest/router and other routes (JSON responses)
app.use((error, req, res, next) => {
    const t = res.locals?.t || getTranslatorFromRequest(req, res);
    log.error(() => ['[Server] General Error:', error]);
    res.status(500).json({ error: t('server.errors.internalServerError', {}, 'Internal server error') });
});

// Initialize sync cache and session manager, then start server
(async () => {
    try {
        // Initialize sync cache
        await syncCache.initSyncCache();
        log.debug(() => '[Startup] Sync cache initialized successfully');
    } catch (error) {
        log.error(() => '[Startup] Failed to initialize sync cache:', error.message);
    }

    // CRITICAL FIX: Wait for session manager to be ready before accepting requests
    // This prevents "session not found" errors during server startup
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

    // Start server and setup graceful shutdown
    const server = app.listen(PORT, () => {
        // Get log level and file logging status
        const logLevel = (process.env.LOG_LEVEL || 'warn').toUpperCase();
        const logToFile = process.env.LOG_TO_FILE !== 'false' ? 'ENABLED' : 'DISABLED';
        const logDir = process.env.LOG_DIR || 'logs/';
        const storageType = (process.env.STORAGE_TYPE || 'redis').toUpperCase();
        // Session stats (after readiness, so counts are accurate)
        // Use synchronous access to cache size for startup banner (storage count requires async)
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

        // Setup graceful shutdown handlers now that server is running
        sessionManager.setupShutdownHandlers(server);
    });
})();

module.exports = app;
