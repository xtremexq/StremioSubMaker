/**
 * Podnapisi API Integration
 *
 * This implementation:
 * - Uses the Podnapisi REST API (free, no API key required)
 * - Searches subtitles by IMDB ID, type, season, episode, and languages
 * - Downloads subtitles directly as SRT files
 * - Normalizes language codes from Podnapisi format to ISO-639-2 (3-letter)
 *
 * IMPORTANT NOTES:
 * - Podnapisi search may return subtitle entries that don't have downloadable files (404)
 * - This often happens with unreleased movies or removed subtitles
 * - The download URLs require the /en/ language prefix: /en/subtitles/{id}/download
 * - Stremio may automatically prefetch/validate subtitle URLs when loading streams
 *   (this is normal behavior and not a bug - it helps validate subtitle availability)
 */

const axios = require('axios');
const { toISO6391, toISO6392 } = require('../utils/languages');
const { handleSearchError, handleDownloadError } = require('../utils/apiErrorHandler');
const { httpAgent, httpsAgent } = require('../utils/httpAgents');
const log = require('../utils/logger');

const PODNAPISI_API_URL = 'https://www.podnapisi.net/en/ppodnapisi/search';
const PODNAPISI_DOWNLOAD_URL = 'https://www.podnapisi.net/en/subtitles';  // Changed: Added /en/ prefix
const USER_AGENT = 'StremioSubtitleTranslator v1.0';

class PodnapisService {
  constructor(apiKey = null) {
    this.apiKey = apiKey; // Not used for Podnapisi (free API)

    // Create axios instance with default configuration
    this.client = axios.create({
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      httpAgent,
      httpsAgent
    });

    log.debug(() => '[Podnapisi] Initialized (free API, no authentication required)');
  }

