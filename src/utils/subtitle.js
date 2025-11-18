/**
 * Utility functions for subtitle handling
 */

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
 * @param {string} id - Stremio video ID (e.g., "tt1234567:1:2" for episode, "anidb:123:1:2" for anime)
 * @returns {Object} - Parsed video info
 */
function parseStremioId(id) {
  if (!id) return null;

  const parts = id.split(':');

  // Handle anime IDs (anidb, kitsu, mal, anilist)
  if (parts[0] && /^(anidb|kitsu|mal|anilist)/.test(parts[0])) {
    const animeIdType = parts[0]; // Platform name (anidb, kitsu, etc.)

    if (parts.length === 1) {
      // Anime movie or series (format: platform:id)
      const animeId = parts[0];
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
      const animeId = `${parts[0]}:${parts[1]}`; // Full ID with platform prefix
      return {
        animeId,
        animeIdType,
        type: 'anime-episode',
        episode: parseInt(parts[2]),
        isAnime: true,
        // Keep anidbId for backward compatibility if it's an AniDB ID
        ...(animeIdType === 'anidb' && { anidbId: animeId })
      };
    }

    if (parts.length === 4) {
      // Anime episode with season (format: platform:id:season:episode)
      // Example: kitsu:8640:1:2 -> platform=kitsu, id=8640, season=1, episode=2
      const animeId = `${parts[0]}:${parts[1]}`; // Full ID with platform prefix
      return {
        animeId,
        animeIdType,
        type: 'anime-episode',
        season: parseInt(parts[2]),
        episode: parseInt(parts[3]),
        isAnime: true,
        // Keep anidbId for backward compatibility if it's an AniDB ID
        ...(animeIdType === 'anidb' && { anidbId: animeId })
      };
    }
  }

  // Handle IMDB IDs (regular content)
  const imdbId = normalizeImdbId(parts[0]);

  if (parts.length === 1) {
    // Movie
    return {
      imdbId,
      type: 'movie'
    };
  }

  if (parts.length === 3) {
    // TV Episode
    return {
      imdbId,
      type: 'episode',
      season: parseInt(parts[1]),
      episode: parseInt(parts[2])
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
  validateSRT,
  normalizeImdbId,
  parseStremioId,
  createSubtitleUrl,
  sanitizeSubtitleText
};
