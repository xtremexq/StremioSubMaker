/**
 * Utility functions for subtitle handling
 */

const log = require('./logger');

/**
 * Detect whether subtitle content is ASS/SSA format
 * @param {string} content - Subtitle content
 * @returns {{ isASS: boolean, format: string|null }} - Detection result with format ('ass' or 'ssa')
 */
function detectASSFormat(content) {
  if (!content || typeof content !== 'string') {
    return { isASS: false, format: null };
  }
  const trimmed = content.trimStart();
  // ASS uses [V4+ Styles], SSA uses [V4 Styles]
  const hasScriptInfo = /\[script info\]/i.test(trimmed);
  const hasEvents = /\[events\]/i.test(trimmed);
  const hasDialogue = /^dialogue\s*:/im.test(trimmed);
  const hasV4Plus = /\[v4\+\s*styles\]/i.test(trimmed);
  const hasV4 = /\[v4\s+styles\]/i.test(trimmed);

  if (hasScriptInfo || hasEvents || hasDialogue) {
    // SSA uses [V4 Styles] (no plus), ASS uses [V4+ Styles]
    const format = (hasV4 && !hasV4Plus) ? 'ssa' : 'ass';
    return { isASS: true, format };
  }
  return { isASS: false, format: null };
}

/**
 * Convert subtitle content from any supported format to SRT.
 * Handles ASS/SSA → VTT → SRT, VTT → SRT, and SRT passthrough.
 * Uses a multi-strategy fallback chain for ASS/SSA conversion.
 *
 * @param {string} content - Subtitle content in any supported format (SRT, VTT, ASS, SSA)
 * @param {string} [logPrefix='[SRT Conversion]'] - Log prefix for debug messages
 * @returns {string} - SRT-formatted content (best effort; returns original on total failure)
 */
function convertToSRT(content, logPrefix = '[SRT Conversion]') {
  if (!content || typeof content !== 'string') {
    return content;
  }

  const trimmed = content.trimStart();

  // Already SRT — pass through (SRT starts with a numeric index line)
  if (/^\d+\s*[\r\n]/.test(trimmed)) {
    return content;
  }

  // VTT → SRT
  if (trimmed.startsWith('WEBVTT')) {
    try {
      const subsrt = require('subsrt-ts');
      const converted = subsrt.convert(content, { to: 'srt', from: 'vtt' });
      if (converted && typeof converted === 'string' && converted.trim().length > 0) {
        log.debug(() => `${logPrefix} Converted VTT to SRT (${converted.length} chars)`);
        return converted;
      }
    } catch (e) {
      log.warn(() => [`${logPrefix} VTT to SRT conversion failed; proceeding with original content:`, e.message]);
    }
    return content;
  }

  // ASS/SSA → SRT (multi-strategy fallback)
  const { isASS, format } = detectASSFormat(content);
  if (isASS) {
    log.debug(() => `${logPrefix} Detected ${(format || 'ass').toUpperCase()} subtitle, converting to SRT`);

    // Strategy 1: Enhanced converter (preprocessASS → subsrt-ts → postprocessVTT) then VTT→SRT
    try {
      const assConverter = require('./assConverter');
      const vttResult = assConverter.convertASSToVTT(content, format || 'ass');
      if (vttResult && vttResult.success && vttResult.content) {
        const subsrt = require('subsrt-ts');
        const srtContent = subsrt.convert(vttResult.content, { to: 'srt', from: 'vtt' });
        if (srtContent && typeof srtContent === 'string' && srtContent.trim().length > 0) {
          log.debug(() => `${logPrefix} Converted ${(format || 'ass').toUpperCase()} → VTT → SRT successfully (${srtContent.length} chars)`);
          return srtContent;
        }
        log.warn(() => `${logPrefix} VTT→SRT step returned empty after successful ASS→VTT conversion`);
      } else {
        log.warn(() => [`${logPrefix} Enhanced ASS→VTT conversion failed:`, vttResult?.error || 'unknown error']);
      }
    } catch (e) {
      log.warn(() => [`${logPrefix} Enhanced ASS/SSA converter threw:`, e.message]);
    }

    // Strategy 2: Direct subsrt-ts ASS/SSA → SRT (with preprocessor fix for first-letter bug)
    try {
      const subsrt = require('subsrt-ts');
      const assConverter = require('./assConverter');
      const preprocessed = assConverter.preprocessASS(content, format || 'ass');
      const directSrt = subsrt.convert(preprocessed, { to: 'srt', from: format || 'ass' });
      if (directSrt && typeof directSrt === 'string' && directSrt.trim().length > 0) {
        log.debug(() => `${logPrefix} Direct subsrt-ts ${(format || 'ass').toUpperCase()} → SRT succeeded (${directSrt.length} chars)`);
        return directSrt;
      }
    } catch (e) {
      log.warn(() => [`${logPrefix} Direct subsrt-ts ASS/SSA → SRT failed:`, e.message]);
    }

    // Strategy 3: Manual ASS parser → SRT (last resort)
    try {
      const manualResult = manualAssToSrt(content);
      if (manualResult) {
        log.debug(() => `${logPrefix} Manual ASS parser → SRT succeeded (${manualResult.length} chars)`);
        return manualResult;
      }
    } catch (e) {
      log.warn(() => [`${logPrefix} Manual ASS parser failed:`, e.message]);
    }

    log.warn(() => `${logPrefix} All ASS/SSA → SRT conversion strategies failed; proceeding with original content`);
    return content;
  }

  // Unknown format — try generic subsrt-ts conversion as last resort
  // Apply ASS preprocessor in case format detection missed an ASS/SSA variant (fixes subsrt-ts first-letter bug)
  try {
    const subsrt = require('subsrt-ts');
    const assConverter = require('./assConverter');
    const preprocessed = assConverter.preprocessASS(content);
    const generic = subsrt.convert(preprocessed, { to: 'srt' });
    if (generic && typeof generic === 'string' && generic.trim().length > 0) {
      log.debug(() => `${logPrefix} Generic subsrt-ts conversion to SRT succeeded (${generic.length} chars)`);
      return generic;
    }
  } catch (_) { }

  return content;
}

