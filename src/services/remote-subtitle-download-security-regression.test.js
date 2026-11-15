'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns');
const axios = require('axios');

process.env.STORAGE_TYPE = 'filesystem';
process.env.LOG_LEVEL = 'error';
process.env.ENCRYPTION_KEY ||= '11'.repeat(32);

const OpenSubtitlesV3Service = require('./opensubtitles-v3');
const WyzieSubsService = require('./wyzieSubs');
const {
    MAX_URL_BYTES,
    MAX_PROVIDER_FILE_ID_CHARS,
    encodeProviderUrl,
    decodeProviderUrl
} = require('../utils/providerUrlToken');
const { fileIdSchema } = require('../utils/validation');
const {
    MAX_REMOTE_SUBTITLE_BYTES,
    isSsrfBlockedRequestError
} = require('../utils/publicRemoteRequest');

async function withEnv(name, value, callback) {
    const original = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;

    try {
        return await callback();
    } finally {
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
    }
}

function legacyId(prefix, url) {
    return `${prefix}${Buffer.from(url, 'utf8').toString('base64url')}`;
}

function invokeLookup(lookup, hostname) {
    return new Promise((resolve, reject) => {
        lookup(hostname, { all: true }, (error, addresses) => {
            if (error) return reject(error);
            return resolve(addresses);
        });
    });
}

test('provider URL IDs are opaque, provider-bound, and tamper-evident', () => {
    const url = 'https://8.8.8.8/subtitles/example.srt?token=visible-in-old-ids';
    const id = encodeProviderUrl('v3_', url);

    assert.match(id, /^v3_e1_[A-Za-z0-9_-]+$/);
    assert.doesNotMatch(id, /token|visible|aHR0cHM/);
    assert.equal(decodeProviderUrl(id, 'v3_'), url);
    assert.throws(
        () => decodeProviderUrl(id.replace(/^v3_/, 'wyzie_'), 'wyzie_'),
        error => error?.code === 'EINVALID_PROVIDER_URL_TOKEN'
    );

    const tokenStart = id.indexOf('e1_') + 3;
    const tamperedIndex = tokenStart + Math.floor((id.length - tokenStart) / 2);
    const replacement = id[tamperedIndex] === 'A' ? 'B' : 'A';
    const tampered = `${id.slice(0, tamperedIndex)}${replacement}${id.slice(tamperedIndex + 1)}`;
    assert.throws(
        () => decodeProviderUrl(tampered, 'v3_'),
        error => error?.code === 'EINVALID_PROVIDER_URL_TOKEN'
    );
});

test('redirect-library wrappers retain non-retryable SSRF classification', () => {
    assert.equal(isSsrfBlockedRequestError({
        code: 'ERR_FR_REDIRECTION_FAILURE',
        message: 'Redirected request failed: [SSRF] Destination 169.254.169.254 is internal or non-global'
    }), true);
    assert.equal(isSsrfBlockedRequestError({
        code: 'ECONNRESET',
        message: 'socket closed during an ordinary public request'
    }), false);
});

test('route validation accepts the longest bounded dynamic-CDN token', () => {
    const fixedUrlBytes = Buffer.byteLength('https://cdn.example.test/');
    const url = `https://cdn.example.test/${'a'.repeat(MAX_URL_BYTES - fixedUrlBytes)}`;
    assert.equal(Buffer.byteLength(url), MAX_URL_BYTES);

    const fileId = encodeProviderUrl('wyzie_', url);
    assert.ok(fileId.length <= MAX_PROVIDER_FILE_ID_CHARS);
    assert.equal(fileIdSchema.validate(fileId).error, undefined);
    assert.equal(decodeProviderUrl(fileId, 'wyzie_'), url);
    assert.ok(fileIdSchema.validate('a'.repeat(MAX_PROVIDER_FILE_ID_CHARS + 1)).error);
});

test('OpenSubtitles V3 search emits opaque IDs while retaining dynamic public CDN hosts', async () => {
    const service = new OpenSubtitlesV3Service();
    const originalGet = service.client.get;
    service.client.get = async () => ({
        data: {
            subtitles: [{
                id: 'example',
                lang: 'en',
                url: 'https://8.8.8.8/dynamic-cdn/example.srt'
            }]
        }
    });

    try {
        const results = await service.searchSubtitles({
            imdb_id: 'tt0133093',
            type: 'movie',
            languages: ['eng']
        });
        assert.equal(results.length, 1);
        assert.match(results[0].fileId, /^v3_e1_/);
        assert.equal(decodeProviderUrl(results[0].fileId, 'v3_'), results[0].downloadLink);
    } finally {
        service.client.get = originalGet;
    }
});

