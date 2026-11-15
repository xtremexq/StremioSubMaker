const axios = require('axios');
const { toISO6391, toISO6392 } = require('../utils/languages');
const { handleSearchError, handleDownloadError } = require('../utils/apiErrorHandler');
const { httpAgent, httpsAgent, dnsLookup } = require('../utils/httpAgents');
const { detectAndConvertEncoding } = require('../utils/encodingDetector');
const { version } = require('../utils/version');
const { appendHiddenInformationalNote } = require('../utils/subtitle');
const { hasExplicitSeasonEpisodeMismatch } = require('../utils/animeSearchResolver');
const log = require('../utils/logger');
const { isTrueishFlag, inferHearingImpairedFromName } = require('../utils/subtitleFlags');
const { detectArchiveType, extractSubtitleFromArchive, isArchive, createZipTooLargeSubtitle, convertSubtitleToVtt } = require('../utils/archiveExtractor');
const { analyzeResponseContent, createInvalidResponseSubtitle } = require('../utils/responseAnalyzer');
const { encodeProviderUrl, decodeProviderUrl } = require('../utils/providerUrlToken');
const {
  MAX_REMOTE_SUBTITLE_BYTES,
  createPublicRemoteRequestConfig,
  isRemoteResponseTooLargeError,
  isSsrfBlockedRequestError
} = require('../utils/publicRemoteRequest');

const OPENSUBTITLES_V3_BASE_URL = 'https://opensubtitles-v3.strem.io/subtitles/';
const USER_AGENT = `SubMaker v${version}`;
const MAX_ZIP_BYTES = MAX_REMOTE_SUBTITLE_BYTES; // shared wire/archive cap (~25MB)

// Performance: Skip slow HEAD requests for filename extraction by default
// When false (default): Uses fast URL-based filename extraction only (~instant)
// When true: Makes HEAD requests to get accurate Content-Disposition filenames (~3-6s for 30 subs)
// Set V3_EXTRACT_FILENAMES=true to enable accurate filename extraction (slower but better matching)
const V3_EXTRACT_FILENAMES = process.env.V3_EXTRACT_FILENAMES === 'true';

/**
 * OpenSubtitles V3 Service - Uses official Stremio OpenSubtitles V3 addon
 * No authentication required, fetches from public Stremio service
 */
class OpenSubtitlesV3Service {
  static initLogged = false;

