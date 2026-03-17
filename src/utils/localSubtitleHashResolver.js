const { deriveVideoHash } = require('./videoHash');
const streamActivity = require('./streamActivity');
const videoHashAssociations = require('./videoHashAssociations');

function normalizeHash(value) {
  const str = (value || '').toString().trim();
  return str || '';
}

function collectHashCandidates(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .map(normalizeHash)
      .filter(Boolean)
  )];
}

function buildLookupSeedHashes({ videoId, streamFilename, stremioHash, activityEntry }) {
  const normalizedVideoId = (videoId || '').toString().trim();
  const normalizedFilename = (streamFilename || '').toString().trim();
  const filenameDerivedHash = normalizedFilename ? deriveVideoHash(normalizedFilename, normalizedVideoId) : '';
  const fallbackVideoHash = normalizedVideoId ? deriveVideoHash('', normalizedVideoId) : '';
  const associationSeedHashes = collectHashCandidates([
    stremioHash,
    filenameDerivedHash,
    activityEntry?.stremioHash,
    activityEntry?.videoHash
  ]);
  const directHashes = collectHashCandidates([
    ...associationSeedHashes,
    fallbackVideoHash
  ]);

  return {
    filenameDerivedHash,
    fallbackVideoHash,
    // Prefer hashes tied to real stream metadata before the id-only fallback.
    primaryVideoHash: filenameDerivedHash
      || normalizeHash(activityEntry?.videoHash)
      || normalizeHash(stremioHash)
      || normalizeHash(activityEntry?.stremioHash)
      || fallbackVideoHash,
    associationSeedHashes,
    directHashes
  };
}

async function expandHashCandidates(seedHashes, deps = {}) {
  const getAssociatedHashes = deps.getAssociatedHashes || videoHashAssociations.getAssociatedHashes;
  const directHashes = collectHashCandidates(seedHashes);
  if (!directHashes.length) return [];

  const expanded = [];
  for (const hash of directHashes) {
    const associated = await getAssociatedHashes(hash);
    expanded.push(...collectHashCandidates(associated));
  }

  return collectHashCandidates([...directHashes, ...expanded]);
}

async function resolveLocalSubtitleHashes(context = {}, deps = {}) {
  const getRecentStreamActivity = deps.getRecentStreamActivity || streamActivity.getRecentStreamActivity;
  const recentActivity = (context.configHash && context.videoId)
    ? await Promise.resolve(getRecentStreamActivity(context.configHash, context.videoId))
    : null;
  const {
    filenameDerivedHash,
    fallbackVideoHash,
    primaryVideoHash,
    associationSeedHashes,
    directHashes
  } = buildLookupSeedHashes({
    videoId: context.videoId,
    streamFilename: context.streamFilename,
    stremioHash: context.stremioHash,
    activityEntry: recentActivity
  });
  const expandedHashes = await expandHashCandidates(associationSeedHashes, deps);
  const lookupHashes = collectHashCandidates([...directHashes, ...expandedHashes]);

  return {
    primaryVideoHash,
    filenameDerivedHash,
    fallbackVideoHash,
    associationSeedHashes,
    directHashes,
    lookupHashes,
    recentActivity
  };
}

async function persistLocalHashAssociations(context = {}, deps = {}) {
  const getRecentStreamActivity = deps.getRecentStreamActivity || streamActivity.getRecentStreamActivity;
  const saveHashMappings = deps.saveHashMappings || videoHashAssociations.saveHashMappings;
  const deriveHash = deps.deriveVideoHash || deriveVideoHash;

  const recentActivity = context.authoritativeEntry
    || ((context.configHash && context.videoId)
      ? await Promise.resolve(getRecentStreamActivity(context.configHash, context.videoId))
      : null);
  const normalizedVideoId = (context.videoId || '').toString().trim();
  const normalizedFilename = (context.streamFilename || '').toString().trim();
  const filenameDerivedHash = normalizedFilename ? deriveHash(normalizedFilename, normalizedVideoId) : '';
  const hashes = collectHashCandidates([
    context.stremioHash,
    context.derivedVideoHash,
    filenameDerivedHash,
    recentActivity?.stremioHash,
    recentActivity?.videoHash
  ]);

  if (hashes.length < 2) return hashes;
  await saveHashMappings(hashes);
  return hashes;
}

module.exports = {
  collectHashCandidates,
  buildLookupSeedHashes,
  expandHashCandidates,
  resolveLocalSubtitleHashes,
  persistLocalHashAssociations
};
