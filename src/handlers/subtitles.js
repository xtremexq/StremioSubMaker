const OpenSubtitlesService = require('../services/opensubtitles');
const OpenSubtitlesV3Service = require('../services/opensubtitles-v3');
const SubDLService = require('../services/subdl');
const SubSourceService = require('../services/subsource');
const GeminiService = require('../services/gemini');
const TranslationEngine = require('../services/translationEngine');
const AniDBService = require('../services/anidb');
const KitsuService = require('../services/kitsu');
const { parseSRT, toSRT, parseStremioId } = require('../utils/subtitle');
const { getLanguageName, getDisplayName } = require('../utils/languages');
const { LRUCache } = require('lru-cache');
const syncCache = require('../utils/syncCache');
const { StorageFactory, StorageAdapter } = require('../storage');
const { getCached: getDownloadCached, saveCached: saveDownloadCached } = require('../utils/downloadCache');
const log = require('../utils/logger');
const { generateCacheKeys } = require('../utils/cacheKeys');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Initialize storage adapter (will be set on first use)
let storageAdapter = null;
async function getStorageAdapter() {
  if (!storageAdapter) {
    storageAdapter = await StorageFactory.getStorageAdapter();
  }
  return storageAdapter;
}

// Initialize anime ID mapping services
const anidbService = new AniDBService();
const kitsuService = new KitsuService();

// Redact/noise-reduce helper for logging large cache keys
function shortKey(v) {
  try {
    return crypto.createHash('sha1').update(String(v)).digest('hex').slice(0, 8);
  } catch (_) {
    const s = String(v || '');
    return s.length > 12 ? s.slice(0, 12) + 'â€¦' : s;
  }
}

// Track per-user concurrent translations (limit enforcement)
// Use LRUCache with max 50k users and a 24h TTL so stale counts expire naturally
const userTranslationCounts = new LRUCache({
  max: 50000, // Max 50k unique users tracked
  ttl: 24 * 60 * 60 * 1000, // 24 hours - auto-cleanup stale entries
  updateAgeOnGet: false,
});
const MAX_CONCURRENT_TRANSLATIONS_PER_USER = 3;

// Security: LRU cache for in-progress translations (max 500 entries)
const translationStatus = new LRUCache({
  max: 500,
  ttl: 10 * 60 * 1000, // 10 minutes
  updateAgeOnGet: false,
});

// Security: LRU cache for request deduplication for subtitle searches (max 200 entries)
const inFlightSearches = new LRUCache({
  max: 200,
  ttl: 5000, // 5 seconds
  updateAgeOnGet: false,
});

// Performance: LRU cache for completed subtitle search results
// Caches completed subtitle searches to avoid repeated API calls for identical queries
// This significantly reduces latency and API load for popular content (e.g., trending shows)
// IMPORTANT: Cache is user-scoped (includes config hash) to prevent cache sharing between different configs
// Environment variable configuration:
// - SUBTITLE_SEARCH_CACHE_MAX: Maximum number of cached searches (default: 15000)
// - SUBTITLE_SEARCH_CACHE_TTL_MS: Time-to-live in milliseconds (default: 600000 = 10 minutes)
const SUBTITLE_SEARCH_CACHE_MAX = parseInt(process.env.SUBTITLE_SEARCH_CACHE_MAX) || 15000;
const SUBTITLE_SEARCH_CACHE_TTL_MS = parseInt(process.env.SUBTITLE_SEARCH_CACHE_TTL_MS) || (10 * 60 * 1000); // 10 minutes

const subtitleSearchResultsCache = new LRUCache({
  max: SUBTITLE_SEARCH_CACHE_MAX,
  ttl: SUBTITLE_SEARCH_CACHE_TTL_MS,
  updateAgeOnGet: true, // Popular content stays cached longer
});

// Security: In-flight translation requests to prevent duplicate translations (max 500 entries)
// Maps cacheKey -> Promise that all simultaneous requests will wait for
const inFlightTranslations = new LRUCache({
  max: 500,
  ttl: 30 * 60 * 1000, // 30 minutes
  updateAgeOnGet: false,
});

// Directory for persistent translation cache (disk-only)
const CACHE_DIR = path.join(__dirname, '..', '..', '.cache', 'translations');
// Directory for bypass translation cache (disk-only, TTL-based) - for user bypass cache config
const BYPASS_CACHE_DIR = path.join(__dirname, '..', '..', '.cache', 'translations_bypass');
// Directory for partial translation cache during chunking/streaming - separate from user config
const PARTIAL_CACHE_DIR = path.join(__dirname, '..', '..', '.cache', 'translations_partial');

// Security: Maximum cache size (50GB)
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024 * 1024; // 50GB

// Cache metrics for monitoring
const cacheMetrics = {
  hits: 0,
  misses: 0,
  diskReads: 0,
  diskWrites: 0,
  apiCalls: 0,
  estimatedCostSaved: 0, // in USD
  totalCacheSize: 0, // in bytes
  filesEvicted: 0,
  lastReset: Date.now()
};

/**
 * Create a single-cue loading subtitle that explains partial loading
 * @returns {string} - SRT formatted loading subtitle
 */
function createLoadingSubtitle() {
  const srt = `1
00:00:00,000 --> 04:00:00,000
TRANSLATION IN PROGRESS
Partial results will appear as they are ready. (~15s)`;

  // Log the loading subtitle for debugging
  log.debug(() => ['[Subtitles] Created loading subtitle with', srt.split('\n\n').length, 'entries']);
  return srt;
}

// Helpers to build partial SRT with an end-of-file warning block
function srtTimeToMs(t) {
  // t like HH:MM:SS,mmm
  const m = /^([0-9]{2}):([0-9]{2}):([0-9]{2}),([0-9]{3})$/.exec(String(t).trim());
  if (!m) return 0;
  const hh = parseInt(m[1], 10) || 0;
  const mm = parseInt(m[2], 10) || 0;
  const ss = parseInt(m[3], 10) || 0;
  const ms = parseInt(m[4], 10) || 0;
  return (((hh * 60 + mm) * 60) + ss) * 1000 + ms;
}

function msToSrtTime(ms) {
  ms = Math.max(0, Math.floor(ms));
  const hh = Math.floor(ms / 3600000); ms %= 3600000;
  const mm = Math.floor(ms / 60000); ms %= 60000;
  const ss = Math.floor(ms / 1000); const mmm = ms % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)},${String(mmm).padStart(3, '0')}`;
}

function buildPartialSrtWithTail(mergedSrt) {
  try {
    if (!mergedSrt || typeof mergedSrt !== 'string' || mergedSrt.trim().length === 0) {
      return null; // Nothing to work with
    }

    const entries = parseSRT(mergedSrt);
    if (!entries || entries.length === 0) {
      // If we have raw text but no valid SRT entries yet, still return something
      // so users see progress instead of a loading screen
      // Append a loading indicator
      const lineCount = mergedSrt.split('\n').length + 10;
      return `${mergedSrt}\n\n${lineCount}\n00:00:00,000 --> 04:00:00,000\nTRANSLATION IN PROGRESS\nReload this subtitle to get more`;
    }

    const reindexed = entries.map((e, idx) => ({ id: idx + 1, timecode: e.timecode, text: (e.text || '').trim() }))
                             .filter(e => e.timecode && e.text);

    if (reindexed.length === 0) {
      // No valid entries after filtering, but we have content - append loading tail
      const lineCount = mergedSrt.split('\n').length + 10;
      return `${mergedSrt}\n\n${lineCount}\n00:00:00,000 --> 04:00:00,000\nTRANSLATION IN PROGRESS\nReload this subtitle to get more`;
    }

    const last = reindexed[reindexed.length - 1];
    let end = '00:00:00,000';
    if (last && typeof last.timecode === 'string') {
      const parts = last.timecode.split('-->');
      if (parts[1]) end = parts[1].trim();
    }
    // Ensure tail starts at or after last end
    const tailStartMs = srtTimeToMs(end);
    const tailStart = msToSrtTime(tailStartMs);
    const tail = {
      id: reindexed.length + 1,
      timecode: `${tailStart} --> 04:00:00,000`,
      text: 'TRANSLATION IN PROGRESS\nReload this subtitle later to get more'
    };
    const full = [...reindexed, tail];
    return toSRT(full);
  } catch (e) {
    log.warn(() => `[Subtitles] Error building partial SRT with tail: ${e.message}`);
    // As fallback, if we have content, append a simple loading tail
    if (mergedSrt && typeof mergedSrt === 'string' && mergedSrt.trim().length > 0) {
      const lineCount = mergedSrt.split('\n').length + 10;
      return `${mergedSrt}\n\n${lineCount}\n00:00:00,000 --> 04:00:00,000\nTRANSLATION IN PROGRESS\nReload this subtitle later to get more`;
    }
    return null;
  }
}

/**
 * Create an error subtitle for session token not found
 * @returns {string} - SRT formatted error subtitle
 */
function createSessionTokenErrorSubtitle() {
  const srt = `1
00:00:00,000 --> 00:00:03,000
Configuration Error\nYour session token was not found or has expired.

2
00:00:03,001 --> 00:00:06,000
Please recreate your SubMaker configuration to continue using the addon.

3
00:00:06,001 --> 04:00:00,000
Session Token Error\nSomething is wrong or an update broke your SubMaker config.\nSorry! Please reconfig and reinstall the addon.
`;

  return srt;
}

/**
 * Create an error subtitle for OpenSubtitles authentication failure
 * Single cue from 0 to 4h with 2 lines
 * @returns {string}
 */
function createOpenSubtitlesAuthErrorSubtitle() {
  return `1
00:00:00,000 --> 04:00:00,000
OpenSubtitles login failed
Please fix your username/password in addon config`;
}

// Create a concise error subtitle when a source file looks invalid/corrupted
function createInvalidSubtitleMessage(reason = 'The subtitle file appears to be invalid or incomplete.') {
  const srt = `1
00:00:00,000 --> 00:00:08,000
Subtitle Problem Detected

2
00:00:08,001 --> 04:00:18,000
${reason}\nAn error occurred. Please try again.`;
  return srt;
}

// Create an SRT explaining concurrency limit reached, visible across the whole video timeline
function createConcurrencyLimitSubtitle(limit = MAX_CONCURRENT_TRANSLATIONS_PER_USER) {
  return `1
00:00:00,000 --> 04:00:00,000
Too many concurrent translations for this user (limit: ${limit}).\nPlease wait for one to finish, then try again.`;
}

// Create an SRT explaining a translation error, visible across the whole video timeline
// User can click again to retry the translation
function createTranslationErrorSubtitle(errorType, errorMessage) {
  // Determine error title based on type
  let errorTitle = 'Translation Failed';
  let errorExplanation = errorMessage || 'An unexpected error occurred during translation.';
  let retryAdvice = 'An unexpected error occurred.\nClick this subtitle again to retry translation.';

  if (errorType === '403') {
    errorTitle = 'Translation Failed: Authentication Error (403)';
    errorExplanation = 'Your Gemini API key is invalid or rejected.\nPlease check that your API key is correct.';
    retryAdvice = 'Update your Gemini API key in the addon configuration,\nthen reinstall the addon and try again.';
  } else if (errorType === '503') {
    errorTitle = 'Translation Failed: Service Overloaded (503)';
    errorExplanation = 'The Gemini API is temporarily overloaded with requests.\nThis is usually temporary and resolves within minutes.';
    retryAdvice = '(503) Service Unavailable - Wait a moment for Gemini to recover,\nthen click this subtitle again to retry translation.';
  } else if (errorType === '429') {
    errorTitle = 'Translation Failed: Usage Limit Reached (429)';
    errorExplanation = 'Your Gemini API usage limit has been exceeded.\nThis may be a rate limit or quota limit.';
    retryAdvice = '(429) API Rate/Quota Limit - Gemini API is limiting your API key requests.\nWait a few minutes, then click again to retry.';
  } else if (errorType === 'MAX_TOKENS') {
    errorTitle = 'Translation Failed: Content Too Large';
    errorExplanation = 'The subtitle file is too large for a single translation.\nThe system attempted chunking but still exceeded limits.';
    retryAdvice = '(MAX_TOKENS) Try translating a different subtitle file.\nAnother model may help. Please let us know if this persists.';
  } else if (errorType === 'SAFETY') {
    errorTitle = 'Translation Failed: Content Filtered';
    errorExplanation = 'The subtitle content was blocked by safety filters.\nThis is rare and usually a false positive.';
    retryAdvice = '(PROHIBITED_CONTENT) Subtitle content was filtered by Gemini.\nPlease retry, or try a different subtitle from the list.';
  } else if (errorType === 'PROHIBITED_CONTENT') {
    errorTitle = 'Translation Failed: Content Filtered';
    errorExplanation = 'The subtitle content was blocked by safety filters.\nThis is rare and usually a false positive.';
    retryAdvice = '(PROHIBITED_CONTENT) Subtitle content was filtered by Gemini.\nPlease retry, or try a different subtitle from the list.';
  } else if (errorType === 'INVALID_SOURCE') {
    errorTitle = 'Translation Failed: Invalid Source File';
    errorExplanation = 'The source subtitle file appears corrupted or invalid.\nIt may be too small or have formatting issues.';
    retryAdvice = '(CORRUPT_SOURCE) Please retry or try a different subtitle from the list.';
  } else if (errorType === 'other') {
    // Generic error - still provide helpful message with actual error
    errorTitle = 'Translation Failed: Unexpected Error';
    errorExplanation = errorMessage ? `Error: ${errorMessage}` : 'An unexpected error occurred during translation.';
    retryAdvice = 'Unexpected error.\nClick this subtitle again to retry.\nIf the problem persists, try a different subtitle, reinstall the addon or contact us.';
  }

  return `1
00:00:00,000 --> 00:00:10,000
${errorTitle}

2
00:00:10,001 --> 00:00:25,000
${errorExplanation}

