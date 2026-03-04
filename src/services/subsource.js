/**
 * SubSource API Integration
 *
 * This implementation:
 * - Uses header-based authentication (X-API-Key and api-key headers)
 * - Attempts both /subtitles and /search endpoints
 * - Converts language codes from ISO-639-2 (3-letter) to ISO-639-1 (2-letter)
 * - Uses browser-like headers for better compatibility
 */

const axios = require('axios');
const { toISO6391, toISO6392 } = require('../utils/languages');
const { handleSearchError, handleDownloadError, logApiError } = require('../utils/apiErrorHandler');
const { httpAgent, httpsAgent, dnsLookup } = require('../utils/httpAgents');
const { detectAndConvertEncoding } = require('../utils/encodingDetector');
const { appendHiddenInformationalNote } = require('../utils/subtitle');
const { sanitizeApiKeyForHeader } = require('../utils/security');
const providerMetadataCache = require('../utils/providerMetadataCache');
const zlib = require('zlib');
const log = require('../utils/logger');
const { isTrueishFlag } = require('../utils/subtitleFlags');
const { detectArchiveType, extractSubtitleFromArchive, isArchive, createEpisodeNotFoundSubtitle, createZipTooLargeSubtitle } = require('../utils/archiveExtractor');
const { analyzeResponseContent, createInvalidResponseSubtitle } = require('../utils/responseAnalyzer');

const SUBSOURCE_API_URL = 'https://api.subsource.net/api/v1';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_LINK_CACHE = 2000; // in-memory direct-link cache size
const MAX_ZIP_BYTES = 25 * 1024 * 1024; // hard cap for ZIP downloads (~25MB) to avoid huge packs

