const log = require('../utils/logger');
const StorageAdapter = require('./StorageAdapter');
const FilesystemStorageAdapter = require('./FilesystemStorageAdapter');
const RedisStorageAdapter = require('./RedisStorageAdapter');

/**
 * Storage Factory
 *
 * Creates the appropriate storage adapter based on environment configuration.
 * Falls back to filesystem storage if Redis is not configured.
 */
class StorageFactory {
  static instance = null;

  /**
   * Get or create the storage adapter instance (singleton)
   * @returns {Promise<StorageAdapter>}
   */
  static async getStorageAdapter() {
    if (StorageFactory.instance) {
      return StorageFactory.instance;
    }

    const storageType = process.env.STORAGE_TYPE || 'filesystem';

    let adapter;

    if (storageType === 'redis') {
      log.debug(() => 'Initializing Redis storage adapter...');
      adapter = new RedisStorageAdapter({
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : undefined,
        password: process.env.REDIS_PASSWORD,
        db: process.env.REDIS_DB ? parseInt(process.env.REDIS_DB, 10) : undefined,
        keyPrefix: process.env.REDIS_KEY_PREFIX || 'stremio:'
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

      return adapter;
    } catch (error) {
      // If Redis fails, fall back to filesystem
      if (storageType === 'redis') {
        log.debug(() => 'Falling back to filesystem storage...');
        adapter = new FilesystemStorageAdapter();
        await adapter.initialize();
        StorageFactory.instance = adapter;

        StorageFactory._scheduleCleanup(adapter);

        return adapter;
      }

      log.error(() => 'Failed to initialize storage adapter:', error);
      throw error;
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

    log.debug(() => 'Scheduled periodic cache cleanup tasks');
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