  /**
   * Search for subtitles using Podnapisi API
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

      // Convert imdb_id to numeric format (remove 'tt' prefix)
      const imdbId = imdb_id.replace('tt', '');

      // Convert ISO-639-2 codes to 2-letter language codes for Podnapisi
      const podnapisLanguages = languages
        .map(lang => this.convertLanguageToPodnapisi(lang))
        .filter(lang => lang !== null);

      if (podnapisLanguages.length === 0) {
        log.debug(() => '[Podnapisi] No valid languages to search');
        return [];
      }

      // Build query parameters
      const queryParams = {
        sI: imdbId,  // IMDb ID without 'tt' prefix (correct Podnapisi param)
        sJ: podnapisLanguages.join(','),  // Language codes (comma-separated)
        sXML: 1  // XML format response
      };

      // For TV episodes, add season and episode
      if (type === 'episode' && season && episode) {
        queryParams.sTS = season;  // Season number
        queryParams.sTE = episode;  // Episode number
      }

      log.debug(() => ['[Podnapisi] Searching with params:', JSON.stringify(queryParams)]);

      const response = await this.client.get(PODNAPISI_API_URL, {
        params: queryParams
      });

      if (!response.data || response.status !== 200) {
        log.debug(() => '[Podnapisi] No response from API');
        return [];
      }

      // Parse XML response
      const subtitles = this.parseXmlResponse(response.data, languages);

      log.debug(() => `[Podnapisi] Found ${subtitles.length} subtitles total`);
      return subtitles;

    } catch (error) {
      return handleSearchError(error, 'Podnapisi');
    }
  }

  /**
   * Parse XML response from Podnapisi API
   * @param {string} xmlData - Raw XML response
   * @param {Array<string>} requestedLanguages - Original ISO-639-2 language codes
   * @returns {Array} - Parsed subtitle objects
   */
  parseXmlResponse(xmlData, requestedLanguages) {
    const subtitles = [];

    if (!xmlData || typeof xmlData !== 'string') {
      return subtitles;
    }

    // Simple regex-based XML parsing (looking for subtitle entries)
    // Pattern: <subtitle>...<title>...</title>...<language>...</language>...<id>...</id>...</subtitle>
    const subtitlePattern = /<subtitle[^>]*>[\s\S]*?<\/subtitle>/g;
    const matches = xmlData.match(subtitlePattern) || [];

    log.debug(() => `[Podnapisi] Found ${matches.length} subtitle entries in XML`);

    for (const match of matches) {
      try {
        // Extract fields from XML - Updated to handle new API structure
        const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(match);
        // API returns both languageName (full name) and language (code)
        const languageNameMatch = /<languageName[^>]*>([^<]+)<\/languageName>/i.exec(match);
        const languageCodeMatch = /<language[^>]*>([^<]+)<\/language>/i.exec(match);
        const idMatch = /<id[^>]*>([^<]+)<\/id>/i.exec(match);
        const pidMatch = /<pid[^>]*>([^<]+)<\/pid>/i.exec(match);  // Short ID like "HF9I"
        const urlMatch = /<url[^>]*>([^<]+)<\/url>/i.exec(match);  // Might contain the full URL path
        const releasesMatch = /<releases[^>]*>([^<]*)<\/releases>/i.exec(match);  // Might contain slug
        const ratingMatch = /<rating[^>]*>([^<]+)<\/rating>/i.exec(match);
        const downloadsMatch = /<downloads[^>]*>([^<]+)<\/downloads>/i.exec(match);
        const uploaderNameMatch = /<uploaderName[^>]*>([^<]*)<\/uploaderName>/i.exec(match);
        const releaseMatch = /<release[^>]*>([^<]*)<\/release>/i.exec(match);
        const timeMatch = /<time[^>]*>([^<]*)<\/time>/i.exec(match);

        if (!titleMatch || (!languageNameMatch && !languageCodeMatch) || !idMatch) {
          log.debug(() => '[Podnapisi] Skipping subtitle entry due to missing required fields');
          continue;
        }

        // Use language name if available, otherwise use language code
        const originalLang = languageNameMatch ? languageNameMatch[1].trim() : languageCodeMatch[1].trim();
        const normalizedLang = this.normalizeLanguageCode(originalLang);

        // Only include if language was requested
        if (!requestedLanguages.includes(normalizedLang)) {
          continue;
        }

        // Log extracted fields for debugging URL construction
        const extractedId = idMatch[1].trim();
        const extractedPid = pidMatch ? pidMatch[1].trim() : null;
        const extractedUrl = urlMatch ? urlMatch[1].trim() : null;
        const extractedReleases = releasesMatch ? releasesMatch[1].trim() : null;

        log.debug(() => `[Podnapisi] XML fields - id: ${extractedId}, pid: ${extractedPid}, url: ${extractedUrl}, releases: ${extractedReleases}`);

        // Construct proper download URL - ONLY slug-based format works!
        // Required format: /en/subtitles/{lang}-{movie-slug}/{short-id}/download
        // Example: /en/subtitles/pt-nobody-2021/tuhG/download
        let downloadLink;
        let podnapisi_id_for_download;
        let fileIdToUse;

        if (extractedUrl && extractedUrl.includes('/subtitles/')) {
          // BEST CASE: We have a direct URL path from XML - use it!
          // URL format: http://www.podnapisi.net/en/subtitles/en-28-years-later-2025/-llI
          // Extract the path part: en-28-years-later-2025/-llI
          const urlPath = extractedUrl.replace(/^https?:\/\/[^\/]+\/en\/subtitles\//, '');
          downloadLink = extractedUrl.endsWith('/download') ? extractedUrl : `${extractedUrl}/download`;
          // Make sure it's a full URL
          if (!downloadLink.startsWith('http')) {
            downloadLink = `https://www.podnapisi.net${downloadLink}`;
          }
          podnapisi_id_for_download = urlPath;
          fileIdToUse = `podnapisi_${urlPath.replace(/\//g, '_')}`;  // e.g., podnapisi_en-28-years-later-2025_-llI
          log.debug(() => `[Podnapisi] Using direct URL from XML: ${downloadLink}`);
        } else if (extractedPid) {
          // Build URL from pid (short ID like "tuhG", "-llI")
          // Format: /en/subtitles/{lang}-{slug}/{pid}/download
          const lang2letter = this.convertLanguageToPodnapisi(normalizedLang) || 'en';
          const movieSlug = this.createSlugFromTitle(titleMatch[1].trim());
          const urlPath = `${lang2letter}-${movieSlug}/${extractedPid}`;
          downloadLink = `${PODNAPISI_DOWNLOAD_URL}/${urlPath}/download`;
          podnapisi_id_for_download = urlPath;
          fileIdToUse = `podnapisi_${urlPath.replace(/\//g, '_')}`;  // e.g., podnapisi_pt-nobody-2021_tuhG
          log.debug(() => `[Podnapisi] Built URL from pid: ${downloadLink}`);
        } else {
          // CRITICAL: No way to construct proper URL - SKIP this subtitle
          log.warn(() => `[Podnapisi] Cannot construct download URL - missing pid/url for subtitle ${extractedId}. Skipping.`);
          log.warn(() => `[Podnapisi] Title: ${titleMatch[1].trim()}, Lang: ${originalLang}`);
          continue;  // Skip this subtitle - can't download it without proper URL
        }

        const fileId = fileIdToUse;
        const subtitle = {
          id: fileId,
          language: originalLang,
          languageCode: normalizedLang,
          name: titleMatch[1].trim() || 'Unknown',
          downloads: parseInt(downloadsMatch?.[1] || '0') || 0,
          rating: parseFloat(ratingMatch?.[1] || '0') || 0,
          uploadDate: timeMatch ? new Date(parseInt(timeMatch[1]) * 1000).toISOString() : '',
          format: 'srt',
          fileId: fileId,
          downloadLink: downloadLink,
          hearing_impaired: false,  // Podnapisi API doesn't provide this info
          foreign_parts_only: false,
          machine_translated: false,
          uploader: uploaderNameMatch ? uploaderNameMatch[1].trim() : 'Unknown',
          provider: 'podnapisi',
          podnapisi_id: podnapisi_id_for_download  // Store URL path for download
        };

        subtitles.push(subtitle);
      } catch (error) {
        log.error(() => ['[Podnapisi] Error parsing subtitle entry:', error.message]);
        continue;
      }
    }

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
    log.debug(() => `[Podnapisi] Found ${subtitles.length} subtitles total, limited to ${limitedSubtitles.length} (max ${MAX_RESULTS_PER_LANGUAGE} per language)`);
    return limitedSubtitles;
  }

  /**
   * Create a URL-friendly slug from a title
   * @param {string} title - Movie/show title
   * @returns {string} - URL slug
   */
  createSlugFromTitle(title) {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')  // Remove special characters
      .replace(/\s+/g, '-')           // Replace spaces with hyphens
      .replace(/-+/g, '-')            // Replace multiple hyphens with single
      .replace(/^-|-$/g, '');         // Trim hyphens from start/end
  }

  /**
   * Download subtitle from Podnapisi
   * @param {string} fileId - Subtitle file ID (format: podnapisi_<id>)
   * @param {string} podnapisi_id - Podnapisi subtitle ID or URL path (optional, can be extracted from fileId)
   * @returns {Promise<string>} - Subtitle content
   */
  async downloadSubtitle(fileId, podnapisi_id = null) {
    try {
      log.debug(() => ['[Podnapisi] Downloading subtitle:', fileId]);

      // Parse fileId if podnapisi_id not provided
      if (!podnapisi_id) {
        const parts = fileId.split('_');
        if (parts[0] === 'podnapisi') {
          // fileId format: podnapisi_en-28-years-later-2025_-llI
          // We need to convert back: en-28-years-later-2025_-llI -> en-28-years-later-2025/-llI
          const encodedPath = parts.slice(1).join('_');
          // Find the last underscore which separates slug from short ID
          const lastUnderscoreIndex = encodedPath.lastIndexOf('_');
          if (lastUnderscoreIndex > 0) {
            // e.g., "en-28-years-later-2025_-llI" -> "en-28-years-later-2025/-llI"
            podnapisi_id = encodedPath.substring(0, lastUnderscoreIndex) + '/' + encodedPath.substring(lastUnderscoreIndex + 1);
          } else {
            // Old format or error - just use as-is
            podnapisi_id = encodedPath;
          }
        } else {
          throw new Error('Invalid Podnapisi file ID format');
        }
      }

      // Construct download URL
      // ONLY slug-based format works: /en/subtitles/{lang}-{movie-slug}/{short-id}/download
      // podnapisi_id should be like: "en-28-years-later-2025/-llI"
      let downloadUrl;
      
      if (podnapisi_id.startsWith('/')) {
        // Already a full path, just add /download if not present
        downloadUrl = podnapisi_id.endsWith('/download') 
          ? `https://www.podnapisi.net${podnapisi_id}`
          : `https://www.podnapisi.net${podnapisi_id}/download`;
      } else if (podnapisi_id.includes('/')) {
        // Slug format: "en-nobody-2021/s81G"
        downloadUrl = `${PODNAPISI_DOWNLOAD_URL}/${podnapisi_id}/download`;
      } else {
        // Invalid format - should never happen now as we skip these in search
        log.error(() => `[Podnapisi] Invalid subtitle ID format: ${podnapisi_id} - cannot construct proper URL`);
        throw new Error(`Invalid Podnapisi subtitle ID format. The subtitle cannot be downloaded.`);
      }

      log.debug(() => ['[Podnapisi] Downloading from URL:', downloadUrl]);

      const response = await axios.get(downloadUrl, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: 12000,
        responseType: 'text',  // Get as text directly
        validateStatus: function (status) {
          return status >= 200 && status < 500; // Accept 4xx to handle gracefully
        },
        httpAgent,
        httpsAgent
      });

      // Handle 404 specifically - subtitle exists in search but file not available
      if (response.status === 404) {
        log.error(() => `[Podnapisi] Subtitle ${podnapisi_id} returned 404 - file not available on server`);
        throw new Error(`Subtitle not available: The subtitle exists in search results but the file has been removed or is not accessible on Podnapisi servers. (ID: ${podnapisi_id})`);
      }

      // Handle other error status codes
      if (response.status >= 400) {
        log.error(() => `[Podnapisi] Download failed with status ${response.status}`);
        throw new Error(`HTTP ${response.status}: Failed to download subtitle from Podnapisi`);
      }

      if (!response.data || typeof response.data !== 'string') {
        throw new Error('Invalid response from Podnapisi API');
      }

      const content = response.data.toString().trim();

      if (content.length === 0) {
        throw new Error('Downloaded subtitle is empty');
      }

      // Check if we got an HTML error page instead of subtitle content
      if (content.toLowerCase().includes('<!doctype html') || content.toLowerCase().includes('<html')) {
        log.error(() => '[Podnapisi] Received HTML page instead of subtitle file');
        throw new Error('Subtitle not available: Podnapisi returned an error page instead of subtitle content');
      }

      log.debug(() => '[Podnapisi] Subtitle downloaded successfully (' + content.length + ' bytes)');
      return content;

    } catch (error) {
      handleDownloadError(error, 'Podnapisi');
    }
  }

