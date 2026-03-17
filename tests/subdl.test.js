const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_TO_FILE = 'false';
process.env.LOG_LEVEL = 'error';

const SubDLService = require('../src/services/subdl');

function buildSubtitle(overrides = {}) {
  return {
    url: '/subtitle/100-200.zip',
    lang: 'English',
    release_name: 'Sample release',
    rating: '0',
    download_count: '0',
    episode: 2,
    episode_from: 2,
    episode_end: 2,
    ...overrides
  };
}

test('SubDL search filters out explicit multi-episode packs that miss the requested episode', async () => {
  const service = new SubDLService('test-key');

  service.client = {
    get: async () => ({
      data: {
        status: true,
        subtitles: [
          buildSubtitle({
            url: '/subtitle/111-111.zip',
            release_name: 'Requested single episode',
            episode: 2,
            episode_from: 2,
            episode_end: 2
          }),
          buildSubtitle({
            url: '/subtitle/222-222.zip',
            release_name: 'Out-of-range multi-pack',
            episode: 5,
            episode_from: 5,
            episode_end: 7
          }),
          buildSubtitle({
            url: '/subtitle/333-333.zip',
            release_name: 'In-range multi-pack',
            episode: 1,
            episode_from: 1,
            episode_end: 3
          }),
          buildSubtitle({
            url: '/subtitle/444-444.zip',
            release_name: 'Full season pack',
            episode: null,
            episode_from: null,
            episode_end: 0
          }),
          buildSubtitle({
            url: '/subtitle/555-555.zip',
            release_name: 'Wrong single episode',
            episode: 9,
            episode_from: 9,
            episode_end: 9
          })
        ]
      }
    })
  };

  const results = await service.searchSubtitles({
    imdb_id: 'tt1234567',
    type: 'episode',
    season: 1,
    episode: 2,
    languages: ['eng']
  });

  const names = results.map(result => result.name);

  assert.deepEqual(names, [
    'Requested single episode',
    'In-range multi-pack',
    'Full season pack'
  ]);
});
