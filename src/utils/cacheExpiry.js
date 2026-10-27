function resolveCacheTtlSeconds(expiresAt, fallbackTtlSeconds, now = Date.now()) {
  const absoluteExpiry = Number(expiresAt);
  if (Number.isFinite(absoluteExpiry) && absoluteExpiry > 0) {
    return Math.max(1, Math.ceil((absoluteExpiry - now) / 1000));
  }

  const fallback = Number(fallbackTtlSeconds);
  return Number.isFinite(fallback) && fallback > 0 ? Math.ceil(fallback) : null;
}

function isCacheEntryExpired(entry, now = Date.now()) {
  const absoluteExpiry = Number(entry?.expiresAt);
  return Number.isFinite(absoluteExpiry) && absoluteExpiry > 0 && absoluteExpiry <= now;
}

module.exports = {
  resolveCacheTtlSeconds,
  isCacheEntryExpired
};
