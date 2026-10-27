const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveCacheTtlSeconds,
  isCacheEntryExpired
} = require('./cacheExpiry');

test('cache TTL follows the payload expiry instead of the cache namespace default', () => {
  const now = 1_000_000;

  assert.equal(resolveCacheTtlSeconds(now + (15 * 60 * 1000), 12 * 60 * 60, now), 15 * 60);
  assert.equal(resolveCacheTtlSeconds(now + 1, 12 * 60 * 60, now), 1);
  assert.equal(resolveCacheTtlSeconds(now - 1, 12 * 60 * 60, now), 1);
  assert.equal(resolveCacheTtlSeconds(null, 12 * 60 * 60, now), 12 * 60 * 60);
});

test('payload expiry protects reads of legacy entries stored with a longer namespace TTL', () => {
  const now = 1_000_000;

  assert.equal(isCacheEntryExpired({ expiresAt: now - 1 }, now), true);
  assert.equal(isCacheEntryExpired({ expiresAt: now }, now), true);
  assert.equal(isCacheEntryExpired({ expiresAt: now + 1 }, now), false);
  assert.equal(isCacheEntryExpired({}, now), false);
});
