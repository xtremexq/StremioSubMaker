/**
 * Sync Cache Management
 * Handles storage and retrieval of synced subtitles
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Cache directory for synced subtitles
const SYNC_CACHE_DIR = path.join(process.cwd(), '.cache', 'sync_cache');
const MAX_CACHE_SIZE_GB = 10; // 10GB max for sync cache
const MAX_CACHE_SIZE_BYTES = MAX_CACHE_SIZE_GB * 1024 * 1024 * 1024;

/**
 * Initialize sync cache directory
 */
async function initSyncCache() {
  try {
    await fs.mkdir(SYNC_CACHE_DIR, { recursive: true });
    console.log('[Sync Cache] Initialized at:', SYNC_CACHE_DIR);
  } catch (error) {
    console.error('[Sync Cache] Failed to initialize:', error.message);
    throw error;
  }
}

/**
 * Generate cache key for synced subtitle
 * @param {string} videoHash - Hash of the video file (from stream info)
 * @param {string} languageCode - ISO-639-2 language code (e.g., 'eng', 'spa')
 * @param {string} sourceSubId - ID of the source subtitle used for syncing
 * @returns {string} Cache key
 */
function generateSyncCacheKey(videoHash, languageCode, sourceSubId) {
  // Format: videoHash_lang_sourceSubId
  // Example: abc123def456_eng_subdl_12345
  return `${videoHash}_${languageCode}_${sourceSubId}`;
}

/**
 * Get path to sync cache file
 * @param {string} cacheKey - Cache key
 * @returns {string} Full path to cache file
 */
function getSyncCachePath(cacheKey) {
  // Use first 2 chars of cache key as subdirectory to avoid too many files in one directory
  const subdir = cacheKey.substring(0, 2);
  return path.join(SYNC_CACHE_DIR, subdir, `${cacheKey}.json`);
}

/**
 * Save synced subtitle to cache
 * @param {string} videoHash - Video file hash
 * @param {string} languageCode - Language code
 * @param {string} sourceSubId - Source subtitle ID
 * @param {Object} syncData - Sync data to store
 * @param {string} syncData.content - Synced SRT content
 * @param {string} syncData.originalSubId - Original subtitle file ID
 * @param {Object} syncData.metadata - Additional metadata
 * @returns {Promise<void>}
 */
async function saveSyncedSubtitle(videoHash, languageCode, sourceSubId, syncData) {
  try {
    const cacheKey = generateSyncCacheKey(videoHash, languageCode, sourceSubId);
    const cachePath = getSyncCachePath(cacheKey);
    const cacheDir = path.dirname(cachePath);

    // Ensure subdirectory exists
    await fs.mkdir(cacheDir, { recursive: true });

    // Prepare cache entry
    const cacheEntry = {
      videoHash,
      languageCode,
      sourceSubId,
      content: syncData.content,
      originalSubId: syncData.originalSubId,
      metadata: syncData.metadata || {},
      timestamp: Date.now(),
      version: '1.0'
    };

    // Write to cache
    await fs.writeFile(cachePath, JSON.stringify(cacheEntry, null, 2), 'utf8');

    console.log(`[Sync Cache] Saved: ${cacheKey}`);

    // Check and enforce cache size limit
    await enforceCacheSizeLimit();

  } catch (error) {
    console.error('[Sync Cache] Failed to save:', error.message);
    throw error;
  }
}

/**
 * Get all synced subtitles for a video hash and language
 * @param {string} videoHash - Video file hash
 * @param {string} languageCode - Language code
 * @returns {Promise<Array>} Array of synced subtitle entries
 */
async function getSyncedSubtitles(videoHash, languageCode) {
  try {
    const results = [];

    // Scan all subdirectories
    const subdirs = await fs.readdir(SYNC_CACHE_DIR).catch(() => []);

    for (const subdir of subdirs) {
      const subdirPath = path.join(SYNC_CACHE_DIR, subdir);
      const stat = await fs.stat(subdirPath).catch(() => null);

      if (!stat || !stat.isDirectory()) continue;

      // Read files in subdirectory
      const files = await fs.readdir(subdirPath).catch(() => []);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        // Check if filename matches pattern
        const cacheKey = file.replace('.json', '');
        if (cacheKey.startsWith(`${videoHash}_${languageCode}_`)) {
          const filePath = path.join(subdirPath, file);
          try {
            const content = await fs.readFile(filePath, 'utf8');
            const entry = JSON.parse(content);
            results.push({
              cacheKey,
              sourceSubId: entry.sourceSubId,
              originalSubId: entry.originalSubId,
              content: entry.content,
              metadata: entry.metadata,
              timestamp: entry.timestamp
            });
          } catch (error) {
            console.warn(`[Sync Cache] Failed to read ${file}:`, error.message);
          }
        }
      }
    }

    // Sort by timestamp (newest first)
    results.sort((a, b) => b.timestamp - a.timestamp);

    console.log(`[Sync Cache] Found ${results.length} synced subtitles for ${videoHash}_${languageCode}`);
    return results;

  } catch (error) {
    console.error('[Sync Cache] Failed to retrieve:', error.message);
    return [];
  }
}

/**
 * Get a specific synced subtitle
 * @param {string} videoHash - Video file hash
 * @param {string} languageCode - Language code
 * @param {string} sourceSubId - Source subtitle ID
 * @returns {Promise<Object|null>} Synced subtitle entry or null
 */
