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

      // Filter subtitles by requested languages
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
        });

      // Extract real filenames from Content-Disposition headers (parallel HEAD requests)
      // This allows proper filename matching instead of just numeric IDs
      const subtitlesWithNames = await this.extractFilenames(filteredSubtitles);

      return subtitlesWithNames;

    } catch (error) {
      return handleSearchError(error, 'OpenSubtitles V3');
    }
  }

  /**
   * Extract filenames from subtitle URLs using parallel HEAD requests
   * @param {Array} subtitles - Array of subtitle objects with urls
   * @returns {Promise<Array>} - Subtitles with extracted names
   */
  async extractFilenames(subtitles) {
    // Make parallel HEAD requests to extract filenames
    const filenamePromises = subtitles.map(async (sub) => {
      try {
        // Make HEAD request to get Content-Disposition header
        const response = await axios.head(sub.url, {
          headers: {
            'User-Agent': USER_AGENT
          },
          timeout: 3000, // 3 second timeout for HEAD requests
          httpAgent,
          httpsAgent
        });

        // Extract filename from Content-Disposition header
        const contentDisposition = response.headers['content-disposition'];
        if (contentDisposition) {
          const match = contentDisposition.match(/filename="(.+?)"/);
          if (match && match[1]) {
            // Remove .srt extension for cleaner display
            const filename = match[1].replace(/\.srt$/i, '');
            return filename;
          }
        }

        // Fallback: no filename found
        return null;

      } catch (error) {
        // Fallback on error (timeout, network issue, etc.)
        log.debug(() => `[OpenSubtitles V3] Failed to extract filename for ${sub.id}: ${error.message}`);
        return null;
      }
    });

    // Wait for all HEAD requests to complete
    const extractedNames = await Promise.all(filenamePromises);

    // Map subtitles with extracted names
    return subtitles.map((sub, index) => {
      const encodedUrl = Buffer.from(sub.url).toString('base64url');
      const fileId = `v3_${encodedUrl}`;

      // Use extracted name if available, otherwise fallback to generic name
      let finalName;
      if (extractedNames[index]) {
        finalName = extractedNames[index];
      } else {
        const langName = this.getLanguageDisplayName(sub.lang);
        finalName = `OpenSubtitles (${langName}) - #${sub.id}`;
      }

      return {
        id: fileId,
        language: sub.lang,
        languageCode: sub.normalizedLang,
        name: finalName,
        downloads: 0, // V3 API doesn't provide download counts
        rating: 0, // V3 API doesn't provide ratings
        uploadDate: null,
        format: 'srt',
        fileId: fileId,
        downloadLink: sub.url,
        hearing_impaired: sub.hearing_impaired || sub.hi || false,
        foreign_parts_only: false,
        machine_translated: false,
        uploader: 'OpenSubtitles V3',
        provider: 'opensubtitles-v3',
        // Store original URL for direct download
        _v3Url: sub.url
      };
    });
  }

  /**
   * Download subtitle content from V3 API with retry logic
   * @param {string} fileId - File ID from search results (contains encoded URL)
   * @param {number} maxRetries - Maximum number of retries (default: 3)
   * @returns {Promise<string>} - Subtitle content as text
   */
  async downloadSubtitle(fileId, maxRetries = 3) {
    // Extract encoded URL from fileId
    // Format: v3_{base64url_encoded_url}
    if (!fileId.startsWith('v3_')) {
      throw new Error('Invalid V3 file ID format');
    }

    const encodedUrl = fileId.substring(3); // Remove 'v3_' prefix
    const downloadUrl = Buffer.from(encodedUrl, 'base64url').toString('utf-8');

    log.debug(() => '[OpenSubtitles V3] Decoded download URL');

    // Retry logic with exponential backoff
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        log.debug(() => `[OpenSubtitles V3] Downloading subtitle (attempt ${attempt}/${maxRetries}): ${fileId}`);

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
        lastError = error;
        const status = error.response?.status;

        // Don't retry for non-retryable errors (404, auth errors, etc.)
        if (status === 404 || status === 401 || status === 403) {
          log.debug(() => `[OpenSubtitles V3] Non-retryable error (${status}), aborting retries`);
          break;
        }

        // For 469 (database error) and 5xx errors, retry with backoff
        if ((status === 469 || status >= 500) && attempt < maxRetries) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // Exponential backoff, max 5s
          log.warn(() => `[OpenSubtitles V3] Download failed (status ${status}), retrying in ${backoffMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }

        // Last attempt or non-retryable error - log and throw
        if (attempt === maxRetries) {
          log.error(() => `[OpenSubtitles V3] All ${maxRetries} download attempts failed`);
        }
      }
    }

    // All retries exhausted - throw the last error
    handleDownloadError(lastError, 'OpenSubtitles V3');
  }

  /**
   * Get human-readable language name for display
   * @param {string} languageCode - Language code (ISO-639-1, ISO-639-2, or special code)
   * @returns {string} - Display name (e.g., "English", "Portuguese (BR)")
   */
  getLanguageDisplayName(languageCode) {
    if (!languageCode) return 'Unknown';

    const lower = languageCode.toLowerCase().trim();

    // Language display names map
    const displayNames = {
      'en': 'English', 'eng': 'English',
      'pt': 'Portuguese', 'por': 'Portuguese',
      'pob': 'Portuguese (BR)', 'pb': 'Portuguese (BR)',
      'es': 'Spanish', 'spa': 'Spanish', 'spn': 'Spanish (Latin America)',
      'fr': 'French', 'fre': 'French', 'fra': 'French',
      'de': 'German', 'ger': 'German', 'deu': 'German',
      'it': 'Italian', 'ita': 'Italian',
      'ru': 'Russian', 'rus': 'Russian',
      'ja': 'Japanese', 'jpn': 'Japanese',
      'zh': 'Chinese', 'chi': 'Chinese', 'zho': 'Chinese',
      'ko': 'Korean', 'kor': 'Korean',
      'ar': 'Arabic', 'ara': 'Arabic',
      'nl': 'Dutch', 'dut': 'Dutch', 'nld': 'Dutch',
      'pl': 'Polish', 'pol': 'Polish',
      'tr': 'Turkish', 'tur': 'Turkish',
      'sv': 'Swedish', 'swe': 'Swedish',
      'no': 'Norwegian', 'nor': 'Norwegian',
      'da': 'Danish', 'dan': 'Danish',
      'fi': 'Finnish', 'fin': 'Finnish',
      'el': 'Greek', 'gre': 'Greek', 'ell': 'Greek',
      'he': 'Hebrew', 'heb': 'Hebrew',
      'hi': 'Hindi', 'hin': 'Hindi',
      'cs': 'Czech', 'cze': 'Czech', 'ces': 'Czech',
      'hu': 'Hungarian', 'hun': 'Hungarian',
      'ro': 'Romanian', 'rum': 'Romanian', 'ron': 'Romanian',
      'th': 'Thai', 'tha': 'Thai',
      'vi': 'Vietnamese', 'vie': 'Vietnamese',
      'id': 'Indonesian', 'ind': 'Indonesian',
      'uk': 'Ukrainian', 'ukr': 'Ukrainian',
      'bg': 'Bulgarian', 'bul': 'Bulgarian',
      'hr': 'Croatian', 'hrv': 'Croatian',
      'sr': 'Serbian', 'srp': 'Serbian',
      'sk': 'Slovak', 'slo': 'Slovak', 'slk': 'Slovak',
      'sl': 'Slovenian', 'slv': 'Slovenian',
      // Additional display names for OS variants
      'ast': 'Asturian',
      'mni': 'Manipuri',
      'syr': 'Syriac',
      'tet': 'Tetum',
      'sat': 'Santali',
      'ext': 'Extremaduran',
      'tok': 'Toki Pona'
    };

    return displayNames[lower] || languageCode.toUpperCase();
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

    // 'ea' appears in V3 feed for Spanish (Latin America)
    if (lower === 'ea') {
      return 'spn';
    }

    // OS two-letter codes or aliases that need explicit mapping
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

    // Normalize region-style codes like 'pt-PT', 'az-ZB' to base ISO-639-2
    // Keep 'pt-br' handled above to map specifically to 'pob'
    const regionMatch = lower.match(/^([a-z]{2})-[a-z0-9]{2,}$/);
    if (regionMatch) {
      const base = regionMatch[1];
      // Explicitly map Portuguese (Portugal) to 'por'
      if (lower === 'pt-pt') {
        return 'por';
      }
      const iso2Codes = toISO6392(base);
      if (iso2Codes && iso2Codes.length > 0) {
        return iso2Codes[0].code2;
      }
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
