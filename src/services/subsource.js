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
      'Accept-Encoding': 'gzip, deflate, br',
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
      'sec-ch-ua-full-version-list': '"Chromium";v="131.0.6778.86", "Not_A Brand";v="24.0.0.0"'
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
      timeout: 15000,
      maxRedirects: 5,
      decompress: true
    });
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

      log.debug(() => ['[SubSource] No movie found for IMDB ID:', imdb_id, season ? `Season ${season}` : '']);
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
          downloadLink: sub.download_url || sub.downloadUrl || sub.url,
          hearing_impaired: sub.hearingImpaired || sub.hearing_impaired || sub.hi || false,
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

      // Client-side episode filtering for TV shows
      // SubSource API doesn't support episode-level filtering, so we filter by subtitle name
      let filteredSubtitles = subtitles;
      if (type === 'episode' && season && episode) {
        const targetSeason = season;
        const targetEpisode = episode;

        log.debug(() => [`[SubSource] Filtering for S${String(targetSeason).padStart(2, '0')}E${String(targetEpisode).padStart(2, '0')} (${subtitles.length} pre-filter)`]);

        filteredSubtitles = subtitles.filter(sub => {
          const name = (sub.name || '').toLowerCase();

          // Check for season/episode patterns in subtitle name
          // Patterns: S02E01, s02e01, 2x01, S02.E01, etc.
          const seasonEpisodePatterns = [
            new RegExp(`s0*${targetSeason}e0*${targetEpisode}(?![0-9])`, 'i'),        // S02E01, s02e01 (ensure not matching S02E011)
            new RegExp(`${targetSeason}x0*${targetEpisode}(?![0-9])`, 'i'),           // 2x01
            new RegExp(`s0*${targetSeason}\\.e0*${targetEpisode}(?![0-9])`, 'i'),     // S02.E01
            new RegExp(`season\\s*0*${targetSeason}.*episode\\s*0*${targetEpisode}(?![0-9])`, 'i')  // Season 2 Episode 1
          ];

          const hasCorrectEpisode = seasonEpisodePatterns.some(pattern => pattern.test(name));
          return hasCorrectEpisode;
        });

        log.debug(() => [`[SubSource] After episode filtering: ${filteredSubtitles.length} subtitles`]);
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
      const url = `/subtitles/${subsource_id}/download`;
      // Allow CDN caching; avoid forcing no-cache on downloads
      const downloadHeaders = { ...this.defaultHeaders };
      delete downloadHeaders['Cache-Control'];
      delete downloadHeaders['Pragma'];
      const response = await this.client.get(url, {
        headers: downloadHeaders,
        responseType: 'arraybuffer'
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

        const entries = Object.keys(zip.files);
        // Prefer .srt if available
        const srtEntry = entries.find(filename => filename.toLowerCase().endsWith('.srt'));
        if (srtEntry) {
          const subtitleContent = await zip.files[srtEntry].async('string');
          log.debug(() => '[SubSource] Subtitle downloaded and extracted successfully from ZIP (.srt)');
          return subtitleContent;
        }

        // Fallback: support common formats
        const altEntry = entries.find(filename => {
          const f = filename.toLowerCase();
          return f.endsWith('.vtt') || f.endsWith('.ass') || f.endsWith('.ssa');
        });

        if (altEntry) {
          try {
            const raw = await zip.files[altEntry].async('string');

            // Keep original VTT intact; only convert ASS/SSA to SRT
            const lower = altEntry.toLowerCase();
            if (lower.endsWith('.vtt')) {
              log.debug(() => `[SubSource] Keeping original VTT: ${altEntry}`);
              return raw;
            }

            const subsrt = require('subsrt-ts');
            const converted = subsrt.convert(raw, { to: 'srt' });
            log.debug(() => `[SubSource] Converted ${altEntry} to .srt successfully`);
            return converted;
          } catch (convErr) {
            log.error(() => ['[SubSource] Failed to convert to .srt:', convErr.message, 'file:', altEntry]);
          }
        }

        log.error(() => ['[SubSource] Available files in ZIP:', entries.join(', ')]);
        throw new Error('No .srt file found in downloaded ZIP');
      } else {
        // Direct SRT content - decode as UTF-8
        log.debug(() => '[SubSource] Subtitle downloaded successfully');
        const content = responseBuffer.toString('utf-8');

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
