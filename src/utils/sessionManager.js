const { LRUCache } = require('lru-cache');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { StorageFactory, StorageAdapter } = require('../storage');
const log = require('./logger');
const { shutdownLogger } = require('./logger');
const { encryptUserConfig, decryptUserConfig } = require('./encryption');

// Storage adapter (lazy loaded)
let storageAdapter = null;
async function getStorageAdapter() {
  if (!storageAdapter) {
    storageAdapter = await StorageFactory.getStorageAdapter();
  }
  return storageAdapter;
}

/**
 * Session Manager with LRU cache and disk persistence
 * Handles user configuration sessions without requiring a database
 */
class SessionManager {
    constructor(options = {}) {
        // If maxSessions is not provided or invalid, leave cache unbounded by count
        this.maxSessions = (Number.isFinite(options.maxSessions) && options.maxSessions > 0)
            ? options.maxSessions
            : null;
        this.maxAge = options.maxAge || 90 * 24 * 60 * 60 * 1000; // 90 days (3 months) default
        this.persistencePath = options.persistencePath || path.join(process.cwd(), 'data', 'sessions.json');
        this.autoSaveInterval = options.autoSaveInterval || 5 * 60 * 1000; // 5 minutes
        this.shutdownTimeout = options.shutdownTimeout || 10 * 1000; // 10 seconds for shutdown save

        // Ensure data directory exists
        this.ensureDataDir();

        // Initialize LRU cache (no max count by default)
        const cacheOptions = {
            ttl: this.maxAge,
            updateAgeOnGet: true, // Refresh TTL on access (sliding expiration)
            updateAgeOnHas: false,
            // Dispose callback for cleanup
            dispose: (value, key) => {
                log.debug(() => `[SessionManager] Session expired: ${key}`);
            }
        };
        if (this.maxSessions) {
            cacheOptions.max = this.maxSessions;
        }
        this.cache = new LRUCache(cacheOptions);

        // Auto-save timer
        this.saveTimer = null;

        // Memory cleanup timer (for preventing memory leaks)
        this.cleanupTimer = null;

        // Track if we've made changes since last save
        this.dirty = false;

        // Track consecutive save failures for alerting
        this.consecutiveSaveFailures = 0;

        // Readiness flag - ensures sessions are loaded before handling requests
        this.isReady = false;
        this.loadingPromise = null;

        // Load sessions from disk on startup (NOW AWAITED PROPERLY)
        this.loadingPromise = this._initializeSessions();

        // Start auto-save interval
        this.startAutoSave();

        // Start memory cleanup interval (runs less frequently)
        this.startMemoryCleanup();
    }

    /**
     * Initialize sessions - loads from disk
     * This MUST be awaited before using the session manager
     * @private
     * @returns {Promise<void>}
     */
    async _initializeSessions() {
        try {
            await this.loadFromDisk();
            this.isReady = true;
            log.debug(() => '[SessionManager] Ready to accept requests');
        } catch (err) {
            log.error(() => ['[SessionManager] Failed to load sessions from disk during init:', err.message]);
            // Mark as ready anyway to prevent blocking startup, but log the error
            this.isReady = true;
        }
    }

    /**
     * Wait for session manager to be ready
     * Call this before any session operations in production
     * @returns {Promise<void>}
     */
    async waitUntilReady() {
        if (this.isReady) {
            return;
        }
        if (this.loadingPromise) {
            await this.loadingPromise;
        }
    }

    /**
     * Ensure data directory exists
     */
    ensureDataDir() {
        try {
            const dir = path.dirname(this.persistencePath);
            if (!require('fs').existsSync(dir)) {
                require('fs').mkdirSync(dir, { recursive: true });
                log.debug(() => `[SessionManager] Created data directory: ${dir}`);
            }
        } catch (err) {
            log.error(() => ['[SessionManager] Failed to create data directory:', err.message]);
        }
    }

    /**
     * Generate a cryptographically secure random session token
     * @returns {string} 32-character hex token
     */
    generateToken() {
        return crypto.randomBytes(16).toString('hex');
    }

    /**
     * Create a new session with user config
     * @param {Object} config - User configuration object
     * @returns {string} Session token
     */
    createSession(config) {
        const token = this.generateToken();

        // Encrypt sensitive fields in config before storing
        const encryptedConfig = encryptUserConfig(config);

        const sessionData = {
            config: encryptedConfig,
            createdAt: Date.now(),
            lastAccessedAt: Date.now()
        };

        this.cache.set(token, sessionData);
        this.dirty = true;

        log.debug(() => `[SessionManager] Session created: ${token} (total: ${this.cache.size})`);
        return token;
    }

