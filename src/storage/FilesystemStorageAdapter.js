const log = require('../utils/logger');
const StorageAdapter = require('./StorageAdapter');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Filesystem Storage Adapter
 *
 * Stores all cache data on the local filesystem.
 * This is the default storage adapter and maintains backwards compatibility.
 */
class FilesystemStorageAdapter extends StorageAdapter {
  constructor(options = {}) {
    super();

    this.baseDir = options.baseDir || path.join(process.cwd(), '.cache');

    // Cache directories for each type
    this.directories = {
      [StorageAdapter.CACHE_TYPES.TRANSLATION]: path.join(this.baseDir, 'translations'),
      [StorageAdapter.CACHE_TYPES.BYPASS]: path.join(this.baseDir, 'translations_bypass'),
      [StorageAdapter.CACHE_TYPES.PARTIAL]: path.join(this.baseDir, 'translations_partial'),
      [StorageAdapter.CACHE_TYPES.SYNC]: path.join(this.baseDir, 'sync_cache'),
      [StorageAdapter.CACHE_TYPES.SESSION]: path.join(process.cwd(), 'data')
    };

    this.initialized = false;

    // Track cache sizes in memory for better performance
    this.cacheSizes = {};
  }

  /**
   * Sanitize cache key to prevent path traversal attacks
   * @private
   */
  _sanitizeKey(key) {
    let sanitized = key.replace(/\.\./g, '');
    sanitized = sanitized.replace(/[/\\]/g, '_');
    sanitized = sanitized.replace(/[^a-zA-Z0-9_-]/g, '_');

    if (sanitized.length > 200) {
      const hash = crypto.createHash('sha256').update(key).digest('hex');
      sanitized = sanitized.substring(0, 150) + '_' + hash.substring(0, 16);
    }

    return sanitized;
  }

  /**
   * Get the file path for a cache entry
   * @private
   */
  _getFilePath(key, cacheType) {
    const dir = this.directories[cacheType];
    const safeKey = this._sanitizeKey(key);

    // Special handling for session type
    if (cacheType === StorageAdapter.CACHE_TYPES.SESSION) {
      return path.join(dir, `${safeKey}.json`);
    }

    return path.join(dir, `${safeKey}.json`);
  }

  /**
   * Verify path is within the allowed directory (security check)
   * @private
   */
  _verifyPath(filePath, cacheType) {
    const resolvedPath = path.resolve(filePath);
    const resolvedDir = path.resolve(this.directories[cacheType]);
    return resolvedPath.startsWith(resolvedDir);
  }

