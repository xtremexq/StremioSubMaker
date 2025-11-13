const axios = require('axios');
const { toISO6391, toISO6392 } = require('../utils/languages');
const { handleSearchError, handleDownloadError } = require('../utils/apiErrorHandler');
const { httpAgent, httpsAgent } = require('../utils/httpAgents');
const { version } = require('../utils/version');
const log = require('../utils/logger');

const OPENSUBTITLES_V3_BASE_URL = 'https://opensubtitles-v3.strem.io/subtitles/';
const USER_AGENT = `SubMaker v${version}`;

/**
 * OpenSubtitles V3 Service - Uses official Stremio OpenSubtitles V3 addon
 * No authentication required, fetches from public Stremio service
 */
class OpenSubtitlesV3Service {
  static initLogged = false;

  constructor() {
    // Create axios instance with default configuration
    this.client = axios.create({
      baseURL: OPENSUBTITLES_V3_BASE_URL,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json'
      },
      timeout: 10000, // 10 second timeout
      httpAgent,
      httpsAgent
    });

    // Only log initialization once at startup
    if (!OpenSubtitlesV3Service.initLogged) {
      log.debug(() => '[OpenSubtitles V3] Initialized with Stremio V3 addon (no authentication required)');
      OpenSubtitlesV3Service.initLogged = true;
    }
  }

  /**
   * Search for subtitles using OpenSubtitles V3 API
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
      const { imdb_id, type, season, episode, languages } = params;

      // OpenSubtitles V3 API requires the full IMDB ID with 'tt' prefix
      // Ensure it has the prefix
      const fullImdbId = imdb_id.startsWith('tt') ? imdb_id : `tt${imdb_id}`;

      // Build URL based on type
      // Note: OpenSubtitles V3 API uses 'series' instead of 'episode' for TV shows
      let url;
      if (type === 'episode' && season && episode) {
        url = `series/${fullImdbId}:${season}:${episode}.json`;
      } else if (type === 'movie') {
        url = `movie/${fullImdbId}.json`;
      } else {
        // Fallback for other types (shouldn't happen in practice)
        url = `${type}/${fullImdbId}.json`;
      }

      log.debug(() => ['[OpenSubtitles V3] Searching:', url]);

      const response = await this.client.get(url);

      if (!response.data || !response.data.subtitles || response.data.subtitles.length === 0) {
        log.debug(() => '[OpenSubtitles V3] No subtitles found');
        return [];
      }

      const allSubtitles = response.data.subtitles;

      // Filter by requested languages
      // V3 API returns lang in various formats, we need to normalize and match
      const normalizedRequestedLangs = new Set(
        languages.map(lang => this.normalizeLanguageCode(lang)).filter(Boolean)
      );

      log.debug(() => ['[OpenSubtitles V3] Requested languages (normalized):', Array.from(normalizedRequestedLangs).join(', ')]);

      // Filter and map subtitles
      const filteredSubtitles = allSubtitles
        .map(sub => {
          const normalizedLang = this.normalizeLanguageCode(sub.lang);
          return {
            ...sub,
            normalizedLang
          };
        })
        .filter(sub => {
          // Keep subtitles that match requested languages
          return sub.normalizedLang && normalizedRequestedLangs.has(sub.normalizedLang);
        })
        .map((sub, index) => {
          // Encode the URL in the fileId for stateless downloads
          // Use base64 encoding (URL-safe)
          const encodedUrl = Buffer.from(sub.url).toString('base64url');
          const fileId = `v3_${encodedUrl}`;

          return {
            id: fileId,
            language: sub.lang,
            languageCode: sub.normalizedLang,
            name: `OpenSubtitles V3 - ${sub.lang}`,
            downloads: 0, // V3 API doesn't provide download counts
            rating: 0, // V3 API doesn't provide ratings
            uploadDate: null,
            format: 'srt',
            fileId: fileId,
            downloadLink: sub.url,
            hearing_impaired: false,
            foreign_parts_only: false,
            machine_translated: false,
            uploader: 'OpenSubtitles V3',
            provider: 'opensubtitles-v3',
            // Store original URL for direct download
            _v3Url: sub.url
          };
        });

      log.debug(() => `[OpenSubtitles V3] Found ${filteredSubtitles.length} matching subtitles`);
      return filteredSubtitles;

    } catch (error) {
      return handleSearchError(error, 'OpenSubtitles V3');
    }
  }

  /**
   * Download subtitle content from V3 API
   * @param {string} fileId - File ID from search results (contains encoded URL)
   * @returns {Promise<string>} - Subtitle content as text
   */
  async downloadSubtitle(fileId) {
    try {
      log.debug(() => ['[OpenSubtitles V3] Downloading subtitle:', fileId]);

      // Extract encoded URL from fileId
      // Format: v3_{base64url_encoded_url}
      if (!fileId.startsWith('v3_')) {
        throw new Error('Invalid V3 file ID format');
      }

      const encodedUrl = fileId.substring(3); // Remove 'v3_' prefix
      const downloadUrl = Buffer.from(encodedUrl, 'base64url').toString('utf-8');

      log.debug(() => '[OpenSubtitles V3] Decoded download URL');

      // Download the subtitle file directly
      const response = await axios.get(downloadUrl, {
        responseType: 'text',
        headers: {
          'User-Agent': USER_AGENT
        },
        timeout: 12000, // 12 second timeout for download
        httpAgent,
        httpsAgent
      });

      const subtitleContent = response.data;
      log.debug(() => '[OpenSubtitles V3] Subtitle downloaded successfully');
      return subtitleContent;

    } catch (error) {
      handleDownloadError(error, 'OpenSubtitles V3');
    }
  }

  /**
   * Normalize language code to ISO-639-2 for Stremio
   * V3 API can return various formats, we normalize to 3-letter codes
   * @param {string} language - Language code from V3 API
   * @returns {string} - ISO-639-2 language code (3-letter)
   */
  normalizeLanguageCode(language) {
    if (!language) return null;

    const lower = language.toLowerCase().trim();

    // Special cases first
    if (lower === 'pob' || lower === 'ptbr' || lower === 'pt-br') {
      return 'pob';
    }

    // Handle Chinese variants
    if (lower === 'zh-cn' || lower === 'zhcn') {
      return 'zhs';
    }
    if (lower === 'zh-tw' || lower === 'zhtw') {
      return 'zht';
    }
    if (lower === 'ze') {
      return 'ze';
    }

    // Handle Montenegrin
    if (lower === 'me') {
      return 'mne';
    }

    // If already 3 letters, assume it's ISO-639-2
    if (lower.length === 3 && /^[a-z]{3}$/.test(lower)) {
      return lower;
    }

    // If 2 letters, convert from ISO-639-1 to ISO-639-2
    if (lower.length === 2 && /^[a-z]{2}$/.test(lower)) {
      const iso2Codes = toISO6392(lower);
      if (iso2Codes && iso2Codes.length > 0) {
        return iso2Codes[0].code2;
      }
    }

    // Unknown format
    log.warn(() => `[OpenSubtitles V3] Unknown language format: "${language}"`);
    return null;
  }
}

module.exports = OpenSubtitlesV3Service;