3
00:00:25,001 --> 04:00:00,000
${retryAdvice}`;
}

/**
 * Check if a user can start a new translation without hitting the concurrency limit
 * Used by the 3-click reset safety check to prevent purging cache if re-translation would fail
 * @param {string} userHash - The user's config hash (for per-user limit tracking)
 * @returns {boolean} - True if the user can start a translation, false if at the limit
 */
function canUserStartTranslation(userHash) {
  const effectiveUserHash = (userHash && userHash.length > 0) ? userHash : 'anonymous';
  const currentCount = userTranslationCounts.get(effectiveUserHash) || 0;
  const canStart = currentCount < MAX_CONCURRENT_TRANSLATIONS_PER_USER;

  if (!canStart) {
    log.debug(() => `[ConcurrencyCheck] User ${effectiveUserHash} cannot start translation: ${currentCount}/${MAX_CONCURRENT_TRANSLATIONS_PER_USER} concurrent translations already in progress`);
  }

  return canStart;
}

// Initialize cache directory
function initializeCacheDirectory() {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      log.debug(() => '[Cache] Created translation cache directory');
    }
    if (!fs.existsSync(BYPASS_CACHE_DIR)) {
      fs.mkdirSync(BYPASS_CACHE_DIR, { recursive: true });
      log.debug(() => '[Cache] Created bypass translation cache directory');
    }
  } catch (error) {
    log.error(() => ['[Cache] Failed to create cache directory:', error.message]);
  }
}

// Verify cache integrity on startup and clean up expired entries
function verifyCacheIntegrity() {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      return;
    }

    const files = fs.readdirSync(CACHE_DIR);
    let validCount = 0;
    let expiredCount = 0;
    let corruptCount = 0;

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const filePath = path.join(CACHE_DIR, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const cached = JSON.parse(content);

        // Check if cache is still valid
        if (cached.expiresAt && Date.now() > cached.expiresAt) {
          // Expired, delete file
          fs.unlinkSync(filePath);
          expiredCount++;
        } else {
          validCount++;
        }
      } catch (error) {
        log.error(() => [`[Cache] Corrupt cache file ${file}:`, error.message]);
        // Delete corrupt files
        try {
          fs.unlinkSync(path.join(CACHE_DIR, file));
          corruptCount++;
        } catch (e) {
          // Ignore deletion errors
        }
      }
    }

    log.debug(() => `[Cache] Integrity check: ${validCount} valid, ${expiredCount} expired (cleaned), ${corruptCount} corrupt (removed)`);
  } catch (error) {
    log.error(() => ['[Cache] Failed to verify cache integrity:', error.message]);
  }
}

// Verify and cleanup expired entries in bypass cache
function verifyBypassCacheIntegrity() {
  try {
    if (!fs.existsSync(BYPASS_CACHE_DIR)) {
      return;
    }

    const files = fs.readdirSync(BYPASS_CACHE_DIR);
    let removedCount = 0;

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const filePath = path.join(BYPASS_CACHE_DIR, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const cached = JSON.parse(content);
        if (!cached.expiresAt || Date.now() > cached.expiresAt) {
          fs.unlinkSync(filePath);
          removedCount++;
        }
      } catch (error) {
        try { fs.unlinkSync(path.join(BYPASS_CACHE_DIR, file)); } catch (e) {}
      }
    }

    if (removedCount > 0) {
      log.debug(() => `[Bypass Cache] Cleaned ${removedCount} expired entries`);
    }
  } catch (error) {
    log.error(() => ['[Bypass Cache] Failed to verify/clean bypass cache:', error.message]);
  }
}

// Sanitize cache key to prevent path traversal attacks
function sanitizeCacheKey(cacheKey) {
  // Remove any path traversal attempts
  let sanitized = cacheKey.replace(/\.\./g, '');
  // Remove path separators
  sanitized = sanitized.replace(/[/\\]/g, '_');
  // Only allow alphanumeric, underscore, and hyphen
  sanitized = sanitized.replace(/[^a-zA-Z0-9_-]/g, '_');
  // Limit length to prevent extremely long filenames
  if (sanitized.length > 200) {
    // Use hash for very long keys
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(cacheKey).digest('hex');
    sanitized = sanitized.substring(0, 150) + '_' + hash.substring(0, 16);
  }
  return sanitized;
}

// Read translation from storage (async)
async function readFromStorage(cacheKey) {
  try {
    const adapter = await getStorageAdapter();
    const cached = await adapter.get(cacheKey, StorageAdapter.CACHE_TYPES.TRANSLATION);

    if (!cached) {
      return null;
    }

    cacheMetrics.diskReads++;
    return cached;
  } catch (error) {
    log.error(() => [`[Cache] Failed to read from storage for key ${cacheKey}:`, error.message]);
    return null;
  }
}

// DEPRECATED: Removed - use async readFromStorage() instead
// This function caused blocking I/O. Legacy code has been migrated.

// Read translation from bypass storage (async)
async function readFromBypassStorage(cacheKey) {
  try {
    const adapter = await getStorageAdapter();
    const cached = await adapter.get(cacheKey, StorageAdapter.CACHE_TYPES.BYPASS);

    if (!cached) {
      return null;
    }

    cacheMetrics.diskReads++;
    return cached;
  } catch (error) {
    log.error(() => [`[Bypass Cache] Failed to read from bypass storage for key ${cacheKey}:`, error.message]);
    return null;
  }
}

// DEPRECATED: Removed - use async readFromBypassStorage() instead
// This function caused blocking I/O. Legacy code has been migrated.

// Save translation to storage (async)
async function saveToStorage(cacheKey, cachedData) {
  try {
    const adapter = await getStorageAdapter();
    const ttl = StorageAdapter.DEFAULT_TTL[StorageAdapter.CACHE_TYPES.TRANSLATION];
    await adapter.set(cacheKey, cachedData, StorageAdapter.CACHE_TYPES.TRANSLATION, ttl);

    cacheMetrics.diskWrites++;
    log.debug(() => `[Cache] Saved translation to storage: ${cacheKey} (expires: ${cachedData.expiresAt ? new Date(cachedData.expiresAt).toISOString() : 'never'})`);
  } catch (error) {
    log.error(() => ['[Cache] Failed to save translation to storage:', error.message]);
  }
}

// DEPRECATED: Removed - use async saveToStorage() instead
// This function caused blocking I/O. Legacy code has been migrated.

// Save translation to bypass storage (async)
async function saveToBypassStorage(cacheKey, cachedData) {
  try {
    const adapter = await getStorageAdapter();
    const ttl = StorageAdapter.DEFAULT_TTL[StorageAdapter.CACHE_TYPES.BYPASS];
    await adapter.set(cacheKey, cachedData, StorageAdapter.CACHE_TYPES.BYPASS, ttl);

    cacheMetrics.diskWrites++;
  } catch (error) {
    log.error(() => ['[Bypass Cache] Failed to save translation to bypass storage:', error.message]);
  }
}

// DEPRECATED: Removed - use async saveToBypassStorage() instead
// This function caused blocking I/O. Legacy code has been migrated.

// Save partial translation to storage (async)
async function saveToPartialStorage(cacheKey, cachedData) {
  try {
    const adapter = await getStorageAdapter();
    const ttl = StorageAdapter.DEFAULT_TTL[StorageAdapter.CACHE_TYPES.PARTIAL];
    await adapter.set(cacheKey, cachedData, StorageAdapter.CACHE_TYPES.PARTIAL, ttl);

    cacheMetrics.diskWrites++;
  } catch (error) {
    log.error(() => ['[Partial Cache] Failed to save partial translation to storage:', error.message]);
  }
}

// DEPRECATED: Removed - use async saveToPartialStorage() instead
// This function caused blocking I/O. Legacy code has been migrated.

// Async helper for saving partial translations
// No queue needed - storage adapter handles concurrency
async function saveToPartialCacheAsync(cacheKey, cachedData) {
  return saveToPartialStorage(cacheKey, cachedData);
}

// Read partial translation result during chunking/streaming (async)
async function readFromPartialCache(cacheKey) {
  try {
    const adapter = await getStorageAdapter();
    const cached = await adapter.get(cacheKey, StorageAdapter.CACHE_TYPES.PARTIAL);
    
    if (!cached) {
      return null;
    }

    cacheMetrics.diskReads++;
    return cached;
  } catch (error) {
    log.error(() => [`[Partial Cache] Failed to read from partial for key ${cacheKey}:`, error.message]);
    return null;
  }
}

// Calculate total cache size
function calculateCacheSize() {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      return 0;
    }

    const files = fs.readdirSync(CACHE_DIR);
    let totalSize = 0;

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const filePath = path.join(CACHE_DIR, file);
        const stats = fs.statSync(filePath);
        totalSize += stats.size;
      } catch (error) {
        // Ignore errors for individual files
      }
    }

    return totalSize;
  } catch (error) {
    log.error(() => ['[Cache] Failed to calculate cache size:', error.message]);
    return 0;
  }
}

// Enforce cache size limit with LRU eviction
function enforceCacheSizeLimit() {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      return;
    }

    const totalSize = calculateCacheSize();
    cacheMetrics.totalCacheSize = totalSize;

    if (totalSize <= MAX_CACHE_SIZE_BYTES) {
      return; // Within limit
    }

    log.debug(() => `[Cache] Cache size (${(totalSize / 1024 / 1024 / 1024).toFixed(2)}GB) exceeds limit (${(MAX_CACHE_SIZE_BYTES / 1024 / 1024 / 1024).toFixed(2)}GB), performing LRU eviction`);

    // Get all cache files with their access times
    const files = fs.readdirSync(CACHE_DIR);
    const fileStats = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const filePath = path.join(CACHE_DIR, file);
        const stats = fs.statSync(filePath);
        fileStats.push({
          path: filePath,
          atime: stats.atime.getTime(), // Last access time
          size: stats.size
        });
      } catch (error) {
        // Ignore errors for individual files
      }
    }

    // Sort by access time (oldest first - LRU)
    fileStats.sort((a, b) => a.atime - b.atime);

    // Delete oldest files until we're under the limit
    let currentSize = totalSize;
    let evictedCount = 0;

    for (const file of fileStats) {
      if (currentSize <= MAX_CACHE_SIZE_BYTES * 0.9) { // Target 90% of limit to avoid frequent evictions
        break;
      }

      try {
        fs.unlinkSync(file.path);
        currentSize -= file.size;
        evictedCount++;
        cacheMetrics.filesEvicted++;
      } catch (error) {
        log.error(() => [`[Cache] Failed to evict file ${file.path}:`, error.message]);
      }
    }

    log.debug(() => `[Cache] LRU eviction complete: removed ${evictedCount} files, new size: ${(currentSize / 1024 / 1024 / 1024).toFixed(2)}GB`);
    cacheMetrics.totalCacheSize = currentSize;

  } catch (error) {
    log.error(() => ['[Cache] Failed to enforce cache size limit:', error.message]);
  }
}

// Log cache metrics periodically
function logCacheMetrics() {
  const uptime = Math.floor((Date.now() - cacheMetrics.lastReset) / 1000 / 60); // minutes
  const hitRate = cacheMetrics.hits + cacheMetrics.misses > 0
    ? ((cacheMetrics.hits / (cacheMetrics.hits + cacheMetrics.misses)) * 100).toFixed(1)
    : 0;
  const cacheSizeGB = (cacheMetrics.totalCacheSize / 1024 / 1024 / 1024).toFixed(2);

  log.debug(() => `[Cache Metrics] Uptime: ${uptime}m | Hits: ${cacheMetrics.hits} | Misses: ${cacheMetrics.misses} | Hit Rate: ${hitRate}% | Disk R/W: ${cacheMetrics.diskReads}/${cacheMetrics.diskWrites} | API Calls: ${cacheMetrics.apiCalls} | Est. Cost Saved: $${cacheMetrics.estimatedCostSaved.toFixed(3)} | Cache Size: ${cacheSizeGB}GB | Evicted: ${cacheMetrics.filesEvicted}`);
}

// Initialize cache on module load
initializeCacheDirectory();
verifyCacheIntegrity();
verifyBypassCacheIntegrity();

// Calculate initial cache size
cacheMetrics.totalCacheSize = calculateCacheSize();
log.debug(() => `[Cache] Initial cache size: ${(cacheMetrics.totalCacheSize / 1024 / 1024 / 1024).toFixed(2)}GB`);

// Log subtitle search cache configuration
log.debug(() => `[Subtitle Search Cache] Initialized: max=${SUBTITLE_SEARCH_CACHE_MAX} entries, ttl=${Math.floor(SUBTITLE_SEARCH_CACHE_TTL_MS / 1000 / 60)}min, user-scoped=true`);

// Log metrics every 30 minutes
setInterval(logCacheMetrics, 1000 * 60 * 30);

// Enforce cache size limit every 10 minutes
setInterval(enforceCacheSizeLimit, 1000 * 60 * 10);
// Cleanup bypass cache periodically
setInterval(verifyBypassCacheIntegrity, 1000 * 60 * 30);

/**
 * Deduplicates subtitle search requests by caching in-flight promises and completed results
 * @param {string} key - Unique key for the request
 * @param {Function} fn - Function to execute if not already in flight or cached
 * @returns {Promise} - Promise result
 */
async function deduplicateSearch(key, fn) {
    // Check completed results cache first (persistent cache)
    const cachedResult = subtitleSearchResultsCache.get(key);
    if (cachedResult) {
        log.debug(() => `[Subtitle Cache] Found cached search results for: ${shortKey(key)} (${cachedResult.length} subtitles)`);
        return cachedResult;
    }

    // Check in-flight requests (prevents duplicate API calls for concurrent requests)
    const cached = inFlightSearches.get(key);
    if (cached) {
        log.debug(() => `[Dedup] Subtitle search already in flight: ${shortKey(key)}`);
        return cached.promise;
    }

    log.debug(() => `[Dedup] Processing new subtitle search: ${shortKey(key)}`);
    const promise = fn();

    inFlightSearches.set(key, { promise });

    try {
        const result = await promise;
        // Cache the completed result for future requests
        if (result && Array.isArray(result)) {
            subtitleSearchResultsCache.set(key, result);
            log.debug(() => `[Subtitle Cache] Cached search results for: ${shortKey(key)} (${result.length} subtitles)`);
        }
        return result;
    } finally {
        inFlightSearches.delete(key);
    }
}

/**
 * Extract quality tier and release group from filename
 * @param {string} filename - The filename to parse
 * @returns {Object} - Object with quality tier, resolution, codec, and release group
 */
function parseReleaseMetadata(filename) {
  const lower = filename.toLowerCase();

  // Resolution detection (highest priority for sync)
  let resolution = null;
  if (lower.includes('4k') || lower.includes('2160p')) resolution = '4k';
  else if (lower.includes('1080p')) resolution = '1080p';
  else if (lower.includes('720p')) resolution = '720p';
  else if (lower.includes('480p')) resolution = '480p';
  else if (lower.includes('360p')) resolution = '360p';

  // Rip type detection (CRITICAL for sync - different rips have different timing)
  // More specific types = lower tier number = higher priority
  let ripType = null;
  let ripTier = 0;

  // Web sources (most common, best quality for recent content)
  if (lower.includes('web-dl') || lower.includes('webdl')) {
    ripType = 'web-dl';
    ripTier = 1;
  } else if (lower.includes('webrip')) {
    ripType = 'webrip';
    ripTier = 2;
  } else if (lower.includes('web')) {
    ripType = 'web';
    ripTier = 3;
  }
  // Blu-ray sources (high quality, scene releases)
  else if (lower.includes('bluray') || lower.includes('blu-ray')) {
    ripType = 'bluray';
    ripTier = 4;
  } else if (lower.includes('bdrip') || lower.includes('brrip')) {
    ripType = 'bdrip';
    ripTier = 5;
  } else if (lower.includes('bdremux') || lower.includes('bd-remux')) {
    ripType = 'bdremux';
    ripTier = 4;
  }
  // TV sources
  else if (lower.includes('hdtv')) {
    ripType = 'hdtv';
    ripTier = 6;
  } else if (lower.includes('pdtv')) {
    ripType = 'pdtv';
    ripTier = 7;
  }
  // DVD sources
  else if (lower.includes('dvdrip')) {
    ripType = 'dvdrip';
    ripTier = 8;
  } else if (lower.includes('dvdscr')) {
    ripType = 'dvdscr';
    ripTier = 10;
  }
  // Lower quality sources
  else if (lower.includes('hdrip')) {
    ripType = 'hdrip';
    ripTier = 9;
  } else if (lower.includes('cam') || lower.includes('camrip')) {
    ripType = 'cam';
    ripTier = 12;
  } else if (lower.includes('telesync') || lower.includes('ts')) {
    ripType = 'telesync';
    ripTier = 11;
  } else if (lower.includes('screener') || lower.includes('scr')) {
    ripType = 'screener';
    ripTier = 10;
  }

  // Video codec detection
  let codec = null;
  if (lower.includes('x265') || lower.includes('h.265') || lower.includes('h265') || lower.includes('hevc')) codec = 'x265';
  else if (lower.includes('x264') || lower.includes('h.264') || lower.includes('h264') || lower.includes('avc')) codec = 'x264';
  else if (lower.includes('xvid')) codec = 'xvid';
  else if (lower.includes('av1')) codec = 'av1';

  // Audio codec detection (helps differentiate releases)
  let audio = null;
  if (lower.includes('atmos')) audio = 'atmos';
  else if (lower.includes('truehd')) audio = 'truehd';
  else if (lower.includes('dts-hd') || lower.includes('dtshd')) audio = 'dts-hd';
  else if (lower.includes('dts')) audio = 'dts';
  else if (lower.includes('dd5.1') || lower.includes('dd51') || lower.includes('ac3')) audio = 'ac3';
  else if (lower.includes('aac')) audio = 'aac';
  else if (lower.includes('eac3') || lower.includes('ddp')) audio = 'eac3';

  // HDR detection (4K releases often have multiple versions)
  let hdr = null;
  if (lower.includes('dolbyvision') || lower.includes('dv')) hdr = 'dolbyvision';
  else if (lower.includes('hdr10+') || lower.includes('hdr10plus')) hdr = 'hdr10+';
  else if (lower.includes('hdr10') || lower.includes('hdr')) hdr = 'hdr10';
  else if (lower.includes('sdr')) hdr = 'sdr';

  // Source platform (streaming service - different cuts/timings)
  let platform = null;
  if (lower.includes('netflix') || lower.includes('.nf.')) platform = 'netflix';
  else if (lower.includes('amazon') || lower.includes('amzn')) platform = 'amazon';
  else if (lower.includes('disney+') || lower.includes('dsnp')) platform = 'disney+';
  else if (lower.includes('hulu')) platform = 'hulu';
  else if (lower.includes('hbo') || lower.includes('hmax')) platform = 'hbo';
  else if (lower.includes('apple') || lower.includes('atvp')) platform = 'apple';
  else if (lower.includes('paramount') || lower.includes('pmtp')) platform = 'paramount';

  // Extract release group (usually at end, after last dash or in brackets)
  // Patterns: "Movie.Name-GROUP", "Movie.Name[GROUP]", "Movie.Name (GROUP)"
  let releaseGroup = null;

  // Try multiple patterns (most specific first)
  const patterns = [
    /\[([A-Z0-9]+)\]\s*$/i,           // [RARBG] at end
    /\(([A-Z0-9]+)\)\s*$/i,           // (YTS) at end
    /[-_]([A-Z0-9]{2,})\s*$/i,        // -ETRG or _PSA at end
    /\b([A-Z0-9]{2,})\s*$/i           // SPARKS at end (no separator)
  ];

  for (const pattern of patterns) {
    const match = filename.match(pattern);
    if (match) {
      releaseGroup = match[1].toLowerCase();
      break;
    }
  }

  // Determine if this is a popular/trusted release group
  const POPULAR_GROUPS = new Set([
    'rarbg', 'yts', 'etrg', 'psa', 'sparks', 'yify', 'ettv', 'galaxyrg',
    'cmrg', 'shaanig', 'nf', 'amzn', 'amiable', 'crimson', 'scene',
    'ntb', 'ntg', 'ghd', 'geckos', 'pahe', 'ion10', 'tigole', 'qxr',
    'joy', 'bokutox', 'iextreme', 'tgx', 'sigma', 'mrcs', 'xlf', 'hqc'
  ]);

  const isPopularGroup = releaseGroup && POPULAR_GROUPS.has(releaseGroup);

  return {
    resolution,
    ripType,
    ripTier,
    codec,
    audio,
    hdr,
    platform,
    releaseGroup,
    isPopularGroup
  };
}

/**
 * Calculate filename match score for a subtitle
 * Prioritizes sync probability: exact releases > quality matches > partial matches
 * @param {string} streamFilename - The stream/video filename from Stremio
 * @param {string} subtitleName - The subtitle name from provider
 * @returns {number} - Match score (higher = better match = more likely to sync)
 */
function calculateFilenameMatchScore(streamFilename, subtitleName) {
  if (!streamFilename || !subtitleName) return 0;

  const stream = streamFilename.toLowerCase();
  const subtitle = subtitleName.toLowerCase();

  // Exact string match is perfect
  if (stream === subtitle) {
    return 10000;
  }

  let score = 0;

  // Parse metadata from both filenames
  const streamMeta = parseReleaseMetadata(streamFilename);
  const subtitleMeta = parseReleaseMetadata(subtitleName);

  // Extract core title (everything before year/resolution)
  const getTitleBase = (filename) => {
    return filename
      .replace(/\b(19|20)\d{2}\b.*/, '') // Remove year and everything after
      .replace(/[_\-\.]/g, ' ')
      .trim()
      .toLowerCase();
  };

  const streamTitle = getTitleBase(streamFilename);
  const subtitleTitle = getTitleBase(subtitleName);

  // CRITICAL: Title must match (very high penalty if it doesn't)
  const titleMatch = subtitleTitle.includes(streamTitle) || streamTitle.includes(subtitleTitle);
  if (!titleMatch) {
    return 0; // Completely different movie/show
  }
  score += 500; // Base score for title match

  // RELEASE GROUP MATCHING (highest priority for sync)
  // If both have release groups and they match = very likely to sync
  if (streamMeta.releaseGroup && subtitleMeta.releaseGroup) {
    if (streamMeta.releaseGroup === subtitleMeta.releaseGroup) {
      // Exact release group match = very high probability
      // Popular/trusted groups get extra weight (even more reliable)
      if (streamMeta.isPopularGroup || subtitleMeta.isPopularGroup) {
        score += 5000; // Popular group exact match (RARBG, YTS, etc.)
      } else {
        score += 4000; // Standard group exact match
      }
    } else {
      score -= 100; // Different release groups = lower probability
    }
  } else if (subtitleMeta.releaseGroup && subtitleMeta.isPopularGroup) {
    // Subtitle has popular release group (even without stream group match)
    // These are generally high-quality and well-synced
    score += 200; // Small bonus for popular group subtitles
  }

  // RIP TYPE MATCHING (second priority - CRITICAL for timing sync)
  // Different rip types (WEB-DL vs BluRay vs HDTV) have different frame timing
  if (streamMeta.ripType && subtitleMeta.ripType) {
    if (streamMeta.ripType === subtitleMeta.ripType) {
      score += 2500; // Exact rip type match = VERY high sync probability
    } else if (streamMeta.ripTier && subtitleMeta.ripTier) {
      const ripTierDiff = Math.abs(streamMeta.ripTier - subtitleMeta.ripTier);
      if (ripTierDiff === 1) {
        score += 800; // Adjacent rip tier (e.g., WEB-DL vs WEBRip)
      } else if (ripTierDiff === 2) {
        score += 300; // Close rip tier (might work)
      } else {
        score -= 500; // Very different rip types (CAM vs BluRay = bad sync)
      }
    }
  }

  // STREAMING PLATFORM MATCHING (important for WEB releases)
  // Netflix/Amazon/etc have different cuts and timing
  if (streamMeta.platform && subtitleMeta.platform) {
    if (streamMeta.platform === subtitleMeta.platform) {
      score += 1200; // Same platform = same cut/timing
    } else {
      score -= 200; // Different platforms = different cuts
    }
  }

  // RESOLUTION MATCHING (third priority)
  // Exact resolution match is good, but 1080p subs work on 720p streams
  if (streamMeta.resolution && subtitleMeta.resolution) {
    if (streamMeta.resolution === subtitleMeta.resolution) {
      score += 1000; // Perfect resolution match
    } else {
      // Resolution compatibility: 1080p/720p are compatible, but penalize mismatches
      const streamRes = parseInt(streamMeta.resolution);
      const subtitleRes = parseInt(subtitleMeta.resolution);

      if ((streamRes === 720 && subtitleRes === 1080) ||
          (streamRes === 1080 && subtitleRes === 720)) {
        score += 400; // 720p/1080p cross-match (still works)
      } else if (streamRes < subtitleRes) {
        score += 200; // Higher quality subtitle on lower res stream (works)
      } else {
        score -= 200; // Lower quality subtitle on higher res stream (mismatch)
      }
    }
  }

  // VIDEO CODEC MATCHING (different encodes can have timing shifts)
  if (streamMeta.codec && subtitleMeta.codec) {
    if (streamMeta.codec === subtitleMeta.codec) {
      score += 500; // Same video codec = better sync (increased from 300)
    } else {
      // x265 and x264 from same source are usually compatible
      const codecCompatible =
        (streamMeta.codec === 'x265' && subtitleMeta.codec === 'x264') ||
        (streamMeta.codec === 'x264' && subtitleMeta.codec === 'x265');
      if (codecCompatible) {
        score += 200; // Compatible codecs (same source, different encode)
      }
    }
  }

  // AUDIO CODEC MATCHING (helps identify exact release variant)
  if (streamMeta.audio && subtitleMeta.audio) {
    if (streamMeta.audio === subtitleMeta.audio) {
      score += 400; // Same audio codec = likely same exact release
    }
  }

  // HDR MATCHING (4K releases often have HDR/SDR variants with different timing)
  if (streamMeta.hdr && subtitleMeta.hdr) {
    if (streamMeta.hdr === subtitleMeta.hdr) {
      score += 600; // Same HDR type = same release variant
    } else {
      score -= 150; // Different HDR variants (DV vs HDR10) may have timing differences
    }
  }

  // TOKEN-BASED MATCHING for other distinguishing factors
  // Split by separators and match tokens
  const streamTokens = stream
    .replace(/\.[^.]+$/, '') // Remove extension
    .split(/[_\-\.\s]+/)
    .filter(t => t.length > 1); // Allow 2+ character tokens

  const subtitleTokens = subtitle
    .replace(/\.[^.]+$/, '')
    .split(/[_\-\.\s]+/)
    .filter(t => t.length > 1);

  // Match tokens (especially year, season/episode numbers, edition info)
  let tokenMatches = 0;
  const IMPORTANT_TOKENS = new Set([
    'repack', 'proper', 'extended', 'unrated', 'directors', 'cut',
    'theatrical', 'imax', 'remux', 'atmos', 'hybrid', 'hc', 'dual'
  ]);

  for (const token of streamTokens) {
    if (!subtitleTokens.includes(token)) continue;

    // Year matching (4-digit number starting with 19 or 20)
    if (/^(19|20)\d{2}$/.test(token)) {
      tokenMatches += 3; // Year is VERY important
    }
    // Season/Episode numbers (S01, E05, etc.)
    else if (/^[se]\d+$/i.test(token)) {
      tokenMatches += 4; // Episode/Season numbers are CRITICAL
    }
    // Other numeric tokens (could be episode number, part number, etc.)
    else if (/^\d+$/.test(token)) {
      tokenMatches += 2;
    }
    // Important edition/quality tokens
    else if (IMPORTANT_TOKENS.has(token)) {
      tokenMatches += 2; // Edition markers are important for correct version
    }
    // Regular token match
    else {
      tokenMatches += 1;
    }
  }

  if (tokenMatches > 0) {
    score += tokenMatches * 100;
  }

  // EDITION/CUT MATCHING (different cuts have different timing!)
  const EDITION_MARKERS = ['extended', 'unrated', 'directors.cut', 'theatrical', 'imax', 'remastered'];
  let streamEdition = null;
  let subtitleEdition = null;

  for (const marker of EDITION_MARKERS) {
    if (stream.includes(marker)) streamEdition = marker;
    if (subtitle.includes(marker)) subtitleEdition = marker;
  }

  if (streamEdition && subtitleEdition) {
    if (streamEdition === subtitleEdition) {
      score += 1500; // Same cut/edition = critical for sync
    } else {
      score -= 1000; // Different cuts = very likely desync
    }
  } else if (streamEdition && !subtitleEdition) {
    score -= 300; // Stream is special edition, subtitle is not
  } else if (!streamEdition && subtitleEdition) {
    score -= 300; // Subtitle is special edition, stream is not
  }

  // PROPER/REPACK MATCHING (scene release fixes)
  const streamIsProper = stream.includes('proper') || stream.includes('repack');
  const subtitleIsProper = subtitle.includes('proper') || subtitle.includes('repack');

  if (streamIsProper && subtitleIsProper) {
    score += 800; // Both PROPER/REPACK = same fixed release
  } else if (streamIsProper !== subtitleIsProper) {
    score -= 400; // One is PROPER, other is not = different releases
  }

  // PENALTY: If subtitle has minimal info (very short), it's less likely to be accurate match
  if (subtitleTokens.length < 2) {
    score *= 0.5;
  }

  // BONUS: If subtitle name is very similar in structure/length, it's probably the right one
  const tokenRatio = Math.min(streamTokens.length, subtitleTokens.length) /
                     Math.max(streamTokens.length, subtitleTokens.length);
  if (tokenRatio > 0.8) {
    score *= 1.3; // Very similar structure = very good sign (increased threshold and bonus)
  } else if (tokenRatio > 0.6) {
    score *= 1.15; // Moderately similar structure = good sign
  }

  // BONUS: Exact match on multiple critical factors = compound boost
  let criticalMatches = 0;
  if (streamMeta.releaseGroup && streamMeta.releaseGroup === subtitleMeta.releaseGroup) criticalMatches++;
  if (streamMeta.ripType && streamMeta.ripType === subtitleMeta.ripType) criticalMatches++;
  if (streamMeta.resolution && streamMeta.resolution === subtitleMeta.resolution) criticalMatches++;

  if (criticalMatches >= 3) {
    score *= 1.5; // Triple match (group + rip + resolution) = extremely likely correct
  } else if (criticalMatches === 2) {
    score *= 1.25; // Double match = very likely correct
  }

  return Math.max(0, Math.round(score));
}

/**
 * Sort subtitles by filename match score with secondary quality-based ranking
 * @param {Array} subtitles - Array of subtitle objects
 * @param {string} streamFilename - Stream filename from Stremio
 * @param {Object} videoInfo - Video metadata (imdbId, type, season, episode)
 * @returns {Array} - Sorted subtitles (best matches first)
 */
function rankSubtitlesByFilename(subtitles, streamFilename, videoInfo = null) {
  if (!streamFilename || subtitles.length === 0) {
    return subtitles;
  }

  const withScores = subtitles.map(sub => {
    // Calculate base score using primary release name
    let bestScore = calculateFilenameMatchScore(streamFilename, sub.name || '');

    // For SubDL subtitles, also check all compatible releases from API
    // This dramatically improves matching since SubDL provides all release variants
    if (sub.provider === 'subdl' && Array.isArray(sub.releases) && sub.releases.length > 0) {
      for (const releaseName of sub.releases) {
        const releaseScore = calculateFilenameMatchScore(streamFilename, releaseName);
        if (releaseScore > bestScore) {
          bestScore = releaseScore;
          // Log when a better match is found in releases array
          if (releaseScore > 100) { // Only log significant improvements
            log.debug(() => `[SubDL Ranking] Better match found in releases: "${releaseName}" (score: ${releaseScore} vs ${calculateFilenameMatchScore(streamFilename, sub.name || '')})`);
          }
        }
      }
    }

    return {
      ...sub,
      _matchScore: bestScore
    };
  });

  // Add episode metadata match bonus/penalty (for TV shows and anime)
  // This helps rank subtitles when filename matching fails (e.g., numeric IDs)
  if (videoInfo && (videoInfo.type === 'episode' || videoInfo.type === 'anime-episode') && videoInfo.episode) {
    // Default season to 1 for anime when not present
    const targetSeason = videoInfo.season || 1;
    const targetEpisode = videoInfo.episode;

    for (const sub of withScores) {
      const name = (sub.name || '').toLowerCase();

      // Check for season/episode patterns in subtitle name
      // Patterns: S02E01, s02e01, 2x01, S02.E01, etc.
      const seasonEpisodePatterns = [
        new RegExp(`s0*${targetSeason}e0*${targetEpisode}`, 'i'),        // S02E01, s02e01
        new RegExp(`${targetSeason}x0*${targetEpisode}`, 'i'),           // 2x01
        new RegExp(`s0*${targetSeason}\\.e0*${targetEpisode}`, 'i'),     // S02.E01
        new RegExp(`season\\s*0*${targetSeason}.*episode\\s*0*${targetEpisode}`, 'i')  // Season 2 Episode 1
      ];

      // Anime-friendly episode-only patterns when type is anime-episode
      // Expanded to match common anime naming without season markers
      const animeEpisodePatterns = [
        // E01 / EP01 / E 01 / EP 01 / (01) / [01] / - 01 / _01 / 01v2
        new RegExp(`(?<=\\b|\\s|\\[|\\(|-|_)e?p?\\s*0*${targetEpisode}(?:v\\d+)?(?=\\b|\\s|\\]|\\)|\\.|-|_|$)`, 'i'),
        new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${targetEpisode}(?:v\\d+)?(?=$|[\\s\\]\\)\\-_.])`, 'i'),

        // Explicit words
        new RegExp(`(?:^|[\\s\\[\\(\\-_])episode\\s*0*${targetEpisode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
        new RegExp(`(?:^|[\\s\\[\\(\\-_])ep\\s*0*${targetEpisode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),

        // Spanish/Portuguese
        new RegExp(`(?:^|[\\s\\[\\(\\-_])cap(?:itulo|\\.)?\\s*0*${targetEpisode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
        new RegExp(`(?:^|[\\s\\[\\(\\-_])epis[oó]dio\\s*0*${targetEpisode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),

        // Japanese/Chinese/Korean: 第01話 / 01話 / 01集 / 1화
        new RegExp(`第\\s*0*${targetEpisode}\\s*(?:話|集)`, 'i'),
        new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${targetEpisode}\\s*(?:話|集|화)(?=$|[\\s\\]\\)\\-_.])`, 'i'),

        // Multi-episode pack ranges that include the requested episode (e.g., 01-02 / 01~02)
        new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${targetEpisode}\\s*[-~](?=\\s*\\d)`, 'i'),
        new RegExp(`(?:^|[\\s\\[\\(\\-_])\\d+\\s*[-~]\\s*0*${targetEpisode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
      ];

      const hasCorrectEpisode = seasonEpisodePatterns.some(pattern => pattern.test(name)) ||
        (videoInfo.type === 'anime-episode' && animeEpisodePatterns.some(p => p.test(name)));

      if (hasCorrectEpisode) {
        // BONUS: Subtitle name explicitly mentions correct episode
        sub._matchScore += 2000; // Large bonus to prioritize correct episodes
      } else {
        // Check if subtitle has ANY episode number (wrong episode)
        const hasWrongEpisode = /s\d+e\d+|\d+x\d+|season\s*\d+.*episode\s*\d+|\b(ep?\d{1,3})\b/i.test(name);
        if (hasWrongEpisode) {
          // PENALTY: Subtitle is for wrong episode (e.g., S02E11 when we want S02E01)
          sub._matchScore -= 3000; // Heavy penalty for wrong episode
        }
      }
    }
  }

  // Provider reputation scores (used as final tiebreaker when all else is equal)
  const providerReputation = {
    'opensubtitles-v3': 3, // Highest reputation (largest database, most reliable)
    'subdl': 2,            // Good reputation
    'subsource': 2         // Good reputation - API provides rating-sorted results with rich metadata
  };

  // Two-tier ranking system:
  // 1. Primary: Filename match score (for subtitle sync accuracy)
  // 2. Secondary: Composite quality score (weighted combination of downloads, rating, date)
  //    - Used as tiebreaker when filename scores are similar

  // Helper: Calculate normalized quality score (0-100) from downloads, rating, and date
  // Missing metrics are treated neutrally (not penalized) to avoid unfairly ranking providers
  const calculateQualityScore = (sub) => {
    const metrics = [];
    const weights = [];

    // Normalize downloads using logarithmic scale (diminishing returns for high download counts)
    // log10(1) = 0, log10(10) = 1, log10(100) = 2, log10(1000) = 3
    const downloads = sub.downloads || 0;
    if (downloads > 0) {
      const normalizedDownloads = Math.min(100, (Math.log10(downloads + 1) / Math.log10(1000)) * 100);
      metrics.push(normalizedDownloads);
      weights.push(0.40);
    }

    // Normalize rating (assume 0-10 scale, though some providers use 0-5)
    // If rating > 10, assume it's out of 100
    const rating = sub.rating || 0;
    if (rating > 0) {
      const normalizedRating = rating > 10
        ? Math.min(100, rating)
        : (rating / 10) * 100;
      metrics.push(normalizedRating);
      weights.push(0.40);
    }

    // Normalize upload date (recent = 100, old = 0)
    // Consider subtitles from last 365 days as "fresh"
    const uploadDate = sub.uploadDate ? new Date(sub.uploadDate).getTime() : 0;
    if (uploadDate > 0) {
      const now = Date.now();
      const daysSinceUpload = (now - uploadDate) / (1000 * 60 * 60 * 24);
      const normalizedDate = Math.max(0, Math.min(100, 100 - (daysSinceUpload / 365) * 100));
      metrics.push(normalizedDate);
      weights.push(0.20);
    }

    // If no metrics available, return neutral score (50)
    if (metrics.length === 0) {
      return 50;
    }

    // Calculate weighted average, normalizing weights to sum to 1.0
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    const compositeScore = metrics.reduce((sum, metric, i) => {
      return sum + (metric * (weights[i] / totalWeight));
    }, 0);

    return compositeScore;
  };

  withScores.sort((a, b) => {
    // Primary sort: Filename match score (descending - higher is better)
    const scoreDiff = b._matchScore - a._matchScore;

    // If scores are significantly different (>1000 points), use filename score
    // High threshold ensures filename matching is DOMINANT over quality metrics
    // This prevents providers without download data (OpenSubtitles V3) from being unfairly penalized
    if (Math.abs(scoreDiff) > 1000) {
      return scoreDiff;
    }

    // Special case: When both scores are 0 (no filename match), prioritize by provider reputation first
    // This ensures quality providers aren't unfairly penalized when release names are missing
    if (a._matchScore === 0 && b._matchScore === 0) {
      const reputationDiff = (providerReputation[b.provider] || 0) - (providerReputation[a.provider] || 0);
      if (reputationDiff !== 0) {
        return reputationDiff;
      }
    }

    // Secondary sort: Composite quality score (balanced weighting of all metrics)
    const qualityScoreA = calculateQualityScore(a);
    const qualityScoreB = calculateQualityScore(b);
    const qualityDiff = qualityScoreB - qualityScoreA;

    if (Math.abs(qualityDiff) > 0.01) { // Use small threshold for floating point comparison
      return qualityDiff;
    }

    // Final tiebreaker: Provider reputation (for truly equal subtitles)
    return (providerReputation[b.provider] || 0) - (providerReputation[a.provider] || 0);
  });

  // Remove the temporary score property before returning
  return withScores.map(({ _matchScore, ...rest }) => rest);
}

/**
 * Create subtitle handler for Stremio addon
 * @param {Object} config - Addon configuration
 * @returns {Function} - Handler function
 */
function createSubtitleHandler(config) {
  return async (args) => {
    try {
      log.debug(() => `[Subtitles] Handler called with args: ${JSON.stringify(args)}`);

      const { type, id, extra } = args;
      const videoInfo = parseStremioId(id);

      if (!videoInfo) {
        log.error(() => ['[Subtitles] Invalid video ID:', id]);
        return { subtitles: [] };
      }

      log.debug(() => `[Subtitles] Video info: ${JSON.stringify(videoInfo)}`);

      // Handle anime content - try to map anime ID to IMDB ID
      if (videoInfo.isAnime && videoInfo.animeId) {
        log.debug(() => `[Subtitles] Anime content detected (${videoInfo.animeIdType}), attempting to map to IMDB ID`);

        if (videoInfo.animeIdType === 'anidb') {
          try {
            const imdbId = await anidbService.getImdbId(videoInfo.anidbId);
            if (imdbId) {
              log.info(() => `[Subtitles] Mapped AniDB ${videoInfo.anidbId} to ${imdbId}`);
              videoInfo.imdbId = imdbId;
            } else {
              log.warn(() => `[Subtitles] Could not find IMDB mapping for AniDB ${videoInfo.anidbId}, subtitles may be limited`);
            }
          } catch (error) {
            log.error(() => `[Subtitles] Error mapping AniDB to IMDB: ${error.message}`);
          }
        } else if (videoInfo.animeIdType === 'kitsu') {
          try {
            const imdbId = await kitsuService.getImdbId(videoInfo.animeId);
            if (imdbId) {
              log.info(() => `[Subtitles] Mapped Kitsu ${videoInfo.animeId} to ${imdbId}`);
              videoInfo.imdbId = imdbId;
            } else {
              log.warn(() => `[Subtitles] Could not find IMDB mapping for Kitsu ${videoInfo.animeId}, subtitles may be limited`);
            }
          } catch (error) {
            log.error(() => `[Subtitles] Error mapping Kitsu to IMDB: ${error.message}`);
          }
        } else {
          log.debug(() => `[Subtitles] No IMDB mapping available for ${videoInfo.animeIdType} IDs yet, will search by anime metadata`);
          // For mal/anilist IDs, we'll need to implement mapping services
          // Continue anyway - subtitle providers will skip search if no IMDB ID
        }
      }

      // Check if this is a session token error - if so, return error entry immediately
      if (config.__sessionTokenError === true) {
        log.warn(() => '[Subtitles] Session token error detected - returning config error entry');
        return {
          subtitles: [{
            id: 'config_error_session_token',
            lang: 'âš ï¸ SubMaker Config Error',
            url: `{{ADDON_URL}}/error-subtitle/session-token-not-found.srt`
          }]
        };
      }

      // Extract stream filename for matching
      const streamFilename = extra?.filename || '';
      if (streamFilename) {
        log.debug(() => `[Subtitles] Stream filename for matching: ${streamFilename}`);
      }

      // Get all languages for searching
      // In no-translation mode (just fetch), use noTranslationLanguages
      // In translation mode, use source + target languages
      const allLanguages = config.noTranslationMode
        ? [...new Set(config.noTranslationLanguages || [])]
        : [...new Set([...config.sourceLanguages, ...config.targetLanguages])];

      // Build search parameters for all providers
      const searchParams = {
        imdb_id: videoInfo.imdbId,
        type: videoInfo.type,
        season: videoInfo.season,
        episode: videoInfo.episode,
        languages: allLanguages
      };

      // Get user config hash for cache isolation
      // Each user's config (API keys, provider settings) gets their own cached results
      const userHash = (config && typeof config.__configHash === 'string' && config.__configHash.length > 0)
        ? config.__configHash
        : 'default';

      // Create user-scoped deduplication key based on video info, languages, and config hash
      // This ensures different users (or same user with different configs) get separate cached results
      // Cache automatically purges when user changes config (different hash = different cache key)
      const dedupKey = `subtitle-search:${videoInfo.imdbId}:${videoInfo.type}:${videoInfo.season || ''}:${videoInfo.episode || ''}:${allLanguages.join(',')}:${userHash}`;

      // Collect subtitles from all enabled providers with deduplication
      let openSubsAuthFailed = false; // track OpenSubtitles auth failures to append UX hint entries later
      const foundSubtitles = await deduplicateSearch(dedupKey, async () => {
        // Parallelize all provider searches using Promise.allSettled for better performance
        // This reduces search time from (OpenSubtitles + SubDL + SubSource) sequential
        // to max(OpenSubtitles, SubDL, SubSource) parallel
        const searchPromises = [];

        // Check if OpenSubtitles provider is enabled
        if (config.subtitleProviders?.opensubtitles?.enabled) {
          const implementationType = config.subtitleProviders.opensubtitles.implementationType || 'v3';
          log.debug(() => `[Subtitles] OpenSubtitles provider is enabled (implementation: ${implementationType})`);

          let opensubtitles;
          if (implementationType === 'v3') {
            opensubtitles = new OpenSubtitlesV3Service();
          } else {
            opensubtitles = new OpenSubtitlesService(config.subtitleProviders.opensubtitles);
          }

          searchPromises.push(
            opensubtitles.searchSubtitles(searchParams)
              .then(results => ({ provider: `OpenSubtitles (${implementationType})`, results }))
              .catch(error => {
                try {
                  const msg = String(error?.message || '').toLowerCase();
                  if (error?.authError === true || error?.statusCode === 400 || error?.statusCode === 401 || error?.statusCode === 403 || msg.includes('auth')) {
                    openSubsAuthFailed = true;
                  }
                } catch (_) {}
                return ({ provider: `OpenSubtitles (${implementationType})`, results: [], error });
              })
          );
        } else {
          log.debug(() => '[Subtitles] OpenSubtitles provider is disabled');
        }

        // Check if SubDL provider is enabled
        if (config.subtitleProviders?.subdl?.enabled) {
          log.debug(() => '[Subtitles] SubDL provider is enabled');
          const subdl = new SubDLService(config.subtitleProviders.subdl.apiKey);
          searchPromises.push(
            subdl.searchSubtitles(searchParams)
              .then(results => ({ provider: 'SubDL', results }))
              .catch(error => ({ provider: 'SubDL', results: [], error }))
          );
        } else {
          log.debug(() => '[Subtitles] SubDL provider is disabled');
        }

        // Check if SubSource provider is enabled
        if (config.subtitleProviders?.subsource?.enabled) {
          log.debug(() => '[Subtitles] SubSource provider is enabled');
          const subsource = new SubSourceService(config.subtitleProviders.subsource.apiKey);
          searchPromises.push(
            subsource.searchSubtitles(searchParams)
              .then(results => ({ provider: 'SubSource', results }))
              .catch(error => ({ provider: 'SubSource', results: [], error }))
          );
        } else {
          log.debug(() => '[Subtitles] SubSource provider is disabled');
        }

        // Execute all searches in parallel
        const providerResults = await Promise.all(searchPromises);

        // Collect and log results from all providers
        let subtitles = [];
        for (const result of providerResults) {
          if (result.error) {
            log.error(() => [`[Subtitles] ${result.provider} search failed:`, result.error.message]);
          } else {
            log.debug(() => `[Subtitles] Found ${result.results.length} subtitles from ${result.provider}`);
            subtitles = [...subtitles, ...result.results];
          }
        }

        return subtitles;
      });

      // Future providers can be added here
      // if (config.subtitleProviders?.anotherProvider?.enabled) {
      //   const results = await anotherProvider.search(...);
      //   foundSubtitles = [...foundSubtitles, ...results];
      // }

      // Normalize language codes to proper ISO-639-2 format
      const normalizeLanguageCode = (lang) => {
        const lower = lang.toLowerCase().replace(/[_-]/g, '');

        // Handle special cases for Portuguese Brazilian
        if (lower === 'ptbr' || lower === 'pt-br') {
          return 'pob';
        }

        // If it's already 3 letters, return as-is
        if (/^[a-z]{3}$/.test(lower)) {
          return lower;
        }

        // If it's 2 letters, try to convert to ISO-639-2
        if (lower.length === 2) {
          const { toISO6392 } = require('../utils/languages');
          const iso2Codes = toISO6392(lower);
          if (iso2Codes && iso2Codes.length > 0) {
            return iso2Codes[0].code2;
          }
        }

        // Return original if we can't normalize
        return lower;
      };

      // Normalize all configured languages (source + target) for filtering
      const normalizedAllLangs = new Set([...new Set(allLanguages.map(lang => normalizeLanguageCode(lang)))]);

      // Add language equivalents for providers that don't distinguish regional variants
      // E.g., SubDL treats Spanish (Spain) and Spanish (Latin America) the same way
      const languageEquivalents = {
        'spa': ['spn'],  // Spanish (Spain) ↔ Spanish (Latin America)
        'spn': ['spa']
      };

      // Expand normalizedAllLangs to include equivalents
      const expandedLangs = new Set(normalizedAllLangs);
      normalizedAllLangs.forEach(lang => {
        if (languageEquivalents[lang]) {
          languageEquivalents[lang].forEach(equiv => expandedLangs.add(equiv));
        }
      });

      // Filter results to only allowed languages (including equivalents)
      // When no languages are configured (just fetch mode), accept all subtitles
      let filteredFoundSubtitles = allLanguages.length > 0
        ? foundSubtitles.filter(sub => sub.languageCode && expandedLangs.has(sub.languageCode))
        : foundSubtitles;

      // Rank subtitles by filename match + quality metrics before creating response lists
      // This ensures the best matches appear first in Stremio UI
      if (streamFilename) {
        filteredFoundSubtitles = rankSubtitlesByFilename(filteredFoundSubtitles, streamFilename, videoInfo);
        log.debug(() => `[Subtitles] Ranked ${filteredFoundSubtitles.length} subtitles by filename match + episode metadata + quality (downloads, rating, date)`);

        // Debug: Log top 3 ranked subtitles for verification
        if (filteredFoundSubtitles.length > 0) {
          const top3 = filteredFoundSubtitles.slice(0, 3);
          log.debug(() => ['[Subtitles] Top 3 AFTER ranking:', top3.map(s => ({
            name: s.name?.substring(0, 50) + (s.name?.length > 50 ? '...' : ''),
            provider: s.provider,
            downloads: s.downloads,
            rating: s.rating,
            uploadDate: s.uploadDate
          }))]);
        }
      }

      // Limit to top 12 subtitles per language (applied AFTER ranking all sources)
      // This prevents UI slowdown while ensuring best-quality subtitles are shown
      const MAX_SUBS_PER_LANGUAGE = 12;
      const limitedByLanguage = new Map(); // language -> subtitle array

      for (const sub of filteredFoundSubtitles) {
        if (!limitedByLanguage.has(sub.languageCode)) {
          limitedByLanguage.set(sub.languageCode, []);
        }
        const langSubs = limitedByLanguage.get(sub.languageCode);
        if (langSubs.length < MAX_SUBS_PER_LANGUAGE) {
          langSubs.push(sub);
        }
      }

      // Flatten back to array, preserving ranked order within each language
      filteredFoundSubtitles = Array.from(limitedByLanguage.values()).flat();
      log.debug(() => `[Subtitles] Limited to ${MAX_SUBS_PER_LANGUAGE} subtitles per language (${filteredFoundSubtitles.length} total)`);

      // Convert to Stremio subtitle format
      // Validate required fields before creating response objects
      const stremioSubtitles = filteredFoundSubtitles
        .filter(sub => {
          // Validate required fields exist and have valid values
          if (!sub.fileId || typeof sub.fileId !== 'string') {
            log.warn(() => ['[Subtitles] Skipping subtitle: missing or invalid fileId', sub]);
            return false;
          }
          if (!sub.languageCode || typeof sub.languageCode !== 'string') {
            log.warn(() => ['[Subtitles] Skipping subtitle: missing or invalid languageCode', sub]);
            return false;
          }
          return true;
        })
        .map(sub => {
          const subtitle = {
            id: `${sub.fileId}`,
            lang: sub.languageCode, // Must be ISO-639-2 (3-letter code)
            url: `{{ADDON_URL}}/subtitle/${sub.fileId}/${sub.languageCode}.srt`
          };

          return subtitle;
        });

      // Add translation buttons for each target language (skip in no-translation mode)
      const translationEntries = [];
      if (!config.noTranslationMode) {
        // Normalize and deduplicate target languages
        const normalizedTargetLangs = [...new Set(config.targetLanguages.map(lang => {
          const normalized = normalizeLanguageCode(lang);
          if (normalized !== lang) {
            log.debug(() => `[Subtitles] Normalized language code: "${lang}" -> "${normalized}"`);
          }
          return normalized;
        }))];

        // Create translation entries: for each target language, create entries for top source language subtitles
        // Note: filteredFoundSubtitles is already limited to 16 per language (including source languages)
        const sourceSubtitles = filteredFoundSubtitles.filter(sub =>
          config.sourceLanguages.some(sourceLang => {
            const normalized = normalizeLanguageCode(sourceLang);
            return sub.languageCode === normalized;
          })
        );

        log.debug(() => `[Subtitles] Found ${sourceSubtitles.length} source language subtitles for translation (already limited to ${MAX_SUBS_PER_LANGUAGE} per language)`);

        // For each target language, create a translation entry for each source subtitle
        // Translation entries are created from the already-limited source subtitles (16 per source language)
        for (const targetLang of normalizedTargetLangs) {
          const baseName = getLanguageName(targetLang);
          const displayName = `Make ${baseName}`;
          log.debug(() => `[Subtitles] Creating translation entries for ${displayName} (${targetLang})`);

          for (const sourceSub of sourceSubtitles) {
            const translationEntry = {
              id: `translate_${sourceSub.fileId}_to_${targetLang}`,
              lang: displayName, // Display as "Make Language" in Stremio UI
              url: `{{ADDON_URL}}/translate/${sourceSub.fileId}/${targetLang}`
            };
            translationEntries.push(translationEntry);
          }
        }

        log.debug(() => `[Subtitles] Created ${translationEntries.length} translation options from ${sourceSubtitles.length} source subtitles`);
      }

      // Add xSync entries (synced subtitles from cache)
      const xSyncEntries = [];
      if (streamFilename && config.syncSubtitlesEnabled !== false) {
        // Generate video hash from stream filename (similar approach for cache key)
        const videoHash = crypto.createHash('md5').update(streamFilename).digest('hex').substring(0, 16);

        // Get synced subtitles for each language
        const allLangsForSync = config.noTranslationMode
          ? [...new Set(config.noTranslationLanguages || [])]
          : [...new Set([...config.sourceLanguages, ...config.targetLanguages])];

        for (const lang of allLangsForSync) {
          try {
            const syncedSubs = await syncCache.getSyncedSubtitles(videoHash, lang);

            if (syncedSubs && syncedSubs.length > 0) {
              const langName = getLanguageName(lang);
              log.debug(() => `[Subtitles] Found ${syncedSubs.length} synced subtitle(s) for ${langName}`);

              // Add an entry for each synced subtitle
              for (let i = 0; i < syncedSubs.length; i++) {
                const syncedSub = syncedSubs[i];
                xSyncEntries.push({
                  id: `xsync_${syncedSub.cacheKey}_${i}`,
                  lang: `xSync ${langName}${syncedSubs.length > 1 ? ` #${i + 1}` : ''}`,
                  url: `{{ADDON_URL}}/xsync/${videoHash}/${lang}/${syncedSub.sourceSubId}`
                });
              }
            }
          } catch (error) {
            log.error(() => [`[Subtitles] Failed to get xSync entries for ${lang}:`, error.message]);
          }
        }

        if (xSyncEntries.length > 0) {
          log.debug(() => `[Subtitles] Added ${xSyncEntries.length} xSync entries`);
        }
      }

      // Add special action buttons
      let allSubtitles = [...stremioSubtitles, ...translationEntries, ...xSyncEntries];

      // If OpenSubtitles auth failed, append a final entry per language with a helpful SRT
      if (openSubsAuthFailed === true) {
        try {
          const languagesForAuthError = config.noTranslationMode
            ? (config.noTranslationLanguages || [])
            : config.sourceLanguages;
          const normalizedLangs = [...new Set(languagesForAuthError.map(lang => normalizeLanguageCode(lang)))].filter(Boolean);
          const authEntries = normalizedLangs.map(lang => ({
            id: `opensubtitles_auth_error_${lang}`,
            lang: lang,
            url: `{{ADDON_URL}}/error-subtitle/opensubtitles-auth.srt`
          }));
          if (authEntries.length > 0) {
            allSubtitles = [...allSubtitles, ...authEntries];
            log.debug(() => `[Subtitles] Appended ${authEntries.length} OpenSubtitles auth-fix entries at end of language lists`);
          }
        } catch (e) {
          log.warn(() => `[Subtitles] Failed to append OpenSubtitles auth hint entries: ${e.message}`);
        }
      }

      // Add "Sync Subtitles" button if enabled
      let actionButtons = [];
      if (config.syncSubtitlesEnabled === true) { // Temporarily disabled - change to !== false to re-enable
        const syncButtonEntry = {
          id: 'sync_subtitles',
          lang: 'Sync Subtitles',
          url: `{{ADDON_URL}}/sync-subtitles/${id}?filename=${encodeURIComponent(streamFilename || '')}`
        };
        actionButtons.push(syncButtonEntry);
        log.debug(() => '[Subtitles] Sync Subtitles is enabled, added entry');
      }

      // Add "Translate SRT" button if enabled
      if (config.fileTranslationEnabled === true) {
        const fileUploadEntry = {
          id: 'file_upload',
          lang: 'Translate SRT',
          url: `{{ADDON_URL}}/file-translate/${id}`
        };
        actionButtons.push(fileUploadEntry);
        log.debug(() => '[Subtitles] Translate SRT is enabled, added entry');
      }

      // Put action buttons at the top
      allSubtitles = [...actionButtons, ...allSubtitles];

      const totalResponseItems = stremioSubtitles.length + translationEntries.length + xSyncEntries.length + actionButtons.length;
      log.debug(() => `[Subtitles] Returning ${totalResponseItems} items (${stremioSubtitles.length} subs + ${translationEntries.length} trans + ${xSyncEntries.length} xSync + ${actionButtons.length} actions)`);

      return {
        subtitles: allSubtitles
      };

    } catch (error) {
      log.error(() => ['[Subtitles] Handler error:', error.message]);
      return { subtitles: [] };
    }
  };
}

/**
 * Handle subtitle download
 * 
 * NOTE: This function may be called automatically by Stremio when loading streams.
 * Stremio prefetches/validates subtitle URLs to check availability - this is normal
 * behavior and not a bug. The user may not have explicitly selected a subtitle.
 * 
 * @param {string} fileId - Subtitle file ID
 * @param {string} language - Language code
 * @param {Object} config - Addon configuration
 * @returns {Promise<string>} - Subtitle content
 */
async function handleSubtitleDownload(fileId, language, config) {
  try {
    log.debug(() => `[Download] Fetching subtitle ${fileId} for language ${language}`);

    // Download from the appropriate provider based on fileId format
    let content;

    // Download subtitle directly from provider (no memory caching)
    const downloadPromise = (async () => {
      if (fileId.startsWith('subdl_')) {
        // SubDL subtitle
        if (!config.subtitleProviders?.subdl?.enabled) {
          throw new Error('SubDL provider is disabled');
        }

        const subdl = new SubDLService(config.subtitleProviders.subdl.apiKey);
        log.debug(() => '[Download] Downloading subtitle via SubDL API');
        return await subdl.downloadSubtitle(fileId);
      } else if (fileId.startsWith('subsource_')) {
        // SubSource subtitle
        if (!config.subtitleProviders?.subsource?.enabled) {
          throw new Error('SubSource provider is disabled');
        }

        const subsource = new SubSourceService(config.subtitleProviders.subsource.apiKey);
        log.debug(() => '[Download] Downloading subtitle via SubSource API');
        return await subsource.downloadSubtitle(fileId);
      } else if (fileId.startsWith('v3_')) {
        // OpenSubtitles V3 subtitle
        if (!config.subtitleProviders?.opensubtitles?.enabled) {
          throw new Error('OpenSubtitles provider is disabled');
        }

        const opensubtitlesV3 = new OpenSubtitlesV3Service();
        log.debug(() => '[Download] Downloading subtitle via OpenSubtitles V3 API');
        return await opensubtitlesV3.downloadSubtitle(fileId);
      } else {
        // OpenSubtitles subtitle (Auth implementation - default)
        if (!config.subtitleProviders?.opensubtitles?.enabled) {
          throw new Error('OpenSubtitles provider is disabled');
        }

        const opensubtitles = new OpenSubtitlesService(config.subtitleProviders.opensubtitles);
        log.debug(() => '[Download] Downloading subtitle via OpenSubtitles Auth API');
        return await opensubtitles.downloadSubtitle(fileId);
      }
    })();

    // Wait for download to complete
    content = await downloadPromise;

    // Validate content
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('Downloaded subtitle content is empty');
    }

    log.debug(() => '[Download] Subtitle downloaded successfully (' + content.length + ' bytes)');
    // Reject obviously broken/corrupted files by size
    try {
      const minSize = Number(config.minSubtitleSizeBytes) || 200;
      if (content.length < minSize) {
        log.warn(() => `[Download] Subtitle content too small (${content.length} bytes < ${minSize}). Returning problem message.`);
        return createInvalidSubtitleMessage('The subtitle file is too small and seems corrupted.');
      }
    } catch (_) {}

    return content;

  } catch (error) {
    log.error(() => ['[Download] Error:', error.message]);

    // Return error message as subtitle so user knows what happened
    const errorStatus = error.response?.status || error.statusCode;

    // Handle 403 errors - API key authentication failures
    if (errorStatus === 403 || error.message.includes('403') || error.message.includes('Authentication failed')) {
      // Determine which service based on fileId
      let serviceName = 'Subtitle Provider';
      let apiKeyInstructions = 'Please check your API key in the addon configuration.';

      if (fileId.startsWith('subdl_')) {
        serviceName = 'SubDL';
        apiKeyInstructions = 'SubDL API key error\nThen update your addon configuration and reinstall.';
      } else if (fileId.startsWith('subsource_')) {
        serviceName = 'SubSource';
        apiKeyInstructions = 'SubSource API key error\nPlease update your addon configuration and reinstall.';
      } else if (fileId.startsWith('v3_')) {
        serviceName = 'OpenSubtitles V3';
        apiKeyInstructions = 'OpenSubtitles v3 should not require an API key.\nPlease report this issue if it persists.';
      } else {
        serviceName = 'OpenSubtitles';
        apiKeyInstructions = 'Please check your OpenSubtitles credentials\nin the addon configuration and reinstall.';
      }

      return `1
00:00:00,000 --> 00:00:08,000
Authentication Error (403)

2
00:00:08,001 --> 00:00:16,000
${serviceName} rejected your API key or credentials

3
00:00:16,001 --> 04:00:00,000
${apiKeyInstructions}`;
    }

    // Handle 404 errors specifically - subtitle not available
    if (errorStatus === 404 || error.message.includes('Subtitle not available') || error.message.includes('404')) {
      return `1
00:00:00,000 --> 00:00:10,000
Subtitle Not Available (Error 404)

2
00:00:10,001 --> 00:00:15,000
This subtitle was found in search results
but the file is no longer available on the server

3
00:00:15,001 --> 00:00:20,000
This often happens with unreleased movies
or subtitles that were removed

4
00:00:20,001 --> 04:00:25,000
Please try a different subtitle from the list
or enable other subtitle providers in settings`;
    }

    if (errorStatus === 503) {
      return `1
00:00:00,000 --> 00:00:10,000
OpenSubtitles API is temporarily unavailable (Error 503)

2
00:00:10,001 --> 00:00:20,000
The subtitle download service is experiencing high traffic

3
00:00:20,001 --> 00:00:30,000
Please try again in a few minutes

4
00:00:30,001 --> 04:00:40,000
Or try a different subtitle from the list`;
    }

    throw error;
  }
}

/**
 * Handle translation request with race-condition protection
 * Prevents multiple simultaneous translation requests for the same subtitle/language pair
 * @param {string} sourceFileId - Source subtitle file ID
 * @param {string} targetLanguage - Target language code
 * @param {Object} config - Addon configuration
 * @returns {Promise<string>} - Translated subtitle content or loading message
 */
async function handleTranslation(sourceFileId, targetLanguage, config) {
  try {
    log.debug(() => `[Translation] Handling translation request for ${sourceFileId} to ${targetLanguage}`);

    // Generate cache keys using shared utility (single source of truth for cache key scoping)
    const { baseKey, cacheKey, bypass, bypassEnabled, userHash } = generateCacheKeys(
      config,
      sourceFileId,
      targetLanguage
    );

    log.debug(() => `[Translation] Cache key: ${cacheKey} (bypass: ${bypass && bypassEnabled})`);


    if (bypass) {
      // Skip reading permanent cache; optionally read bypass cache
      if (bypassEnabled) {
        const bypassCached = await readFromBypassStorage(cacheKey);
        if (bypassCached) {
          // SECURITY: Validate that the cached entry belongs to this user
          // This prevents cache poisoning and ensures user isolation
          if (bypassCached.configHash && bypassCached.configHash !== userHash) {
            log.warn(() => `[Translation] Bypass cache configHash mismatch for key=${cacheKey} (cached: ${bypassCached.configHash}, current: ${userHash}) - treating as cache miss`);
            // Don't return the cached entry - treat as cache miss
            // This shouldn't happen normally, but protects against cache key collisions
          } else if (!bypassCached.configHash) {
            log.warn(() => `[Translation] Bypass cache entry missing configHash for key=${cacheKey} - treating as cache miss for security`);
            // Legacy entry without configHash - treat as cache miss for security
          } else {
            // Valid cache entry with matching configHash
            // Check if this is a cached error
            if (bypassCached.isError === true) {
              log.debug(() => ['[Translation] Cached error found (bypass) key=', cacheKey, 'â€” showing error and clearing cache']);
              const errorSrt = createTranslationErrorSubtitle(bypassCached.errorType, bypassCached.errorMessage);

              // Delete the error cache so next click retries translation
              const adapter = await getStorageAdapter();
              try {
                await adapter.delete(cacheKey, StorageAdapter.CACHE_TYPES.BYPASS);
                log.debug(() => '[Translation] Cleared error cache for retry');
              } catch (e) {
                log.warn(() => ['[Translation] Failed to delete error cache:', e.message]);
              }

              return errorSrt;
            }

            log.debug(() => ['[Translation] Cache hit (bypass) key=', cacheKey, 'userHash=', userHash, 'â€” serving cached translation']);
            cacheMetrics.hits++;
            cacheMetrics.estimatedCostSaved += 0.004;
            return bypassCached.content || bypassCached;
          }
        }
      }
    } else {
      const cached = await readFromStorage(cacheKey);
      if (cached) {
        // Check if this is a cached error
        if (cached.isError === true) {
          log.debug(() => ['[Translation] Cached error found (permanent) key=', cacheKey, 'â€” showing error and clearing cache']);
          const errorSrt = createTranslationErrorSubtitle(cached.errorType, cached.errorMessage);

          // Delete the error cache so next click retries translation
          const adapter = await getStorageAdapter();
          try {
            await adapter.delete(cacheKey, StorageAdapter.CACHE_TYPES.TRANSLATION);
            log.debug(() => '[Translation] Cleared error cache for retry');
          } catch (e) {
            log.warn(() => ['[Translation] Failed to delete error cache:', e.message]);
          }

          return errorSrt;
        }

        log.debug(() => ['[Translation] Cache hit (permanent) key=', cacheKey, 'â€” serving cached translation']);
        cacheMetrics.hits++;
        cacheMetrics.estimatedCostSaved += 0.004; // Estimated $0.004 per translation
        return cached.content || cached;
      }
    }

    // Cache miss
    cacheMetrics.misses++;
    log.debug(() => ['[Translation] Cache miss key=', cacheKey, 'â€” not cached']);

    // === RACE CONDITION PROTECTION ===
    // Check if there's already an in-flight request for this exact key
    // All simultaneous requests will share the same promise
    const inFlightPromise = inFlightTranslations.get(cacheKey);
    if (inFlightPromise) {
      log.debug(() => `[Translation] Detected in-flight translation for key=${cacheKey}; checking for partial results`);
      try {
        // DON'T WAIT for completion - immediately return available partials instead
        // Check storage first (in case it just completed)
        const cachedResult = await readFromStorage(cacheKey);
        if (cachedResult) {
          log.debug(() => '[Translation] Final result already cached; returning it');
          cacheMetrics.hits++;
          return cachedResult.content || cachedResult;
        }

        // Check partial cache (most common case - translation in progress)
        const partialResult = await readFromPartialCache(cacheKey);
        if (partialResult && typeof partialResult.content === 'string' && partialResult.content.length > 0) {
          log.debug(() => `[Translation] Returning partial result (${partialResult.content.length} chars) without waiting for completion`);
          return partialResult.content;
        }

        // No cached/partial result yet - return loading message and let user retry
        const loadingMsg = createLoadingSubtitle();
        log.debug(() => `[Translation] No partial result yet for duplicate request; returning loading message`);
        return loadingMsg;
      } catch (err) {
        log.warn(() => [`[Translation] Error checking partials for duplicate request (${cacheKey}):`, err.message]);
        // Return loading message on any error
        const loadingMsg = createLoadingSubtitle();
        return loadingMsg;
      }
    }

    // Check if translation is in progress (for backward compatibility)
    const status = translationStatus.get(cacheKey);
    if (status && status.inProgress) {
      const elapsedTime = Math.floor((Date.now() - status.startedAt) / 1000);
      log.debug(() => `[Translation] In-progress existing translation key=${cacheKey} (elapsed ${elapsedTime}s); attempting partial SRT`);
      try {
        const partial = await readFromPartialCache(cacheKey);
        if (partial && typeof partial.content === 'string' && partial.content.length > 0) {
          log.debug(() => '[Translation] Serving partial SRT from partial cache');
          return partial.content;
        }
      } catch (_) {}
      const loadingMsg = createLoadingSubtitle();
      log.debug(() => `[Translation] No partial available, returning loading SRT (size=${loadingMsg.length})`);
      return loadingMsg;
    }

    // Enforce per-user concurrency limit only when starting a new translation
    const effectiveUserHash = (userHash && userHash.length > 0) ? userHash : 'anonymous';
    const currentCount = userTranslationCounts.get(effectiveUserHash) || 0;
    if (currentCount >= MAX_CONCURRENT_TRANSLATIONS_PER_USER) {
      log.warn(() => `[Translation] Concurrency limit reached for user=${effectiveUserHash}: ${currentCount} in progress (limit ${MAX_CONCURRENT_TRANSLATIONS_PER_USER}).`);
      return createConcurrencyLimitSubtitle(MAX_CONCURRENT_TRANSLATIONS_PER_USER);
    }

    // === PRE-FLIGHT VALIDATION ===
    // Download and validate source subtitle BEFORE returning loading message
    // This prevents users from being stuck at "TRANSLATION IN PROGRESS" if subtitle is corrupted
    log.debug(() => `[Translation] Pre-flight validation: downloading source subtitle ${sourceFileId}`);

    let sourceContent;
    try {
      // Check download cache first
      sourceContent = getDownloadCached(sourceFileId);

      if (!sourceContent) {
        // Download from provider
        log.debug(() => `[Translation] Pre-flight: downloading from provider`);

        if (sourceFileId.startsWith('subdl_')) {
          if (!config.subtitleProviders?.subdl?.enabled) {
            throw new Error('SubDL provider is disabled');
          }
          const subdl = new SubDLService(config.subtitleProviders.subdl.apiKey);
          sourceContent = await subdl.downloadSubtitle(sourceFileId);
        } else if (sourceFileId.startsWith('subsource_')) {
          if (!config.subtitleProviders?.subsource?.enabled) {
            throw new Error('SubSource provider is disabled');
          }
          const subsource = new SubSourceService(config.subtitleProviders.subsource.apiKey);
          sourceContent = await subsource.downloadSubtitle(sourceFileId);
        } else if (sourceFileId.startsWith('v3_')) {
          if (!config.subtitleProviders?.opensubtitles?.enabled) {
            throw new Error('OpenSubtitles provider is disabled');
          }
          const opensubtitlesV3 = new OpenSubtitlesV3Service();
          sourceContent = await opensubtitlesV3.downloadSubtitle(sourceFileId);
        } else {
          if (!config.subtitleProviders?.opensubtitles?.enabled) {
            throw new Error('OpenSubtitles provider is disabled');
          }
          const opensubtitles = new OpenSubtitlesService(config.subtitleProviders.opensubtitles);
          sourceContent = await opensubtitles.downloadSubtitle(sourceFileId);
        }

        // Save to download cache for subsequent operations
        try {
          saveDownloadCached(sourceFileId, sourceContent);
        } catch (_) {}
      } else {
        log.debug(() => `[Translation] Pre-flight: using cached source (${sourceContent.length} bytes)`);
      }

      // Validate source size - same check as in performTranslation
      const minSize = Number(config.minSubtitleSizeBytes) || 200;
      if (!sourceContent || sourceContent.length < minSize) {
        log.warn(() => `[Translation] Pre-flight validation failed: source too small (${sourceContent?.length || 0} bytes < ${minSize})`);
        // Return corruption error immediately instead of loading message
        return createInvalidSubtitleMessage('Selected subtitle seems invalid (too small).');
      }

      log.debug(() => `[Translation] Pre-flight validation passed: ${sourceContent.length} bytes`);

    } catch (error) {
      log.error(() => ['[Translation] Pre-flight validation failed:', error.message]);
      // Return error message instead of loading message
      return createInvalidSubtitleMessage(`Download failed: ${error.message}`);
    }

    // === START BACKGROUND TRANSLATION ===
    // Mark translation as in progress and start it in background
    log.debug(() => ['[Translation] Not cached and not in-progress; starting translation key=', cacheKey]);
    translationStatus.set(cacheKey, { inProgress: true, startedAt: Date.now(), userHash: effectiveUserHash });
    userTranslationCounts.set(effectiveUserHash, currentCount + 1);

    // Create a promise for this translation that all simultaneous requests will wait for
    // Pass the already-downloaded sourceContent to avoid re-downloading
    const translationPromise = performTranslation(sourceFileId, targetLanguage, config, cacheKey, effectiveUserHash, sourceContent);
    inFlightTranslations.set(cacheKey, translationPromise);

    // Start translation in background (don't await here)
    translationPromise.catch(error => {
      // Only log if not already logged by upstream handler
      if (!error._alreadyLogged) {
        log.error(() => ['[Translation] Background translation failed:', error.message]);
      }
      // Mark as failed so it can be retried
      try {
        translationStatus.delete(cacheKey);
      } catch (_) {}
    }).finally(() => {
      // Clean up the in-flight promise when done
      inFlightTranslations.delete(cacheKey);
    });

    // Return loading message immediately
    const loadingMsg = createLoadingSubtitle();
    log.debug(() => `[Translation] Returning initial loading message (${loadingMsg.length} characters)`);
    return loadingMsg;
  } catch (error) {
    log.error(() => ['[Translation] Error:', error.message]);
    throw error;
  }
}

/**
 * Perform the actual translation in the background
 * @param {string} sourceFileId - Source subtitle file ID
 * @param {string} targetLanguage - Target language code
 * @param {Object} config - Addon configuration
 * @param {string} cacheKey - Cache key for storing result
 * @param {string} userHash - User hash for concurrency tracking
 * @param {string} preDownloadedContent - Optional pre-downloaded source content (from pre-flight validation)
 */
async function performTranslation(sourceFileId, targetLanguage, config, cacheKey, userHash, preDownloadedContent = null) {
  try {
    log.debug(() => `[Translation] Background translation started for ${sourceFileId} to ${targetLanguage}`);
    cacheMetrics.apiCalls++;

    let sourceContent;

    // Use pre-downloaded content if provided (from pre-flight validation)
    if (preDownloadedContent) {
      log.debug(() => `[Translation] Using pre-downloaded source from pre-flight validation (${preDownloadedContent.length} bytes)`);
      sourceContent = preDownloadedContent;
      // Skip download and validation since it was already done in pre-flight
    } else {
      // Fallback: Fetch subtitle content, preferring 10min download cache first
      // This avoids re-downloading the same source when translating after a direct download
      sourceContent = getDownloadCached(sourceFileId);
    if (sourceContent) {
      log.debug(() => `[Translation] Using cached source subtitle for ${sourceFileId} (${sourceContent.length} bytes)`);
    } else {
      // Download subtitle from provider
      log.debug(() => `[Translation] Cache miss â€“ downloading source subtitle from provider`);

      if (sourceFileId.startsWith('subdl_')) {
        // SubDL subtitle
        if (!config.subtitleProviders?.subdl?.enabled) {
          throw new Error('SubDL provider is disabled');
        }

        const subdl = new SubDLService(config.subtitleProviders.subdl.apiKey);
        sourceContent = await subdl.downloadSubtitle(sourceFileId);
      } else if (sourceFileId.startsWith('subsource_')) {
        // SubSource subtitle
        if (!config.subtitleProviders?.subsource?.enabled) {
          throw new Error('SubSource provider is disabled');
        }

        const subsource = new SubSourceService(config.subtitleProviders.subsource.apiKey);
        sourceContent = await subsource.downloadSubtitle(sourceFileId);
      } else if (sourceFileId.startsWith('v3_')) {
        // OpenSubtitles V3 subtitle
        if (!config.subtitleProviders?.opensubtitles?.enabled) {
          throw new Error('OpenSubtitles provider is disabled');
        }

        const opensubtitlesV3 = new OpenSubtitlesV3Service();
        sourceContent = await opensubtitlesV3.downloadSubtitle(sourceFileId);
      } else {
        // OpenSubtitles subtitle (Auth implementation - default)
        if (!config.subtitleProviders?.opensubtitles?.enabled) {
          throw new Error('OpenSubtitles provider is disabled');
        }

        const opensubtitles = new OpenSubtitlesService(config.subtitleProviders.opensubtitles);
        sourceContent = await opensubtitles.downloadSubtitle(sourceFileId);
      }

      // Save the freshly downloaded source to the 10min download cache for subsequent operations
      try {
        saveDownloadCached(sourceFileId, sourceContent);
      } catch (_) {}
    }

      // Validate source size before translation (only if not pre-validated)
      try {
        const minSize = Number(config.minSubtitleSizeBytes) || 200;
        if (!sourceContent || sourceContent.length < minSize) {
          const msg = createInvalidSubtitleMessage('Selected subtitle seems invalid (too small).');
          // Save short-lived cache to bypass storage so we never overwrite permanent translations
          await saveToBypassStorage(cacheKey, {
            content: msg,
            // expire after 10 minutes so user can try again later
            expiresAt: Date.now() + 10 * 60 * 1000,
            configHash: userHash  // Include user hash for isolation
          });
          translationStatus.delete(cacheKey);
          log.debug(() => '[Translation] Aborted due to invalid/corrupted source subtitle (too small).');
          return;
        }
      } catch (_) {}
    }

    // Convert VTT originals to SRT for translation
    try {
      const trimmed = (sourceContent || '').trimStart();
      if (trimmed.startsWith('WEBVTT')) {
        const subsrt = require('subsrt-ts');
        sourceContent = subsrt.convert(sourceContent, { to: 'srt' });
        log.debug(() => '[Translation] Converted VTT source to SRT for translation');
      }
    } catch (e) {
      log.warn(() => ['[Translation] VTT to SRT conversion failed; proceeding with original content:', e.message]);
    }

    // Get language names for better translation context
    const targetLangName = getLanguageName(targetLanguage) || targetLanguage;

    // Initialize Gemini service with advanced settings
    const gemini = new GeminiService(
      config.geminiApiKey,
      config.geminiModel,
      config.advancedSettings || {}
    );

    // Initialize new Translation Engine (structure-first approach)
    const translationEngine = new TranslationEngine(gemini);

    log.debug(() => '[Translation] Using unified translation engine');

    // Translate with smart partial delivery to reduce Redis I/O
    // Strategy: 1st batch â†’ save, then next 3 â†’ save, then next 5 â†’ save, then every 5
    let translatedContent;
    let lastSavedBatch = 0;

    const shouldSavePartial = (currentBatch) => {
      if (currentBatch === 1) return true; // 1st batch: immediate feedback
      if (currentBatch === 4) return true; // After next 3 batches (2,3,4)
      if (currentBatch === 9) return true; // After next 5 batches (5,6,7,8,9)
      if (currentBatch >= 10 && currentBatch % 5 === 0) return true; // Every 5 batches after that
      return false;
    };

    try {
      translatedContent = await translationEngine.translateSubtitle(
        sourceContent,
        targetLangName,
        config.translationPrompt,
        async (progress) => {
          // Smart partial delivery: save at strategic points to reduce Redis I/O
          if (progress.partialSRT && shouldSavePartial(progress.currentBatch) && progress.currentBatch > lastSavedBatch) {
            lastSavedBatch = progress.currentBatch;

            const partialSrt = buildPartialSrtWithTail(progress.partialSRT);
            if (partialSrt && partialSrt.length > 0) {
              await saveToPartialCacheAsync(cacheKey, {
                content: partialSrt,
                expiresAt: Date.now() + 60 * 60 * 1000
              });
              log.debug(() => `[Translation] Saved partial: batch ${progress.currentBatch}/${progress.totalBatches}, ${progress.completedEntries}/${progress.totalEntries} entries`);
            }
          }
        }
      );

      log.debug(() => '[Translation] Translation completed successfully');

    } catch (error) {
      // Only log if not already logged by upstream handler
      if (!error._alreadyLogged) {
        log.error(() => ['[Translation] Structure-first translation failed:', error.message]);
      }
      throw error;
    }

    log.debug(() => '[Translation] Background translation completed successfully');

    // Cache the translation (disk-only, permanent by default)
    const cacheConfig = config.translationCache || { enabled: true, duration: 0, persistent: true };
    const bypass = config.bypassCache === true;
    const bypassCfg = config.bypassCacheConfig || config.tempCache || {}; // Support both old and new names
    const bypassEnabled = bypass && (bypassCfg.enabled !== false);

    if (bypass && bypassEnabled) {
      // Save only to bypass storage with TTL
      const bypassDuration = (typeof bypassCfg.duration === 'number') ? bypassCfg.duration : 12;
      const expiresAt = Date.now() + (bypassDuration * 60 * 60 * 1000);

      // CRITICAL: Ensure we have a valid configHash before saving
      // At this point, userHash should always be valid due to earlier validation
      if (!userHash) {
        log.error(() => `[Translation] CRITICAL: Attempted to save bypass cache without valid userHash for key=${cacheKey} - skipping cache write`);
        // Skip bypass cache write if we somehow got here without a userHash
      } else {
        const cachedData = {
          key: cacheKey,
          content: translatedContent,
          createdAt: Date.now(),
          expiresAt,
          sourceFileId,
          targetLanguage,
          configHash: userHash  // Always set configHash for user isolation
        };
        await saveToBypassStorage(cacheKey, cachedData);
        log.debug(() => `[Translation] Saved to bypass cache: key=${cacheKey}, userHash=${userHash}, expiresAt=${new Date(expiresAt).toISOString()}`);
      }
    } else if (cacheConfig.enabled && cacheConfig.persistent !== false) {
      // Save to permanent storage (no expiry)
      const cacheDuration = cacheConfig.duration; // 0 = permanent
      const expiresAt = cacheDuration > 0 ? Date.now() + (cacheDuration * 60 * 60 * 1000) : null;
      const cachedData = {
        key: cacheKey,
        content: translatedContent,
        createdAt: Date.now(),
        expiresAt,
        sourceFileId,
        targetLanguage
      };
      await saveToStorage(cacheKey, cachedData);
    }

    // Mark translation as complete
    translationStatus.set(cacheKey, { inProgress: false, completedAt: Date.now() });

    // Clean up partial cache now that final translation is saved
    // Partial cache is no longer needed and should be deleted to free disk space
    try {
      const adapter = await getStorageAdapter();
      await adapter.delete(cacheKey, StorageAdapter.CACHE_TYPES.PARTIAL);
      log.debug(() => `[Translation] Cleaned up partial cache for ${cacheKey}`);
    } catch (e) {
      // Ignore - partial cache might not exist or already cleaned
      log.debug(() => `[Translation] Partial cache cleanup skipped (might not exist): ${e.message}`);
    }

    log.debug(() => '[Translation] Translation cached and ready to serve');

  } catch (error) {
    // Only log if not already logged by upstream handler
    if (!error._alreadyLogged) {
      log.error(() => ['[Translation] Background translation error:', error.message]);
    }

    // Determine error type for user-friendly message
    let errorType = 'other';
    let errorMessage = error.message;

    // FIRST: Check for translationErrorType set by apiErrorHandler.js (most reliable)
    if (error.translationErrorType) {
      errorType = error.translationErrorType;
    }
    // SECOND: Check for statusCode set by apiErrorHandler.js
    else if (error.statusCode) {
      if (error.statusCode === 403) {
        errorType = '403';
      } else if (error.statusCode === 503) {
        errorType = '503';
      } else if (error.statusCode === 429) {
        errorType = '429';
      }
    }
    // THIRD: Check HTTP status codes from axios error.response
    else if (error.response?.status) {
      const statusCode = error.response.status;
      if (statusCode === 403) {
        errorType = '403';
      } else if (statusCode === 503) {
        errorType = '503';
      } else if (statusCode === 429) {
        errorType = '429';
      }
    }

    // FOURTH: Check error message content (as fallback)
    if (errorType === 'other' && error.message) {
      if (error.message.includes('403')) {
        errorType = '403';
      } else if (error.message.includes('503')) {
        errorType = '503';
      } else if (error.message.includes('429')) {
        errorType = '429';
      } else if (error.message.includes('MAX_TOKENS') || error.message.includes('exceeded maximum token limit')) {
        errorType = 'MAX_TOKENS';
      } else if (error.message.includes('SAFETY') || error.message.includes('PROHIBITED_CONTENT') || error.message.includes('safety filters') || error.message.includes('RECITATION')) {
        errorType = 'PROHIBITED_CONTENT';
      } else if (error.message.includes('invalid') || error.message.includes('corrupted') || error.message.includes('too small')) {
        errorType = 'INVALID_SOURCE';
      }
    }

    log.debug(() => `[Translation] Caching error (type: ${errorType}) for user retry`);

    // Cache the error so user can see what went wrong and retry
    const bypass = config.bypassCache === true;
    const bypassCfg = config.bypassCacheConfig || config.tempCache || {};
    const bypassEnabled = bypass && (bypassCfg.enabled !== false);

    try {
      const errorCache = {
        isError: true,
        errorType: errorType,
        errorMessage: errorMessage,
        timestamp: Date.now(),
        expiresAt: Date.now() + 15 * 60 * 1000 // 15 minutes - auto-expire old errors
      };

      if (bypass && bypassEnabled) {
        // Save to bypass storage with short TTL
        errorCache.configHash = userHash;  // Include user hash for isolation
        await saveToBypassStorage(cacheKey, errorCache);
        log.debug(() => '[Translation] Error cached to bypass storage');
      } else {
        // Save to permanent storage with TTL
        await saveToStorage(cacheKey, errorCache);
        log.debug(() => '[Translation] Error cached to permanent storage');
      }
    } catch (cacheError) {
      log.warn(() => ['[Translation] Failed to cache error:', cacheError.message]);
    }

    // Remove from status so it can be retried
    try { translationStatus.delete(cacheKey); } catch (_) {}

    // Clean up partial cache on error as well
    try {
      const adapter = await getStorageAdapter();
      await adapter.delete(cacheKey, StorageAdapter.CACHE_TYPES.PARTIAL);
      log.debug(() => `[Translation] Cleaned up partial cache after error for ${cacheKey}`);
    } catch (e) {
      // Ignore - partial cache might not exist
    }

    throw error;
  } finally {
    // Decrement per-user concurrency counter
    try {
      const key = userHash || 'anonymous';
      const current = userTranslationCounts.get(key) || 0;
      if (current > 1) userTranslationCounts.set(key, current - 1);
      else userTranslationCounts.delete(key);
      log.debug(() => `[Translation] User concurrency updated user=${key} count=${userTranslationCounts.get(key) || 0}`);
    } catch (_) {}
  }
}

/**
 * Get available subtitles for translation selector
 * @param {string} videoId - Stremio video ID
 * @param {Object} config - Addon configuration
 * @returns {Promise<Array>} - Array of available subtitles
 */
async function getAvailableSubtitlesForTranslation(videoId, config) {
  try {
    log.debug(() => ['[Translation Selector] Getting subtitles for:', videoId]);

    const videoInfo = parseStremioId(videoId);
    if (!videoInfo) {
      throw new Error('Invalid video ID');
    }

    // Get ONLY source languages for translation selector
    // Users will configure one source language, and selector shows only those subtitles
    const sourceLanguages = config.sourceLanguages;

    // Build search parameters for source language subtitles only
    const searchParams = {
      imdb_id: videoInfo.imdbId,
      type: videoInfo.type,
      season: videoInfo.season,
      episode: videoInfo.episode,
      languages: sourceLanguages
    };

    // Create deduplication key based on video info and source languages
    const dedupKey = `translation-search:${videoInfo.imdbId}:${videoInfo.type}:${videoInfo.season || ''}:${videoInfo.episode || ''}:${sourceLanguages.join(',')}`;

    // Collect subtitles from all enabled providers with deduplication
    const subtitles = await deduplicateSearch(dedupKey, async () => {
      // Parallelize all provider searches using Promise.all for better performance
      const searchPromises = [];

      // Check if OpenSubtitles provider is enabled
      if (config.subtitleProviders?.opensubtitles?.enabled) {
        const implementationType = config.subtitleProviders.opensubtitles.implementationType || 'v3';

        let opensubtitles;
        if (implementationType === 'v3') {
          opensubtitles = new OpenSubtitlesV3Service();
        } else {
          opensubtitles = new OpenSubtitlesService(config.subtitleProviders.opensubtitles);
        }

        searchPromises.push(
          opensubtitles.searchSubtitles(searchParams)
            .then(results => ({ provider: `OpenSubtitles (${implementationType})`, results }))
            .catch(error => ({ provider: `OpenSubtitles (${implementationType})`, results: [], error }))
        );
      }

      // Check if SubDL provider is enabled
      if (config.subtitleProviders?.subdl?.enabled) {
        const subdl = new SubDLService(config.subtitleProviders.subdl.apiKey);
        searchPromises.push(
          subdl.searchSubtitles(searchParams)
            .then(results => ({ provider: 'SubDL', results }))
            .catch(error => ({ provider: 'SubDL', results: [], error }))
        );
      }

      // Check if SubSource provider is enabled
      if (config.subtitleProviders?.subsource?.enabled) {
        const subsource = new SubSourceService(config.subtitleProviders.subsource.apiKey);
        searchPromises.push(
          subsource.searchSubtitles(searchParams)
            .then(results => ({ provider: 'SubSource', results }))
            .catch(error => ({ provider: 'SubSource', results: [], error }))
        );
      }

      // Execute all searches in parallel
      const providerResults = await Promise.all(searchPromises);

      // Collect results from all providers
      let subs = [];
      for (const result of providerResults) {
        if (result.error) {
          log.error(() => [`[Translation Selector] ${result.provider} search failed:`, result.error.message]);
        } else {
          subs = [...subs, ...result.results];
        }
      }

      // Future providers can be added here

      log.debug(() => `[Translation Selector] Found ${subs.length} subtitles total`);
      return subs;
    });

    return subtitles;

  } catch (error) {
    log.error(() => ['[Translation Selector] Error:', error.message]);
    return [];
  }
}

// Clean up expired disk cache entries periodically (only needed for non-permanent caches)
setInterval(() => {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      return;
    }

    const now = Date.now();
    const files = fs.readdirSync(CACHE_DIR);
    let removedCount = 0;

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const filePath = path.join(CACHE_DIR, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const cached = JSON.parse(content);

        // Check if cache has expired
        if (cached.expiresAt && now > cached.expiresAt) {
          fs.unlinkSync(filePath);
          removedCount++;
        }
      } catch (error) {
        // Ignore errors for individual files
      }
    }

    if (removedCount > 0) {
      log.debug(() => `[Cache] Cleaned up ${removedCount} expired disk cache entries`);
    }
  } catch (error) {
    log.error(() => ['[Cache] Failed to clean up disk cache:', error.message]);
  }
}, 1000 * 60 * 60); // Every hour (less frequent for disk operations)
// Also clean up bypass cache (more frequent not needed here)
setInterval(() => {
  try {
    verifyBypassCacheIntegrity();
  } catch (error) {
    // ignore
  }
}, 1000 * 60 * 60);

// Note: No manual cleanup needed for translationStatus - LRU cache handles TTL automatically


module.exports = {
  createSubtitleHandler,
  handleSubtitleDownload,
  handleTranslation,
  getAvailableSubtitlesForTranslation,
  createLoadingSubtitle, // Export for loading message in translation endpoint
  createSessionTokenErrorSubtitle, // Export for session token error subtitle
  createOpenSubtitlesAuthErrorSubtitle, // Export for OpenSubtitles auth error subtitle
  createInvalidSubtitleMessage, // Export for corrupted/invalid subtitle error message
  readFromPartialCache, // Export for checking in-flight partial results during duplicate requests
  translationStatus, // Export for safety block to check if translation is in progress
  /**
   * Check if a translated subtitle exists in cache (bypass or permanent)
   * Mirrors the cache key logic used in handleTranslation
   */
  hasCachedTranslation: async function (sourceFileId, targetLanguage, config) {
    try {
      const baseKey = `${sourceFileId}_${targetLanguage}`;

      // Determine which cache type the user is using
      const bypass = config && config.bypassCache === true;
      const bypassCfg = (config && (config.bypassCacheConfig || config.tempCache)) || {};
      const bypassEnabled = bypass && (bypassCfg.enabled !== false);

      const userHash = (config && typeof config.__configHash === 'string' && config.__configHash.length > 0)
        ? config.__configHash
        : '';

      if (bypass && bypassEnabled && userHash) {
        // Check bypass cache with user-scoped key
        const scopedKey = `${baseKey}__u_${userHash}`;
        const cached = await readFromBypassCache(scopedKey);
        return !!(cached && ((cached.content && typeof cached.content === 'string' && cached.content.length > 0) || (typeof cached === 'string' && cached.length > 0)));
      } else {
        // Check permanent cache
        const cached = await readFromStorage(baseKey);
        return !!(cached && ((cached.content && typeof cached.content === 'string' && cached.content.length > 0) || (typeof cached === 'string' && cached.length > 0)));
      }
    } catch (_) {
      return false;
    }
  },
  /**
   * Purge cached translation based on user's cache type and reset in-progress state
   * CACHE-TYPE AWARE: Only deletes the cache type the user is using
   */
  purgeTranslationCache: async function (sourceFileId, targetLanguage, config) {
    try {
      const baseKey = `${sourceFileId}_${targetLanguage}`;
      const adapter = await getStorageAdapter();

      // Determine which cache type the user is using
      const bypass = config && config.bypassCache === true;
      const bypassCfg = (config && (config.bypassCacheConfig || config.tempCache)) || {};
      const bypassEnabled = bypass && (bypassCfg.enabled !== false);

      const userHash = (config && typeof config.__configHash === 'string' && config.__configHash.length > 0)
        ? config.__configHash
        : '';

      // CACHE-TYPE AWARE DELETION: Only delete the cache type the user is using
      if (bypass && bypassEnabled) {
        // User is using BYPASS CACHE - only delete bypass cache entries
        log.debug(() => `[Purge] User is using bypass cache - deleting bypass entries only`);

        try {
          // Delete user-scoped bypass cache (primary key)
          if (userHash) {
            const scopedKey = `${baseKey}__u_${userHash}`;
            await adapter.delete(scopedKey, StorageAdapter.CACHE_TYPES.BYPASS);
            log.debug(() => `[Purge] Removed user-scoped bypass cache for ${scopedKey}`);
          }

          // Also try deleting unscoped bypass cache (legacy fallback)
          // This handles old entries created before user isolation was implemented
          try {
            await adapter.delete(baseKey, StorageAdapter.CACHE_TYPES.BYPASS);
            log.debug(() => `[Purge] Removed legacy unscoped bypass cache for ${baseKey}`);
          } catch (e) {
            // Ignore - legacy key might not exist
          }
        } catch (e) {
          log.warn(() => [`[Purge] Failed removing bypass cache for ${baseKey}:`, e.message]);
        }

        // Clear user-scoped translation status
        try {
          if (userHash) {
            const scopedKey = `${baseKey}__u_${userHash}`;
            translationStatus.delete(scopedKey);
            log.debug(() => `[Purge] Cleared user-scoped translation status for ${scopedKey}`);
          }
        } catch (_) {}

      } else {
        // User is using PERMANENT CACHE - only delete permanent cache
        log.debug(() => `[Purge] User is using permanent cache - deleting permanent entries only`);

        try {
          await adapter.delete(baseKey, StorageAdapter.CACHE_TYPES.TRANSLATION);
          log.debug(() => `[Purge] Removed permanent cache for ${baseKey}`);
        } catch (e) {
          log.warn(() => [`[Purge] Failed removing permanent cache for ${baseKey}:`, e.message]);
        }

        // Clear unscoped translation status
        try {
          translationStatus.delete(baseKey);
          log.debug(() => `[Purge] Cleared translation status for ${baseKey}`);
        } catch (_) {}
      }

      // ALWAYS delete partial cache (in-flight translations)
      // Partial cache stores incomplete translations that are still being generated
      // IMPORTANT: For bypass cache, partial cache is also user-scoped
      try {
        if (bypass && bypassEnabled && userHash) {
          // Delete user-scoped partial cache for bypass users
          const scopedKey = `${baseKey}__u_${userHash}`;
          await adapter.delete(scopedKey, StorageAdapter.CACHE_TYPES.PARTIAL);
          log.debug(() => `[Purge] Removed user-scoped partial cache for ${scopedKey}`);
        } else {
          // Delete unscoped partial cache for permanent cache users
          await adapter.delete(baseKey, StorageAdapter.CACHE_TYPES.PARTIAL);
          log.debug(() => `[Purge] Removed partial cache for ${baseKey}`);
        }
      } catch (e) {
        // Ignore - partial cache might not exist
      }

      return true;
    } catch (error) {
      log.error(() => ['[Purge] Error purging translation cache:', error.message]);
      return false;
    }
  },
  /**
   * Check if a user can start a new translation without hitting the concurrency limit
   * Used by the 3-click reset safety check to prevent purging cache if re-translation would fail
   */
  canUserStartTranslation,
  /**
   * In-flight translations tracker
   * Used by the 3-click reset safety check to prevent purging cache during active translations
   */
  inFlightTranslations
};

