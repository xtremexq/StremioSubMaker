const test = require('node:test');
const assert = require('node:assert/strict');
const { rankSubtitlesByFilename } = require('./subtitles');

test('confirmed hash matches stay first and release metadata ranks candidates within the hash group', () => {
  const streamFilename = 'Two.and.a.Half.Men.S12E10.1080p.WEB-DL.x265-NTb.mkv';
  const ranked = rankSubtitlesByFilename([
    {
      id: 'hash-weak-release',
      hashMatch: true,
      hashMatchPriority: 0,
      filename: 'Wrong.Show.S12E10.720p.HDTV.x264-GROUP.srt',
      downloads: 1000000,
      rating: 10,
      provider: 'test'
    },
    {
      id: 'hash-strong-release',
      hashMatch: true,
      hashMatchPriority: 10,
      filename: 'Two.and.a.Half.Men.S12E10.1080p.WEB-DL.x265-NTb.srt',
      downloads: 1,
      rating: 1,
      provider: 'test'
    },
    {
      id: 'non-hash-perfect-release',
      filename: 'Two.and.a.Half.Men.S12E10.1080p.WEB-DL.x265-NTb.srt',
      downloads: 1000000,
      rating: 10,
      provider: 'test'
    }
  ], streamFilename, { type: 'episode', season: 12, episode: 10 });

  assert.deepEqual(ranked.map(subtitle => subtitle.id), [
    'hash-strong-release',
    'hash-weak-release',
    'non-hash-perfect-release'
  ]);
  assert.equal(ranked.some(subtitle => '_confirmedHashMatch' in subtitle), false);
});

test('release fingerprint outranks a provider recommendation from a hash-aware search', () => {
  const ranked = rankSubtitlesByFilename([
    {
      id: 'provider-recommendation',
      providerBestMatch: true,
      providerBestMatchPriority: 0,
      name: 'Generic English subtitles',
      provider: 'test'
    },
    {
      id: 'release-match',
      filename: 'Two.and.a.Half.Men.S12E10.1080p.WEB-DL.x265-NTb.srt',
      provider: 'other'
    }
  ], 'Two.and.a.Half.Men.S12E10.1080p.WEB-DL.x265-NTb.mkv', { type: 'episode', season: 12, episode: 10 });

  assert.deepEqual(ranked.map(subtitle => subtitle.id), ['release-match', 'provider-recommendation']);
});

test('episode title in the stream filename outranks an alternate-order subtitle with the same S/E number', () => {
  const streamFilename = 'American.Dad.S15E02.Paranoid_Frandroid.1080p.DSNP.WEB-DL.DDP5.1.H.264-playWEB.mkv';
  const ranked = rankSubtitlesByFilename([
    {
      id: 'downtown',
      name: 'American Dad - 15x02 - Downtown.English.srt',
      provider: 'opensubtitles-v3'
    },
    {
      id: 'paranoid',
      name: 'American.Dad.S15E02.Paranoid_Frandroid.1080p.DSNP.WEB-DL.DDP5.1.H.264-playWEB.srt',
      provider: 'opensubtitles-v3'
    }
  ], streamFilename, { type: 'episode', season: 15, episode: 2 });

  assert.deepEqual(ranked.map(subtitle => subtitle.id), ['paranoid', 'downtown']);
});
