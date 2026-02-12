/**
 * SubMaker Database (SMDB) Cache
 * Community-uploaded subtitles keyed by video hash + language code.
 * One subtitle per language per video hash. Supports override limiting.
 */

const log = require('./logger');
const { handleCaughtError } = require('./errorClassifier');
const { StorageFactory, StorageAdapter } = require('../storage');

let storageAdapter = null;

const CACHE_TYPE = StorageAdapter.CACHE_TYPES.SMDB;

// Override rate limiting (3 overrides per user per hour)
const MAX_OVERRIDES_PER_HOUR = 3;
const OVERRIDE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
// In-memory override tracker (keyed by uploaderHash → array of timestamps)
const overrideTracker = new Map();

// Index for per-video language listings (avoids SCAN in hot paths)
const INDEX_VERSION = 1;
const MAX_LANGUAGES_PER_VIDEO = 100;

async function getStorageAdapter() {
    if (!storageAdapter) {
        storageAdapter = await StorageFactory.getStorageAdapter();
    }
    return storageAdapter;
}

/**
 * Sanitize a string for use as a cache key component
 */
function sanitizeKey(value) {
    if (!value) return '';
    return String(value)
        .replace(/[\*\?\[\]\\]/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 120);
}

/**
 * Build the storage key for a subtitle entry
 */
function buildKey(videoHash, langCode) {
    return `smdb:${sanitizeKey(videoHash)}:${sanitizeKey(langCode)}`;
}

/**
 * Build the index key that lists all languages for a video hash
 */
function buildIndexKey(videoHash) {
    return `__index_smdb__${sanitizeKey(videoHash)}`;
}

/**
 * Load the language index for a video hash
 */
async function loadIndex(adapter, videoHash) {
    const indexKey = buildIndexKey(videoHash);
    const index = await adapter.get(indexKey, CACHE_TYPE);
    if (!index || index.version !== INDEX_VERSION || !Array.isArray(index.entries)) {
        return { indexKey, entries: [] };
    }
    return { indexKey, entries: index.entries };
}

/**
 * Persist the language index for a video hash
 */
async function persistIndex(adapter, indexKey, entries) {
    // Deduplicate by langCode, keeping the most recent entry per language
    const byLang = new Map();
    for (const entry of entries) {
        byLang.set(entry.languageCode, entry);
    }
    const unique = Array.from(byLang.values()).slice(0, MAX_LANGUAGES_PER_VIDEO);
    await adapter.set(indexKey, { version: INDEX_VERSION, entries: unique }, CACHE_TYPE);
}

/**
 * Save a subtitle to the SMDB
 * @param {string} videoHash - The video hash (real Stremio hash or derived)
 * @param {string} langCode - ISO 639-2/B language code (e.g., 'por', 'eng')
 * @param {string} srtContent - The subtitle content (SRT/VTT/ASS text)
 * @param {string} uploaderHash - Hash identifying the uploader (config hash)
 * @returns {Promise<{success: boolean, isOverride: boolean, error?: string}>}
 */
async function saveSubtitle(videoHash, langCode, srtContent, uploaderHash) {
    try {
        if (!videoHash || !langCode || !srtContent) {
            return { success: false, error: 'Missing required fields' };
        }

        const adapter = await getStorageAdapter();
        const key = buildKey(videoHash, langCode);
        const existing = await adapter.get(key, CACHE_TYPE);
        const isOverride = !!existing;

        // Check override limit if replacing an existing subtitle
        if (isOverride) {
            const limit = checkOverrideLimit(uploaderHash);
            if (!limit.allowed) {
                return { success: false, error: `Override limit reached (${MAX_OVERRIDES_PER_HOUR}/hour). Try again later.`, remaining: limit.remaining };
            }
        }

        const entry = {
            videoHash: sanitizeKey(videoHash),
            languageCode: sanitizeKey(langCode),
            content: srtContent,
            uploaderHash: sanitizeKey(uploaderHash || 'anonymous'),
            timestamp: Date.now(),
            version: '1.0'
        };

        await adapter.set(key, entry, CACHE_TYPE);

        // Record override if applicable
        if (isOverride) {
            recordOverride(uploaderHash);
        }

        // Update the per-video index
        const { indexKey, entries } = await loadIndex(adapter, videoHash);
        // Remove existing entry for this language if present, add new one
        const updatedEntries = entries.filter(e => e.languageCode !== langCode);
        updatedEntries.push({
            languageCode: langCode,
            timestamp: entry.timestamp,
            uploaderHash: entry.uploaderHash
        });
        await persistIndex(adapter, indexKey, updatedEntries);

        log.info(() => `[SMDB] Saved subtitle: hash=${videoHash.slice(0, 8)}..., lang=${langCode}, override=${isOverride}, uploader=${(uploaderHash || '').slice(0, 8)}`);

        return { success: true, isOverride };
    } catch (error) {
        handleCaughtError(error, `[SMDB] saveSubtitle failed`, log);
        return { success: false, error: error.message };
    }
}

