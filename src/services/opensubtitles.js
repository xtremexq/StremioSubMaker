const axios = require('axios');
const { LRUCache } = require('lru-cache');
const { sanitizeApiKeyForHeader } = require('../utils/security');
const crypto = require('crypto');
const { toISO6391, toISO6392 } = require('../utils/languages');
const { handleSearchError, handleDownloadError, handleAuthError, parseApiError } = require('../utils/apiErrorHandler');
const { httpAgent, httpsAgent, dnsLookup } = require('../utils/httpAgents');
const { detectAndConvertEncoding } = require('../utils/encodingDetector');
const { version } = require('../utils/version');
const { appendHiddenInformationalNote } = require('../utils/subtitle');
const log = require('../utils/logger');
const { isTrueishFlag } = require('../utils/subtitleFlags');
const { detectArchiveType, extractSubtitleFromArchive, isArchive, createEpisodeNotFoundSubtitle, createZipTooLargeSubtitle, convertSubtitleToVtt } = require('../utils/archiveExtractor');
const { analyzeResponseContent, createInvalidResponseSubtitle } = require('../utils/responseAnalyzer');

const OPENSUBTITLES_API_URL = 'https://api.opensubtitles.com/api/v1';
const OPENSUBTITLES_VIP_API_URL = 'https://vip-api.opensubtitles.com/api/v1';
const USER_AGENT = `SubMaker v${version}`;
const MAX_ZIP_BYTES = 25 * 1024 * 1024; // hard cap for ZIP downloads (~25MB) to avoid huge packs

const AUTH_FAILURE_TTL_MS = 5 * 60 * 1000; // Keep invalid credentials blocked for 5 minutes
const credentialFailureCache = new Map();

// MULTI-INSTANCE FIX: Token cache is now backed by Redis for cross-pod sharing
// Local Map is used as L1 cache for same-process performance
// Redis is the source of truth, checked when local cache misses
const tokenCacheLocal = new Map();
const TOKEN_CACHE_PREFIX = 'ostoken:';
const TOKEN_TTL_SECONDS = 23 * 60 * 60; // 23 hours (token valid for 24h, 1h buffer)

// Login mutex: prevents multiple concurrent /login calls for the same credentials
// Key: credentialsCacheKey, Value: Promise that resolves when login completes
const loginMutex = new Map();

// ─── Token-bucket rate limiter ────────────────────────────────────────────────
// OpenSubtitles enforces 5 req/sec/IP.  On shared-IP deployments every pod
// shares that budget, so we cap at 4/sec locally to leave margin.
// All outbound OpenSubtitles API calls (login, search, download-link) must
// call `await acquireToken()` before making the HTTP request.
const RATE_LIMIT_TOKENS_MAX = 4;          // max burst
const RATE_LIMIT_REFILL_INTERVAL_MS = 1000; // refill every 1 s
let _rateLimitTokens = RATE_LIMIT_TOKENS_MAX;
const _rateLimitQueue = [];              // waiters: array of resolve callbacks
let _rateLimitTimer = null;

function _startRefillTimer() {
  if (_rateLimitTimer) return;
  _rateLimitTimer = setInterval(() => {
    // Refill up to max
    _rateLimitTokens = Math.min(_rateLimitTokens + RATE_LIMIT_TOKENS_MAX, RATE_LIMIT_TOKENS_MAX);
    // Wake queued waiters
    while (_rateLimitTokens > 0 && _rateLimitQueue.length > 0) {
      _rateLimitTokens--;
      const resolve = _rateLimitQueue.shift();
      resolve();
    }
    // Stop timer when idle (no waiters, bucket full) to avoid keeping process alive
    if (_rateLimitQueue.length === 0 && _rateLimitTokens >= RATE_LIMIT_TOKENS_MAX) {
      clearInterval(_rateLimitTimer);
      _rateLimitTimer = null;
    }
  }, RATE_LIMIT_REFILL_INTERVAL_MS);
  // Allow Node to exit even if the timer is running
  if (_rateLimitTimer && typeof _rateLimitTimer.unref === 'function') {
    _rateLimitTimer.unref();
  }
}

/**
 * Acquire a rate-limit token before making an OpenSubtitles API call.
 * Resolves immediately if tokens are available, otherwise queues.
 * @returns {Promise<void>}
 */
function acquireToken() {
  if (_rateLimitTokens > 0) {
    _rateLimitTokens--;
    _startRefillTimer();
    return Promise.resolve();
  }
  // No tokens – queue and start the refill timer
  _startRefillTimer();
  return new Promise(resolve => {
    _rateLimitQueue.push(resolve);
  });
}
// ─── End rate limiter ─────────────────────────────────────────────────────────

// ─── Provider-level search result cache ───────────────────────────────────────
// Shared across ALL users within a pod. Safe because OpenSubtitles returns
// identical search results regardless of which user's token is used — the token
// only affects download quotas, not search results.
// Cache key = exact API query params (imdb_id, languages, season, episode, HI).
// IMPORTANT: results are deep-cloned on retrieval because downstream code
// (episode filtering, season pack detection) mutates the subtitle objects.
const OS_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const OS_SEARCH_CACHE_MAX = 2000;
const osSearchCache = new LRUCache({
  max: OS_SEARCH_CACHE_MAX,
  ttl: OS_SEARCH_CACHE_TTL_MS,
  updateAgeOnGet: true, // popular content stays cached longer
});

/**
 * Build a deterministic cache key from the exact query params sent to the
 * OpenSubtitles API.  Languages are sorted so that the same set in any order
 * produces the same key.
 * @param {Object} queryParams - The query params object sent to /subtitles
 * @returns {string}
 */
function buildSearchCacheKey(queryParams) {
  const langs = (queryParams.languages || '').split(',').sort().join(',');
  const parts = [
    'os_search',
    queryParams.imdb_id || '',
    langs,
    queryParams.season_number || '',
    queryParams.episode_number || '',
    queryParams.hearing_impaired || ''
  ];
  return parts.join(':');
}
// ─── End search cache ─────────────────────────────────────────────────────────


/**
 * Get cached token for credentials (if valid)
 * MULTI-INSTANCE: Checks local cache first, then Redis
 * @param {string} cacheKey - Credentials cache key
 * @returns {Promise<{ token: string, expiry: number, baseUrl?: string } | null>}
 */
