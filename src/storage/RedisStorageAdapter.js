const log = require('../utils/logger');
const StorageAdapter = require('./StorageAdapter');
const Redis = require('ioredis');

/**
 * Redis Storage Adapter
 *
 * Stores all cache data in Redis with support for:
 * - TTL-based expiration
 * - LRU eviction based on size limits
 * - Atomic operations
 * - High availability and horizontal scaling
 */
class RedisStorageAdapter extends StorageAdapter {
  constructor(options = {}) {
    super();

    this.options = {
      host: options.host || process.env.REDIS_HOST || 'localhost',
      port: options.port || process.env.REDIS_PORT || 6379,
      password: options.password || process.env.REDIS_PASSWORD || undefined,
      db: options.db || process.env.REDIS_DB || 0,
      keyPrefix: options.keyPrefix || 'stremio:',
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      ...options
    };

    this.client = null;
    this.initialized = false;
  }

  /**
   * Get the full Redis key for a cache entry
   * @private
   */
  _getKey(key, cacheType) {
    return `${this.options.keyPrefix}${cacheType}:${key}`;
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
    return `${this.options.keyPrefix}lru:${cacheType}`;
  }

  /**
   * Get the total size counter key for a cache type
   * @private
   */
  _getSizeKey(cacheType) {
    return `${this.options.keyPrefix}size:${cacheType}`;
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

      // Get existing entry size if updating
      const existingMeta = await this.client.hgetall(metaKey);
      const oldSize = existingMeta.size ? parseInt(existingMeta.size, 10) : 0;

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
        createdAt: now,
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