class SubSourceService {
  // Static/singleton axios client - shared across all instances for connection reuse
  // Note: API key headers are added per-request via { headers: this.defaultHeaders } in each request
  static client = axios.create({
    baseURL: SUBSOURCE_API_URL,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, application/*+json, application/zip, application/octet-stream, application/x-subrip, text/plain, text/srt, */*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://subsource.net/',
      'Origin': 'https://subsource.net',
      'DNT': '1',
      'Sec-GPC': '1',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-ch-ua-platform-version': '"15.0.0"',
      'sec-ch-ua-arch': '"x86"',
      'sec-ch-ua-bitness': '"64"',
      'sec-ch-ua-full-version': '"131.0.6778.86"',
      'sec-ch-ua-full-version-list': '"Chromium";v="131.0.6778.86", "Not_A Brand";v="24.0.0.0"',
      'X-Requested-With': 'XMLHttpRequest'
    },
    httpAgent,
    httpsAgent,
    lookup: dnsLookup,
    timeout: 12000,
    maxRedirects: 5,
    decompress: true
  });

  static initLogged = false;

  constructor(apiKey = null) {
    // Ensure apiKey is always a string (protect against objects/undefined)
    this.apiKey = (typeof apiKey === 'string') ? apiKey : '';
    this.baseURL = SUBSOURCE_API_URL;
    this._linkCache = new Map(); // subsource_id -> direct download URL

    // Use static client for all instances (connection pooling optimization)
    this.client = SubSourceService.client;

    // Configure default headers (stored for per-request use)
    this.defaultHeaders = {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, application/*+json, application/zip, application/octet-stream, application/x-subrip, text/plain, text/srt, */*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://subsource.net/',
      'Origin': 'https://subsource.net',
      'DNT': '1',
      'Sec-GPC': '1',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-ch-ua-platform-version': '"15.0.0"',
      'sec-ch-ua-arch': '"x86"',
      'sec-ch-ua-bitness': '"64"',
      'sec-ch-ua-full-version': '"131.0.6778.86"',
      'sec-ch-ua-full-version-list': '"Chromium";v="131.0.6778.86", "Not_A Brand";v="24.0.0.0"',
      'X-Requested-With': 'XMLHttpRequest'
    };

    // Add API key to headers (sanitize to prevent "Invalid character in header content" errors)
    const sanitizedApiKey = sanitizeApiKeyForHeader(this.apiKey);
    if (sanitizedApiKey) {
      this.defaultHeaders['X-API-Key'] = sanitizedApiKey;
      this.defaultHeaders['api-key'] = sanitizedApiKey;
      if (!SubSourceService.initLogged) {
        log.debug(() => '[SubSource] Initializing with API key in headers');
      }
    } else if (this.apiKey && this.apiKey.trim() !== '') {
      // API key was provided but contained too many invalid characters (likely corrupted)
      log.warn(() => '[SubSource] API key appears corrupted (contains invalid characters) - please re-enter your SubSource API key');
    }

    if (!SubSourceService.initLogged) {
      SubSourceService.initLogged = true;
    }
  }

  rememberDownloadLink(id, url) {
    try {
      if (!id || !url || typeof url !== 'string') return;
      if (!/^https?:\/\//i.test(url)) return;
      // Insert and prune oldest if over limit
      this._linkCache.set(String(id), url);
      if (this._linkCache.size > MAX_LINK_CACHE) {
        const firstKey = this._linkCache.keys().next().value;
        if (firstKey !== undefined) this._linkCache.delete(firstKey);
      }
    } catch (_) { /* ignore */ }
  }

  /**
   * Retry a function with exponential backoff and a total time budget.
   * The provided function is called as fn(attemptTimeoutMs) so it can use
   * a per-attempt timeout that fits within the remaining time budget.
   * Retries on: timeouts, connection resets/refused, 5xx, 429, 503
   * @param {(attemptTimeout:number)=>Promise<any>} fn
   * @param {Object} options
   * @param {number} [options.totalTimeoutMs=10000] - Total time budget for all attempts
   * @param {number} [options.maxRetries=2] - Number of retries (in addition to first attempt)
   * @param {number} [options.baseDelay=800] - Base delay in ms for backoff
   * @param {number} [options.minAttemptTimeoutMs=2500] - Minimum per-attempt timeout
   */
  async retryWithBackoff(fn, options = {}) {
    const totalTimeoutMs = options.totalTimeoutMs ?? 10000;
    const maxRetries = options.maxRetries ?? 2;
    const baseDelay = options.baseDelay ?? 800;
    const minAttemptTimeoutMs = options.minAttemptTimeoutMs ?? 2500;

    const startedAt = Date.now();
    let attempt = 0;

    // Helper to compute remaining budget
    const remaining = () => Math.max(0, totalTimeoutMs - (Date.now() - startedAt));

    while (true) {
      // Reserve some time for a potential delay before the next retry
      const r = remaining();
      if (r <= 0) throw new Error('Request timed out');

      const hasMoreRetries = attempt < maxRetries;
      const plannedDelay = hasMoreRetries
        ? Math.min(Math.round(baseDelay * Math.pow(2, attempt)), Math.floor(r / 3))
        : 0;

      // Allocate attempt timeout from remaining budget minus planned delay
      const attemptTimeout = Math.max(minAttemptTimeoutMs, r - plannedDelay);

      try {
        return await fn(attemptTimeout);
      } catch (error) {
        const status = error.response?.status;
        const code = error.code;
        const isTimeout = code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(error.message || '');
        const isNetwork = code === 'ECONNRESET' || code === 'ECONNREFUSED';
        const isRetryableStatus = status === 429 || status === 503 || (status >= 500 && status <= 599);
        const retryable = isTimeout || isNetwork || isRetryableStatus;

        if (!retryable || attempt >= maxRetries) {
          throw error;
        }

        // Wait with backoff but do not exceed remaining budget
        const r2 = remaining();
        const delay = Math.min(plannedDelay, Math.max(0, r2 - minAttemptTimeoutMs));
        if (delay <= 0) {
          // No time left for a safe retry attempt
          throw error;
        }
        log.warn(() => `[SubSource] Request failed (attempt ${attempt + 1}) — ${status || code || error.message}. Retrying in ${delay}ms...`);
        await new Promise(res => setTimeout(res, delay));
        attempt++;
      }
    }
  }

  /**
   * Search for movie/show by IMDB ID to get SubSource movieId
   * 
   * Uses Redis-backed cache to avoid repeated API calls.
   * IMPORTANT: Makes only ONE API call with the user's timeout - no fallback chains.
   * This ensures SubSource respects the user's timeout setting exactly.
   * 
   * @param {string} imdb_id - IMDB ID (with 'tt' prefix)
   * @param {number} season - Season number (for TV shows)
   * @param {number} providerTimeout - Timeout in ms from user config
   * @returns {Promise<string|null>} - SubSource movie ID or null
   */
  async getMovieId(imdb_id, season = null, providerTimeout = null) {
    const timeoutMs = providerTimeout || 10000;

    // Check Redis-backed cache first (includes in-memory L1 cache)
    try {
      const cached = await providerMetadataCache.get('subsource', 'movieId', imdb_id, season);
      if (cached) {
        log.debug(() => `[SubSource] movieId cache HIT: ${imdb_id}${season ? `:S${season}` : ''} → ${cached}`);
        return cached;
      }
    } catch (err) {
      log.warn(() => `[SubSource] Cache read error: ${err.message}`);
    }

    // Cache miss - make a SINGLE API call with the user's exact timeout
    // NO fallback chains - if this fails, we return null immediately
    try {
      let searchUrl = `${this.baseURL}/movies/search?searchType=imdb&imdb=${imdb_id}`;
      if (season) {
        searchUrl += `&season=${season}`;
      }

      log.debug(() => `[SubSource] Fetching movieId: ${imdb_id}${season ? ` S${season}` : ''} (timeout: ${timeoutMs}ms)`);

      const response = await this.client.get(searchUrl, {
        headers: this.defaultHeaders,
        responseType: 'json',
        timeout: timeoutMs
      });

      // Parse response
      const movies = Array.isArray(response.data) ? response.data : (response.data?.data || []);

      if (movies.length > 0) {
        const movieId = movies[0].id || movies[0].movieId;
        const movieTitle = movies[0].title || 'Unknown';

        if (movieId) {
          // Cache to Redis (async, non-blocking)
          providerMetadataCache.set('subsource', 'movieId', imdb_id, movieId, season)
            .catch(err => log.warn(() => `[SubSource] Cache write error: ${err.message}`));

          log.debug(() => `[SubSource] Found movieId=${movieId} for "${movieTitle}"${season ? ` S${season}` : ''}`);
          return movieId;
        }
      }

      log.debug(() => `[SubSource] No movie found for: ${imdb_id}${season ? ` S${season}` : ''}`);
      return null;
    } catch (error) {
      // Log the error but don't retry - respect the user's timeout
      const code = error?.code || '';
      const isTimeout = code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(error?.message || '');

      if (isTimeout) {
        log.warn(() => `[SubSource] movieId lookup timed out after ${timeoutMs}ms for ${imdb_id}`);
      } else {
        logApiError(error, 'SubSource', 'Get movie ID', { skipResponseData: true, skipUserMessage: true });
      }

      return null;
    }
  }



  /**
   * Search for subtitles using SubSource API
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
      // Check if API key is provided
      if (!this.apiKey || this.apiKey.trim() === '') {
        log.error(() => '[SubSource] API key is required for SubSource API');
        log.error(() => '[SubSource] Please get a free API key from https://subsource.net/');
        return [];
      }

      const { imdb_id, type, season, episode, languages, excludeHearingImpairedSubtitles, providerTimeout } = params;

      // SubSource requires IMDB ID - skip if not available (e.g., anime with Kitsu IDs)
      if (!imdb_id || imdb_id === 'undefined') {
        log.debug(() => '[SubSource] No IMDB ID available, skipping search');
        return [];
      }

      // SubSource uses a two-step process:
      // 1. getMovieId: lookup IMDB -> SubSource movieId (cached in Redis)
      // 2. searchSubtitles: fetch subtitles using movieId
      // Respect user's configured timeout - no artificial caps
      const userTimeoutMs = providerTimeout || 10000;
      const totalStartTime = Date.now();

      // First, get SubSource's internal movie ID
      // Pass full user timeout since getMovieId checks cache first (usually instant)
      const movieId = await this.getMovieId(imdb_id, season, userTimeoutMs);
      const movieIdDurationMs = Date.now() - totalStartTime;

      if (!movieId) {
        log.debug(() => `[SubSource] Could not find movie ID for: ${imdb_id}${season ? ` S${season}` : ''} (took ${movieIdDurationMs}ms)`);
        return [];
      }

      // Calculate remaining time for subtitle search
      const elapsedMs = Date.now() - totalStartTime;
      const searchTimeoutMs = Math.max(0, userTimeoutMs - elapsedMs);

      // Log if movieId took significant time (cache miss)
      if (movieIdDurationMs > 1000) {
        log.debug(() => `[SubSource] movieId lookup took ${movieIdDurationMs}ms - subtitle search gets ${searchTimeoutMs}ms`);
      }

      // Check if we have enough time left for a meaningful search
      if (searchTimeoutMs < 2000) {
        log.warn(() => `[SubSource] Insufficient time remaining for search after movieId lookup (${searchTimeoutMs}ms left)`);
        return [];
      }

      // Build query parameters for SubSource API
      const queryParams = {
        movieId: movieId,
        // Sort by downloads (popularity) to get diverse, well-tested subtitles
        // This balances quality with filename/release matching (unlike 'rating' which may exclude correct releases)
        sort: 'popular',
        // Request more results to allow for better ranking/filtering
        limit: 100
      };

      // Optional filter: exclude HI/SDH subtitles (SubSource supports hearingImpaired=true/false)
      if (excludeHearingImpairedSubtitles === true) {
        queryParams.hearingImpaired = 'false';
      }

      // Convert ISO codes to full language names for SubSource API
      // SubSource expects language names like "english", "spanish", etc.
      const convertedLanguages = languages.map(lang => {
        if (!lang) return null;

        const lower = lang.toLowerCase();

        // Map ISO-639-2 (3-letter) and ISO-639-1 (2-letter) codes to SubSource language names
        const languageMap = {
          // ISO-639-2 (3-letter codes)
          'eng': 'english',
          'spa': 'spanish',
          'spn': 'spanish_latin_america',  // Latin America Spanish
          'fre': 'french',
          'fra': 'french',
          'ger': 'german',
          'deu': 'german',
          'por': 'portuguese',
          'pob': 'brazilian_portuguese',  // Brazilian Portuguese (fixed)
          'ita': 'italian',
          'rus': 'russian',
          'jpn': 'japanese',
          'kor': 'korean',
          'chi': 'chinese',
          'zho': 'chinese',
          'zhs': 'chinese_simplified',   // Chinese Simplified
          'zht': 'chinese_traditional',  // Chinese Traditional
          'ara': 'arabic',
          'dut': 'dutch',
          'nld': 'dutch',
          'pol': 'polish',
          'tur': 'turkish',
          'swe': 'swedish',
          'dan': 'danish',
          'fin': 'finnish',
          'nor': 'norwegian',
          'nob': 'norwegian',  // Norwegian Bokmål → generic Norwegian (SubSource has no variant split)
          'nno': 'norwegian',  // Norwegian Nynorsk → generic Norwegian
          'heb': 'hebrew',
          'hin': 'hindi',
          'tha': 'thai',
          'vie': 'vietnamese',
          'ind': 'indonesian',
          'rum': 'romanian',
          'ron': 'romanian',
          'cze': 'czech',
          'ces': 'czech',
          'hun': 'hungarian',
          'gre': 'greek',
          'ell': 'greek',
          'bul': 'bulgarian',
          'hrv': 'croatian',
          'ukr': 'ukrainian',
          'srp': 'serbian',
          'per': 'farsi_persian',   // Persian/Farsi
          'fas': 'farsi_persian',
          'may': 'malay',
          'msa': 'malay',
          'est': 'estonian',
          'lav': 'latvian',
          'lit': 'lithuanian',
          'slo': 'slovak',
          'slk': 'slovak',
          'slv': 'slovenian',
          'ben': 'bengali',
          'tgl': 'tagalog',
          'fil': 'tagalog',  // Filipino → Tagalog (same written standard, SubSource uses 'tagalog')
          'bos': 'bosnian',
          'mac': 'macedonian',
          'mkd': 'macedonian',
          'alb': 'albanian',
          'sqi': 'albanian',
          'geo': 'georgian',
          'kat': 'georgian',
          'ice': 'icelandic',
          'isl': 'icelandic',
          'cat': 'catalan',
          'baq': 'basque',
          'eus': 'basque',
          'glg': 'galician',
          'wel': 'welsh',
          'cym': 'welsh',
          'swa': 'swahili',
          'mal': 'malayalam',
          'tam': 'tamil',
          'tel': 'telugu',
          'urd': 'urdu',
          'pan': 'punjabi',
          'nep': 'nepali',
          'sin': 'sinhala',
          'khm': 'khmer',
          'lao': 'lao',
          'bur': 'burmese',
          'mya': 'burmese',
          'mon': 'mongolian',
          'afr': 'afrikaans',
          'kur': 'kurdish',

          // ISO-639-1 (2-letter codes)
          'en': 'english',
          'es': 'spanish',
          'fr': 'french',
          'de': 'german',
          'pt': 'portuguese',
          'it': 'italian',
          'ru': 'russian',
          'ja': 'japanese',
          'ko': 'korean',
          'zh': 'chinese',
          'ar': 'arabic',
          'nl': 'dutch',
          'pl': 'polish',
          'tr': 'turkish',
          'sv': 'swedish',
          'da': 'danish',
          'fi': 'finnish',
          'no': 'norwegian',
          'he': 'hebrew',
          'hi': 'hindi',
          'th': 'thai',
          'vi': 'vietnamese',
          'id': 'indonesian',
          'ro': 'romanian',
          'cs': 'czech',
          'hu': 'hungarian',
          'el': 'greek',
          'bg': 'bulgarian',
          'hr': 'croatian',
          'uk': 'ukrainian',
          'sr': 'serbian',
          'fa': 'farsi_persian',
          'ms': 'malay',
          'et': 'estonian',
          'lv': 'latvian',
          'lt': 'lithuanian',
          'sk': 'slovak',
          'sl': 'slovenian',
          'bn': 'bengali',
          'tl': 'tagalog',
          'bs': 'bosnian',
          'mk': 'macedonian',
          'sq': 'albanian',
          'ka': 'georgian',
          'is': 'icelandic',
          'ca': 'catalan',
          'eu': 'basque',
          'gl': 'galician',
          'cy': 'welsh',
          'sw': 'swahili',
          'ml': 'malayalam',
          'ta': 'tamil',
          'te': 'telugu',
          'ur': 'urdu',
          'pa': 'punjabi',
          'ne': 'nepali',
          'si': 'sinhala',
          'km': 'khmer',
          'lo': 'lao',
          'my': 'burmese',
          'mn': 'mongolian',
          'af': 'afrikaans',
          'ku': 'kurdish'
        };

        return languageMap[lower] || null;
      }).filter(lang => lang !== null);

      // Remove duplicates and add language parameter if we have valid languages
      const uniqueLanguages = [...new Set(convertedLanguages)];
      if (uniqueLanguages.length > 0) {
        queryParams.language = uniqueLanguages.join(',');
      } else if (languages && languages.length > 0) {
        // All requested languages were unmapped — don't silently fetch all languages
        log.warn(() => `[SubSource] None of the requested languages [${languages.join(', ')}] are supported by SubSource, skipping search`);
        return [];
      }

      // Note: Season filtering is handled via getMovieId(imdb_id, season)
      // Note: Episode filtering is NOT supported by the API - we'll filter client-side below

      log.debug(() => `[SubSource] Searching: movieId=${queryParams.movieId}, languages=[${queryParams.language || 'all'}], sort=${queryParams.sort}, limit=${queryParams.limit}${type === 'episode' ? `, episode=${episode}` : ''}`);

      // Try /subtitles endpoint first (more common pattern), fallback to /search if needed
      let response;
      let endpoint = '/subtitles';

      // Build query string
      const queryString = new URLSearchParams(queryParams).toString();
      const url = `${this.baseURL}${endpoint}?${queryString}`;

      // searchTimeoutMs already calculated above with 30s total cap

      try {
        const requestConfig = { headers: this.defaultHeaders, responseType: 'json', timeout: searchTimeoutMs };
        const rawResponse = await this.client.get(url, requestConfig);

        response = rawResponse.data;
      } catch (error) {
        if (error.response?.status === 404) {
          log.debug(() => '[SubSource] /subtitles endpoint not found, trying /search');
          endpoint = '/search';
          const searchUrl = `${this.baseURL}${endpoint}?${queryString}`;

          // Fallback also gets full timeout
          const searchConfig = { headers: this.defaultHeaders, responseType: 'json', timeout: searchTimeoutMs };
          const rawResponse = await this.client.get(searchUrl, searchConfig);


          response = rawResponse.data;
        } else {
          throw error;
        }
      }

      log.debug(() => '[SubSource] API Response received');

      // Handle different possible response formats
      // Cloudscraper with json:true returns the parsed JSON directly
      let subtitlesData = null;
      if (response) {
        if (Array.isArray(response)) {
          subtitlesData = response;
        } else if (response.subtitles) {
          subtitlesData = response.subtitles;
        } else if (response.data) {
          // Some APIs wrap results in a data field
          if (Array.isArray(response.data)) {
            subtitlesData = response.data;
          } else if (response.data.subtitles) {
            subtitlesData = response.data.subtitles;
          } else if (response.data.results) {
            subtitlesData = response.data.results;
          }
        } else if (response.results) {
          subtitlesData = response.results;
        }
      }

      if (!subtitlesData || subtitlesData.length === 0) {
        log.debug(() => '[SubSource] No subtitles found in response');
        return [];
      }

      log.debug(() => `[SubSource] API returned ${subtitlesData.length} subtitles (before episode filtering)`);

      const subtitles = subtitlesData.map(sub => {
        const originalLang = sub.language || 'en';
        const normalizedLang = this.normalizeLanguageCode(originalLang);

        // SubSource provides subtitle ID - check multiple possible field names (subtitleId is the correct field)
        const subtitleId = sub.subtitleId || sub.id || sub.subtitle_id || sub._id;
        const fileId = `subsource_${subtitleId}`;

        // Log subtitle structure for debugging if ID is missing
        if (!subtitleId) {
          log.error(() => '[SubSource] WARNING: Subtitle missing ID field');
        }

        // Extract name from releaseInfo array (SubSource stores release names as an array)
        let extractedName = null;
        if (sub.releaseInfo && Array.isArray(sub.releaseInfo) && sub.releaseInfo.length > 0) {
          // Join multiple release names with " / " if there are multiple
          extractedName = sub.releaseInfo.join(' / ');
        } else if (sub.releaseInfo && typeof sub.releaseInfo === 'string') {
          // In case it's a string instead of array
          extractedName = sub.releaseInfo;
        }

        // Fallback to other possible field names if releaseInfo not found
        if (!extractedName) {
          extractedName = sub.name ||
            sub.release_name ||
            sub.releaseName ||
            sub.fullname ||
            sub.fullName ||
            sub.full_name ||
            sub.file_name ||
            sub.fileName ||
            sub.filename ||
            sub.title ||
            sub.subtitle_name ||
            sub.subtitleName ||
            sub.releasename ||
            sub.label ||
            sub.description ||
            sub.subtitle ||
            sub.release ||
            null;
        }

        // If still no name found, construct one from available info
        // Also enhance with productionType and releaseType for better matching
        let finalName = extractedName;
        if (!finalName || finalName.trim() === '') {
          const langName = originalLang || 'Unknown Language';
          const dlCount = parseInt(sub.downloads || sub.download_count || 0) || 0;
          // Include production/release type if available to improve matching
          const typeInfo = sub.productionType || sub.releaseType || '';
          finalName = `SubSource ${langName}${typeInfo ? ` [${typeInfo}]` : ''}${dlCount > 0 ? ` (${dlCount} downloads)` : ''}`;
          log.debug(() => `[SubSource] No name field found for subtitle ${subtitleId}, constructed: ${finalName}`);
        } else {
          // Enhance existing name with production/release type if not already present
          const typeInfo = sub.productionType || sub.releaseType || '';
          if (typeInfo && !finalName.toLowerCase().includes(typeInfo.toLowerCase())) {
            finalName = `${finalName} [${typeInfo}]`;
          }
        }

        // Extract upload date from various possible field names (createdAt is the correct field for SubSource)
        const extractedDate = sub.createdAt ||
          sub.created_at ||
          sub.upload_date ||
          sub.uploadDate ||
          sub.date ||
          sub.uploaded ||
          sub.created ||
          sub.date_uploaded ||
          sub.dateUploaded ||
          sub.upload ||
          sub.timestamp ||
          sub.create_date ||
          sub.createDate ||
          undefined;

        // Extract downloads from various possible field names
        const extractedDownloads = parseInt(
          sub.downloads ||
          sub.download_count ||
          sub.downloadCount ||
          sub.hi_download_count ||
          sub.hiDownloadCount ||
          sub.total_downloads ||
          sub.totalDownloads ||
          0
        ) || 0;

        // Extract rating - SubSource returns rating as an object {good, bad, total}
        let extractedRating = 0;
        if (sub.rating && typeof sub.rating === 'object') {
          // Calculate confidence-weighted rating (Bayesian average)
          // This prevents subtitles with few votes from ranking unfairly high
          const good = parseInt(sub.rating.good) || 0;
          const bad = parseInt(sub.rating.bad) || 0;
          const total = good + bad;

          if (total > 0) {
            // Use Bayesian averaging with confidence factor
            // Assume a prior of 5 votes at 70% positive (3.5 good, 1.5 bad)
            const CONFIDENCE = 5;
            const PRIOR_POSITIVE_RATIO = 0.7;

            const weightedGood = good + (CONFIDENCE * PRIOR_POSITIVE_RATIO);
            const weightedTotal = total + CONFIDENCE;

            // Convert to 0-10 scale
            extractedRating = (weightedGood / weightedTotal) * 10;
          }
        } else {
          extractedRating = parseFloat(sub.rating || sub.score || 0) || 0;
        }

        const directUrl = sub.download_url || sub.downloadUrl || sub.url;
        // Cache direct link for CDN-first download attempts
        if (subtitleId && directUrl) {
          try { this.rememberDownloadLink(subtitleId, directUrl); } catch (_) { }
        }

        return {
          id: fileId,
          language: originalLang,
          languageCode: normalizedLang,
          name: finalName,
          downloads: extractedDownloads,
          rating: extractedRating,
          uploadDate: extractedDate,
          format: sub.format || 'srt',
          fileId: fileId,
          downloadLink: directUrl,
          hearing_impaired: isTrueishFlag(sub.hearingImpaired) || isTrueishFlag(sub.hearing_impaired) || isTrueishFlag(sub.hi),
          foreign_parts_only: sub.foreignParts || false,
          machine_translated: false,
          uploader: sub.uploader || sub.author || sub.user || 'Unknown',
          provider: 'subsource',
          // Store SubSource-specific metadata for improved matching
          subsource_id: subtitleId,
          productionType: sub.productionType || null,
          releaseType: sub.releaseType || null,
          framerate: sub.framerate || null,
          // Include rating breakdown for better quality assessment
          ratingDetails: sub.rating && typeof sub.rating === 'object' ? {
            good: parseInt(sub.rating.good) || 0,
            bad: parseInt(sub.rating.bad) || 0,
            total: parseInt(sub.rating.total) || 0
          } : null
        };
      });

      // Client-side episode filtering for TV shows and anime
      // SubSource API doesn't support episode-level filtering, so we filter by subtitle name
      let filteredSubtitles = subtitles;
      if ((type === 'episode' || type === 'anime-episode') && episode) {
        // Default to season 1 if not specified (common for anime)
        const targetSeason = season || 1;
        const targetEpisode = episode;

        log.debug(() => [`[SubSource] Filtering for S${String(targetSeason).padStart(2, '0')}E${String(targetEpisode).padStart(2, '0')} (${subtitles.length} pre-filter)`]);

        filteredSubtitles = subtitles.filter(sub => {
          const name = (sub.name || '').toLowerCase();

          // Check for season pack patterns (season without specific episode)
          // Patterns: "season 3", "third season", "complete season 3", "s03 complete", "1-24 complete", etc.
          const seasonPackPatterns = [
            new RegExp(`(?:complete|full|entire)?\\s*(?:season|s)\\s*0*${targetSeason}(?:\\s+(?:complete|full|pack))?(?!.*e0*\\d)`, 'i'),
            new RegExp(`(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\\s+season(?!.*episode)`, 'i'),
            new RegExp(`s0*${targetSeason}\\s*(?:complete|full|pack)`, 'i'),
            // Episode range patterns: "1-24 complete", "01~12 complete", "[1-24]", etc.
            // These are common for anime released as season packs without explicit "season" word
            /\d{1,3}\s*[-~]\s*\d{1,3}\s*(?:complete|batch|full|pack|\]|$)/i,
            /\[(?:batch|complete|full)\]/i,
            // S01. followed by quality/release info without episode number
            // Examples: Breaking.Bad.S01.2160p.WEBRip, Show.S01.BluRay.x264
            new RegExp(`\\.s0*${targetSeason}\\.(?!e0*\\d)(?:complete|720p|1080p|2160p|4k|blu\\.?ray|webrip|web[\\-\\.]?dl|hdtv|dvdrip|bdrip|brrip)`, 'i')
          ];

          // Anime-specific season pack patterns (often don't include season numbers)
          // Patterns: "complete", "batch", "01-12", "1~12", "[Batch]", etc.
          const animeSeasonPackPatterns = [
            /(?:complete|batch|full(?:\s+series)?|\d{1,2}\s*[-~]\s*\d{1,2})/i,
            /\[(?:batch|complete|full)\]/i,
            /(?:episode\s*)?(?:01|001)\s*[-~]\s*(?:\d{2}|\d{3})/i  // 01-12, 001-024
          ];

          let isSeasonPack = false;

          // More comprehensive episode number exclusion pattern
          const hasEpisodeNumber = /s0*\d+e0*\d+|\d+x\d+|episode\s*\d+|ep\.?\s*\d+|\be\.?\s*\d{1,3}\b/i.test(name);

          if (type === 'anime-episode') {
            // For anime, use anime-specific patterns and don't require season numbers
            const episodeExclusionPattern = new RegExp(`(?:^|[^0-9])0*${targetEpisode}(?:v\\d+)?(?:[^0-9]|$)`);
            isSeasonPack = animeSeasonPackPatterns.some(pattern => pattern.test(name)) &&
              !episodeExclusionPattern.test(name); // Exclude if has specific episode number
          } else {
            // For regular TV shows, use season-based patterns
            isSeasonPack = seasonPackPatterns.some(pattern => pattern.test(name)) &&
              !hasEpisodeNumber; // Exclude if has episode number
          }

          if (isSeasonPack) {
            // Mark as season pack and include it (don't filter out)
            sub.is_season_pack = true;
            sub.season_pack_season = targetSeason;
            sub.season_pack_episode = targetEpisode; // Store requested episode for download

            // Encode season/episode info in fileId for download extraction
            // Format: subsource_<id>_seasonpack_s<season>e<episode>
            const originalFileId = sub.fileId || sub.id;
            sub.fileId = `${originalFileId}_seasonpack_s${targetSeason}e${targetEpisode}`;
            sub.id = sub.fileId; // Keep id in sync

            log.debug(() => `[SubSource] Detected season pack: ${sub.name}`);
            return true;
          }

          // Check for season/episode patterns in subtitle name
          // Patterns: S02E01, s02e01, 2x01, S02.E01, etc.
          const seasonEpisodePatterns = [
            new RegExp(`s0*${targetSeason}e0*${targetEpisode}(?![0-9])`, 'i'),        // S02E01, s02e01 (ensure not matching S02E011)
            new RegExp(`${targetSeason}x0*${targetEpisode}(?![0-9])`, 'i'),           // 2x01
            new RegExp(`s0*${targetSeason}[\\s._-]*x[\\s._-]*e?0*${targetEpisode}(?![0-9])`, 'i'), // S02xE01, S02x1
            new RegExp(`0*${targetSeason}[\\s._-]*x[\\s._-]*e?0*${targetEpisode}(?![0-9])`, 'i'),  // 2xE01, 02x01
            new RegExp(`s0*${targetSeason}\\.e0*${targetEpisode}(?![0-9])`, 'i'),     // S02.E01
            new RegExp(`season\\s*0*${targetSeason}.*episode\\s*0*${targetEpisode}(?![0-9])`, 'i')  // Season 2 Episode 1
          ];

          // Anime-friendly episode-only patterns (commonly used without Sxx)
          // Broaden coverage while guarding against matching years/resolutions (e.g., 1080p)
          const animeEpisodePatterns = [
            // E01 / EP01 / E 01 / EP 01 / (01) / [01] / - 01 / _01 / 01v2 / - 01[1080p]
            new RegExp(`(?<=\\b|\\s|\\[|\\(|-|_)e?p?\\s*0*${targetEpisode}(?:v\\d+)?(?=\\b|\\s|\\[\\]|\\(\\)|\\.|-|_|$)`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${targetEpisode}(?:v\\d+)?(?=$|[\\s\\[\\]\\(\\)\\-_.])`, 'i'),
            // 01en / 01eng (language suffix immediately after episode number before extension)
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${targetEpisode}(?:v\\d+)?[a-z]{2,3}(?=\\.|[\\s\\[\\]\\(\\)\\-_.]|$)`, 'i'),

            // Explicit words
            new RegExp(`(?:^|[\\s\\[\\(\\-_])episode\\s*0*${targetEpisode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])ep\\s*0*${targetEpisode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),

            // Spanish/Portuguese
            new RegExp(`(?:^|[\\s\\[\\(\\-_])cap(?:itulo|\\.)?\\s*0*${targetEpisode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])epis[oó]dio\\s*0*${targetEpisode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),

            // Japanese/Chinese/Korean: 第01話 / 01話 / 01集 / 1화
            new RegExp(`第\\s*0*${targetEpisode}\\s*(?:話|集)`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${targetEpisode}\\s*(?:話|集|화)(?=$|[\\s\\]\\)\\-_.])`, 'i'),

            // Multi-episode pack ranges that include the requested episode (e.g., 01-02)
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${targetEpisode}\\s*[-~](?=\\s*\\d)`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])\\d+\\s*[-~]\\s*0*${targetEpisode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
          ];

          const hasCorrectEpisode = seasonEpisodePatterns.some(pattern => pattern.test(name))
            || (type === 'anime-episode' && animeEpisodePatterns.some(p => p.test(name)));
          return hasCorrectEpisode;
        });

        // If nothing matched, do NOT fall back to unfiltered list
        if (filteredSubtitles.length === 0) {
          log.debug(() => '[SubSource] No matches after episode filtering; returning no results for this episode');
        }

        log.debug(() => [`[SubSource] After episode filtering: ${filteredSubtitles.length} subtitles (including ${filteredSubtitles.filter(s => s.is_season_pack).length} season packs)`]);
      }

      // Limit to 14 results per language to control response size
      const MAX_RESULTS_PER_LANGUAGE = 14;
      const groupedByLanguage = {};

      for (const sub of filteredSubtitles) {
        const lang = sub.languageCode || 'unknown';
        if (!groupedByLanguage[lang]) {
          groupedByLanguage[lang] = [];
        }
        if (groupedByLanguage[lang].length < MAX_RESULTS_PER_LANGUAGE) {
          groupedByLanguage[lang].push(sub);
        }
      }

      const limitedSubtitles = Object.values(groupedByLanguage).flat();
      log.debug(() => [`[SubSource] Returning ${limitedSubtitles.length} subtitles after per-language limit`]);
      return limitedSubtitles;

    } catch (error) {
      return handleSearchError(error, 'SubSource');
    }
  }

  /**
   * Download subtitle content
   * @param {string} fileId - File ID from search results (format: subsource_<id> or subsource_<id>_seasonpack_s<season>e<episode>)
   * @param {string} subsource_id - SubSource subtitle ID
   * @returns {Promise<string>} - Subtitle content as text
   */
  async downloadSubtitle(fileId, options = {}) {
    // Support legacy call pattern: downloadSubtitle(fileId, subsource_id)
    // New pattern: downloadSubtitle(fileId, { timeout })
    let subsource_id = null;
    const timeout = options?.timeout || 12000; // Default 12s

    // Handle legacy call pattern where second arg is subsource_id string
    if (typeof options === 'string') {
      subsource_id = options;
    }

    try {
      log.debug(() => ['[SubSource] Downloading subtitle:', fileId]);

      // Check if this is a season pack download
      let isSeasonPack = false;
      let seasonPackSeason = null;
      let seasonPackEpisode = null;

      // Parse the fileId to extract subsource_id and season pack info if not provided
      if (!subsource_id) {
        const parts = fileId.split('_');
        if (parts.length >= 2 && parts[0] === 'subsource') {
          subsource_id = parts[1];

          // Check for season pack format: subsource_<id>_seasonpack_s<season>e<episode>
          if (parts.length >= 4 && parts[2] === 'seasonpack') {
            isSeasonPack = true;
            // Parse s<season>e<episode> from parts[3]
            const match = parts[3].match(/s(\d+)e(\d+)/i);
            if (match) {
              seasonPackSeason = parseInt(match[1]);
              seasonPackEpisode = parseInt(match[2]);
              log.debug(() => `[SubSource] Season pack download requested: S${String(seasonPackSeason).padStart(2, '0')}E${String(seasonPackEpisode).padStart(2, '0')}`);
            }
          }
        } else {
          throw new Error('Invalid SubSource file ID format');
        }
      }

      log.debug(() => ['[SubSource] SubSource ID:', subsource_id]);

      // Check if we have a valid ID
      if (!subsource_id || subsource_id === 'undefined') {
        throw new Error('Invalid or missing SubSource subtitle ID');
      }


      // Attempt CDN/direct download first if we cached a direct URL from search
      let response;
      try {
        const cachedDirect = this._linkCache.get(String(subsource_id));
        if (cachedDirect && /^https?:\/\//i.test(cachedDirect)) {
          log.debug(() => `[SubSource] Trying CDN/direct link first: ${cachedDirect.replace(/\?.*$/, '')}`);
          const axios = require('axios');
          response = await axios.get(cachedDirect, {
            responseType: 'arraybuffer',
            timeout: 4000,
            headers: {
              'User-Agent': this.defaultHeaders['User-Agent'],
              'Accept': this.defaultHeaders['Accept'],
              'Accept-Encoding': this.defaultHeaders['Accept-Encoding'],
              'Referer': this.defaultHeaders['Referer'],
              'Origin': this.defaultHeaders['Origin']
            },
            httpAgent,
            httpsAgent
          });
        }
      } catch (cdnFirstErr) {
        // Ignore and continue to primary endpoint
        log.warn(() => ['[SubSource] CDN-first attempt failed:', cdnFirstErr?.message || String(cdnFirstErr)]);
        response = null;
      }

      // If CDN-first succeeded, continue to parse
      if (!response) {
        // Request download from SubSource API (API key is in headers)
        // According to API docs: GET /subtitles/{id}/download
        const url = `/subtitles/${subsource_id}/download`;
        // Allow CDN caching; avoid forcing no-cache on downloads
        const downloadHeaders = { ...this.defaultHeaders };
        delete downloadHeaders['Cache-Control'];
        delete downloadHeaders['Pragma'];

        // Race primary endpoint (retries within ~7s budget) with a details→CDN fetch
        // that starts after the first retryable primary failure.
        let triggerFallbackResolve;
        let fallbackTriggered = false;
        const triggerFallback = () => {
          if (!fallbackTriggered) {
            fallbackTriggered = true;
            try { triggerFallbackResolve && triggerFallbackResolve(); } catch (_) { }
          }
        };

        const fallbackGate = new Promise((resolve) => { triggerFallbackResolve = resolve; });

        const fallbackPromise = (async () => {
          // Wait until primary reports the first retryable failure
          await fallbackGate;
          log.warn(() => '[SubSource] Primary started failing — launching details→CDN in parallel');

          // Try to fetch subtitle details to obtain a direct download URL (often served via CDN)
          const detailResp = await this.client.get(`/subtitles/${subsource_id}`, {
            headers: this.defaultHeaders,
            responseType: 'json',
            timeout: 5000
          }).catch(() => null);

          // Extract any plausible direct download URL field
          let directUrl = null;
          if (detailResp && detailResp.data) {
            const d = detailResp.data;
            // Accept common variants
            directUrl = d.download_url || d.downloadUrl || d.url || (d.data && (d.data.download_url || d.data.downloadUrl || d.data.url)) || null;
          }

          if (directUrl && typeof directUrl === 'string' && /^https?:\/\//i.test(directUrl)) {
            log.debug(() => `[SubSource] Using CDN/direct link fallback: ${directUrl.replace(/\?.*$/, '')}`);
            const axios = require('axios');
            return axios.get(directUrl, {
              responseType: 'arraybuffer',
              timeout: 4000,
              headers: {
                'User-Agent': this.defaultHeaders['User-Agent'],
                'Accept': this.defaultHeaders['Accept'],
                'Accept-Encoding': this.defaultHeaders['Accept-Encoding'],
                'Referer': this.defaultHeaders['Referer'],
                'Origin': this.defaultHeaders['Origin']
              },
              httpAgent,
              httpsAgent
            });
          } else {
            // No direct URL available
            throw new Error('No direct URL available from details');
          }
        })();

        const primaryPromise = (async () => {
          return this.retryWithBackoff((attemptTimeout) => this.client.get(url, {
            headers: downloadHeaders,
            responseType: 'arraybuffer',
            timeout: attemptTimeout
          }).catch((err) => {
            // On retryable failure, trigger the parallel fallback chain
            const code = err?.code || '';
            const status = err?.response?.status;
            const isTimeout = code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(err.message || '');
            const isNetwork = code === 'ECONNRESET' || code === 'ECONNREFUSED';
            const isRetryableStatus = status === 429 || status === 503 || (status >= 500 && status <= 599);
            if (isTimeout || isNetwork || isRetryableStatus) triggerFallback();
            throw err;
          }), { totalTimeoutMs: timeout, maxRetries: 2, baseDelay: 800, minAttemptTimeoutMs: 2500 });
        })();

        // Resolve with the first successful response (ignore the first rejection)
        // Use Promise.any to wait for the first fulfillment among primary/fallback
        try {
          response = await Promise.any([primaryPromise, fallbackPromise]);
        } catch (e) {
          // If both fail, rethrow the first error for user-facing error semantics
          const firstErr = Array.isArray(e?.errors) && e.errors.length ? e.errors[0] : e;
          throw firstErr;
        }

      }

      // Check if response is a ZIP file or direct SRT content
      const contentType = response.headers && (response.headers['content-type'] || response.headers['Content-Type']) || '';
      const responseBody = response.data;
      const responseBuffer = Buffer.isBuffer(responseBody) ? responseBody : Buffer.from(responseBody);

      // Analyze response content to understand what we received
      const contentAnalysis = analyzeResponseContent(responseBuffer);

      // Check for ZIP file by magic bytes (PK signature) in addition to content-type
      // This handles cases where content-type header is missing or incorrect
      // Also check for RAR archives
      const archiveType = detectArchiveType(responseBuffer);
      const isZipByMagicBytes = contentAnalysis.type === 'zip';

      // If the response is actually direct subtitle content but was mis-labeled as ZIP
      if (contentAnalysis.type === 'subtitle' && (contentType.includes('application/zip') || contentType.includes('application/x-zip'))) {
        log.debug(() => `[SubSource] Response declared as ZIP but contains direct subtitle content; processing as subtitle`);
        const content = detectAndConvertEncoding(responseBuffer, 'SubSource', options.languageHint || null);
        return content;
      }

      if (archiveType || isZipByMagicBytes || contentType.includes('application/zip') ||
        contentType.includes('application/x-zip')) {

        // Validate archive signature before parsing
        if (!archiveType && !isZipByMagicBytes) {
          log.error(() => `[SubSource] Response declared as ZIP but missing valid archive signature. Content analysis: ${contentAnalysis.type} - ${contentAnalysis.hint}`);
          if (responseBuffer.length > 0) {
            const hexBytes = responseBuffer.slice(0, Math.min(16, responseBuffer.length)).toString('hex').match(/.{2}/g)?.join(' ') || '';
            log.debug(() => `[SubSource] First bytes: ${hexBytes}`);
          }
          return createInvalidResponseSubtitle('SubSource', contentAnalysis, responseBuffer.length);
        }

        log.debug(() => `[SubSource] Detected ${(archiveType || 'ZIP').toUpperCase()} archive`);

        // Use the centralized archive extractor
        return await extractSubtitleFromArchive(responseBuffer, {
          providerName: 'SubSource',
          maxBytes: MAX_ZIP_BYTES,
          isSeasonPack: isSeasonPack,
          season: seasonPackSeason,
          episode: seasonPackEpisode,
          languageHint: options.languageHint || null,
          skipAssConversion: options.skipAssConversion
        });
      }

      // Direct SRT content - detect encoding and convert to UTF-8
      log.debug(() => '[SubSource] Subtitle downloaded successfully');
      const content = detectAndConvertEncoding(responseBuffer, 'SubSource', options.languageHint || null);

      // If content appears to be WebVTT, keep it intact (we serve original to Stremio)
      const ct = contentType.toLowerCase();
      if (ct.includes('text/vtt') || content.trim().startsWith('WEBVTT')) {
        log.debug(() => '[SubSource] Detected VTT in direct response; returning original VTT');
        return content;
      }

      // Validate that the decoded content looks like SRT (contains timecodes or text)
      if (!content || content.trim().length === 0) {
        throw new Error('Downloaded subtitle content is empty');
      }

      return content;

    } catch (error) {
      handleDownloadError(error, 'SubSource');
    }
  }

  /**
   * Normalize language code to ISO-639-2 for Stremio
   * @param {string} language - Language code from SubSource
   * @returns {string} - ISO-639-2 language code (3-letter)
   */
  normalizeLanguageCode(language) {
    if (!language) return null;

    const lower = language.toLowerCase();

    // Map SubSource language names to ISO-639-2 codes for Stremio
    const languageMap = {
      'english': 'eng',
      'spanish': 'spa',
      'spanish_latin_america': 'spn',  // Latin America Spanish
      'spanish (latin america)': 'spn',
      'french': 'fre',
      'german': 'ger',
      'portuguese': 'por',
      'brazilian': 'pob',  // Brazilian Portuguese (legacy)
      'brazilian_portuguese': 'pob',  // Brazilian Portuguese (proper)
      'portuguese (brazil)': 'pob',
      'portuguese-brazilian': 'pob',
      'italian': 'ita',
      'russian': 'rus',
      'japanese': 'jpn',
      'korean': 'kor',
      'chinese': 'chi',
      'chinese_simplified': 'zhs',
      'chinese (simplified)': 'zhs',
      'chinese_traditional': 'zht',
      'chinese (traditional)': 'zht',
      'arabic': 'ara',
      'dutch': 'dut',
      'polish': 'pol',
      'turkish': 'tur',
      'swedish': 'swe',
      'danish': 'dan',
      'finnish': 'fin',
      'norwegian': 'nor',
      'hebrew': 'heb',
      'hindi': 'hin',
      'thai': 'tha',
      'vietnamese': 'vie',
      'indonesian': 'ind',
      'romanian': 'rum',
      'czech': 'cze',
      'hungarian': 'hun',
      'greek': 'gre',
      'bulgarian': 'bul',
      'croatian': 'hrv',
      'serbian': 'srp',
      'serbian (latin)': 'srp',
      'serbian (cyrillic)': 'srp',
      'ukrainian': 'ukr',
      'farsi_persian': 'per',
      'farsi/persian': 'per',
      'farsi': 'per',
      'persian': 'per',
      'malay': 'may',
      'estonian': 'est',
      'latvian': 'lav',
      'lithuanian': 'lit',
      'slovak': 'slo',
      'slovenian': 'slv',
      'bengali': 'ben',
      'tagalog': 'tgl',
      'filipino': 'tgl',
      'bosnian': 'bos',
      'macedonian': 'mac',
      'albanian': 'alb',
      'georgian': 'geo',
      'icelandic': 'ice',
      'catalan': 'cat',
      'basque': 'baq',
      'galician': 'glg',
      'welsh': 'wel',
      'swahili': 'swa',
      'malayalam': 'mal',
      'tamil': 'tam',
      'telugu': 'tel',
      'urdu': 'urd',
      'punjabi': 'pan',
      'nepali': 'nep',
      'sinhala': 'sin',
      'sinhalese': 'sin',
      'khmer': 'khm',
      'lao': 'lao',
      'burmese': 'bur',
      'mongolian': 'mon',
      'afrikaans': 'afr',
      'kurdish': 'kur',
      // SubSource-specific names (from their API language list)
      'brazillian portuguese': 'pob',  // SubSource uses double-l typo
      'abkhazian': 'abk',
      'amharic': 'amh',
      'aragonese': 'arg',
      'armenian': 'arm',
      'assamese': 'asm',
      'asturian': 'ast',
      'azerbaijani': 'aze',
      'belarusian': 'bel',
      'big 5 code': 'zht',  // Big5 = Traditional Chinese encoding
      'breton': 'bre',
      'chinese (cantonese)': 'yue',
      'chinese bg code': 'chi',  // BG code = Chinese encoding variant
      'chinese bilingual': 'ze',
      'dari': 'prs',
      'espranto': 'epo',  // SubSource typo for Esperanto
      'esperanto': 'epo',
      'extremaduran': 'ext',
      'french (canada)': 'fre',  // No distinct ISO code; map to generic French
      'french (france)': 'fre',
      'gaelic': 'gla',  // Scottish Gaelic
      'gaelician': 'glg',  // SubSource typo for Galician
      'greenlandic': 'kal',
      'igbo': 'ibo',
      'interlingua': 'ina',
      'irish': 'gle',
      'kannada': 'kan',
      'kazakh': 'kaz',
      'kyrgyz': 'kir',
      'luxembourgish': 'ltz',
      'manipuri': 'mni',
      'marathi': 'mar',
      'montenegrin': 'mne',
      'navajo': 'nav',
      'northen sami': 'sme',  // SubSource typo for Northern Sami
      'northern sami': 'sme',
      'occitan': 'oci',
      'odia': 'ori',
      'pashto': 'pus',
      'pushto': 'pus',
      'santli': 'sat',  // SubSource typo for Santali
      'santali': 'sat',
      'sindhi': 'snd',
      'somali': 'som',
      'sorbian': 'hsb',
      'spanish (spain)': 'spa',
      'sylheti': 'syl',
      'syriac': 'syr',
      'tatar': 'tat',
      'tetum': 'tet',
      'toki pona': 'tok',
      'turkmen': 'tuk',
      'uzbek': 'uzb'
    };

    // Check if it's a full language name from SubSource
    if (languageMap[lower]) {
      return languageMap[lower];
    }

    // Handle special cases
    if (lower.includes('portuguese') && (lower.includes('brazil') || lower === 'pt-br' || lower === 'ptbr' || lower === 'br')) {
      return 'pob';
    }

    // If it's already 3 letters, assume it's ISO-639-2
    if (lower.length === 3) {
      return lower;
    }

    // If it's 2 letters, convert from ISO-639-1 to ISO-639-2
    if (lower.length === 2) {
      const iso2Codes = toISO6392(lower);
      if (iso2Codes && iso2Codes.length > 0) {
        return iso2Codes[0].code2; // Return the first ISO-639-2 code
      }
    }

    // Unknown language
    return null;
  }
}

module.exports = SubSourceService;
