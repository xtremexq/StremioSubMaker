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
  const blocks = srtContent.trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
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
    .map(entry => `${entry.id}\n${entry.timecode}\n${entry.text}`)
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
 * @param {string} id - Stremio video ID (e.g., "tt1234567:1:2" for episode)
 * @returns {Object} - Parsed video info
 */
function parseStremioId(id) {
  if (!id) return null;

  const parts = id.split(':');
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