/**
 * Ensure subtitle content is in SRT format for translation.
 * Thin wrapper around convertToSRT with a translation-specific log prefix.
 *
 * @param {string} content - Subtitle content in any supported format
 * @param {string} [logPrefix='[Translation]'] - Log prefix for debug messages
 * @returns {string} - SRT-formatted content (best effort; returns original on total failure)
 */
function ensureSRTForTranslation(content, logPrefix = '[Translation]') {
  return convertToSRT(content, logPrefix);
}

/**
 * Manual ASS/SSA to SRT converter (last-resort fallback).
 * Parses Dialogue lines directly and produces SRT output.
 * @param {string} input - Raw ASS/SSA content
 * @returns {string|null} - SRT content or null on failure
 */
function manualAssToSrt(input) {
  if (!input || !/\[events\]/i.test(input)) return null;

  const lines = input.split(/\r?\n/);
  let formatFields = [];
  let inEvents = false;

  for (const line of lines) {
    const l = line.trim();
    if (/^\[events\]/i.test(l)) { inEvents = true; continue; }
    if (!inEvents) continue;
    if (/^\[.*\]/.test(l)) break;
    if (/^format\s*:/i.test(l)) {
      formatFields = l.split(':')[1].split(',').map(s => s.trim().toLowerCase());
    }
  }

  const idxStart = Math.max(0, formatFields.indexOf('start'));
  const idxEnd = Math.max(1, formatFields.indexOf('end'));
  const idxText = formatFields.length > 0 ? Math.max(formatFields.indexOf('text'), formatFields.length - 1) : 9;

  const entries = [];

  const parseTime = (t) => {
    const m = t.trim().match(/(\d+):(\d{2}):(\d{2})[\.\:](\d{2})/);
    if (!m) return null;
    const h = parseInt(m[1], 10) || 0;
    const mi = parseInt(m[2], 10) || 0;
    const s = parseInt(m[3], 10) || 0;
    const cs = parseInt(m[4], 10) || 0;
    const ms = (h * 3600 + mi * 60 + s) * 1000 + cs * 10;
    const hh = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const mm = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
    const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    const mmm = String(ms % 1000).padStart(3, '0');
    return `${hh}:${mm}:${ss},${mmm}`;
  };

  const cleanText = (txt) => {
    let t = txt.replace(/\{[^}]*\}/g, '');
    t = t.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');
    t = t.replace(/[\u0000-\u001F]/g, '');
    return t.trim();
  };

  for (const line of lines) {
    if (!/^dialogue\s*:/i.test(line)) continue;
    const payload = line.split(':').slice(1).join(':');
    const parts = [];
    let cur = '';
    let splits = 0;
    for (let i = 0; i < payload.length; i++) {
      const ch = payload[i];
      if (ch === ',' && splits < Math.max(idxText, 9)) {
        parts.push(cur);
        cur = '';
        splits++;
      } else {
        cur += ch;
      }
    }
    parts.push(cur);
    const st = parseTime(parts[idxStart]);
    const et = parseTime(parts[idxEnd]);
    if (!st || !et) continue;
    const ct = cleanText(parts[idxText] ?? '');
    if (!ct) continue;
    entries.push({ start: st, end: et, text: ct });
  }

  if (entries.length === 0) return null;

  return entries.map((e, i) =>
    `${i + 1}\n${e.start} --> ${e.end}\n${e.text}`
  ).join('\n\n');
}

