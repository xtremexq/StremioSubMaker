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
const { httpAgent, httpsAgent } = require('../utils/httpAgents');
const zlib = require('zlib');
const log = require('../utils/logger');

const SUBSOURCE_API_URL = 'https://api.subsource.net/api/v1';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

class SubSourceService {
  constructor(apiKey = null) {
    this.apiKey = apiKey;
    this.baseURL = SUBSOURCE_API_URL;

    // Configure axios with default headers
    // Include Client Hints headers for better compatibility
    this.defaultHeaders = {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://subsource.net/',
      'Origin': 'https://subsource.net',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
      'Sec-CH-UA': '"Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"',
      'Sec-CH-UA-Platform-Version': '"15.0.0"',
      'Sec-CH-UA-Arch': '"x86"',
      'Sec-CH-UA-Bitness': '"64"',
      'Sec-CH-UA-Full-Version': '"131.0.6778.86"',
      'sec-ch-ua-full-version-list': '"Chromium";v="131.0.6778.86", "Not_A Brand";v="24.0.0.0"',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    };

    // Add API key to headers
    if (this.apiKey && this.apiKey.trim() !== '') {
      this.defaultHeaders['X-API-Key'] = this.apiKey.trim();
      this.defaultHeaders['api-key'] = this.apiKey.trim();
      log.debug(() => '[SubSource] Initializing with API key in headers');
    }
  }