test('OpenSubtitles V3 filters contradictory episode metadata and preserves release titles', async () => {
    const service = new OpenSubtitlesV3Service();
    const originalGet = service.client.get;
    service.client.get = async () => ({
        data: {
            subtitles: [
                {
                    id: 'wrong-season-label',
                    lang: 'eng',
                    url: 'https://8.8.8.8/dynamic-cdn/wrong-season.srt',
                    subtitleFileName: 'American.Dad.S16E02.HDTV.x264-SVA.srt',
                    movieReleaseName: 'American.Dad.S16E02.HDTV.x264-SVA',
                    season: 15,
                    episode: 2
                },
                {
                    id: 'wrong-episode-number',
                    lang: 'eng',
                    url: 'https://8.8.8.8/dynamic-cdn/wrong-episode.srt',
                    subtitleFileName: 'American.Dad.S15E03.The.Census.of.the.Lambs.srt',
                    movieReleaseName: 'American.Dad.S15E03.The.Census.of.the.Lambs',
                    season: 15,
                    episode: 3
                },
                {
                    id: 'downtown',
                    lang: 'eng',
                    url: 'https://8.8.8.8/dynamic-cdn/downtown.srt',
                    subtitleFileName: 'American.Dad.S15E02.Downtown.srt',
                    movieReleaseName: 'American.Dad.S15E02.Downtown',
                    season: 15,
                    episode: 2
                },
                {
                    id: 'paranoid',
                    lang: 'eng',
                    url: 'https://8.8.8.8/dynamic-cdn/paranoid.srt',
                    subtitleFileName: 'American.Dad.S15E02.Paranoid_Frandroid.srt',
                    movieReleaseName: 'American.Dad.S15E02.Paranoid_Frandroid',
                    season: 15,
                    episode: 2
                }
            ]
        }
    });

    try {
        const results = await service.searchSubtitles({
            imdb_id: 'tt0397306',
            type: 'episode',
            season: 15,
            episode: 2,
            languages: ['eng']
        });
        assert.equal(results.length, 2);
        assert.ok(results.every(result => /American\.Dad\.S15E02\./i.test(result.originalFilename)));
        const paranoid = results.find(result => result.originalFilename?.includes('Paranoid_Frandroid'));
        assert.ok(paranoid);
        assert.match(paranoid.name, /Paranoid_Frandroid/i);
        assert.equal(paranoid.season, 15);
        assert.equal(paranoid.episode, 2);
    } finally {
        service.client.get = originalGet;
    }
});

test('unsigned legacy provider URL IDs are rejected by default before Axios dispatch', async () => {
    await withEnv('ALLOW_LEGACY_UNSIGNED_SUBTITLE_URL_IDS', undefined, async () => {
        let v3Reached = false;
        const v3 = new OpenSubtitlesV3Service();
        const originalV3Get = v3.client.get;
        v3.client.get = async () => {
            v3Reached = true;
            return { data: Buffer.from('unexpected') };
        };

        const originalAxiosGet = axios.get;
        let wyzieReached = false;
        axios.get = async () => {
            wyzieReached = true;
            return { data: Buffer.from('unexpected') };
        };

        try {
            await assert.rejects(
                v3.downloadSubtitle(legacyId('v3_', 'http://169.254.169.254/latest/meta-data/'), { maxRetries: 1 }),
                error => error?.code === 'EUNSIGNED_PROVIDER_URL_ID'
            );
            await assert.rejects(
                new WyzieSubsService('test-key').downloadSubtitle(
                    legacyId('wyzie_', 'https://127.0.0.1/internal'),
                    { maxRetries: 1 }
                ),
                error => error?.code === 'EUNSIGNED_PROVIDER_URL_ID'
            );
            assert.equal(v3Reached, false);
            assert.equal(wyzieReached, false);
        } finally {
            v3.client.get = originalV3Get;
            axios.get = originalAxiosGet;
        }
    });
});

test('legacy compatibility mode still cannot reach metadata, loopback, or internal HTTPS', async () => {
    await withEnv('ALLOW_LEGACY_UNSIGNED_SUBTITLE_URL_IDS', 'true', async () => {
        await withEnv('ALLOW_INTERNAL_CUSTOM_ENDPOINTS', 'true', async () => {
            const v3 = new OpenSubtitlesV3Service();
            let v3Reached = false;
            const originalV3Get = v3.client.get;
            v3.client.get = async () => {
                v3Reached = true;
                return { data: Buffer.from('unexpected') };
            };

            const originalAxiosGet = axios.get;
            let wyzieReached = false;
            axios.get = async () => {
                wyzieReached = true;
                return { data: Buffer.from('unexpected') };
            };

            try {
                await assert.rejects(
                    v3.downloadSubtitle(legacyId('v3_', 'http://169.254.169.254/latest/meta-data/'), { maxRetries: 1 }),
                    error => error?.code === 'ESSRF_INTERNAL_IP'
                );
                await assert.rejects(
                    new WyzieSubsService('test-key').downloadSubtitle(
                        legacyId('wyzie_', 'https://[::ffff:7f00:1]/internal'),
                        { maxRetries: 1 }
                    ),
                    error => error?.code === 'ESSRF_INTERNAL_IP'
                );
                assert.equal(v3Reached, false);
                assert.equal(wyzieReached, false);
            } finally {
                v3.client.get = originalV3Get;
                axios.get = originalAxiosGet;
            }
        });
    });
});