/**
 * Parse SRT subtitle content into structured format
 * @param {string} srtContent - SRT formatted subtitle content
 * @returns {Array} - Array of subtitle entries
 */
function parseSRT(srtContent) {
  if (!srtContent || typeof srtContent !== 'string') {
    return [];
  }

  const entries = [];
  // CRLF-aware splitting: handles both \n\n (LF) and \r\n\r\n (CRLF) line endings
  // Pattern (?:\r?\n){2,} matches 2 or more consecutive newlines (with optional \r before each \n)
  const blocks = srtContent.trim().split(/(?:\r?\n){2,}/);

  for (const block of blocks) {
    // Also handle CRLF when splitting lines within each block
    const lines = block.trim().split(/\r?\n/);
    if (lines.length < 3) continue;

    const id = parseInt(lines[0]);
    if (isNaN(id)) continue;

    const timecode = lines[1];
    const text = lines.slice(2).join('\n');

    entries.push({
      id,
      timecode,
      text
    });
  }

  return entries;
}

const DEFAULT_INFO_SUBTITLE_NOTE = 'This informational subtitle was generated by the addon.';
const HIDDEN_NOTE_TIMECODE = '04:00:01,000 --> 04:00:02,500';
const MIN_INFO_SUBTITLE_LENGTH = 240;

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Append an informational note as a hidden (>4h) cue and ensure minimum length
 * so heuristic filters keep the subtitle while keeping the note off-screen.
 * @param {string} srtContent - Base SRT content
 * @param {string} note - Informational note to include in hidden cue
 * @param {number} minLength - Minimum total length to enforce
 * @returns {string}
 */
function appendHiddenInformationalNote(srtContent, note = DEFAULT_INFO_SUBTITLE_NOTE, minLength = MIN_INFO_SUBTITLE_LENGTH) {
  try {
    const base = typeof srtContent === 'string' ? srtContent : String(srtContent || '');
    // Strip any visible occurrences of the note so it only lives in the hidden cue
    const sanitized = base.replace(new RegExp(escapeRegExp(note), 'g'), '').trimEnd();
    const entries = parseSRT(sanitized) || [];
    const lastId = entries.length > 0 ? Math.max(...entries.map(e => parseInt(e.id, 10) || 0)) : 0;
    const nextId = Math.max(1, lastId + 1);
    const separator = sanitized && sanitized.length > 0 ? '\n\n' : '';
    const cueHeader = `${nextId}\n${HIDDEN_NOTE_TIMECODE}\n`;

    const filler = ' Additional details: this subtitle is shown by the addon to explain what went wrong.';
    let hiddenText = note;

    const currentLength = sanitized.length + separator.length + cueHeader.length + hiddenText.length;
    if (currentLength < minLength) {
      const needed = minLength - currentLength;
      const fillerChunk = filler.repeat(Math.ceil(needed / filler.length)).slice(0, needed);
      hiddenText += fillerChunk;

      const afterFillerLength = sanitized.length + separator.length + cueHeader.length + hiddenText.length;
      if (afterFillerLength < minLength) {
        hiddenText += '.'.repeat(minLength - afterFillerLength);
      }
    }

    return `${sanitized}${separator}${cueHeader}${hiddenText}`;
  } catch (_) {
    return srtContent;
  }
}

/**
 * Convert parsed subtitle entries back to SRT format
 * @param {Array} entries - Array of subtitle entries
 * @returns {string} - SRT formatted content
 */
function toSRT(entries) {
  return entries
    .map(entry => {
      // Ensure text uses only LF (\n), not CRLF (\r\n)
      // This prevents extra spacing issues on Linux
      const normalizedText = entry.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      return `${entry.id}\n${entry.timecode}\n${normalizedText}`;
    })
    .join('\n\n') + '\n';
}

/**
 * Convert SRT time (HH:MM:SS,mmm) to VTT time (HH:MM:SS.mmm)
 */
