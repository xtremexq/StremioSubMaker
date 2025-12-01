/**
 * Sync Cache Management
 * Handles storage and retrieval of synced subtitles
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { StorageFactory, StorageAdapter } = require('../storage');
const log = require('./logger');

// Index metadata is stored alongside sync cache entries so we can avoid
// per-request SCANs. Index keys are namespaced and sanitized to avoid
// cross-user bleed (storage adapters already isolate via prefix/baseDir).
const INDEX_VERSION = 1;
const MAX_INDEX_ENTRIES = 200; // hard cap per video/lang to avoid unbounded growth

// Cache directory for synced subtitles (legacy filesystem fallback)
const SYNC_CACHE_DIR = path.join(process.cwd(), '.cache', 'sync_cache');
const MAX_CACHE_SIZE_GB = 50; // 50GB max for sync cache
const MAX_CACHE_SIZE_BYTES = MAX_CACHE_SIZE_GB * 1024 * 1024 * 1024;

// Storage adapter (lazy loaded)
let storageAdapter = null;
async function getStorageAdapter() {
  if (!storageAdapter) {
    storageAdapter = await StorageFactory.getStorageAdapter();
  }
  return storageAdapter;
}

/**
 * Initialize sync cache directory
 */
async function initSyncCache() {
  try {
    await fs.mkdir(SYNC_CACHE_DIR, { recursive: true });
    log.debug(() => ['[Sync Cache] Initialized at:', SYNC_CACHE_DIR]);
  } catch (error) {
    log.error(() => ['[Sync Cache] Failed to initialize:', error.message]);
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

function normalizeIndexSegment(value, fallback = 'unknown') {
  const str = String(value || fallback);
  let normalized = str.replace(/[\s\*\?\[\]\\]/g, '_');
  if (normalized.length > 64) {
    const hash = crypto.createHash('md5').update(str).digest('hex').slice(0, 8);
    normalized = normalized.slice(0, 40) + '_' + hash;
  }
  return normalized || fallback;
}

function getIndexKey(videoHash, languageCode) {
  const safeVideo = normalizeIndexSegment(videoHash);
  const safeLang = normalizeIndexSegment(languageCode);
  return `__index_sync__${safeVideo}__${safeLang}`;
}

async function loadIndex(adapter, videoHash, languageCode) {
  const indexKey = getIndexKey(videoHash, languageCode);
  const index = await adapter.get(indexKey, StorageAdapter.CACHE_TYPES.SYNC);
  if (!index || index.version !== INDEX_VERSION || !Array.isArray(index.keys)) {
    return { indexKey, keys: [] };
  }
  return { indexKey, keys: index.keys };
}

async function persistIndex(adapter, indexKey, keys, previousKeys = [], scanPattern = null) {
  const unique = Array.from(new Set(keys)).slice(-MAX_INDEX_ENTRIES);
  const trimmed = Array.isArray(keys) ? keys.filter(k => k && !unique.includes(k)) : [];
  const removed = Array.isArray(previousKeys) ? previousKeys.filter(k => k && !unique.includes(k)) : [];
  const stray = [];

  if (scanPattern) {
    try {
      const listed = await adapter.list(StorageAdapter.CACHE_TYPES.SYNC, scanPattern);
      if (Array.isArray(listed)) {
        for (const key of listed) {
          if (key && !unique.includes(key)) {
            stray.push(key);
          }
        }
      }
    } catch (error) {
      log.warn(() => [`[Sync Cache] Failed to list for pruning (${scanPattern}):`, error.message]);
    }
  }

  const toDelete = Array.from(new Set([...trimmed, ...removed, ...stray]));

  await adapter.set(indexKey, { version: INDEX_VERSION, keys: unique }, StorageAdapter.CACHE_TYPES.SYNC);

  if (toDelete.length) {
    for (const key of toDelete) {
      try {
        await adapter.delete(key, StorageAdapter.CACHE_TYPES.SYNC);
      } catch (error) {
        log.warn(() => [`[Sync Cache] Failed to delete pruned key ${key}:`, error.message]);
      }
    }
  }

  return unique;
}

async function addToIndex(adapter, videoHash, languageCode, cacheKey) {
  const { indexKey, keys: previousKeys } = await loadIndex(adapter, videoHash, languageCode);
  if (previousKeys.includes(cacheKey)) {
    return previousKeys;
  }
  const updated = [...previousKeys, cacheKey];
  const pattern = `${videoHash}_${languageCode}_*`;
  return persistIndex(adapter, indexKey, updated, previousKeys, pattern);
}

async function removeFromIndex(adapter, videoHash, languageCode, cacheKey) {
  const { indexKey, keys: previousKeys } = await loadIndex(adapter, videoHash, languageCode);
  if (!previousKeys.length) {
    return;
  }
  const filtered = previousKeys.filter(k => k !== cacheKey);
  if (filtered.length === previousKeys.length) {
    return;
  }
  const pattern = `${videoHash}_${languageCode}_*`;
  await persistIndex(adapter, indexKey, filtered, previousKeys, pattern);
}

async function rebuildIndexFromStorage(adapter, videoHash, languageCode) {
  const pattern = `${videoHash}_${languageCode}_*`;
  const keys = await adapter.list(StorageAdapter.CACHE_TYPES.SYNC, pattern);
  const { indexKey, keys: previousKeys } = await loadIndex(adapter, videoHash, languageCode);
  const saved = await persistIndex(adapter, indexKey, keys || [], previousKeys, pattern);
  return saved;
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
 * Save synced subtitle to storage
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
    const adapter = await getStorageAdapter();

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

    // Save to storage
    await adapter.set(cacheKey, cacheEntry, StorageAdapter.CACHE_TYPES.SYNC);

    // Maintain per-video/lang index to avoid SCAN on reads
    try {
      await addToIndex(adapter, videoHash, languageCode, cacheKey);
    } catch (error) {
      log.warn(() => [`[Sync Cache] Failed to update index for ${cacheKey}:`, error.message]);
    }

    log.debug(() => `[Sync Cache] Saved: ${cacheKey}`);

  } catch (error) {
    log.error(() => ['[Sync Cache] Failed to save:', error.message]);
    throw error;
  }
}

/**
 * Get all synced subtitles for a video hash and language
 * Uses the configured storage adapter (Redis or filesystem)
 * @param {string} videoHash - Video file hash
 * @param {string} languageCode - Language code
 * @returns {Promise<Array>} Array of synced subtitle entries
 */
async function getSyncedSubtitles(videoHash, languageCode) {
  try {
    const adapter = await getStorageAdapter();
    let { keys } = await loadIndex(adapter, videoHash, languageCode);

    // If the index is empty, rebuild once from storage as a fallback
    if (!keys.length) {
      keys = await rebuildIndexFromStorage(adapter, videoHash, languageCode);
    }

    const results = [];

    for (const cacheKey of keys) {
      try {
        const entry = await adapter.get(cacheKey, StorageAdapter.CACHE_TYPES.SYNC);
        if (!entry) {
          try { await removeFromIndex(adapter, videoHash, languageCode, cacheKey); } catch (_) {}
          continue;
        }

        results.push({
          cacheKey,
          sourceSubId: entry.sourceSubId,
          originalSubId: entry.originalSubId,
          content: entry.content,
          metadata: entry.metadata,
          timestamp: entry.timestamp || Date.now()
        });
      } catch (error) {
        log.warn(() => [`[Sync Cache] Failed to fetch entry for ${cacheKey}:`, error.message]);
        // On failure, drop the key from index to avoid repeat hits
        try { await removeFromIndex(adapter, videoHash, languageCode, cacheKey); } catch (_) {}
      }
    }

    // Sort by timestamp (newest first)
    results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    log.debug(() => `[Sync Cache] Found ${results.length} synced subtitles for ${videoHash}_${languageCode}`);
    return results;

  } catch (error) {
    log.error(() => ['[Sync Cache] Failed to retrieve:', error.message]);
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
    const adapter = await getStorageAdapter();

    const entry = await adapter.get(cacheKey, StorageAdapter.CACHE_TYPES.SYNC);

    if (!entry) {
      return null;
    }

    log.debug(() => `[Sync Cache] Retrieved: ${cacheKey}`);
    return {
      cacheKey,
      sourceSubId: entry.sourceSubId,
      originalSubId: entry.originalSubId,
      content: entry.content,
      metadata: entry.metadata,
      timestamp: entry.timestamp
    };

  } catch (error) {
    log.warn(() => [`[Sync Cache] Failed to retrieve ${videoHash}_${languageCode}_${sourceSubId}:`, error.message]);
    return null;
  }
}

/**
 * Delete a synced subtitle from storage
 * @param {string} videoHash - Video file hash
 * @param {string} languageCode - Language code
 * @param {string} sourceSubId - Source subtitle ID
 * @returns {Promise<boolean>} True if deleted
 */
async function deleteSyncedSubtitle(videoHash, languageCode, sourceSubId) {
  try {
    const cacheKey = generateSyncCacheKey(videoHash, languageCode, sourceSubId);
    const adapter = await getStorageAdapter();

    const deleted = await adapter.delete(cacheKey, StorageAdapter.CACHE_TYPES.SYNC);
    if (deleted) {
      try {
        await removeFromIndex(adapter, videoHash, languageCode, cacheKey);
      } catch (error) {
        log.warn(() => [`[Sync Cache] Failed to update index on delete for ${cacheKey}:`, error.message]);
      }
      log.debug(() => `[Sync Cache] Deleted: ${cacheKey}`);
    }
    return deleted;

  } catch (error) {
    log.error(() => ['[Sync Cache] Failed to delete:', error.message]);
    return false;
  }
}

/**
 * Get total cache size and entry count for sync cache
 * @returns {Promise<Object>} Cache statistics
 */
async function getCacheStats() {
  try {
    const adapter = await getStorageAdapter();
    const totalSize = await adapter.size(StorageAdapter.CACHE_TYPES.SYNC);
    const keys = await adapter.list(StorageAdapter.CACHE_TYPES.SYNC, '*');
    const fileCount = Array.isArray(keys) ? keys.length : 0;

    return {
      totalSize,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      fileCount,
      maxSizeGB: MAX_CACHE_SIZE_GB
    };

  } catch (error) {
    log.error(() => ['[Sync Cache] Failed to get stats:', error.message]);
    return { totalSize: 0, totalSizeMB: '0.00', fileCount: 0, maxSizeGB: MAX_CACHE_SIZE_GB };
  }
}

/**
 * Enforce cache size limit using the storage adapter's cleanup logic
 * @returns {Promise<void>}
 */
async function enforceCacheSizeLimit() {
  try {
    const adapter = await getStorageAdapter();
    const result = await adapter.cleanup(StorageAdapter.CACHE_TYPES.SYNC);
    if (result && (result.deleted > 0 || result.bytesFreed > 0)) {
      log.debug(() => `[Sync Cache] Cleanup: deleted ${result.deleted} entries, freed ${result.bytesFreed} bytes`);
    }
  } catch (error) {
    log.error(() => ['[Sync Cache] Failed to enforce size limit:', error.message]);
  }
}

/**
 * Clear entire sync cache via storage adapter
 * @returns {Promise<void>}
 */
async function clearSyncCache() {
  try {
    const adapter = await getStorageAdapter();
    const keys = await adapter.list(StorageAdapter.CACHE_TYPES.SYNC, '*');

    for (const key of keys) {
      try { await adapter.delete(key, StorageAdapter.CACHE_TYPES.SYNC); } catch (_) { /* ignore */ }
    }

    log.debug(() => '[Sync Cache] Cleared all cached synced subtitles');
  } catch (error) {
    log.error(() => ['[Sync Cache] Failed to clear cache:', error.message]);
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
