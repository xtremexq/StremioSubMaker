const OpenSubtitlesService = require('../services/opensubtitles');
const SubDLService = require('../services/subdl');
const SubSourceService = require('../services/subsource');
const PodnapisService = require('../services/podnapisi');
const GeminiService = require('../services/gemini');
const { parseStremioId } = require('../utils/subtitle');
const { getLanguageName, getDisplayName } = require('../utils/languages');
const { LRUCache } = require('lru-cache');

const fs = require('fs');
const path = require('path');

// Track per-user concurrent translations (limit enforcement)
const userTranslationCounts = new Map(); // key: userHash, value: number in-progress
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

// Directory for persistent translation cache (disk-only)
const CACHE_DIR = path.join(__dirname, '..', '..', '.cache', 'translations');
// Directory for temporary translation cache (disk-only, TTL-based)
const TEMP_CACHE_DIR = path.join(__dirname, '..', '..', '.cache', 'translations_temp');

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
 * Create a loading subtitle with multiple messages
 * @returns {string} - SRT formatted loading subtitle
 */
function createLoadingSubtitle() {
  const srt = `1
00:00:00,000 --> 00:00:05,000
TRANSLATION IN PROGRESS
Please wait, this may take 1-10 minutes
Depending on selected model and file size

2
00:00:05,001 --> 00:00:10,000
Your subtitle is being translated...
This happens in the background

3
00:00:10,001 --> 00:00:15,000
Pro models take longer than flash and lite
Movies take longer than tv episodes

4
00:00:15,001 --> 04:00:00,000
Please wait 1-10 minutes. Then, select
this subtitle again to see the result`;
  
  // Log the loading subtitle for debugging
  console.log('[Subtitles] Created loading subtitle with', srt.split('\n\n').length, 'entries');
  return srt;
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
    if (!fs.existsSync(TEMP_CACHE_DIR)) {
      fs.mkdirSync(TEMP_CACHE_DIR, { recursive: true });
      console.log('[Cache] Created temporary translation cache directory');
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

// Verify and cleanup expired entries in temporary cache
function verifyTempCacheIntegrity() {
  try {
    if (!fs.existsSync(TEMP_CACHE_DIR)) {
      return;
    }

    const files = fs.readdirSync(TEMP_CACHE_DIR);
    let removedCount = 0;

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const filePath = path.join(TEMP_CACHE_DIR, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const cached = JSON.parse(content);
        if (!cached.expiresAt || Date.now() > cached.expiresAt) {
          fs.unlinkSync(filePath);
          removedCount++;
        }
      } catch (error) {
        try { fs.unlinkSync(path.join(TEMP_CACHE_DIR, file)); } catch (e) {}
      }
    }

    if (removedCount > 0) {
      console.log(`[Temp Cache] Cleaned ${removedCount} expired entries`);
    }
  } catch (error) {
    console.error('[Temp Cache] Failed to verify/clean temp cache:', error.message);
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

// Read translation from temporary disk cache
function readFromTemp(cacheKey) {
  try {
    const safeKey = sanitizeCacheKey(cacheKey);
    const filePath = path.join(TEMP_CACHE_DIR, `${safeKey}.json`);

    const resolvedPath = path.resolve(filePath);
    const resolvedCacheDir = path.resolve(TEMP_CACHE_DIR);
    if (!resolvedPath.startsWith(resolvedCacheDir)) {
      console.error(`[Temp Cache] Security: Path traversal attempt detected for key ${cacheKey}`);
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
    console.error(`[Temp Cache] Failed to read from temp for key ${cacheKey}:`, error.message);
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

// Save translation to temporary disk cache
function saveToTemp(cacheKey, cachedData) {
  try {
    const safeKey = sanitizeCacheKey(cacheKey);
    const filePath = path.join(TEMP_CACHE_DIR, `${safeKey}.json`);

    const resolvedPath = path.resolve(filePath);
    const resolvedCacheDir = path.resolve(TEMP_CACHE_DIR);
    if (!resolvedPath.startsWith(resolvedCacheDir)) {
      console.error(`[Temp Cache] Security: Path traversal attempt detected for key ${cacheKey}`);
      return;
    }

    fs.writeFileSync(filePath, JSON.stringify(cachedData, null, 2), 'utf8');
    cacheMetrics.diskWrites++;
  } catch (error) {
    console.error('[Temp Cache] Failed to save translation to temp:', error.message);
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
verifyTempCacheIntegrity();

// Calculate initial cache size
cacheMetrics.totalCacheSize = calculateCacheSize();
console.log(`[Cache] Initial cache size: ${(cacheMetrics.totalCacheSize / 1024 / 1024 / 1024).toFixed(2)}GB`);

// Log metrics every 30 minutes
setInterval(logCacheMetrics, 1000 * 60 * 30);

// Enforce cache size limit every 10 minutes
setInterval(enforceCacheSizeLimit, 1000 * 60 * 10);
// Cleanup temp cache periodically
setInterval(verifyTempCacheIntegrity, 1000 * 60 * 30);

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
 * Create subtitle handler for Stremio addon
 * @param {Object} config - Addon configuration
 * @returns {Function} - Handler function
 */
function createSubtitleHandler(config) {
  return async (args) => {
    try {
      console.log('[Subtitles] Handler called with args:', JSON.stringify(args));

      const { type, id } = args;
      const videoInfo = parseStremioId(id);

      if (!videoInfo) {
        console.error('[Subtitles] Invalid video ID:', id);
        return { subtitles: [] };
      }

      console.log('[Subtitles] Video info:', videoInfo);

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
      const filteredFoundSubtitles = foundSubtitles.filter(sub => sub.languageCode && normalizedAllLangs.has(sub.languageCode));

      // Convert to Stremio subtitle format
       const stremioSubtitles = filteredFoundSubtitles.map(sub => {
        const subtitle = {
          id: `${sub.fileId}`,
          lang: sub.languageCode, // Must be ISO-639-2 (3-letter code)
          url: `{{ADDON_URL}}/subtitle/${sub.fileId}/${sub.languageCode}.srt`
        };

        console.log('[Subtitles] Formatted subtitle:', JSON.stringify(subtitle));
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

      // Create translation entries: for each target language, create entries for ALL source language subtitles
      // First, filter out target language subtitles to get only source language subtitles
      const sourceSubtitles = filteredFoundSubtitles.filter(sub =>
        config.sourceLanguages.some(sourceLang => {
          const normalized = normalizeLanguageCode(sourceLang);
          return sub.languageCode === normalized;
        })
      );

      console.log(`[Subtitles] Found ${sourceSubtitles.length} source language subtitles for translation`);

      // For each target language, create a translation entry for each source subtitle
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

      console.log(`[Subtitles] Created ${translationEntries.length} translation entries`);

      // Add fake "File Translation" entry if enabled in config
      let allSubtitles = [...stremioSubtitles, ...translationEntries];

      if (config.fileTranslationEnabled === true) {
        const fileUploadEntry = {
          id: 'file_upload',
          lang: 'Upload Sub',
          url: `{{ADDON_URL}}/file-translate/${id}`
        };
        allSubtitles = [fileUploadEntry, ...allSubtitles];
        console.log('[Subtitles] File translation is enabled, added file upload entry');
      } else {
        console.log('[Subtitles] File translation is disabled');
      }

      console.log(`[Subtitles] Returning ${stremioSubtitles.length} subtitles and ${translationEntries.length} translation entries`);
      console.log('[Subtitles] Full response:', JSON.stringify({ subtitles: allSubtitles }, null, 2));

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
 * Handle translation request
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
    const tempEnabled = !config.tempCache || config.tempCache.enabled !== false;
    const userHash = (config && typeof config.__configHash === 'string' && config.__configHash.length > 0) ? config.__configHash : '';

    // Scope temp cache by user/config hash only when bypassing permanent cache
    const cacheKey = (bypass && tempEnabled && userHash)
      ? `${baseKey}__u_${userHash}`
      : baseKey;

    if (bypass) {
      // Skip reading permanent cache; optionally read temp cache
      if (tempEnabled) {
        const tempCached = readFromTemp(cacheKey);
        if (tempCached) {
          console.log('[Translation] Cache hit (temp) key=', cacheKey, '— serving cached translation');
          cacheMetrics.hits++;
          cacheMetrics.estimatedCostSaved += 0.004;
          return tempCached.content;
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

    // Check if translation is in progress (scope to same key used for caching)
    const status = translationStatus.get(cacheKey);
    if (status && status.inProgress) {
      const elapsedTime = Math.floor((Date.now() - status.startedAt) / 1000);
      console.log(`[Translation] In-progress existing translation key=${cacheKey} (elapsed ${elapsedTime}s); returning loading SRT`);
      const loadingMsg = createLoadingSubtitle();
      console.log(`[Translation] Loading SRT size=${loadingMsg.length}`);
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
    
    // Start translation in background (don't await)
    performTranslation(sourceFileId, targetLanguage, config, cacheKey, effectiveUserHash).catch(error => {
      console.error('[Translation] Background translation failed:', error.message);
      // Mark as failed so it can be retried
      try {
        translationStatus.delete(cacheKey);
      } catch (_) {}
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
        // Save short-lived cache to TEMP so we never overwrite permanent translations
        saveToTemp(cacheKey, {
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
      // Always chunk files above 25k tokens for reliability across all models
      const useChunking = estimatedTokens > 25000;
      if (useChunking) {
        console.log('[Translation] Preemptively using chunked translation (file size > 25k tokens)');
      }

      if (useChunking) {
        console.log('[Translation] Using chunked translation (large file)');
        translatedContent = await gemini.translateSubtitleInChunks(
          sourceContent,
          'detected source language',
          targetLangName,
          config.translationPrompt
        );
      } else {
        translatedContent = await gemini.translateSubtitle(
          sourceContent,
          'detected source language',
          targetLangName,
          config.translationPrompt
        );
      }

    console.log('[Translation] Background translation completed successfully');

    // Cache the translation (disk-only, permanent by default)
    const cacheConfig = config.translationCache || { enabled: true, duration: 0, persistent: true };
    const bypass = config.bypassCache === true;
    const tempEnabled = !config.tempCache || config.tempCache.enabled !== false;

    if (bypass && tempEnabled) {
      // Save only to temporary cache with TTL
      const tempDuration = (config.tempCache && typeof config.tempCache.duration === 'number') ? config.tempCache.duration : 12;
      const expiresAt = Date.now() + (tempDuration * 60 * 60 * 1000);
      const cachedData = {
        key: cacheKey,
        content: translatedContent,
        createdAt: Date.now(),
        expiresAt,
        sourceFileId,
        targetLanguage,
        configHash: (config && typeof config.__configHash === 'string') ? config.__configHash : undefined
      };
      saveToTemp(cacheKey, cachedData);
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
// Also clean up temporary cache (more frequent not needed here)
setInterval(() => {
  try {
    verifyTempCacheIntegrity();
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

      // Delete temp cache file (both scoped and unscoped variants just in case)
      try {
        // Scoped by user/config hash (if present)
        const userHash = (config && typeof config.__configHash === 'string' && config.__configHash.length > 0)
          ? config.__configHash
          : '';
        const scopedKey = `${baseKey}__u_${userHash}`;
        const tempFiles = [sanitizeCacheKey(baseKey), sanitizeCacheKey(scopedKey)];
        for (const key of tempFiles) {
          const tempPath = path.join(TEMP_CACHE_DIR, `${key}.json`);
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
            console.log(`[Purge] Removed temp cache for ${key}`);
          }
        }
      } catch (e) {
        console.warn(`[Purge] Failed removing temp cache for ${baseKey}:`, e.message);
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