function srtTimeToVttTime(tc) {
  return String(tc || '').replace(/,/g, '.');
}

// Parse SRT timecode duration in milliseconds (00:00:00,000 --> 00:00:05,000)
function srtDurationMs(tc) {
  const m = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/.exec(String(tc || '').trim());
  if (!m) return 0;
  const toMs = (h, mm, s, ms) => (((parseInt(h, 10) || 0) * 60 + (parseInt(mm, 10) || 0)) * 60 + (parseInt(s, 10) || 0)) * 1000 + (parseInt(ms, 10) || 0);
  return Math.max(0, toMs(m[5], m[6], m[7], m[8]) - toMs(m[1], m[2], m[3], m[4]));
}

/**
 * Convert two aligned SRT strings into a dual-language WebVTT output
 * - Merges both languages into a single cue per entry (line break separated)
 *   for maximum cross-player compatibility (Android, Android TV, desktop)
 * - Order controls which language appears on the first line
 */
function srtPairToWebVTT(sourceSrt, targetSrt, order = 'source-top', placement = 'stacked', options = {}) {
  try {
    const srcEntries = parseSRT(sourceSrt);
    const trgEntries = parseSRT(targetSrt);
    const srcTop = order === 'source-top';
    const italic = options.learnItalic !== false; // default true
    const italicTarget = options.learnItalicTarget || 'target'; // 'target' | 'source'
    const isStatusCue = (text) => /TRANSLATION IN PROGRESS|Reload this subtitle/i.test(String(text || ''));

    // When we only have a partial translation, limit cues to what the target has (including the status tail)
    const statusIndex = trgEntries.findIndex(e => isStatusCue(e.text));
    const hasStatusTail = statusIndex !== -1;
    const translatedCount = hasStatusTail ? Math.max(0, statusIndex) : trgEntries.length;
    const isPartial = hasStatusTail || (trgEntries.length > 0 && trgEntries.length < srcEntries.length);
    const count = isPartial
      ? Math.min(translatedCount, srcEntries.length)
      : Math.max(srcEntries.length, trgEntries.length);

    const lines = ['WEBVTT', ''];

    for (let i = 0; i < count; i++) {
      const s = srcEntries[i];
      const t = trgEntries[i];
      if (!s && !t) continue;

      // Choose timecode: prefer target when it exists and is a status cue or longer than source
      let chosenTimecode = (s && s.timecode) || '';
      if (t && t.timecode) {
        if (!chosenTimecode) {
          chosenTimecode = t.timecode;
        } else if (isStatusCue(t.text) || srtDurationMs(t.timecode) > srtDurationMs(chosenTimecode)) {
          chosenTimecode = t.timecode;
        }
      }

      if (!chosenTimecode) {
        chosenTimecode = '00:00:00,000 --> 00:00:05,000';
      }

      const vttTime = srtTimeToVttTime(chosenTimecode);

      // Status cues render alone so they don't get paired with source text
      if (isStatusCue(t && t.text)) {
        lines.push(vttTime);
        lines.push(sanitizeSubtitleText(t.text));
        lines.push('');
        continue;
      }

      let firstLine = srcTop ? (s && s.text) : (t && t.text);
      let secondLine = srcTop ? (t && t.text) : (s && s.text);

      // Fallback: if only one side exists, show it alone
      if (!firstLine && secondLine) {
        firstLine = secondLine;
        secondLine = '';
      }

      if (!firstLine && !secondLine) continue;

      // Single cue with both languages separated by a line break.
      // Optionally italicize one language for visual distinction.
      lines.push(vttTime);
      const sanitizedFirst = sanitizeSubtitleText(firstLine);
      if (secondLine) {
        const sanitizedSecond = sanitizeSubtitleText(secondLine);
        if (italic) {
          // Determine which line to italicize based on config
          // firstLine is source when srcTop, target when !srcTop
          const italicizeFirst = (srcTop && italicTarget === 'source') || (!srcTop && italicTarget === 'target');
          if (italicizeFirst) {
            lines.push(`<i>${sanitizedFirst}</i>\n${sanitizedSecond}`);
          } else {
            lines.push(`${sanitizedFirst}\n<i>${sanitizedSecond}</i>`);
          }
        } else {
          lines.push(`${sanitizedFirst}\n${sanitizedSecond}`);
        }
      } else {
        lines.push(sanitizedFirst);
      }
      lines.push('');
    }

    // If we had a status tail that wasn't consumed in the main loop (e.g., no translations yet),
    // render it here so users still see progress without extra source lines mixed in.
    if (hasStatusTail && (count === 0 || statusIndex >= count)) {
      const statusEntry = trgEntries[statusIndex];
      const fallbackTime = srcEntries[count - 1]?.timecode || '00:00:00,000 --> 04:00:00,000';
      const vttTime = srtTimeToVttTime(statusEntry.timecode || fallbackTime);
      lines.push(vttTime);
      lines.push(sanitizeSubtitleText(statusEntry.text));
      lines.push('');
    }

    if (count === 0 && !hasStatusTail) {
      // Fallback minimal cue
      lines.push('00:00:00.000 --> 04:00:00.000');
      lines.push('No content available');
      lines.push('');
    }

    return lines.join('\n');
  } catch (_) {
    // Simple fallback VTT
    return 'WEBVTT\n\n00:00:00.000 --> 04:00:00.000\nLearn Mode: Unable to build VTT';
  }
}

