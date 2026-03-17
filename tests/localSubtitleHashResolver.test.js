const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_TO_FILE = 'false';

const { deriveVideoHash } = require('../src/utils/videoHash');
const streamActivity = require('../src/utils/streamActivity');
const {
  resolveLocalSubtitleHashes,
  persistLocalHashAssociations
} = require('../src/utils/localSubtitleHashResolver');

function uniqueConfigHash(label) {
  return `${label}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

test('resolveLocalSubtitleHashes prefers remembered authoritative hashes over id-only fallback', async () => {
  const videoId = 'series:show:season1:episode1';
  const fallbackHash = deriveVideoHash('', videoId);
  const recentActivity = {
    videoHash: 'authoritativeHash',
    stremioHash: 'stremioHash'
  };

  const result = await resolveLocalSubtitleHashes(
    {
      configHash: 'cfg-resolve-hashes',
      videoId,
      streamFilename: '',
      stremioHash: 'stremioHash'
    },
    {
      getRecentStreamActivity: () => recentActivity,
      getAssociatedHashes: async (hash) => ({
        stremioHash: ['stremioHash', 'mappedFromStremio'],
        authoritativeHash: ['authoritativeHash', 'authoritativeAlias']
      }[hash] || [hash])
    }
  );

  assert.equal(result.primaryVideoHash, 'authoritativeHash');
  assert.deepEqual(result.associationSeedHashes, ['stremioHash', 'authoritativeHash']);
  assert.deepEqual(result.directHashes, ['stremioHash', 'authoritativeHash', fallbackHash]);
  assert.deepEqual(
    result.lookupHashes,
    ['stremioHash', 'authoritativeHash', fallbackHash, 'mappedFromStremio', 'authoritativeAlias']
  );
  assert.equal(result.recentActivity, recentActivity);
});

test('resolveLocalSubtitleHashes recovers remembered hash after switch-away weak return', async () => {
  const configHash = uniqueConfigHash('resolver-switch-return');
  const videoId = 'video-a';
  const fallbackHash = deriveVideoHash('', videoId);

  streamActivity.recordStreamActivity({
    configHash,
    videoId,
    filename: 'Show.S01E01.1080p.mkv',
    videoHash: 'hash-video-a',
    stremioHash: 'stremio-video-a'
  });
  streamActivity.recordStreamActivity({
    configHash,
    videoId: 'video-b',
    filename: 'Show.S01E02.1080p.mkv',
    videoHash: 'hash-video-b',
    stremioHash: 'stremio-video-b'
  });
  streamActivity.recordStreamActivity({
    configHash,
    videoId,
    filename: '',
    videoHash: '',
    stremioHash: ''
  });

  const result = await resolveLocalSubtitleHashes(
    {
      configHash,
      videoId,
      streamFilename: '',
      stremioHash: ''
    },
    {
      getAssociatedHashes: async (hash) => [hash]
    }
  );

  assert.equal(result.primaryVideoHash, 'hash-video-a');
  assert.equal(result.recentActivity?.filename, 'Show.S01E01.1080p.mkv');
  assert.deepEqual(result.associationSeedHashes, ['stremio-video-a', 'hash-video-a']);
  assert.deepEqual(result.directHashes, ['stremio-video-a', 'hash-video-a', fallbackHash]);
});

test('resolveLocalSubtitleHashes keeps both current and remembered hashes when filename drifts', async () => {
  const videoId = 'series:show:season1:episode2';
  const currentFilenameHash = deriveVideoHash('Show.S01E02.REPACK.mkv', videoId);
  const fallbackHash = deriveVideoHash('', videoId);

  const result = await resolveLocalSubtitleHashes(
    {
      configHash: 'cfg-drift-hashes',
      videoId,
      streamFilename: 'Show.S01E02.REPACK.mkv',
      stremioHash: ''
    },
    {
      getRecentStreamActivity: () => ({
        filename: 'Show.S01E02.1080p.mkv',
        videoHash: 'authoritativeHash'
      }),
      getAssociatedHashes: async (hash) => [hash]
    }
  );

  assert.equal(result.primaryVideoHash, currentFilenameHash);
  assert.deepEqual(result.associationSeedHashes, [currentFilenameHash, 'authoritativeHash']);
  assert.deepEqual(result.directHashes, [currentFilenameHash, 'authoritativeHash', fallbackHash]);
});

test('persistLocalHashAssociations links only strong request and remembered hashes', async () => {
  const savedHashes = [];

  const result = await persistLocalHashAssociations(
    {
      configHash: 'cfg-save-hashes',
      videoId: 'series:movie:1',
      streamFilename: 'Example.Movie.1080p.mkv',
      derivedVideoHash: 'incomingDerivedHash',
      stremioHash: 'realStreamHash'
    },
    {
      deriveVideoHash: (filename) => (filename ? 'filenameDerivedHash' : 'fallbackVideoHash'),
      getRecentStreamActivity: () => ({
        videoHash: 'authoritativeHash',
        stremioHash: 'recentStremioHash'
      }),
      saveHashMappings: async (hashes) => {
        savedHashes.push([...hashes]);
        return hashes;
      }
    }
  );

  assert.deepEqual(
    result,
    ['realStreamHash', 'incomingDerivedHash', 'filenameDerivedHash', 'recentStremioHash', 'authoritativeHash']
  );
  assert.deepEqual(savedHashes, [result]);
});
