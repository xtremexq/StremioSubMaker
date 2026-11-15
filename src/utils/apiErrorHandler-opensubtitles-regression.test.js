'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    getApiErrorMessage,
    isResponseTooLargeError,
    isOpenSubtitlesQuotaError,
    parseApiError,
    handleDownloadError,
    handleTranslationError
} = require('./apiErrorHandler');
const OpenSubtitlesService = require('../services/opensubtitles');
const { handleSubtitleDownload } = require('../handlers/subtitles');

function upstream406(message) {
    const error = new Error(message);
    error.response = { status: 406, data: { message }, headers: {} };
    return error;
}

test('does not classify a generic OpenSubtitles 406 as exhausted quota', () => {
    const error = upstream406('The requested file ID is not available');
    assert.equal(isOpenSubtitlesQuotaError(error), false);
    assert.equal(parseApiError(error, 'OpenSubtitles').type, 'client_error');
});

test('oversized buffered responses receive a non-retryable user-facing classification', () => {
    const error = new Error('maxContentLength size of 67108864 exceeded');
    error.code = 'ERR_BAD_RESPONSE';

    assert.equal(isResponseTooLargeError(error), true);
    const parsed = parseApiError(error, 'Custom');
    assert.equal(parsed.type, 'response_too_large');
    assert.equal(parsed.isRetryable, false);
    assert.match(parsed.userMessage, /more data than SubMaker can process safely/i);

    assert.throws(
        () => handleTranslationError(error, 'Custom'),
        wrapped => wrapped.translationErrorType === 'RESPONSE_TOO_LARGE'
            && /more data than SubMaker can process safely/i.test(wrapped.message)
    );
});

test('Gemini model-capacity 503s tell file-translation users to retry or switch models', () => {
    const error = new Error('Request failed with status code 503');
    error.response = {
        status: 503,
        data: {
            error: {
                status: 'UNAVAILABLE',
                message: 'This model is currently experiencing high demand. Please try again later.'
            }
        }
    };

    const parsed = parseApiError(error, 'Gemini', { lang: 'en' });
    assert.equal(parsed.type, 'service_unavailable');
    assert.equal(parsed.isRetryable, true);
    assert.match(parsed.userMessage, /selected Gemini model is temporarily overloaded/i);
    assert.match(parsed.userMessage, /try again shortly or select another Gemini model/i);

    assert.throws(
        () => handleTranslationError(error, 'Gemini', { lang: 'en' }),
        wrapped => wrapped.statusCode === 503
            && wrapped.translationErrorType === '503'
            && /temporarily overloaded/i.test(wrapped.message)
    );
});

test('generic Gemini 503s keep the standard service-unavailable message', () => {
    const error = new Error('Request failed with status code 503');
    error.response = { status: 503, data: { error: { status: 'UNAVAILABLE', message: 'Service unavailable.' } } };

    const parsed = parseApiError(error, 'Gemini', { lang: 'en' });
    assert.equal(parsed.type, 'service_unavailable');
    assert.match(parsed.userMessage, /Gemini temporarily unavailable/i);
});

test('preserves the upstream 406 message through the download error wrapper', () => {
    const error = upstream406('The requested file ID is not available');
    let wrapped;
    try {
        handleDownloadError(error, 'OpenSubtitles');
    } catch (caught) {
        wrapped = caught;
    }

    assert.ok(wrapped);
    assert.equal(wrapped.statusCode, 406);
    assert.equal(wrapped.type, 'client_error');
    assert.equal(getApiErrorMessage(wrapped), 'The requested file ID is not available');
    assert.equal(isOpenSubtitlesQuotaError(wrapped), false);
});

test('still recognizes real OpenSubtitles quota responses, including wrapped errors', () => {
    const message = 'You have downloaded the allowed 200 subtitles in the last 24h. Your quota will be renewed later.';
    const error = upstream406(message);
    assert.equal(isOpenSubtitlesQuotaError(error), true);
    assert.equal(parseApiError(error, 'OpenSubtitles').type, 'quota_exceeded');

    let wrapped;
    try {
        handleDownloadError(error, 'OpenSubtitles');
    } catch (caught) {
        wrapped = caught;
    }
    assert.equal(wrapped.type, 'quota_exceeded');
    assert.equal(isOpenSubtitlesQuotaError(wrapped), true);
});

test('download handler only renders the quota subtitle for a real quota response', async (t) => {
    const originalDownload = OpenSubtitlesService.prototype.downloadSubtitle;
    t.after(() => {
        OpenSubtitlesService.prototype.downloadSubtitle = originalDownload;
    });

    OpenSubtitlesService.prototype.downloadSubtitle = async function (fileId) {
        const message = fileId === 'real-quota'
            ? 'You have downloaded the allowed 1000 subtitles in the last 24h. Your quota will be renewed later.'
            : 'The requested file ID is not available';
        handleDownloadError(upstream406(message), 'OpenSubtitles');
    };

    const config = {
        __configHash: 'quota-classification-test',
        uiLanguage: 'en',
        convertAssToVtt: true,
        forceSRTOutput: false,
        subtitleProviders: {
            opensubtitles: {
                enabled: true,
                implementationType: 'auth',
                username: 'user',
                password: 'pass'
            }
        }
    };

    const rejectedFile = await handleSubtitleDownload('invalid-file', 'eng', config);
    assert.doesNotMatch(rejectedFile, /daily download limit reached/i);
    assert.match(rejectedFile, /download failed/i);

    const actualQuota = await handleSubtitleDownload('real-quota', 'eng', config);
    assert.match(actualQuota, /daily download limit reached/i);
    assert.match(actualQuota, /allowed 1000 subtitles/i);
});