/**
 * Validate SRT subtitle content
 * @param {string} srtContent - SRT content to validate
 * @returns {boolean} - True if valid SRT format
 */
function validateSRT(srtContent) {
  if (!srtContent || typeof srtContent !== 'string') {
    return false;
  }

  const entries = parseSRT(srtContent);
  return entries.length > 0;
}

/**
 * Extract IMDB ID from various formats
 * @param {string} id - ID in various formats (tt1234567, 1234567, etc.)
 * @returns {string} - Normalized IMDB ID with 'tt' prefix
 */
function normalizeImdbId(id) {
  if (!id) return null;

  const idStr = String(id).trim();

  // If it already has 'tt' prefix, return as is
  if (idStr.startsWith('tt')) {
    return idStr;
  }

  // If it's just numbers, add 'tt' prefix
  if (/^\d+$/.test(idStr)) {
    return `tt${idStr}`;
  }

  return idStr;
}

/**
 * Extract video info from Stremio ID
 * @param {string} id - Stremio video ID (e.g., "tt1234567:1:2" for episode, "anidb:123:1:2" for anime, "tmdb:1234" for TMDB)
 * @param {string} [stremioType] - Optional Stremio meta type hint ("movie" or "series")
 * @returns {Object|null} - Parsed video info
 */