/**
 * Retrieve a single subtitle from the SMDB
 * @param {string} videoHash - The video hash
 * @param {string} langCode - ISO 639-2/B language code
 * @returns {Promise<{content: string, uploaderHash: string, timestamp: number}|null>}
 */
async function getSubtitle(videoHash, langCode) {
    try {
        if (!videoHash || !langCode) return null;
        const adapter = await getStorageAdapter();
        const key = buildKey(videoHash, langCode);
        const entry = await adapter.get(key, CACHE_TYPE);
        if (!entry || !entry.content) return null;
        return {
            content: entry.content,
            languageCode: entry.languageCode,
            uploaderHash: entry.uploaderHash,
            timestamp: entry.timestamp
        };
    } catch (error) {
        handleCaughtError(error, `[SMDB] getSubtitle failed`, log);
        return null;
    }
}

/**
 * List all available languages for a video hash
 * @param {string} videoHash - The video hash
 * @returns {Promise<Array<{languageCode: string, timestamp: number, uploaderHash: string}>>}
 */
async function listSubtitles(videoHash) {
    try {
        if (!videoHash) return [];
        const adapter = await getStorageAdapter();
        const { entries } = await loadIndex(adapter, videoHash);
        return entries;
    } catch (error) {
        handleCaughtError(error, `[SMDB] listSubtitles failed`, log);
        return [];
    }
}

/**
 * List subtitles checking multiple video hashes (for cross-source matching)
 * Merges results, preferring stremioHash entries over derivedHash entries
 * @param {string[]} videoHashes - Array of hashes to check (e.g., [stremioHash, derivedHash])
 * @returns {Promise<Array<{languageCode: string, timestamp: number, uploaderHash: string, videoHash: string}>>}
 */
async function listSubtitlesMultiHash(videoHashes) {
    try {
        if (!videoHashes || !videoHashes.length) return [];
        const uniqueHashes = [...new Set(videoHashes.filter(Boolean))];
        if (!uniqueHashes.length) return [];

        // Fetch indexes for all hashes in parallel
        const results = await Promise.all(uniqueHashes.map(async (hash) => {
            const entries = await listSubtitles(hash);
            return entries.map(e => ({ ...e, videoHash: hash }));
        }));

        // Merge: first hash wins per language (stremioHash should be first)
        const byLang = new Map();
        for (const entries of results) {
            for (const entry of entries) {
                if (!byLang.has(entry.languageCode)) {
                    byLang.set(entry.languageCode, entry);
                }
            }
        }

        return Array.from(byLang.values());
    } catch (error) {
        handleCaughtError(error, `[SMDB] listSubtitlesMultiHash failed`, log);
        return [];
    }
}

/**
 * Get a subtitle checking multiple video hashes
 * @param {string[]} videoHashes - Array of hashes to check
 * @param {string} langCode - Language code
 * @returns {Promise<{content: string, uploaderHash: string, timestamp: number, videoHash: string}|null>}
 */
async function getSubtitleMultiHash(videoHashes, langCode) {
    try {
        if (!videoHashes || !videoHashes.length || !langCode) return null;
        const uniqueHashes = [...new Set(videoHashes.filter(Boolean))];

        for (const hash of uniqueHashes) {
            const sub = await getSubtitle(hash, langCode);
            if (sub) return { ...sub, videoHash: hash };
        }
        return null;
    } catch (error) {
        handleCaughtError(error, `[SMDB] getSubtitleMultiHash failed`, log);
        return null;
    }
}

/**
 * Delete a subtitle from the SMDB
 * @param {string} videoHash - The video hash
 * @param {string} langCode - ISO 639-2/B language code
 * @returns {Promise<boolean>}
 */
async function deleteSubtitle(videoHash, langCode) {
    try {
        if (!videoHash || !langCode) return false;
        const adapter = await getStorageAdapter();
        const key = buildKey(videoHash, langCode);
        await adapter.delete(key, CACHE_TYPE);

        // Update index
        const { indexKey, entries } = await loadIndex(adapter, videoHash);
        const updatedEntries = entries.filter(e => e.languageCode !== langCode);
        await persistIndex(adapter, indexKey, updatedEntries);

        log.info(() => `[SMDB] Deleted subtitle: hash=${videoHash.slice(0, 8)}..., lang=${langCode}`);
        return true;
    } catch (error) {
        handleCaughtError(error, `[SMDB] deleteSubtitle failed`, log);
        return false;
    }
}