test('OpenSubtitles V3 downloads enforce redirect, connection-time DNS, proxy, and size guards', async () => {
    const url = 'http://8.8.8.8/dynamic-cdn/example.srt';
    const fileId = encodeProviderUrl('v3_', url);
    const service = new OpenSubtitlesV3Service();
    const originalGet = service.client.get;
    let request;
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nHello\n';
    service.client.get = async (requestedUrl, options) => {
        request = { requestedUrl, options };
        return { data: Buffer.from(srt) };
    };

    try {
        assert.equal(await service.downloadSubtitle(fileId, { maxRetries: 1 }), srt);
        assert.equal(request.requestedUrl, url);
        assert.equal(request.options.proxy, false);
        assert.equal(request.options.maxContentLength, MAX_REMOTE_SUBTITLE_BYTES);
        assert.equal(request.options.responseType, 'arraybuffer');
        assert.equal(typeof request.options.lookup, 'function');
        assert.equal(typeof request.options.beforeRedirect, 'function');
        assert.throws(
            () => request.options.beforeRedirect({ href: 'http://169.254.169.254/latest/meta-data/' }),
            error => error?.code === 'ESSRF_INTERNAL_IP'
        );

        const originalLookup = dns.lookup;
        dns.lookup = (_hostname, _options, callback) => callback(null, [
            { address: '8.8.8.8', family: 4 },
            { address: '169.254.169.254', family: 4 }
        ]);
        try {
            await assert.rejects(
                invokeLookup(request.options.lookup, 'rotating-cdn.example'),
                error => error?.code === 'ESSRF_INTERNAL_IP'
            );
        } finally {
            dns.lookup = originalLookup;
        }
    } finally {
        service.client.get = originalGet;
    }
});

test('Wyzie keeps arbitrary HTTPS CDN hosts but applies the same public-network and size policy', async () => {
    const url = 'https://1.1.1.1/current-provider/example.srt';
    const fileId = encodeProviderUrl('wyzie_', url);
    const originalGet = axios.get;
    let request;
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nHello\n';
    axios.get = async (requestedUrl, options) => {
        request = { requestedUrl, options };
        return { data: Buffer.from(srt) };
    };

    try {
        const result = await new WyzieSubsService('test-key').downloadSubtitle(fileId, { maxRetries: 1 });
        assert.equal(result, srt);
        assert.equal(request.requestedUrl, url);
        assert.equal(request.options.proxy, false);
        assert.equal(request.options.maxContentLength, MAX_REMOTE_SUBTITLE_BYTES);
        assert.equal(request.options.responseType, 'arraybuffer');
        assert.throws(
            () => request.options.beforeRedirect({ href: 'https://10.0.0.1/private' }),
            error => error?.code === 'ESSRF_INTERNAL_IP'
        );
        assert.throws(
            () => request.options.beforeRedirect({ href: 'http://8.8.8.8/downgrade' }),
            /Protocol http: is not allowed/
        );
    } finally {
        axios.get = originalGet;
    }
});

test('OpenSubtitles V3 aborts oversized responses through Axios streamed byte limits', async () => {
    const service = new OpenSubtitlesV3Service();
    const originalGet = service.client.get;
    service.client.get = async (_url, options) => {
        assert.equal(options.maxContentLength, MAX_REMOTE_SUBTITLE_BYTES);
        const error = new Error(`maxContentLength size of ${MAX_REMOTE_SUBTITLE_BYTES} exceeded`);
        error.code = 'ERR_BAD_RESPONSE';
        throw error;
    };

    try {
        const result = await service.downloadSubtitle(
            encodeProviderUrl('v3_', 'https://8.8.8.8/too-large.zip'),
            { maxRetries: 1 }
        );
        assert.match(result, /Subtitle pack is too large to process/);
    } finally {
        service.client.get = originalGet;
    }
});

test('Wyzie aborts oversized responses through the same streamed byte limit', async () => {
    const originalGet = axios.get;
    axios.get = async (_url, options) => {
        assert.equal(options.maxContentLength, MAX_REMOTE_SUBTITLE_BYTES);
        const error = new Error(`maxContentLength size of ${MAX_REMOTE_SUBTITLE_BYTES} exceeded`);
        error.code = 'ERR_BAD_RESPONSE';
        throw error;
    };

    try {
        const result = await new WyzieSubsService('test-key').downloadSubtitle(
            encodeProviderUrl('wyzie_', 'https://1.1.1.1/too-large.srt'),
            { maxRetries: 1 }
        );
        assert.match(result, /Subtitle pack is too large to process/);
    } finally {
        axios.get = originalGet;
    }
});