    /**
     * Get config from session token
     * @param {string} token - Session token
     * @returns {Object|null} User config or null if not found
     */
    getSession(token) {
        if (!token) return null;

        const sessionData = this.cache.get(token);

        if (!sessionData) {
            return null;
        }

        // Update last accessed time
        sessionData.lastAccessedAt = Date.now();
        this.cache.set(token, sessionData);
        this.dirty = true;

        // Decrypt sensitive fields in config before returning
        const decryptedConfig = decryptUserConfig(sessionData.config);

        return decryptedConfig;
    }

    /**
     * Check if session exists
     * @param {string} token - Session token
     * @returns {boolean}
     */
    hasSession(token) {
        return this.cache.has(token);
    }

    /**
     * Update an existing session with new config
     * @param {string} token - Session token
     * @param {Object} config - New user configuration
     * @returns {boolean} True if updated, false if session not found
     */
    updateSession(token, config) {
        if (!token) return false;

        const sessionData = this.cache.get(token);

        if (!sessionData) {
            log.warn(() => `[SessionManager] Cannot update - session not found: ${token}`);
            return false;
        }

        // Encrypt sensitive fields in config before storing
        const encryptedConfig = encryptUserConfig(config);

        // Update config but keep creation time
        sessionData.config = encryptedConfig;
        sessionData.lastAccessedAt = Date.now();

        this.cache.set(token, sessionData);
        this.dirty = true;

        log.debug(() => `[SessionManager] Session updated: ${token}`);
        return true;
    }

    /**
     * Delete a session
     * @param {string} token - Session token
     * @returns {boolean} True if deleted
     */
    deleteSession(token) {
        const existed = this.cache.delete(token);
        if (existed) {
            this.dirty = true;
            log.debug(() => `[SessionManager] Session deleted: ${token}`);
        }
        return existed;
    }

    /**
     * Get session statistics
     * @returns {Object} Statistics
     */
    getStats() {
            return {
                activeSessions: this.cache.size,
                maxSessions: this.maxSessions || null,
                maxAge: this.maxAge,
                persistencePath: this.persistencePath
            };
        }

    /**
     * Save sessions to storage
     * @returns {Promise<void>}
     */
    async saveToDisk() {
        if (!this.dirty) {
            return; // No changes to save
        }

        try {
            const adapter = await getStorageAdapter();

            // Convert cache to serializable format
            const sessions = {};
            for (const [token, sessionData] of this.cache.entries()) {
                sessions[token] = sessionData;
            }

            const data = {
                version: '1.0',
                savedAt: Date.now(),
                sessions
            };

            const expectedCount = Object.keys(sessions).length;

            // Save to storage
            await adapter.set('sessions', data, StorageAdapter.CACHE_TYPES.SESSION);

            // CRITICAL FIX: Verify save succeeded by reading back the data
            try {
                const verification = await adapter.get('sessions', StorageAdapter.CACHE_TYPES.SESSION);

                if (!verification || !verification.sessions) {
                    throw new Error('Session save verification failed - data not found after save');
                }

                const savedCount = Object.keys(verification.sessions).length;
                if (savedCount !== expectedCount) {
                    throw new Error(`Session count mismatch: saved ${savedCount}, expected ${expectedCount}`);
                }

                log.debug(() => `[SessionManager] Save verified: ${savedCount} sessions persisted successfully`);
            } catch (verifyError) {
                log.error(() => ['[SessionManager] Save verification failed:', verifyError.message]);
                // Don't mark as clean if verification failed
                throw verifyError;
            }

            this.dirty = false;
            this.consecutiveSaveFailures = 0; // Reset on successful save
            log.debug(() => `[SessionManager] Saved ${expectedCount} sessions to storage`);
        } catch (err) {
            log.error(() => ['[SessionManager] Failed to save sessions:', err]);
            throw err;
        }
    }

