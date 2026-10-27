'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const JSZip = require('jszip');

const {
    extractSubtitleFromArchive,
    findSubtitleFile,
    convertSubtitleToVtt
} = require('./archiveExtractor');

test('findSubtitleFile accepts an SRT file with a trailing .txt suffix', () => {
    const result = findSubtitleFile([
        'README.txt',
        'The.Matrix-1999-DVDRip.Xvid.srt.txt'
    ]);

    assert.deepEqual(result, {
        filename: 'The.Matrix-1999-DVDRip.Xvid.srt.txt',
        isSrt: true
    });
});

test('findSubtitleFile still rejects arbitrary text files', () => {
    assert.deepEqual(findSubtitleFile(['README.txt', 'release-notes.txt']), {
        filename: null,
        isSrt: false
    });
});

test('TSDB MPL2 subtitles convert decisecond timings and line breaks to WebVTT', async () => {
    const result = await convertSubtitleToVtt('[10][25]First line|Second line', 'subtitle.mpl', 'TSDB');
    assert.match(result, /^WEBVTT/);
    assert.match(result, /00:00:01\.000 --> 00:00:02\.500/);
    assert.match(result, /First line\nSecond line/);
});

test('TSDB TMP subtitles infer cue end times from the following cue', async () => {
    const result = await convertSubtitleToVtt('0:00:01:First line\ncontinued\n0:00:03:Second line', 'subtitle.tmp', 'TSDB');
    assert.match(result, /^WEBVTT/);
    assert.match(result, /00:00:01\.000 --> 00:00:03\.000/);
    assert.match(result, /First line\ncontinued/);
    assert.match(result, /00:00:03\.000 --> 00:00:07\.000/);
});

test('TSDB USF XML subtitles convert safely, including entities and nested formatting', async () => {
    const result = await convertSubtitleToVtt(
        '<USFSubtitles><subtitles><subtitle start="00:00:01.000" stop="00:00:02.500"><text>Hello &amp; <i>world</i><br/>again &#x1F600;</text></subtitle></subtitles></USFSubtitles>',
        'subtitle.usf',
        'TSDB'
    );
    assert.match(result, /^WEBVTT/);
    assert.match(result, /Hello & <i>world<\/i>\nagain 😀/);

    const rejected = await convertSubtitleToVtt('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><USFSubtitles/>', 'subtitle.usf', 'TSDB');
    assert.match(rejected, /Unsupported subtitle format/i);
});

test('season-pack matching includes SRT files with a trailing .txt suffix', () => {
    const result = findSubtitleFile([
        'Show.S01E01.srt.txt',
        'Show.S01E02.srt.txt'
    ], { isSeasonPack: true, season: 1, episode: 2 });

    assert.deepEqual(result, {
        filename: 'Show.S01E02.srt.txt',
        isSrt: true
    });
});

async function makeZip(files) {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) {
        zip.file(name, content);
    }
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('ordinary ZIP extraction keeps the existing season-pack selection behavior', async () => {
    const buffer = await makeZip({
        'Show.S01E01.srt': '1\n00:00:01,000 --> 00:00:02,000\nEpisode one',
        'Show.S01E02.ass': '[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Episode two'
    });

    const result = await extractSubtitleFromArchive(buffer, {
        providerName: 'Test',
        isSeasonPack: true,
        season: 1,
        episode: 2,
        skipAssConversion: true
    });

    assert.equal(result.format, 'ass');
    assert.match(result.content, /Episode two/);
});

test('RAR extraction requests only the subtitle selected by the existing matcher', async (t) => {
    const unrarPath = require.resolve('node-unrar-js');
    require(unrarPath);
    const unrarModule = require.cache[unrarPath];
    const originalExports = unrarModule.exports;
    let requestedFiles = null;
    t.after(() => {
        unrarModule.exports = originalExports;
    });

    const headers = [
        { name: 'Show.S01E01.srt', flags: { directory: false }, packSize: 20, unpSize: 48 },
        { name: 'Show.S01E02.srt', flags: { directory: false }, packSize: 20, unpSize: 48 }
    ];
    unrarModule.exports = { createExtractorFromData: async () => ({
        getFileList: () => ({ fileHeaders: headers.values() }),
        extract: ({ files }) => {
            requestedFiles = files;
            const selected = headers.find(header => header.name === files[0]);
            return {
                files: [{
                    fileHeader: selected,
                    extraction: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nEpisode two')
                }].values()
            };
        }
    }) };

    const rarSignature = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00, 0x00]);
    const result = await extractSubtitleFromArchive(rarSignature, {
        providerName: 'Test',
        isSeasonPack: true,
        season: 1,
        episode: 2
    });

    assert.deepEqual(requestedFiles, ['Show.S01E02.srt']);
    assert.match(result, /Episode two/);
});

test('ZIP metadata is rejected before expansion when entry limits are exceeded', async () => {
    const buffer = await makeZip({
        'one.srt': 'first',
        'two.srt': 'second'
    });

    const result = await extractSubtitleFromArchive(buffer, {
        providerName: 'Test',
        archiveLimits: { maxEntries: 1 }
    });

    assert.match(result, /too large or complex to process safely/i);
    assert.match(result, /too many files \(2; limit: 1\)/i);
});

test('ZIP metadata enforces per-entry and compression-ratio limits', async () => {
    const buffer = await makeZip({ 'large.srt': 'A'.repeat(4096) });

    const entryResult = await extractSubtitleFromArchive(buffer, {
        providerName: 'Test',
        archiveLimits: { maxEntryBytes: 1024 }
    });
    assert.match(entryResult, /expands beyond the safe processing limit/i);

    const ratioResult = await extractSubtitleFromArchive(buffer, {
        providerName: 'Test',
        archiveLimits: {
            maxCompressionRatio: 2,
            minRatioBytes: 1
        }
    });
    assert.match(ratioResult, /far beyond its compressed size/i);
});

test('Gzip decompression stops at the configured expanded-byte ceiling', async () => {
    const buffer = zlib.gzipSync(Buffer.from('A'.repeat(4096)));
    const result = await extractSubtitleFromArchive(buffer, {
        providerName: 'Test',
        maxBytes: 1024 * 1024,
        archiveLimits: { maxEntryBytes: 1024 }
    });

    assert.match(result, /too large or complex to process safely/i);
});

test('nested compression allows four layers and rejects a fifth', async () => {
    const zip = await makeZip({
        'subtitle.srt': '1\n00:00:01,000 --> 00:00:02,000\nNested subtitle'
    });
    const wrap = (buffer, layers) => {
        let result = buffer;
        for (let i = 0; i < layers; i++) result = zlib.gzipSync(result);
        return result;
    };

    const allowed = await extractSubtitleFromArchive(wrap(zip, 4), {
        providerName: 'Test',
        maxBytes: 1024 * 1024
    });
    assert.match(allowed, /Nested subtitle/);

    const rejected = await extractSubtitleFromArchive(wrap(zip, 5), {
        providerName: 'Test',
        maxBytes: 1024 * 1024
    });
    assert.match(rejected, /too many nested compression layers \(limit: 4\)/i);
});
