/**
 * Shared utility for analyzing HTTP response content
 * Helps detect malformed responses across all subtitle providers
 */

const { appendHiddenInformationalNote } = require('./subtitle');

/**
 * Analyze response content to determine what was actually received
 * @param {Buffer} buffer - Response buffer
 * @returns {Object} - { type: string, hint: string, isRetryable: boolean }
 */
function analyzeResponseContent(buffer) {
    if (!buffer || buffer.length === 0) {
        return { type: 'empty', hint: 'Empty response received', isRetryable: true };
    }

    // Check for common file signatures
    const isZip = buffer.length >= 4 &&
        buffer[0] === 0x50 && buffer[1] === 0x4B &&
        buffer[2] === 0x03 && buffer[3] === 0x04;
    if (isZip) return { type: 'zip', hint: 'Valid ZIP file', isRetryable: false };

    // Check for Gzip (compressed content) - 1f 8b
    const isGzip = buffer.length >= 2 && buffer[0] === 0x1F && buffer[1] === 0x8B;
    if (isGzip) return { type: 'gzip', hint: 'Gzip compressed content', isRetryable: false };

    // Try to decode as text
    let textContent;
    try {
        textContent = buffer.toString('utf8', 0, Math.min(1024, buffer.length)).toLowerCase();
    } catch (_) {
        return { type: 'binary', hint: 'Binary content (not text)', isRetryable: false };
    }

    // Check for HTML content (likely error pages)
    if (textContent.includes('<!doctype') || textContent.includes('<html') || textContent.includes('<head')) {
        // Check for specific error types
        if (textContent.includes('cloudflare') || textContent.includes('cf-ray')) {
            return { type: 'html_cloudflare', hint: 'Cloudflare challenge/block page', isRetryable: true };
        }
        if (textContent.includes('captcha') || textContent.includes('recaptcha') || textContent.includes('hcaptcha')) {
            return { type: 'html_captcha', hint: 'CAPTCHA challenge page', isRetryable: true };
        }
        if (textContent.includes('404') || textContent.includes('not found')) {
            return { type: 'html_404', hint: 'HTML 404 Not Found page', isRetryable: false };
        }
        if (textContent.includes('500') || textContent.includes('internal server error')) {
            return { type: 'html_500', hint: 'HTML 500 Server Error page', isRetryable: true };
        }
        if (textContent.includes('503') || textContent.includes('service unavailable')) {
            return { type: 'html_503', hint: 'HTML 503 Service Unavailable page', isRetryable: true };
        }
        if (textContent.includes('429') || textContent.includes('too many requests') || textContent.includes('rate limit')) {
            return { type: 'html_429', hint: 'HTML 429 Rate Limit page', isRetryable: true };
        }
        return { type: 'html_error', hint: 'HTML page instead of subtitle file', isRetryable: true };
    }

    // Check for JSON error responses
    const trimmed = textContent.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            const json = JSON.parse(buffer.toString('utf8', 0, Math.min(2048, buffer.length)));
            if (json.error || json.message || json.status === false) {
                const errorHint = json.error || json.message || 'Unknown error';
                return { type: 'json_error', hint: `JSON error: ${String(errorHint).slice(0, 100)}`, isRetryable: true };
            }
        } catch (_) {
            // Not valid JSON, might be truncated
        }
        return { type: 'json', hint: 'JSON content received', isRetryable: false };
    }

    // Check for plain text error messages
    if (textContent.includes('error') || textContent.includes('denied') || textContent.includes('forbidden')) {
        return { type: 'text_error', hint: 'Text error message received', isRetryable: true };
    }

    // Check if it looks like subtitle content (SRT/VTT)
    if (/^\d+\s*[\r\n]+\d{2}:\d{2}/.test(textContent) || textContent.startsWith('webvtt')) {
        return { type: 'subtitle', hint: 'Direct subtitle content (not ZIP)', isRetryable: false };
    }

    // Very short response
    if (buffer.length < 50) {
        return { type: 'truncated', hint: `Very short response (${buffer.length} bytes)`, isRetryable: true };
    }

    return { type: 'unknown', hint: `Unrecognized content (${buffer.length} bytes)`, isRetryable: false };
}

/**
 * Create an informative SRT subtitle when a provider returns invalid response
 * @param {string} providerName - Name of the provider (e.g., 'SubSource', 'SubDL')
 * @param {string} contentType - Content-Type header from response
 * @param {Object} analysis - Analysis result from analyzeResponseContent
 * @param {number} responseSize - Size of response in bytes
 * @returns {string} - SRT formatted error message
 */
function createInvalidResponseSubtitle(providerName, contentType, analysis, responseSize) {
    const sizeInfo = responseSize ? ` (${responseSize} bytes)` : '';

    let mainMessage = `${providerName} download failed: ${analysis.hint}${sizeInfo}`;
    let suggestion = analysis.isRetryable
        ? 'This may be temporary - try again in a few minutes.'
        : 'Try selecting a different subtitle.';

    // Customize message for specific error types
    switch (analysis.type) {
        case 'html_cloudflare':
            suggestion = 'The provider is blocking requests. Try again later or use a different provider.';
            break;
        case 'html_captcha':
            suggestion = 'The provider requires CAPTCHA verification. Try a different provider.';
            break;
        case 'html_429':
            suggestion = 'Too many requests. Wait a few minutes and try again.';
            break;
        case 'html_503':
        case 'html_500':
            suggestion = 'The provider is having issues. Try again in a few minutes.';
            break;
        case 'html_404':
            suggestion = 'The subtitle may have been removed. Try a different subtitle.';
            break;
        case 'empty':
            suggestion = 'Empty response received. The provider may be down or the subtitle was removed.';
            break;
        case 'truncated':
            suggestion = 'Response was incomplete. Network issues may be affecting the download.';
            break;
        default:
            break;
    }

    const srtContent = `1
00:00:00,000 --> 04:00:00,000
${mainMessage}
${suggestion}`;

    return appendHiddenInformationalNote(srtContent);
}

/**
 * Log and analyze response for debugging
 * @param {string} providerName - Provider name for logging
 * @param {Buffer} buffer - Response buffer
 * @returns {Object} - Analysis result
 */
function logResponseAnalysis(providerName, buffer) {
    const analysis = analyzeResponseContent(buffer);

    // This returns the analysis for use by the caller
    // Actual logging should be done by the caller with their logger instance
    return analysis;
}

module.exports = {
    analyzeResponseContent,
    createInvalidResponseSubtitle,
    logResponseAnalysis
};