async function getCachedToken(cacheKey) {
  if (!cacheKey) return null;

  // L1: Check local cache first (fast path)
  const local = tokenCacheLocal.get(cacheKey);
  if (local) {
    // Check if token is still valid (with 1 minute buffer)
    if (Date.now() < local.expiry - 60000) {
      return local;
    }
    tokenCacheLocal.delete(cacheKey);
  }

  // L2: Check Redis (cross-pod cache)
  try {
    const { getShared } = require('../utils/sharedCache');
    const { StorageAdapter } = require('../storage');
    const redisKey = `${TOKEN_CACHE_PREFIX}${cacheKey}`;
    const cached = await getShared(redisKey, StorageAdapter.CACHE_TYPES.SESSION);

    if (cached) {
      const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
      if (parsed && parsed.token && parsed.expiry) {
        // Check if token is still valid
        if (Date.now() < parsed.expiry - 60000) {
          // Populate local cache for future same-process calls
          tokenCacheLocal.set(cacheKey, parsed);
          log.debug(() => '[OpenSubtitles] Token loaded from Redis (cross-pod cache)');
          return parsed;
        }
      }
    }
  } catch (err) {
    // Redis unavailable - fall through
    log.debug(() => `[OpenSubtitles] Redis token lookup failed: ${err.message}`);
  }

  return null;
}

/**
 * Store token in cache (both local and Redis)
 * @param {string} cacheKey - Credentials cache key
 * @param {string} token - JWT token
 * @param {number} expiry - Expiry timestamp
 * @param {string} [baseUrl] - Optional VIP API base URL
 */
async function setCachedToken(cacheKey, token, expiry, baseUrl = null) {
  if (!cacheKey || !token) return;

  const data = { token, expiry };
  // Include VIP base URL if provided (for VIP members)
  if (baseUrl) {
    data.baseUrl = baseUrl;
  }

  // L1: Store in local cache
  tokenCacheLocal.set(cacheKey, data);

  // L2: Store in Redis for cross-pod sharing
  try {
    const { setShared } = require('../utils/sharedCache');
    const { StorageAdapter } = require('../storage');
    const redisKey = `${TOKEN_CACHE_PREFIX}${cacheKey}`;
    await setShared(redisKey, JSON.stringify(data), StorageAdapter.CACHE_TYPES.SESSION, TOKEN_TTL_SECONDS);
    log.debug(() => '[OpenSubtitles] Token cached in Redis (cross-pod)');
  } catch (err) {
    // Redis unavailable - local cache still works
    log.debug(() => `[OpenSubtitles] Redis token cache failed: ${err.message}`);
  }
}

/**
 * Clear cached token (both local and Redis)
 * @param {string} cacheKey - Credentials cache key
 */
async function clearCachedToken(cacheKey) {
  if (!cacheKey) return;

  // L1: Clear local cache
  tokenCacheLocal.delete(cacheKey);

  // L2: Clear from Redis
  try {
    const { deleteShared } = require('../utils/sharedCache');
    const { StorageAdapter } = require('../storage');
    const redisKey = `${TOKEN_CACHE_PREFIX}${cacheKey}`;
    await deleteShared(redisKey, StorageAdapter.CACHE_TYPES.SESSION);
  } catch (err) {
    log.debug(() => `[OpenSubtitles] Redis token delete failed: ${err.message}`);
  }
}

function inferFormatFromFilename(filename) {
  if (!filename) return null;
  const lower = String(filename).toLowerCase();
  const extMatch = lower.match(/\.([a-z0-9]{2,4})$/);
  if (extMatch && extMatch[1]) {
    const ext = extMatch[1];
    if (['srt', 'vtt', 'ass', 'ssa', 'sub'].includes(ext)) {
      return ext;
    }
  }
  return null;
}

function stripExtension(filename) {
  if (!filename) return filename;
  return filename.replace(/\.[^.]+$/, '');
}

