const { LRUCache } = require('lru-cache');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

/**
 * Session Manager with LRU cache and disk persistence
 * Handles user configuration sessions without requiring a database
 */
class SessionManager {
    constructor(options = {}) {
        this.maxSessions = options.maxSessions || 1000;
        this.maxAge = options.maxAge || 90 * 24 * 60 * 60 * 1000; // 90 days (3 months) default
        this.persistencePath = options.persistencePath || path.join(process.cwd(), 'data', 'sessions.json');
        this.autoSaveInterval = options.autoSaveInterval || 5 * 60 * 1000; // 5 minutes

        // Initialize LRU cache
        this.cache = new LRUCache({
            max: this.maxSessions,
            ttl: this.maxAge,
            updateAgeOnGet: true, // Refresh TTL on access (sliding expiration)
            updateAgeOnHas: false,
            // Dispose callback for cleanup
            dispose: (value, key) => {
                console.log(`[SessionManager] Session expired: ${key}`);
            }
        });

        // Auto-save timer
        this.saveTimer = null;

        // Track if we've made changes since last save
        this.dirty = false;

        // Load sessions from disk on startup
        this.loadFromDisk().catch(err => {
            console.error('[SessionManager] Failed to load sessions from disk:', err.message);
        });

        // Start auto-save interval
        this.startAutoSave();

        // Graceful shutdown handler
        this.setupShutdownHandlers();
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
        const sessionData = {
            config,
            createdAt: Date.now(),
            lastAccessedAt: Date.now()
        };

        this.cache.set(token, sessionData);
        this.dirty = true;

        console.log(`[SessionManager] Session created: ${token} (total: ${this.cache.size})`);
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

        return sessionData.config;
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
            console.warn(`[SessionManager] Cannot update - session not found: ${token}`);
            return false;
        }

        // Update config but keep creation time
        sessionData.config = config;
        sessionData.lastAccessedAt = Date.now();

        this.cache.set(token, sessionData);
        this.dirty = true;

        console.log(`[SessionManager] Session updated: ${token}`);
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
            console.log(`[SessionManager] Session deleted: ${token}`);
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
            maxSessions: this.maxSessions,
            maxAge: this.maxAge,
            persistencePath: this.persistencePath
        };
    }

    /**
     * Save sessions to disk
     * @returns {Promise<void>}
     */
    async saveToDisk() {
        if (!this.dirty) {
            return; // No changes to save
        }

        try {
            // Ensure data directory exists
            const dir = path.dirname(this.persistencePath);
            await fs.mkdir(dir, { recursive: true });

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

            // Write atomically (write to temp file, then rename)
            const tempPath = `${this.persistencePath}.tmp`;
            await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
            await fs.rename(tempPath, this.persistencePath);

            // Set restrictive permissions (Unix-like systems only)
            try {
                await fs.chmod(this.persistencePath, 0o600);
            } catch (err) {
                // Ignore on Windows
            }

            this.dirty = false;
            console.log(`[SessionManager] Saved ${Object.keys(sessions).length} sessions to disk`);
        } catch (err) {
            console.error('[SessionManager] Failed to save sessions:', err);
            throw err;
        }
    }

    /**
     * Load sessions from disk
     * @returns {Promise<void>}
     */
    async loadFromDisk() {
        try {
            const fileContent = await fs.readFile(this.persistencePath, 'utf8');
            const data = JSON.parse(fileContent);

            if (!data.sessions) {
                console.log('[SessionManager] No sessions in persistence file');
                return;
            }

            const now = Date.now();
            let loadedCount = 0;
            let expiredCount = 0;

            for (const [token, sessionData] of Object.entries(data.sessions)) {
                // Check if session is expired
                const age = now - sessionData.lastAccessedAt;
                if (age > this.maxAge) {
                    expiredCount++;
                    continue;
                }

                // Restore session to cache
                this.cache.set(token, sessionData);
                loadedCount++;
            }

            console.log(`[SessionManager] Loaded ${loadedCount} sessions from disk (${expiredCount} expired)`);
            this.dirty = false;
        } catch (err) {
            if (err.code === 'ENOENT') {
                console.log('[SessionManager] No existing sessions file found, starting fresh');
            } else {
                console.error('[SessionManager] Failed to load sessions:', err.message);
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
                } catch (err) {
                    console.error('[SessionManager] Auto-save failed:', err);
                }
            }
        }, this.autoSaveInterval);

        // Don't prevent process from exiting
        this.saveTimer.unref();
    }

    /**
     * Setup graceful shutdown handlers
     */
    setupShutdownHandlers() {
        const shutdown = async (signal) => {
            console.log(`[SessionManager] Received ${signal}, saving sessions...`);
            try {
                await this.saveToDisk();
                console.log('[SessionManager] Sessions saved successfully');
            } catch (err) {
                console.error('[SessionManager] Failed to save sessions on shutdown:', err);
            }
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('beforeExit', () => shutdown('beforeExit'));
    }

    /**
     * Clear all sessions (for testing/admin use)
     */
    async clearAll() {
        this.cache.clear();
        this.dirty = true;
        await this.saveToDisk();
        console.log('[SessionManager] All sessions cleared');
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