    /**
     * Load sessions from storage
     * @returns {Promise<void>}
     */
    async loadFromDisk() {
        try {
            const adapter = await getStorageAdapter();
            const data = await adapter.get('sessions', StorageAdapter.CACHE_TYPES.SESSION);

            if (!data || !data.sessions) {
                log.debug(() => '[SessionManager] No sessions in storage');
                return;
            }

            const now = Date.now();
            let loadedCount = 0;
            let expiredCount = 0;
            let migratedCount = 0;
            let invalidTokenCount = 0;

            for (const [token, sessionData] of Object.entries(data.sessions)) {
                // CRITICAL FIX: Validate token format before loading
                // Session tokens must be 32-character hexadecimal strings
                if (!/^[a-f0-9]{32}$/.test(token)) {
                    log.warn(() => `[SessionManager] Skipping invalid token format in storage: ${token.substring(0, 8)}...`);
                    invalidTokenCount++;
                    continue;
                }

                // FIXED: Check expiration using createdAt (absolute TTL) not lastAccessedAt
                // lastAccessedAt should only be used for sliding window within the absolute max
                const absoluteAge = now - sessionData.createdAt;
                if (absoluteAge > this.maxAge) {
                    log.debug(() => `[SessionManager] Session expired (created ${Math.floor(absoluteAge / 1000 / 60)}m ago): ${token}`);
                    expiredCount++;
                    continue;
                }

                // Check if config is already encrypted
                if (!sessionData.config._encrypted) {
                    // Migrate old unencrypted config to encrypted format
                    try {
                        sessionData.config = encryptUserConfig(sessionData.config);
                        migratedCount++;
                    } catch (error) {
                        log.error(() => [`[SessionManager] Failed to encrypt config for token ${token}:`, error.message]);
                        // Keep the unencrypted config to avoid data loss
                    }
                }

                // Restore session to cache (with encrypted config)
                this.cache.set(token, sessionData);
                loadedCount++;
            }

            if (migratedCount > 0) {
                log.debug(() => `[SessionManager] Migrated ${migratedCount} sessions to encrypted format`);
                this.dirty = true; // Mark as dirty to save encrypted versions
            }

            if (invalidTokenCount > 0) {
                log.warn(() => `[SessionManager] Skipped ${invalidTokenCount} sessions with invalid token formats`);
                this.dirty = true; // Mark as dirty to clean up invalid tokens on next save
            }

            log.debug(() => `[SessionManager] Loaded ${loadedCount} sessions from storage (${expiredCount} expired, ${invalidTokenCount} invalid)`);
        } catch (err) {
            if (err.code === 'ENOENT') {
                log.debug(() => '[SessionManager] No existing sessions file found, starting fresh');
            } else {
                log.error(() => ['[SessionManager] Failed to load sessions:', err.message]);
            }
        }
    }

    /**
     * Start auto-save interval
     */
    startAutoSave() {
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
        }

        this.saveTimer = setInterval(async () => {
            if (this.dirty) {
                try {
                    await this.saveToDisk();
                    // consecutiveSaveFailures is reset in saveToDisk on success
                } catch (err) {
                    this.consecutiveSaveFailures++;
                    log.error(() => [`[SessionManager] Auto-save failed (${this.consecutiveSaveFailures} consecutive):`, err.message]);

                    // CRITICAL ALERT: Alert after 5 consecutive failures (25 minutes with 5min interval)
                    if (this.consecutiveSaveFailures >= 5) {
                        log.error(() => `[SessionManager] CRITICAL: ${this.consecutiveSaveFailures} consecutive save failures! Sessions may be lost on restart!`);
                        // This critical error will be visible in logs for monitoring/alerting systems
                    }
                }
            }
        }, this.autoSaveInterval);

