const axios = require('axios');
const { toISO6391, toISO6392 } = require('../utils/languages');
const { handleSearchError, handleDownloadError, handleAuthError } = require('../utils/apiErrorHandler');
const { httpAgent, httpsAgent } = require('../utils/httpAgents');
const { version } = require('../utils/version');
const log = require('../utils/logger');

const OPENSUBTITLES_API_URL = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = `SubMaker v${version}`;

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

    this.token = null;
    this.tokenExpiry = null;

    // Read API key at runtime (not at module load time)
    const apiKey = getOpenSubtitlesApiKey();

    // Create axios instance with default configuration
    const defaultHeaders = {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    // Add API key if configured
    if (apiKey) {
      defaultHeaders['Api-Key'] = apiKey;
      // Only log once at startup
      if (!OpenSubtitlesService.initLogged) {
        log.warn(() => '[OpenSubtitles] API key loaded successfully from environment');
      }
    }

    this.client = axios.create({
      baseURL: OPENSUBTITLES_API_URL,
      headers: defaultHeaders,
      httpAgent,
      httpsAgent
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
    this.client.interceptors.request.use((config) => {
      if (this.token && !this.isTokenExpired()) {
        config.headers['Authorization'] = `Bearer ${this.token}`;
      }
      return config;
    });
  }

  /**
   * Check if token is expired
   * @returns {boolean}
   */
  isTokenExpired() {
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

      log.debug(() => '[OpenSubtitles] User authentication successful');
      return this.token;

    } catch (error) {
      return handleAuthError(error, 'OpenSubtitles');
    }
  }

    /**
   * Login to OpenSubtitles REST API (optional, for higher download limits)
   * @returns {Promise<string|null>} - JWT token if credentials provided, null otherwise
   */
  async login() {
    if (this.config.username && this.config.password) {
      return await this.loginWithCredentials(this.config.username, this.config.password);
    }
    // No credentials provided, use basic API access
    return null;
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

      if (this.isTokenExpired()) {
        const loginResult = await this.login();
        if (!loginResult) {
          // Authentication failed, handleAuthError already logged it
          return [];
        }
      }

      const { imdb_id, type, season, episode, languages } = params;

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

      if (type === 'episode' && season && episode) {
        queryParams.season_number = season;
        queryParams.episode_number = episode;
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

      const subtitles = response.data.data.map(sub => {

        const originalLang = sub.attributes.language;
        const normalizedLang = this.normalizeLanguageCode(originalLang);
        const fileId = sub.attributes.files?.[0]?.file_id || sub.id;

        return {
          id: String(fileId),
          language: originalLang,
          languageCode: normalizedLang,
          name: sub.attributes.release || sub.attributes.feature_details?.movie_name || 'Unknown',
          downloads: parseInt(sub.attributes.download_count) || 0,
          rating: parseFloat(sub.attributes.ratings) || 0,
          uploadDate: sub.attributes.upload_date,
          format: sub.attributes.format || 'srt',
          fileId: String(fileId),
          downloadLink: sub.attributes.url,
          hearing_impaired: sub.attributes.hearing_impaired || false,
          foreign_parts_only: sub.attributes.foreign_parts_only || false,
          machine_translated: sub.attributes.machine_translated || false,
          uploader: sub.attributes.uploader?.name || 'Unknown',
          provider: 'opensubtitles'
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

      // Authenticate with user credentials (required)
      if (!this.config.username || !this.config.password) {
        log.error(() => '[OpenSubtitles] Username and password are required. Please configure your OpenSubtitles credentials.');
        throw new Error('OpenSubtitles credentials not configured');
      }

      if (this.isTokenExpired()) {
        const loginResult = await this.login();
        if (!loginResult) {
          // Authentication failed, handleAuthError already logged it
          throw new Error('OpenSubtitles authentication failed');
        }
      }

      // First, request download link
      const downloadResponse = await this.client.post('/download', {
        file_id: parseInt(fileId)
      });

      if (!downloadResponse.data || !downloadResponse.data.link) {
        throw new Error('No download link received');
      }

      const downloadLink = downloadResponse.data.link;
      log.debug(() => ['[OpenSubtitles] Got download link:', downloadLink]);

      // Download the subtitle file
      const subtitleResponse = await axios.get(downloadLink, {
        responseType: 'text',
        headers: {
          'User-Agent': USER_AGENT
        },
        httpAgent,
        httpsAgent
      });

      const subtitleContent = subtitleResponse.data;
      log.debug(() => '[OpenSubtitles] Subtitle downloaded successfully');
      return subtitleContent;

    } catch (error) {
      handleDownloadError(error, 'OpenSubtitles');
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
