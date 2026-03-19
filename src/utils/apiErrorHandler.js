/**
 * Centralized API Error Handler
 *
 * Provides graceful error handling for all API services (OpenSubtitles, Gemini, SubDL, etc.)
 * - Detects common error types (429, 503, 401, 403, 404, network errors)
 * - Logs errors concisely without stack traces
 * - Returns user-friendly error information
 */

const log = require('./logger');
const { getTranslator, DEFAULT_LANG } = require('./i18n');

const defaultTranslate = (key, vars, fallback) => fallback || key;

function resolveTranslator(options, error) {
  if (typeof options === 'function') return options;
  const candidate = options?.t || options?.translate;
  if (typeof candidate === 'function') return candidate;
  const lang = options?.lang || options?.uiLanguage || options?.uiLang || error?.uiLanguage || error?.uiLang;
  if (lang) {
    try {
      return getTranslator(lang);
    } catch (_) { /* ignore translator errors */ }
  }
  try {
    return getTranslator(DEFAULT_LANG);
  } catch (_) {
    return defaultTranslate;
  }
}

function buildRateLimitUserMessage(serviceLabel, translate) {
  const normalizedService = String(serviceLabel || '').trim().toLowerCase();
  if (normalizedService === 'gemini') {
    return translate(
      'apiErrors.geminiRateLimit',
      { service: serviceLabel || 'Gemini' },
      'Gemini usage limit reached. Check your API key usage/quota or use another key.'
    );
  }

  return translate(
    'apiErrors.rateLimit',
    { service: serviceLabel },
    `${serviceLabel} rate limit exceeded. Please wait a few minutes and try again.`
  );
}

/**
 * Parse and classify an API error
 * @param {Error} error - The error object from axios or other API call
 * @param {string} serviceName - Name of the service (e.g., 'OpenSubtitles', 'Gemini')
 * @returns {Object} - Parsed error information
 */
