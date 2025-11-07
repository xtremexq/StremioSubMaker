const axios = require('axios');
const { toISO6391, toISO6392 } = require('../utils/languages');
const DEFAULT_API_KEYS = require('../config/defaultApiKeys');

const OPENSUBTITLES_API_URL = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'StremioSubtitleTranslator v1.0';
// Resolve API key from (priority): per-config -> env -> defaults (empty)
const resolveApiKey = (cfg) => {
  if (cfg && typeof cfg.opensubtitlesApiKey === 'string' && cfg.opensubtitlesApiKey.trim() !== '') {
    return cfg.opensubtitlesApiKey.trim();
  }
  if (process.env.OPENSUBTITLES_API_KEY && process.env.OPENSUBTITLES_API_KEY.trim() !== '') {
    return process.env.OPENSUBTITLES_API_KEY.trim();
  }
  return (DEFAULT_API_KEYS.OPENSUBTITLES || '').trim();
};

class OpenSubtitlesService {
  constructor(config = {}) {
    // Config only contains optional username/password for user authentication
    this.config = {
      username: config.username || '',
      password: config.password || ''
    };

    this.token = null;
    this.tokenExpiry = null;

    // Determine API key (do not rely on hardcoded keys)
    const apiKey = resolveApiKey(this.config);

    // Create axios instance with default configuration
    this.client = axios.create({
      baseURL: OPENSUBTITLES_API_URL,
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        // Use provided API key if available; otherwise, requests will fail and be logged clearly
        ...(apiKey ? { 'Api-Key': apiKey } : {})
      }
    });

    if (!apiKey) {
      console.warn('[OpenSubtitles] No API key configured. Set OPENSUBTITLES_API_KEY env var or config.opensubtitlesApiKey');
    }

