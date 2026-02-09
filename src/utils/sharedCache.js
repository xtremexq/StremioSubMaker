/**
 * Shared Cache Utility for Multi-Instance Deployments
 * 
 * This module provides Redis-backed caching utilities that work across
 * multiple pods in a distributed deployment. It uses the existing
 * StorageAdapter infrastructure for Redis access.
 * 
 * Key Features:
 * - Cross-pod cache sharing via Redis
 * - TTL-based expiry for automatic cleanup
 * - Atomic counter operations for concurrency tracking
 * - Graceful fallback when Redis is unavailable
 */

const log = require('./logger');
const { handleCaughtError } = require('./errorClassifier');

// Lazy-load storage adapter to avoid circular dependencies
let _storageAdapter = null;
let _StorageAdapter = null;

async function getStorageAdapter() {
    if (!_storageAdapter) {
        const { getStorageAdapter: getAdapter, StorageAdapter } = require('../storage');
        _StorageAdapter = StorageAdapter;
        _storageAdapter = await getAdapter();
    }
    return _storageAdapter;
}

function getStorageAdapterClass() {
    if (!_StorageAdapter) {
        const { StorageAdapter } = require('../storage');
        _StorageAdapter = StorageAdapter;
    }
    return _StorageAdapter;
}

// ============================================================================
// SHARED CACHE OPERATIONS (for anime IDs, TMDB lookups, etc.)
// ============================================================================

/**
 * Get a value from the shared Redis cache
 * @param {string} key - Cache key
 * @param {string} cacheType - Cache type (e.g., PROVIDER_METADATA)
 * @returns {Promise<string|null>} Cached value or null if not found
 */
async function getShared(key, cacheType) {
    try {
        const adapter = await getStorageAdapter();
        const value = await adapter.get(key, cacheType);
        if (value !== null && value !== undefined) {
            log.debug(() => `[SharedCache] HIT ${key}`);
            return value;
        }
        log.debug(() => `[SharedCache] MISS ${key}`);
        return null;
    } catch (error) {
        return handleCaughtError(error, `[SharedCache] GET failed for ${key}`, log, { fallbackValue: null });
    }
}

/**
 * Set a value in the shared Redis cache
 * @param {string} key - Cache key
 * @param {any} value - Value to cache (will be serialized)
 * @param {string} cacheType - Cache type (e.g., PROVIDER_METADATA)
 * @param {number} ttlSeconds - TTL in seconds (null = use default for cache type)
 * @returns {Promise<boolean>} True if successful
 */
async function setShared(key, value, cacheType, ttlSeconds = null) {
    try {
        const adapter = await getStorageAdapter();
        await adapter.set(key, value, cacheType, ttlSeconds);
        log.debug(() => `[SharedCache] SET ${key} (TTL: ${ttlSeconds || 'default'}s)`);
        return true;
    } catch (error) {
        return handleCaughtError(error, `[SharedCache] SET failed for ${key}`, log, { fallbackValue: false });
    }
}

/**
 * Delete a value from the shared Redis cache
 * @param {string} key - Cache key
 * @param {string} cacheType - Cache type
 * @returns {Promise<boolean>} True if deleted
 */
async function deleteShared(key, cacheType) {
    try {
        const adapter = await getStorageAdapter();
        await adapter.delete(key, cacheType);
        log.debug(() => `[SharedCache] DELETE ${key}`);
        return true;
    } catch (error) {
        return handleCaughtError(error, `[SharedCache] DELETE failed for ${key}`, log, { fallbackValue: false });
    }
}

// ============================================================================
// ATOMIC COUNTER OPERATIONS (for concurrency tracking)
// ============================================================================

/**
 * Atomically increment a counter in Redis with TTL refresh
 * Used for cross-pod concurrency tracking with automatic cleanup
 * 
 * @param {string} key - Counter key (will be prefixed with session:)
 * @param {number} ttlSeconds - TTL in seconds (refreshed on each increment)
 * @returns {Promise<number>} New counter value, or -1 on failure
 */