function parseApiError(error, serviceName = 'API', options = {}) {
  const parsed = {
    serviceName,
    message: error.message || 'Unknown error',
    type: 'unknown',
    statusCode: null,
    isRetryable: false,
    userMessage: null
  };
  const translate = resolveTranslator(options, error);
  const serviceLabel = serviceName || 'API';

  // IMPORTANT: First check if the error already has pre-classified properties
  // This preserves error metadata from upstream handlers (e.g., loginWithCredentials rate limit errors)
  // Without this, manually-created errors with statusCode/type would be re-classified as 'unknown'
  if (typeof error.statusCode === 'number' && error.statusCode > 0) {
    parsed.statusCode = error.statusCode;
  }
  if (typeof error.type === 'string' && error.type !== 'unknown') {
    parsed.type = error.type;
  }
  if (typeof error.isRetryable === 'boolean') {
    parsed.isRetryable = error.isRetryable;
  }

  // If already classified (e.g., rate_limit from upstream), generate appropriate user message
  if (parsed.type === 'rate_limit') {
    parsed.userMessage = buildRateLimitUserMessage(serviceLabel, translate);
    return parsed;
  }
  if (parsed.type === 'service_unavailable') {
    parsed.userMessage = translate('apiErrors.serviceUnavailable', { service: serviceLabel }, 'Service temporarily unavailable. Please try again in a few minutes.');
    return parsed;
  }

  // Check for response errors (HTTP errors)
  if (error.response) {
    parsed.statusCode = error.response.status;

    // Rate limiting (429)
    if (parsed.statusCode === 429) {
      parsed.type = 'rate_limit';
      parsed.isRetryable = true;
      parsed.userMessage = buildRateLimitUserMessage(serviceLabel, translate);
    }
    // Service unavailable (503)
    else if (parsed.statusCode === 503) {
      parsed.type = 'service_unavailable';
      parsed.isRetryable = true;
      parsed.userMessage = translate('apiErrors.serviceUnavailable', { service: serviceLabel }, 'Service temporarily unavailable. Please try again in a few minutes.');
    }
    // DeepL quota/rate limits (non-standard 456/459)
    else if (String(serviceName || '').toLowerCase() === 'deepl' && (parsed.statusCode === 456 || parsed.statusCode === 459)) {
      parsed.type = 'rate_limit';
      parsed.isRetryable = true;
      parsed.userMessage = buildRateLimitUserMessage(serviceLabel, translate);
    }
    // OpenSubtitles 469 (Database connection error - custom status code)
    // This is a backend error that should be retried
    else if (parsed.statusCode === 469) {
      parsed.type = 'database_error';
      parsed.isRetryable = true;
      parsed.userMessage = translate('apiErrors.databaseUnavailable', {}, 'Subtitle server database temporarily unavailable. Trying next subtitle...');
    }
    // Authentication errors (401, 403)
    else if (parsed.statusCode === 401 || parsed.statusCode === 403) {
      parsed.type = 'authentication';
      parsed.isRetryable = false;
      parsed.userMessage = translate('apiErrors.authFailed', {}, 'Authentication failed. Please check your API credentials.');
    }
    // Not found (404)
    else if (parsed.statusCode === 404) {
      parsed.type = 'not_found';
      parsed.isRetryable = false;
      parsed.userMessage = translate('apiErrors.notFound', {}, 'Resource not found. The requested content may have been removed.');
    }
    // Server errors (500-599)
    else if (parsed.statusCode >= 500) {
      parsed.type = 'server_error';
      parsed.isRetryable = true;
      parsed.userMessage = translate('apiErrors.serverError', { service: serviceLabel }, 'Server error. Please try again later.');
    }
    // OpenSubtitles daily quota exceeded (406 Not Acceptable used for download quota)
    // Matches any plan: free (20), Gold (200), VIP (1000), etc.
    else if (parsed.statusCode === 406 && serviceName === 'OpenSubtitles') {
      const msg = String(error.response?.data?.message || error.message || '').toLowerCase();
      const looksLikeQuota = (msg.includes('allowed') && msg.includes('subtitles')) || (msg.includes('quota') && msg.includes('renew'));
      if (looksLikeQuota) {
        parsed.type = 'quota_exceeded';
        parsed.isRetryable = false;
        parsed.userMessage = translate('apiErrors.opensubsQuota', {}, 'OpenSubtitles daily download limit reached. Try again after the next UTC midnight.');
      } else {
        // Fallback to generic client error if not quota text
        parsed.type = 'client_error';
        parsed.isRetryable = false;
        parsed.userMessage = translate('apiErrors.invalidRequest', {}, 'Invalid request. Please check your configuration.');
      }
    }
    // Client errors (400-499)
    else if (parsed.statusCode >= 400) {
      parsed.type = 'client_error';
      parsed.isRetryable = false;
      parsed.userMessage = translate('apiErrors.invalidRequest', {}, 'Invalid request. Please check your configuration.');
    }
  }
  // Network errors (no response)
  else if (error.code) {
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      parsed.type = 'timeout';
      parsed.isRetryable = true;
      parsed.userMessage = translate('apiErrors.timeout', {}, 'Request timed out. Please try again.');
    } else if (error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED') {
      parsed.type = 'network';
      parsed.isRetryable = true;
      parsed.userMessage = translate('apiErrors.network', {}, 'Network connection failed. Please check your internet connection.');
    } else if (error.code === 'ENOTFOUND') {
      parsed.type = 'dns';
      parsed.isRetryable = false;
      parsed.userMessage = translate('apiErrors.dns', {}, 'Cannot reach service. DNS lookup failed.');
    }
  }

  return parsed;
}

/**
 * Log an API error concisely (without stack traces)
 * @param {Error} error - The error object
 * @param {string} serviceName - Name of the service
 * @param {string} operation - Operation being performed (e.g., 'search', 'download')
 * @param {Object} options - Additional logging options
 */