function parseStremioId(id, stremioType) {
  if (!id) return null;

  const raw = String(id).trim();
  if (!raw) return null;

  const parts = raw.split(':');
  const prefix = String(parts[0] || '').toLowerCase();

  // Handle TMDB IDs (movie or TV/episode)
  if (prefix === 'tmdb') {
    const tmdbId = parts[1];
    if (!tmdbId) return null;

    // Derive media type from Stremio meta type when available
    const tmdbMediaType = stremioType === 'series' ? 'tv'
      : stremioType === 'movie' ? 'movie'
      : undefined;

    if (parts.length === 2) {
      // tmdb:{id} with no season/episode — could be movie or series
      // Use stremioType hint for tmdbMediaType (drives Cinemeta lookup type),
      // but keep parsed type as 'movie' since providers need season/episode
      // for series queries and we don't have them here
      return {
        tmdbId,
        tmdbMediaType,
        type: 'movie'
      };
    }

    if (parts.length === 3) {
      // Episode with implicit season 1: tmdb:{id}:{episode}
      const episode = parseInt(parts[2], 10);
      if (!Number.isFinite(episode) || episode <= 0) return null;
      return {
        tmdbId,
        tmdbMediaType,
        type: 'episode',
        season: 1,
        episode
      };
    }

    if (parts.length === 4) {
      // Episode with season: tmdb:{id}:{season}:{episode}
      const season = parseInt(parts[2], 10);
      const episode = parseInt(parts[3], 10);
      if (!Number.isFinite(season) || season <= 0 || !Number.isFinite(episode) || episode <= 0) return null;
      return {
        tmdbId,
        tmdbMediaType,
        type: 'episode',
        season,
        episode
      };
    }
  }

  // Handle anime IDs (extended compatibility with common anime catalog prefixes)
  const animePrefixAliases = {
    myanimelist: 'mal'
  };
  const supportedAnimePrefixes = new Set([
    'anidb',
    'kitsu',
    'mal',
    'myanimelist',
    'anilist',
    'tvdb',
    'simkl',
    'livechart',
    'anisearch'
  ]);

  if (parts[0] && supportedAnimePrefixes.has(prefix)) {
    const canonicalAnimePrefix = animePrefixAliases[prefix] || prefix;
    const animeIdType = canonicalAnimePrefix;
    const animeRawId = String(parts[1] || '').trim();
    if (!animeRawId) return null;

    if (parts.length === 2) {
      // Anime movie or series (format: platform:id)
      // Example: kitsu:8640 -> platform=kitsu, id=8640
      const animeId = `${canonicalAnimePrefix}:${animeRawId}`; // Full ID with canonical platform prefix
      return {
        animeId,
        animeIdType,
        type: 'anime',
        isAnime: true,
        // Keep anidbId for backward compatibility if it's an AniDB ID
        ...(animeIdType === 'anidb' && { anidbId: animeId })
      };
    }

    if (parts.length === 3) {
      // Anime episode (format: platform:id:episode)
      // Example: kitsu:8640:2 -> platform=kitsu, id=8640, episode=2
      const episode = parseInt(parts[2], 10);
      if (!Number.isFinite(episode) || episode <= 0) return null;
      const animeId = `${canonicalAnimePrefix}:${animeRawId}`; // Full ID with canonical platform prefix
      return {
        animeId,
        animeIdType,
        type: 'anime-episode',
        episode,
        isAnime: true,
        // Keep anidbId for backward compatibility if it's an AniDB ID
        ...(animeIdType === 'anidb' && { anidbId: animeId })
      };
    }

    if (parts.length === 4) {
      // Anime episode with season (format: platform:id:season:episode)
      // Example: kitsu:8640:1:2 -> platform=kitsu, id=8640, season=1, episode=2
      const season = parseInt(parts[2], 10);
      const episode = parseInt(parts[3], 10);
      if (!Number.isFinite(season) || season <= 0 || !Number.isFinite(episode) || episode <= 0) return null;
      const animeId = `${canonicalAnimePrefix}:${animeRawId}`; // Full ID with canonical platform prefix
      return {
        animeId,
        animeIdType,
        type: 'anime-episode',
        season,
        episode,
        isAnime: true,
        // Keep anidbId for backward compatibility if it's an AniDB ID
        ...(animeIdType === 'anidb' && { anidbId: animeId })
      };
    }

    return null;
  }

  // Fail closed for unknown prefixed IDs instead of coercing them into fake IMDB IDs.
  if (parts.length > 1 && prefix && !/^tt\d+$/i.test(prefix)) {
    return null;
  }

  // Handle IMDB IDs (regular content)
  const imdbBase = String(parts[0] || '').trim();
  const imdbId = normalizeImdbId(imdbBase);
  const isImdbLike = /^tt\d{3,}$/i.test(imdbId);
  if (!isImdbLike) return null;

  if (parts.length === 1) {
    // Movie
    return {
      imdbId,
      type: 'movie'
    };
  }

  if (parts.length === 2) {
    // IMDB ID with single numeric part — treat as episode with implicit season 1
    // e.g., tt1234567:5 -> season 1, episode 5
    const episodeNum = parseInt(parts[1], 10);
    if (!isNaN(episodeNum)) {
      return {
        imdbId,
        type: 'episode',
        season: 1,
        episode: episodeNum
      };
    }
    return null;
  }

  if (parts.length === 3) {
    // TV Episode
    const season = parseInt(parts[1], 10);
    const episode = parseInt(parts[2], 10);
    if (!Number.isFinite(season) || season <= 0 || !Number.isFinite(episode) || episode <= 0) return null;
    return {
      imdbId,
      type: 'episode',
      season,
      episode
    };
  }

  return null;
}

/**
 * Create a subtitle URL for Stremio
 * @param {string} id - Subtitle ID
 * @param {string} lang - Language code
 * @param {string} baseUrl - Base URL of the addon
 * @returns {string} - Subtitle URL
 */
function createSubtitleUrl(id, lang, baseUrl) {
  return `${baseUrl}/subtitle/${encodeURIComponent(id)}/${lang}.srt`;
}

/**
 * Sanitize subtitle text (remove unwanted characters, fix encoding issues)
 * @param {string} text - Subtitle text
 * @returns {string} - Sanitized text
 */
function sanitizeSubtitleText(text) {
  if (!text) return '';

  return text
    .replace(/\r\n/g, '\n') // Normalize line endings
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters
    .trim();
}

module.exports = {
  parseSRT,
  toSRT,
  appendHiddenInformationalNote,
  validateSRT,
  normalizeImdbId,
  parseStremioId,
  createSubtitleUrl,
  sanitizeSubtitleText,
  srtPairToWebVTT,
  convertToSRT,
  ensureSRTForTranslation,
  detectASSFormat
};
