const { LRUCache } = require('lru-cache');
const { EventEmitter } = require('events');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const Redis = require('ioredis');
const { StorageFactory, StorageAdapter } = require('../storage');
const log = require('./logger');
const { shutdownLogger } = require('./logger');
const { encryptUserConfig, decryptUserConfig } = require('./encryption');
const { redactToken } = require('./security');

// Cache decrypted configs briefly to avoid redundant decryption on rapid navigation
const DECRYPTED_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Lightweight integrity fingerprint stored alongside each session
// Helps detect cross-session contamination when storage returns an unexpected payload
function computeConfigFingerprint(config) {
  try {
    const serialized = JSON.stringify(config || {});
    return crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 16);
  } catch (err) {
    log.warn(() => ['[SessionManager] Failed to compute config fingerprint:', err?.message || String(err)]);
    return 'fingerprint_error';
  }
}

// Bind sessions to a stable fingerprint of their token so we can detect when a
// payload has been accidentally returned for the wrong token (e.g., due to
// cache prefix collisions or mis-keyed storage writes)
function computeTokenFingerprint(token) {
  try {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16);
  } catch (err) {
    log.warn(() => ['[SessionManager] Failed to compute token fingerprint:', err?.message || String(err)]);
    return 'token_fingerprint_error';
  }
}

// Prevent cache/key collisions from silently serving another user's config by
// binding stored payloads to both the token and the config fingerprint.  If a
// different payload is ever returned for the same token (e.g., due to shared
// Redis keyspace or proxy cache mix-ups), the integrity check will fail and the
// session will be discarded instead of leaking the other user's data.
function computeIntegrityHash(token, fingerprint) {
  try {
    return crypto
      .createHash('sha256')
      .update(String(token || ''))
      .update('|')
      .update(String(fingerprint || ''))
      .digest('hex')
      .slice(0, 24);
  } catch (err) {
    log.warn(() => ['[SessionManager] Failed to compute integrity hash:', err?.message || String(err)]);
    return 'integrity_error';
  }
}

// Safe clone helper to prevent consumers from mutating cached objects
function cloneConfig(config) {
  if (!config || typeof config !== 'object') {
    return config;
  }
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(config);
    }
  } catch (_) {
    // structuredClone not available or failed, fallback below
  }
  try {
    return JSON.parse(JSON.stringify(config));
  } catch (_) {
    return config;
  }
}

// Validate stored session metadata against the requested token to detect cross-user bleed
// Returns a status describing mismatches or missing safety fields
function ensureTokenMetadata(sessionData, token) {
  if (!sessionData) {
    return { status: 'invalid' };
  }

  const expectedTokenFingerprint = computeTokenFingerprint(token);

  if (!sessionData.token) {
    return { status: 'missing_token' };
  }

  if (sessionData.token !== token) {
    return { status: 'mismatch_token', storedToken: sessionData.token };
  }

  if (!sessionData.tokenFingerprint) {
    return { status: 'missing_fingerprint', expectedTokenFingerprint };
  }

  if (sessionData.tokenFingerprint !== expectedTokenFingerprint) {
    return {
      status: 'mismatch_fingerprint',
      storedTokenFingerprint: sessionData.tokenFingerprint,
      expectedTokenFingerprint
    };
  }

  return { status: 'ok' };
}

// Validate that a session payload looks like an encrypted session blob we expect
// rather than an arbitrary object that may have leaked in from another user.
function validateEncryptedSessionPayload(sessionData) {
  if (!sessionData || typeof sessionData !== 'object') {
    return { valid: false, reason: 'not_object' };
  }

  const { config } = sessionData;
  if (!config || typeof config !== 'object') {
    return { valid: false, reason: 'missing_config' };
  }

  if (config._encrypted !== true) {
    return { valid: false, reason: 'unencrypted_config' };
  }

  const hasFingerprint = typeof sessionData.fingerprint === 'string' && sessionData.fingerprint.length > 0;
  const hasIntegrity = typeof sessionData.integrity === 'string' && sessionData.integrity.length > 0;

  return {
    valid: true,
    missingFingerprint: !hasFingerprint,
    missingIntegrity: !hasIntegrity
  };
}

// Storage adapter (lazy loaded)
let storageAdapter = null;
async function getStorageAdapter() {
  if (!storageAdapter) {
    storageAdapter = await StorageFactory.getStorageAdapter();
  }
  return storageAdapter;
}

// Redis pub/sub clients for cross-instance cache invalidation (only in Redis mode)
// Note: Separate clients needed because Redis clients in subscriber mode can only use pub/sub commands
let pubSubClient = null; // For subscribing to channels
let publishClient = null; // For publishing messages (normal mode)

function getPrefixVariants() {
  const configured = process.env.REDIS_KEY_PREFIX || 'stremio';
  const extra = (process.env.REDIS_KEY_PREFIX_VARIANTS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const bases = [configured, ...extra];

  const variants = new Set();
  variants.add(''); // no prefix fallback

  for (const base of bases) {
    const withColon = base.endsWith(':') ? base : `${base}:`;
    const withoutColon = base.endsWith(':') ? base.slice(0, -1) : base;
    variants.add(withColon);
    variants.add(withoutColon);
  }

  return Array.from(variants).filter(Boolean);
}

async function getPubSubClient() {
  const storageType = process.env.STORAGE_TYPE || 'filesystem';
  if (storageType !== 'redis') {
    return null; // Not needed in filesystem mode
  }

  if (pubSubClient) {
    return pubSubClient;
  }

  try {
    pubSubClient = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db: process.env.REDIS_DB ? parseInt(process.env.REDIS_DB, 10) : 0,
      // Use raw channels so we can manually subscribe to both prefixed and unprefixed variants
      keyPrefix: '',
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      }
    });

    // Set up error handlers
    pubSubClient.on('error', (err) => {
      log.error(() => ['[SessionManager] Pub/Sub client error:', err.message]);
    });

    return pubSubClient;
  } catch (err) {
    log.error(() => ['[SessionManager] Failed to create pub/sub client:', err.message]);
    return null;
  }
}

