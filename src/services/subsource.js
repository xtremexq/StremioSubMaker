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
const zlib = require('zlib');
const log = require('../utils/logger');
const { waitForDownloadSlot, currentDownloadLimit } = require('../utils/downloadLimiter');
const { isTrueishFlag } = require('../utils/subtitleFlags');

const SUBSOURCE_API_URL = 'https://api.subsource.net/api/v1';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_LINK_CACHE = 2000; // in-memory direct-link cache size
const MAX_ZIP_BYTES = 25 * 1024 * 1024; // hard cap for ZIP downloads (~25MB) to avoid huge packs

/**
 * Create an informative SRT subtitle when an episode is not found in a season pack
 * @param {number} episode - Episode number that was not found
 * @param {number} season - Season number
 * @param {Array<string>} availableFiles - List of files that were found in the pack
 * @returns {string} - SRT subtitle content
 */
function createEpisodeNotFoundSubtitle(episode, season, availableFiles = []) {
  const seasonEpisodeStr = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

  // Try to extract episode numbers from available files to help user
  const foundEpisodes = availableFiles
    .map(filename => {
      // Match explicit episode labels (Episode 12, Ep12, Cap 12, etc.)
      const labeled = filename.match(/(?:episode|episodio|capitulo|cap|ep|e|ova|oad)\s*(\d{1,4})/i);
      if (labeled && labeled[1]) return parseInt(labeled[1], 10);

      // Fallback: any standalone 1-4 digit number not obviously a resolution/year
      const generic = filename.match(/(?:^|[^0-9])(\d{1,4})(?=[^0-9]|$)/);
      if (generic && generic[1]) {
        const n = parseInt(generic[1], 10);
        if (Number.isNaN(n)) return null;
        // Skip common resolutions/years
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

class SubSourceService {
  constructor(apiKey = null) {
    this.apiKey = apiKey;
    this.baseURL = SUBSOURCE_API_URL;
    this._linkCache = new Map(); // subsource_id -> direct download URL

    // Configure axios with default headers
    // Include Client Hints headers for better compatibility
    this.defaultHeaders = {
      'User-Agent': USER_AGENT,
      // Broaden Accept to cover JSON and common subtitle/binary types
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
      // Normalize Client Hints header casing to typical browser style
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-ch-ua-platform-version': '"15.0.0"',
      'sec-ch-ua-arch': '"x86"',
      'sec-ch-ua-bitness': '"64"',
      'sec-ch-ua-full-version': '"131.0.6778.86"',
      'sec-ch-ua-full-version-list': '"Chromium";v="131.0.6778.86", "Not_A Brand";v="24.0.0.0"',
      // Common XHR indicator header seen from browsers/frameworks
      'X-Requested-With': 'XMLHttpRequest'
    };

    // Add API key to headers
    if (this.apiKey && this.apiKey.trim() !== '') {
      this.defaultHeaders['X-API-Key'] = this.apiKey.trim();
      this.defaultHeaders['api-key'] = this.apiKey.trim();
      log.debug(() => '[SubSource] Initializing with API key in headers');
    }

    // Reusable axios client with pooling + DNS cache
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: this.defaultHeaders,
      httpAgent,
      httpsAgent,
      lookup: dnsLookup,
      timeout: 7000,
      maxRedirects: 5,
      decompress: true
    });
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
   * @param {string} imdb_id - IMDB ID (with 'tt' prefix)
   * @param {number} season - Season number (for TV shows)
   * @returns {Promise<string|null>} - SubSource movie ID or null
   */
  async getMovieId(imdb_id, season = null) {
    try {
      let searchUrl = `${this.baseURL}/movies/search?searchType=imdb&imdb=${imdb_id}`;

      // For TV shows, include season to get season-specific movieId
      if (season) {
        searchUrl += `&season=${season}`;
      }

      log.debug(() => ['[SubSource] Searching for movie:', searchUrl]);

      const response = await this.client.get(searchUrl, {
        responseType: 'json'
      });

      // Response could be an array of movies or a single movie
      let movies = Array.isArray(response.data) ? response.data : (response.data.data || []);

      if (movies.length > 0) {
        const movieId = movies[0].id || movies[0].movieId;
        const movieTitle = movies[0].title || 'Unknown';
        const movieSeason = movies[0].season || 'N/A';
        log.debug(() => `[SubSource] Found movieId=${movieId} for "${movieTitle}" (Season: ${movieSeason}, Total matches: ${movies.length})`);
        return movieId;
      }

      // Primary search returned no results – try deriving from subtitles/search endpoints
      try {
        const derived = await this._deriveMovieIdFromImdb(imdb_id, season);
        if (derived) return derived;
      } catch (_) { /* ignore and fall through */ }

      log.debug(() => ['[SubSource] No movie found for IMDB ID:', imdb_id, season ? `Season ${season}` : '']);
      return null;
    } catch (error) {
      logApiError(error, 'SubSource', 'Get movie ID', { skipResponseData: true, skipUserMessage: true });

      // If timeout/network – attempt a lightweight fallback using endpoints that accept imdb directly
      const code = error?.code || '';
      const msg = String(error?.message || '').toLowerCase();
      const isTimeout = code === 'ECONNABORTED' || code === 'ETIMEDOUT' || msg.includes('timeout');
      const isNetwork = code === 'ECONNRESET' || code === 'ECONNREFUSED';
      if (isTimeout || isNetwork) {
        try {
          const derived = await this._deriveMovieIdFromImdb(imdb_id, season);
          if (derived) return derived;
        } catch (_) { /* ignore */ }
      }

      return null;
    }
  }

  /**
   * Attempt to derive movieId by querying endpoints that accept imdb directly
   * Tries /subtitles?imdb=… then /search?imdb=…
   * @param {string} imdb_id
   * @param {number|null} season
   * @returns {Promise<string|null>}
   */
  async _deriveMovieIdFromImdb(imdb_id, season = null) {
    try {
      const params = new URLSearchParams();
      params.set('imdb', imdb_id);
      if (season) params.set('season', String(season));
      params.set('limit', '5');

      const endpoints = ['/subtitles', '/search'];
      for (const endpoint of endpoints) {
        const url = `${this.baseURL}${endpoint}?${params.toString()}`;
        log.debug(() => `[SubSource] Deriving movieId via ${endpoint} for ${imdb_id}${season ? ` S${season}` : ''}`);
        try {
          const { data } = await this.client.get(url, { responseType: 'json', timeout: 5000 });

          let list = null;
          if (Array.isArray(data)) list = data;
          else if (data?.subtitles) list = data.subtitles;
          else if (Array.isArray(data?.data)) list = data.data;
          else if (Array.isArray(data?.results)) list = data.results;

          if (Array.isArray(list) && list.length > 0) {
            for (const item of list) {
              const id = item?.movieId || item?.movie_id || item?.movie?.id || item?.movie?.movieId || item?.movie?.movie_id || null;
              if (id) {
                log.debug(() => `[SubSource] Derived movieId=${id} from ${endpoint} imdb=${imdb_id}${season ? ` S${season}` : ''}`);
                return id;
              }
            }
          }
        } catch (innerErr) {
          const status = innerErr?.response?.status;
          const code = innerErr?.code || '';
          const msg = String(innerErr?.message || '').toLowerCase();
          const isTimeout = code === 'ECONNABORTED' || code === 'ETIMEDOUT' || msg.includes('timeout');
          const isNetwork = code === 'ECONNRESET' || code === 'ECONNREFUSED';
          if (status === 404 || isTimeout || isNetwork) {
            continue;
          }
          break;
        }
      }
    } catch (_) { /* ignore */ }
    return null;
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

      const { imdb_id, type, season, episode, languages, excludeHearingImpairedSubtitles } = params;

      // SubSource requires IMDB ID - skip if not available (e.g., anime with Kitsu IDs)
      if (!imdb_id || imdb_id === 'undefined') {
        log.debug(() => '[SubSource] No IMDB ID available, skipping search');
        return [];
      }

      // First, get SubSource's internal movie ID
      // For TV shows, pass season to get season-specific movieId
      const movieId = await this.getMovieId(imdb_id, season);
      if (!movieId) {
        log.debug(() => ['[SubSource] Could not find movie ID for:', imdb_id]);
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
          'ara': 'arabic',
          'dut': 'dutch',
          'nld': 'dutch',
          'pol': 'polish',
          'tur': 'turkish',
          'swe': 'swedish',
          'dan': 'danish',
          'fin': 'finnish',
          'nor': 'norwegian',
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
          'uk': 'ukrainian'
        };

        return languageMap[lower] || null;
      }).filter(lang => lang !== null);

      // Remove duplicates and add language parameter if we have valid languages
      const uniqueLanguages = [...new Set(convertedLanguages)];
      if (uniqueLanguages.length > 0) {
        queryParams.language = uniqueLanguages.join(',');
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

      try {
        const rawResponse = await this.client.get(url, {
          responseType: 'json'
        });

        response = rawResponse.data;
      } catch (error) {
        if (error.response?.status === 404) {
          log.debug(() => '[SubSource] /subtitles endpoint not found, trying /search');
          endpoint = '/search';
          const searchUrl = `${this.baseURL}${endpoint}?${queryString}`;

          const rawResponse = await this.client.get(searchUrl, {
            responseType: 'json'
          });

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
          try { this.rememberDownloadLink(subtitleId, directUrl); } catch (_) {}
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
          // Patterns: "season 3", "third season", "complete season 3", "s03 complete", etc.
          const seasonPackPatterns = [
            new RegExp(`(?:complete|full|entire)?\\s*(?:season|s)\\s*0*${targetSeason}(?:\\s+(?:complete|full|pack))?(?!.*e0*\\d)`, 'i'),
            new RegExp(`(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\\s+season(?!.*episode)`, 'i'),
            new RegExp(`s0*${targetSeason}\\s*(?:complete|full|pack)`, 'i')
          ];

          // Anime-specific season pack patterns (often don't include season numbers)
          // Patterns: "complete", "batch", "01-12", "1~12", "[Batch]", etc.
          const animeSeasonPackPatterns = [
            /(?:complete|batch|full(?:\s+series)?|\d{1,2}\s*[-~]\s*\d{1,2})/i,
            /\[(?:batch|complete|full)\]/i,
            /(?:episode\s*)?(?:01|001)\s*[-~]\s*(?:\d{2}|\d{3})/i  // 01-12, 001-024
          ];

          let isSeasonPack = false;

          if (type === 'anime-episode') {
            // For anime, use anime-specific patterns and don't require season numbers
            isSeasonPack = animeSeasonPackPatterns.some(pattern => pattern.test(name)) &&
                          !/(?:^|[^0-9])0*${targetEpisode}(?:v\d+)?(?:[^0-9]|$)/.test(name); // Exclude if has specific episode number
          } else {
            // For regular TV shows, use season-based patterns
            isSeasonPack = seasonPackPatterns.some(pattern => pattern.test(name)) &&
                          !/s0*\d+e0*\d+|\d+x\d+|episode\s*\d+|ep\s*\d+/i.test(name); // Exclude if has episode number
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
            // E01 / EP01 / E 01 / EP 01 / (01) / [01] / - 01 / _01 / 01v2
            new RegExp(`(?<=\\b|\\s|\\[|\\(|-|_)e?p?\\s*0*${targetEpisode}(?:v\\d+)?(?=\\b|\\s|\\]|\\)|\\.|-|_|$)`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${targetEpisode}(?:v\\d+)?(?=$|[\\s\\]\\)\\-_.])`, 'i'),
            // 01en / 01eng (language suffix immediately after episode number before extension)
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${targetEpisode}(?:v\\d+)?[a-z]{2,3}(?=\\.|[\\s\\]\\)\\-_.]|$)`, 'i'),

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

      // Limit to 20 results per language to control response size
      const MAX_RESULTS_PER_LANGUAGE = 20;
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
  async downloadSubtitle(fileId, subsource_id = null) {
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

      const waitedMs = await waitForDownloadSlot('SubSource');
      if (waitedMs > 0) {
        const { maxPerMinute } = currentDownloadLimit();
        log.debug(() => `[SubSource] Throttling download (${maxPerMinute}/min) waited ${waitedMs}ms`);
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
            try { triggerFallbackResolve && triggerFallbackResolve(); } catch (_) {}
          }
        };

        const fallbackGate = new Promise((resolve) => { triggerFallbackResolve = resolve; });

        const fallbackPromise = (async () => {
          // Wait until primary reports the first retryable failure
          await fallbackGate;
          log.warn(() => '[SubSource] Primary started failing — launching details→CDN in parallel');

          // Try to fetch subtitle details to obtain a direct download URL (often served via CDN)
          const detailResp = await this.client.get(`/subtitles/${subsource_id}`, {
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
          }), { totalTimeoutMs: 7000, maxRetries: 2, baseDelay: 800, minAttemptTimeoutMs: 2500 });
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

      // Check for ZIP file by magic bytes (PK signature) in addition to content-type
      // This handles cases where content-type header is missing or incorrect
      const isZipByMagicBytes = responseBuffer.length > 4 &&
        responseBuffer[0] === 0x50 && responseBuffer[1] === 0x4B && // PK
        responseBuffer[2] === 0x03 && responseBuffer[3] === 0x04;   // \x03\x04

      if (isZipByMagicBytes || contentType.includes('application/zip') ||
          contentType.includes('application/x-zip')) {
        // Guard against huge ZIPs before attempting to parse
        const zipSize = responseBuffer.length;
        if (zipSize > MAX_ZIP_BYTES) {
          log.warn(() => `[SubSource] ZIP too large (${zipSize} bytes > ${MAX_ZIP_BYTES}); returning info subtitle instead of parsing`);
          return createZipTooLargeSubtitle(MAX_ZIP_BYTES, zipSize);
        }

        // Validate ZIP signature before parsing
        if (!isZipByMagicBytes) {
          log.error(() => '[SubSource] Response declared as ZIP but missing PK signature');
          throw new Error('Invalid ZIP file from SubSource (missing ZIP header)');
        }

        // Handle ZIP file
        const JSZip = require('jszip');
        log.debug(() => '[SubSource] Detected ZIP file format (checking contents)');
        let zip;
        try {
          zip = await JSZip.loadAsync(responseBuffer, { base64: false });
        } catch (zipErr) {
          log.error(() => ['[SubSource] Failed to parse ZIP from SubSource:', zipErr.message]);
          throw new Error('Invalid ZIP file from SubSource (corrupted or incomplete)');
        }

        const entries = Object.keys(zip.files);

        // Helper function to find episode file in season pack (regular TV shows)
        const findEpisodeFile = (files, season, episode) => {
          const seasonEpisodePatterns = [
            new RegExp(`s0*${season}e0*${episode}(?![0-9])`, 'i'),        // S02E01, s02e01
            new RegExp(`${season}x0*${episode}(?![0-9])`, 'i'),           // 2x01
            new RegExp(`s0*${season}[\\s._-]*x[\\s._-]*e?0*${episode}(?![0-9])`, 'i'), // S02xE01, S02x1
            new RegExp(`0*${season}[\\s._-]*x[\\s._-]*e?0*${episode}(?![0-9])`, 'i'),  // 2xE01, 02x01
            new RegExp(`s0*${season}\\.e0*${episode}(?![0-9])`, 'i'),     // S02.E01
            new RegExp(`season[\\s._-]*0*${season}[\\s._-]*episode[\\s._-]*0*${episode}(?![0-9])`, 'i')  // Season 2 Episode 1
          ];

          // Find file that matches the episode pattern
          for (const filename of files) {
            const lowerName = filename.toLowerCase();
            // Skip directories
            if (zip.files[filename].dir) continue;

            // Check if file matches episode patterns
            if (seasonEpisodePatterns.some(pattern => pattern.test(lowerName))) {
              return filename;
            }
          }

          return null;
        };

        // Helper function to find episode file in anime season pack (episode number only)
        const findEpisodeFileAnime = (files, episode) => {
          // Anime-friendly episode-only patterns (no season required)
          const animeEpisodePatterns = [
            // E01 / EP01 / Episode 01 / Ep 01
            new RegExp(`(?<=\\b|\\s|\\[|\\(|-|_)e(?:p(?:isode)?)?[\\s._-]*0*${episode}(?:v\\d+)?(?=\\b|\\s|\\]|\\)|\\.|-|_|$)`, 'i'),
            // [01] / (01) / - 01 / _01 / .01. (with boundaries)
            new RegExp(`(?:^|[\\s\\[\\(\\-_.])0*${episode}(?:v\\d+)?(?=$|[\\s\\]\\)\\-_.])`, 'i'),
            // 01en / 01eng (language suffix immediately after episode number before extension)
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${episode}(?:v\\d+)?[a-z]{2,3}(?=\\.|[\\s\\]\\)\\-_.]|$)`, 'i'),
            // Episode 01 / Episodio 01 / Capitulo 01
            new RegExp(`(?:episode|episodio|ep|cap(?:itulo)?)\\s*0*${episode}(?![0-9])`, 'i'),
            // Japanese/Chinese/Korean: 第01話 / 01話 / 01集 / 1화
            new RegExp(`第?\\s*0*${episode}\\s*(?:話|集|화)`, 'i'),
            // Must NOT match resolution/year patterns
            new RegExp(`^(?!.*(?:720|1080|480|2160)p).*[\\[\\(\\-_\\s]0*${episode}[\\]\\)\\-_\\s\\.]`, 'i')
          ];

          // Find file that matches the episode pattern
          for (const filename of files) {
            const lowerName = filename.toLowerCase();
            // Skip directories
            if (zip.files[filename].dir) continue;

            // Skip if it looks like a resolution or year (e.g., 1080p, 2023)
            if (/(?:720|1080|480|2160)p|(?:19|20)\d{2}/.test(lowerName)) {
              // Only skip if the episode number appears in these contexts
              const episodeStr = String(episode).padStart(2, '0');
              if (lowerName.includes(`${episodeStr}p`) || lowerName.includes(`20${episodeStr}`)) {
                continue;
              }
            }

            // Check if file matches episode patterns
            if (animeEpisodePatterns.some(pattern => pattern.test(lowerName))) {
              return filename;
            }
          }

          return null;
        };

        let targetEntry = null;

        // If this is a season pack, find the specific episode file
        if (isSeasonPack && seasonPackSeason && seasonPackEpisode) {
          log.debug(() => `[SubSource] Searching for S${String(seasonPackSeason).padStart(2, '0')}E${String(seasonPackEpisode).padStart(2, '0')} in season pack ZIP`);
          log.debug(() => `[SubSource] Available files in ZIP: ${entries.join(', ')}`);

          // Prefer SRT when both SRT and ASS/SSA exist
          const srtFiles = entries.filter(filename => filename.toLowerCase().endsWith('.srt') && !zip.files[filename].dir);

          // Try anime-specific patterns first (episode-only, no season)
          // This works for anime where files are just "01.srt", "ep01.srt", etc.
          targetEntry = findEpisodeFileAnime(srtFiles, seasonPackEpisode);

          if (targetEntry) {
            log.debug(() => `[SubSource] Found SRT episode file using anime patterns: ${targetEntry}`);
          } else {
            // Fallback to regular TV show patterns (season+episode) within SRT files
            targetEntry = findEpisodeFile(srtFiles, seasonPackSeason, seasonPackEpisode);

            if (targetEntry) {
              log.debug(() => `[SubSource] Found SRT episode file using TV show patterns: ${targetEntry}`);
            } else {
              // If no matching SRT, try any format (anime patterns first, then TV patterns)
              let anyMatch = findEpisodeFileAnime(entries, seasonPackEpisode);
              if (anyMatch) {
                log.debug(() => `[SubSource] Found episode file using anime patterns: ${anyMatch}`);
                targetEntry = anyMatch;
              } else {
                anyMatch = findEpisodeFile(entries, seasonPackSeason, seasonPackEpisode);
                if (anyMatch) {
                  log.debug(() => `[SubSource] Found episode file using TV show patterns: ${anyMatch}`);
                  targetEntry = anyMatch;
                } else {
                  log.warn(() => `[SubSource] Could not find episode ${seasonPackEpisode} (S${String(seasonPackSeason).padStart(2, '0')}E${String(seasonPackEpisode).padStart(2, '0')}) in season pack ZIP`);
                  log.warn(() => `[SubSource] Available files: ${entries.join(', ')}`);
                  // Return informative subtitle instead of throwing error
                  return createEpisodeNotFoundSubtitle(seasonPackEpisode, seasonPackSeason, entries);
                }
              }
            }
          }
        } else {
          // Not a season pack - use the first .srt file
          targetEntry = entries.find(filename => filename.toLowerCase().endsWith('.srt'));
        }

        // Extract and return the target .srt file if found
        if (targetEntry && targetEntry.toLowerCase().endsWith('.srt')) {
          // Read as buffer to detect encoding properly
          const buffer = await zip.files[targetEntry].async('nodebuffer');
          const subtitleContent = detectAndConvertEncoding(buffer, 'SubSource');
          log.debug(() => `[SubSource] Subtitle downloaded and extracted successfully from ZIP (.srt): ${targetEntry}`);
          return subtitleContent;
        }

        // Fallback: support common formats (.vtt, .ass, .ssa, .sub)
        let altEntry = null;

        if (isSeasonPack && seasonPackSeason && seasonPackEpisode) {
          // For season packs, search for episode file with alternate formats
          const altFormatFiles = entries.filter(filename => {
            const f = filename.toLowerCase();
            return (f.endsWith('.vtt') || f.endsWith('.ass') || f.endsWith('.ssa') || f.endsWith('.sub')) && !zip.files[filename].dir;
          });

          // Try anime-specific patterns first, then regular TV show patterns
          altEntry = findEpisodeFileAnime(altFormatFiles, seasonPackEpisode);

          if (!altEntry) {
            altEntry = findEpisodeFile(altFormatFiles, seasonPackSeason, seasonPackEpisode);
          }

          if (altEntry) {
            log.debug(() => `[SubSource] Found episode file with alternate format in season pack: ${altEntry}`);
          }
        } else {
          // Not a season pack - use the first alternate format file
          altEntry = entries.find(filename => {
            const f = filename.toLowerCase();
            return f.endsWith('.vtt') || f.endsWith('.ass') || f.endsWith('.ssa') || f.endsWith('.sub');
          });
        }

        if (altEntry) {
          // Read raw bytes and decode with BOM awareness
          const uint8 = await zip.files[altEntry].async('uint8array');
          const buf = Buffer.from(uint8);

          let raw;
          if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
            raw = buf.slice(2).toString('utf16le');
            log.debug(() => `[SubSource] Detected UTF-16LE BOM in ${altEntry}; decoded as UTF-16LE`);
          } else if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
            const swapped = Buffer.allocUnsafe(Math.max(0, buf.length - 2));
            for (let i = 2, j = 0; i + 1 < buf.length; i += 2, j += 2) {
              swapped[j] = buf[i + 1];
              swapped[j + 1] = buf[i];
            }
            raw = swapped.toString('utf16le');
            log.debug(() => `[SubSource] Detected UTF-16BE BOM in ${altEntry}; decoded as UTF-16BE->LE`);
          } else {
            raw = buf.toString('utf8');
          }
          // Strip UTF-8 BOM if present (prevents first-letter loss in some players)
          if (raw && typeof raw === 'string') raw = raw.replace(/^\uFEFF/, '');

          const lower = altEntry.toLowerCase();
          if (lower.endsWith('.vtt')) {
            log.debug(() => `[SubSource] Keeping original VTT: ${altEntry}`);
            return raw;
          }

          // Handle MicroDVD .sub files (text-based, frame-based timing)
          if (lower.endsWith('.sub')) {
            const isMicroDVD = /^\s*\{\d+\}\{\d+\}/.test(raw);
            if (isMicroDVD) {
              log.debug(() => `[SubSource] Detected MicroDVD .sub format: ${altEntry}`);
              try {
                const subsrt = require('subsrt-ts');
                const fps = 25;
                const converted = subsrt.convert(raw, { to: 'vtt', from: 'sub', fps: fps });
                if (converted && typeof converted === 'string' && converted.trim().length > 0) {
                  log.debug(() => `[SubSource] Converted MicroDVD .sub to .vtt successfully (fps=${fps})`);
                  return converted;
                }
              } catch (subErr) {
                log.error(() => ['[SubSource] Failed to convert MicroDVD .sub to .vtt:', subErr.message]);
              }
            } else {
              log.warn(() => `[SubSource] Detected VobSub .sub format (binary/image-based): ${altEntry} - not supported, skipping`);
            }
          }

          // Try enhanced ASS/SSA conversion for .ass and .ssa files
          if (lower.endsWith('.ass') || lower.endsWith('.ssa')) {
            const assConverter = require('../utils/assConverter');
            const format = lower.endsWith('.ass') ? 'ass' : 'ssa';
            const result = assConverter.convertASSToVTT(raw, format);

            if (result.success) {
              log.debug(() => `[SubSource] Converted ${altEntry} to .vtt successfully (enhanced converter)`);
              return result.content;
            } else {
              log.warn(() => `[SubSource] Enhanced converter failed: ${result.error}, trying fallback`);
            }
          }

          // Try library conversion first (to VTT) for other formats
          let converted = null;
          let conversionError = null;

          try {
            const subsrt = require('subsrt-ts');
            if (lower.endsWith('.ass')) {
              converted = subsrt.convert(raw, { to: 'vtt', from: 'ass' });
            } else if (lower.endsWith('.ssa')) {
              converted = subsrt.convert(raw, { to: 'vtt', from: 'ssa' });
            } else {
              converted = subsrt.convert(raw, { to: 'vtt' });
            }

            if (!converted || typeof converted !== 'string' || converted.trim().length === 0) {
              const sanitized = (raw || '').replace(/\u0000/g, '');
              if (sanitized && sanitized !== raw) {
                if (lower.endsWith('.ass')) {
                  converted = subsrt.convert(sanitized, { to: 'vtt', from: 'ass' });
                } else if (lower.endsWith('.ssa')) {
                  converted = subsrt.convert(sanitized, { to: 'vtt', from: 'ssa' });
                } else {
                  converted = subsrt.convert(sanitized, { to: 'vtt' });
                }
              }
            }
          } catch (convErr) {
            conversionError = convErr;
            log.error(() => ['[SubSource] Failed to convert to .vtt:', convErr.message, 'file:', altEntry]);
          }

          // Validate library conversion result
          if (converted && typeof converted === 'string' && converted.trim().length > 0) {
            // Validate that the converted VTT actually has subtitle content (timing cues)
            // A valid VTT should have lines like "00:00:00.000 --> 00:00:10.000"
            const hasTimingCues = /\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/.test(converted);

            if (hasTimingCues) {
              log.debug(() => `[SubSource] Converted ${altEntry} to .vtt successfully`);
              return converted;
            } else {
              log.warn(() => `[SubSource] Converted VTT has no timing cues (only ${converted.length} bytes), trying manual parser`);
            }
          } else if (conversionError) {
            log.warn(() => `[SubSource] Library conversion failed, trying manual parser`);
          } else {
            log.warn(() => `[SubSource] Library conversion resulted in empty output, trying manual parser`);
          }

          // Manual fallback for common ASS/SSA formats
          try {
            const manual = (function assToVttFallback(input) {
                if (!input || !/\[events\]/i.test(input)) return null;
                const lines = input.split(/\r?\n/);
                let format = [];
                let inEvents = false;
                for (const line of lines) {
                  const l = line.trim();
                  if (/^\[events\]/i.test(l)) { inEvents = true; continue; }
                  if (!inEvents) continue;
                  if (/^\[.*\]/.test(l)) break;
                  if (/^format\s*:/i.test(l)) {
                    format = l.split(':')[1].split(',').map(s => s.trim().toLowerCase());
                  }
                }
                const idxStart = Math.max(0, format.indexOf('start'));
                const idxEnd = Math.max(1, format.indexOf('end'));
                const idxText = format.length > 0 ? Math.max(format.indexOf('text'), format.length - 1) : 9;
                const out = ['WEBVTT', ''];
                const parseTime = (t) => {
                  const m = t.trim().match(/(\d+):(\d{2}):(\d{2})[\.\:](\d{2})/);
                  if (!m) return null;
                  const h = parseInt(m[1], 10) || 0;
                  const mi = parseInt(m[2], 10) || 0;
                  const s = parseInt(m[3], 10) || 0;
                  const cs = parseInt(m[4], 10) || 0;
                  const ms = (h*3600 + mi*60 + s) * 1000 + cs * 10;
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
                  const parts = [];
                  let cur = '';
                  let splits = 0;
                  for (let i = 0; i < payload.length; i++) {
                    const ch = payload[i];
                    if (ch === ',' && splits < Math.max(idxText, 9)) { parts.push(cur); cur = ''; splits++; }
                    else { cur += ch; }
                  }
                  parts.push(cur);
                  const start = parts[idxStart];
                  const end = parts[idxEnd];
                  const text = parts[idxText] ?? '';
                  const st = parseTime(start);
                  const et = parseTime(end);
                  if (!st || !et) continue;
                  const ct = cleanText(text);
                  if (!ct) continue;
                  out.push(`${st} --> ${et}`);
                  out.push(ct);
                  out.push('');
                }
                if (out.length <= 2) return null;
                return out.join('\n');
              })(raw);

            if (manual && manual.trim().length > 0) {
              log.debug(() => `[SubSource] Fallback converted ${altEntry} to .vtt successfully (manual parser)`);
              return manual;
            }
          } catch (fallbackErr) {
            log.error(() => ['[SubSource] Manual ASS/SSA fallback failed:', fallbackErr.message, 'file:', altEntry]);
          }
        }

        log.error(() => ['[SubSource] Available files in ZIP:', entries.join(', ')]);
        throw new Error('Failed to extract or convert subtitle from ZIP (no .srt and conversion to VTT failed)');
      } else {
        // Direct SRT content - detect encoding and convert to UTF-8
        log.debug(() => '[SubSource] Subtitle downloaded successfully');
        const content = detectAndConvertEncoding(responseBuffer, 'SubSource');

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
      }

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
      'ukrainian': 'ukr'
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