async function incrementCounter(key, ttlSeconds = 1800) {
    try {
        const adapter = await getStorageAdapter();
        const StorageAdapter = getStorageAdapterClass();

        // Access the raw Redis client for atomic operations
        if (!adapter.client) {
            log.warn(() => `[SharedCache] No Redis client available for counter increment`);
            return -1;
        }

        // Build the full key using adapter's key generation
        const fullKey = adapter._getKey(key, StorageAdapter.CACHE_TYPES.SESSION);

        // Atomic INCR + EXPIRE in a pipeline for consistency
        const pipeline = adapter.client.pipeline();
        pipeline.incr(fullKey);
        pipeline.expire(fullKey, ttlSeconds);

        const results = await pipeline.exec();
        const newCount = results[0][1]; // INCR result

        log.debug(() => `[SharedCache] INCR ${key} = ${newCount} (TTL: ${ttlSeconds}s)`);
        return newCount;
    } catch (error) {
        return handleCaughtError(error, `[SharedCache] INCR failed for ${key}`, log, { fallbackValue: -1 });
    }
}

/**
 * Atomically decrement a counter in Redis (minimum 0)
 * 
 * @param {string} key - Counter key
 * @returns {Promise<number>} New counter value, or -1 on failure
 */
async function decrementCounter(key) {
    try {
        const adapter = await getStorageAdapter();
        const StorageAdapter = getStorageAdapterClass();

        if (!adapter.client) {
            log.warn(() => `[SharedCache] No Redis client available for counter decrement`);
            return -1;
        }

        const fullKey = adapter._getKey(key, StorageAdapter.CACHE_TYPES.SESSION);

        // MULTI-INSTANCE FIX: Use Lua script for atomic decrement that prevents going negative
        // This avoids the TOCTOU race where two pods could both GET the same value
        // and both DECR, resulting in a negative counter in Redis.
        const luaScript = `
            local current = tonumber(redis.call('get', KEYS[1]) or '0')
            if current <= 0 then
                return 0
            end
            return redis.call('decr', KEYS[1])
        `;

        const newCount = await adapter.client.eval(luaScript, 1, fullKey);
        log.debug(() => `[SharedCache] DECR ${key} = ${newCount}`);
        return Math.max(0, newCount);

    } catch (error) {
        return handleCaughtError(error, `[SharedCache] DECR failed for ${key}`, log, { fallbackValue: -1 });
    }
}

/**
 * Get current counter value without modifying it
 * 
 * @param {string} key - Counter key
 * @returns {Promise<number>} Current count, or 0 on failure/missing
 */
async function getCounter(key) {
    try {
        const adapter = await getStorageAdapter();
        const StorageAdapter = getStorageAdapterClass();

        if (!adapter.client) {
            return 0;
        }

        const fullKey = adapter._getKey(key, StorageAdapter.CACHE_TYPES.SESSION);
        const value = await adapter.client.get(fullKey);
        const count = value ? parseInt(value, 10) : 0;

        log.debug(() => `[SharedCache] GET counter ${key} = ${count}`);
        return count;
    } catch (error) {
        return handleCaughtError(error, `[SharedCache] GET counter failed for ${key}`, log, { fallbackValue: 0 });
    }
}

// ============================================================================
// KEY HEALTH TRACKING (for multi-instance API key management)
// ============================================================================

// Constants for key health (must match TranslationEngine values)
const KEY_HEALTH_ERROR_THRESHOLD = 5;
const KEY_HEALTH_COOLDOWN_SECONDS = 60 * 60; // 1 hour

/**
 * Record an error for an API key in Redis (distributed key health tracking)
 * Keys with >= threshold errors within cooldown period are skipped across all pods.
 * 
 * @param {string} apiKey - The API key that errored
 * @returns {Promise<{count: number, coolingDown: boolean}>} Current error state
 */