function logApiError(error, serviceName, operation, options = {}) {
  const parsed = parseApiError(error, serviceName, options);

  // Only log once per error to avoid spam
  const logPrefix = `[${serviceName}]`;

  // Log concise error message (as warn - these are expected operational issues, not code errors)
  log.warn(() => `${logPrefix} ${operation} error: ${parsed.message}`);

  // Log status code only if not already mentioned in the error message
  if (parsed.statusCode && !parsed.message.includes(String(parsed.statusCode))) {
    log.warn(() => `${logPrefix} Response status: ${parsed.statusCode}`);
  }

  // Log response data only for specific error types (not for rate limits/503s)
  if (error.response && error.response.data && !options.skipResponseData) {
    // Only log response data for non-retryable errors or when explicitly requested
    if (!parsed.isRetryable || options.logResponseData) {
      const truncateLimit = (() => {
        if (typeof options.truncateResponseData === 'number' && options.truncateResponseData > 0) {
          return Math.max(50, options.truncateResponseData); // enforce a sensible floor
        }
        return 500; // default limit
      })();

      try {
        const data = error.response.data;
        if (typeof data === 'string') {
          const truncated = data.length > truncateLimit ? data.substring(0, truncateLimit) + '...' : data;
          const suffix = data.length > truncateLimit ? ' (truncated)' : '';
          log.warn(() => [`${logPrefix} Response data${suffix}:`, truncated]);
        } else if (typeof data === 'object' && data !== null) {
          // Log only essential fields for objects
          const essentialData = {
            message: data.message,
            error: data.error,
            code: data.code,
            status: data.status
          };
          const serialized = JSON.stringify(essentialData);
          const truncated = serialized.length > truncateLimit ? serialized.substring(0, truncateLimit) + '...' : serialized;
          const suffix = serialized.length > truncateLimit ? ' (truncated)' : '';
          log.warn(() => [`${logPrefix} Response data${suffix}:`, truncated]);
        } else {
          const stringified = String(data);
          const truncated = stringified.length > truncateLimit ? stringified.substring(0, truncateLimit) + '...' : stringified;
          const suffix = stringified.length > truncateLimit ? ' (truncated)' : '';
          log.warn(() => [`${logPrefix} Response data${suffix}:`, truncated]);
        }
      } catch (logError) {
        // If logging the response data fails, log a safe error message
        log.warn(() => [`${logPrefix} Unable to parse response data:`, logError.message]);
      }
    }
  }

  // Log user-friendly message
  if (parsed.userMessage && !options.skipUserMessage) {
    log.warn(() => `${logPrefix} ${parsed.userMessage}`);
  }
}

/**
 * Handle API error for search operations (returns empty array)
 * For authentication errors with authError flag, rethrows the error so callers can react
 * @param {Error} error - The error object
 * @param {string} serviceName - Name of the service
 * @param {Object} options - Additional options
 * @returns {Array} - Empty array
 * @throws {Error} - Rethrows if error has authError flag set
 */
function handleSearchError(error, serviceName, options = {}) {
  logApiError(error, serviceName, 'Search', options);

  // Rethrow authentication errors so calling code can handle them specially
  // (e.g., to show warning subtitles to users)
  if (error && error.authError === true) {
    throw error;
  }

  return [];
}

/**
 * Handle API error for download operations (throws custom error with user message)
 * @param {Error} error - The error object
 * @param {string} serviceName - Name of the service
 * @param {Object} options - Additional options
 * @throws {Error} - Custom error with user-friendly message
 */
function handleDownloadError(error, serviceName, options = {}) {
  logApiError(error, serviceName, 'Download', options);

  const parsed = parseApiError(error, serviceName, options);

  // Throw a custom error with user-friendly message
  const customError = new Error(parsed.userMessage || parsed.message);
  customError.originalError = error;
  customError.statusCode = parsed.statusCode;
  customError.type = parsed.type;
  customError.isRetryable = parsed.isRetryable;
  // Mark as already logged to avoid duplicate logs in higher layers
  customError._alreadyLogged = true;

  throw customError;
}

