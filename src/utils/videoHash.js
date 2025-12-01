const crypto = require('crypto');

/**
 * Derive a stable hash for a video using the stream filename when available,
 * combined with the video/stremio id when available. The hash is truncated
 * to 16 hex chars to keep cache keys short while still avoiding easy collisions.
 */
function deriveVideoHash(filename, fallbackId = '') {
  const name = (filename && String(filename).trim()) || '';
  const fallback = (fallbackId && String(fallbackId).trim()) || '';
  const base = [name, fallback].filter(Boolean).join('::');
  if (!base) return '';
  return crypto.createHash('md5').update(base).digest('hex').substring(0, 16);
}

module.exports = {
  deriveVideoHash
};