  /**
   * Calculate directory size
   * @private
   */
  _calculateDirectorySize(dir) {
    if (!fs.existsSync(dir)) {
      return 0;
    }

    let totalSize = 0;
    const files = fs.readdirSync(dir);

    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stats = fs.statSync(filePath);
        if (stats.isFile()) {
          totalSize += stats.size;
        }
      } catch (error) {
        // Skip files that can't be accessed
      }
    }

    return totalSize;
  }

  /**
   * Initialize the filesystem storage
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    try {
      // Create all cache directories
      for (const [cacheType, dir] of Object.entries(this.directories)) {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        // Calculate initial cache sizes
        this.cacheSizes[cacheType] = this._calculateDirectorySize(dir);
      }

      this.initialized = true;
      log.debug(() => 'Filesystem storage adapter initialized successfully');
    } catch (error) {
      log.error(() => 'Failed to initialize filesystem storage adapter:', error);
      throw error;
    }
  }

  /**
   * Get a value from filesystem
   */
  async get(key, cacheType) {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    try {
      const filePath = this._getFilePath(key, cacheType);

      if (!this._verifyPath(filePath, cacheType)) {
        log.error(() => `[Filesystem] Security: Path traversal attempt detected for key ${key}`);
        return null;
      }

      if (!fs.existsSync(filePath)) {
        return null;
      }

      const content = fs.readFileSync(filePath, 'utf8');

      // Touch file to update atime for LRU
      try {
        const stats = fs.statSync(filePath);
        fs.utimesSync(filePath, new Date(), stats.mtime);
      } catch (error) {
        // Ignore touch errors
      }

      const data = JSON.parse(content);

      // Check if expired
      if (data.expiresAt && Date.now() > data.expiresAt) {
        fs.unlinkSync(filePath);
        return null;
      }

      // Return the content field if it exists, otherwise return the whole object
      return data.content !== undefined ? data.content : data;
    } catch (error) {
      log.error(() => `[Filesystem] Failed to read key ${key}:`, error.message);
      return null;
    }
  }

  /**
   * Set a value in filesystem
   */
  async set(key, value, cacheType, ttl = null) {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    try {
      const filePath = this._getFilePath(key, cacheType);
      const tempPath = `${filePath}.tmp`;

      if (!this._verifyPath(filePath, cacheType)) {
        log.error(() => `[Filesystem] Security: Path traversal attempt detected for key ${key}`);
        return false;
      }

      // Prepare data to store
      const now = Date.now();
      const expiresAt = ttl ? now + (ttl * 1000) : null;

      const data = {
        key,
        content: value,
        createdAt: now,
        expiresAt
      };

      // Atomic write: write to temp then rename
      try {
        const fd = fs.openSync(tempPath, 'w');
        const jsonData = JSON.stringify(data, null, 2);
        fs.writeSync(fd, jsonData);

        // Ensure data hits disk before rename
        try {
          fs.fsyncSync(fd);
        } catch (error) {
          // Ignore fsync errors on unsupported platforms
        }

        fs.closeSync(fd);
        fs.renameSync(tempPath, filePath);
      } finally {
        // Cleanup stray temp file on failure
        try {
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
        } catch (error) {
          // Ignore cleanup errors
        }
      }

      // Update cache size
      const stats = fs.statSync(filePath);
      this.cacheSizes[cacheType] = (this.cacheSizes[cacheType] || 0) + stats.size;

      // Check if we need to enforce size limits
      const sizeLimit = StorageAdapter.SIZE_LIMITS[cacheType];
      if (sizeLimit && this.cacheSizes[cacheType] > sizeLimit) {
        // Don't await - run cleanup in background
        this._enforceLimit(cacheType).catch(err => {
          log.error(() => `[Filesystem] Background cleanup error:`, err);
        });
      }

      return true;
    } catch (error) {
      log.error(() => `[Filesystem] Failed to set key ${key}:`, error.message);
      return false;
    }
  }

  /**
   * Delete a value from filesystem
   */
  async delete(key, cacheType) {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    try {
      const filePath = this._getFilePath(key, cacheType);

      if (!this._verifyPath(filePath, cacheType)) {
        log.error(() => `[Filesystem] Security: Path traversal attempt detected for key ${key}`);
        return false;
      }

      if (!fs.existsSync(filePath)) {
        return false;
      }

      // Get file size before deleting
      const stats = fs.statSync(filePath);
      fs.unlinkSync(filePath);

      // Update cache size
      this.cacheSizes[cacheType] = Math.max(0, (this.cacheSizes[cacheType] || 0) - stats.size);

      return true;
    } catch (error) {
      log.error(() => `[Filesystem] Failed to delete key ${key}:`, error.message);
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
      const filePath = this._getFilePath(key, cacheType);

      if (!this._verifyPath(filePath, cacheType)) {
        return false;
      }

      return fs.existsSync(filePath);
    } catch (error) {
      log.error(() => `[Filesystem] Failed to check existence of key ${key}:`, error.message);
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
      const dir = this.directories[cacheType];

      if (!fs.existsSync(dir)) {
        return [];
      }

      const files = fs.readdirSync(dir);
      const keys = [];

      for (const file of files) {
        // Skip temp files
        if (file.endsWith('.tmp')) {
          continue;
        }

        // Remove .json extension
        const key = file.replace(/\.json$/, '');

        // Simple pattern matching (only supports * wildcard)
        if (pattern === '*' || this._matchPattern(key, pattern)) {
          keys.push(key);
        }
      }

      return keys;
    } catch (error) {
      log.error(() => `[Filesystem] Failed to list keys for cache type ${cacheType}:`, error.message);
      return [];
    }
  }

  /**
   * Simple pattern matching helper
   * @private
   */
  _matchPattern(str, pattern) {
    // Convert wildcard pattern to regex
    const regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special chars
      .replace(/\*/g, '.*'); // Convert * to .*

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(str);
  }

  /**
   * Get the total size of a cache type
   */
  async size(cacheType) {
    if (!this.initialized) {
      throw new Error('Storage adapter not initialized');
    }

    try {
      // Recalculate to ensure accuracy
      const dir = this.directories[cacheType];
      const actualSize = this._calculateDirectorySize(dir);
      this.cacheSizes[cacheType] = actualSize;
      return actualSize;
    } catch (error) {
      log.error(() => `[Filesystem] Failed to calculate size for cache type ${cacheType}:`, error.message);
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
      const filePath = this._getFilePath(key, cacheType);

      if (!this._verifyPath(filePath, cacheType) || !fs.existsSync(filePath)) {
        return null;
      }

      const stats = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);

      return {
        size: stats.size,
        createdAt: data.createdAt || stats.birthtimeMs,
        expiresAt: data.expiresAt || null
      };
    } catch (error) {
      log.error(() => `[Filesystem] Failed to get metadata for key ${key}:`, error.message);
      return null;
    }
  }

  /**
   * Enforce size limit by evicting oldest entries (LRU)
   * @private
   */
  async _enforceLimit(cacheType) {
    const sizeLimit = StorageAdapter.SIZE_LIMITS[cacheType];
    if (!sizeLimit) {
      return { deleted: 0, bytesFreed: 0 };
    }

    try {
      const currentSize = await this.size(cacheType);
      const targetSize = Math.floor(sizeLimit * 0.8); // Free up to 80% of limit

      if (currentSize <= targetSize) {
        return { deleted: 0, bytesFreed: 0 };
      }

      const dir = this.directories[cacheType];
      const files = fs.readdirSync(dir);

      // Get file stats and sort by access time (oldest first)
      const fileStats = [];
      for (const file of files) {
        if (file.endsWith('.tmp')) continue;

        const filePath = path.join(dir, file);
        try {
          const stats = fs.statSync(filePath);
          fileStats.push({
            path: filePath,
            atime: stats.atimeMs,
            size: stats.size
          });
        } catch (error) {
          // Skip files that can't be accessed
        }
      }

      // Sort by access time (oldest first)
      fileStats.sort((a, b) => a.atime - b.atime);

      // Delete oldest files until we reach target size
      let deleted = 0;
      let bytesFreed = 0;
      let remainingSize = currentSize;

      for (const file of fileStats) {
        if (remainingSize <= targetSize) {
          break;
        }

        try {
          fs.unlinkSync(file.path);
          deleted++;
          bytesFreed += file.size;
          remainingSize -= file.size;
        } catch (error) {
          log.error(() => `[Filesystem] Failed to delete file ${file.path}:`, error.message);
        }
      }

      // Update cache size
      this.cacheSizes[cacheType] = remainingSize;

      log.debug(() => `[Filesystem] Enforced ${cacheType} cache limit: deleted ${deleted} entries, freed ${bytesFreed} bytes`);
      return { deleted, bytesFreed };
    } catch (error) {
      log.error(() => `[Filesystem] Failed to enforce limit for cache type ${cacheType}:`, error.message);
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
      const dir = this.directories[cacheType];

      if (!fs.existsSync(dir)) {
        return { deleted: 0, bytesFreed: 0 };
      }

      const files = fs.readdirSync(dir);
      const now = Date.now();

      let deleted = 0;
      let bytesFreed = 0;

      for (const file of files) {
        if (file.endsWith('.tmp')) continue;

        const filePath = path.join(dir, file);

        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const data = JSON.parse(content);

          // Check if expired
          if (data.expiresAt && now > data.expiresAt) {
            const stats = fs.statSync(filePath);
            fs.unlinkSync(filePath);
            deleted++;
            bytesFreed += stats.size;
          }
        } catch (error) {
          // Skip files that can't be read or parsed
        }
      }

      // Also enforce size limits
      const limitResult = await this._enforceLimit(cacheType);
      deleted += limitResult.deleted;
      bytesFreed += limitResult.bytesFreed;

      if (deleted > 0) {
        log.debug(() => `[Filesystem] Cleaned up ${cacheType}: deleted ${deleted} entries, freed ${bytesFreed} bytes`);
      }

      return { deleted, bytesFreed };
    } catch (error) {
      log.error(() => `[Filesystem] Failed to cleanup cache type ${cacheType}:`, error.message);
      return { deleted: 0, bytesFreed: 0 };
    }
  }

  /**
   * Close the filesystem storage (no-op for filesystem)
   */
  async close() {
    this.initialized = false;
    log.debug(() => 'Filesystem storage adapter closed');
  }

  /**
   * Health check
   */
  async healthCheck() {
    if (!this.initialized) {
      return false;
    }

    try {
      // Check if we can read/write to all directories
      for (const [cacheType, dir] of Object.entries(this.directories)) {
        if (!fs.existsSync(dir)) {
          return false;
        }

        // Try to create a test file
        const testFile = path.join(dir, '.health-check');
        fs.writeFileSync(testFile, 'ok');
        fs.unlinkSync(testFile);
      }

      return true;
    } catch (error) {
      log.error(() => '[Filesystem] Health check failed:', error);
      return false;
    }
  }
}

module.exports = FilesystemStorageAdapter;
