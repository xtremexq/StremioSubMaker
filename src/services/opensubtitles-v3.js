const axios = require('axios');
const { toISO6391, toISO6392 } = require('../utils/languages');
const { handleSearchError, handleDownloadError } = require('../utils/apiErrorHandler');
const { httpAgent, httpsAgent, dnsLookup } = require('../utils/httpAgents');
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
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br'
      },
      timeout: 10000, // 10 second timeout
      httpAgent,
      httpsAgent,
      lookup: dnsLookup,
      maxRedirects: 5,
      decompress: true
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
          const nameLower = sub.name.toLowerCase();

          // Patterns to match the correct episode (S03E02, 3x02, etc.)
          const seasonEpisodePatterns = [
            new RegExp(`s0*${effectiveSeason}e0*${episode}\\b`, 'i'),           // S03E02, S3E2
            new RegExp(`${effectiveSeason}x0*${episode}\\b`, 'i'),              // 3x02
            new RegExp(`s0*${effectiveSeason}\\.e0*${episode}\\b`, 'i'),        // S03.E02
            new RegExp(`season\\s*0*${effectiveSeason}.*episode\\s*0*${episode}\\b`, 'i')  // Season 3 Episode 2
          ];

          // Anime-friendly episode patterns (commonly no season)
          const animeEpisodePatterns = [
            new RegExp(`(?<=\\b|\\s|\\[|\\(|-|_)e?p?\\s*0*${episode}(?:v\\d+)?(?=\\b|\\s|\\]|\\)|\\.|-|_|$)`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${episode}(?:v\\d+)?(?=$|[\\s\\]\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])episode\\s*0*${episode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])ep\\s*0*${episode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])cap(?:itulo|\\.)?\\s*0*${episode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])epis[oó]dio\\s*0*${episode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
            new RegExp(`第\\s*0*${episode}\\s*(?:話|集)`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${episode}\\s*(?:話|集|화)(?=$|[\\s\\]\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${episode}\\s*[-~](?=\\s*\\d)`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])\\d+\\s*[-~]\\s*0*${episode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
          ];

          // If ANY pattern matches the correct episode, keep this subtitle
          if (seasonEpisodePatterns.some(pattern => pattern.test(nameLower)) ||
              (type === 'anime-episode' && animeEpisodePatterns.some(p => p.test(nameLower)))) {
            return true;
          }

          // Check if subtitle has a DIFFERENT episode number (wrong episode)
          // Extract season/episode from subtitle name
          const episodeMatch = nameLower.match(/s0*(\d+)e0*(\d+)|(\d+)x0*(\d+)/i);
          if (episodeMatch) {
            const subSeason = parseInt(episodeMatch[1] || episodeMatch[3]);
            const subEpisode = parseInt(episodeMatch[2] || episodeMatch[4]);

            // If it explicitly mentions a different episode, filter it out
            if (subSeason === effectiveSeason && subEpisode !== episode) {
              return false; // Wrong episode - exclude
            }
          }

          // No episode info found in name - keep it (might be generic subtitle)
          // The ranking algorithm will handle these with lower scores
          return true;
        });

        const filteredCount = beforeCount - episodeFilteredSubtitles.length;
        if (filteredCount > 0) {
          log.debug(() => `[OpenSubtitles V3] Filtered out ${filteredCount} wrong episode subtitles (requested: S${String(effectiveSeason).padStart(2, '0')}E${String(episode).padStart(2, '0')})`);
        }
      }

      return episodeFilteredSubtitles;

    } catch (error) {
      return handleSearchError(error, 'OpenSubtitles V3');
    }
  }

  /**
   * Extract filenames from subtitle URLs using batched parallel HEAD requests
   * @param {Array} subtitles - Array of subtitle objects with urls
   * @returns {Promise<Array>} - Subtitles with extracted names
   */
  async extractFilenames(subtitles) {
    const BATCH_SIZE = 10;
    const extractedNames = new Array(subtitles.length);

    // Process subtitles in batches of 10 to avoid rate limiting
    for (let i = 0; i < subtitles.length; i += BATCH_SIZE) {
      const batch = subtitles.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(async (sub, batchIndex) => {
        try {
          // Make HEAD request to get Content-Disposition header
          const response = await this.client.head(sub.url, {
            headers: {
              'User-Agent': USER_AGENT
            },
            timeout: 3000 // 3 second timeout for HEAD requests
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

      // Wait for this batch to complete
      const batchResults = await Promise.all(batchPromises);

      // Store results in correct positions
      batchResults.forEach((result, batchIndex) => {
        extractedNames[i + batchIndex] = result;
      });
    }

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

        // Download the subtitle file as raw bytes to handle BOM/ZIP efficiently
        const response = await this.client.get(downloadUrl, {
          responseType: 'arraybuffer',
          headers: { 'User-Agent': USER_AGENT },
          timeout: 12000
        });

        const buf = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
        const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;

        if (isZip) {
          const JSZip = require('jszip');
          const zip = await JSZip.loadAsync(buf, { base64: false });
          const entries = Object.keys(zip.files);
          const srtEntry = entries.find(f => f.toLowerCase().endsWith('.srt'));
          if (srtEntry) {
            const srt = await zip.files[srtEntry].async('string');
            log.debug(() => '[OpenSubtitles V3] Extracted .srt from ZIP');
            return srt;
          }
          const altEntry = entries.find(f => { const l=f.toLowerCase(); return l.endsWith('.vtt') || l.endsWith('.ass') || l.endsWith('.ssa') || l.endsWith('.sub'); });
          if (altEntry) {
            const uint8 = await zip.files[altEntry].async('uint8array');
            const abuf = Buffer.from(uint8);
            let raw;
            if (abuf.length >= 2 && abuf[0] === 0xFF && abuf[1] === 0xFE) raw = abuf.slice(2).toString('utf16le');
            else if (abuf.length >= 2 && abuf[0] === 0xFE && abuf[1] === 0xFF) {
              const swapped = Buffer.allocUnsafe(Math.max(0, abuf.length - 2));
              for (let i = 2, j = 0; i + 1 < abuf.length; i += 2, j += 2) { swapped[j] = abuf[i + 1]; swapped[j + 1] = abuf[i]; }
              raw = swapped.toString('utf16le');
            } else raw = abuf.toString('utf8');

            const lname = altEntry.toLowerCase();
            if (lname.endsWith('.vtt')) return raw;

            // Handle MicroDVD .sub files (text-based, frame-based timing)
            if (lname.endsWith('.sub')) {
              const isMicroDVD = /^\s*\{\d+\}\{\d+\}/.test(raw);
              if (isMicroDVD) {
                log.debug(() => `[OpenSubtitles V3] Detected MicroDVD .sub format: ${altEntry}`);
                try {
                  const subsrt = require('subsrt-ts');
                  const fps = 25;
                  const converted = subsrt.convert(raw, { to: 'vtt', from: 'sub', fps: fps });
                  if (converted && typeof converted === 'string' && converted.trim().length > 0) {
                    log.debug(() => `[OpenSubtitles V3] Converted MicroDVD .sub to .vtt successfully (fps=${fps})`);
                    return converted;
                  }
                } catch (subErr) {
                  log.error(() => ['[OpenSubtitles V3] Failed to convert MicroDVD .sub to .vtt:', subErr.message]);
                }
              } else {
                log.warn(() => `[OpenSubtitles V3] Detected VobSub .sub format (binary/image-based): ${altEntry} - not supported, skipping`);
              }
            }

            try {
              const subsrt = require('subsrt-ts');
              let converted;
              if (lname.endsWith('.ass')) converted = subsrt.convert(raw, { to: 'vtt', from: 'ass' });
              else if (lname.endsWith('.ssa')) converted = subsrt.convert(raw, { to: 'vtt', from: 'ssa' });
              else converted = subsrt.convert(raw, { to: 'vtt' });
              if (!converted || converted.trim().length === 0) {
                const sanitized = (raw || '').replace(/\u0000/g, '');
                if (lname.endsWith('.ass')) converted = subsrt.convert(sanitized, { to: 'vtt', from: 'ass' });
                else if (lname.endsWith('.ssa')) converted = subsrt.convert(sanitized, { to: 'vtt', from: 'ssa' });
                else converted = subsrt.convert(sanitized, { to: 'vtt' });
              }
              if (converted && converted.trim().length > 0) return converted;
              throw new Error('Empty VTT after conversion');
            } catch (_) {
              const manual = (function assToVttFallback(input) {
                if (!input || !/\[events\]/i.test(input)) return null;
                const lines = input.split(/\r?\n/); let format = []; let inEvents = false;
                for (const line of lines) {
                  const l = line.trim();
                  if (/^\[events\]/i.test(l)) { inEvents = true; continue; }
                  if (!inEvents) continue; if (/^\[.*\]/.test(l)) break;
                  if (/^format\s*:/i.test(l)) format = l.split(':')[1].split(',').map(s => s.trim().toLowerCase());
                }
                const idxStart = Math.max(0, format.indexOf('start'));
                const idxEnd = Math.max(1, format.indexOf('end'));
                const idxText = format.length > 0 ? Math.max(format.indexOf('text'), format.length - 1) : 9;
                const out = ['WEBVTT', ''];
                const parseTime = (t) => {
                  const m = t.trim().match(/(\d+):(\d{2}):(\d{2})[\.\:](\d{2})/);
                  if (!m) return null; const h=+m[1]||0, mi=+m[2]||0, s=+m[3]||0, cs=+m[4]||0;
                  const ms=(h*3600+mi*60+s)*1000+cs*10; const hh=String(Math.floor(ms/3600000)).padStart(2,'0');
                  const mm=String(Math.floor((ms%3600000)/60000)).padStart(2,'0'); const ss=String(Math.floor((ms%60000)/1000)).padStart(2,'0');
                  const mmm=String(ms%1000).padStart(3,'0'); return `${hh}:${mm}:${ss}.${mmm}`;
                };
                const cleanText = (txt) => { let t = txt.replace(/\{[^}]*\}/g,''); t = t.replace(/\\N/g,'\n').replace(/\\n/g,'\n').replace(/\\h/g,' ');
                  t = t.replace(/[\u0000-\u001F]/g,''); return t.trim(); };
                for (const line of lines) {
                  if (!/^dialogue\s*:/i.test(line)) continue; const payload=line.split(':').slice(1).join(':');
                  const parts=[]; let cur=''; let splits=0; for (let i=0;i<payload.length;i++){const ch=payload[i]; if(ch===',' && splits<Math.max(idxText,9)){parts.push(cur);cur='';splits++;} else {cur+=ch;}}
                  parts.push(cur); const st=parseTime(parts[idxStart]); const et=parseTime(parts[idxEnd]); if(!st||!et) continue;
                  const ct=cleanText(parts[idxText]??''); if(!ct) continue; out.push(`${st} --> ${et}`); out.push(ct); out.push('');
                }
                return out.length>2?out.join('\n'):null;
              })(raw);
              if (manual && manual.trim().length > 0) return manual;
            }
          }
          throw new Error('Failed to extract or convert subtitle from ZIP (no .srt and conversion to VTT failed)');
        }

        // Non-ZIP path: decode with BOM awareness
        let text;
        if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) text = buf.slice(2).toString('utf16le');
        else if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
          const swapped = Buffer.allocUnsafe(Math.max(0, buf.length - 2));
          for (let i = 2, j = 0; i + 1 < buf.length; i += 2, j += 2) { swapped[j] = buf[i + 1]; swapped[j + 1] = buf[i]; }
          text = swapped.toString('utf16le');
        } else text = buf.toString('utf8');

        const trimmed = (text || '').trimStart();
        if (trimmed.startsWith('WEBVTT')) {
          log.debug(() => '[OpenSubtitles V3] Detected VTT; returning original VTT');
          return text;
        }

        if (/\[events\]/i.test(text) || /^dialogue\s*:/im.test(text)) {
          try {
            const subsrt = require('subsrt-ts');
            let converted = subsrt.convert(text, { to: 'vtt', from: 'ass' });
            if (!converted || converted.trim().length === 0) {
              const sanitized = (text || '').replace(/\u0000/g, '');
              converted = subsrt.convert(sanitized, { to: 'vtt', from: 'ass' });
            }
            if (converted && converted.trim().length > 0) return converted;
          } catch (_) {}
          const manual = (function assToVttFallback(input) {
            if (!input || !/\[events\]/i.test(input)) return null;
            const lines = input.split(/\r?\n/); let format = []; let inEvents = false;
            for (const line of lines) {
              const l = line.trim(); if (/^\[events\]/i.test(l)) { inEvents = true; continue; }
              if (!inEvents) continue; if (/^\[.*\]/.test(l)) break;
              if (/^format\s*:/i.test(l)) format = l.split(':')[1].split(',').map(s => s.trim().toLowerCase());
            }
            const idxStart = Math.max(0, format.indexOf('start'));
            const idxEnd = Math.max(1, format.indexOf('end'));
            const idxText = format.length > 0 ? Math.max(format.indexOf('text'), format.length - 1) : 9;
            const out = ['WEBVTT', ''];
            const parseTime = (t) => {
              const m = t.trim().match(/(\d+):(\d{2}):(\d{2})[\.\:](\d{2})/);
              if (!m) return null; const h=+m[1]||0, mi=+m[2]||0, s=+m[3]||0, cs=+m[4]||0;
              const ms=(h*3600+mi*60+s)*1000+cs*10; const hh=String(Math.floor(ms/3600000)).padStart(2,'0');
              const mm=String(Math.floor((ms%3600000)/60000)).padStart(2,'0'); const ss=String(Math.floor((ms%60000)/1000)).padStart(2,'0');
              const mmm=String(ms%1000).padStart(3,'0'); return `${hh}:${mm}:${ss}.${mmm}`;
            };
            const cleanText = (txt) => { let t = txt.replace(/\{[^}]*\}/g,''); t = t.replace(/\\N/g,'\n').replace(/\\n/g,'\n').replace(/\\h/g,' ');
              t = t.replace(/[\u0000-\u001F]/g,''); return t.trim(); };
            for (const line of lines) {
              if (!/^dialogue\s*:/i.test(line)) continue; const payload=line.split(':').slice(1).join(':');
              const parts=[]; let cur=''; let splits=0; for (let i=0;i<payload.length;i++){const ch=payload[i]; if(ch===',' && splits<Math.max(idxText,9)){parts.push(cur);cur='';splits++;} else {cur+=ch;}}
              parts.push(cur); const st=parseTime(parts[idxStart]); const et=parseTime(parts[idxEnd]); if(!st||!et) continue;
              const ct=cleanText(parts[idxText]??''); if(!ct) continue; out.push(`${st} --> ${et}`); out.push(ct); out.push('');
            }
            return out.length>2?out.join('\n'):null;
          })(text);
          if (manual && manual.trim().length > 0) return manual;
        }

        log.debug(() => '[OpenSubtitles V3] Subtitle downloaded successfully');
        return text;

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