async function recordKeyError(apiKey) {
    if (!apiKey) return { count: 0, coolingDown: false };

    try {
        const adapter = await getStorageAdapter();
        const StorageAdapter = getStorageAdapterClass();

        if (!adapter.client) {
            log.warn(() => `[SharedCache] No Redis client for key health tracking`);
            return { count: 0, coolingDown: false };
        }

        // Use a hash to store both count and lastError atomically
        const keyHash = require('crypto').createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
        const fullKey = adapter._getKey(`keyhealth:${keyHash}`, StorageAdapter.CACHE_TYPES.SESSION);

        // Atomic increment of error count + update lastError time + set TTL
        const pipeline = adapter.client.pipeline();
        pipeline.hincrby(fullKey, 'count', 1);
        pipeline.hset(fullKey, 'lastError', Date.now().toString());
        pipeline.expire(fullKey, KEY_HEALTH_COOLDOWN_SECONDS);

        const results = await pipeline.exec();
        const newCount = results[0][1]; // HINCRBY result
        const coolingDown = newCount >= KEY_HEALTH_ERROR_THRESHOLD;

        if (coolingDown) {
            const redactedKey = apiKey.length > 10
                ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`
                : '[REDACTED]';
            log.warn(() => `[SharedCache] Key ${redactedKey} reached ${newCount} errors, cooling down for ~1h (cross-pod)`);
        } else {
            log.debug(() => `[SharedCache] Key health: ${keyHash.slice(0, 8)}... = ${newCount} errors`);
        }

        return { count: newCount, coolingDown };
    } catch (error) {
        handleCaughtError(error, `[SharedCache] recordKeyError failed`, log);
        return { count: 0, coolingDown: false };
    }
}

/**
 * Check if an API key is currently in cooldown (unhealthy) across all pods
 * 
 * @param {string} apiKey - The API key to check
 * @returns {Promise<boolean>} True if key should be skipped
 */
async function isKeyCoolingDown(apiKey) {
    if (!apiKey) return false;

    try {
        const adapter = await getStorageAdapter();
        const StorageAdapter = getStorageAdapterClass();

        if (!adapter.client) {
            return false; // Fail open - allow key if Redis unavailable
        }

        const keyHash = require('crypto').createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
        const fullKey = adapter._getKey(`keyhealth:${keyHash}`, StorageAdapter.CACHE_TYPES.SESSION);

        const count = await adapter.client.hget(fullKey, 'count');
        const errorCount = count ? parseInt(count, 10) : 0;

        // Key is cooling down if error count >= threshold
        // The TTL handles automatic reset after cooldown period
        return errorCount >= KEY_HEALTH_ERROR_THRESHOLD;
    } catch (error) {
        handleCaughtError(error, `[SharedCache] isKeyCoolingDown failed`, log);
        return false; // Fail open
    }
}

/**
 * Get current error count for an API key (for debugging/monitoring)
 * 
 * @param {string} apiKey - The API key to check
 * @returns {Promise<number>} Current error count
 */
async function getKeyErrorCount(apiKey) {
    if (!apiKey) return 0;

    try {
        const adapter = await getStorageAdapter();
        const StorageAdapter = getStorageAdapterClass();

        if (!adapter.client) {
            return 0;
        }

        const keyHash = require('crypto').createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
        const fullKey = adapter._getKey(`keyhealth:${keyHash}`, StorageAdapter.CACHE_TYPES.SESSION);

        const count = await adapter.client.hget(fullKey, 'count');
        return count ? parseInt(count, 10) : 0;
    } catch (error) {
        return 0;
    }
}

/**
 * Reset error count for an API key (e.g., after successful use)
 * 
 * @param {string} apiKey - The API key to reset
 * @returns {Promise<boolean>} True if reset successfully
 */
async function resetKeyHealth(apiKey) {
    if (!apiKey) return false;

    try {
        const adapter = await getStorageAdapter();
        const StorageAdapter = getStorageAdapterClass();

        if (!adapter.client) {
            return false;
        }

        const keyHash = require('crypto').createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
        const fullKey = adapter._getKey(`keyhealth:${keyHash}`, StorageAdapter.CACHE_TYPES.SESSION);

        await adapter.client.del(fullKey);
        log.debug(() => `[SharedCache] Reset key health for ${keyHash.slice(0, 8)}...`);
        return true;
    } catch (error) {
        return handleCaughtError(error, `[SharedCache] resetKeyHealth failed`, log, { fallbackValue: false });
    }
}

// ============================================================================
// ATOMIC KEY ROTATION COUNTER (for distributed round-robin key selection)
// ============================================================================

/**
 * Get the next rotation index atomically across all pods
 * This ensures consistent round-robin key selection in multi-instance deployments.
 * 
 * @param {string} counterId - Identifier for the counter (e.g., 'gemini')
 * @param {number} keyCount - Total number of keys for modulo operation
 * @returns {Promise<number>} Next key index (0 to keyCount-1), or -1 on failure
 */
async function getNextRotationIndex(counterId, keyCount) {
    if (!counterId || !keyCount || keyCount <= 0) return -1;

    try {
        const adapter = await getStorageAdapter();
        const StorageAdapter = getStorageAdapterClass();

        if (!adapter.client) {
            log.warn(() => `[SharedCache] No Redis client for rotation counter`);
            return -1;
        }

        const fullKey = adapter._getKey(`keyrotation:${counterId}`, StorageAdapter.CACHE_TYPES.SESSION);

        // Atomic increment - counter lives indefinitely (no TTL needed)
        // Value wraps naturally due to modulo, so no risk of overflow issues in practice
        const newValue = await adapter.client.incr(fullKey);

        // Use modulo to get index, -1 because we want 0-based after first increment
        const index = (newValue - 1) % keyCount;

        log.debug(() => `[SharedCache] Rotation counter ${counterId}: raw=${newValue}, index=${index}/${keyCount}`);
        return index;
    } catch (error) {
        return handleCaughtError(error, `[SharedCache] getNextRotationIndex failed`, log, { fallbackValue: -1 });
    }
}

/**
 * Get current rotation counter value without incrementing
 * 
 * @param {string} counterId - Identifier for the counter
 * @returns {Promise<number>} Current counter value, or 0 if not found
 */
async function getRotationCounter(counterId) {
    if (!counterId) return 0;

    try {
        const adapter = await getStorageAdapter();
        const StorageAdapter = getStorageAdapterClass();

        if (!adapter.client) {
            return 0;
        }

        const fullKey = adapter._getKey(`keyrotation:${counterId}`, StorageAdapter.CACHE_TYPES.SESSION);
        const value = await adapter.client.get(fullKey);
        return value ? parseInt(value, 10) : 0;
    } catch (error) {
        return 0;
    }
}

// ============================================================================
// CACHE KEY PREFIXES
// ============================================================================

const CACHE_PREFIXES = {
    // Anime ID mappings (24h TTL, 10min for negatives)
    MAL_IMDB: 'anime:mal_imdb:',
    ANILIST_IMDB: 'anime:anilist_imdb:',
    ANIDB_IMDB: 'anime:anidb_imdb:',
    KITSU_IMDB: 'anime:kitsu_imdb:',

    // TMDB to IMDB mappings
    TMDB_IMDB: 'tmdb_imdb:',

    // User concurrency tracking
    USER_CONCURRENCY: 'user_translations:',

    // Key health tracking
    KEY_HEALTH: 'keyhealth:',

    // Key rotation counter
    KEY_ROTATION: 'keyrotation:',

    // OpenSubtitles JWT token cache (cross-pod sharing)
    OS_TOKEN: 'ostoken:'
};

// TTL values in seconds
const CACHE_TTLS = {
    ANIME_POSITIVE: 24 * 60 * 60,  // 24 hours for successful lookups
    ANIME_NEGATIVE: 10 * 60,       // 10 minutes for failed lookups
    TMDB_POSITIVE: 24 * 60 * 60,   // 24 hours for successful lookups
    TMDB_NEGATIVE: 10 * 60,        // 10 minutes for failed lookups
    USER_CONCURRENCY: 30 * 60,     // 30 minutes (safety net for orphaned counts)
    OS_TOKEN: 23 * 60 * 60         // 23 hours (token valid for 24h, 1h buffer)
};

module.exports = {
    // Cache operations
    getShared,
    setShared,
    deleteShared,

    // Counter operations
    incrementCounter,
    decrementCounter,
    getCounter,

    // Key health operations (distributed across pods)
    recordKeyError,
    isKeyCoolingDown,
    getKeyErrorCount,
    resetKeyHealth,

    // Key rotation operations (distributed round-robin)
    getNextRotationIndex,
    getRotationCounter,

    // Constants
    CACHE_PREFIXES,
    CACHE_TTLS,
    KEY_HEALTH_ERROR_THRESHOLD,
    KEY_HEALTH_COOLDOWN_SECONDS,

    // For testing
    getStorageAdapter
};
