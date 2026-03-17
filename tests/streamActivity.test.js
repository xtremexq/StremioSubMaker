const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_TO_FILE = 'false';

const streamActivity = require('../src/utils/streamActivity');

function uniqueConfigHash(label) {
  return `${label}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

test('getRecentStreamActivity keeps prior stream details after switching away', () => {
  const configHash = uniqueConfigHash('recent-switch');

  streamActivity.recordStreamActivity({
    configHash,
    videoId: 'video-a',
    filename: 'Show.S01E01.1080p.mkv',
    videoHash: 'hash-video-a'
  });
  streamActivity.recordStreamActivity({
    configHash,
    videoId: 'video-b',
    filename: 'Show.S01E02.1080p.mkv',
    videoHash: 'hash-video-b'
  });

  const latest = streamActivity.getLatestStreamActivity(configHash);
  const recentA = streamActivity.getRecentStreamActivity(configHash, 'video-a');

  assert.equal(latest.videoId, 'video-b');
  assert.equal(recentA.videoId, 'video-a');
  assert.equal(recentA.filename, 'Show.S01E01.1080p.mkv');
  assert.equal(recentA.videoHash, 'hash-video-a');
});

test('getRecentStreamActivity preserves authoritative details on weak return after switching away', () => {
  const configHash = uniqueConfigHash('recent-switch-return-weak');

  streamActivity.recordStreamActivity({
    configHash,
    videoId: 'video-a',
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
    videoId: 'video-a',
    filename: '',
    videoHash: '',
    stremioHash: ''
  });

  const latest = streamActivity.getLatestStreamActivity(configHash);
  const recentA = streamActivity.getRecentStreamActivity(configHash, 'video-a');

  assert.equal(latest.videoId, 'video-a');
  assert.equal(latest.filename, 'Show.S01E01.1080p.mkv');
  assert.equal(latest.videoHash, 'hash-video-a');
  assert.equal(latest.stremioHash, 'stremio-video-a');
  assert.equal(recentA.filename, 'Show.S01E01.1080p.mkv');
  assert.equal(recentA.videoHash, 'hash-video-a');
  assert.equal(recentA.stremioHash, 'stremio-video-a');
});

test('getRecentStreamActivity preserves authoritative details on drifted-filename return after switching away', () => {
  const configHash = uniqueConfigHash('recent-switch-return-drift');

  streamActivity.recordStreamActivity({
    configHash,
    videoId: 'video-a',
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
    videoId: 'video-a',
    filename: 'Show.S01E01.REPACK.mkv',
    videoHash: 'drifted-hash',
    stremioHash: ''
  });

  const latest = streamActivity.getLatestStreamActivity(configHash);
  const recentA = streamActivity.getRecentStreamActivity(configHash, 'video-a');

  assert.equal(latest.videoId, 'video-a');
  assert.equal(latest.filename, 'Show.S01E01.1080p.mkv');
  assert.equal(latest.videoHash, 'hash-video-a');
  assert.equal(latest.stremioHash, 'stremio-video-a');
  assert.equal(recentA.filename, 'Show.S01E01.1080p.mkv');
  assert.equal(recentA.videoHash, 'hash-video-a');
  assert.equal(recentA.stremioHash, 'stremio-video-a');
});

test('recordStreamActivity preserves the authoritative hash when same video metadata weakens or drifts', () => {
  const configHash = uniqueConfigHash('recent-drift');

  streamActivity.recordStreamActivity({
    configHash,
    videoId: 'video-c',
    filename: 'Show.S01E03.1080p.mkv',
    videoHash: 'authoritative-hash',
    stremioHash: 'opensubtitles-hash'
  });
  streamActivity.recordStreamActivity({
    configHash,
    videoId: 'video-c',
    filename: '',
    videoHash: '',
    stremioHash: ''
  });
  streamActivity.recordStreamActivity({
    configHash,
    videoId: 'video-c',
    filename: 'Show.S01E03.REPACK.mkv',
    videoHash: 'drifted-hash',
    stremioHash: ''
  });

  const latest = streamActivity.getLatestStreamActivity(configHash);
  const recent = streamActivity.getRecentStreamActivity(configHash, 'video-c');

  assert.equal(latest.filename, 'Show.S01E03.1080p.mkv');
  assert.equal(latest.videoHash, 'authoritative-hash');
  assert.equal(latest.stremioHash, 'opensubtitles-hash');
  assert.equal(recent.filename, 'Show.S01E03.1080p.mkv');
  assert.equal(recent.videoHash, 'authoritative-hash');
});