function getCredentialsCacheKey(username, password) {
  if (!username) {
    return null;
  }
  const normalized = String(username || '').trim().toLowerCase();
  const secret = `${normalized}:${password || ''}`;
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function isAuthenticationFailure(error) {
  if (!error) {
    return false;
  }

  const status = error.response?.status;

  // 401 Unauthorized and 403 Forbidden are clear auth failures
  if (status === 401 || status === 403) {
    return true;
  }

  // Check error message for auth-related keywords
  // This handles 400 errors that might be auth-related, as well as other edge cases
  const message = String(error.response?.data?.message || error.message || '').toLowerCase();
  if (message.includes('invalid username') || message.includes('invalid credentials') || message.includes('usernamepassword') || message.includes('unauthorized') || message.includes('wrong password')) {
    return true;
  }

  // 400 Bad Request is NOT automatically an auth failure - it could be many things
  // (malformed request, missing fields, etc.) - only the message content tells us

  return false;
}

function hasCachedAuthFailure(cacheKey) {
  if (!cacheKey) {
    return false;
  }

  const timestamp = credentialFailureCache.get(cacheKey);
  if (!timestamp) {
    return false;
  }

  if (Date.now() - timestamp > AUTH_FAILURE_TTL_MS) {
    credentialFailureCache.delete(cacheKey);
    return false;
  }

  return true;
}

function cacheAuthFailure(cacheKey) {
  if (!cacheKey) {
    return;
  }

  credentialFailureCache.set(cacheKey, Date.now());
}

function clearCachedAuthFailure(cacheKey) {
  if (!cacheKey) {
    return;
  }

  credentialFailureCache.delete(cacheKey);
}

/**
 * Get OpenSubtitles API key at runtime (not at module load time)
 * This ensures Docker ENV vars and runtime environment changes are picked up
 * @returns {string} API key or empty string
 */
function getOpenSubtitlesApiKey() {
  return process.env.OPENSUBTITLES_API_KEY || '';
}

class OpenSubtitlesService {
  // Static flag to track if initialization logs have been shown
  static initLogged = false;

  constructor(config = {}) {
    // Config requires username/password for user authentication (mandatory)
    this.config = {
      username: config.username || '',
      password: config.password || ''
    };

    this.credentialsCacheKey = getCredentialsCacheKey(this.config.username, this.config.password);

    // MULTI-INSTANCE: Token loading from Redis happens lazily in login()/isTokenExpired()
    // Constructor only checks local cache for fast startup
    const local = tokenCacheLocal.get(this.credentialsCacheKey);
    if (local && Date.now() < local.expiry - 60000) {
      this.token = local.token;
      this.tokenExpiry = local.expiry;
      // Apply VIP base_url if cached
      if (local.baseUrl) {
        this.baseUrl = local.baseUrl;
      }
    } else {
      this.token = null;
      this.tokenExpiry = null;
      this.baseUrl = null;
    }

    // Read API key at runtime (not at module load time)
    const apiKey = getOpenSubtitlesApiKey();

    // Base axios configuration
    const defaultHeaders = {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
      'Accept': '*/*', // OpenSubtitles docs: "make sure you always add to every request Accept header: Accept: */*"
      'Accept-Encoding': 'gzip, deflate, br'
    };

    // Add API key if configured (only for search/auth flows)
    const sanitizedApiKey = sanitizeApiKeyForHeader(apiKey);
    if (sanitizedApiKey) {
      defaultHeaders['Api-Key'] = sanitizedApiKey;
      // Only log once at startup
      if (!OpenSubtitlesService.initLogged) {
        log.debug(() => '[OpenSubtitles] API key loaded successfully from environment');
      }
    }

    const baseAxiosConfig = {
      baseURL: OPENSUBTITLES_API_URL,
      headers: defaultHeaders,
      httpAgent,
      httpsAgent,
      lookup: dnsLookup,
      timeout: 12000,
      maxRedirects: 5,
      decompress: true
    };

    // Primary client (search/auth) uses Api-Key
    this.client = axios.create(baseAxiosConfig);

    // Download client also uses Api-Key - per OpenSubtitles docs:
    // "In every request should be present these HTTP headers... Api-Key"
    this.downloadClient = axios.create(baseAxiosConfig);

    // Only log initialization messages once at startup
    if (!OpenSubtitlesService.initLogged) {
      // Validate API key is configured
      if (!apiKey) {
        log.warn(() => '[OpenSubtitles] WARNING: OPENSUBTITLES_API_KEY not found in environment variables');
        log.warn(() => '[OpenSubtitles] Set it via: .env file, Docker ENV, or docker-compose environment');
        log.warn(() => '[OpenSubtitles] API requests may fail or have very limited rate limits');
      }

      // Validate that credentials are provided
      if (!this.config.username || !this.config.password) {
        log.warn(() => '[OpenSubtitles] Username and password are optional - searches will use basic API access (limited to 5 downloads/24h per IP)');
      } else {
        log.debug(() => '[OpenSubtitles] Initialized with user account authentication for higher rate limits');
      }

      // Mark as logged
      OpenSubtitlesService.initLogged = true;
    }

    // Add request interceptor to handle token refresh for user authentication
    const addAuthInterceptor = (axiosInstance) => {
      axiosInstance.interceptors.request.use((config) => {
        // Use instance token if valid - Redis check happens in login()
        // Interceptor is synchronous, so we only use local state here
        if (this.token && this.tokenExpiry && Date.now() < this.tokenExpiry) {
          config.headers['Authorization'] = `Bearer ${this.token}`;
        }
        return config;
      });
    };
    addAuthInterceptor(this.client);
    addAuthInterceptor(this.downloadClient);

    // Apply cached VIP base_url to axios clients (if loaded from local cache in constructor)
    if (this.baseUrl) {
      this.client.defaults.baseURL = this.baseUrl;
      this.downloadClient.defaults.baseURL = this.baseUrl;
    }
  }

  /**
   * Check if token is expired (also checks Redis cache)
   * MULTI-INSTANCE: Async to support Redis lookup
   * @returns {Promise<boolean>}
   */
  async isTokenExpired() {
    // If we have a valid local token, use it
    if (this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return false;
    }

    // Check Redis for a token from another pod
    const cached = await getCachedToken(this.credentialsCacheKey);
    if (cached) {
      this.token = cached.token;
      this.tokenExpiry = cached.expiry;
      // Apply VIP base_url if cached
      if (cached.baseUrl && !this.baseUrl) {
        this.baseUrl = cached.baseUrl;
        this.client.defaults.baseURL = cached.baseUrl;
        this.downloadClient.defaults.baseURL = cached.baseUrl;
      }
      return Date.now() >= this.tokenExpiry;
    }

    return true;
  }

  /**
   * Login with username and password to get JWT token
   * @param {string} username - OpenSubtitles username
   * @param {string} password - OpenSubtitles password
   * @param {number} timeout - Optional timeout in ms
   * @returns {Promise<string>} - JWT token
   */
  async loginWithCredentials(username, password, timeout) {
    try {
      log.debug(() => ['[OpenSubtitles] Authenticating user:', username]);

      // Use provided timeout or fall back to client default
      const requestConfig = timeout ? { timeout } : {};
      await acquireToken(); // Rate-limit: wait for token before hitting OpenSubtitles API
      const response = await this.client.post('/login', {
        username: username,
        password: password
      }, requestConfig);

      if (!response.data?.token) {
        throw new Error('No token received from authentication');
      }

      this.token = response.data.token;
      // Token is valid for 24 hours
      this.tokenExpiry = Date.now() + (24 * 60 * 60 * 1000);

      // VIP users get a special base_url - use it for faster/less rate-limited access
      let vipBaseUrl = null;
      if (response.data.base_url) {
        const rawBaseUrl = String(response.data.base_url).trim();
        // Only use vip-api endpoint if returned by OpenSubtitles
        if (rawBaseUrl.includes('vip-api.opensubtitles.com')) {
          vipBaseUrl = rawBaseUrl.startsWith('http') ? rawBaseUrl : `https://${rawBaseUrl}`;
          // Ensure it ends with /api/v1
          if (!vipBaseUrl.endsWith('/api/v1')) {
            vipBaseUrl = vipBaseUrl.replace(/\/?$/, '/api/v1');
          }
          this.baseUrl = vipBaseUrl;
          // Update axios clients to use VIP endpoint
          this.client.defaults.baseURL = vipBaseUrl;
          this.downloadClient.defaults.baseURL = vipBaseUrl;
          log.info(() => `[OpenSubtitles] VIP user detected - switching to VIP API endpoint`);
        }
      }

      // Store in Redis for cross-pod sharing (fire and forget - don't block on this)
      setCachedToken(this.credentialsCacheKey, this.token, this.tokenExpiry, vipBaseUrl).catch(() => { });

      log.debug(() => '[OpenSubtitles] User authentication successful');
      clearCachedAuthFailure(this.credentialsCacheKey);
      return this.token;

    } catch (error) {
      // Classify the error so we don't mis-treat rate limits as bad credentials
      const parsed = parseApiError(error, 'OpenSubtitles');

      // OpenSubtitles returns 403 "You cannot consume this service" when API key is rate-limited/blocked
      // Treat this like a rate limit, not an auth failure
      const errMsg = String(error.response?.data?.message || error.message || '').toLowerCase();
      const looksLikeRateLimit = errMsg.includes('throttle') || errMsg.includes('rate limit') || errMsg.includes('too many') || errMsg.includes('cannot consume');
      if (parsed.statusCode === 403 && looksLikeRateLimit) {
        log.warn(() => `[OpenSubtitles] 403 response looks like rate limiting, not auth failure: "${errMsg}"`);
        const e = new Error('OpenSubtitles API key temporarily blocked due to rate limiting');
        e.statusCode = 429;
        e.type = 'rate_limit';
        e.isRetryable = true;
        throw e;
      }

      // Never cache an auth failure for retryable cases like 429/503
      // Also skip caching if the error message looks like rate limiting regardless of status code
      if (parsed.type !== 'rate_limit' && parsed.statusCode !== 503 && parsed.statusCode !== 429 && !looksLikeRateLimit && isAuthenticationFailure(error)) {
        cacheAuthFailure(this.credentialsCacheKey);
      }

      // For rate limits or service unavailability, bubble up so callers can render a proper message
      if (parsed.statusCode === 429 || parsed.type === 'rate_limit' || parsed.statusCode === 503) {
        const e = new Error(parsed.userMessage || parsed.message || 'Service temporarily unavailable');
        e.statusCode = parsed.statusCode || 503;
        e.type = parsed.type || 'service_unavailable';
        e.isRetryable = true;
        throw e;
      }

      // For timeout and network errors, also bubble up so they don't get misinterpreted as invalid credentials
      if (parsed.type === 'timeout' || parsed.type === 'network' || parsed.type === 'dns') {
        const e = new Error(parsed.userMessage || parsed.message || 'Network error during authentication');
        e.statusCode = parsed.statusCode || 0;
        e.type = parsed.type;
        e.isRetryable = parsed.type !== 'dns'; // DNS errors are not retryable
        throw e;
      }

      // For genuine auth failures and other client errors, log via auth handler and return null
      return handleAuthError(error, 'OpenSubtitles');
    }
  }

  /**
   * Login to OpenSubtitles REST API (optional, for higher download limits)
   * Uses mutex to serialize concurrent login attempts for the same credentials.
   * @param {number} timeout - Optional timeout in ms for the login request
   * @returns {Promise<string|null>} - JWT token if credentials provided, null otherwise
   */
  async login(timeout) {
    if (!this.config.username || !this.config.password) {
      // No credentials provided, use basic API access
      return null;
    }

    if (hasCachedAuthFailure(this.credentialsCacheKey)) {
      log.warn(() => '[OpenSubtitles] Authentication blocked: cached invalid credentials detected');
      return null;
    }

    // Check if there's already a valid token in cache (local + Redis)
    const cached = await getCachedToken(this.credentialsCacheKey);
    if (cached) {
      this.token = cached.token;
      this.tokenExpiry = cached.expiry;
      // Apply VIP base_url if cached (for VIP members)
      if (cached.baseUrl) {
        this.baseUrl = cached.baseUrl;
        this.client.defaults.baseURL = cached.baseUrl;
        this.downloadClient.defaults.baseURL = cached.baseUrl;
        log.debug(() => '[OpenSubtitles] VIP base URL applied from cache');
      }
      log.debug(() => '[OpenSubtitles] Using cached token (cross-pod Redis cache)');
      return this.token;
    }

    // Check if another request is already logging in with these credentials
    const existingMutex = loginMutex.get(this.credentialsCacheKey);
    if (existingMutex) {
      log.debug(() => '[OpenSubtitles] Waiting for existing login to complete (mutex)');
      try {
        const result = await existingMutex;
        // After mutex resolves, check cache again
        const freshCached = await getCachedToken(this.credentialsCacheKey);
        if (freshCached) {
          this.token = freshCached.token;
          this.tokenExpiry = freshCached.expiry;
          // Apply VIP base_url if cached
          if (freshCached.baseUrl) {
            this.baseUrl = freshCached.baseUrl;
            this.client.defaults.baseURL = freshCached.baseUrl;
            this.downloadClient.defaults.baseURL = freshCached.baseUrl;
          }
          return this.token;
        }
        return result;
      } catch (err) {
        // If the original login failed due to bad credentials (cached auth failure), return null gracefully
        // For rate limits and other retryable errors, also return null to allow graceful degradation
        // instead of propagating errors that would become unhandled rejections
        if (hasCachedAuthFailure(this.credentialsCacheKey)) {
          return null;
        }
        // For rate limits (429/503), return null to degrade gracefully
        // The login will be retried on the next request after the rate limit window
        if (err && (err.type === 'rate_limit' || err.statusCode === 429 || err.statusCode === 503)) {
          log.warn(() => `[OpenSubtitles] Login mutex caught rate limit error: ${err.message}`);
          return null;
        }
        // For timeout/network errors, re-throw so they propagate with proper error type
        // instead of being misinterpreted as invalid credentials
        if (err && (err.type === 'timeout' || err.type === 'network' || err.type === 'dns')) {
          throw err;
        }
        // For unexpected errors, throw to let the caller handle
        throw err;
      }
    }

    // Create a mutex promise for this login attempt
    let resolveMutex;
    let rejectMutex;
    const mutexPromise = new Promise((resolve, reject) => {
      resolveMutex = resolve;
      rejectMutex = reject;
    });
    // Prevent unhandled rejection if no one awaits this mutex when it rejects
    // This happens when the first request fails and no concurrent requests were waiting
    mutexPromise.catch(() => { /* swallow - rejection is handled by the try/catch below */ });
    loginMutex.set(this.credentialsCacheKey, mutexPromise);

    try {
      const result = await this.loginWithCredentials(this.config.username, this.config.password, timeout);
      resolveMutex(result);
      return result;
    } catch (err) {
      rejectMutex(err);
      throw err;
    } finally {
      // Clean up mutex after a short delay to handle race conditions
      setTimeout(() => {
        if (loginMutex.get(this.credentialsCacheKey) === mutexPromise) {
          loginMutex.delete(this.credentialsCacheKey);
        }
      }, 100);
    }
  }

  /**
   * Search for subtitles using the new REST API
   * @param {Object} params - Search parameters
   * @param {string} params.imdb_id - IMDB ID (with 'tt' prefix)
   * @param {string} params.type - 'movie' or 'episode'
   * @param {number} params.season - Season number (for episodes)
   * @param {number} params.episode - Episode number (for episodes)
   * @param {Array<string>} params.languages - Array of ISO-639-2 language codes
   * @returns {Promise<Array>} - Array of subtitle objects
   */
  async searchSubtitles(params) {
    try {
      // Extract providerTimeout early so it can be used for login as well as search
      const { providerTimeout } = params;

      // Authenticate with user credentials (required)
      if (!this.config.username || !this.config.password) {
        log.warn(() => '[OpenSubtitles] Username and password are required. Please configure your OpenSubtitles credentials.');
        return [];
      }

      // Check for cached authentication failure (known bad credentials)
      if (hasCachedAuthFailure(this.credentialsCacheKey)) {
        const authErr = new Error('OpenSubtitles authentication failed: invalid username/password');
        authErr.statusCode = 401;
        authErr.authError = true;
        throw authErr;
      }

      if (await this.isTokenExpired()) {
        // login() throws for timeout/network/dns errors
        // login() returns null for rate limits (graceful degradation) or if credentials just failed
        const loginResult = await this.login(providerTimeout);

        if (!loginResult) {
          // If we got here with null, check WHY:
          // - If credentials are now cached as failed, it's a real auth failure
          // - Otherwise, it was likely a rate limit - return empty for now
          if (hasCachedAuthFailure(this.credentialsCacheKey)) {
            const authErr = new Error('OpenSubtitles authentication failed: invalid username/password');
            authErr.statusCode = 401;
            authErr.authError = true;
            throw authErr;
          }
          // Rate limit or other transient issue - return empty, user can try again
          log.warn(() => '[OpenSubtitles] Authentication temporarily unavailable (rate limited). Try again later.');
          return [];
        }
      }

      const { imdb_id, type, season, episode, languages, excludeHearingImpairedSubtitles, videoHash } = params;

      if (!imdb_id) {
        log.warn(() => '[OpenSubtitles] No IMDB ID provided, skipping search');
        return [];
      }

      // Convert imdb_id to numeric format (remove 'tt' prefix)
      const imdbId = imdb_id.replace('tt', '');

      // Convert ISO-639-2 (3-letter) codes to ISO-639-1 (2-letter) codes for OpenSubtitles API
      const convertedLanguages = languages.map(lang => {
        const lower = lang.toLowerCase().trim();

        // Handle special case for Portuguese Brazilian
        if (lower === 'pob' || lower === 'ptbr' || lower === 'pt-br') {
          return 'pt-br';
        }

        // If already 2 letters, return as-is
        if (lower.length === 2 && /^[a-z]{2}$/.test(lower)) {
          return lower;
        }

        // If 3 letters (ISO-639-2), convert to ISO-639-1
        if (lower.length === 3 && /^[a-z]{3}$/.test(lower)) {
          const iso1Code = toISO6391(lower);
          if (iso1Code) {
            return iso1Code;
          }
        }

        // Return original if can't convert
        return lower;
      }).filter(lang => lang); // Remove any nulls/undefined

      log.debug(() => ['[OpenSubtitles] Converted languages from ISO-639-2 to ISO-639-1:', languages.join(','), '->', convertedLanguages.join(',')]);

      // Build query parameters for REST API
      const queryParams = {
        imdb_id: imdbId,
        languages: convertedLanguages.join(',')
      };

      if ((type === 'episode' || type === 'anime-episode') && episode) {
        // Default to season 1 if not specified (common for anime)
        queryParams.season_number = season || 1;
        queryParams.episode_number = episode;
      }

      if (excludeHearingImpairedSubtitles === true) {
        queryParams.hearing_impaired = 'exclude';
      }

      // Send moviehash when a real Stremio video hash is available
      // OpenSubtitles API will return moviehash_match=true for exact file matches
      if (videoHash) {
        queryParams.moviehash = videoHash;
        log.debug(() => '[OpenSubtitles] Including moviehash in search for hash-based matching');
      }

      log.debug(() => ['[OpenSubtitles] Searching with params:', JSON.stringify(queryParams)]);
      if (this.token) {
        log.debug(() => '[OpenSubtitles] Using user account authentication');
      } else {
        log.debug(() => '[OpenSubtitles] Using basic API access');
      }

      // Use providerTimeout from config if provided, otherwise use client default
      const requestConfig = { params: queryParams };
      if (providerTimeout) requestConfig.timeout = providerTimeout;

      // ── Provider-level shared cache: check before hitting the API ──
      const searchCacheKey = buildSearchCacheKey(queryParams);
      const cachedResults = osSearchCache.get(searchCacheKey);
      if (cachedResults) {
        log.debug(() => `[OpenSubtitles] Search cache HIT: ${searchCacheKey} (${cachedResults.length} subs)`);
        // Deep-clone: downstream code mutates objects (season pack fileId, etc.)
        let subtitles = cachedResults.map(s => ({ ...s }));
        // Jump to episode filtering (skip API call entirely)
        return this._postProcessSearchResults(subtitles, type, season, episode, convertedLanguages);
      }

      // Rate-limit + 429 retry: throttle locally and retry once if still rate-limited
      await acquireToken();
      let response;
      try {
        response = await this.client.get('/subtitles', requestConfig);
      } catch (searchErr) {
        const status = searchErr?.response?.status;
        if (status === 429) {
          // Parse retry-after header or fall back to 1.5s
          const retryAfter = parseInt(searchErr.response?.headers?.['ratelimit-reset'] || searchErr.response?.headers?.['retry-after'], 10);
          const waitMs = (retryAfter && retryAfter > 0 && retryAfter <= 10) ? retryAfter * 1000 : 1500;
          log.warn(() => `[OpenSubtitles] Search 429 rate limited, retrying in ${waitMs}ms`);
          await new Promise(r => setTimeout(r, waitMs));
          await acquireToken();
          response = await this.client.get('/subtitles', requestConfig);
        } else {
          throw searchErr;
        }
      }

      if (!response.data || !response.data.data || response.data.data.length === 0) {
        log.debug(() => '[OpenSubtitles] No subtitles found in response');
        return [];
      }

      let subtitles = response.data.data.map(sub => {

        const originalLang = sub.attributes.language;
        const normalizedLang = this.normalizeLanguageCode(originalLang);
        const fileId = sub.attributes.files?.[0]?.file_id || sub.id;
        const fileName = sub.attributes.files?.[0]?.file_name || '';
        const detectedFormat = sub.attributes.format || inferFormatFromFilename(fileName) || 'srt';
        const releaseName = sub.attributes.release || '';
        const cleanedName = stripExtension(fileName);
        const displayName = releaseName || cleanedName || sub.attributes.feature_details?.movie_name || 'Unknown';

        // OpenSubtitles API returns moviehash_match when moviehash was sent in query
        const isHashMatch = sub.attributes.moviehash_match === true;

        return {
          id: String(fileId),
          language: originalLang,
          languageCode: normalizedLang,
          name: displayName,
          downloads: parseInt(sub.attributes.download_count) || 0,
          rating: parseFloat(sub.attributes.ratings) || 0,
          uploadDate: sub.attributes.upload_date,
          format: detectedFormat,
          fileId: String(fileId),
          downloadLink: sub.attributes.url,
          originalFilename: fileName || null,
          hearing_impaired: isTrueishFlag(sub.attributes.hearing_impaired),
          foreign_parts_only: sub.attributes.foreign_parts_only || false,
          machine_translated: sub.attributes.machine_translated || false,
          uploader: sub.attributes.uploader?.name || 'Unknown',
          provider: 'opensubtitles',
          hashMatch: isHashMatch,
          hashMatchPriority: isHashMatch ? 0 : undefined
        };
      });

      // Store raw mapped results in shared cache (before episode filtering mutates them)
      osSearchCache.set(searchCacheKey, subtitles.map(s => ({ ...s })));
      log.debug(() => `[OpenSubtitles] Search cache STORE: ${searchCacheKey} (${subtitles.length} subs)`);

      return this._postProcessSearchResults(subtitles, type, season, episode, convertedLanguages);

    } catch (error) {
      return handleSearchError(error, 'OpenSubtitles');
    }
  }

  /**
   * Post-process raw mapped search results: episode filtering, season pack
   * detection, and per-language limiting.
   * Extracted so both the live API path and the cache-hit path share the same
   * logic without duplication.
   * @param {Array} subtitles - Raw mapped subtitle objects
   * @param {string} type - Content type (movie, episode, anime-episode)
   * @param {number} season - Season number
   * @param {number} episode - Episode number
   * @param {string[]} convertedLanguages - Languages used in the query (for logging)
   * @returns {Array} - Filtered and limited subtitle results
   * @private
   */
  _postProcessSearchResults(subtitles, type, season, episode, convertedLanguages) {
    // Client-side episode filtering and season pack detection
    if ((type === 'episode' || type === 'anime-episode') && episode) {
      const targetSeason = season || 1;
      const targetEpisode = episode;

      const beforeCount = subtitles.length;

      subtitles = subtitles.filter(sub => {
        const name = String(sub.name || '').toLowerCase();

        // Season pack patterns
        const seasonPackPatterns = [
          new RegExp(`(?:complete|full|entire)?\\s*(?:season|s)\\s*0*${targetSeason}(?:\\s+(?:complete|full|pack))?(?!.*e0*\\\d)`, 'i'),
          new RegExp(`(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\\s+season(?!.*episode)`, 'i'),
          new RegExp(`s0*${targetSeason}\\s*(?:complete|full|pack)`, 'i')
        ];

        // Anime pack patterns
        const animeSeasonPackPatterns = [
          /(?:complete|batch|full(?:\s+series)?|\d{1,2}\s*[-~]\s*\d{1,2})/i,
          /\[(?:batch|complete|full)\]/i,
          /(?:episode\s*)?(?:01|001)\s*[-~]\s*(?:\d{2}|\d{3})/i
        ];

        let isSeasonPack = false;
        if (type === 'anime-episode') {
          isSeasonPack = animeSeasonPackPatterns.some(p => p.test(name)) &&
            !new RegExp(`(?:^|[^0-9])0*${targetEpisode}(?:v\\d+)?(?:[^0-9]|$)`, 'i').test(name);
        } else {
          isSeasonPack = seasonPackPatterns.some(p => p.test(name)) &&
            !/s0*\d+e0*\d+|\d+x\d+|episode\s*\d+|ep\s*\d+/i.test(name);
        }

        if (isSeasonPack) {
          sub.is_season_pack = true;
          sub.season_pack_season = targetSeason;
          sub.season_pack_episode = targetEpisode;
          const originalFileId = sub.fileId || sub.id;
          sub.fileId = `${originalFileId}_seasonpack_s${targetSeason}e${targetEpisode}`;
          sub.id = sub.fileId;
          log.debug(() => `[OpenSubtitles] Detected season pack: ${sub.name}`);
          return true;
        }

        // Episode match patterns
        const seasonEpisodePatterns = [
          new RegExp(`s0*${targetSeason}e0*${targetEpisode}(?![0-9])`, 'i'),
          new RegExp(`${targetSeason}x0*${targetEpisode}(?![0-9])`, 'i'),
          new RegExp(`s0*${targetSeason}[\\s._-]*x[\\s._-]*e?0*${targetEpisode}(?![0-9])`, 'i'), // S01xE01, S01x1
          new RegExp(`0*${targetSeason}[\\s._-]*x[\\s._-]*e?0*${targetEpisode}(?![0-9])`, 'i'),  // 01xE01, 1xE01
          new RegExp(`s0*${targetSeason}\\.e0*${targetEpisode}(?![0-9])`, 'i'),
          new RegExp(`season\\s*0*${targetSeason}.*episode\\s*0*${targetEpisode}(?![0-9])`, 'i')
        ];
        if (seasonEpisodePatterns.some(p => p.test(name))) return true;

        // If it explicitly references a different episode, exclude
        const m = name.match(/s0*(\d+)e0*(\d+)|(\d+)x0*(\d+)/i);
        if (m) {
          const subSeason = parseInt(m[1] || m[3], 10);
          const subEpisode = parseInt(m[2] || m[4], 10);
          if (subSeason === targetSeason && subEpisode !== targetEpisode) return false;
        }

        return true; // keep ambiguous
      });

      const filteredOut = beforeCount - subtitles.length;
      const seasonPackCount = subtitles.filter(s => s.is_season_pack).length;
      if (filteredOut > 0 || seasonPackCount > 0) {
        log.debug(() => `[OpenSubtitles] Episode filtering kept ${subtitles.length}/${beforeCount} (season packs: ${seasonPackCount})`);
      }
    }

    // Limit to 14 results per language to control response size
    const MAX_RESULTS_PER_LANGUAGE = 14;
    const groupedByLanguage = {};

    for (const sub of subtitles) {
      const lang = sub.languageCode || 'unknown';
      if (!groupedByLanguage[lang]) {
        groupedByLanguage[lang] = [];
      }
      if (groupedByLanguage[lang].length < MAX_RESULTS_PER_LANGUAGE) {
        groupedByLanguage[lang].push(sub);
      }
    }

    const limitedSubtitles = Object.values(groupedByLanguage).flat();
    log.debug(() => `[OpenSubtitles] Found ${subtitles.length} subtitles total, limited to ${limitedSubtitles.length} (max ${MAX_RESULTS_PER_LANGUAGE} per language)`);
    return limitedSubtitles;
  }

  /**
   * Download subtitle content via REST API
   * @param {string} fileId - File ID from search results
   * @returns {Promise<string>} - Subtitle content as text
   */
  async downloadSubtitle(fileId, options = {}) {
    const timeout = options?.timeout || 12000; // Default 12s
    try {
      log.debug(() => ['[OpenSubtitles] Downloading subtitle via REST API:', fileId]);

      // Parse season pack info encoded in fileId if present
      let baseFileId = String(fileId);
      let isSeasonPack = false;
      let seasonPackSeason = null;
      let seasonPackEpisode = null;
      const seasonPackMatch = String(fileId).match(/^(.*)_seasonpack_s(\d+)e(\d+)$/i);
      if (seasonPackMatch) {
        isSeasonPack = true;
        baseFileId = seasonPackMatch[1];
        seasonPackSeason = parseInt(seasonPackMatch[2], 10);
        seasonPackEpisode = parseInt(seasonPackMatch[3], 10);
        log.debug(() => `[OpenSubtitles] Season pack download detected for S${String(seasonPackSeason).padStart(2, '0')}E${String(seasonPackEpisode).padStart(2, '0')}`);
      }

      // Authenticate with user credentials (required)
      if (!this.config.username || !this.config.password) {
        log.warn(() => '[OpenSubtitles] Username and password are required. Please configure your OpenSubtitles credentials.');
        throw new Error('OpenSubtitles credentials not configured');
      }

      if (hasCachedAuthFailure(this.credentialsCacheKey)) {
        const authErr = new Error('OpenSubtitles authentication failed: invalid username/password');
        authErr.statusCode = 401;
        throw authErr;
      }

      if (await this.isTokenExpired()) {
        const loginResult = await this.login();
        if (!loginResult) {
          // Check if credentials are now cached as failed
          if (hasCachedAuthFailure(this.credentialsCacheKey)) {
            throw new Error('OpenSubtitles authentication failed: invalid username/password');
          }
          // Rate limit or other transient issue
          throw new Error('OpenSubtitles authentication temporarily unavailable. Try again later.');
        }
      }

      // First, request download link
      // Use the primary client so Api-Key is sent (required by OpenSubtitles for /download)
      await acquireToken(); // Rate-limit: wait for token before hitting OpenSubtitles API
      const downloadResponse = await this.client.post('/download', {
        file_id: parseInt(baseFileId)
      });

      if (!downloadResponse.data || !downloadResponse.data.link) {
        throw new Error('No download link received');
      }

      const downloadLink = downloadResponse.data.link;
      log.debug(() => ['[OpenSubtitles] Got download link:', downloadLink]);

      // Download the subtitle file as raw bytes to handle BOM/ZIP cases efficiently
      // Use a clean axios request for CDN downloads - don't send Api-Key/Authorization/Content-Type
      // headers to the CDN; those are only needed for the OpenSubtitles API, not the file CDN
      let subtitleResponse;
      try {
        subtitleResponse = await axios.get(downloadLink, {
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': USER_AGENT,
            'Accept': '*/*'
          },
          httpAgent,
          httpsAgent,
          lookup: dnsLookup,
          timeout: timeout,
          maxRedirects: 5,
          decompress: true
        });
      } catch (cdnError) {
        // CDN download errors (403/410 from Varnish) should NOT be reported as "Authentication failed"
        // These are file-level availability issues on OpenSubtitles' CDN, not credential problems
        const cdnStatus = cdnError.response?.status;
        if (cdnStatus === 403 || cdnStatus === 410) {
          const bodyStr = cdnError.response?.data
            ? (Buffer.isBuffer(cdnError.response.data)
              ? cdnError.response.data.toString('utf8').substring(0, 200)
              : String(cdnError.response.data).substring(0, 200))
            : '';
          const isVarnish = bodyStr.includes('Varnish') || bodyStr.includes('Guru Meditation');
          const hint = cdnStatus === 410 ? 'expired download link' : (isVarnish ? 'file unavailable on CDN' : 'CDN access denied');
          log.warn(() => `[OpenSubtitles] CDN download failed (${cdnStatus}): ${hint}`);
          const err = new Error(`Subtitle file unavailable on OpenSubtitles CDN (${cdnStatus} ${hint}). Try a different subtitle.`);
          err.statusCode = cdnStatus;
          err.type = 'cdn_unavailable';
          err._alreadyLogged = true;
          throw err;
        }
        throw cdnError; // re-throw other errors for default handling
      }

      const buf = Buffer.isBuffer(subtitleResponse.data)
        ? subtitleResponse.data
        : Buffer.from(subtitleResponse.data);

      // Analyze response content to detect HTML error pages, Cloudflare blocks, etc.
      const contentAnalysis = analyzeResponseContent(buf);

      // Check for archive by magic bytes (ZIP, RAR, Gzip, 7z, Tar, etc.)
      const archiveType = detectArchiveType(buf);

      if (archiveType) {
        log.debug(() => `[OpenSubtitles] Detected ${archiveType.toUpperCase()} archive`);

        // Use the centralized archive extractor
        return await extractSubtitleFromArchive(buf, {
          providerName: 'OpenSubtitles',
          maxBytes: MAX_ZIP_BYTES,
          isSeasonPack: isSeasonPack,
          season: seasonPackSeason,
          episode: seasonPackEpisode,
          languageHint: options.languageHint || null,
          skipAssConversion: options.skipAssConversion
        });
      }

      // If not an archive, check if it's an error response (HTML, Cloudflare, etc.)
      if (contentAnalysis.type !== 'subtitle' && contentAnalysis.type !== 'unknown') {
        if (contentAnalysis.type.startsWith('html') || contentAnalysis.type === 'json_error' || contentAnalysis.type === 'text_error' || contentAnalysis.type === 'empty' || contentAnalysis.type === 'truncated') {
          log.error(() => `[OpenSubtitles] Download failed: ${contentAnalysis.type} - ${contentAnalysis.hint}`);
          return createInvalidResponseSubtitle('OpenSubtitles', contentAnalysis, buf.length);
        }
      }

      // Non-ZIP: use centralized encoding detector for proper Arabic/Hebrew/RTL support
      let text = detectAndConvertEncoding(buf, 'OpenSubtitles', options.languageHint || null);

      const trimmed = (text || '').trimStart();
      if (trimmed.startsWith('WEBVTT')) {
        log.debug(() => '[OpenSubtitles] Detected VTT; returning original VTT');
        return text;
      }

      // If content looks like ASS/SSA, convert to VTT using centralized converter
      if (/\[events\]/i.test(text) || /^dialogue\s*:/im.test(text)) {
        log.debug(() => '[OpenSubtitles] Detected ASS/SSA format, using centralized converter');
        return await convertSubtitleToVtt(text, 'subtitle.ass', 'OpenSubtitles', { skipAssConversion: options.skipAssConversion });
      }

      log.debug(() => '[OpenSubtitles] Subtitle downloaded successfully');
      return text;

    } catch (error) {
      handleDownloadError(error, 'OpenSubtitles', { logResponseData: true, truncateResponseData: 400 });
    }
  }

  /**
   * Normalize language code to ISO-639-2 for Stremio
   * @param {string} language - Language code or name from OpenSubtitles (ISO-639-2)
   * @returns {string} - ISO-639-2 language code (3-letter)
   */
  normalizeLanguageCode(language) {
    if (!language) return null;

    const lower = language.toLowerCase().trim();

    // Map OpenSubtitles language names to ISO-639-2 codes
    const languageNameMap = {
      'english': 'eng',
      'spanish': 'spa',
      'french': 'fre',
      'german': 'ger',
      'italian': 'ita',
      'portuguese': 'por',
      'russian': 'rus',
      'japanese': 'jpn',
      'chinese': 'chi',
      'korean': 'kor',
      'arabic': 'ara',
      'dutch': 'dut',
      'polish': 'pol',
      'turkish': 'tur',
      'swedish': 'swe',
      'norwegian': 'nor',
      'danish': 'dan',
      'finnish': 'fin',
      'greek': 'gre',
      'hebrew': 'heb',
      'hindi': 'hin',
      'czech': 'cze',
      'hungarian': 'hun',
      'romanian': 'rum',
      'thai': 'tha',
      'vietnamese': 'vie',
      'indonesian': 'ind',
      'malay': 'may',
      'ukrainian': 'ukr',
      'bulgarian': 'bul',
      'croatian': 'hrv',
      'serbian': 'srp',
      'slovak': 'slo',
      'slovenian': 'slv',
      'estonian': 'est',
      'latvian': 'lav',
      'lithuanian': 'lit',
      'farsi': 'per',
      'persian': 'per',
      'bengali': 'ben',
      'catalan': 'cat',
      'basque': 'baq',
      'galician': 'glg',
      'bosnian': 'bos',
      'macedonian': 'mac',
      'albanian': 'alb',
      'belarusian': 'bel',
      'azerbaijani': 'aze',
      'georgian': 'geo',
      'malayalam': 'mal',
      'tamil': 'tam',
      'telugu': 'tel',
      'urdu': 'urd',
      'tagalog': 'tgl',
      'icelandic': 'ice',
      'kurdish': 'kur',
      'afrikaans': 'afr',
      'armenian': 'arm',
      'kazakh': 'kaz',
      'mongolian': 'mon',
      'nepali': 'nep',
      'punjabi': 'pan',
      'sinhala': 'sin',
      'swahili': 'swa',
      'uzbek': 'uzb',
      'amharic': 'amh',
      'burmese': 'bur',
      'khmer': 'khm',
      'central khmer': 'khm',
      'lao': 'lao',
      'pashto': 'pus',
      'somali': 'som',
      'sinhalese': 'sin'
    };

    // Check if it's a full language name
    if (languageNameMap[lower]) {
      return languageNameMap[lower];
    }

    // Handle special cases for regional variants per OpenSubtitles API format
    if (lower.includes('portuguese') && (lower.includes('brazil') || lower.includes('br'))) {
      return 'pob';
    }
    if (lower === 'brazilian' || lower === 'pt-br' || lower === 'ptbr') {
      return 'pob';
    }

    // Spanish (Latin America) short code sometimes appears as 'ea'
    if (lower === 'ea') {
      return 'spn';
    }

    // OS two-letter or variant codes requiring explicit mapping
    if (lower === 'sx') return 'sat'; // Santali
    if (lower === 'at') return 'ast'; // Asturian
    if (lower === 'pr') return 'per'; // Dari -> Persian macro
    if (lower === 'ex') return 'ext'; // Extremaduran (639-3)
    if (lower === 'ma') return 'mni'; // Manipuri
    if (lower === 'pm') return 'por'; // Portuguese (Mozambique)
    if (lower === 'sp') return 'spa'; // Spanish (EU)
    if (lower === 'sy') return 'syr'; // Syriac
    if (lower === 'tm-td') return 'tet'; // Tetum
    if (lower === 'tp') return 'tok'; // Toki Pona (639-3)

    // Handle Chinese variants per OpenSubtitles API format
    if (lower === 'zh-cn' || lower === 'zhcn' || (lower.includes('chinese') && lower.includes('simplified'))) {
      return 'zhs';
    }
    if (lower === 'zh-tw' || lower === 'zhtw' || (lower.includes('chinese') && lower.includes('traditional'))) {
      return 'zht';
    }
    if (lower === 'ze' || lower === 'chinese bilingual') {
      return 'ze';
    }

    // Handle Montenegrin
    if (lower === 'me' || lower === 'montenegrin') {
      return 'mne';
    }

    // Normalize region-style codes like 'pt-PT', 'az-ZB' to base ISO-639-2
    // Keep 'pt-br' handled above to map specifically to 'pob'
    const regionMatch = lower.match(/^([a-z]{2})-[a-z0-9]{2,}$/);
    if (regionMatch) {
      const base = regionMatch[1];
      // Map 'pt-pt' explicitly to Portuguese
      if (lower === 'pt-pt') {
        return 'por';
      }
      const iso2Codes = toISO6392(base);
      if (iso2Codes && iso2Codes.length > 0) {
        return iso2Codes[0].code2; // Convert base to ISO-639-2
      }
    }

    // If it's already 3 letters, assume it's ISO-639-2
    if (lower.length === 3 && /^[a-z]{3}$/.test(lower)) {
      return lower;
    }

    // If it's 2 letters, convert from ISO-639-1 to ISO-639-2
    if (lower.length === 2 && /^[a-z]{2}$/.test(lower)) {
      const iso2Codes = toISO6392(lower);
      if (iso2Codes && iso2Codes.length > 0) {
        return iso2Codes[0].code2; // Return the first ISO-639-2 code
      }
    }

    // Unknown language
    log.warn(() => `[OpenSubtitles] Unknown language format: "${language}", filtering out`);
    return null;
  }
}

// Support both `require()` direct and `{ OpenSubtitlesService }` destructured imports
module.exports = OpenSubtitlesService;
module.exports.OpenSubtitlesService = OpenSubtitlesService;
module.exports.getCachedToken = getCachedToken;
module.exports.getCredentialsCacheKey = getCredentialsCacheKey;