    if (this.config.username && this.config.password) {
      console.log('[OpenSubtitles] Initialized with user account authentication (higher download limits)');
    } else {
      console.log('[OpenSubtitles] Initialized with basic API access (standard download limits)');
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
      console.log('[OpenSubtitles] Authenticating user:', username);

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

      console.log('[OpenSubtitles] User authentication successful');
      return this.token;

    } catch (error) {
      console.error('[OpenSubtitles] User authentication failed:', error.message);
      throw error;
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
      // Try to authenticate with user credentials if provided (for higher download limits)
      if (this.config.username && this.config.password && this.isTokenExpired()) {
        try {
          await this.login();
        } catch (error) {
          console.warn('[OpenSubtitles] User authentication failed, falling back to basic API access:', error.message);
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

      console.log('[OpenSubtitles] Converted languages from ISO-639-2 to ISO-639-1:', languages.join(','), '->', convertedLanguages.join(','));

      // Build query parameters for REST API
      const queryParams = {
        imdb_id: imdbId,
        languages: convertedLanguages.join(',')
      };

      if (type === 'episode' && season && episode) {
        queryParams.season_number = season;
        queryParams.episode_number = episode;
      }

      console.log('[OpenSubtitles] Searching with params:', JSON.stringify(queryParams));
      if (this.token) {
        console.log('[OpenSubtitles] Using user account authentication');
      } else {
        console.log('[OpenSubtitles] Using basic API access');
      }

      const response = await this.client.get('/subtitles', {
        params: queryParams
      });

      console.log('[OpenSubtitles] API Response status:', response.status);
      console.log('[OpenSubtitles] API Response data structure:', JSON.stringify(response.data, null, 2).substring(0, 1000));

      if (!response.data || !response.data.data || response.data.data.length === 0) {
        console.log('[OpenSubtitles] No subtitles found in response');
        return [];
      }

      const subtitles = response.data.data.map(sub => {
        console.log('[OpenSubtitles] Processing subtitle:', JSON.stringify(sub, null, 2).substring(0, 500));

        const originalLang = sub.attributes.language;
        const normalizedLang = this.normalizeLanguageCode(originalLang);
        const fileId = sub.attributes.files?.[0]?.file_id || sub.id;

        console.log(`[OpenSubtitles] Found subtitle: ${sub.attributes.release || sub.attributes.feature_details?.movie_name || 'Unknown'} (${originalLang}) - File ID: ${fileId}`);

        return {
          id: fileId,
          language: originalLang,
          languageCode: normalizedLang,
          name: sub.attributes.release || sub.attributes.feature_details?.movie_name || 'Unknown',
          downloads: parseInt(sub.attributes.download_count) || 0,
          rating: parseFloat(sub.attributes.ratings) || 0,
          uploadDate: sub.attributes.upload_date,
          format: sub.attributes.format || 'srt',
          fileId: fileId,
          downloadLink: sub.attributes.url,
          hearing_impaired: sub.attributes.hearing_impaired || false,
          foreign_parts_only: sub.attributes.foreign_parts_only || false,
          machine_translated: sub.attributes.machine_translated || false,
          uploader: sub.attributes.uploader?.name || 'Unknown',
          provider: 'opensubtitles'
        };
      });

      console.log(`[OpenSubtitles] Found ${subtitles.length} subtitles total`);
      return subtitles;

    } catch (error) {
      console.error('[OpenSubtitles] Search error:', error.message);
      if (error.response) {
        console.error('[OpenSubtitles] Response status:', error.response.status);
        console.error('[OpenSubtitles] Response headers:', JSON.stringify(error.response.headers));
        console.error('[OpenSubtitles] Response data:', JSON.stringify(error.response.data));

                if (error.response.status === 401 || error.response.status === 403) {
          console.error('[OpenSubtitles] Authentication failed!');
          if (this.config.username && this.config.password) {
            console.error('[OpenSubtitles] Check your username and password.');
          } else {
            console.error('[OpenSubtitles] You may have hit rate limits. Consider adding your OpenSubtitles account credentials for higher limits.');
          }
        }
      }
      return [];
    }
  }

  /**
   * Download subtitle content via REST API
   * @param {string} fileId - File ID from search results
   * @returns {Promise<string>} - Subtitle content as text
   */
  async downloadSubtitle(fileId) {
    try {
      console.log('[OpenSubtitles] Downloading subtitle via REST API:', fileId);

      // Try to authenticate with user credentials if provided (for higher download limits)
      if (this.config.username && this.config.password && this.isTokenExpired()) {
        try {
          await this.login();
        } catch (error) {
          console.warn('[OpenSubtitles] User authentication failed, falling back to basic API access:', error.message);
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
      console.log('[OpenSubtitles] Got download link:', downloadLink);

      // Download the subtitle file
      const subtitleResponse = await axios.get(downloadLink, {
        responseType: 'text',
        headers: {
          'User-Agent': USER_AGENT
        }
      });

      const subtitleContent = subtitleResponse.data;
      console.log('[OpenSubtitles] Subtitle downloaded successfully');
      return subtitleContent;

    } catch (error) {
      console.error('[OpenSubtitles] Download error:', error.message);
      if (error.response) {
        console.error('[OpenSubtitles] Response status:', error.response.status);
        console.error('[OpenSubtitles] Response data:', error.response.data);

        if (error.response.status === 401 || error.response.status === 403) {
          console.error('[OpenSubtitles] Authentication failed for download!');
          if (this.config.username && this.config.password) {
            console.error('[OpenSubtitles] Check your username and password.');
          } else {
            console.error('[OpenSubtitles] You may have hit download limits. Consider adding your OpenSubtitles account credentials for higher limits.');
          }
        }
      }
      throw error;
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
      'lao': 'lao',
      'pashto': 'pus',
      'somali': 'som'
    };

    // Check if it's a full language name
    if (languageNameMap[lower]) {
      return languageNameMap[lower];
    }

    // Handle special cases for Portuguese Brazilian
    if (lower.includes('portuguese') && (lower.includes('brazil') || lower.includes('br'))) {
      return 'pob';
    }
    if (lower === 'brazilian' || lower === 'pt-br' || lower === 'ptbr') {
      return 'pob';
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
    console.warn(`[OpenSubtitles] Unknown language format: "${language}", filtering out`);
    return null;
  }
}

module.exports = OpenSubtitlesService;
