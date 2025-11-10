const OpenSubtitlesService = require('../services/opensubtitles');
const SubDLService = require('../services/subdl');
const SubSourceService = require('../services/subsource');
const PodnapisService = require('../services/podnapisi');
const GeminiService = require('../services/gemini');
const { parseSRT, toSRT, parseStremioId } = require('../utils/subtitle');
const { getLanguageName, getDisplayName } = require('../utils/languages');
const { LRUCache } = require('lru-cache');
const syncCache = require('../utils/syncCache');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Redact/noise-reduce helper for logging large cache keys
function shortKey(v) {
  try {
    return crypto.createHash('sha1').update(String(v)).digest('hex').slice(0, 8);
  } catch (_) {
    const s = String(v || '');
    return s.length > 12 ? s.slice(0, 12) + '…' : s;
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

// Security: Maximum cache size (20GB)
const MAX_CACHE_SIZE_BYTES = 20 * 1024 * 1024 * 1024; // 20GB

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
Subtitles load progressively during translation.
Please wait ~1-3 minutes and reselect this subtitle.
Partial results will appear as they are ready.`;

  // Log the loading subtitle for debugging
  console.log('[Subtitles] Created loading subtitle with', srt.split('\n\n').length, 'entries');
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
      return `${mergedSrt}\n\n${lineCount}\n00:00:00,000 --> 04:00:00,000\nTRANSLATION IN PROGRESS\nReload this subtitle later to get more`;
    }

    const reindexed = entries.map((e, idx) => ({ id: idx + 1, timecode: e.timecode, text: (e.text || '').trim() }))
                             .filter(e => e.timecode && e.text);

    if (reindexed.length === 0) {
      // No valid entries after filtering, but we have content - append loading tail
      const lineCount = mergedSrt.split('\n').length + 10;
      return `${mergedSrt}\n\n${lineCount}\n00:00:00,000 --> 04:00:00,000\nTRANSLATION IN PROGRESS\nReload this subtitle later to get more`;
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
    console.warn('[Subtitles] Error building partial SRT with tail:', e.message);
    // As fallback, if we have content, append a simple loading tail
    if (mergedSrt && typeof mergedSrt === 'string' && mergedSrt.trim().length > 0) {
      const lineCount = mergedSrt.split('\n').length + 10;
      return `${mergedSrt}\n\n${lineCount}\n00:00:00,000 --> 04:00:00,000\nTRANSLATION IN PROGRESS\nReload this subtitle later to get more`;
    }
    return null;
  }
}

// Create a concise error subtitle when a source file looks invalid/corrupted
function createInvalidSubtitleMessage(reason = 'The subtitle file appears to be invalid or incomplete.') {
  const srt = `1
00:00:00,000 --> 00:00:08,000
Subtitle Problem Detected

2
00:00:08,001 --> 00:00:18,000
${reason}

3
00:00:18,001 --> 04:00:00,000
Please try another subtitle from the list.`;
  return srt;
}

// Create an SRT explaining concurrency limit reached, visible across the whole video timeline
function createConcurrencyLimitSubtitle(limit = MAX_CONCURRENT_TRANSLATIONS_PER_USER) {
  return `1
00:00:00,000 --> 04:00:00,000
Too many concurrent translations for this user (limit: ${limit}).\nPlease wait for one to finish, then try again.`;
}

// Initialize cache directory
function initializeCacheDirectory() {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      console.log('[Cache] Created translation cache directory');
    }
    if (!fs.existsSync(BYPASS_CACHE_DIR)) {
      fs.mkdirSync(BYPASS_CACHE_DIR, { recursive: true });
      console.log('[Cache] Created bypass translation cache directory');
    }
  } catch (error) {
    console.error('[Cache] Failed to create cache directory:', error.message);
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
        console.error(`[Cache] Corrupt cache file ${file}:`, error.message);
        // Delete corrupt files
        try {
          fs.unlinkSync(path.join(CACHE_DIR, file));
          corruptCount++;
        } catch (e) {
          // Ignore deletion errors
        }
      }
    }

    console.log(`[Cache] Integrity check: ${validCount} valid, ${expiredCount} expired (cleaned), ${corruptCount} corrupt (removed)`);
  } catch (error) {
    console.error('[Cache] Failed to verify cache integrity:', error.message);
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
      console.log(`[Bypass Cache] Cleaned ${removedCount} expired entries`);
    }
  } catch (error) {
    console.error('[Bypass Cache] Failed to verify/clean bypass cache:', error.message);
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

// Read translation from disk cache
function readFromDisk(cacheKey) {
  try {
    const safeKey = sanitizeCacheKey(cacheKey);
    const filePath = path.join(CACHE_DIR, `${safeKey}.json`);

    // Security: Verify the resolved path is still within CACHE_DIR
    const resolvedPath = path.resolve(filePath);
    const resolvedCacheDir = path.resolve(CACHE_DIR);
    if (!resolvedPath.startsWith(resolvedCacheDir)) {
      console.error(`[Cache] Security: Path traversal attempt detected for key ${cacheKey}`);
      return null;
    }

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    // Touch file to update atime so LRU eviction prefers truly old entries
    try {
      const stats = fs.statSync(filePath);
      fs.utimesSync(filePath, new Date(), stats.mtime);
    } catch (_) {}
    const cached = JSON.parse(content);

    // Check if cache is still valid
    if (cached.expiresAt && Date.now() > cached.expiresAt) {
      // Expired, delete file
      fs.unlinkSync(filePath);
      return null;
    }

    cacheMetrics.diskReads++;
    return cached;
  } catch (error) {
    console.error(`[Cache] Failed to read from disk for key ${cacheKey}:`, error.message);
    return null;
  }
}

// Read translation from bypass disk cache
function readFromBypassCache(cacheKey) {
  try {
    const safeKey = sanitizeCacheKey(cacheKey);
    const filePath = path.join(BYPASS_CACHE_DIR, `${safeKey}.json`);

    const resolvedPath = path.resolve(filePath);
    const resolvedCacheDir = path.resolve(BYPASS_CACHE_DIR);
    if (!resolvedPath.startsWith(resolvedCacheDir)) {
      console.error(`[Bypass Cache] Security: Path traversal attempt detected for key ${cacheKey}`);
      return null;
    }

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const cached = JSON.parse(content);

    if (!cached.expiresAt || Date.now() > cached.expiresAt) {
      try { fs.unlinkSync(filePath); } catch (_) {}
      return null;
    }

    cacheMetrics.diskReads++;
    return cached;
  } catch (error) {
    console.error(`[Bypass Cache] Failed to read from bypass cache for key ${cacheKey}:`, error.message);
    return null;
  }
}

// Save translation to disk
function saveToDisk(cacheKey, cachedData) {
  try {
    const safeKey = sanitizeCacheKey(cacheKey);
    const filePath = path.join(CACHE_DIR, `${safeKey}.json`);
    const tempPath = path.join(CACHE_DIR, `${safeKey}.json.tmp`);

    // Security: Verify the resolved path is still within CACHE_DIR
    const resolvedPath = path.resolve(filePath);
    const resolvedCacheDir = path.resolve(CACHE_DIR);
    if (!resolvedPath.startsWith(resolvedCacheDir)) {
      console.error(`[Cache] Security: Path traversal attempt detected for key ${cacheKey}`);
      return;
    }

    // Atomic write: write to temp then rename
    try {
      const fd = fs.openSync(tempPath, 'w');
      const data = JSON.stringify(cachedData, null, 2);
      fs.writeSync(fd, data);
      // Ensure data hits disk before rename (best effort on platforms that support it)
      try { fs.fsyncSync(fd); } catch (_) {}
      fs.closeSync(fd);
      fs.renameSync(tempPath, filePath);
    } finally {
      // Cleanup stray temp file on failure
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
    }
    cacheMetrics.diskWrites++;

    // Update cache size metrics
    const stats = fs.statSync(filePath);
    cacheMetrics.totalCacheSize += stats.size;

    console.log(`[Cache] Saved translation to disk: ${safeKey} (expires: ${cachedData.expiresAt ? new Date(cachedData.expiresAt).toISOString() : 'never'})`);

    // Check if we need to enforce size limit
    if (cacheMetrics.totalCacheSize > MAX_CACHE_SIZE_BYTES) {
      console.log('[Cache] Cache size limit exceeded, triggering eviction');
      enforceCacheSizeLimit();
    }
  } catch (error) {
    console.error('[Cache] Failed to save translation to disk:', error.message);
  }
}

// Save translation to bypass disk cache (for user-controlled bypass cache config)
function saveToBypassCache(cacheKey, cachedData) {
  try {
    const safeKey = sanitizeCacheKey(cacheKey);
    const filePath = path.join(BYPASS_CACHE_DIR, `${safeKey}.json`);

    const resolvedPath = path.resolve(filePath);
    const resolvedCacheDir = path.resolve(BYPASS_CACHE_DIR);
    if (!resolvedPath.startsWith(resolvedCacheDir)) {
      console.error(`[Bypass Cache] Security: Path traversal attempt detected for key ${cacheKey}`);
      return;
    }

    fs.writeFileSync(filePath, JSON.stringify(cachedData, null, 2), 'utf8');
    cacheMetrics.diskWrites++;
  } catch (error) {
    console.error('[Bypass Cache] Failed to save translation to bypass cache:', error.message);
  }
}

// Save partial translation result during chunking/streaming (separate from user bypass config)
function saveToPartialCache(cacheKey, cachedData) {
  try {
    const safeKey = sanitizeCacheKey(cacheKey);
    const filePath = path.join(PARTIAL_CACHE_DIR, `${safeKey}.json`);

    // Ensure partial cache directory exists
    if (!fs.existsSync(PARTIAL_CACHE_DIR)) {
      fs.mkdirSync(PARTIAL_CACHE_DIR, { recursive: true });
    }

    const resolvedPath = path.resolve(filePath);
    const resolvedCacheDir = path.resolve(PARTIAL_CACHE_DIR);
    if (!resolvedPath.startsWith(resolvedCacheDir)) {
      console.error(`[Partial Cache] Security: Path traversal attempt detected for key ${cacheKey}`);
      return;
    }

    fs.writeFileSync(filePath, JSON.stringify(cachedData, null, 2), 'utf8');
    cacheMetrics.diskWrites++;
  } catch (error) {
    console.error('[Partial Cache] Failed to save partial translation:', error.message);
  }
}

// Async version of saveToPartialCache with write queue to prevent blocking
const writeQueue = [];
let isProcessingQueue = false;

async function saveToPartialCacheAsync(cacheKey, cachedData) {
  return new Promise((resolve) => {
    writeQueue.push({ cacheKey, cachedData, resolve });
    if (!isProcessingQueue) {
      processWriteQueue();
    }
  });
}

async function processWriteQueue() {
  if (writeQueue.length === 0) {
    isProcessingQueue = false;
    return;
  }

  isProcessingQueue = true;
  const { cacheKey, cachedData, resolve } = writeQueue.shift();

  try {
    const safeKey = sanitizeCacheKey(cacheKey);
    const filePath = path.join(PARTIAL_CACHE_DIR, `${safeKey}.json`);

    // Ensure partial cache directory exists
    if (!fs.existsSync(PARTIAL_CACHE_DIR)) {
      fs.mkdirSync(PARTIAL_CACHE_DIR, { recursive: true });
    }

    const resolvedPath = path.resolve(filePath);
    const resolvedCacheDir = path.resolve(PARTIAL_CACHE_DIR);
    if (!resolvedPath.startsWith(resolvedCacheDir)) {
      console.error(`[Partial Cache] Security: Path traversal attempt detected for key ${cacheKey}`);
      resolve();
      processWriteQueue();
      return;
    }

    await fs.promises.writeFile(filePath, JSON.stringify(cachedData, null, 2), 'utf8');
    cacheMetrics.diskWrites++;
    resolve();
  } catch (error) {
    console.error('[Partial Cache] Failed to save partial translation (async):', error.message);
    resolve();
  }

  // Continue processing next item in queue
  processWriteQueue();
}

// Read partial translation result during chunking/streaming
function readFromPartialCache(cacheKey) {
  try {
    const safeKey = sanitizeCacheKey(cacheKey);
    const filePath = path.join(PARTIAL_CACHE_DIR, `${safeKey}.json`);

    const resolvedPath = path.resolve(filePath);
    const resolvedCacheDir = path.resolve(PARTIAL_CACHE_DIR);
    if (!resolvedPath.startsWith(resolvedCacheDir)) {
      console.error(`[Partial Cache] Security: Path traversal attempt detected for key ${cacheKey}`);
      return null;
    }

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const cached = JSON.parse(content);

    // Check if partial has expired (default 1 hour TTL for in-flight partials)
    if (!cached.expiresAt || Date.now() > cached.expiresAt) {
      try { fs.unlinkSync(filePath); } catch (_) {}
      return null;
    }

    cacheMetrics.diskReads++;
    return cached;
  } catch (error) {
    console.error(`[Partial Cache] Failed to read from partial for key ${cacheKey}:`, error.message);
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
    console.error('[Cache] Failed to calculate cache size:', error.message);
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

    console.log(`[Cache] Cache size (${(totalSize / 1024 / 1024 / 1024).toFixed(2)}GB) exceeds limit (${(MAX_CACHE_SIZE_BYTES / 1024 / 1024 / 1024).toFixed(2)}GB), performing LRU eviction`);

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
        console.error(`[Cache] Failed to evict file ${file.path}:`, error.message);
      }
    }

    console.log(`[Cache] LRU eviction complete: removed ${evictedCount} files, new size: ${(currentSize / 1024 / 1024 / 1024).toFixed(2)}GB`);
    cacheMetrics.totalCacheSize = currentSize;

  } catch (error) {
    console.error('[Cache] Failed to enforce cache size limit:', error.message);
  }
}

// Log cache metrics periodically
function logCacheMetrics() {
  const uptime = Math.floor((Date.now() - cacheMetrics.lastReset) / 1000 / 60); // minutes
  const hitRate = cacheMetrics.hits + cacheMetrics.misses > 0
    ? ((cacheMetrics.hits / (cacheMetrics.hits + cacheMetrics.misses)) * 100).toFixed(1)
    : 0;
  const cacheSizeGB = (cacheMetrics.totalCacheSize / 1024 / 1024 / 1024).toFixed(2);

  console.log(`[Cache Metrics] Uptime: ${uptime}m | Hits: ${cacheMetrics.hits} | Misses: ${cacheMetrics.misses} | Hit Rate: ${hitRate}% | Disk R/W: ${cacheMetrics.diskReads}/${cacheMetrics.diskWrites} | API Calls: ${cacheMetrics.apiCalls} | Est. Cost Saved: $${cacheMetrics.estimatedCostSaved.toFixed(3)} | Cache Size: ${cacheSizeGB}GB | Evicted: ${cacheMetrics.filesEvicted}`);
}

// Initialize cache on module load
initializeCacheDirectory();
verifyCacheIntegrity();
verifyBypassCacheIntegrity();

// Calculate initial cache size
cacheMetrics.totalCacheSize = calculateCacheSize();
console.log(`[Cache] Initial cache size: ${(cacheMetrics.totalCacheSize / 1024 / 1024 / 1024).toFixed(2)}GB`);

// Log metrics every 30 minutes
setInterval(logCacheMetrics, 1000 * 60 * 30);

// Enforce cache size limit every 10 minutes
setInterval(enforceCacheSizeLimit, 1000 * 60 * 10);
// Cleanup bypass cache periodically
setInterval(verifyBypassCacheIntegrity, 1000 * 60 * 30);

/**
 * Deduplicates subtitle search requests
 * @param {string} key - Unique key for the request
 * @param {Function} fn - Function to execute if not already in flight
 * @returns {Promise} - Promise result
 */
async function deduplicateSearch(key, fn) {
    const cached = inFlightSearches.get(key);
    if (cached) {
        console.log(`[Dedup] Subtitle search already in flight: ${key}`);
        return cached.promise;
    }

    console.log(`[Dedup] Processing new subtitle search: ${key}`);
    const promise = fn();

    inFlightSearches.set(key, { promise });

    try {
        const result = await promise;
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

  // Quality tier detection (lower tier = more specific, more likely to sync)
  let qualityTier = 0;
  if (lower.includes('webrip')) qualityTier = 1; // Most specific/common for subs
  else if (lower.includes('bluray') || lower.includes('bdrip')) qualityTier = 2;
  else if (lower.includes('hdtv')) qualityTier = 3;
  else if (lower.includes('dvdrip')) qualityTier = 4;
  else if (lower.includes('ts') || lower.includes('telesync')) qualityTier = 5;

  // Codec detection
  let codec = null;
  if (lower.includes('x265') || lower.includes('h.265') || lower.includes('h265')) codec = 'x265';
  else if (lower.includes('x264') || lower.includes('h.264') || lower.includes('h264')) codec = 'x264';

  // Extract release group (usually at end, after last dash or bracket)
  let releaseGroup = null;
  const groupMatch = filename.match(/[-_]([A-Z0-9]{2,})\s*$/i);
  if (groupMatch) {
    releaseGroup = groupMatch[1].toLowerCase();
  }

  return { resolution, qualityTier, codec, releaseGroup };
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
      score += 3000; // Exact release group match = very high probability
    } else {
      score -= 100; // Different release groups = lower probability
    }
  }

  // QUALITY TIER MATCHING (second priority)
  // Lower tier (more specific) quality markers are better
  if (streamMeta.qualityTier > 0 && subtitleMeta.qualityTier > 0) {
    const tierDifference = Math.abs(streamMeta.qualityTier - subtitleMeta.qualityTier);
    if (tierDifference === 0) {
      score += 1500; // Same quality tier = very likely to match
    } else if (tierDifference === 1) {
      score += 700; // Adjacent quality tier (acceptable match)
    } else {
      score -= 300; // Very different quality tiers (less likely to match)
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

  // CODEC MATCHING (bonus for matching codec)
  if (streamMeta.codec && subtitleMeta.codec) {
    if (streamMeta.codec === subtitleMeta.codec) {
      score += 300; // Same codec = good sign
    }
  }

  // TOKEN-BASED MATCHING for other distinguishing factors
  // Split by separators and match tokens
  const streamTokens = stream
    .replace(/\.[^.]+$/, '') // Remove extension
    .split(/[_\-\.\s]+/)
    .filter(t => t.length > 2); // Only meaningful tokens

  const subtitleTokens = subtitle
    .replace(/\.[^.]+$/, '')
    .split(/[_\-\.\s]+/)
    .filter(t => t.length > 2);

  // Match tokens (especially year, season/episode numbers)
  let tokenMatches = 0;
  for (const token of streamTokens) {
    if (/^\d+$/.test(token) && subtitleTokens.includes(token)) {
      // Numeric tokens (year, season, episode) are very important
      tokenMatches += 2;
    } else if (subtitleTokens.includes(token)) {
      tokenMatches += 1;
    }
  }

  if (tokenMatches > 0) {
    score += tokenMatches * 100;
  }

  // PENALTY: If subtitle has minimal info (very short), it's less likely to be accurate match
  if (subtitleTokens.length < 2) {
    score *= 0.5;
  }

  // BONUS: If subtitle name is very similar in structure/length, it's probably the right one
  const tokenRatio = Math.min(streamTokens.length, subtitleTokens.length) /
                     Math.max(streamTokens.length, subtitleTokens.length);
  if (tokenRatio > 0.7) {
    score *= 1.2; // Similar structure = good sign
  }

  return Math.max(0, Math.round(score));
}

/**
 * Sort subtitles by filename match score
 * @param {Array} subtitles - Array of subtitle objects
 * @param {string} streamFilename - Stream filename from Stremio
 * @returns {Array} - Sorted subtitles (best matches first)
 */
function rankSubtitlesByFilename(subtitles, streamFilename) {
  if (!streamFilename || subtitles.length === 0) {
    return subtitles;
  }

  const withScores = subtitles.map(sub => ({
    ...sub,
    _matchScore: calculateFilenameMatchScore(streamFilename, sub.name || '')
  }));

  // Sort by match score descending (highest first)
  withScores.sort((a, b) => b._matchScore - a._matchScore);

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
      console.log('[Subtitles] Handler called with args:', JSON.stringify(args));

      const { type, id, extra } = args;
      const videoInfo = parseStremioId(id);

      if (!videoInfo) {
        console.error('[Subtitles] Invalid video ID:', id);
        return { subtitles: [] };
      }

      console.log('[Subtitles] Video info:', videoInfo);

      // Extract stream filename for matching
      const streamFilename = extra?.filename || '';
      if (streamFilename) {
        console.log('[Subtitles] Stream filename for matching:', streamFilename);
      }

      // Get all languages (source + target) for searching
      // This way users can find subtitles already in target languages and use them directly
      const allLanguages = [...new Set([...config.sourceLanguages, ...config.targetLanguages])];

      // Build search parameters for all providers
      const searchParams = {
        imdb_id: videoInfo.imdbId,
        type: videoInfo.type,
        season: videoInfo.season,
        episode: videoInfo.episode,
        languages: allLanguages
      };

      // Create deduplication key based on video info and languages
      const dedupKey = `subtitle-search:${videoInfo.imdbId}:${videoInfo.type}:${videoInfo.season || ''}:${videoInfo.episode || ''}:${allLanguages.join(',')}`;

      // Collect subtitles from all enabled providers with deduplication
      const foundSubtitles = await deduplicateSearch(dedupKey, async () => {
        let subtitles = [];

        // Check if OpenSubtitles provider is enabled
        if (config.subtitleProviders?.opensubtitles?.enabled) {
          console.log('[Subtitles] OpenSubtitles provider is enabled');
          const opensubtitles = new OpenSubtitlesService(config.subtitleProviders.opensubtitles);
          const opensubtitlesResults = await opensubtitles.searchSubtitles(searchParams);
          console.log(`[Subtitles] Found ${opensubtitlesResults.length} subtitles from OpenSubtitles`);
          subtitles = [...subtitles, ...opensubtitlesResults];
        } else {
          console.log('[Subtitles] OpenSubtitles provider is disabled');
        }

        // Check if SubDL provider is enabled
        if (config.subtitleProviders?.subdl?.enabled) {
          console.log('[Subtitles] SubDL provider is enabled');
          const subdl = new SubDLService(config.subtitleProviders.subdl.apiKey);
          const subdlResults = await subdl.searchSubtitles(searchParams);
          console.log(`[Subtitles] Found ${subdlResults.length} subtitles from SubDL`);
          subtitles = [...subtitles, ...subdlResults];
        } else {
          console.log('[Subtitles] SubDL provider is disabled');
        }

        // Check if SubSource provider is enabled
        if (config.subtitleProviders?.subsource?.enabled) {
          console.log('[Subtitles] SubSource provider is enabled');
          const subsource = new SubSourceService(config.subtitleProviders.subsource.apiKey);
          const subsourceResults = await subsource.searchSubtitles(searchParams);
          console.log(`[Subtitles] Found ${subsourceResults.length} subtitles from SubSource`);
          subtitles = [...subtitles, ...subsourceResults];
        } else {
          console.log('[Subtitles] SubSource provider is disabled');
        }

        // Check if Podnapisi provider is enabled
        if (config.subtitleProviders?.podnapisi?.enabled) {
          console.log('[Subtitles] Podnapisi provider is enabled');
          const podnapisi = new PodnapisService(config.subtitleProviders.podnapisi.apiKey);
          const podnapisResults = await podnapisi.searchSubtitles(searchParams);
          console.log(`[Subtitles] Found ${podnapisResults.length} subtitles from Podnapisi`);
          subtitles = [...subtitles, ...podnapisResults];
        } else {
          console.log('[Subtitles] Podnapisi provider is disabled');
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

      // Filter results to only allowed languages
      let filteredFoundSubtitles = foundSubtitles.filter(sub => sub.languageCode && normalizedAllLangs.has(sub.languageCode));

      // Rank subtitles by filename match before creating response lists
      // This ensures the best matches appear first in Stremio UI
      if (streamFilename) {
        filteredFoundSubtitles = rankSubtitlesByFilename(filteredFoundSubtitles, streamFilename);
        console.log('[Subtitles] Ranked subtitles by filename match');
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
      console.log(`[Subtitles] Limited to ${MAX_SUBS_PER_LANGUAGE} subtitles per language (${filteredFoundSubtitles.length} total)`);

      // Convert to Stremio subtitle format
      // Validate required fields before creating response objects
      const stremioSubtitles = filteredFoundSubtitles
        .filter(sub => {
          // Validate required fields exist and have valid values
          if (!sub.fileId || typeof sub.fileId !== 'string') {
            console.warn('[Subtitles] Skipping subtitle: missing or invalid fileId', sub);
            return false;
          }
          if (!sub.languageCode || typeof sub.languageCode !== 'string') {
            console.warn('[Subtitles] Skipping subtitle: missing or invalid languageCode', sub);
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

            // Add translation buttons for each target language
       // Normalize and deduplicate target languages
      const normalizedTargetLangs = [...new Set(config.targetLanguages.map(lang => {
        const normalized = normalizeLanguageCode(lang);
        if (normalized !== lang) {
          console.log(`[Subtitles] Normalized language code: "${lang}" -> "${normalized}"`);
        }
        return normalized;
      }))];

      // Create translation entries: for each target language, create entries for top source language subtitles
      // Note: filteredFoundSubtitles is already limited to 12 per language (including source languages)
      const sourceSubtitles = filteredFoundSubtitles.filter(sub =>
        config.sourceLanguages.some(sourceLang => {
          const normalized = normalizeLanguageCode(sourceLang);
          return sub.languageCode === normalized;
        })
      );

      console.log(`[Subtitles] Found ${sourceSubtitles.length} source language subtitles for translation (already limited to ${MAX_SUBS_PER_LANGUAGE} per language)`);

      // For each target language, create a translation entry for each source subtitle
      // Translation entries are created from the already-limited source subtitles (12 per source language)
      const translationEntries = [];
      for (const targetLang of normalizedTargetLangs) {
        const baseName = getLanguageName(targetLang);
        const displayName = `Make ${baseName}`;
        console.log(`[Subtitles] Creating translation entries for ${displayName} (${targetLang})`);

        for (const sourceSub of sourceSubtitles) {
          const translationEntry = {
            id: `translate_${sourceSub.fileId}_to_${targetLang}`,
            lang: displayName, // Display as "Make Language" in Stremio UI
            url: `{{ADDON_URL}}/translate/${sourceSub.fileId}/${targetLang}`
          };
          translationEntries.push(translationEntry);
        }
      }

      console.log(`[Subtitles] Created ${translationEntries.length} translation options from ${sourceSubtitles.length} source subtitles`);

      // Add xSync entries (synced subtitles from cache)
      const xSyncEntries = [];
      if (streamFilename && config.syncSubtitlesEnabled !== false) {
        // Generate video hash from stream filename (similar approach for cache key)
        const videoHash = crypto.createHash('md5').update(streamFilename).digest('hex').substring(0, 16);

        // Get synced subtitles for each language
        const allLangsForSync = [...new Set([...config.sourceLanguages, ...config.targetLanguages])];

        for (const lang of allLangsForSync) {
          try {
            const syncedSubs = await syncCache.getSyncedSubtitles(videoHash, lang);

            if (syncedSubs && syncedSubs.length > 0) {
              const langName = getLanguageName(lang);
              console.log(`[Subtitles] Found ${syncedSubs.length} synced subtitle(s) for ${langName}`);

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
            console.error(`[Subtitles] Failed to get xSync entries for ${lang}:`, error.message);
          }
        }

        if (xSyncEntries.length > 0) {
          console.log(`[Subtitles] Added ${xSyncEntries.length} xSync entries`);
        }
      }

      // Add special action buttons
      let allSubtitles = [...stremioSubtitles, ...translationEntries, ...xSyncEntries];

      // Add "Sync Subtitles" button if enabled
      let actionButtons = [];
      if (config.syncSubtitlesEnabled === true) { // Temporarily disabled - change to !== false to re-enable
        const syncButtonEntry = {
          id: 'sync_subtitles',
          lang: 'Sync Subtitles',
          url: `{{ADDON_URL}}/sync-subtitles/${id}?filename=${encodeURIComponent(streamFilename || '')}`
        };
        actionButtons.push(syncButtonEntry);
        console.log('[Subtitles] Sync Subtitles is enabled, added entry');
      }

      // Add "Translate SRT" button if enabled
      if (config.fileTranslationEnabled === true) {
        const fileUploadEntry = {
          id: 'file_upload',
          lang: 'Translate SRT',
          url: `{{ADDON_URL}}/file-translate/${id}`
        };
        actionButtons.push(fileUploadEntry);
        console.log('[Subtitles] Translate SRT is enabled, added entry');
      }

      // Put action buttons at the top
      allSubtitles = [...actionButtons, ...allSubtitles];

      const totalResponseItems = stremioSubtitles.length + translationEntries.length + xSyncEntries.length + actionButtons.length;
      console.log(`[Subtitles] Returning ${totalResponseItems} items (${stremioSubtitles.length} subs + ${translationEntries.length} trans + ${xSyncEntries.length} xSync + ${actionButtons.length} actions)`);

      return {
        subtitles: allSubtitles
      };

    } catch (error) {
      console.error('[Subtitles] Handler error:', error.message);
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
    console.log(`[Download] Fetching subtitle ${fileId} for language ${language}`);

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
        console.log('[Download] Downloading subtitle via SubDL API');
        return await subdl.downloadSubtitle(fileId);
      } else if (fileId.startsWith('subsource_')) {
        // SubSource subtitle
        if (!config.subtitleProviders?.subsource?.enabled) {
          throw new Error('SubSource provider is disabled');
        }

        const subsource = new SubSourceService(config.subtitleProviders.subsource.apiKey);
        console.log('[Download] Downloading subtitle via SubSource API');
        return await subsource.downloadSubtitle(fileId);
      } else if (fileId.startsWith('podnapisi_')) {
        // Podnapisi subtitle
        if (!config.subtitleProviders?.podnapisi?.enabled) {
          throw new Error('Podnapisi provider is disabled');
        }

        const podnapisi = new PodnapisService(config.subtitleProviders.podnapisi.apiKey);
        console.log('[Download] Downloading subtitle via Podnapisi API');
        return await podnapisi.downloadSubtitle(fileId);
      } else {
        // OpenSubtitles subtitle (default)
        if (!config.subtitleProviders?.opensubtitles?.enabled) {
          throw new Error('OpenSubtitles provider is disabled');
        }

        const opensubtitles = new OpenSubtitlesService(config.subtitleProviders.opensubtitles);
        console.log('[Download] Downloading subtitle via OpenSubtitles API');
        return await opensubtitles.downloadSubtitle(fileId);
      }
    })();

    // Wait for download to complete
    content = await downloadPromise;

    // Validate content
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('Downloaded subtitle content is empty');
    }

    console.log('[Download] Subtitle downloaded successfully (' + content.length + ' bytes)');
    // Reject obviously broken/corrupted files by size
    try {
      const minSize = Number(config.minSubtitleSizeBytes) || 200;
      if (content.length < minSize) {
        console.warn(`[Download] Subtitle content too small (${content.length} bytes < ${minSize}). Returning problem message.`);
        return createInvalidSubtitleMessage('The subtitle file is too small and seems corrupted.');
      }
    } catch (_) {}

    return content;

  } catch (error) {
    console.error('[Download] Error:', error.message);

    // Return error message as subtitle so user knows what happened
    const errorStatus = error.response?.status;
    
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
    console.log(`[Translation] Handling translation request for ${sourceFileId} to ${targetLanguage}`);

    // Check disk cache first
    const baseKey = `${sourceFileId}_${targetLanguage}`;
    const bypass = config.bypassCache === true;
    const bypassCfg = config.bypassCacheConfig || config.tempCache || {}; // Support both old and new names
    const bypassEnabled = bypass && (bypassCfg.enabled !== false);
    const userHash = (config && typeof config.__configHash === 'string' && config.__configHash.length > 0) ? config.__configHash : '';

    // Scope bypass cache by user/config hash only when bypassing permanent cache
    const cacheKey = (bypass && bypassEnabled && userHash)
      ? `${baseKey}__u_${userHash}`
      : baseKey;

    if (bypass) {
      // Skip reading permanent cache; optionally read bypass cache
      if (bypassEnabled) {
        const bypassCached = readFromBypassCache(cacheKey);
        if (bypassCached) {
          console.log('[Translation] Cache hit (bypass) key=', cacheKey, '— serving cached translation');
          cacheMetrics.hits++;
          cacheMetrics.estimatedCostSaved += 0.004;
          return bypassCached.content;
        }
      }
    } else {
      const cached = readFromDisk(cacheKey);
      if (cached) {
        console.log('[Translation] Cache hit (permanent) key=', cacheKey, '— serving cached translation');
        cacheMetrics.hits++;
        cacheMetrics.estimatedCostSaved += 0.004; // Estimated $0.004 per translation
        return cached.content;
      }
    }

    // Cache miss
    cacheMetrics.misses++;
    console.log('[Translation] Cache miss key=', cacheKey, '— not cached');

    // === RACE CONDITION PROTECTION ===
    // Check if there's already an in-flight request for this exact key
    // All simultaneous requests will share the same promise
    const inFlightPromise = inFlightTranslations.get(cacheKey);
    if (inFlightPromise) {
      console.log(`[Translation] Detected in-flight translation for key=${cacheKey}; checking for partial results`);
      try {
        // DON'T WAIT for completion - immediately return available partials instead
        // Check disk cache first (in case it just completed)
        const cachedResult = readFromDisk(cacheKey);
        if (cachedResult) {
          console.log('[Translation] Final result already cached; returning it');
          cacheMetrics.hits++;
          return cachedResult.content;
        }

        // Check partial cache (most common case - translation in progress)
        // Partials are saved to PARTIAL_CACHE_DIR, not BYPASS_CACHE_DIR
        const partialResult = readFromPartialCache(cacheKey);
        if (partialResult && typeof partialResult.content === 'string' && partialResult.content.length > 0) {
          console.log(`[Translation] Returning partial result (${partialResult.content.length} chars) without waiting for completion`);
          return partialResult.content;
        }

        // No cached/partial result yet - return loading message and let user retry
        const loadingMsg = createLoadingSubtitle();
        console.log(`[Translation] No partial result yet for duplicate request; returning loading message`);
        return loadingMsg;
      } catch (err) {
        console.warn(`[Translation] Error checking partials for duplicate request (${cacheKey}):`, err.message);
        // Return loading message on any error
        const loadingMsg = createLoadingSubtitle();
        return loadingMsg;
      }
    }

    // Check if translation is in progress (for backward compatibility)
    const status = translationStatus.get(cacheKey);
    if (status && status.inProgress) {
      const elapsedTime = Math.floor((Date.now() - status.startedAt) / 1000);
      console.log(`[Translation] In-progress existing translation key=${cacheKey} (elapsed ${elapsedTime}s); attempting partial SRT`);
      try {
        const partial = readFromPartialCache(cacheKey);
        if (partial && typeof partial.content === 'string' && partial.content.length > 0) {
          console.log('[Translation] Serving partial SRT from partial cache');
          return partial.content;
        }
      } catch (_) {}
      const loadingMsg = createLoadingSubtitle();
      console.log(`[Translation] No partial available, returning loading SRT (size=${loadingMsg.length})`);
      return loadingMsg;
    }

    // Enforce per-user concurrency limit only when starting a new translation
    const effectiveUserHash = (userHash && userHash.length > 0) ? userHash : 'anonymous';
    const currentCount = userTranslationCounts.get(effectiveUserHash) || 0;
    if (currentCount >= MAX_CONCURRENT_TRANSLATIONS_PER_USER) {
      console.warn(`[Translation] Concurrency limit reached for user=${effectiveUserHash}: ${currentCount} in progress (limit ${MAX_CONCURRENT_TRANSLATIONS_PER_USER}).`);
      return createConcurrencyLimitSubtitle(MAX_CONCURRENT_TRANSLATIONS_PER_USER);
    }

    // Mark translation as in progress and start it in background
    console.log('[Translation] Not cached and not in-progress; starting translation key=', cacheKey);
    translationStatus.set(cacheKey, { inProgress: true, startedAt: Date.now(), userHash: effectiveUserHash });
    userTranslationCounts.set(effectiveUserHash, currentCount + 1);

    // Create a promise for this translation that all simultaneous requests will wait for
    const translationPromise = performTranslation(sourceFileId, targetLanguage, config, cacheKey, effectiveUserHash);
    inFlightTranslations.set(cacheKey, translationPromise);

    // Start translation in background (don't await here)
    translationPromise.catch(error => {
      console.error('[Translation] Background translation failed:', error.message);
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
    console.log(`[Translation] Returning initial loading message (${loadingMsg.length} characters)`);
    return loadingMsg;
  } catch (error) {
    console.error('[Translation] Error:', error.message);
    throw error;
  }
}

/**
 * Perform the actual translation in the background
 * @param {string} sourceFileId - Source subtitle file ID
 * @param {string} targetLanguage - Target language code
 * @param {Object} config - Addon configuration
 * @param {string} cacheKey - Cache key for storing result
 */
async function performTranslation(sourceFileId, targetLanguage, config, cacheKey, userHash) {
  try {
    console.log(`[Translation] Background translation started for ${sourceFileId} to ${targetLanguage}`);
    cacheMetrics.apiCalls++;

    // Download subtitle from provider
    let sourceContent = null;
    console.log(`[Translation] Downloading subtitle from provider`);

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
    } else if (sourceFileId.startsWith('podnapisi_')) {
      // Podnapisi subtitle
      if (!config.subtitleProviders?.podnapisi?.enabled) {
        throw new Error('Podnapisi provider is disabled');
      }

      const podnapisi = new PodnapisService(config.subtitleProviders.podnapisi.apiKey);
      sourceContent = await podnapisi.downloadSubtitle(sourceFileId);
    } else {
      // OpenSubtitles subtitle (default)
      if (!config.subtitleProviders?.opensubtitles?.enabled) {
        throw new Error('OpenSubtitles provider is disabled');
      }

      const opensubtitles = new OpenSubtitlesService(config.subtitleProviders.opensubtitles);
      sourceContent = await opensubtitles.downloadSubtitle(sourceFileId);
    }

    // Validate source size before translation
    try {
      const minSize = Number(config.minSubtitleSizeBytes) || 200;
      if (!sourceContent || sourceContent.length < minSize) {
        const msg = createInvalidSubtitleMessage('Selected subtitle seems invalid (too small).');
        // Save short-lived cache to bypass cache so we never overwrite permanent translations
        saveToBypassCache(cacheKey, {
          content: msg,
          // expire after 10 minutes so user can try again later
          expiresAt: Date.now() + 10 * 60 * 1000
        });
        translationStatus.delete(cacheKey);
        console.log('[Translation] Aborted due to invalid/corrupted source subtitle (too small).');
        return;
      }
    } catch (_) {}

    // Get language names for better translation context
    const targetLangName = getLanguageName(targetLanguage) || targetLanguage;

          // Initialize Gemini service with advanced settings
      const gemini = new GeminiService(
        config.geminiApiKey, 
        config.geminiModel,
        config.advancedSettings || {}
      );

    // Estimate token count and get model limits to decide chunking by input cap
    const estimatedTokens = gemini.estimateTokenCount(sourceContent);
    const limits = await gemini.getModelLimits();
    const modelInputCap = typeof limits.inputTokenLimit === 'number' ? limits.inputTokenLimit : 32000;
    const safetyMarginIn = Math.floor(modelInputCap * 0.1);
    console.log(`[Translation] Estimated tokens: ${estimatedTokens} (model input cap ~${modelInputCap})`);

    // Also consider model output limits; large inputs can expand 2-3x upon translation
    const modelOutputCap = typeof limits.outputTokenLimit === 'number' ? limits.outputTokenLimit : 8192;
    const safetyMarginOut = Math.floor(modelOutputCap * 0.05);
    const expectedOutputTokens = Math.max(8192, Math.floor(estimatedTokens * 2.5));
    console.log(`[Translation] Expected output tokens ~${expectedOutputTokens} (model output cap ~${modelOutputCap})`);

    // Translate with automatic fallback to chunking
    let translatedContent;
    // Chunk files above 25k tokens (chunks will be ~12k tokens each for faster progressive updates)
    const useChunking = estimatedTokens > 25000;
    if (useChunking) {
      console.log('[Translation] Using chunked translation (file size > 25k tokens, chunks ~12k each) for progressive updates');
    } else {
      console.log(`[Translation] File size ${estimatedTokens} tokens <= 25k, using streaming for progressive updates`);
    }

    if (useChunking) {
        console.log('[Translation] Using chunked translation with per-chunk streaming for progressive updates');
        const soFar = [];
        let lastFlush = Date.now(); // Initialize to now so first partial respects 10s interval
        let flushCount = 0;
        // Tiered flush intervals: 10s, 60s, 180s, then 300s for all subsequent
        const flushIntervals = [10000, 60000, 180000, 300000];
        const getFlushInterval = () => flushIntervals[Math.min(flushCount, flushIntervals.length - 1)];
        const savePartial = async () => {
          const merged = soFar.join('\n\n');
          console.log(`[Translation] Saving partial: ${soFar.length} chunks merged (${merged.length} chars)`);
          const partialSrt = buildPartialSrtWithTail(merged);
          if (partialSrt && partialSrt.length > 0) {
            flushCount++;
            const nextInterval = getFlushInterval();
            console.log(`[Translation] Partial SRT built successfully (${partialSrt.length} chars), saving to partial cache (flush #${flushCount}, next flush in ${nextInterval / 1000}s)`);
            await saveToPartialCacheAsync(cacheKey, {
              content: partialSrt,
              // expire after 1 hour; final will overwrite with persistent cache
              expiresAt: Date.now() + 60 * 60 * 1000
            });
          } else {
            console.log('[Translation] Partial SRT is null/empty, not saving to cache');
          }
        };
        translatedContent = await gemini.translateSubtitleInChunksWithStreaming(
          sourceContent,
          'detected source language',
          targetLangName,
          config.translationPrompt,
          null,
          async ({ index, total, translatedChunk, isDelta }) => {
            if (isDelta) {
              // Token-level delta - add to current chunk buffer and flush at tiered intervals
              soFar[index] = (soFar[index] || '') + translatedChunk;
              const now = Date.now();
              const currentInterval = getFlushInterval();
              if (now - lastFlush > currentInterval) {
                lastFlush = now;
                await savePartial();
              }
            } else {
              // Full chunk completed - always save
              soFar[index] = translatedChunk;
              console.log(`[Translation] Chunk ${index + 1}/${total} completed via streaming (${translatedChunk.length} chars)`);
              await savePartial();
            }
          }
        );
      } else {
        // Use streaming for smaller files (< 12k tokens) for faster progressive updates
        console.log('[Translation] Using token-level streaming with progressive updates');
        let buffer = '';
        let lastWrite = Date.now(); // Initialize to now so first partial respects 10s interval
        let flushCount = 0;
        // Tiered flush intervals: 10s, 60s, 180s, then 300s for all subsequent
        const flushIntervals = [10000, 60000, 180000, 300000];
        const getFlushInterval = () => flushIntervals[Math.min(flushCount, flushIntervals.length - 1)];
        const flushPartial = async () => {
          const cleaned = gemini.cleanTranslatedSubtitle(buffer);
          const partialSrt = buildPartialSrtWithTail(cleaned);
          if (partialSrt && partialSrt.length > 0) {
            flushCount++;
            const nextInterval = getFlushInterval();
            await saveToPartialCacheAsync(cacheKey, {
              content: partialSrt,
              expiresAt: Date.now() + 60 * 60 * 1000
            });
            console.log(`[Translation] Regular streaming flush #${flushCount} (${partialSrt.length} chars), next flush in ${nextInterval / 1000}s`);
          }
        };
        try {
          await gemini.translateSubtitleStream(
            sourceContent,
            'detected source language',
            targetLangName,
            config.translationPrompt,
            (delta) => {
              buffer += delta;
              const now = Date.now();
              const currentInterval = getFlushInterval();
              if (now - lastWrite > currentInterval) {
                lastWrite = now;
                // Queue flush async without awaiting (callback must return immediately)
                flushPartial().catch(err => console.error('[Translation] Async flush error:', err.message));
              }
            }
          );
          // Stream ended; flush any remaining buffer and set final content
          if (buffer.length > 0) {
            await flushPartial();
          }
          console.log(`[Translation] Stream completed with ${flushCount} progressive updates (${buffer.length} final chars)`);
          translatedContent = gemini.cleanTranslatedSubtitle(buffer);
        } catch (e) {
          console.warn('[Translation] Streaming failed, falling back to chunking:', e.message);
          // Fallback to chunking if streaming fails
          const soFar = [];
          const savePartial = async () => {
            const merged = soFar.join('\n\n');
            console.log(`[Translation] Fallback chunking: Saving partial with ${soFar.length} chunks (${merged.length} chars)`);
            const partialSrt = buildPartialSrtWithTail(merged);
            if (partialSrt && partialSrt.length > 0) {
              await saveToPartialCacheAsync(cacheKey, {
                content: partialSrt,
                expiresAt: Date.now() + 60 * 60 * 1000
              });
            }
          };
          try {
            translatedContent = await gemini.translateSubtitleInChunksWithProgress(
              sourceContent,
              'detected source language',
              targetLangName,
              config.translationPrompt,
              null,
              async ({ index, total, translatedChunk }) => {
                soFar.push(translatedChunk);
                await savePartial();
              }
            );
          } catch (chunkError) {
            console.error('[Translation] Both streaming and chunking failed:', chunkError.message);
            throw chunkError;
          }
        }
      }

    console.log('[Translation] Background translation completed successfully');

    // Cache the translation (disk-only, permanent by default)
    const cacheConfig = config.translationCache || { enabled: true, duration: 0, persistent: true };
    const bypass = config.bypassCache === true;
    const bypassCfg = config.bypassCacheConfig || config.tempCache || {}; // Support both old and new names
    const bypassEnabled = bypass && (bypassCfg.enabled !== false);

    if (bypass && bypassEnabled) {
      // Save only to bypass cache with TTL
      const bypassDuration = (typeof bypassCfg.duration === 'number') ? bypassCfg.duration : 12;
      const expiresAt = Date.now() + (bypassDuration * 60 * 60 * 1000);
      const cachedData = {
        key: cacheKey,
        content: translatedContent,
        createdAt: Date.now(),
        expiresAt,
        sourceFileId,
        targetLanguage,
        configHash: (config && typeof config.__configHash === 'string') ? config.__configHash : undefined
      };
      saveToBypassCache(cacheKey, cachedData);
    } else if (cacheConfig.enabled && cacheConfig.persistent !== false) {
      // Save to permanent cache (no expiry)
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
      saveToDisk(cacheKey, cachedData);
    }

    // Mark translation as complete
    translationStatus.set(cacheKey, { inProgress: false, completedAt: Date.now() });

    // Note: No manual cleanup needed - LRU cache handles TTL automatically

    console.log('[Translation] Translation cached and ready to serve');

  } catch (error) {
    console.error('[Translation] Background translation error:', error.message);
    // Remove from status so it can be retried
    try { translationStatus.delete(cacheKey); } catch (_) {}
    throw error;
  } finally {
    // Decrement per-user concurrency counter
    try {
      const key = userHash || 'anonymous';
      const current = userTranslationCounts.get(key) || 0;
      if (current > 1) userTranslationCounts.set(key, current - 1);
      else userTranslationCounts.delete(key);
      console.log(`[Translation] User concurrency updated user=${key} count=${userTranslationCounts.get(key) || 0}`);
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
    console.log('[Translation Selector] Getting subtitles for:', videoId);

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
      let subs = [];

      // Check if OpenSubtitles provider is enabled
      if (config.subtitleProviders?.opensubtitles?.enabled) {
        const opensubtitles = new OpenSubtitlesService(config.subtitleProviders.opensubtitles);
        const opensubtitlesResults = await opensubtitles.searchSubtitles(searchParams);
        subs = [...subs, ...opensubtitlesResults];
      }

      // Check if SubDL provider is enabled
      if (config.subtitleProviders?.subdl?.enabled) {
        const subdl = new SubDLService(config.subtitleProviders.subdl.apiKey);
        const subdlResults = await subdl.searchSubtitles(searchParams);
        subs = [...subs, ...subdlResults];
      }

      // Check if SubSource provider is enabled
      if (config.subtitleProviders?.subsource?.enabled) {
        const subsource = new SubSourceService(config.subtitleProviders.subsource.apiKey);
        const subsourceResults = await subsource.searchSubtitles(searchParams);
        subs = [...subs, ...subsourceResults];
      }

      // Future providers can be added here

      console.log(`[Translation Selector] Found ${subs.length} subtitles total`);
      return subs;
    });

    return subtitles;

  } catch (error) {
    console.error('[Translation Selector] Error:', error.message);
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
      console.log(`[Cache] Cleaned up ${removedCount} expired disk cache entries`);
    }
  } catch (error) {
    console.error('[Cache] Failed to clean up disk cache:', error.message);
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
  readFromPartialCache, // Export for checking in-flight partial results during duplicate requests
  readFromBypassCache, // Export for checking bypass cache during duplicate requests
  translationStatus, // Export for safety block to check if translation is in progress
  /**
   * Check if a translated subtitle exists in permanent cache
   * Mirrors the cache key logic used in handleTranslation (without bypass)
   */
  hasCachedTranslation: function (sourceFileId, targetLanguage, config) {
    try {
      const baseKey = `${sourceFileId}_${targetLanguage}`;
      const cached = readFromDisk(baseKey);
      return !!(cached && typeof cached.content === 'string' && cached.content.length > 0);
    } catch (_) {
      return false;
    }
  },
  /**
   * Purge any cached translation (permanent + temp) and reset in-progress state
   */
  purgeTranslationCache: function (sourceFileId, targetLanguage, config) {
    try {
      const baseKey = `${sourceFileId}_${targetLanguage}`;
      const safeKey = sanitizeCacheKey(baseKey);
      // Delete permanent cache file
      try {
        const filePath = path.join(CACHE_DIR, `${safeKey}.json`);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`[Purge] Removed permanent cache for ${safeKey}`);
        }
      } catch (e) {
        console.warn(`[Purge] Failed removing permanent cache for ${safeKey}:`, e.message);
      }

      // Delete bypass cache file (both scoped and unscoped variants just in case)
      try {
        // Scoped by user/config hash (if present)
        const userHash = (config && typeof config.__configHash === 'string' && config.__configHash.length > 0)
          ? config.__configHash
          : '';
        const scopedKey = `${baseKey}__u_${userHash}`;
        const bypassFiles = [sanitizeCacheKey(baseKey), sanitizeCacheKey(scopedKey)];
        for (const key of bypassFiles) {
          const bypassPath = path.join(BYPASS_CACHE_DIR, `${key}.json`);
          if (fs.existsSync(bypassPath)) {
            fs.unlinkSync(bypassPath);
            console.log(`[Purge] Removed bypass cache for ${key}`);
          }
        }
      } catch (e) {
        console.warn(`[Purge] Failed removing bypass cache for ${baseKey}:`, e.message);
      }

      // Delete partial cache file (in-flight translations)
      try {
        const partialPath = path.join(PARTIAL_CACHE_DIR, `${safeKey}.json`);
        if (fs.existsSync(partialPath)) {
          fs.unlinkSync(partialPath);
          console.log(`[Purge] Removed partial cache for ${safeKey}`);
        }
      } catch (e) {
        console.warn(`[Purge] Failed removing partial cache for ${baseKey}:`, e.message);
      }

      // Clear in-progress status so a fresh translation can start
      try {
        translationStatus.delete(baseKey);
        const userHash = (config && typeof config.__configHash === 'string' && config.__configHash.length > 0)
          ? config.__configHash
          : '';
        const scopedKey = `${baseKey}__u_${userHash}`;
        translationStatus.delete(scopedKey);
      } catch (_) {}

      return true;
    } catch (error) {
      console.error('[Purge] Error purging translation cache:', error.message);
      return false;
    }
  }
};
