'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const TheSubtitleDatabaseService = require('./theSubtitleDatabase');

const { getLookupPath, getApiLanguageCodes, mapSubtitle } = TheSubtitleDatabaseService.__testing;

test('TSDB routes cover IMDb movies and episodes plus TMDB movies, series, and episodes', () => {
    assert.equal(getLookupPath({ imdb_id: 'tt0133093', type: 'movie' }), '/v1/by-imdb/tt0133093');
    assert.equal(getLookupPath({ imdb_id: 'tt0944947', type: 'episode', season: 4, episode: 2 }), '/v1/by-imdb/tt0944947/season/4/episode/2');
    assert.equal(getLookupPath({ tmdb_id: '603', tmdbMediaType: 'movie', type: 'movie' }), '/v1/by-tmdb/movie/603');
    assert.equal(getLookupPath({ tmdb_id: '1399', tmdbMediaType: 'tv', type: 'movie' }), '/v1/by-tmdb/tv/1399');
    assert.equal(getLookupPath({ tmdb_id: '1399', tmdbMediaType: 'tv', type: 'episode', season: 4, episode: 2 }), '/v1/by-tmdb/tv/1399/season/4/episode/2');
});

test('TSDB uses documented release-name and title fallbacks without an ID', () => {
    assert.equal(getLookupPath({ filename: 'The.Matrix.1999.1080p.mkv' }), '/v1/by-releasename');
    assert.equal(getLookupPath({ title: 'The Matrix' }), '/v1/by-title');
    assert.equal(getLookupPath({}), null);
});

test('TSDB language query expands documented regional archive codes and respects its 16-code limit', () => {
    assert.deepEqual(getApiLanguageCodes(['chi', 'spa', 'por', 'eng']), [
        'zh', 'zt', 'ze', 'zc', 'es', 'ea', 'sp', 'pt', 'pb', 'pm', 'en'
    ]);
    assert.equal(getApiLanguageCodes(['chi', 'spa', 'por', 'eng', 'fra', 'deu', 'ita', 'jpn', 'kor', 'ara']).length, 16);
});

test('TSDB response language codes normalize to SubMaker language codes', () => {
    const expected = {
        pb: 'pob', zt: 'zht', ea: 'spn', sp: 'spa', pm: 'por', zc: 'yue',
        me: 'mne', at: 'ast', ma: 'mni', sb: 'wen'
    };
    for (const [apiLanguage, languageCode] of Object.entries(expected)) {
        assert.equal(mapSubtitle({ id: 123, language: apiLanguage, format: 'srt' }).languageCode, languageCode);
    }
});
