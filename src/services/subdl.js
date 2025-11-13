const axios = require('axios');
const { toISO6391, toISO6392 } = require('../utils/languages');
const { handleSearchError, handleDownloadError } = require('../utils/apiErrorHandler');
const { httpAgent, httpsAgent } = require('../utils/httpAgents');
const log = require('../utils/logger');

const SUBDL_API_URL = 'https://api.subdl.com/api/v1';
const USER_AGENT = 'StremioSubtitleTranslator v1.0';

class SubDLService {
  constructor(apiKey = null) {
    this.apiKey = apiKey;
    
    // Create axios instance with default configuration
    this.client = axios.create({
      baseURL: SUBDL_API_URL,
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      httpAgent,
      httpsAgent
    });

    if (this.apiKey && this.apiKey.trim() !== '') {
      log.debug(() => '[SubDL] Using API key for requests');
    } else {
      log.debug(() => '[SubDL] No API key provided');
    }
  }

  /**
   * Search for subtitles using SubDL API
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
        log.error(() => '[SubDL] API key is required for SubDL API');
        log.error(() => '[SubDL] Please get a free API key from https://subdl.com');
        return [];
      }

      const { imdb_id, type, season, episode, languages } = params;

      // Convert ISO-639-2 codes to SubDL format (uppercase codes)
      // SubDL uses uppercase 2-letter codes with special cases like BR_PT
      const subdlLanguageMap = {
        'eng': 'EN', 'spa': 'ES', 'spn': 'ES', 'fre': 'FR', 'fra': 'FR', 'ger': 'DE', 'deu': 'DE',
        'por': 'PT', 'pob': 'BR_PT', 'pt-br': 'BR_PT', 'ptbr': 'BR_PT',
        'ita': 'IT', 'rus': 'RU', 'jpn': 'JA', 'chi': 'ZH', 'zho': 'ZH',
        'kor': 'KO', 'ara': 'AR', 'dut': 'NL', 'nld': 'NL', 'pol': 'PL',
        'tur': 'TR', 'swe': 'SV', 'nor': 'NO', 'dan': 'DA', 'fin': 'FI',
        'gre': 'EL', 'ell': 'EL', 'heb': 'HE', 'hin': 'HI', 'cze': 'CS',
        'ces': 'CS', 'hun': 'HU', 'rum': 'RO', 'ron': 'RO', 'tha': 'TH',
        'vie': 'VI', 'ind': 'ID', 'ukr': 'UK', 'bul': 'BG', 'hrv': 'HR',
        'srp': 'SR', 'slo': 'SK', 'slk': 'SK', 'slv': 'SL', 'est': 'ET',
        'lav': 'LV', 'lit': 'LT', 'per': 'FA', 'fas': 'FA', 'ben': 'BN',
        'cat': 'CA', 'baq': 'EU', 'eus': 'EU', 'glg': 'GL', 'bos': 'BS',
        'mac': 'MK', 'mkd': 'MK', 'alb': 'SQ', 'sqi': 'SQ', 'bel': 'BE',
        'aze': 'AZ', 'geo': 'KA', 'kat': 'KA', 'mal': 'ML', 'tam': 'TA',
        'tel': 'TE', 'urd': 'UR', 'may': 'MS', 'msa': 'MS', 'tgl': 'TL',
        'ice': 'IS', 'isl': 'IS', 'kur': 'KU'
      };

      const convertedLanguages = [...new Set(languages.map(lang => {
        const lower = lang.toLowerCase().trim();

        // Check SubDL mapping first
        if (subdlLanguageMap[lower]) {
          return subdlLanguageMap[lower];
        }

        // Try ISO-639-1 conversion then uppercase
        const iso1Code = toISO6391(lang);
        if (iso1Code && iso1Code !== 'pb') {
          return iso1Code.toUpperCase();
        }

        // Fallback: uppercase first 2 letters
        return lang.substring(0, 2).toUpperCase();
      }))];

      log.debug(() => `[SubDL] Converted languages: ${languages.join(',')} -> ${convertedLanguages.join(',')}`);

      // Build query parameters for SubDL API
      const queryParams = {
        api_key: this.apiKey,
        imdb_id: imdb_id, // SubDL accepts 'tt' prefix
        languages: convertedLanguages.join(','),
        type: type // 'movie' or 'tv'
      };

      // For TV shows, add season and episode parameters
      if (type === 'episode' && season && episode) {
        queryParams.type = 'tv';
        queryParams.season_number = season;
        queryParams.episode_number = episode;
      }

      log.debug(() => ['[SubDL] Searching with params:', JSON.stringify(queryParams)]);

      const response = await this.client.get('/subtitles', {
        params: queryParams
      });

      if (!response.data || response.data.status !== true || !response.data.subtitles || response.data.subtitles.length === 0) {
        log.debug(() => '[SubDL] No subtitles found in response');
        return [];
      }

      const subtitles = response.data.subtitles.map(sub => {

        const originalLang = sub.lang || 'en';
        const normalizedLang = this.normalizeLanguageCode(originalLang);

        // SubDL provides IDs in the URL field: /subtitle/3028156-3032428.zip
        // Extract sd_id and subtitle_id from the URL
        let sdId = null;
        let subtitleId = null;

        if (sub.url) {
          // Parse URL like "/subtitle/3028156-3032428.zip"
          const urlMatch = sub.url.match(/\/subtitle\/(\d+)-(\d+)\.zip/);
          if (urlMatch) {
            sdId = urlMatch[1];
            subtitleId = urlMatch[2];
          }
        }

        const fileId = `subdl_${sdId}_${subtitleId}`;

        return {
          id: fileId,
          language: originalLang,
          languageCode: normalizedLang,
          name: sub.release_name || sub.name || 'Unknown',
          downloads: parseInt(sub.download_count) || 0,
          rating: parseFloat(sub.rating) || 0,
          uploadDate: sub.upload_date || sub.created_at,
          format: 'srt',
          fileId: fileId,
          downloadLink: sub.url, // SubDL provides direct download link
          hearing_impaired: sub.hi === 1 || false,
          foreign_parts_only: false,
          machine_translated: false,
          uploader: sub.author || 'Unknown',
          provider: 'subdl',
          // Store SubDL-specific IDs for download
          subdl_id: sdId,
          subtitles_id: subtitleId
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
      log.debug(() => `[SubDL] Found ${subtitles.length} subtitles total, limited to ${limitedSubtitles.length} (max ${MAX_RESULTS_PER_LANGUAGE} per language)`);
      return limitedSubtitles;

    } catch (error) {
      return handleSearchError(error, 'SubDL');
    }
  }

  /**
   * Download subtitle content
   * @param {string} fileId - File ID from search results (format: subdl_<sd_id>_<subtitles_id>)
   * @param {string} subdl_id - SubDL subtitle ID
   * @param {string} subtitles_id - SubDL subtitle file ID
   * @returns {Promise<string>} - Subtitle content as text
   */
  async downloadSubtitle(fileId, subdl_id = null, subtitles_id = null) {
    try {
      log.debug(() => ['[SubDL] Downloading subtitle:', fileId]);

      // Parse the fileId to extract subdl_id and subtitles_id if not provided
      if (!subdl_id || !subtitles_id) {
        const parts = fileId.split('_');
        if (parts.length >= 3 && parts[0] === 'subdl') {
          subdl_id = parts[1];
          subtitles_id = parts[2];
        } else {
          throw new Error('Invalid SubDL file ID format');
        }
      }

      // Construct download URL according to SubDL API documentation
      // Format: https://dl.subdl.com/subtitle/<sd_id>-<subtitles_id>.zip
      const downloadUrl = `https://dl.subdl.com/subtitle/${subdl_id}-${subtitles_id}.zip`;

      log.debug(() => ['[SubDL] Download URL:', downloadUrl]);

      // Download the subtitle file (it's a ZIP file)
      const subtitleResponse = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': USER_AGENT
        },
        timeout: 12000, // 12 second timeout
        httpAgent,
        httpsAgent
      });

      log.debug(() => ['[SubDL] Response status:', subtitleResponse.status]);
      log.debug(() => ['[SubDL] Response Content-Type:', subtitleResponse.headers['content-type']]);
      log.debug(() => ['[SubDL] Response size:', subtitleResponse.data.length, 'bytes']);

      // Validate that we received binary data (not HTML error page)
      if (!subtitleResponse.data || subtitleResponse.data.length === 0) {
        throw new Error('Downloaded file is empty');
      }

      // Check if response looks like an error page (HTML) instead of ZIP
      const dataString = subtitleResponse.data.toString('utf8', 0, Math.min(100, subtitleResponse.data.length));
      if (dataString.includes('<!DOCTYPE') || dataString.includes('<html') || dataString.includes('404') || dataString.includes('error')) {
        log.error(() => '[SubDL] Response appears to be an error page, not a ZIP file');
        log.error(() => ['[SubDL] Response preview:', dataString.substring(0, 200)]);
        throw new Error('Server returned an error page instead of a subtitle file. The subtitle may have been removed from SubDL.');
      }

      // Check for ZIP file signature (PK bytes at start)
      if (subtitleResponse.data[0] !== 0x50 || subtitleResponse.data[1] !== 0x4B) {
        log.error(() => '[SubDL] Invalid ZIP file signature detected');
        log.error(() => ['[SubDL] First 20 bytes:', Array.from(subtitleResponse.data.slice(0, 20)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ')]);
        throw new Error('Downloaded file is not a valid ZIP file. Server may have returned an error or the file may be corrupted.');
      }

      // Extract .srt file from ZIP
      const JSZip = require('jszip');
      const zip = await JSZip.loadAsync(subtitleResponse.data);

      // Find the first .srt file in the ZIP
      const srtFile = Object.keys(zip.files).find(filename => filename.toLowerCase().endsWith('.srt'));

      if (!srtFile) {
        log.error(() => ['[SubDL] Available files in ZIP:', Object.keys(zip.files).join(', ')]);
        throw new Error('No .srt file found in downloaded ZIP');
      }

      const subtitleContent = await zip.files[srtFile].async('string');
      log.debug(() => '[SubDL] Subtitle downloaded and extracted successfully');

      return subtitleContent;

    } catch (error) {
      handleDownloadError(error, 'SubDL');
    }
  }

  /**
   * Normalize language code to ISO-639-2 for Stremio
   * @param {string} language - Language code or name from SubDL
   * @returns {string} - ISO-639-2 language code (3-letter)
   */
  normalizeLanguageCode(language) {
    if (!language) return null;

    const lower = language.toLowerCase().trim();

    // Map SubDL language names to ISO-639-2 codes
    const languageNameMap = {
      'english': 'eng',
      'spanish': 'spa',
      'french': 'fre',
      'german': 'ger',
      'italian': 'ita',
      'portuguese': 'por',
      'portuguese (brazil)': 'pob',
      'portuguese-brazilian': 'pob',
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
      'serbian (latin)': 'srp',
      'serbian (cyrillic)': 'srp',
      'serbian latin': 'srp',
      'serbian cyrillic': 'srp',
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
      'galician': 'glg'
    };

    // Check if it's a language name
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
        return iso2Codes[0].code2;
      }
    }

    // Unknown language
    log.warn(() => `[SubDL] Unknown language format: "${language}", filtering out`);
    return null;
  }
}

module.exports = SubDLService;