  /**
   * Convert ISO-639-2 (3-letter) language code to Podnapisi format (2-letter or special format)
   * Podnapisi uses 2-letter language codes
   * @param {string} iso639_2 - ISO-639-2 code (3-letter)
   * @returns {string|null} - Podnapisi language code or null if not supported
   */
  convertLanguageToPodnapisi(iso639_2) {
    if (!iso639_2) return null;

    const lower = iso639_2.toLowerCase().trim();

    // Map ISO-639-2 (3-letter) to 2-letter codes used by Podnapisi
    const iso2Map = {
      'eng': 'en',  'spa': 'es',  'fre': 'fr',  'fra': 'fr',
      'ger': 'de',  'deu': 'de',  'por': 'pt',  'pob': 'pt',
      'ita': 'it',  'rus': 'ru',  'jpn': 'ja',  'chi': 'zh',
      'zho': 'zh',  'kor': 'ko',  'ara': 'ar',  'dut': 'nl',
      'nld': 'nl',  'pol': 'pl',  'tur': 'tr',  'swe': 'sv',
      'nor': 'no',  'dan': 'da',  'fin': 'fi',  'gre': 'el',
      'ell': 'el',  'heb': 'he',  'hin': 'hi',  'cze': 'cs',
      'ces': 'cs',  'hun': 'hu',  'rum': 'ro',  'ron': 'ro',
      'tha': 'th',  'vie': 'vi',  'ind': 'id',  'ukr': 'uk',
      'bul': 'bg',  'hrv': 'hr',  'srp': 'sr',  'slo': 'sk',
      'slk': 'sk',  'slv': 'sl',  'est': 'et',  'lav': 'lv',
      'lit': 'lt',  'per': 'fa',  'fas': 'fa',  'ben': 'bn',
      'cat': 'ca',  'baq': 'eu',  'eus': 'eu',  'glg': 'gl',
      'bos': 'bs',  'mac': 'mk',  'mkd': 'mk',  'alb': 'sq',
      'sqi': 'sq',  'bel': 'be',  'aze': 'az',  'geo': 'ka',
      'kat': 'ka',  'mal': 'ml',  'tam': 'ta',  'tel': 'te',
      'urd': 'ur',  'may': 'ms',  'msa': 'ms',  'tgl': 'tl',
      'ice': 'is',  'isl': 'is',  'kur': 'ku'
    };

    return iso2Map[lower] || null;
  }