  /**
   * Search for movie/show by IMDB ID to get SubSource movieId
   * @param {string} imdb_id - IMDB ID (with 'tt' prefix)
   * @returns {Promise<string|null>} - SubSource movie ID or null
   */
  async getMovieId(imdb_id) {
    try {
      const searchUrl = `${this.baseURL}/movies/search?searchType=imdb&imdb=${imdb_id}`;
      log.debug(() => ['[SubSource] Searching for movie:', searchUrl]);

      const response = await axios.get(searchUrl, {
        headers: this.defaultHeaders,
        responseType: 'json',
        httpAgent,
        httpsAgent
      });

      // Response could be an array of movies or a single movie
      let movies = Array.isArray(response.data) ? response.data : (response.data.data || []);

      if (movies.length > 0) {
        const movieId = movies[0].id || movies[0].movieId;
        log.debug(() => ['[SubSource] Found SubSource movie ID:', movieId]);
        return movieId;
      }

      log.debug(() => ['[SubSource] No movie found for IMDB ID:', imdb_id]);
      return null;
    } catch (error) {
      logApiError(error, 'SubSource', 'Get movie ID', { skipResponseData: true, skipUserMessage: true });
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

      const { imdb_id, type, season, episode, languages } = params;

      // First, get SubSource's internal movie ID
      const movieId = await this.getMovieId(imdb_id);
      if (!movieId) {
        log.debug(() => ['[SubSource] Could not find movie ID for:', imdb_id]);
        return [];
      }

      // Build query parameters for SubSource API
      const queryParams = {
        movieId: movieId
      };

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

      // For TV shows, add season and episode parameters
      if (type === 'episode' && season && episode) {
        queryParams.season = season;
        queryParams.episode = episode;
      }

      log.debug(() => ['[SubSource] Searching with params:', JSON.stringify(queryParams)]);

      // Try /subtitles endpoint first (more common pattern), fallback to /search if needed
      let response;
      let endpoint = '/subtitles';

      // Build query string
      const queryString = new URLSearchParams(queryParams).toString();
      const url = `${this.baseURL}${endpoint}?${queryString}`;

      try {
        const rawResponse = await axios.get(url, {
          headers: this.defaultHeaders,
          responseType: 'json',
          httpAgent,
          httpsAgent
        });

        response = rawResponse.data;
      } catch (error) {
        if (error.response?.status === 404) {
          log.debug(() => '[SubSource] /subtitles endpoint not found, trying /search');
          endpoint = '/search';
          const searchUrl = `${this.baseURL}${endpoint}?${queryString}`;

          const rawResponse = await axios.get(searchUrl, {
            headers: this.defaultHeaders,
            responseType: 'json',
            httpAgent,
            httpsAgent
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

      const subtitles = subtitlesData.map(sub => {
        const originalLang = sub.language || 'en';
        const normalizedLang = this.normalizeLanguageCode(originalLang);

        // SubSource provides subtitle ID - check multiple possible field names
        const subtitleId = sub.id || sub.subtitleId || sub.subtitle_id || sub._id;
        const fileId = `subsource_${subtitleId}`;

        // Log subtitle structure for debugging if ID is missing
        if (!subtitleId) {
          log.error(() => '[SubSource] WARNING: Subtitle missing ID field');
        }

        return {
          id: fileId,
          language: originalLang,
          languageCode: normalizedLang,
          name: sub.name || sub.release_name || sub.fullname || 'Unknown',
          downloads: parseInt(sub.downloads || sub.download_count) || 0,
          rating: parseFloat(sub.rating) || 0,
          uploadDate: sub.upload_date || sub.created_at,
          format: sub.format || 'srt',
          fileId: fileId,
          downloadLink: sub.download_url || sub.url,
          hearing_impaired: sub.hearing_impaired || sub.hi || false,
          foreign_parts_only: false,
          machine_translated: false,
          uploader: sub.uploader || sub.author || 'Unknown',
          provider: 'subsource',
          // Store SubSource-specific IDs for download
          subsource_id: subtitleId
        };
      });

      // Limit to 20 results per language to control response size
      const MAX_RESULTS_PER_LANGUAGE = 20;
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
      log.debug(() => `[SubSource] Found ${subtitles.length} subtitles total, limited to ${limitedSubtitles.length} (max ${MAX_RESULTS_PER_LANGUAGE} per language)`);
      return limitedSubtitles;

    } catch (error) {
      return handleSearchError(error, 'SubSource');
    }
  }

  /**
   * Download subtitle content
   * @param {string} fileId - File ID from search results (format: subsource_<id>)
   * @param {string} subsource_id - SubSource subtitle ID
   * @returns {Promise<string>} - Subtitle content as text
   */
  async downloadSubtitle(fileId, subsource_id = null) {
    try {
      log.debug(() => ['[SubSource] Downloading subtitle:', fileId]);

      // Parse the fileId to extract subsource_id if not provided
      if (!subsource_id) {
        const parts = fileId.split('_');
        if (parts.length >= 2 && parts[0] === 'subsource') {
          subsource_id = parts[1];
        } else {
          throw new Error('Invalid SubSource file ID format');
        }
      }

      log.debug(() => ['[SubSource] SubSource ID:', subsource_id]);

      // Check if we have a valid ID
      if (!subsource_id || subsource_id === 'undefined') {
        throw new Error('Invalid or missing SubSource subtitle ID');
      }

      // Request download from SubSource API (API key is in headers)
      // According to API docs: GET /subtitles/{id}/download
      const url = `${this.baseURL}/subtitles/${subsource_id}/download`;
      const response = await axios.get(url, {
        headers: this.defaultHeaders,
        responseType: 'arraybuffer', // Get response as buffer
        httpAgent,
        httpsAgent
      });

      // Check if response is a ZIP file or direct SRT content
      const contentType = response.headers['content-type'] || '';
      const responseBody = response.data;
      const responseBuffer = Buffer.isBuffer(responseBody) ? responseBody : Buffer.from(responseBody);

      // Check for ZIP file by magic bytes (PK signature) in addition to content-type
      // This handles cases where content-type header is missing or incorrect
      const isZipByMagicBytes = responseBuffer.length > 4 &&
        responseBuffer[0] === 0x50 && responseBuffer[1] === 0x4B && // PK
        responseBuffer[2] === 0x03 && responseBuffer[3] === 0x04;   // \x03\x04

      if (isZipByMagicBytes || contentType.includes('application/zip') ||
          contentType.includes('application/x-zip')) {
        // Handle ZIP file
        const JSZip = require('jszip');
        console.log('[SubSource] Detected ZIP file format (checking contents)');
        const zip = await JSZip.loadAsync(responseBuffer, { base64: false });

        // Find the first .srt file in the ZIP
        const srtFile = Object.keys(zip.files).find(filename => filename.toLowerCase().endsWith('.srt'));

        if (!srtFile) {
          throw new Error('No .srt file found in downloaded ZIP');
        }

        const subtitleContent = await zip.files[srtFile].async('string');
        log.debug(() => '[SubSource] Subtitle downloaded and extracted successfully from ZIP');
        return subtitleContent;
      } else {
        // Direct SRT content - decode as UTF-8
        log.debug(() => '[SubSource] Subtitle downloaded successfully');
        const content = responseBuffer.toString('utf-8');

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