/**
 * Handle API error for authentication operations (logs and returns null)
 * @param {Error} error - The error object
 * @param {string} serviceName - Name of the service
 * @param {Object} options - Additional options
 * @returns {null} - Returns null to indicate auth failure
 */
function handleAuthError(error, serviceName, options = {}) {
  logApiError(error, serviceName, 'Authentication', options);
  return null;
}

/**
 * Handle API error for translation operations (throws with specific error type)
 * @param {Error} error - The error object
 * @param {string} serviceName - Name of the service
 * @param {Object} options - Additional options
 * @throws {Error} - Custom error with user-friendly message
 */
function handleTranslationError(error, serviceName, options = {}) {
  logApiError(error, serviceName, 'Translation', { ...options, skipResponseData: true });

  const parsed = parseApiError(error, serviceName, options);

  // Create a custom error with specific properties for translation errors
  const customError = new Error(parsed.userMessage || parsed.message);
  customError.originalError = error;
  customError.statusCode = parsed.statusCode;
  customError.type = parsed.type;
  customError.isRetryable = parsed.isRetryable;
  customError.serviceName = parsed.serviceName || serviceName;

  // Mark error as already logged to prevent duplicate logs in downstream handlers
  customError._alreadyLogged = true;

  // Preserve any explicit classification from upstream
  if (error && error.translationErrorType && !customError.translationErrorType) {
    customError.translationErrorType = error.translationErrorType;
  }

  // Add translation-specific error flags for all error types
  // These are checked by performTranslation() and used to create user-friendly error messages
  if (!customError.translationErrorType && parsed.statusCode === 403) {
    customError.translationErrorType = '403';
  } else if (!customError.translationErrorType && parsed.statusCode === 404) {
    customError.translationErrorType = 'MODEL_NOT_FOUND';
  } else if (!customError.translationErrorType && parsed.statusCode === 429) {
    customError.translationErrorType = '429';
  } else if (!customError.translationErrorType && parsed.statusCode === 503) {
    customError.translationErrorType = '503';
  } else if (!customError.translationErrorType && String(serviceName || '').toLowerCase() === 'deepl' && (parsed.statusCode === 456 || parsed.statusCode === 459)) {
    customError.translationErrorType = '429';
  } else if (!customError.translationErrorType && error.message && (error.message.includes('MAX_TOKENS') || error.message.includes('exceeded maximum token limit'))) {
    customError.translationErrorType = 'MAX_TOKENS';
  } else if (!customError.translationErrorType && error.message && (error.message.includes('PROHIBITED_CONTENT') || error.message.includes('RECITATION'))) {
    // PROHIBITED_CONTENT and RECITATION are both safety filter violations
    customError.translationErrorType = 'PROHIBITED_CONTENT';
  } else if (!customError.translationErrorType && error.message && (error.message.includes('SAFETY') || error.message.includes('safety filters'))) {
    // Generic SAFETY error
    customError.translationErrorType = 'PROHIBITED_CONTENT';
  } else if (!customError.translationErrorType && error.message && (error.message.includes('invalid') || error.message.includes('corrupted') || error.message.includes('too small'))) {
    customError.translationErrorType = 'INVALID_SOURCE';
  }

  throw customError;
}

/**
 * Check if an error is a rate limit error
 * @param {Error} error - The error object
 * @returns {boolean} - True if rate limit error
 */
function isRateLimitError(error) {
  const parsed = parseApiError(error, 'API', {});
  return parsed.type === 'rate_limit';
}

/**
 * Check if an error is retryable
 * @param {Error} error - The error object
 * @returns {boolean} - True if error is retryable
 */
function isRetryableError(error) {
  const parsed = parseApiError(error, 'API', {});
  return parsed.isRetryable;
}

module.exports = {
  parseApiError,
  logApiError,
  handleSearchError,
  handleDownloadError,
  handleAuthError,
  handleTranslationError,
  isRateLimitError,
  isRetryableError
};
