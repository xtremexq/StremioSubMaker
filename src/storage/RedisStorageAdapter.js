const log = require('../utils/logger');
const StorageAdapter = require('./StorageAdapter');
const Redis = require('ioredis');
const crypto = require('crypto');
const { getIsolationKey } = require('../utils/isolation');

/**
 * Redis Storage Adapter
 *
 * Stores all cache data in Redis with support for:
 * - TTL-based expiration
 * - LRU eviction based on size limits
 * - Atomic operations
 * - High availability and horizontal scaling
 * - Optional Redis Sentinel for automatic failover (enterprise HA)
 */
class RedisStorageAdapter extends StorageAdapter {
  constructor(options = {}) {
    super();

    const {
      canonicalPrefix,
      variants,
      usedFallbackPrefix
    } = this._normalizeKeyPrefix(options.keyPrefix);

    // Prefix/key migration can unintentionally merge data between tenants when
    // a shared Redis instance is used (e.g., managed hosting). Keep it opt-in
    // to avoid cross-user config leakage while still allowing operators to
    // enable it explicitly for controlled single-tenant migrations.
    // Enable prefix self-healing by default when we're using the built-in
    // fallback prefix (no explicit REDIS_KEY_PREFIX provided). This allows us
    // to pull sessions/configs that were written with the previous
    // isolation-derived default before this fallback was introduced.
    const migrationEnv = process.env.REDIS_PREFIX_MIGRATION;
    this.prefixMigrationEnabled = migrationEnv === 'true' || (migrationEnv !== 'false' && usedFallbackPrefix);

    // Check if Redis Sentinel is enabled (disabled by default)
    const sentinelEnabled = process.env.REDIS_SENTINEL_ENABLED === 'true' || options.sentinelEnabled === true;

    if (sentinelEnabled) {
      // Redis Sentinel configuration for HA deployments
      const sentinels = process.env.REDIS_SENTINELS
        ? process.env.REDIS_SENTINELS.split(',').map(s => {
            const [host, port] = s.trim().split(':');
            return { host, port: parseInt(port) || 26379 };
          })
        : options.sentinels || [{ host: 'localhost', port: 26379 }];

      const sentinelName = process.env.REDIS_SENTINEL_NAME || options.sentinelName || 'mymaster';

      this.options = {
        sentinels,
        name: sentinelName,
        password: options.password || process.env.REDIS_PASSWORD || undefined,
        db: options.db || process.env.REDIS_DB || 0,
        keyPrefix: canonicalPrefix,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        sentinelRetryStrategy: (times) => {
          const delay = Math.min(times * 100, 3000);
          return delay;
        },
        ...options
      };
      log.debug(() => `[Redis] Sentinel mode enabled: ${sentinelName} with ${sentinels.length} sentinel(s)`);
    } else {
      // Standard Redis configuration (default for single-user deployments)
      this.options = {
        host: options.host || process.env.REDIS_HOST || 'localhost',
        port: options.port || process.env.REDIS_PORT || 6379,
        password: options.password || process.env.REDIS_PASSWORD || undefined,
        db: options.db || process.env.REDIS_DB || 0,
        keyPrefix: canonicalPrefix,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        ...options
      };
    }

    this.client = null;
    this.migrationClient = null;
    this.initialized = false;
    this.sentinelMode = sentinelEnabled;
    this.prefixVariants = variants;
  }

