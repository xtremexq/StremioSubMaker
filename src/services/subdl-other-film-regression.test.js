'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const SubDLService = require('./subdl');
const { releaseNamesOtherFilm } = SubDLService.__testing;

const spiritedAway = { imdb_id: 'tt0245429', name: 'Spirited Away', year: 2001 };

test('a release name dated to another film is recognised', () => {
  assert.equal(releaseNamesOtherFilm('Spirited (2022) AC3 5.1 1080p H265 Sp33dy94-MIRCrew.en', spiritedAway), true);
});

test('the film itself, nearby years and undated names are kept', () => {
  assert.equal(releaseNamesOtherFilm('Spirited.Away.2001.1080p.BluRay.X264-AMIABLE-English', spiritedAway), false);
  assert.equal(releaseNamesOtherFilm('Spirited.Away.2002.DVDRip', spiritedAway), false); // release vs premiere year
  assert.equal(releaseNamesOtherFilm('Spirited.Away.1080p.BluRay.x264-YTS', spiritedAway), false);
  assert.equal(releaseNamesOtherFilm('Spirited Away 2001 Remastered 2021 1080p', spiritedAway), false);
  assert.equal(releaseNamesOtherFilm('Spirited.Away.2160p.UHD.BluRay', spiritedAway), false); // 2160p is not a year
});

test("a year in the film's own title is not taken as a release year", () => {
  const br = { name: 'Blade Runner 2049', year: 2017 };
  assert.equal(releaseNamesOtherFilm('Blade.Runner.2049.1080p.BluRay.x264', br), false);
  assert.equal(releaseNamesOtherFilm('Blade.Runner.2049.2017.1080p', br), false);
  assert.equal(releaseNamesOtherFilm('Blade.Runner.1982.Final.Cut.1080p', br), true);
});

test('without a film year nothing is dropped', () => {
  assert.equal(releaseNamesOtherFilm('Spirited (2022)', { name: 'Spirited Away' }), false);
  assert.equal(releaseNamesOtherFilm('', spiritedAway), false);
});

test('searchSubtitles drops the other film for a movie and keeps episodes alone', async () => {
  const service = new SubDLService('test-key');
  const originalGet = service.client.get;
  service.client.get = async () => ({
    data: {
      status: true,
      results: [spiritedAway],
      subtitles: [
        { release_name: 'Spirited.Away.2001.1080p.BluRay.X264-AMIABLE-English', lang: 'english', url: '/subtitle/1-11.zip' },
        { release_name: 'Spirited (2022) AC3 5.1 1080p H265 Sp33dy94-MIRCrew.en', lang: 'english', url: '/subtitle/2-22.zip' }
      ]
    }
  });
  try {
    const results = await service.searchSubtitles({ imdb_id: 'tt0245429', type: 'movie', languages: ['eng'] });
    assert.deepEqual(results.map(r => r.name), ['Spirited.Away.2001.1080p.BluRay.X264-AMIABLE-English']);
  } finally {
    service.client.get = originalGet;
  }
});
