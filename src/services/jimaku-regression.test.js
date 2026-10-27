'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const fs = require('node:fs');
const path = require('node:path');

process.env.STORAGE_TYPE = 'filesystem';
process.env.LOG_LEVEL = 'error';
process.env.ENCRYPTION_KEY ||= '22'.repeat(32);

const JimakuService = require('./jimaku');
const { decodeProviderUrl, encodeProviderUrl } = require('../utils/providerUrlToken');

test('Jimaku searches anime with the raw Authorization key and returns opaque episode file IDs', async () => {
  const service = new JimakuService('  jimaku-test-key  ');
  const originalGet = service.client.get;
  const calls = [];
  service.client.get = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/entries/search') {
      return { data: [{ id: 729, name: 'Sousou no Frieren', flags: { anime: true } }] };
    }
    return {
      data: [
        { name: 'Sousou no Frieren S01E01.srt', url: 'https://jimaku.cc/entry/729/download/1', last_modified: '2025-01-01' },
        { name: 'Sousou no Frieren S01E02.srt', url: 'https://jimaku.cc/entry/729/download/2' }
      ]
    };
  };

  try {
    const results = await service.searchSubtitles({
      animeId: 'anilist:154587',
      animeIdType: 'anilist',
      isAnime: true,
      type: 'anime-episode',
      season: 1,
      episode: 1,
      languages: ['jpn'],
      providerTimeout: 5000
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].options.params, { anilist_id: 154587 });
    assert.equal(calls[1].options.params.episode, 1);
    assert.equal(service.client.defaults.headers.Authorization, 'jimaku-test-key');
    assert.equal(results.length, 1);
    assert.equal(results[0].provider, 'jimaku');
    assert.equal(results[0].languageCode, 'jpn');
    assert.match(results[0].fileId, /^jimaku_e1_/);
    assert.doesNotMatch(results[0].fileId, /https|jimaku\.cc|\/download/);
    const url = decodeProviderUrl(results[0].fileId, 'jimaku_');
    assert.match(url, /^https:\/\/jimaku\.cc\/entry\/729\/download\/1#/);
    assert.match(url, /episode=1/);
  } finally {
    service.client.get = originalGet;
  }
});

test('Jimaku declines non-anime and non-Japanese searches before making requests', async () => {
  const service = new JimakuService('jimaku-test-key');
  let calls = 0;
  const originalGet = service.client.get;
  service.client.get = async () => {
    calls += 1;
    return { data: [] };
  };

  try {
    assert.deepEqual(await service.searchSubtitles({ isAnime: false, type: 'episode', filename: 'Show.S01E01.mkv', languages: ['eng'] }), []);
    assert.deepEqual(await service.searchSubtitles({ isAnime: true, type: 'anime-episode', animeId: 'anilist:154587', languages: ['eng'] }), []);
    assert.equal(calls, 0);
  } finally {
    service.client.get = originalGet;
  }
});

test('Jimaku downloads subtitle bytes without forwarding the API key and converts the SRT', async (t) => {
  const service = new JimakuService('jimaku-test-key');
  const originalGet = axios.get;
  let requestedUrl;
  let requestOptions;
  t.after(() => {
    axios.get = originalGet;
  });
  axios.get = async (url, options) => {
    requestedUrl = url;
    requestOptions = options;
    return {
      status: 200,
      data: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello from Jimaku\n')
    };
  };

  const fileId = encodeProviderUrl('jimaku_', 'https://jimaku.cc/entry/729/download/1.srt');
  const content = await service.downloadSubtitle(fileId, { languageHint: 'jpn' });

  assert.equal(requestedUrl, 'https://jimaku.cc/entry/729/download/1.srt');
  assert.equal(requestOptions.headers.Authorization, undefined);
  assert.match(content, /^WEBVTT/m);
  assert.match(content, /Hello from Jimaku/);
});

test('Jimaku rejects external download hosts', () => {
  const { mapFileEntry } = JimakuService.__testing;
  assert.equal(mapFileEntry({ name: 'S01E01.srt', url: 'https://attacker.example/entry/729/download/1' }, { id: 729 }, { episode: 1 }), null);
});

test('Jimaku is available in Config with a validated, persisted per-user API key', () => {
  const root = path.join(__dirname, '..', '..');
  const html = fs.readFileSync(path.join(root, 'public', 'partials', 'main.html'), 'utf8');
  const configUi = fs.readFileSync(path.join(root, 'public', 'config.js'), 'utf8');

  assert.match(html, /id="enableJimaku"/);
  assert.match(html, /id="jimakuApiKey"/);
  assert.match(html, /href="https:\/\/jimaku\.cc\/account"/);
  assert.match(configUi, /\/api\/validate-jimaku/);
  assert.match(configUi, /subtitleProviders\.jimaku/);
  assert.match(configUi, /jimakuKeyRequired/);
});
