const log = require('./logger');
const { handleCaughtError } = require('./errorClassifier');
const { StorageFactory, StorageAdapter } = require('../storage');

let storageAdapter = null;

// Keep the legacy SMDB namespace so existing persisted hash links still resolve.
// These associations are generic and are now shared by SMDB plus local caches.
const CACHE_TYPE = StorageAdapter.CACHE_TYPES.SMDB;
const LEGACY_KEY_PREFIX = 'smdb_hashmap:';
const MAX_MAPPED = 12;
const MAX_ASSOCIATED_HASHES = 32;

async function getStorageAdapter() {
  if (!storageAdapter) {
    storageAdapter = await StorageFactory.getStorageAdapter();
  }
  return storageAdapter;
}

function sanitizeHash(value) {
  if (!value) return '';
  return String(value)
    .trim()
    .replace(/[\*\?\[\]\\]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120);
}

function buildAssociationKey(hash) {
  return `${LEGACY_KEY_PREFIX}${sanitizeHash(hash)}`;
}

function normalizeHashes(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .map(value => sanitizeHash(value))
      .filter(Boolean)
  )];
}

async function readAssociations(adapter, hash) {
  const key = buildAssociationKey(hash);
  const entry = await adapter.get(key, CACHE_TYPE);
  if (!entry || !Array.isArray(entry.hashes)) {
    return [];
  }
  return normalizeHashes(entry.hashes);
}

async function writeAssociations(adapter, hash, associatedHashes) {
  const key = buildAssociationKey(hash);
  await adapter.set(
    key,
    { hashes: normalizeHashes(associatedHashes).slice(0, MAX_MAPPED) },
    CACHE_TYPE
  );
}

async function saveHashMapping(hash1, hash2) {
  try {
    const [left, right] = normalizeHashes([hash1, hash2]);
    if (!left || !right || left === right) return;

    const adapter = await getStorageAdapter();
    const [leftExisting, rightExisting] = await Promise.all([
      readAssociations(adapter, left),
      readAssociations(adapter, right)
    ]);

    await Promise.all([
      writeAssociations(adapter, left, [...leftExisting, right]),
      writeAssociations(adapter, right, [...rightExisting, left])
    ]);

    log.debug(() => `[VideoHash] Saved mapping ${left.slice(0, 8)}... <-> ${right.slice(0, 8)}...`);
  } catch (error) {
    handleCaughtError(error, '[VideoHash] saveHashMapping failed', log);
  }
}

async function saveHashMappings(hashes) {
  const unique = normalizeHashes(hashes);
  if (unique.length < 2) return unique;

  try {
    const adapter = await getStorageAdapter();
    const existingEntries = await Promise.all(unique.map(hash => readAssociations(adapter, hash)));
    const nextByHash = new Map();

    unique.forEach((hash, index) => {
      nextByHash.set(hash, new Set(existingEntries[index]));
    });

    for (let i = 0; i < unique.length; i++) {
      for (let j = 0; j < unique.length; j++) {
        if (i === j) continue;
        nextByHash.get(unique[i]).add(unique[j]);
      }
    }

    await Promise.all(
      unique.map(hash => writeAssociations(adapter, hash, [...nextByHash.get(hash)]))
    );
  } catch (error) {
    handleCaughtError(error, '[VideoHash] saveHashMappings failed', log);
  }

  return unique;
}

async function getAssociatedHashes(hash) {
  try {
    const [seed] = normalizeHashes(hash);
    if (!seed) return [];

    const adapter = await getStorageAdapter();
    const seen = new Set([seed]);
    const ordered = [seed];
    const queue = [seed];

    while (queue.length && ordered.length < MAX_ASSOCIATED_HASHES) {
      const current = queue.shift();
      const neighbors = await readAssociations(adapter, current);
      for (const neighbor of neighbors) {
        if (!neighbor || seen.has(neighbor)) continue;
        seen.add(neighbor);
        ordered.push(neighbor);
        if (ordered.length >= MAX_ASSOCIATED_HASHES) break;
        queue.push(neighbor);
      }
    }

    return ordered;
  } catch (error) {
    handleCaughtError(error, '[VideoHash] getAssociatedHashes failed', log);
    return normalizeHashes(hash);
  }
}

module.exports = {
  buildAssociationKey,
  normalizeHashes,
  saveHashMapping,
  saveHashMappings,
  getAssociatedHashes
};