  /**
   * Normalize Podnapisi language format to ISO-639-2 (3-letter code)
   * @param {string} language - Language name/code from Podnapisi
   * @returns {string} - ISO-639-2 code (3-letter)
   */
  normalizeLanguageCode(language) {
    if (!language) return null;

    const lower = language.toLowerCase().trim();

    // Map language names to ISO-639-2 codes
    const languageNameMap = {
      'english': 'eng',
      'spanish': 'spa',
      'french': 'fre',
      'german': 'ger',
      'portuguese': 'por',
      'brazilian': 'pob',
      'brazilian portuguese': 'pob',
      'portuguese (brazil)': 'pob',
      'portuguese-brazilian': 'pob',
      'italiano': 'ita',
      'italian': 'ita',
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
      'malay': 'may',
      'tagalog': 'tgl',
      'icelandic': 'ice',
      'kurdish': 'kur',
      // Add 2-letter ISO codes (as they appear in API response)
      'en': 'eng', 'es': 'spa', 'fr': 'fre', 'de': 'ger', 'pt': 'por',
      'it': 'ita', 'ru': 'rus', 'ja': 'jpn', 'zh': 'chi', 'ko': 'kor',
      'ar': 'ara', 'nl': 'dut', 'pl': 'pol', 'tr': 'tur', 'sv': 'swe',
      'no': 'nor', 'da': 'dan', 'fi': 'fin', 'el': 'gre', 'he': 'heb',
      'hi': 'hin', 'cs': 'cze', 'hu': 'hun', 'ro': 'rum', 'th': 'tha',
      'vi': 'vie', 'id': 'ind', 'uk': 'ukr', 'bg': 'bul', 'hr': 'hrv',
      'sr': 'srp', 'sk': 'slo', 'sl': 'slv', 'et': 'est', 'lv': 'lav',
      'lt': 'lit', 'fa': 'fas', 'bn': 'ben', 'ca': 'cat', 'eu': 'baq',
      'gl': 'glg', 'bs': 'bos', 'mk': 'mkd', 'sq': 'sqi', 'be': 'bel',
      'az': 'aze', 'ka': 'kat', 'ml': 'mal', 'ta': 'tam', 'te': 'tel',
      'ur': 'urd', 'ms': 'msa', 'tl': 'tgl', 'is': 'isl', 'ku': 'kur'
    };

    if (languageNameMap[lower]) {
      return languageNameMap[lower];
    }

    // Handle 2-letter codes (convert to 3-letter)
    if (lower.length === 2) {
      const iso2Codes = toISO6392(lower);
      if (iso2Codes && iso2Codes.length > 0) {
        return iso2Codes[0].code2;
      }
    }

    // Handle 3-letter codes
    if (/^[a-z]{3}$/.test(lower)) {
      return lower;
    }

    // Try ISO-639-2 conversion as last resort
    const iso2Result = toISO6392(lower);
    if (iso2Result && iso2Result.length > 0) {
      return iso2Result[0].code2;
    }

    return null;  // Unknown language; let caller filter it out
  }
}

module.exports = PodnapisService;