  // Static/singleton axios client - shared across all instances for connection reuse
  static client = axios.create({
    baseURL: OPENSUBTITLES_V3_BASE_URL,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate, br'
    },
    timeout: 12000, // 12 second timeout (must fit within global provider timeout)
    httpAgent,
    httpsAgent,
    lookup: dnsLookup,
    maxRedirects: 5,
    decompress: true
  });

  constructor() {
    // Use static client for all instances (connection pooling optimization)
    this.client = OpenSubtitlesV3Service.client;

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
      const { imdb_id, type, season, episode, languages, providerTimeout } = params;

      // OpenSubtitles V3 requires IMDB ID - skip if not available (e.g., anime with Kitsu IDs)
      if (!imdb_id || imdb_id === 'undefined') {
        log.debug(() => '[OpenSubtitles V3] No IMDB ID available, skipping search');
        return [];
      }

      // OpenSubtitles V3 API requires the full IMDB ID with 'tt' prefix
      // Ensure it has the prefix
      const fullImdbId = imdb_id.startsWith('tt') ? imdb_id : `tt${imdb_id}`;

      // Build URL based on type
      // Note: OpenSubtitles V3 API uses 'series' instead of 'episode' for TV shows
      let url;
      if ((type === 'episode' || type === 'anime-episode') && episode) {
        // Default to season 1 if not specified (common for anime)
        const effectiveSeason = season || 1;
        url = `series/${fullImdbId}:${effectiveSeason}:${episode}.json`;
      } else if (type === 'movie' || type === 'anime') {
        url = `movie/${fullImdbId}.json`;
      } else {
        // Fallback for other types (shouldn't happen in practice)
        url = `${type}/${fullImdbId}.json`;
      }

      log.debug(() => ['[OpenSubtitles V3] Searching:', url]);

      // Use providerTimeout from config if provided, otherwise use client default
      const requestConfig = providerTimeout ? { timeout: providerTimeout } : {};
      const response = await this.client.get(url, requestConfig);

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
      // When no languages are configured (just fetch mode), accept all subtitles
      const filteredSubtitles = allSubtitles
        .map(sub => {
          const normalizedLang = this.normalizeLanguageCode(sub.lang);
          return {
            ...sub,
            normalizedLang
          };
        })
        .filter(sub => {
          // Keep subtitles that match requested languages, or all if no languages specified
          return normalizedRequestedLangs.size === 0 || (sub.normalizedLang && normalizedRequestedLangs.has(sub.normalizedLang));
        });

      // Extract real filenames from Content-Disposition headers (parallel HEAD requests)
      // This allows proper filename matching instead of just numeric IDs
      const subtitlesWithNames = await this.extractFilenames(filteredSubtitles);

      // Filter by episode number for TV shows and anime
      // OpenSubtitles V3 API sometimes returns subtitles for all episodes in the season
      let episodeFilteredSubtitles = subtitlesWithNames;
      if ((type === 'episode' || type === 'anime-episode') && episode) {
        // Default to season 1 if not specified (common for anime)
        const effectiveSeason = season || 1;
        const beforeCount = episodeFilteredSubtitles.length;

        episodeFilteredSubtitles = episodeFilteredSubtitles.filter(sub => {
          // The V3 response carries the real release filename and episode
          // coordinates, but the old code only checked the generated display
          // name. With the fast URL-only path that name is often just a file
          // ID, so S16E02 results could slip through an S15E02 request.
          const sourceNames = [
            sub.subtitleFileName,
            sub.movieReleaseName,
            sub.originalFilename,
            sub.filename,
            sub.releaseName,
            sub.name
          ].filter(value => typeof value === 'string' && value.trim());
          const nameLower = sourceNames.join(' ').toLowerCase();

          const responseSeason = Number(sub.season);
          const responseEpisode = Number(sub.episode);
          if (Number.isFinite(responseSeason) && responseSeason > 0 && responseSeason !== effectiveSeason) {
            return false;
          }
          if (Number.isFinite(responseEpisode) && responseEpisode > 0 && responseEpisode !== Number(episode)) {
            return false;
          }

          if (hasExplicitSeasonEpisodeMismatch(nameLower, effectiveSeason, episode)) {
            return false;
          }

          // Season pack patterns (keep as fallback, mark for identification)
          const seasonPackPatterns = [
            new RegExp(`(?:complete|full|entire)?\\s*(?:season|s)\\s*0*${effectiveSeason}(?:\\s+(?:complete|full|pack))?(?!.*e0*\\d)`, 'i'),
            new RegExp(`(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\\s+season(?!.*episode)`, 'i'),
            new RegExp(`s0*${effectiveSeason}\\s*(?:complete|full|pack)`, 'i')
          ];

          // Anime-specific season pack patterns
          const animeSeasonPackPatterns = [
            /(?:complete|batch|full(?:\s+series)?|\d{1,2}\s*[-~]\s*\d{1,2})/i,
            /\[(?:batch|complete|full)\]/i,
            /(?:episode\s*)?(?:01|001)\s*[-~]\s*(?:\d{2}|\d{3})/i
          ];

          let isSeasonPack = false;
          if (type === 'anime-episode') {
            isSeasonPack = animeSeasonPackPatterns.some(p => p.test(nameLower)) &&
              !new RegExp(`(?:^|[^0-9])0*${episode}(?:v\\d+)?(?:[^0-9]|$)`, 'i').test(nameLower);
          } else {
            isSeasonPack = seasonPackPatterns.some(p => p.test(nameLower)) &&
              !/s0*\d+e0*\d+|\d+x\d+|episode\s*\d+|ep\s*\d+/i.test(nameLower);
          }

          if (isSeasonPack) {
            sub.is_season_pack = true;
            sub.season_pack_season = effectiveSeason;
            sub.season_pack_episode = episode;
            // Encode season pack info in fileId for download extraction
            const originalFileId = sub.fileId || sub.id;
            sub.fileId = `${originalFileId}_seasonpack_s${effectiveSeason}e${episode}`;
            sub.id = sub.fileId;
            log.debug(() => `[OpenSubtitles V3] Detected season pack: ${sub.name}`);
            return true; // Keep season packs
          }

          // Patterns to match the correct episode (S03E02, 3x02, etc.)
          const seasonEpisodePatterns = [
            new RegExp(`s0*${effectiveSeason}e0*${episode}\\b`, 'i'),           // S03E02, S3E2
            new RegExp(`${effectiveSeason}x0*${episode}\\b`, 'i'),              // 3x02
            new RegExp(`s0*${effectiveSeason}[\\s._-]*x[\\s._-]*e?0*${episode}\\b`, 'i'), // S03xE02, S03x2
            new RegExp(`0*${effectiveSeason}[\\s._-]*x[\\s._-]*e?0*${episode}\\b`, 'i'),  // 03xE02, 3xE02
            new RegExp(`s0*${effectiveSeason}\\.e0*${episode}\\b`, 'i'),        // S03.E02
            new RegExp(`season\\s*0*${effectiveSeason}.*episode\\s*0*${episode}\\b`, 'i')  // Season 3 Episode 2
          ];

          // Anime-friendly episode patterns (commonly no season, handle cases like "- 01[1080p]")
          const animeEpisodePatterns = [
            new RegExp(`(?<=\\b|\\s|\\[|\\(|-|_)e?p?\\s*0*${episode}(?:v\\d+)?(?=\\b|\\s|\\[\\]|\\(\\)|\\.|-|_|$)`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${episode}(?:v\\d+)?(?=$|[\\s\\[\\]\\(\\)\\-_.])`, 'i'),
            // 01en / 01eng (language suffix immediately after episode number before extension)
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${episode}(?:v\\d+)?[a-z]{2,3}(?=\\.|[\\s\\[\\]\\(\\)\\-_.]|$)`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])episode\\s*0*${episode}(?=$|[\\s\\[\\]\\(\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])ep\\s*0*${episode}(?=$|[\\s\\[\\]\\(\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])cap(?:itulo|\\.)?\\s*0*${episode}(?=$|[\\s\\[\\]\\(\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])epis[oó]dio\\s*0*${episode}(?=$|[\\s\\[\\]\\(\\)\\-_.])`, 'i'),
            new RegExp(`第\\s*0*${episode}\\s*(?:話|集)`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${episode}\\s*(?:話|集|화)(?=$|[\\s\\[\\]\\(\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${episode}\\s*[-~](?=\\s*\\d)`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])\\d+\\s*[-~]\\s*0*${episode}(?=$|[\\s\\[\\]\\(\\)\\-_.])`, 'i'),
          ];

          // If ANY pattern matches the correct episode, keep this subtitle
          if (seasonEpisodePatterns.some(pattern => pattern.test(nameLower)) ||
            (type === 'anime-episode' && animeEpisodePatterns.some(p => p.test(nameLower)))) {
            return true;
          }

          // No episode info found in name - keep it (might be generic subtitle)
          // The ranking algorithm will handle these with lower scores
          return true;
        });

        const filteredCount = beforeCount - episodeFilteredSubtitles.length;
        const seasonPackCount = episodeFilteredSubtitles.filter(s => s.is_season_pack).length;
        if (filteredCount > 0 || seasonPackCount > 0) {
          log.debug(() => `[OpenSubtitles V3] Episode filtering kept ${episodeFilteredSubtitles.length}/${beforeCount} (season packs: ${seasonPackCount})`);
        }
      }

      return episodeFilteredSubtitles;

    } catch (error) {
      return handleSearchError(error, 'OpenSubtitles V3');
    }
  }

  /**
   * Extract filenames from subtitle URLs
   * By default (V3_EXTRACT_FILENAMES=false): Uses fast URL-based extraction only
   * When V3_EXTRACT_FILENAMES=true: Makes HEAD requests for accurate Content-Disposition filenames
   * @param {Array} subtitles - Array of subtitle objects with urls
   * @returns {Promise<Array>} - Subtitles with extracted names
   */
  async extractFilenames(subtitles) {
    const extractedNames = new Array(subtitles.length).fill(null);

    // Fast path: Skip HEAD requests entirely (default for performance)
    // This saves 3-6+ seconds on shared hosting with many subtitles
    if (!V3_EXTRACT_FILENAMES) {
      log.debug(() => `[OpenSubtitles V3] Using fast URL-based filename extraction (${subtitles.length} subs)`);
      // extractedNames stays null, fallback logic below will use URL parsing
    } else {
      // Slow path: Make HEAD requests for accurate Content-Disposition filenames
      log.debug(() => `[OpenSubtitles V3] Using HEAD requests for filename extraction (${subtitles.length} subs)`);
      const BATCH_SIZE = 15; // Increased batch size for slightly better parallelism
      const HEAD_TIMEOUT = 2000; // Reduced timeout (was 3000)

      for (let i = 0; i < subtitles.length; i += BATCH_SIZE) {
        const batch = subtitles.slice(i, i + BATCH_SIZE);
        const batchPromises = batch.map(async (sub, batchIndex) => {
          try {
            const response = await this.client.head(sub.url, createPublicRemoteRequestConfig(sub.url, {
              headers: { 'User-Agent': USER_AGENT },
              timeout: HEAD_TIMEOUT
            }, { context: 'OpenSubtitles V3 filename URL', maxBytes: 64 * 1024 }));

            const contentDisposition = response.headers['content-disposition'];
            if (contentDisposition) {
              const match = contentDisposition.match(/filename="(.+?)"/);
              if (match && match[1]) {
                return match[1];
              }
            }
            return null;
          } catch (error) {
            // If rate-limited, retry once after 1.5 seconds
            const status = error?.response?.status;
            if (status === 429) {
              log.debug(() => `[OpenSubtitles V3] 429 while extracting filename for ${sub.id} - retrying once`);
              await new Promise(r => setTimeout(r, 1500));
              try {
                const response = await this.client.head(sub.url, createPublicRemoteRequestConfig(sub.url, {
                  headers: { 'User-Agent': USER_AGENT },
                  timeout: HEAD_TIMEOUT
                }, { context: 'OpenSubtitles V3 filename URL', maxBytes: 64 * 1024 }));
                const contentDisposition = response.headers['content-disposition'];
                if (contentDisposition) {
                  const match = contentDisposition.match(/filename=\"(.+?)\"/);
                  if (match && match[1]) {
                    return match[1];
                  }
                }
                return null;
              } catch (retryErr) {
                log.debug(() => `[OpenSubtitles V3] Failed to extract filename for ${sub.id} after retry: ${retryErr.message}`);
                return null;
              }
            }
            log.debug(() => `[OpenSubtitles V3] Failed to extract filename for ${sub.id}: ${error.message}`);
            return null;
          }
        });

        const batchResults = await Promise.all(batchPromises);
        batchResults.forEach((result, batchIndex) => {
          extractedNames[i + batchIndex] = result;
        });
      }
    }

    // Map subtitles with extracted names
    return subtitles.map((sub, index) => {
      let fileId;
      try {
        // Validate URL structure/literals before exposing the result. DNS and
        // the actual socket destination are checked again during download.
        createPublicRemoteRequestConfig(sub.url, {}, {
          context: 'OpenSubtitles V3 download URL',
          maxBytes: MAX_ZIP_BYTES
        });
        fileId = encodeProviderUrl('v3_', sub.url);
      } catch (error) {
        log.warn(() => `[OpenSubtitles V3] Skipping unsafe download URL: ${error.message}`);
        return null;
      }

      // Determine format from extracted filename or URL (best-effort) and set display name
      const extracted = extractedNames[index];
      let detectedFormat = null;
      let finalName;
      if (extracted) {
        const lower = String(extracted).toLowerCase();
        const m = lower.match(/\.([a-z0-9]{2,4})$/);
        if (m) {
          const ext = m[1];
          if (['srt', 'vtt', 'ass', 'ssa', 'sub'].includes(ext)) detectedFormat = ext;
        }
        // Display name without extension for cleaner UI
        finalName = extracted.replace(/\.[^.]+$/, '');
      } else {
        // Try to detect from URL
        try {
          const urlLower = String(sub.url || '').toLowerCase();
          const um = urlLower.match(/(?:^|\/)([^\/?#]+)\.(srt|vtt|ass|ssa|sub)(?:$|[?#])/);
          if (um) {
            detectedFormat = um[2];
            finalName = um[1];
          }
        } catch (_) { }

        // Prefer the release metadata returned by the API over an opaque or
        // URL-derived CDN name when HEAD filename extraction is disabled.
        if (!extracted && (sub.subtitleFileName || sub.movieReleaseName)) {
          finalName = sub.subtitleFileName || sub.movieReleaseName;
        } else if (!finalName || /^\d+$/.test(finalName)) {
          finalName = sub.subtitleFileName || sub.movieReleaseName || finalName;
        }

        if (!finalName) {
          const langName = this.getLanguageDisplayName(sub.lang);
          finalName = `OpenSubtitles (${langName}) - #${sub.id}`;
        }
      }

      return {
        id: fileId,
        language: sub.lang,
        languageCode: sub.normalizedLang,
        name: finalName,
        // Preserve provider release metadata for episode and release-aware
        // ranking. The previous mapping discarded these fields, leaving only
        // an opaque URL/file ID when HEAD extraction was disabled.
        originalFilename: sub.subtitleFileName || null,
        filename: sub.subtitleFileName || null,
        releaseName: sub.movieReleaseName || null,
        season: Number.isFinite(Number(sub.season)) ? Number(sub.season) : null,
        episode: Number.isFinite(Number(sub.episode)) ? Number(sub.episode) : null,
        downloads: 0, // V3 API doesn't provide download counts
        rating: 0, // V3 API doesn't provide ratings
        uploadDate: null,
        format: detectedFormat || 'srt',
        fileId: fileId,
        downloadLink: sub.url,
        hearing_impaired: isTrueishFlag(sub.hearing_impaired) || isTrueishFlag(sub.hi) || inferHearingImpairedFromName(extracted || finalName),
        foreign_parts_only: false,
        machine_translated: false,
        uploader: 'OpenSubtitles V3',
        provider: 'opensubtitles-v3',
        // Store original URL for direct download
        _v3Url: sub.url
      };
    }).filter(Boolean);
  }

  /**
   * Download subtitle content from V3 API with retry logic
   * @param {string} fileId - Opaque authenticated file ID from search results
   * @param {number} maxRetries - Maximum number of retries (default: 3)
   * @returns {Promise<string>} - Subtitle content as text
   */
  async downloadSubtitle(fileId, options = {}) {
    // Support legacy call pattern: downloadSubtitle(fileId, maxRetries)
    // New pattern: downloadSubtitle(fileId, { timeout, maxRetries })
    let maxRetries = 3;
    let timeout = 12000; // Default 12s

    if (typeof options === 'number') {
      // Legacy: second arg was maxRetries
      maxRetries = options;
    } else if (options) {
      timeout = options.timeout || 12000;
      maxRetries = options.maxRetries || 3;
    }
    // Format: v3_e1_{opaque_token} or
    // v3_e1_{opaque_token}_seasonpack_s{season}e{episode}
    if (!fileId.startsWith('v3_')) {
      throw new Error('Invalid V3 file ID format');
    }

    // Check for season pack encoding in fileId
    let isSeasonPack = false;
    let seasonPackSeason = null;
    let seasonPackEpisode = null;
    let baseFileId = fileId;

    const seasonPackMatch = fileId.match(/^(v3_.+)_seasonpack_s(\d+)e(\d+)$/i);
    if (seasonPackMatch) {
      isSeasonPack = true;
      baseFileId = seasonPackMatch[1];
      seasonPackSeason = parseInt(seasonPackMatch[2], 10);
      seasonPackEpisode = parseInt(seasonPackMatch[3], 10);
      log.debug(() => `[OpenSubtitles V3] Season pack download: S${String(seasonPackSeason).padStart(2, '0')}E${String(seasonPackEpisode).padStart(2, '0')}`);
    }

    const downloadUrl = decodeProviderUrl(baseFileId, 'v3_');
    const downloadRequestConfig = createPublicRemoteRequestConfig(downloadUrl, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': USER_AGENT },
      timeout
    }, {
      context: 'OpenSubtitles V3 download URL',
      maxBytes: MAX_ZIP_BYTES
    });

    log.debug(() => '[OpenSubtitles V3] Decoded download URL');


    // Retry logic with exponential backoff
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        log.debug(() => `[OpenSubtitles V3] Downloading subtitle (attempt ${attempt}/${maxRetries}): ${fileId}`);

        // Download the subtitle file as raw bytes to handle BOM/ZIP efficiently
        const response = await this.client.get(downloadUrl, downloadRequestConfig);

        const buf = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);

        // Analyze response content to detect HTML error pages, Cloudflare blocks, etc.
        const contentAnalysis = analyzeResponseContent(buf);

        // Check for archive by magic bytes (ZIP, RAR, Gzip, 7z, Tar, etc.)
        const archiveType = detectArchiveType(buf);

        if (archiveType) {
          log.debug(() => `[OpenSubtitles V3] Detected ${archiveType.toUpperCase()} archive`);

          // Use the centralized archive extractor
          return await extractSubtitleFromArchive(buf, {
            providerName: 'OpenSubtitles V3',
            maxBytes: MAX_ZIP_BYTES,
            isSeasonPack: isSeasonPack,
            season: seasonPackSeason,
            episode: seasonPackEpisode,
            languageHint: options.languageHint || null,
            skipAssConversion: options.skipAssConversion
          });
        }

        // If not an archive and not valid subtitle content, show error
        if (contentAnalysis.type !== 'subtitle' && contentAnalysis.type !== 'unknown') {
          // Check if it's an error response (HTML, Cloudflare, etc.)
          if (contentAnalysis.type.startsWith('html') || contentAnalysis.type === 'json_error' || contentAnalysis.type === 'text_error' || contentAnalysis.type === 'empty' || contentAnalysis.type === 'truncated') {
            log.error(() => `[OpenSubtitles V3] Download failed: ${contentAnalysis.type} - ${contentAnalysis.hint}`);
            return createInvalidResponseSubtitle('OpenSubtitles V3', contentAnalysis, buf.length);
          }
        }

        // Use centralized encoding detector for proper Arabic/Hebrew/RTL support
        let text = detectAndConvertEncoding(buf, 'OpenSubtitles V3', options.languageHint || null);

        const trimmed = (text || '').trimStart();
        if (trimmed.startsWith('WEBVTT')) {
          log.debug(() => '[OpenSubtitles V3] Detected VTT; returning original VTT');
          return text;
        }

        // Check if it's SRT format (no conversion needed)
        if (/^\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,.:]\d{2,3}/.test(trimmed)) {
          log.debug(() => '[OpenSubtitles V3] Detected SRT; returning original SRT');
          return text;
        }

        // Use centralized converter for ASS/SSA and other formats
        // This handles unsupported formats gracefully with informational subtitles
        if (/\[events\]/i.test(text) || /^dialogue\s*:/im.test(text) ||
          trimmed.endsWith('.ass') || trimmed.endsWith('.ssa') ||
          trimmed.endsWith('.sub')) {
          log.debug(() => '[OpenSubtitles V3] Non-SRT format detected, using centralized converter');
          // Determine filename for converter (best effort from URL)
          let filename = 'subtitle.ass';
          try {
            const urlMatch = downloadUrl.match(/\/([^\/]+)\.(srt|vtt|ass|ssa|sub)$/i);
            if (urlMatch) filename = `${urlMatch[1]}.${urlMatch[2]}`;
          } catch (_) { }
          return await convertSubtitleToVtt(text, filename, 'OpenSubtitles V3', { skipAssConversion: options.skipAssConversion });
        }

        log.debug(() => '[OpenSubtitles V3] Subtitle downloaded successfully');
        return text;

      } catch (error) {
        lastError = error;
        const status = error.response?.status;

        if (isRemoteResponseTooLargeError(error)) {
          log.warn(() => `[OpenSubtitles V3] Download exceeded ${MAX_ZIP_BYTES} byte response limit`);
          return createZipTooLargeSubtitle(MAX_ZIP_BYTES, MAX_ZIP_BYTES + 1);
        }

        if (isSsrfBlockedRequestError(error)) {
          log.warn(() => `[OpenSubtitles V3] Blocked unsafe download destination: ${error.message}`);
          break;
        }

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