async function getSyncedSubtitle(videoHash, languageCode, sourceSubId) {
  try {
    const cacheKey = generateSyncCacheKey(videoHash, languageCode, sourceSubId);
    const cachePath = getSyncCachePath(cacheKey);

    const content = await fs.readFile(cachePath, 'utf8');
    const entry = JSON.parse(content);

    console.log(`[Sync Cache] Retrieved: ${cacheKey}`);
    return {
      cacheKey,
      sourceSubId: entry.sourceSubId,
      originalSubId: entry.originalSubId,
      content: entry.content,
      metadata: entry.metadata,
      timestamp: entry.timestamp
    };

  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[Sync Cache] Failed to retrieve ${videoHash}_${languageCode}_${sourceSubId}:`, error.message);
    }
    return null;
  }
}

/**
 * Delete a synced subtitle from cache
 * @param {string} videoHash - Video file hash
 * @param {string} languageCode - Language code
 * @param {string} sourceSubId - Source subtitle ID
 * @returns {Promise<boolean>} True if deleted
 */
async function deleteSyncedSubtitle(videoHash, languageCode, sourceSubId) {
  try {
    const cacheKey = generateSyncCacheKey(videoHash, languageCode, sourceSubId);
    const cachePath = getSyncCachePath(cacheKey);

    await fs.unlink(cachePath);
    console.log(`[Sync Cache] Deleted: ${cacheKey}`);
    return true;

  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[Sync Cache] Failed to delete:', error.message);
    }
    return false;
  }
}

/**
 * Get total cache size and file count
 * @returns {Promise<Object>} Cache statistics
 */
async function getCacheStats() {
  try {
    let totalSize = 0;
    let fileCount = 0;

    const subdirs = await fs.readdir(SYNC_CACHE_DIR).catch(() => []);

    for (const subdir of subdirs) {
      const subdirPath = path.join(SYNC_CACHE_DIR, subdir);
      const stat = await fs.stat(subdirPath).catch(() => null);

      if (!stat || !stat.isDirectory()) continue;

      const files = await fs.readdir(subdirPath).catch(() => []);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = path.join(subdirPath, file);
        const fileStat = await fs.stat(filePath).catch(() => null);

        if (fileStat) {
          totalSize += fileStat.size;
          fileCount++;
        }
      }
    }

    return {
      totalSize,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      fileCount,
      maxSizeGB: MAX_CACHE_SIZE_GB
    };

  } catch (error) {
    console.error('[Sync Cache] Failed to get stats:', error.message);
    return { totalSize: 0, totalSizeMB: '0.00', fileCount: 0, maxSizeGB: MAX_CACHE_SIZE_GB };
  }
}

/**
 * Enforce cache size limit by removing oldest entries
 * @returns {Promise<void>}
 */
async function enforceCacheSizeLimit() {
  try {
    const stats = await getCacheStats();

    if (stats.totalSize <= MAX_CACHE_SIZE_BYTES) {
      return; // Within limit
    }

    console.log(`[Sync Cache] Cache size (${stats.totalSizeMB} MB) exceeds limit (${MAX_CACHE_SIZE_GB} GB), cleaning up...`);

    // Collect all cache files with their metadata
    const allFiles = [];
    const subdirs = await fs.readdir(SYNC_CACHE_DIR).catch(() => []);

    for (const subdir of subdirs) {
      const subdirPath = path.join(SYNC_CACHE_DIR, subdir);
      const stat = await fs.stat(subdirPath).catch(() => null);

      if (!stat || !stat.isDirectory()) continue;

      const files = await fs.readdir(subdirPath).catch(() => []);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = path.join(subdirPath, file);
        const fileStat = await fs.stat(filePath).catch(() => null);

        if (fileStat) {
          allFiles.push({
            path: filePath,
            size: fileStat.size,
            timestamp: fileStat.mtimeMs
          });
        }
      }
    }

    // Sort by timestamp (oldest first)
    allFiles.sort((a, b) => a.timestamp - b.timestamp);

    // Delete oldest files until we're under the limit
    let currentSize = stats.totalSize;
    let deletedCount = 0;

    for (const file of allFiles) {
      if (currentSize <= MAX_CACHE_SIZE_BYTES * 0.8) { // Delete until 80% of limit
        break;
      }

      try {
        await fs.unlink(file.path);
        currentSize -= file.size;
        deletedCount++;
      } catch (error) {
        console.warn(`[Sync Cache] Failed to delete ${file.path}:`, error.message);
      }
    }

    console.log(`[Sync Cache] Deleted ${deletedCount} old files, new size: ${(currentSize / (1024 * 1024)).toFixed(2)} MB`);

  } catch (error) {
    console.error('[Sync Cache] Failed to enforce size limit:', error.message);
  }
}

/**
 * Clear entire sync cache
 * @returns {Promise<void>}
 */
async function clearSyncCache() {
  try {
    await fs.rm(SYNC_CACHE_DIR, { recursive: true, force: true });
    await initSyncCache();
    console.log('[Sync Cache] Cleared all cached synced subtitles');
  } catch (error) {
    console.error('[Sync Cache] Failed to clear cache:', error.message);
    throw error;
  }
}

module.exports = {
  initSyncCache,
  generateSyncCacheKey,
  saveSyncedSubtitle,
  getSyncedSubtitles,
  getSyncedSubtitle,
  deleteSyncedSubtitle,
  getCacheStats,
  clearSyncCache
};