async function getPublishClient() {
  const storageType = process.env.STORAGE_TYPE || 'filesystem';
  if (storageType !== 'redis') {
    return null; // Not needed in filesystem mode
  }

  if (publishClient) {
    return publishClient;
  }

  try {
    publishClient = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db: process.env.REDIS_DB ? parseInt(process.env.REDIS_DB, 10) : 0,
      // Use raw channels so we can manually publish to both prefixed and unprefixed variants
      keyPrefix: '',
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      }
    });

    // Set up error handlers
    publishClient.on('error', (err) => {
      log.error(() => ['[SessionManager] Publish client error:', err.message]);
    });

    return publishClient;
  } catch (err) {
    log.error(() => ['[SessionManager] Failed to create publish client:', err.message]);
    return null;
  }
}

/**
 * Session Manager with LRU cache and disk persistence
 * Handles user configuration sessions without requiring a database
 */
class SessionManager extends EventEmitter {
    constructor(options = {}) {
        super();
        // Generate unique instance ID to prevent self-invalidation in pub/sub
        this.instanceId = crypto.randomBytes(8).toString('hex');

        // If maxSessions is not provided or invalid, leave cache unbounded by count
        this.maxSessions = (Number.isFinite(options.maxSessions) && options.maxSessions > 0)
            ? options.maxSessions
            : null;
        this.maxAge = options.maxAge || 90 * 24 * 60 * 60 * 1000; // 90 days (3 months) default
        this.persistencePath = options.persistencePath || path.join(process.cwd(), 'data', 'sessions.json');
        this.autoSaveInterval = options.autoSaveInterval || 60 * 1000; // 1 minute
        this.shutdownTimeout = options.shutdownTimeout || 10 * 1000; // 10 seconds for shutdown save

        // Storage session limits (defense-in-depth)
        this.storageMaxSessions = (Number.isFinite(options.storageMaxSessions) && options.storageMaxSessions > 0)
            ? options.storageMaxSessions
            : null; // Default: 60k from index.js
        this.storageMaxAge = options.storageMaxAge || 90 * 24 * 60 * 60 * 1000; // 90 days default

        // Session monitoring and alerting
        this.lastStorageCount = 0;
        this.lastEvictionCount = 0;
        this.evictionHistory = []; // Track evictions for spike detection (last 10 cleanups)

        // Ensure data directory exists
        this.ensureDataDir();

        // Initialize LRU cache (no max count by default)
        const cacheOptions = {
            ttl: this.maxAge,
            updateAgeOnGet: true, // Refresh TTL on access (sliding expiration)
            updateAgeOnHas: false,
            // Dispose callback for cleanup - tracks evictions for spike detection
            dispose: (value, key) => {
                this.lastEvictionCount++;
                log.debug(() => `[SessionManager] Session evicted from memory: ${key}`);
            }
        };
        if (this.maxSessions) {
            cacheOptions.max = this.maxSessions;
        }
        this.cache = new LRUCache(cacheOptions);

        // Short-lived cache of decrypted configs (in-memory only) to avoid re-decryption on frequent requests
        const decryptedTtl = Math.min(this.maxAge || Infinity, DECRYPTED_CACHE_TTL_MS);
        this.decryptedCache = new LRUCache({
            max: this.maxSessions || 30000,
            ttl: Number.isFinite(decryptedTtl) ? decryptedTtl : DECRYPTED_CACHE_TTL_MS,
            updateAgeOnGet: true
        });

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
     * Initialize sessions - loads from disk and sets up pub/sub
     * This MUST be awaited before using the session manager
     * @private
     * @returns {Promise<void>}
     */
    async _initializeSessions() {
        try {
            const storageType = process.env.STORAGE_TYPE || 'filesystem';
            const sessionPreloadEnabled = process.env.SESSION_PRELOAD === 'true';
            log.debug(() => `[SessionManager] Initializing sessions (storage: ${storageType}, preload: ${sessionPreloadEnabled})`);

            await this.loadFromDisk();

            // Initialize Redis pub/sub for cross-instance cache invalidation
            if (storageType === 'redis') {
                try {
                    await this._initializePubSub();
                } catch (err) {
                    log.error(() => ['[SessionManager] Failed to initialize pub/sub:', err.message]);
                    // Continue anyway - pub/sub is not critical
                }
            }

            this.isReady = true;
            log.debug(() => `[SessionManager] Ready to accept requests (instance: ${this.instanceId}, in-memory sessions: ${this.cache.size})`);

            // In Redis lazy-load mode, add helpful message about cross-instance fallback
            if (storageType === 'redis' && !sessionPreloadEnabled) {
                log.debug(() => '[SessionManager] Using lazy-load mode: sessions load from Redis on-demand via fallback');
            }
        } catch (err) {
            log.error(() => ['[SessionManager] Failed to load sessions from disk during init:', err.message]);
            // Mark as ready anyway to prevent blocking startup, but log the error
            this.isReady = true;
        }
    }

    /**
     * Initialize Redis pub/sub listener for cross-instance cache invalidation
     * @private
     */
    async _initializePubSub() {
        const pubSub = await getPubSubClient();
        if (!pubSub) {
            log.debug(() => '[SessionManager] Pub/Sub not available');
            return;
        }

        // Subscribe to session invalidation channel (both prefixed and unprefixed to interop across hosts)
        const baseChannel = 'session:invalidate';
        const channels = Array.from(new Set([
            baseChannel,
            ...getPrefixVariants().map(p => `${p}${baseChannel}`)
        ]));

        const channelSet = new Set(channels);

        pubSub.on('message', (channel, message) => {
            if (!channelSet.has(channel)) {
                return;
            }
            try {
                const data = JSON.parse(message);
                const { token, action, instanceId } = data;

                // Ignore messages from ourselves to prevent self-invalidation
                if (instanceId === this.instanceId) {
                    log.debug(() => `[SessionManager] Ignoring own invalidation event: ${redactToken(token)} (action: ${action})`);
                    return;
                }

                if (token && this.cache.has(token)) {
                    this.cache.delete(token);
                    this.decryptedCache?.delete(token);
                    this.emit('sessionInvalidated', { token, action, source: 'pubsub' });
                    log.debug(() => `[SessionManager] Invalidated cached session from pub/sub: ${redactToken(token)} (action: ${action}) via ${channel}`);
                }
            } catch (err) {
                log.error(() => ['[SessionManager] Failed to process pub/sub message:', err.message]);
            }
        });

        pubSub.on('error', (err) => {
            log.error(() => ['[SessionManager] Pub/Sub error:', err.message]);
        });

        await pubSub.subscribe(...channels);
        log.debug(() => `[SessionManager] Subscribed to pub/sub channels: ${channels.join(', ')}`);
    }

    /**
     * Publish session invalidation event to other instances
     * @private
     */
    async _publishInvalidation(token, action) {
        if ((process.env.STORAGE_TYPE || 'filesystem') !== 'redis') {
            return; // Only in Redis mode
        }

        try {
            const publisher = await getPublishClient();
            if (!publisher) {
                return;
            }

            const message = JSON.stringify({
                token,
                action,
                instanceId: this.instanceId,
                timestamp: Date.now()
            });
            const baseChannel = 'session:invalidate';
            const channels = Array.from(new Set([
                baseChannel,
                ...getPrefixVariants().map(p => `${p}${baseChannel}`)
            ]));

            for (const channel of channels) {
                await publisher.publish(channel, message);
            }
            log.debug(() => `[SessionManager] Published invalidation event: ${redactToken(token)} (${action}) to ${channels.join(', ')}`);
        } catch (err) {
            log.error(() => ['[SessionManager] Failed to publish invalidation event:', err.message]);
            // Don't throw - pub/sub is best-effort
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

        const tokenFingerprint = computeTokenFingerprint(token);

        // Encrypt sensitive fields in config before storing
        const encryptedConfig = encryptUserConfig(config);

        const fingerprint = computeConfigFingerprint(config);
        const integrity = computeIntegrityHash(token, fingerprint);

        const sessionData = {
            token,
            tokenFingerprint,
            config: encryptedConfig,
            createdAt: Date.now(),
            lastAccessedAt: Date.now(),
            fingerprint,
            integrity
        };

        this.cache.set(token, sessionData);
        this.decryptedCache.set(token, cloneConfig(config));
        this.dirty = true;

        // Persist immediately (per-token) for durability across restarts and instances
        Promise.resolve().then(async () => {
            const adapter = await getStorageAdapter();
            // Set sliding persistence TTL equal to maxAge
            const ttlSeconds = Number.isFinite(this.maxAge) ? Math.floor(this.maxAge / 1000) : null;
            await adapter.set(token, sessionData, StorageAdapter.CACHE_TYPES.SESSION, ttlSeconds);
        }).catch(err => {
            log.error(() => ['[SessionManager] Failed to persist new session:', err?.message || String(err)]);
        });

        this.emit('sessionCreated', { token, source: 'local' });
        log.debug(() => `[SessionManager] Session created: ${redactToken(token)} (in-memory: ${this.cache.size})`);
        return token;
    }

    /**
     * Get config from session token
     * @param {string} token - Session token
     * @returns {Promise<Object|null>} User config or null if not found
     */
    async getSession(token) {
        if (!token) return null;

        let sessionData = this.cache.get(token);

        // If not in cache, try loading from storage (Redis/filesystem)
        if (!sessionData) {
            log.debug(() => `[SessionManager] Session not in cache, checking storage: ${redactToken(token)}`);
            const loadedConfig = await this.loadSessionFromStorage(token);
            if (!loadedConfig) {
                return null;
            }
            // loadSessionFromStorage already added to cache and returns decrypted config
            return loadedConfig;
        }

        const tokenValidation = ensureTokenMetadata(sessionData, token);
        if (tokenValidation.status !== 'ok') {
            log.warn(() => `[SessionManager] Token validation failed (${tokenValidation.status}) for ${redactToken(token)} - deleting session`);
            this.deleteSession(token);
            return null;
        }

        const payloadValidation = validateEncryptedSessionPayload(sessionData);
        if (!payloadValidation.valid) {
            log.warn(() => `[SessionManager] Invalid session payload (${payloadValidation.reason}) for ${redactToken(token)} - deleting session`);
            this.deleteSession(token);
            return null;
        }

        // Update last accessed time
        sessionData.lastAccessedAt = Date.now();
        this.cache.set(token, sessionData);
        // In Redis mode we persist/touch per access already; avoid marking dirty to
        // prevent periodic full flushes that rewrite all sessions unnecessarily.
        if ((process.env.STORAGE_TYPE || 'filesystem') !== 'redis') {
            this.dirty = true;
        }

        // Persist touch to refresh persistent TTL
        Promise.resolve().then(async () => {
            const adapter = await getStorageAdapter();
            const ttlSeconds = Number.isFinite(this.maxAge) ? Math.floor(this.maxAge / 1000) : null;
            await adapter.set(token, sessionData, StorageAdapter.CACHE_TYPES.SESSION, ttlSeconds);
        }).catch(err => {
            log.error(() => ['[SessionManager] Failed to refresh session TTL on access:', err?.message || String(err)]);
        });

        // Use cached decrypted config when available to avoid redundant decrypt/log spam on page changes
        const cachedDecrypted = this.decryptedCache.get(token);
        if (cachedDecrypted) {
            return cloneConfig(cachedDecrypted);
        }

        // Decrypt sensitive fields in config before returning
        let decryptedConfig = null;
        try {
            decryptedConfig = decryptUserConfig(sessionData.config);
        } catch (err) {
            log.warn(() => `[SessionManager] Failed to decrypt config for ${redactToken(token)} - deleting session`);
            this.deleteSession(token);
            return null;
        }

        if (!decryptedConfig) {
            log.warn(() => `[SessionManager] Decrypted config was empty for ${redactToken(token)} - deleting session`);
            this.deleteSession(token);
            return null;
        }
        const fingerprint = computeConfigFingerprint(decryptedConfig);
        if (sessionData.fingerprint && fingerprint !== sessionData.fingerprint) {
            log.warn(() => `[SessionManager] Fingerprint mismatch for ${redactToken(token)} - discarding contaminated session`);
            this.deleteSession(token);
            return null;
        }

        // Defense-in-depth: ensure the stored integrity tag matches the token + fingerprint
        const expectedIntegrity = computeIntegrityHash(token, sessionData.fingerprint || fingerprint);
        if (sessionData.integrity && sessionData.integrity !== expectedIntegrity) {
            log.warn(() => `[SessionManager] Integrity mismatch for ${redactToken(token)} - discarding contaminated session`);
            this.deleteSession(token);
            return null;
        }
        if (!sessionData.integrity) {
            sessionData.integrity = expectedIntegrity;
            this.cache.set(token, sessionData);
            this.dirty = true;
            Promise.resolve().then(async () => {
                const adapter = await getStorageAdapter();
                const ttlSeconds = Number.isFinite(this.maxAge) ? Math.floor(this.maxAge / 1000) : null;
                await adapter.set(token, sessionData, StorageAdapter.CACHE_TYPES.SESSION, ttlSeconds);
            }).catch(err => {
                log.error(() => ['[SessionManager] Failed to persist integrity backfill:', err?.message || String(err)]);
            });
        }

        // Backfill missing fingerprint for legacy sessions
        if (!sessionData.fingerprint) {
            sessionData.fingerprint = fingerprint;
            this.cache.set(token, sessionData);
            this.dirty = true;

            // Backfill integrity so future checks can detect contamination
            sessionData.integrity = computeIntegrityHash(token, fingerprint);

            Promise.resolve().then(async () => {
                const adapter = await getStorageAdapter();
                const ttlSeconds = Number.isFinite(this.maxAge) ? Math.floor(this.maxAge / 1000) : null;
                await adapter.set(token, sessionData, StorageAdapter.CACHE_TYPES.SESSION, ttlSeconds);
            }).catch(err => {
                log.error(() => ['[SessionManager] Failed to persist fingerprint backfill:', err?.message || String(err)]);
            });
        }

        this.decryptedCache.set(token, cloneConfig(decryptedConfig));

        return cloneConfig(decryptedConfig);
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
     * @returns {Promise<boolean>} True if updated, false if session not found
     */
    async updateSession(token, config) {
        if (!token) return false;

        let sessionData = this.cache.get(token);

        // If not in cache, try loading from storage (Redis/filesystem)
        if (!sessionData) {
            log.debug(() => `[SessionManager] Session not in cache for update, checking storage: ${redactToken(token)}`);
            const loadedConfig = await this.loadSessionFromStorage(token);
            if (!loadedConfig) {
                log.warn(() => `[SessionManager] Cannot update - session not found in cache or storage: ${redactToken(token)}`);
                return false;
            }
            // loadSessionFromStorage already added to cache, retrieve it
            sessionData = this.cache.get(token);
        }

        const tokenValidation = ensureTokenMetadata(sessionData, token);
        if (tokenValidation.status !== 'ok') {
            log.warn(() => `[SessionManager] Token validation failed (${tokenValidation.status}) during update for ${redactToken(token)} - deleting session`);
            this.deleteSession(token);
            return false;
        }

        const payloadValidation = validateEncryptedSessionPayload(sessionData);
        if (!payloadValidation.valid) {
            log.warn(() => `[SessionManager] Invalid session payload (${payloadValidation.reason}) during update for ${redactToken(token)} - deleting session`);
            this.deleteSession(token);
            return false;
        }

        // Encrypt sensitive fields in config before storing
        const encryptedConfig = encryptUserConfig(config);
        const fingerprint = computeConfigFingerprint(config);
        const integrity = computeIntegrityHash(token, fingerprint);
        const tokenFingerprint = computeTokenFingerprint(token);

        // Update config but keep creation time
        sessionData.config = encryptedConfig;
        sessionData.lastAccessedAt = Date.now();
        sessionData.fingerprint = fingerprint;
        sessionData.integrity = integrity;
        sessionData.tokenFingerprint = tokenFingerprint;

        this.cache.set(token, sessionData);
        this.decryptedCache.set(token, cloneConfig(config));
        this.dirty = true;

        // Persist immediately (per-token)
        Promise.resolve().then(async () => {
            const adapter = await getStorageAdapter();
            const ttlSeconds = Number.isFinite(this.maxAge) ? Math.floor(this.maxAge / 1000) : null;
            await adapter.set(token, sessionData, StorageAdapter.CACHE_TYPES.SESSION, ttlSeconds);
            // Notify other instances to invalidate their cache
            await this._publishInvalidation(token, 'update');
        }).catch(err => {
            log.error(() => ['[SessionManager] Failed to persist updated session:', err?.message || String(err)]);
        });

        this.emit('sessionUpdated', { token, source: 'local' });
        log.debug(() => `[SessionManager] Session updated: ${redactToken(token)}`);
        return true;
    }

    /**
     * Delete a session
     * @param {string} token - Session token
     * @returns {boolean} True if deleted
     */
    deleteSession(token) {
        const existed = this.cache.delete(token);
        this.decryptedCache.delete(token);
        if (existed) {
            this.dirty = true;
            log.debug(() => `[SessionManager] Session deleted: ${redactToken(token)}`);
            // Remove from storage immediately
            Promise.resolve().then(async () => {
                const adapter = await getStorageAdapter();
                await adapter.delete(token, StorageAdapter.CACHE_TYPES.SESSION);
                // Notify other instances to invalidate their cache
                await this._publishInvalidation(token, 'delete');
            }).catch(err => {
                log.error(() => ['[SessionManager] Failed to delete session from storage:', err?.message || String(err)]);
            });
            this.emit('sessionDeleted', { token, source: 'local' });
        }
        return existed;
    }

    /**
     * Get session statistics
     * @returns {Promise<Object>} Statistics
     */
    async getStats() {
        const storageType = process.env.STORAGE_TYPE || 'filesystem';
        const storageCount = await this.getStorageSessionCount();

        return {
            activeSessions: this.cache.size,
            maxSessions: this.maxSessions || null,
            storageSessionCount: storageCount,
            storageMaxSessions: this.storageMaxSessions || null,
            storageUtilization: this.storageMaxSessions ? (storageCount / this.storageMaxSessions * 100).toFixed(2) + '%' : 'N/A',
            maxAge: this.maxAge,
            storageMaxAge: this.storageMaxAge,
            storageType: storageType,
            lastEvictionCount: this.lastEvictionCount,
            // Note: In Redis mode with lazy loading, activeSessions is only in-memory count
            // Sessions in storage but not loaded in memory are NOT counted in activeSessions
            isLazyLoadingMode: storageType === 'redis' && process.env.SESSION_PRELOAD !== 'true'
        };
    }

    /**
     * Get total number of sessions in storage
     * @returns {Promise<number>} Total session count
     */
    async getStorageSessionCount() {
        try {
            const adapter = await getStorageAdapter();
            const keys = await adapter.list(StorageAdapter.CACHE_TYPES.SESSION, '*');
            // Filter to only valid session tokens (32 hex chars)
            const validKeys = keys.filter(token => /^[a-f0-9]{32}$/.test(token));
            return validKeys.length;
        } catch (err) {
            log.error(() => ['[SessionManager] Failed to count storage sessions:', err.message]);
            return 0;
        }
    }

    /**
     * Attempt to load a session directly from storage (cross-instance support)
     * Does NOT throw. On success, populates cache and returns decrypted config.
     * @param {string} token
     * @returns {Promise<Object|null>}
     */
    async loadSessionFromStorage(token) {
        try {
            if (!token) {
                log.debug(() => `[SessionManager] loadSessionFromStorage: token is empty or null`);
                return null;
            }

            const adapter = await getStorageAdapter();
            const stored = await adapter.get(token, StorageAdapter.CACHE_TYPES.SESSION);

            // Session not found in storage
            if (!stored) {
                log.debug(() => `[SessionManager] loadSessionFromStorage: session token not found in storage: ${redactToken(token)}`);
                return null;
            }

            const tokenValidation = ensureTokenMetadata(stored, token);
            if (tokenValidation.status !== 'ok') {
                log.warn(() => `[SessionManager] loadSessionFromStorage: token validation failed (${tokenValidation.status}) for ${redactToken(token)} - deleting session`);
                try { await adapter.delete(token, StorageAdapter.CACHE_TYPES.SESSION); } catch (_) {}
                return null;
            }

            const payloadValidation = validateEncryptedSessionPayload(stored);
            if (!payloadValidation.valid) {
                log.warn(() => `[SessionManager] loadSessionFromStorage: invalid session payload (${payloadValidation.reason}) for ${redactToken(token)} - deleting session`);
                try { await adapter.delete(token, StorageAdapter.CACHE_TYPES.SESSION); } catch (_) {}
                return null;
            }

            // Check if session has expired based on inactivity
            const now = Date.now();
            const inactivityAge = now - (stored.lastAccessedAt || stored.createdAt);
            if (Number.isFinite(this.maxAge) && inactivityAge > this.maxAge) {
                log.warn(() => `[SessionManager] loadSessionFromStorage: session expired due to inactivity (${Math.round(inactivityAge / 1000 / 3600)} hours): ${token}`);
                try { await adapter.delete(token, StorageAdapter.CACHE_TYPES.SESSION); } catch (_) {}
                return null;
            }

            // Refresh last accessed and cache it
            stored.lastAccessedAt = now;
            this.cache.set(token, stored);
            this.decryptedCache.delete(token);

            // Refresh persistent TTL on successful load
            try {
                const ttlSeconds = Number.isFinite(this.maxAge) ? Math.floor(this.maxAge / 1000) : null;
                await adapter.set(token, stored, StorageAdapter.CACHE_TYPES.SESSION, ttlSeconds);
            } catch (e) {
                log.error(() => ['[SessionManager] Failed to refresh TTL during load from storage:', e?.message || String(e)]);
            }

            // Decrypt and return config
            try {
                const decryptedConfig = decryptUserConfig(stored.config);
                const fingerprint = computeConfigFingerprint(decryptedConfig);

                if (stored.fingerprint && fingerprint !== stored.fingerprint) {
                    log.warn(() => `[SessionManager] Fingerprint mismatch on storage load for ${redactToken(token)} - removing corrupted session`);
                    try { await adapter.delete(token, StorageAdapter.CACHE_TYPES.SESSION); } catch (_) {}
                    this.cache.delete(token);
                    this.decryptedCache.delete(token);
                    return null;
                }
                const expectedIntegrity = computeIntegrityHash(token, stored.fingerprint || fingerprint);
                if (stored.integrity && stored.integrity !== expectedIntegrity) {
                    log.warn(() => `[SessionManager] Integrity mismatch on storage load for ${redactToken(token)} - removing contaminated session`);
                    try { await adapter.delete(token, StorageAdapter.CACHE_TYPES.SESSION); } catch (_) {}
                    this.cache.delete(token);
                    this.decryptedCache.delete(token);
                    return null;
                }

                if (!stored.fingerprint) {
                    stored.fingerprint = fingerprint;
                    this.cache.set(token, stored);
                    try {
                        const ttlSeconds = Number.isFinite(this.maxAge) ? Math.floor(this.maxAge / 1000) : null;
                        await adapter.set(token, stored, StorageAdapter.CACHE_TYPES.SESSION, ttlSeconds);
                    } catch (persistErr) {
                        log.error(() => ['[SessionManager] Failed to persist fingerprint during storage load:', persistErr?.message || String(persistErr)]);
                    }
                }
                if (!stored.integrity) {
                    stored.integrity = computeIntegrityHash(token, stored.fingerprint);
                    this.cache.set(token, stored);
                    try {
                        const ttlSeconds = Number.isFinite(this.maxAge) ? Math.floor(this.maxAge / 1000) : null;
                        await adapter.set(token, stored, StorageAdapter.CACHE_TYPES.SESSION, ttlSeconds);
                    } catch (persistErr) {
                        log.error(() => ['[SessionManager] Failed to persist integrity during storage load:', persistErr?.message || String(persistErr)]);
                    }
                }
                if (!decryptedConfig) {
                    log.warn(() => `[SessionManager] loadSessionFromStorage: decrypted config was empty for token ${redactToken(token)} - deleting session`);
                    try { await adapter.delete(token, StorageAdapter.CACHE_TYPES.SESSION); } catch (_) {}
                    this.cache.delete(token);
                    this.decryptedCache.delete(token);
                    return null;
                }
                this.decryptedCache.set(token, cloneConfig(decryptedConfig));
                return cloneConfig(decryptedConfig);
            } catch (decryptErr) {
                log.error(() => ['[SessionManager] loadSessionFromStorage: failed to decrypt config:', decryptErr?.message || String(decryptErr)]);
                try { await adapter.delete(token, StorageAdapter.CACHE_TYPES.SESSION); } catch (_) {}
                this.cache.delete(token);
                this.decryptedCache.delete(token);
                return null;
            }
        } catch (err) {
            log.error(() => ['[SessionManager] loadSessionFromStorage: unexpected error while loading from storage:', err?.message || String(err), 'stack:', err?.stack || 'N/A']);
            return null;
        }
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

            let saved = 0;
            for (const [token, sessionData] of this.cache.entries()) {
                // Persist each session independently to avoid multi-instance clobbering
                const ttlSeconds = Number.isFinite(this.maxAge) ? Math.floor(this.maxAge / 1000) : null;
                await adapter.set(token, sessionData, StorageAdapter.CACHE_TYPES.SESSION, ttlSeconds);
                saved++;
            }

            this.dirty = false;
            this.consecutiveSaveFailures = 0; // Reset on successful save
            log.debug(() => `[SessionManager] Saved ${saved} sessions to storage (per-token)`);
        } catch (err) {
            log.error(() => ['[SessionManager] Failed to save sessions:', err.message || String(err)]);
            throw err;
        }
    }

    /**
     * Load sessions from storage
     * @returns {Promise<void>}
     */
    async loadFromDisk() {
        // In HA/Redis mode, optionally skip preloading all sessions to avoid
        // SCAN + GET overhead across large datasets. Rely on lazy
        // loadSessionFromStorage() when tokens are accessed.
        const storageType = process.env.STORAGE_TYPE || 'filesystem';
        const preloadEnabled = process.env.SESSION_PRELOAD === 'true';
        if (storageType === 'redis' && !preloadEnabled) {
            log.debug(() => '[SessionManager] Skipping session preload in Redis mode (SESSION_PRELOAD!=true)');
            return;
        }
        try {
            const adapter = await getStorageAdapter();

            // Migrate legacy blob if present
            try {
                const legacy = await adapter.get('sessions', StorageAdapter.CACHE_TYPES.SESSION);
                if (legacy && legacy.sessions && typeof legacy.sessions === 'object') {
                    let migrated = 0;
                    for (const [token, sessionData] of Object.entries(legacy.sessions)) {
                        if (!/^[a-f0-9]{32}$/.test(token)) continue;
                        const ok = await adapter.set(token, sessionData, StorageAdapter.CACHE_TYPES.SESSION);
                        if (ok) {
                            migrated++;
                        } else {
                            log.error(() => [`[SessionManager] Failed to persist migrated legacy session token ${token}`]);
                        }
                    }
                    try { await adapter.delete('sessions', StorageAdapter.CACHE_TYPES.SESSION); } catch (_) {}
                    if (migrated > 0) {
                        log.warn(() => `[SessionManager] Migrated ${migrated} legacy sessions to per-token storage`);
                    }
                }
            } catch (_) {
                // ignore migration read errors
            }

            const keys = await adapter.list(StorageAdapter.CACHE_TYPES.SESSION, '*');
            if (!keys || keys.length === 0) {
                log.debug(() => '[SessionManager] No sessions in storage');
                return;
            }

            const now = Date.now();
            let loadedCount = 0;
            let expiredCount = 0;
            let invalidTokenCount = 0;

            for (const token of keys) {
                if (!/^[a-f0-9]{32}$/.test(token)) { invalidTokenCount++; continue; }
                const sessionData = await adapter.get(token, StorageAdapter.CACHE_TYPES.SESSION);
                if (!sessionData) continue;

                const tokenValidation = ensureTokenMetadata(sessionData, token);
                if (tokenValidation.status !== 'ok') {
                    log.warn(() => `[SessionManager] loadFromDisk: token validation failed (${tokenValidation.status}) for ${redactToken(token)} - deleting session`);
                    try { await adapter.delete(token, StorageAdapter.CACHE_TYPES.SESSION); } catch (_) {}
                    continue;
                }

                const payloadValidation = validateEncryptedSessionPayload(sessionData);
                if (!payloadValidation.valid) {
                    log.warn(() => `[SessionManager] loadFromDisk: invalid session payload (${payloadValidation.reason}) for ${redactToken(token)} - deleting session`);
                    try { await adapter.delete(token, StorageAdapter.CACHE_TYPES.SESSION); } catch (_) {}
                    continue;
                }

                const inactivityAge = now - (sessionData.lastAccessedAt || sessionData.createdAt);
                if (Number.isFinite(this.maxAge) && inactivityAge > this.maxAge) {
                    expiredCount++;
                    try { await adapter.delete(token, StorageAdapter.CACHE_TYPES.SESSION); } catch (_) {}
                    continue;
                }

                this.cache.set(token, sessionData);
                loadedCount++;
            }

            if (invalidTokenCount > 0) {
                log.warn(() => `[SessionManager] Skipped ${invalidTokenCount} non-token session keys`);
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
        // In Redis mode, touches and updates persist immediately per token.
        // Skip the periodic auto-save to reduce redundant writes.
        if ((process.env.STORAGE_TYPE || 'filesystem') === 'redis') {
            log.debug(() => '[SessionManager] Skipping auto-save timer in Redis mode');
            return;
        }
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
     * Purge oldest accessed sessions from storage
     * @param {number} count - Number of sessions to purge
     * @returns {Promise<number>} Number of sessions purged
     */
    async purgeOldestSessions(count = 100) {
        try {
            const adapter = await getStorageAdapter();
            const keys = await adapter.list(StorageAdapter.CACHE_TYPES.SESSION, '*');

            // Filter to valid session tokens only
            const validTokens = keys.filter(token => /^[a-f0-9]{32}$/.test(token));

            if (validTokens.length === 0) {
                return 0;
            }

            // Load session metadata (lastAccessedAt) for all sessions
            const sessionsWithMetadata = [];
            for (const token of validTokens) {
                try {
                    const sessionData = await adapter.get(token, StorageAdapter.CACHE_TYPES.SESSION);
                    if (sessionData) {
                        sessionsWithMetadata.push({
                            token,
                            lastAccessedAt: sessionData.lastAccessedAt || sessionData.createdAt || 0
                        });
                    }
                } catch (err) {
                    log.debug(() => `[SessionManager] Failed to load session metadata for ${redactToken(token)}: ${err.message}`);
                }
            }

            // Sort by lastAccessedAt (oldest first)
            sessionsWithMetadata.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

            // Purge the oldest N sessions
            const toPurge = sessionsWithMetadata.slice(0, Math.min(count, sessionsWithMetadata.length));
            let purged = 0;

            for (const { token } of toPurge) {
                try {
                    await adapter.delete(token, StorageAdapter.CACHE_TYPES.SESSION);
                    // Also remove from memory cache if present
                    this.cache.delete(token);
                    purged++;
                } catch (err) {
                    log.error(() => [`[SessionManager] Failed to purge session ${token}:`, err.message]);
                }
            }

            if (purged > 0) {
                log.warn(() => `[SessionManager] Storage cleanup: purged ${purged} oldest accessed sessions`);
            }

            return purged;
        } catch (err) {
            log.error(() => ['[SessionManager] Failed to purge oldest sessions:', err.message]);
            return 0;
        }
    }

    /**
     * Check storage session count and run cleanup if approaching limit
     * @returns {Promise<void>}
     */
    async checkStorageLimitAndCleanup() {
        if (!this.storageMaxSessions) {
            return; // No storage limit configured
        }

        try {
            const storageCount = await this.getStorageSessionCount();
            const utilizationPercent = (storageCount / this.storageMaxSessions) * 100;

            // Alert if approaching limit (>80%)
            if (utilizationPercent > 80) {
                log.warn(() => `[SessionManager] Storage session count approaching limit: ${storageCount} / ${this.storageMaxSessions} (${utilizationPercent.toFixed(1)}%)`);
            }

            // Run cleanup if at or above 90% of limit
            if (utilizationPercent >= 90) {
                const sessionsToRemove = Math.max(100, Math.floor(storageCount - (this.storageMaxSessions * 0.85))); // Target 85% utilization
                log.warn(() => `[SessionManager] Storage limit reached (${utilizationPercent.toFixed(1)}%), purging ${sessionsToRemove} oldest sessions`);
                const purged = await this.purgeOldestSessions(sessionsToRemove);

                if (purged < sessionsToRemove) {
                    log.error(() => `[SessionManager] ALERT: Only purged ${purged} / ${sessionsToRemove} sessions - storage may be exhausted!`);
                }
            }

            // Track storage count changes for abnormal growth detection
            if (this.lastStorageCount > 0) {
                const growth = storageCount - this.lastStorageCount;
                const growthPercent = (growth / this.lastStorageCount) * 100;

                // Alert on abnormal growth (>20% increase in 1 hour)
                if (growthPercent > 20) {
                    log.warn(() => `[SessionManager] ALERT: Abnormal session growth detected: +${growth} sessions (+${growthPercent.toFixed(1)}%) in the last hour`);
                }
            }

            this.lastStorageCount = storageCount;
        } catch (err) {
            log.error(() => ['[SessionManager] Storage limit check failed:', err.message]);
        }
    }

    /**
     * Start memory cleanup interval
     * Periodically removes old sessions from memory to prevent unbounded growth
     * Sessions are still preserved in persistent storage and will be loaded on next access
     * Also runs storage cleanup when approaching storage limits
     */
    startMemoryCleanup() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }

        // Run cleanup every hour (less frequent than auto-save)
        const cleanupInterval = 60 * 60 * 1000; // 1 hour

        this.cleanupTimer = setInterval(async () => {
            try {
                const now = Date.now();
                const memoryThreshold = 30 * 24 * 60 * 60 * 1000; // 30 days - sessions older than this in memory get evicted
                let memoryEvictedCount = 0;
                const initialSize = this.cache.size;
                const previousEvictionCount = this.lastEvictionCount;

                // Iterate through cache and evict sessions that haven't been accessed in 30 days
                // They remain in persistent storage and will be loaded if accessed again
                for (const [token, sessionData] of this.cache.entries()) {
                    const timeSinceLastAccess = now - sessionData.lastAccessedAt;

                    // If session hasn't been accessed in 30 days, remove from memory
                    if (timeSinceLastAccess > memoryThreshold) {
                        this.cache.delete(token);
                        memoryEvictedCount++;
                    }
                }

                if (memoryEvictedCount > 0) {
                    log.info(() => `[SessionManager] Memory cleanup: evicted ${memoryEvictedCount} old sessions from memory (${initialSize} → ${this.cache.size})`);
                    log.debug(() => '[SessionManager] Evicted sessions remain in persistent storage and will reload if accessed');
                }

                // Track eviction history for spike detection
                const totalEvictionsSinceLastCheck = this.lastEvictionCount - previousEvictionCount;
                this.evictionHistory.push(totalEvictionsSinceLastCheck);

                // Keep only last 10 cleanup cycles
                if (this.evictionHistory.length > 10) {
                    this.evictionHistory.shift();
                }

                // Detect eviction spikes (current evictions > 3x average)
                if (this.evictionHistory.length >= 3) {
                    const avgEvictions = this.evictionHistory.slice(0, -1).reduce((sum, val) => sum + val, 0) / (this.evictionHistory.length - 1);
                    if (totalEvictionsSinceLastCheck > avgEvictions * 3 && totalEvictionsSinceLastCheck > 100) {
                        log.warn(() => `[SessionManager] ALERT: Eviction spike detected! ${totalEvictionsSinceLastCheck} evictions (avg: ${avgEvictions.toFixed(0)})`);
                    }
                }

                // Reset eviction counter for next cycle
                this.lastEvictionCount = 0;

                // Run storage cleanup check
                await this.checkStorageLimitAndCleanup();
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

            // Close pub/sub and publish connections if initialized
            if (pubSubClient) {
                try {
                    await pubSubClient.quit();
                    log.warn(() => '[SessionManager] Pub/Sub connection closed');
                } catch (err) {
                    log.error(() => ['[SessionManager] Error closing pub/sub connection:', err.message]);
                }
            }
            if (publishClient) {
                try {
                    await publishClient.quit();
                    log.warn(() => '[SessionManager] Publish connection closed');
                } catch (err) {
                    log.error(() => ['[SessionManager] Error closing publish connection:', err.message]);
                }
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