/**
 * Check if an uploader can override (3 per hour limit)
 * @param {string} uploaderHash - The uploader's config hash
 * @returns {{allowed: boolean, remaining: number}}
 */
function checkOverrideLimit(uploaderHash) {
    if (!uploaderHash) return { allowed: true, remaining: MAX_OVERRIDES_PER_HOUR };

    const now = Date.now();
    const key = sanitizeKey(uploaderHash);
    const timestamps = overrideTracker.get(key) || [];

    // Filter to only those within the last hour
    const recent = timestamps.filter(ts => now - ts <= OVERRIDE_WINDOW_MS);
    overrideTracker.set(key, recent);

    const remaining = Math.max(0, MAX_OVERRIDES_PER_HOUR - recent.length);
    return {
        allowed: recent.length < MAX_OVERRIDES_PER_HOUR,
        remaining
    };
}

/**
 * Record an override for rate limiting
 * @param {string} uploaderHash - The uploader's config hash
 */
function recordOverride(uploaderHash) {
    if (!uploaderHash) return;
    const now = Date.now();
    const key = sanitizeKey(uploaderHash);
    const timestamps = overrideTracker.get(key) || [];
    const recent = timestamps.filter(ts => now - ts <= OVERRIDE_WINDOW_MS);
    recent.push(now);
    overrideTracker.set(key, recent);
}

/**
 * Check if a subtitle exists for a given hash + language
 * @param {string} videoHash
 * @param {string} langCode
 * @returns {Promise<boolean>}
 */
async function exists(videoHash, langCode) {
    try {
        if (!videoHash || !langCode) return false;
        const adapter = await getStorageAdapter();
        const key = buildKey(videoHash, langCode);
        return await adapter.exists(key, CACHE_TYPE);
    } catch (error) {
        handleCaughtError(error, `[SMDB] exists check failed`, log);
        return false;
    }
}

/**
 * Build the key for a hash mapping entry
 */
function buildHashMapKey(hash) {
    return `smdb_hashmap:${sanitizeKey(hash)}`;
}

/**
 * Persist a bidirectional hash mapping (stremioHash ↔ derivedHash).
 * Idempotent — safe to call repeatedly with the same pair.
 * @param {string} hash1 - First hash (e.g., stremioHash)
 * @param {string} hash2 - Second hash (e.g., derivedHash)
 */
async function saveHashMapping(hash1, hash2) {
    try {
        if (!hash1 || !hash2 || hash1 === hash2) return;
        const adapter = await getStorageAdapter();

        // Store bidirectional: hash1 → [hash2] and hash2 → [hash1]
        const key1 = buildHashMapKey(hash1);
        const key2 = buildHashMapKey(hash2);

        // Load existing mappings, add the new association
        const existing1 = await adapter.get(key1, CACHE_TYPE) || { hashes: [] };
        const existing2 = await adapter.get(key2, CACHE_TYPE) || { hashes: [] };

        const set1 = new Set(existing1.hashes);
        const set2 = new Set(existing2.hashes);
        set1.add(hash2);
        set2.add(hash1);

        // Cap at a reasonable max to prevent unbounded growth
        const MAX_MAPPED = 10;
        await adapter.set(key1, { hashes: [...set1].slice(0, MAX_MAPPED) }, CACHE_TYPE);
        await adapter.set(key2, { hashes: [...set2].slice(0, MAX_MAPPED) }, CACHE_TYPE);

        log.debug(() => `[SMDB] Hash mapping saved: ${hash1.slice(0, 8)}… ↔ ${hash2.slice(0, 8)}…`);
    } catch (error) {
        handleCaughtError(error, `[SMDB] saveHashMapping failed`, log);
    }
}

/**
 * Get all hashes associated with a given hash (including the hash itself)
 * @param {string} hash - Any video hash
 * @returns {Promise<string[]>} Array of associated hashes (always includes the input hash)
 */
async function getAssociatedHashes(hash) {
    try {
        if (!hash) return [];
        const adapter = await getStorageAdapter();
        const key = buildHashMapKey(hash);
        const mapping = await adapter.get(key, CACHE_TYPE);
        const result = new Set([hash]);
        if (mapping && Array.isArray(mapping.hashes)) {
            for (const h of mapping.hashes) {
                if (h) result.add(h);
            }
        }
        return [...result];
    } catch (error) {
        handleCaughtError(error, `[SMDB] getAssociatedHashes failed`, log);
        return [hash].filter(Boolean);
    }
}

module.exports = {
    saveSubtitle,
    getSubtitle,
    listSubtitles,
    listSubtitlesMultiHash,
    getSubtitleMultiHash,
    deleteSubtitle,
    checkOverrideLimit,
    recordOverride,
    exists,
    saveHashMapping,
    getAssociatedHashes
};
