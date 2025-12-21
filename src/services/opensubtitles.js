const axios = require('axios');
const crypto = require('crypto');
const { toISO6391, toISO6392 } = require('../utils/languages');
const { handleSearchError, handleDownloadError, handleAuthError, parseApiError } = require('../utils/apiErrorHandler');
const { httpAgent, httpsAgent, dnsLookup } = require('../utils/httpAgents');
const { detectAndConvertEncoding } = require('../utils/encodingDetector');
const { version } = require('../utils/version');
const { appendHiddenInformationalNote } = require('../utils/subtitle');
const log = require('../utils/logger');
const { isTrueishFlag } = require('../utils/subtitleFlags');

const OPENSUBTITLES_API_URL = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = `SubMaker v${version}`;
const MAX_ZIP_BYTES = 25 * 1024 * 1024; // hard cap for ZIP downloads (~25MB) to avoid huge packs

const AUTH_FAILURE_TTL_MS = 5 * 60 * 1000; // Keep invalid credentials blocked for 5 minutes
const credentialFailureCache = new Map();

// Static token cache: shared across all instances with the same credentials
// Key: credentialsCacheKey (hash of username:password), Value: { token, expiry }
const tokenCache = new Map();

// Login mutex: prevents multiple concurrent /login calls for the same credentials
// Key: credentialsCacheKey, Value: Promise that resolves when login completes
const loginMutex = new Map();

/**
 * Get cached token for credentials (if valid)
 * @param {string} cacheKey - Credentials cache key
 * @returns {{ token: string, expiry: number } | null}
 */
function getCachedToken(cacheKey) {
  if (!cacheKey) return null;
  const cached = tokenCache.get(cacheKey);
  if (!cached) return null;
  // Check if token is still valid (with 1 minute buffer)
  if (Date.now() >= cached.expiry - 60000) {
    tokenCache.delete(cacheKey);
    return null;
  }
  return cached;
}

/**
 * Store token in static cache
 * @param {string} cacheKey - Credentials cache key
 * @param {string} token - JWT token
 * @param {number} expiry - Expiry timestamp
 */