  /**
   * Normalize configured keyPrefix and build variants to interop across deployments
   * (colon vs non-colon, custom variants, and empty prefix fallback)
   * @private
   */
  _normalizeKeyPrefix(configuredPrefix) {
    const isolationSegment = getIsolationKey();
    const isolationPrefix = `stremio:${isolationSegment}:`;

    // Use the explicit prefix when provided. Otherwise, fall back to the
    // legacy stable prefix so restarts continue to see previously stored
    // sessions/configs even when the instance ID changes. Include the
    // isolation-derived prefix as a variant so operators can migrate data
    // written before this change.
    const explicitPrefix = configuredPrefix ?? process.env.REDIS_KEY_PREFIX;
    const base = explicitPrefix || 'stremio:';
    const canonicalPrefix = !base || base.endsWith(':') ? base : `${base}:`;
    const usedFallbackPrefix = !explicitPrefix;

    const variants = new Set();
    const addVariants = (prefix) => {
      if (!prefix) return;
      const withColon = prefix.endsWith(':') ? prefix : `${prefix}:`;
      const withoutColon = prefix.endsWith(':') ? prefix.slice(0, -1) : prefix;
      variants.add(withColon);
      variants.add(withoutColon);
    };

    addVariants(canonicalPrefix);
    if (configuredPrefix && configuredPrefix !== canonicalPrefix) {
      addVariants(configuredPrefix);
    }
    // Always include the legacy default so deployments migrating from the old
    // shared prefix can still read/cleanup previously stored data.
    addVariants('stremio:');

    // When using the fallback prefix, also include the isolation-derived prefix
    // so migrations can pull keys written before we reverted to the stable
    // default.
    if (usedFallbackPrefix) {
      addVariants(isolationPrefix);
    }

    if (process.env.REDIS_KEY_PREFIX_VARIANTS) {
      process.env.REDIS_KEY_PREFIX_VARIANTS
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .forEach(addVariants);
    }

    // Always include empty prefix as a fallback for deployments that used no prefix
    variants.add('');

    return {
      canonicalPrefix,
      variants: Array.from(variants),
      usedFallbackPrefix
    };
  }

  /**
   * Sanitize a cache key to prevent NoSQL injection attacks
   * @private
   * @param {string} key - The cache key to sanitize
   * @returns {string} - Sanitized key safe for Redis operations
   */
  _sanitizeKey(key) {
    // Validate input type
    if (!key || typeof key !== 'string') {
      throw new Error('Cache key must be a non-empty string');
    }

    // Remove potentially dangerous Redis wildcard and special characters
    // Replace: * ? [ ] \ with underscores to prevent pattern matching attacks
    let sanitized = key.replace(/[\*\?\[\]\\]/g, '_');

    // Also sanitize newlines, carriage returns, and null bytes that could cause issues
    sanitized = sanitized.replace(/[\r\n\0]/g, '_');

    // Limit key length to prevent DoS via extremely long keys
    const MAX_KEY_LENGTH = 250;
    if (sanitized.length > MAX_KEY_LENGTH) {
      // For very long keys, use a hash to ensure consistent length
      const hash = crypto.createHash('sha256').update(key).digest('hex');
      // Keep first 200 chars + underscore + 16 char hash
      sanitized = sanitized.substring(0, 200) + '_' + hash.substring(0, 16);
      log.debug(() => `[RedisStorage] Long key truncated and hashed: ${key.substring(0, 50)}...`);
    }

    return sanitized;
  }

  /**
   * Get the full Redis key for a cache entry
   * @private
   */
  _getKey(key, cacheType) {
    // Sanitize the key to prevent NoSQL injection attacks
    const sanitizedKey = this._sanitizeKey(key);

    // Note: ioredis already applies `keyPrefix` to all command keys.
    // Do NOT include the prefix here to avoid double-prefixing.
    return `${cacheType}:${sanitizedKey}`;
  }

  /**
   * Get the metadata key for a cache entry
   * @private
   */
  _getMetadataKey(key, cacheType) {
    return `${this._getKey(key, cacheType)}:meta`;
  }

  /**
   * Get the sorted set key for LRU tracking
   * @private
   */
  _getLruKey(cacheType) {
    // Keep raw key; client keyPrefix will be applied by ioredis
    return `lru:${cacheType}`;
  }

  /**
   * Get the total size counter key for a cache type
   * @private
   */
  _getSizeKey(cacheType) {
    // Keep raw key; client keyPrefix will be applied by ioredis
    return `size:${cacheType}`;
  }

