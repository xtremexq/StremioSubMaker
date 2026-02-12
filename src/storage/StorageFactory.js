const log = require('../utils/logger');
const StorageAdapter = require('./StorageAdapter');
const FilesystemStorageAdapter = require('./FilesystemStorageAdapter');
const RedisStorageAdapter = require('./RedisStorageAdapter');
const { getRedisPassword } = require('../utils/redisHelper');

/**
 * Storage Factory
 *
 * Creates the appropriate storage adapter based on environment configuration.
 * Falls back to filesystem storage if Redis is not configured.
 */
class StorageFactory {
  static instance = null;
  static initializationPromise = null; // FIX: Prevent concurrent initializations

  /**
   * Get or create the storage adapter instance (singleton)
   * @returns {Promise<StorageAdapter>}
   */
  static async getStorageAdapter() {
    // FIXED: If already initialized, return immediately
    if (StorageFactory.instance) {
      return StorageFactory.instance;
    }

    // FIXED: If initialization is in progress, wait for it to complete
    if (StorageFactory.initializationPromise) {
      return StorageFactory.initializationPromise;
    }

    // FIXED: Mark initialization as in progress
    StorageFactory.initializationPromise = StorageFactory._initializeAdapter();

    try {
      const adapter = await StorageFactory.initializationPromise;
      return adapter;
    } finally {
      // Clear the pending promise after completion
      StorageFactory.initializationPromise = null;
    }
  }

  /**
   * Internal initialization logic
   * @private
   * @returns {Promise<StorageAdapter>}
   */
  static async _initializeAdapter() {
    const storageType = process.env.STORAGE_TYPE || 'redis';

    let adapter;

    if (storageType === 'redis') {
      log.debug(() => 'Initializing Redis storage adapter...');
      adapter = new RedisStorageAdapter({
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : undefined,
        password: getRedisPassword() || undefined,
        db: process.env.REDIS_DB ? parseInt(process.env.REDIS_DB, 10) : undefined,
        keyPrefix: process.env.REDIS_KEY_PREFIX
      });
    } else {
      log.debug(() => 'Initializing Filesystem storage adapter...');
      adapter = new FilesystemStorageAdapter();
    }

    try {
      await adapter.initialize();
      StorageFactory.instance = adapter;

      // Schedule periodic cleanup
      StorageFactory._scheduleCleanup(adapter);

      log.debug(() => `[StorageFactory] Storage adapter initialized successfully (type: ${storageType})`);
      return adapter;
    } catch (error) {
      // In Redis mode, do not silently fall back to the filesystem. Doing so stores
      // sessions on the ephemeral container filesystem, which are lost on the next
      // restart and surface as "session token not found" errors even though the
      // user previously saved their config. Crash early so operators fix Redis or
      // the connection details instead of losing sessions.
      if (storageType === 'redis') {
        log.error(() => ['[StorageFactory] Redis storage initialization failed:', error.message]);
        throw error;
      }

      // For non-Redis deployments, keep the existing filesystem fallback behaviour
      log.warn(() => 'Redis storage initialization failed, falling back to filesystem storage...');
      adapter = new FilesystemStorageAdapter();
      try {
        await adapter.initialize();
        StorageFactory.instance = adapter;
        StorageFactory._scheduleCleanup(adapter);
        log.debug(() => '[StorageFactory] Fallback to filesystem storage successful');
        return adapter;
      } catch (fallbackError) {
        log.error(() => ['[StorageFactory] Filesystem fallback also failed:', fallbackError.message]);
        throw fallbackError;
      }
    }
  }

  /**
   * Schedule periodic cleanup for all cache types
   * @private
   */
  static _scheduleCleanup(adapter) {
    // Cleanup bypass cache every 30 minutes
    setInterval(async () => {
      try {
        await adapter.cleanup(StorageAdapter.CACHE_TYPES.BYPASS);
      } catch (error) {
        log.error(() => '[Cleanup] Failed to cleanup bypass cache:', error);
      }
    }, 30 * 60 * 1000);

    // Cleanup partial cache every hour
    setInterval(async () => {
      try {
        await adapter.cleanup(StorageAdapter.CACHE_TYPES.PARTIAL);
      } catch (error) {
        log.error(() => '[Cleanup] Failed to cleanup partial cache:', error);
      }
    }, 60 * 60 * 1000);

    // Cleanup translation cache every 10 minutes (for size enforcement)
    setInterval(async () => {
      try {
        await adapter.cleanup(StorageAdapter.CACHE_TYPES.TRANSLATION);
      } catch (error) {
        log.error(() => '[Cleanup] Failed to cleanup translation cache:', error);
      }
    }, 10 * 60 * 1000);

    // Cleanup sync cache every hour
    setInterval(async () => {
      try {
        await adapter.cleanup(StorageAdapter.CACHE_TYPES.SYNC);
      } catch (error) {
        log.error(() => '[Cleanup] Failed to cleanup sync cache:', error);
      }
    }, 60 * 60 * 1000);

    // Cleanup embedded cache every hour
    setInterval(async () => {
      try {
        await adapter.cleanup(StorageAdapter.CACHE_TYPES.EMBEDDED);
      } catch (error) {
        log.error(() => '[Cleanup] Failed to cleanup embedded cache:', error);
      }
    }, 60 * 60 * 1000);

    // Cleanup provider metadata cache every 6 hours (7-day TTL, low churn)
    setInterval(async () => {
      try {
        await adapter.cleanup(StorageAdapter.CACHE_TYPES.PROVIDER_METADATA);
      } catch (error) {
        log.error(() => '[Cleanup] Failed to cleanup provider metadata cache:', error);
      }
    }, 6 * 60 * 60 * 1000);

    log.debug(() => 'Scheduled periodic cache cleanup tasks');
  }

  /**
   * Get the underlying Redis client (if using RedisStorageAdapter).
   * Returns null for filesystem deployments.
   * @returns {import('ioredis')|null}
   */
  static getRedisClient() {
    if (StorageFactory.instance && typeof StorageFactory.instance.getClient === 'function') {
      return StorageFactory.instance.getClient();
    }
    return null;
  }

  /**
   * Reset the singleton instance (useful for testing)
   */
  static async reset() {
    if (StorageFactory.instance) {
      await StorageFactory.instance.close();
      StorageFactory.instance = null;
    }
  }

  /**
   * Check if storage is healthy
   */
  static async healthCheck() {
    if (!StorageFactory.instance) {
      return false;
    }

    return StorageFactory.instance.healthCheck();
  }
}

module.exports = StorageFactory;