        // Don't prevent process from exiting
        this.saveTimer.unref();
    }

    /**
     * Start memory cleanup interval
     * Periodically removes old sessions from memory to prevent unbounded growth
     * Sessions are still preserved in persistent storage and will be loaded on next access
     */
    startMemoryCleanup() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }

        // Run cleanup every hour (less frequent than auto-save)
        const cleanupInterval = 60 * 60 * 1000; // 1 hour

        this.cleanupTimer = setInterval(() => {
            try {
                const now = Date.now();
                const memoryThreshold = 30 * 24 * 60 * 60 * 1000; // 30 days - sessions older than this in memory get evicted
                let evictedCount = 0;
                const initialSize = this.cache.size;

                // Iterate through cache and evict sessions that haven't been accessed in 30 days
                // They remain in persistent storage and will be loaded if accessed again
                for (const [token, sessionData] of this.cache.entries()) {
                    const timeSinceLastAccess = now - sessionData.lastAccessedAt;

                    // If session hasn't been accessed in 30 days, remove from memory
                    if (timeSinceLastAccess > memoryThreshold) {
                        this.cache.delete(token);
                        evictedCount++;
                    }
                }

                if (evictedCount > 0) {
                    log.info(() => `[SessionManager] Memory cleanup: evicted ${evictedCount} old sessions from memory (${initialSize} → ${this.cache.size})`);
                    log.debug(() => '[SessionManager] Evicted sessions remain in persistent storage and will reload if accessed');
                }
            } catch (err) {
                log.error(() => ['[SessionManager] Memory cleanup failed:', err.message]);
            }
        }, cleanupInterval);

        // Don't prevent process from exiting
        this.cleanupTimer.unref();
    }

    /**
     * Setup graceful shutdown handlers
     * @param {http.Server} server - Express server instance to close
     */
    setupShutdownHandlers(server) {
        let isShuttingDown = false; // Prevent multiple shutdown attempts

        const shutdown = async (signal) => {
            // Prevent multiple shutdown attempts
            if (isShuttingDown) {
                log.warn(() => `[SessionManager] Shutdown already in progress, ignoring ${signal}`);
                return;
            }
            isShuttingDown = true;

            log.warn(() => `[SessionManager] Received ${signal}, saving sessions...`);

            // Clear the auto-save timer
            if (this.saveTimer) {
                clearInterval(this.saveTimer);
                log.warn(() => '[SessionManager] Cleared auto-save timer');
            }

            // Clear the memory cleanup timer
            if (this.cleanupTimer) {
                clearInterval(this.cleanupTimer);
                log.warn(() => '[SessionManager] Cleared memory cleanup timer');
            }

            // Save with generous timeout to prevent data loss
            let saveFailed = false;
            let saveAttempts = 0;
            const maxSaveAttempts = 3;

            while (saveAttempts < maxSaveAttempts && !saveFailed) {
                try {
                    saveAttempts++;
                    // Use configurable timeout (default 10 seconds)
                    const savePromise = this.saveToDisk();
                    const timeoutPromise = new Promise((_, reject) => {
                        setTimeout(() => reject(new Error(`Save operation timed out after ${this.shutdownTimeout}ms`)), this.shutdownTimeout);
                    });

                    await Promise.race([savePromise, timeoutPromise]);
                    log.warn(() => `[SessionManager] Sessions saved successfully (attempt ${saveAttempts}/${maxSaveAttempts})`);
                    saveFailed = false;
                    break; // Success - exit retry loop
                } catch (err) {
                    log.error(() => [`[SessionManager] Save attempt ${saveAttempts}/${maxSaveAttempts} failed:`, err.message]);
                    saveFailed = true;

                    // If we have more attempts, wait a bit before retrying
                    if (saveAttempts < maxSaveAttempts) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
            }

            if (saveFailed && saveAttempts >= maxSaveAttempts) {
                log.error(() => '[SessionManager] All save attempts failed during shutdown - sessions may be lost');
            }

            // Close the server if provided
            if (server) {
                server.close(() => {
                    log.warn(() => '[SessionManager] Server closed gracefully');
                    // Close logger before exit
                    shutdownLogger();
                    process.exit(saveFailed ? 1 : 0);
                });

                // Force exit after 5 seconds if server close hangs
                const forceExitTimeout = setTimeout(() => {
                    log.warn(() => '[SessionManager] Forcefully exiting after server close timeout');
                    // Close logger before exit
                    shutdownLogger();
                    process.exit(saveFailed ? 1 : 0);
                }, 5000);
                forceExitTimeout.unref(); // unref to allow process to exit naturally if server closes faster
            } else {
                // Close logger before exit
                shutdownLogger();
                process.exit(saveFailed ? 1 : 0);
            }
        };

        // Handle SIGTERM (kill command)
        process.on('SIGTERM', () => shutdown('SIGTERM'));

        // Handle SIGINT (Ctrl+C)
        process.on('SIGINT', () => shutdown('SIGINT'));

        // Handle uncaught exceptions to save before crash
        process.on('uncaughtException', (err) => {
            log.error(() => ['[SessionManager] Uncaught exception:', err]);
            if (!isShuttingDown) {
                shutdown('uncaughtException').then(() => {
                    shutdownLogger();
                    process.exit(1);
                }).catch(() => {
                    shutdownLogger();
                    process.exit(1);
                });
            }
        });
    }

    /**
     * Clear all sessions (for testing/admin use)
     */
    async clearAll() {
        this.cache.clear();
        this.dirty = true;
        await this.saveToDisk();
        log.debug(() => '[SessionManager] All sessions cleared');
    }
}

// Singleton instance
let instance = null;

/**
 * Get or create SessionManager instance
 * @param {Object} options - Configuration options
 * @returns {SessionManager}
 */
function getSessionManager(options = {}) {
    if (!instance) {
        instance = new SessionManager(options);
    }
    return instance;
}

module.exports = {
    SessionManager,
    getSessionManager
};