  /**
   * Initialize the Redis connection
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    try {
      this.client = new Redis(this.options);

      await new Promise((resolve, reject) => {
        this.client.on('ready', resolve);
        this.client.on('error', reject);
        setTimeout(() => reject(new Error('Redis connection timeout')), 10000);
      });

      if (this.prefixMigrationEnabled) {
        // Self-heal legacy double-prefixed keys to prevent invisible sessions/configs
        await this._migrateDoublePrefixedKeys();
        // Self-heal single-prefixed keys written with alternate prefixes (colon vs non-colon or custom)
        await this._migrateCrossPrefixKeys();
      } else {
        log.debug(() => '[RedisStorage] Prefix migration disabled (REDIS_PREFIX_MIGRATION!=true)');
      }

      this.initialized = true;
      log.debug(() => 'Redis storage adapter initialized successfully');
    } catch (error) {
      // Log a concise error message instead of the full stack trace
      const isConnectionError = error.code === 'ECONNREFUSED' || error.message === 'Redis connection timeout';
      if (isConnectionError) {
        log.debug(() => `Redis connection failed: Unable to connect to ${this.options.host}:${this.options.port}`);
      } else {
        log.error(() => 'Failed to initialize Redis storage adapter:', error.message);
      }
      throw error;
    }
  }

  /**
   * Migrate legacy double-prefixed keys (e.g., stremio:stremio:session:token)
   * to the corrected single-prefix format. This prevents invisible sessions
   * that can cause user configs (languages, API keys) to appear to "randomly"
   * change when Redis is used with a keyPrefix.
   *
   * Migration is capped to avoid long scans on large datasets.
   * @private
   */
  async _migrateDoublePrefixedKeys() {
    const targetPrefix = this.options.keyPrefix || '';
    // Only applicable when a non-empty prefix is set
    if (!targetPrefix) return;

    // Use normalized variants (colon/no-colon, env/custom) so mixed deployments converge
    const variants = new Set(this.prefixVariants.filter(Boolean));

    const doublePrefixes = [];
    for (const v of variants) {
      for (const u of variants) {
        if (!v || !u) continue;
        doublePrefixes.push(`${v}${u}`);
      }
    }

    const scanPatterns = Array.from(new Set(doublePrefixes)).map(dp => `${dp}*`);
    let cursor = '0';
    let migrated = 0;
    let cleaned = 0;
    const MIGRATION_LIMIT = 500; // safety cap
    const seenKeys = new Set();

    // Use a raw client without keyPrefix to avoid re-prefixing returned keys.
    // Enable lazyConnect so calling .connect() doesn't throw "already connecting/connected".
    const migrationClient = await this._getMigrationClient('[RedisStorage] Double-prefix migration skipped: could not open raw client:');
    if (!migrationClient) return;

    try {
      for (const scanPattern of scanPatterns) {
        cursor = '0';
        do {
          const [newCursor, keys] = await migrationClient.scan(cursor, 'MATCH', scanPattern, 'COUNT', 100);
          cursor = newCursor;

          for (const key of keys) {
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);

            if (migrated >= MIGRATION_LIMIT) {
              cursor = '0'; // break outer loop
              break;
            }

            // Only replace the leading double prefix to avoid mangling keys that include it elsewhere
            const matchedPrefix = doublePrefixes.find(dp => key.startsWith(dp)) || '';
            const fixedKey = matchedPrefix
              ? `${targetPrefix}${key.slice(matchedPrefix.length)}`
              : key;

            if (fixedKey === key) continue; // Nothing to fix

            try {
              const exists = await migrationClient.exists(fixedKey);
              if (exists) {
                // The single-prefix key already exists; remove the unusable double-prefixed duplicate to prevent repeated warnings.
                await migrationClient.del(key);
                cleaned++;
              } else {
                await migrationClient.rename(key, fixedKey);
                migrated++;
              }
            } catch (err) {
              log.error(() => [`[RedisStorage] Failed to migrate key ${key} -> ${fixedKey}:`, err.message]);
            }
          }
        } while (cursor !== '0');
      }

      if (migrated > 0 || cleaned > 0) {
        log.warn(() => `[RedisStorage] Migrated ${migrated} double-prefixed Redis key(s) and removed ${cleaned} duplicate(s) with existing targets`);
      }
    } catch (err) {
      log.error(() => ['[RedisStorage] Double-prefix migration failed:', err.message]);
    } finally {
      await this._closeMigrationClient();
    }
  }

  /**
   * Migrate single-prefixed keys from alternate prefixes (colon vs non-colon, custom variants)
   * so mixed deployments converge to this instance's prefix.
   * @private
   */
  async _migrateCrossPrefixKeys() {
    const targetPrefix = this.options.keyPrefix || '';
    if (!targetPrefix) return;

    const variants = this.prefixVariants;
    const altPrefixes = variants.filter(p => p && p !== targetPrefix);
    if (altPrefixes.length === 0) return;

    const migrationClient = await this._getMigrationClient('[RedisStorage] Cross-prefix migration skipped: could not open raw client:');
    if (!migrationClient) return;

    let migrated = 0;
    let cleaned = 0;
    const MIGRATION_LIMIT = 500;
    const seenKeys = new Set();

    try {
      for (const altPrefix of altPrefixes) {
        let cursor = '0';
        const scanPattern = `${altPrefix}*`;
        do {
          const [newCursor, keys] = await migrationClient.scan(cursor, 'MATCH', scanPattern, 'COUNT', 100);
          cursor = newCursor;

          for (const key of keys) {
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);

            if (migrated >= MIGRATION_LIMIT) {
              cursor = '0';
              break;
            }

            if (!key.startsWith(altPrefix)) continue;
            const fixedKey = `${targetPrefix}${key.slice(altPrefix.length)}`;
            if (fixedKey === key) continue;

            try {
              const exists = await migrationClient.exists(fixedKey);
              if (exists) {
                await migrationClient.del(key);
                cleaned++;
              } else {
                await migrationClient.rename(key, fixedKey);
                migrated++;
              }
            } catch (err) {
              log.error(() => [`[RedisStorage] Failed to migrate key ${key} -> ${fixedKey}:`, err.message]);
            }
          }
        } while (cursor !== '0');
      }

      if (migrated > 0 || cleaned > 0) {
        log.warn(() => `[RedisStorage] Migrated ${migrated} cross-prefix Redis key(s) and removed ${cleaned} duplicate(s) with existing targets`);
      }
    } catch (err) {
      log.error(() => ['[RedisStorage] Cross-prefix migration failed:', err.message]);
    } finally {
      await this._closeMigrationClient();
    }
  }

  /**
   * Get or create a raw migration client (no keyPrefix) with lazy connect
   * @private
   */
  async _getMigrationClient(errorPrefix) {
    if (this.migrationClient) {
      return this.migrationClient;
    }

    const migrationClient = this.client.duplicate({ keyPrefix: '', lazyConnect: true });

    try {
      if (migrationClient.status === 'wait') {
        await migrationClient.connect();
      } else if (migrationClient.status !== 'ready') {
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            migrationClient.removeListener('ready', onReady);
            migrationClient.removeListener('error', onError);
          };
          const onReady = () => {
            cleanup();
            resolve();
          };
          const onError = (err) => {
            cleanup();
            reject(err);
          };

          migrationClient.once('ready', onReady);
          migrationClient.once('error', onError);
          setTimeout(() => onError(new Error('Redis migration client ready timeout')), 10000);
        });
      }
      this.migrationClient = migrationClient;
      return migrationClient;
    } catch (err) {
      log.error(() => [errorPrefix, err.message]);
      return null;
    }
  }

  /**
   * Close migration client if created
   * @private
   */
  async _closeMigrationClient() {
    if (this.migrationClient) {
      try {
        await this.migrationClient.disconnect();
      } catch (_) {
        // ignore
      }
      this.migrationClient = null;
    }
  }

  /**
   * Get a value from Redis
   */
  async get(key, cacheType) {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    try {
      const redisKey = this._getKey(key, cacheType);
      const content = await this.client.get(redisKey);

      if (!content) {
        return null;
      }

      // Update LRU timestamp
      const now = Date.now();
      await this.client.zadd(this._getLruKey(cacheType), now, key);

      // Parse JSON if it's a JSON string
      try {
        return JSON.parse(content);
      } catch {
        return content;
      }
    } catch (error) {
      log.error(() => `Redis get error for key ${key}:`, error);
      return null;
    }
  }

  /**
   * Set a value in Redis
   */
  async set(key, value, cacheType, ttl = null) {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    try {
      const redisKey = this._getKey(key, cacheType);
      const metaKey = this._getMetadataKey(key, cacheType);
      const lruKey = this._getLruKey(cacheType);
      const sizeKey = this._getSizeKey(cacheType);

      // Serialize value
      const content = typeof value === 'string' ? value : JSON.stringify(value);
      const contentSize = Buffer.byteLength(content, 'utf8');

      // Check if we need to enforce size limits
      const sizeLimit = StorageAdapter.SIZE_LIMITS[cacheType];
      if (sizeLimit) {
        const currentSize = parseInt(await this.client.get(sizeKey) || '0', 10);

        // If adding this entry would exceed the limit, clean up old entries
        if (currentSize + contentSize > sizeLimit) {
          await this._enforceLimit(cacheType, contentSize);
        }
      }

      // Get existing entry size/createdAt if updating
      const existingMeta = await this.client.hgetall(metaKey);
      const oldSize = existingMeta.size ? parseInt(existingMeta.size, 10) : 0;
      const preservedCreatedAt = existingMeta.createdAt ? parseInt(existingMeta.createdAt, 10) : null;

      // Use a pipeline for atomic operations
      const pipeline = this.client.pipeline();

      // Store the content
      if (ttl !== null) {
        pipeline.setex(redisKey, ttl, content);
      } else {
        pipeline.set(redisKey, content);
      }

      // Store metadata
      const now = Date.now();
      const expiresAt = ttl ? now + (ttl * 1000) : null;
      pipeline.hmset(metaKey, {
        size: contentSize,
        createdAt: preservedCreatedAt || now,
        expiresAt: expiresAt || 'null'
      });

      if (ttl !== null) {
        pipeline.expire(metaKey, ttl);
      }

      // Update LRU tracking
      pipeline.zadd(lruKey, now, key);

      // Update total size counter
      if (sizeLimit) {
        const sizeDelta = contentSize - oldSize;
        if (sizeDelta > 0) {
          pipeline.incrby(sizeKey, sizeDelta);
        } else if (sizeDelta < 0) {
          pipeline.decrby(sizeKey, Math.abs(sizeDelta));
        }
      }

      await pipeline.exec();
      return true;
    } catch (error) {
      log.error(() => `Redis set error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Delete a value from Redis
   */
  async delete(key, cacheType) {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    try {
      const redisKey = this._getKey(key, cacheType);
      const metaKey = this._getMetadataKey(key, cacheType);
      const lruKey = this._getLruKey(cacheType);
      const sizeKey = this._getSizeKey(cacheType);

      // Get size before deleting
      const meta = await this.client.hgetall(metaKey);
      const size = meta.size ? parseInt(meta.size, 10) : 0;

      // Delete using pipeline
      const pipeline = this.client.pipeline();
      pipeline.del(redisKey);
      pipeline.del(metaKey);
      pipeline.zrem(lruKey, key);

      if (size > 0) {
        pipeline.decrby(sizeKey, size);
      }

      await pipeline.exec();
      return true;
    } catch (error) {
      log.error(() => `Redis delete error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Check if a key exists
   */
  async exists(key, cacheType) {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    try {
      const redisKey = this._getKey(key, cacheType);
      const exists = await this.client.exists(redisKey);
      return exists === 1;
    } catch (error) {
      log.error(() => `Redis exists error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * List keys matching a pattern
   */
  async list(cacheType, pattern = '*') {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    try {
      // Use SCAN for better performance with large datasets
      const keys = [];
      const scanPattern = `${this.options.keyPrefix}${cacheType}:${pattern}`;
      let cursor = '0';

      do {
        const result = await this.client.scan(cursor, 'MATCH', scanPattern, 'COUNT', 100);
        cursor = result[0];
        const foundKeys = result[1];

        // Strip prefix and cache type from keys
        const prefix = `${this.options.keyPrefix}${cacheType}:`;
        for (const key of foundKeys) {
          if (key.endsWith(':meta')) continue; // Skip metadata keys
          keys.push(key.substring(prefix.length));
        }
      } while (cursor !== '0');

      return keys;
    } catch (error) {
      log.error(() => `Redis list error for cache type ${cacheType}:`, error);
      return [];
    }
  }

  /**
   * Get the total size of a cache type
   */
  async size(cacheType) {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    try {
      const sizeKey = this._getSizeKey(cacheType);
      const size = await this.client.get(sizeKey);
      return size ? parseInt(size, 10) : 0;
    } catch (error) {
      log.error(() => `Redis size error for cache type ${cacheType}:`, error);
      return 0;
    }
  }

  /**
   * Get metadata about a cached entry
   */
  async metadata(key, cacheType) {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    try {
      const metaKey = this._getMetadataKey(key, cacheType);
      const meta = await this.client.hgetall(metaKey);

      if (!meta || Object.keys(meta).length === 0) {
        return null;
      }

      return {
        size: parseInt(meta.size || '0', 10),
        createdAt: parseInt(meta.createdAt || '0', 10),
        expiresAt: meta.expiresAt === 'null' ? null : parseInt(meta.expiresAt, 10)
      };
    } catch (error) {
      log.error(() => `Redis metadata error for key ${key}:`, error);
      return null;
    }
  }

  /**
   * Enforce size limit by evicting oldest entries (LRU)
   * @private
   */
  async _enforceLimit(cacheType, requiredSpace = 0) {
    const sizeLimit = StorageAdapter.SIZE_LIMITS[cacheType];
    if (!sizeLimit) {
      return { deleted: 0, bytesFreed: 0 };
    }

    try {
      const currentSize = await this.size(cacheType);
      const targetSize = Math.floor(sizeLimit * 0.8); // Free up to 80% of limit

      let needToFree = (currentSize + requiredSpace) - targetSize;
      if (needToFree <= 0) {
        return { deleted: 0, bytesFreed: 0 };
      }

      // Get oldest entries from LRU sorted set
      const lruKey = this._getLruKey(cacheType);
      let deleted = 0;
      let bytesFreed = 0;
      let offset = 0;

      while (needToFree > 0) {
        // Get batch of 100 oldest entries
        const oldestKeys = await this.client.zrange(lruKey, offset, offset + 99);

        if (oldestKeys.length === 0) {
          break; // No more entries to delete
        }

        for (const key of oldestKeys) {
          const meta = await this.metadata(key, cacheType);
          if (meta) {
            await this.delete(key, cacheType);
            deleted++;
            bytesFreed += meta.size;
            needToFree -= meta.size;

            if (needToFree <= 0) {
              break;
            }
          }
        }

        offset += 100;
      }

      log.debug(() => `Enforced ${cacheType} cache limit: deleted ${deleted} entries, freed ${bytesFreed} bytes`);
      return { deleted, bytesFreed };
    } catch (error) {
      log.error(() => `Redis enforce limit error for cache type ${cacheType}:`, error);
      return { deleted: 0, bytesFreed: 0 };
    }
  }

  /**
   * Clean up expired entries
   */
  async cleanup(cacheType) {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    try {
      // Redis automatically handles TTL expiration, but we need to clean up orphaned metadata
      // and enforce size limits

      let deleted = 0;
      let bytesFreed = 0;

      // Get all keys for this cache type
      const keys = await this.list(cacheType);

      for (const key of keys) {
        const redisKey = this._getKey(key, cacheType);
        const exists = await this.client.exists(redisKey);

        // If the main key doesn't exist but metadata does, clean up metadata
        if (!exists) {
          const meta = await this.metadata(key, cacheType);
          if (meta) {
            bytesFreed += meta.size;
            await this.delete(key, cacheType);
            deleted++;
          }
        }
      }

      // Enforce size limits
      const limitResult = await this._enforceLimit(cacheType);
      deleted += limitResult.deleted;
      bytesFreed += limitResult.bytesFreed;

      return { deleted, bytesFreed };
    } catch (error) {
      log.error(() => `Redis cleanup error for cache type ${cacheType}:`, error);
      return { deleted: 0, bytesFreed: 0 };
    }
  }

  /**
   * Close the Redis connection
   */
  async close() {
    if (this.client) {
      await this.client.quit();
      this.initialized = false;
      log.debug(() => 'Redis storage adapter closed');
    }
  }

  /**
   * Health check
   */
  async healthCheck() {
    if (!this.initialized) {
      return false;
    }

    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      log.error(() => 'Redis health check failed:', error);
      return false;
    }
  }
}

module.exports = RedisStorageAdapter;