function setCachedToken(cacheKey, token, expiry) {
  if (!cacheKey || !token) return;
  tokenCache.set(cacheKey, { token, expiry });
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
  if (status === 401 || status === 403) {
    return true;
  }

  const message = String(error.response?.data?.message || error.message || '').toLowerCase();
  if (message.includes('invalid username') || message.includes('invalid credentials') || message.includes('usernamepassword')) {
    return true;
  }

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
 * Create an informative SRT subtitle when an episode is not found in a season pack
 * @param {number} episode - Episode number that was not found
 * @param {number} season - Season number
 * @param {Array<string>} availableFiles - List of files that were found in the pack
 * @returns {string} - SRT subtitle content
 */
function createEpisodeNotFoundSubtitle(episode, season, availableFiles = []) {
  try {
    const seasonEpisodeStr = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

    const foundEpisodes = (availableFiles || [])
      .map(filename => {
        // Match explicit episode labels (Episode 12, Ep12, Cap 12, etc.)
        const labeled = String(filename || '').match(/(?:episode|episodio|capitulo|cap|ep|e|ova|oad)\s*(\d{1,4})/i);
        if (labeled && labeled[1]) return parseInt(labeled[1], 10);

        // Fallback: any standalone 1-4 digit number not obviously a resolution/year
        const generic = String(filename || '').match(/(?:^|[^0-9])(\d{1,4})(?=[^0-9]|$)/);
        if (generic && generic[1]) {
          const n = parseInt(generic[1], 10);
          if (Number.isNaN(n)) return null;
          if ([480, 720, 1080, 2160].includes(n)) return null;
          if (n >= 1900 && n <= 2099) return null;
          return n;
        }
        return null;
      })
      .filter(ep => ep !== null && ep < 4000)
      .sort((a, b) => a - b);

    const uniqueEpisodes = [...new Set(foundEpisodes)];
    const availableInfo = uniqueEpisodes.length > 0
      ? `Pack contains ~${uniqueEpisodes.length} files, episodes ${uniqueEpisodes[0]}-${uniqueEpisodes[uniqueEpisodes.length - 1]}`
      : 'No episode numbers detected in pack.';

    const message = `1
00:00:00,000 --> 04:00:00,000
Episode ${seasonEpisodeStr} not found in this subtitle pack.
${availableInfo}
Try another subtitle or a different provider.`;

    return appendHiddenInformationalNote(message);
  } catch (_) {
    const fallback = `1
00:00:00,000 --> 04:00:00,000
Episode not found in this subtitle pack.
`;
    return appendHiddenInformationalNote(fallback);
  }
}

// Create a concise SRT when a ZIP is too large to process
function createZipTooLargeSubtitle(limitBytes, actualBytes) {
  const toMb = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;
  const limitMb = toMb(limitBytes);
  const actualMb = toMb(actualBytes);

  const message = `1
00:00:00,000 --> 04:00:00,000
Subtitle pack is too large to process.
Size: ${actualMb} MB (limit: ${limitMb} MB).
Please pick another subtitle or provider.`;

  return appendHiddenInformationalNote(message);
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

    // Load token from static cache if available (shared across instances)
    const cached = getCachedToken(this.credentialsCacheKey);
    if (cached) {
      this.token = cached.token;
      this.tokenExpiry = cached.expiry;
    } else {
      this.token = null;
      this.tokenExpiry = null;
    }

    // Read API key at runtime (not at module load time)
    const apiKey = getOpenSubtitlesApiKey();

    // Base axios configuration
    const defaultHeaders = {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate, br'
    };

    // Add API key if configured (only for search/auth flows)
    if (apiKey) {
      defaultHeaders['Api-Key'] = apiKey;
      // Only log once at startup
      if (!OpenSubtitlesService.initLogged) {
        log.warn(() => '[OpenSubtitles] API key loaded successfully from environment');
      }
    }

    const baseAxiosConfig = {
      baseURL: OPENSUBTITLES_API_URL,
      headers: defaultHeaders,
      httpAgent,
      httpsAgent,
      lookup: dnsLookup,
      timeout: 10000,
      maxRedirects: 5,
      decompress: true
    };

    // Primary client (search/auth) uses Api-Key
    this.client = axios.create(baseAxiosConfig);

    // Download client must NOT send Api-Key, to avoid global key rate limits on downloads
    const downloadHeaders = { ...defaultHeaders };
    delete downloadHeaders['Api-Key'];
    delete downloadHeaders['api-key'];
    this.downloadClient = axios.create({
      ...baseAxiosConfig,
      headers: downloadHeaders
    });

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
        log.warn(() => '[OpenSubtitles] Initialized with user account authentication for higher rate limits');
      }

      // Mark as logged
      OpenSubtitlesService.initLogged = true;
    }

    // Add request interceptor to handle token refresh for user authentication
    const addAuthInterceptor = (axiosInstance) => {
      axiosInstance.interceptors.request.use((config) => {
        // Always check static cache for fresh token
        const cachedToken = getCachedToken(this.credentialsCacheKey);
        if (cachedToken) {
          this.token = cachedToken.token;
          this.tokenExpiry = cachedToken.expiry;
        }
        if (this.token && !this.isTokenExpired()) {
          config.headers['Authorization'] = `Bearer ${this.token}`;
        }
        return config;
      });
    };
    addAuthInterceptor(this.client);
    addAuthInterceptor(this.downloadClient);
  }

  /**
   * Check if token is expired (also checks static cache)
   * @returns {boolean}
   */
  isTokenExpired() {
    // First check static cache for a fresh token
    const cached = getCachedToken(this.credentialsCacheKey);
    if (cached) {
      this.token = cached.token;
      this.tokenExpiry = cached.expiry;
    }
    return !this.tokenExpiry || Date.now() >= this.tokenExpiry;
  }

  /**
   * Login with username and password to get JWT token
   * @param {string} username - OpenSubtitles username
   * @param {string} password - OpenSubtitles password
   * @returns {Promise<string>} - JWT token
   */
  async loginWithCredentials(username, password) {
    try {
      log.debug(() => ['[OpenSubtitles] Authenticating user:', username]);

      const response = await this.client.post('/login', {
        username: username,
        password: password
      });

      if (!response.data?.token) {
        throw new Error('No token received from authentication');
      }

      this.token = response.data.token;
      // Token is valid for 24 hours
      this.tokenExpiry = Date.now() + (24 * 60 * 60 * 1000);

      // Store in static cache for reuse by other instances
      setCachedToken(this.credentialsCacheKey, this.token, this.tokenExpiry);

      log.debug(() => '[OpenSubtitles] User authentication successful');
      clearCachedAuthFailure(this.credentialsCacheKey);
      return this.token;

    } catch (error) {
      // Classify the error so we don't mis-treat rate limits as bad credentials
      const parsed = parseApiError(error, 'OpenSubtitles');

      // Never cache an auth failure for retryable cases like 429/503
      if (parsed.type !== 'rate_limit' && parsed.statusCode !== 503 && isAuthenticationFailure(error)) {
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

      // For genuine auth failures and other client errors, log via auth handler and return null
      return handleAuthError(error, 'OpenSubtitles');
    }
  }

  /**
   * Login to OpenSubtitles REST API (optional, for higher download limits)
   * Uses mutex to serialize concurrent login attempts for the same credentials.
   * @returns {Promise<string|null>} - JWT token if credentials provided, null otherwise
   */
  async login() {
    if (!this.config.username || !this.config.password) {
      // No credentials provided, use basic API access
      return null;
    }

    if (hasCachedAuthFailure(this.credentialsCacheKey)) {
      log.warn(() => '[OpenSubtitles] Authentication blocked: cached invalid credentials detected');
      return null;
    }

    // Check if there's already a valid token in cache
    const cached = getCachedToken(this.credentialsCacheKey);
    if (cached) {
      this.token = cached.token;
      this.tokenExpiry = cached.expiry;
      log.debug(() => '[OpenSubtitles] Using cached token (shared across instances)');
      return this.token;
    }

    // Check if another request is already logging in with these credentials
    const existingMutex = loginMutex.get(this.credentialsCacheKey);
    if (existingMutex) {
      log.debug(() => '[OpenSubtitles] Waiting for existing login to complete (mutex)');
      try {
        const result = await existingMutex;
        // After mutex resolves, check cache again
        const freshCached = getCachedToken(this.credentialsCacheKey);
        if (freshCached) {
          this.token = freshCached.token;
          this.tokenExpiry = freshCached.expiry;
          return this.token;
        }
        return result;
      } catch (err) {
        // If the original login failed, we might need to retry
        // But only if it wasn't an auth failure
        if (!hasCachedAuthFailure(this.credentialsCacheKey)) {
          throw err;
        }
        return null;
      }
    }

    // Create a mutex promise for this login attempt
    let resolveMutex;
    let rejectMutex;
    const mutexPromise = new Promise((resolve, reject) => {
      resolveMutex = resolve;
      rejectMutex = reject;
    });
    loginMutex.set(this.credentialsCacheKey, mutexPromise);

    try {
      const result = await this.loginWithCredentials(this.config.username, this.config.password);
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
      // Authenticate with user credentials (required)
      if (!this.config.username || !this.config.password) {
        log.error(() => '[OpenSubtitles] Username and password are required. Please configure your OpenSubtitles credentials.');
        return [];
      }

      if (hasCachedAuthFailure(this.credentialsCacheKey)) {
        const authErr = new Error('OpenSubtitles authentication failed: invalid username/password');
        authErr.statusCode = 401;
        authErr.authError = true;
        throw authErr;
      }

      if (this.isTokenExpired()) {
        const loginResult = await this.login();
        if (!loginResult) {
          // Authentication failed; surface this so callers can react (e.g., append UX hint entries)
          const authErr = new Error('OpenSubtitles authentication failed: invalid username/password');
          authErr.statusCode = 400;
          authErr.authError = true;
          throw authErr;
        }
      }

      const { imdb_id, type, season, episode, languages, excludeHearingImpairedSubtitles } = params;

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

      log.debug(() => ['[OpenSubtitles] Searching with params:', JSON.stringify(queryParams)]);
      if (this.token) {
        log.debug(() => '[OpenSubtitles] Using user account authentication');
      } else {
        log.debug(() => '[OpenSubtitles] Using basic API access');
      }

      const response = await this.client.get('/subtitles', {
        params: queryParams
      });

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
          provider: 'opensubtitles'
        };
      });

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

    } catch (error) {
      return handleSearchError(error, 'OpenSubtitles');
    }
  }

  /**
   * Download subtitle content via REST API
   * @param {string} fileId - File ID from search results
   * @returns {Promise<string>} - Subtitle content as text
   */
  async downloadSubtitle(fileId) {
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
        log.error(() => '[OpenSubtitles] Username and password are required. Please configure your OpenSubtitles credentials.');
        throw new Error('OpenSubtitles credentials not configured');
      }

      if (hasCachedAuthFailure(this.credentialsCacheKey)) {
        const authErr = new Error('OpenSubtitles authentication failed: invalid username/password');
        authErr.statusCode = 401;
        throw authErr;
      }

      if (this.isTokenExpired()) {
        const loginResult = await this.login();
        if (!loginResult) {
          // Authentication failed, handleAuthError already logged it
          throw new Error('OpenSubtitles authentication failed');
        }
      }

      // First, request download link
      // Use the primary client so Api-Key is sent (required by OpenSubtitles for /download)
      const downloadResponse = await this.client.post('/download', {
        file_id: parseInt(baseFileId)
      });

      if (!downloadResponse.data || !downloadResponse.data.link) {
        throw new Error('No download link received');
      }

      const downloadLink = downloadResponse.data.link;
      log.debug(() => ['[OpenSubtitles] Got download link:', downloadLink]);

      // Download the subtitle file as raw bytes to handle BOM/ZIP cases efficiently
      const subtitleResponse = await this.downloadClient.get(downloadLink, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': USER_AGENT },
        timeout: 12000
      });

      const buf = Buffer.isBuffer(subtitleResponse.data)
        ? subtitleResponse.data
        : Buffer.from(subtitleResponse.data);

      // ZIP by magic bytes: 50 4B 03 04
      const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;

      if (isZip) {
        if (buf.length > MAX_ZIP_BYTES) {
          log.warn(() => `[OpenSubtitles] ZIP too large (${buf.length} bytes > ${MAX_ZIP_BYTES}); returning info subtitle instead of parsing`);
          return createZipTooLargeSubtitle(MAX_ZIP_BYTES, buf.length);
        }

        const JSZip = require('jszip');
        let zip;
        try {
          zip = await JSZip.loadAsync(buf, { base64: false });
        } catch (zipErr) {
          log.error(() => ['[OpenSubtitles] Failed to parse ZIP file:', zipErr.message]);
          // Return informative subtitle instead of throwing
          const message = `1
00:00:00,000 --> 04:00:00,000
OpenSubtitles download failed: Corrupted ZIP file
The subtitle file appears to be damaged or incomplete.
Try selecting a different subtitle.`;
          return appendHiddenInformationalNote(message);
        }
        const entries = Object.keys(zip.files);
        // Season pack handling: select the requested episode inside the ZIP
        if (isSeasonPack && seasonPackSeason && seasonPackEpisode) {
          log.debug(() => `[OpenSubtitles] Searching for S${String(seasonPackSeason).padStart(2, '0')}E${String(seasonPackEpisode).padStart(2, '0')} in season pack ZIP`);
          log.debug(() => `[OpenSubtitles] Available files in ZIP: ${entries.join(', ')}`);

          const findEpisodeFile = (files, season, episode) => {
            const patterns = [
              new RegExp(`s0*${season}e0*${episode}(?:v\\d+)?`, 'i'),
              new RegExp(`${season}x0*${episode}(?:v\\d+)?`, 'i'),
              new RegExp(`s0*${season}[\\s._-]*x[\\s._-]*e?0*${episode}(?:v\\d+)?`, 'i'),
              new RegExp(`0*${season}[\\s._-]*x[\\s._-]*e?0*${episode}(?:v\\d+)?`, 'i'),
              new RegExp(`season\\s*0*${season}.*episode\\s*0*${episode}`, 'i'),
              new RegExp(`s0*${season}\\.e0*${episode}(?:v\\d+)?`, 'i')
            ];
            for (const filename of files) {
              if (zip.files[filename].dir) continue;
              const lower = filename.toLowerCase();
              if (patterns.some(p => p.test(lower))) return filename;
            }
            return null;
          };

          const findEpisodeFileAnime = (files, episode) => {
            const patterns = [
              new RegExp(`(?<=\\b|\\s|\\[|\\(|-|_)e(?:p(?:isode)?)?[\\s._-]*0*${episode}(?:v\\d+)?(?=\\b|\\s|\\]|\\)|\\.|-|_|$)`, 'i'),
              new RegExp(`(?:^|[\\s\\[\\(\\-_.])0*${episode}(?:v\\d+)?(?=$|[\\s\\[\\]\\(\\)\\-_.])`, 'i'),
              new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${episode}(?:v\\d+)?[a-z]{2,3}(?=\\.|[\\s\\[\\]\\(\\)\\-_.]|$)`, 'i'),
              new RegExp(`(?:episode|episodio|ep|cap(?:itulo)?)\\s*0*${episode}(?![0-9])`, 'i'),
              new RegExp(`第?\\s*0*${episode}\\s*(?:話|集|화)`, 'i'),
              new RegExp(`^(?!.*(?:720|1080|480|2160)p).*[\\[\\(\\-_\\s]0*${episode}[\\]\\)\\-_\\s\\.]`, 'i')
            ];
            for (const filename of files) {
              if (zip.files[filename].dir) continue;
              const lower = filename.toLowerCase();
              if (/(?:720|1080|480|2160)p|(?:19|20)\d{2}/.test(lower)) {
                const episodeStr = String(episode).padStart(2, '0');
                if (lower.includes(`${episodeStr}p`) || lower.includes(`20${episodeStr}`)) {
                  continue;
                }
              }
              if (patterns.some(p => p.test(lower))) return filename;
            }
            return null;
          };

          // Prefer SRT files
          const srtFiles = entries.filter(n => n.toLowerCase().endsWith('.srt') && !zip.files[n].dir);
          let targetEntry = findEpisodeFileAnime(srtFiles, seasonPackEpisode) ||
            findEpisodeFile(srtFiles, seasonPackSeason, seasonPackEpisode);

          if (!targetEntry) {
            targetEntry = findEpisodeFileAnime(entries, seasonPackEpisode) ||
              findEpisodeFile(entries, seasonPackSeason, seasonPackEpisode);
          }

          if (!targetEntry) {
            log.warn(() => `[OpenSubtitles] Could not find requested episode in season pack ZIP`);
            return createEpisodeNotFoundSubtitle(seasonPackEpisode, seasonPackSeason, entries);
          }

          if (targetEntry.toLowerCase().endsWith('.srt')) {
            const buffer = await zip.files[targetEntry].async('nodebuffer');
            const srt = detectAndConvertEncoding(buffer, 'OpenSubtitles');
            log.debug(() => '[OpenSubtitles] Extracted episode .srt from season pack');
            return srt;
          }

          // Non-SRT in season pack: fall through to alternate-format path by emulating altEntry
          const altEntry = targetEntry;
          const uint8 = await zip.files[altEntry].async('uint8array');
          const abuf = Buffer.from(uint8);
          let raw;
          if (abuf.length >= 2 && abuf[0] === 0xFF && abuf[1] === 0xFE) raw = abuf.slice(2).toString('utf16le');
          else if (abuf.length >= 2 && abuf[0] === 0xFE && abuf[1] === 0xFF) {
            const swapped = Buffer.allocUnsafe(Math.max(0, abuf.length - 2));
            for (let i = 2, j = 0; i + 1 < abuf.length; i += 2, j += 2) { swapped[j] = abuf[i + 1]; swapped[j + 1] = abuf[i]; }
            raw = swapped.toString('utf16le');
          } else raw = abuf.toString('utf8');
          // Strip UTF-8 BOM if present to avoid corrupting first cue/id
          if (raw && typeof raw === 'string') raw = raw.replace(/^\uFEFF/, '');

          const lname = altEntry.toLowerCase();
          if (lname.endsWith('.vtt')) return raw;

          if (lname.endsWith('.sub')) {
            const isMicroDVD = /^\s*\{\d+\}\{\d+\}/.test(raw);
            if (!isMicroDVD) {
              log.warn(() => `[OpenSubtitles] Detected VobSub .sub format (binary/image-based): ${altEntry} - not supported`);
            } else {
              try {
                const subsrt = require('subsrt-ts');
                const fps = 25;
                const converted = subsrt.convert(raw, { to: 'vtt', from: 'sub', fps });
                if (converted && typeof converted === 'string' && converted.trim().length > 0) return converted;
              } catch (_) { /* ignore */ }
            }
          }

          if (lname.endsWith('.ass') || lname.endsWith('.ssa')) {
            const assConverter = require('../utils/assConverter');
            const format = lname.endsWith('.ass') ? 'ass' : 'ssa';
            const result = assConverter.convertASSToVTT(raw, format);
            if (result.success) return result.content;
          }
          try {
            const subsrt = require('subsrt-ts');
            let converted;
            if (lname.endsWith('.ass')) converted = subsrt.convert(raw, { to: 'vtt', from: 'ass' });
            else if (lname.endsWith('.ssa')) converted = subsrt.convert(raw, { to: 'vtt', from: 'ssa' });
            else converted = subsrt.convert(raw, { to: 'vtt' });
            if (!converted || typeof converted !== 'string' || converted.trim().length === 0) {
              const sanitized = (raw || '').replace(/\u0000/g, '');
              if (lname.endsWith('.ass')) converted = subsrt.convert(sanitized, { to: 'vtt', from: 'ass' });
              else if (lname.endsWith('.ssa')) converted = subsrt.convert(sanitized, { to: 'vtt', from: 'ssa' });
              else converted = subsrt.convert(sanitized, { to: 'vtt' });
            }
            if (converted && converted.trim().length > 0) return converted;
          } catch (_) { /* ignore */ }

          const manual = (function assToVttFallback(input) {
            if (!input || !/\[events\]/i.test(input)) return null;
            const lines = input.split(/\r?\n/); let format = []; let inEvents = false;
            for (const line of lines) {
              const l = line.trim(); if (/^\[events\]/i.test(l)) { inEvents = true; continue; }
              if (!inEvents) continue; if (/^\[.*\]/.test(l)) break;
              if (/^format\s*:/i.test(l)) format = l.split(':')[1].split(',').map(s => s.trim().toLowerCase());
            }
            const idxStart = Math.max(0, format.indexOf('start'));
            const idxEnd = Math.max(1, format.indexOf('end'));
            const idxText = format.length > 0 ? Math.max(format.indexOf('text'), format.length - 1) : 9;
            const out = ['WEBVTT', ''];
            const parseTime = (t) => {
              const m = t.trim().match(/(\d+):(\d{2}):(\d{2})[\.\:](\d{2})/);
              if (!m) return null; const h = +m[1] || 0, mi = +m[2] || 0, s = +m[3] || 0, cs = +m[4] || 0;
              const ms = (h * 3600 + mi * 60 + s) * 1000 + cs * 10; const hh = String(Math.floor(ms / 3600000)).padStart(2, '0');
              const mm = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0'); const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
              const mmm = String(ms % 1000).padStart(3, '0'); return `${hh}:${mm}:${ss}.${mmm}`;
            };
            const cleanText = (txt) => {
              let t = txt.replace(/\{[^}]*\}/g, ''); t = t.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');
              t = t.replace(/[\u0000-\u001F]/g, ''); return t.trim();
            };
            for (const line of lines) {
              if (!/^dialogue\s*:/i.test(line)) continue; const payload = line.split(':').slice(1).join(':');
              const parts = []; let cur = ''; let splits = 0; for (let i = 0; i < payload.length; i++) { const ch = payload[i]; if (ch === ',' && splits < Math.max(idxText, 9)) { parts.push(cur); cur = ''; splits++; } else { cur += ch; } }
              parts.push(cur); const st = parseTime(parts[idxStart]); const et = parseTime(parts[idxEnd]); if (!st || !et) continue;
              const ct = cleanText(parts[idxText] ?? ''); if (!ct) continue; out.push(`${st} --> ${et}`); out.push(ct); out.push('');
            }
            return out.length > 2 ? out.join('\n') : null;
          })(raw);
          if (manual && manual.trim().length > 0) return manual;
          throw new Error('Failed to extract or convert subtitle from season pack ZIP');
        }
        const srtEntry = entries.find(f => f.toLowerCase().endsWith('.srt'));
        if (srtEntry) {
          const buffer = await zip.files[srtEntry].async('nodebuffer');
          const srt = detectAndConvertEncoding(buffer, 'OpenSubtitles');
          log.debug(() => '[OpenSubtitles] Extracted .srt from ZIP');
          return srt;
        }
        const altEntry = entries.find(f => {
          const l = f.toLowerCase();
          return l.endsWith('.vtt') || l.endsWith('.ass') || l.endsWith('.ssa') || l.endsWith('.sub');
        });
        if (altEntry) {
          const uint8 = await zip.files[altEntry].async('uint8array');
          const abuf = Buffer.from(uint8);
          let raw;
          if (abuf.length >= 2 && abuf[0] === 0xFF && abuf[1] === 0xFE) raw = abuf.slice(2).toString('utf16le');
          else if (abuf.length >= 2 && abuf[0] === 0xFE && abuf[1] === 0xFF) {
            const swapped = Buffer.allocUnsafe(Math.max(0, abuf.length - 2));
            for (let i = 2, j = 0; i + 1 < abuf.length; i += 2, j += 2) { swapped[j] = abuf[i + 1]; swapped[j + 1] = abuf[i]; }
            raw = swapped.toString('utf16le');
          } else raw = abuf.toString('utf8');
          // Strip UTF-8 BOM if present to avoid corrupting first cue/id
          if (raw && typeof raw === 'string') raw = raw.replace(/^\uFEFF/, '');

          const lname = altEntry.toLowerCase();
          if (lname.endsWith('.vtt')) return raw;

          // Handle MicroDVD .sub files (text-based, frame-based timing)
          if (lname.endsWith('.sub')) {
            const isMicroDVD = /^\s*\{\d+\}\{\d+\}/.test(raw);
            if (isMicroDVD) {
              log.debug(() => `[OpenSubtitles] Detected MicroDVD .sub format: ${altEntry}`);
              try {
                const subsrt = require('subsrt-ts');
                const fps = 25;
                const converted = subsrt.convert(raw, { to: 'vtt', from: 'sub', fps: fps });
                if (converted && typeof converted === 'string' && converted.trim().length > 0) {
                  log.debug(() => `[OpenSubtitles] Converted MicroDVD .sub to .vtt successfully (fps=${fps})`);
                  return converted;
                }
              } catch (subErr) {
                log.error(() => ['[OpenSubtitles] Failed to convert MicroDVD .sub to .vtt:', subErr.message]);
              }
            } else {
              log.warn(() => `[OpenSubtitles] Detected VobSub .sub format (binary/image-based): ${altEntry} - not supported, skipping`);
            }
          }

          // Try library conversion, then manual fallback
          // Try enhanced ASS/SSA conversion first
          if (lname.endsWith('.ass') || lname.endsWith('.ssa')) {
            const assConverter = require('../utils/assConverter');
            const format = lname.endsWith('.ass') ? 'ass' : 'ssa';
            const result = assConverter.convertASSToVTT(raw, format);
            if (result.success) return result.content;
            log.debug(() => `[OpenSubtitles] Enhanced converter failed: ${result.error}, trying fallback`);
          }

          try {
            const subsrt = require('subsrt-ts');
            let converted;
            if (lname.endsWith('.ass')) converted = subsrt.convert(raw, { to: 'vtt', from: 'ass' });
            else if (lname.endsWith('.ssa')) converted = subsrt.convert(raw, { to: 'vtt', from: 'ssa' });
            else converted = subsrt.convert(raw, { to: 'vtt' });
            if (!converted || typeof converted !== 'string' || converted.trim().length === 0) {
              const sanitized = (raw || '').replace(/\u0000/g, '');
              if (sanitized && sanitized !== raw) {
                if (lname.endsWith('.ass')) converted = subsrt.convert(sanitized, { to: 'vtt', from: 'ass' });
                else if (lname.endsWith('.ssa')) converted = subsrt.convert(sanitized, { to: 'vtt', from: 'ssa' });
                else converted = subsrt.convert(sanitized, { to: 'vtt' });
              }
            }
            if (converted && converted.trim().length > 0) return converted;
            throw new Error('Empty VTT after conversion');
          } catch (_) {
            const manual = (function assToVttFallback(input) {
              if (!input || !/\[events\]/i.test(input)) return null;
              const lines = input.split(/\r?\n/); let format = []; let inEvents = false;
              for (const line of lines) {
                const l = line.trim();
                if (/^\[events\]/i.test(l)) { inEvents = true; continue; }
                if (!inEvents) continue;
                if (/^\[.*\]/.test(l)) break;
                if (/^format\s*:/i.test(l)) format = l.split(':')[1].split(',').map(s => s.trim().toLowerCase());
              }
              const idxStart = Math.max(0, format.indexOf('start'));
              const idxEnd = Math.max(1, format.indexOf('end'));
              const idxText = format.length > 0 ? Math.max(format.indexOf('text'), format.length - 1) : 9;
              const out = ['WEBVTT', ''];
              const parseTime = (t) => {
                const m = t.trim().match(/(\d+):(\d{2}):(\d{2})[\.\:](\d{2})/);
                if (!m) return null;
                const h = +m[1] || 0, mi = +m[2] || 0, s = +m[3] || 0, cs = +m[4] || 0;
                const ms = (h * 3600 + mi * 60 + s) * 1000 + cs * 10;
                const hh = String(Math.floor(ms / 3600000)).padStart(2, '0');
                const mm = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
                const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
                const mmm = String(ms % 1000).padStart(3, '0');
                return `${hh}:${mm}:${ss}.${mmm}`;
              };
              const cleanText = (txt) => {
                let t = txt.replace(/\{[^}]*\}/g, '');
                t = t.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');
                t = t.replace(/[\u0000-\u001F]/g, '');
                return t.trim();
              };
              for (const line of lines) {
                if (!/^dialogue\s*:/i.test(line)) continue;
                const payload = line.split(':').slice(1).join(':');
                const parts = []; let cur = ''; let splits = 0;
                for (let i = 0; i < payload.length; i++) { const ch = payload[i]; if (ch === ',' && splits < Math.max(idxText, 9)) { parts.push(cur); cur = ''; splits++; } else { cur += ch; } }
                parts.push(cur);
                const st = parseTime(parts[idxStart]); const et = parseTime(parts[idxEnd]);
                if (!st || !et) continue; const ct = cleanText(parts[idxText] ?? ''); if (!ct) continue;
                out.push(`${st} --> ${et}`); out.push(ct); out.push('');
              }
              return out.length > 2 ? out.join('\n') : null;
            })(raw);
            if (manual && manual.trim().length > 0) return manual;
          }
        }
        throw new Error('Failed to extract or convert subtitle from ZIP (no .srt and conversion to VTT failed)');
      }

      // Non-ZIP: decode with BOM awareness
      let text;
      if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) text = buf.slice(2).toString('utf16le');
      else if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
        const swapped = Buffer.allocUnsafe(Math.max(0, buf.length - 2));
        for (let i = 2, j = 0; i + 1 < buf.length; i += 2, j += 2) { swapped[j] = buf[i + 1]; swapped[j + 1] = buf[i]; }
        text = swapped.toString('utf16le');
      } else text = buf.toString('utf8');
      // Strip UTF-8 BOM if present (some providers ship BOM-prefixed UTF-8)
      if (text && typeof text === 'string') text = text.replace(/^\uFEFF/, '');

      const trimmed = (text || '').trimStart();
      if (trimmed.startsWith('WEBVTT')) {
        log.debug(() => '[OpenSubtitles] Detected VTT; returning original VTT');
        return text;
      }

      // If content looks like ASS/SSA, convert to SRT
      if (/\[events\]/i.test(text) || /^dialogue\s*:/im.test(text)) {
        // Try enhanced ASS converter first
        const assConverter = require('../utils/assConverter');
        const result = assConverter.convertASSToVTT(text, 'ass');
        if (result.success) return result.content;
        log.debug(() => `[OpenSubtitles] Enhanced converter failed: ${result.error}, trying standard conversion`);

        try {
          const subsrt = require('subsrt-ts');
          let converted = subsrt.convert(text, { to: 'vtt', from: 'ass' });
          if (!converted || converted.trim().length === 0) {
            const sanitized = (text || '').replace(/\u0000/g, '');
            converted = subsrt.convert(sanitized, { to: 'vtt', from: 'ass' });
          }
          if (converted && converted.trim().length > 0) return converted;
        } catch (_) {
          // ignore and fallback to manual
        }
        const manual = (function assToVttFallback(input) {
          if (!input || !/\[events\]/i.test(input)) return null;
          const lines = input.split(/\r?\n/); let format = []; let inEvents = false;
          for (const line of lines) {
            const l = line.trim(); if (/^\[events\]/i.test(l)) { inEvents = true; continue; }
            if (!inEvents) continue; if (/^\[.*\]/.test(l)) break;
            if (/^format\s*:/i.test(l)) format = l.split(':')[1].split(',').map(s => s.trim().toLowerCase());
          }
          const idxStart = Math.max(0, format.indexOf('start'));
          const idxEnd = Math.max(1, format.indexOf('end'));
          const idxText = format.length > 0 ? Math.max(format.indexOf('text'), format.length - 1) : 9;
          const out = ['WEBVTT', ''];
          const parseTime = (t) => {
            const m = t.trim().match(/(\d+):(\d{2}):(\d{2})[\.\:](\d{2})/);
            if (!m) return null; const h = +m[1] || 0, mi = +m[2] || 0, s = +m[3] || 0, cs = +m[4] || 0;
            const ms = (h * 3600 + mi * 60 + s) * 1000 + cs * 10; const hh = String(Math.floor(ms / 3600000)).padStart(2, '0');
            const mm = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0'); const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
            const mmm = String(ms % 1000).padStart(3, '0'); return `${hh}:${mm}:${ss}.${mmm}`;
          };
          const cleanText = (txt) => {
            let t = txt.replace(/\{[^}]*\}/g, ''); t = t.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');
            t = t.replace(/[\u0000-\u001F]/g, ''); return t.trim();
          };
          for (const line of lines) {
            if (!/^dialogue\s*:/i.test(line)) continue; const payload = line.split(':').slice(1).join(':');
            const parts = []; let cur = ''; let splits = 0; for (let i = 0; i < payload.length; i++) { const ch = payload[i]; if (ch === ',' && splits < Math.max(idxText, 9)) { parts.push(cur); cur = ''; splits++; } else { cur += ch; } }
            parts.push(cur); const st = parseTime(parts[idxStart]); const et = parseTime(parts[idxEnd]); if (!st || !et) continue;
            const ct = cleanText(parts[idxText] ?? ''); if (!ct) continue; out.push(`${st} --> ${et}`); out.push(ct); out.push('');
          }
          return out.length > 2 ? out.join('\n') : null;
        })(text);
        if (manual && manual.trim().length > 0) return manual;
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

module.exports = OpenSubtitlesService;
