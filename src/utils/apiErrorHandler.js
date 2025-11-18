/**
 * Centralized API Error Handler
 *
 * Provides graceful error handling for all API services (OpenSubtitles, Gemini, SubDL, etc.)
 * - Detects common error types (429, 503, 401, 403, 404, network errors)
 * - Logs errors concisely without stack traces
 * - Returns user-friendly error information
 */

const log = require('./logger');

/**
 * Parse and classify an API error
 * @param {Error} error - The error object from axios or other API call
 * @param {string} serviceName - Name of the service (e.g., 'OpenSubtitles', 'Gemini')
 * @returns {Object} - Parsed error information
 */
function parseApiError(error, serviceName = 'API') {
  const parsed = {
    serviceName,
    message: error.message || 'Unknown error',
    type: 'unknown',
    statusCode: null,
    isRetryable: false,
    userMessage: null
  };

  // Check for response errors (HTTP errors)
  if (error.response) {
    parsed.statusCode = error.response.status;

    // Rate limiting (429)
    if (parsed.statusCode === 429) {
      parsed.type = 'rate_limit';
      parsed.isRetryable = true;
      parsed.userMessage = 'API rate limit exceeded. Please wait a few minutes and try again.';
    }
    // Service unavailable (503)
    else if (parsed.statusCode === 503) {
      parsed.type = 'service_unavailable';
      parsed.isRetryable = true;
      parsed.userMessage = 'Service temporarily unavailable. Please try again in a few minutes.';
    }
    // OpenSubtitles 469 (Database connection error - custom status code)
    // This is a server-side error that should be retried
    else if (parsed.statusCode === 469) {
      parsed.type = 'database_error';
      parsed.isRetryable = true;
      parsed.userMessage = 'Subtitle server database temporarily unavailable. Trying next subtitle...';
    }
    // Authentication errors (401, 403)
    else if (parsed.statusCode === 401 || parsed.statusCode === 403) {
      parsed.type = 'authentication';
      parsed.isRetryable = false;
      parsed.userMessage = 'Authentication failed. Please check your API credentials.';
    }
    // Not found (404)
    else if (parsed.statusCode === 404) {
      parsed.type = 'not_found';
      parsed.isRetryable = false;
      parsed.userMessage = 'Resource not found. The requested content may have been removed.';
    }
    // Server errors (500-599)
    else if (parsed.statusCode >= 500) {
      parsed.type = 'server_error';
      parsed.isRetryable = true;
      parsed.userMessage = 'Server error. Please try again later.';
    }
    // Client errors (400-499)
    else if (parsed.statusCode >= 400) {
      parsed.type = 'client_error';
      parsed.isRetryable = false;
      parsed.userMessage = 'Invalid request. Please check your configuration.';
    }
  }
  // Network errors (no response)
  else if (error.code) {
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      parsed.type = 'timeout';
      parsed.isRetryable = true;
      parsed.userMessage = 'Request timed out. Please try again.';
    } else if (error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED') {
      parsed.type = 'network';
      parsed.isRetryable = true;
      parsed.userMessage = 'Network connection failed. Please check your internet connection.';
    } else if (error.code === 'ENOTFOUND') {
      parsed.type = 'dns';
      parsed.isRetryable = false;
      parsed.userMessage = 'Cannot reach service. DNS lookup failed.';
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
  const parsed = parseApiError(error, serviceName);

  // Only log once per error to avoid spam
  const logPrefix = `[${serviceName}]`;

  // Log concise error message
  log.error(() => `${logPrefix} ${operation} error: ${parsed.message}`);

  // Log status code only if not already mentioned in the error message
  if (parsed.statusCode && !parsed.message.includes(String(parsed.statusCode))) {
    log.error(() => `${logPrefix} Response status: ${parsed.statusCode}`);
  }

  // Log response data only for specific error types (not for rate limits/503s)
  if (error.response && error.response.data && !options.skipResponseData) {
    // Only log response data for non-retryable errors or when explicitly requested
    if (!parsed.isRetryable || options.logResponseData) {
      try {
        const data = error.response.data;
        if (typeof data === 'string' && data.length > 500) {
          log.error(() => [`${logPrefix} Response data (truncated):`, data.substring(0, 500) + '...']);
        } else if (typeof data === 'object' && data !== null) {
          // Log only essential fields for objects
          const essentialData = {
            message: data.message,
            error: data.error,
            code: data.code,
            status: data.status
          };
          log.error(() => [`${logPrefix} Response data:`, JSON.stringify(essentialData)]);
        } else {
          log.error(() => [`${logPrefix} Response data:`, String(data)]);
        }
      } catch (logError) {
        // If logging the response data fails, log a safe error message
        log.error(() => [`${logPrefix} Unable to parse response data:`, logError.message]);
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
 * @param {Error} error - The error object
 * @param {string} serviceName - Name of the service
 * @param {Object} options - Additional options
 * @returns {Array} - Empty array
 */
function handleSearchError(error, serviceName, options = {}) {
  logApiError(error, serviceName, 'Search', options);
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

  const parsed = parseApiError(error, serviceName);

  // Throw a custom error with user-friendly message
  const customError = new Error(parsed.userMessage || parsed.message);
  customError.originalError = error;
  customError.statusCode = parsed.statusCode;
  customError.type = parsed.type;
  customError.isRetryable = parsed.isRetryable;

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

  const parsed = parseApiError(error, serviceName);

  // Create a custom error with specific properties for translation errors
  const customError = new Error(parsed.userMessage || parsed.message);
  customError.originalError = error;
  customError.statusCode = parsed.statusCode;
  customError.type = parsed.type;
  customError.isRetryable = parsed.isRetryable;

  // Mark error as already logged to prevent duplicate logs in downstream handlers
  customError._alreadyLogged = true;

  // Add translation-specific error flags for all error types
  // These are checked by performTranslation() and used to create user-friendly error messages
  if (parsed.statusCode === 403) {
    customError.translationErrorType = '403';
  } else if (parsed.statusCode === 429) {
    customError.translationErrorType = '429';
  } else if (parsed.statusCode === 503) {
    customError.translationErrorType = '503';
  } else if (error.message && (error.message.includes('MAX_TOKENS') || error.message.includes('exceeded maximum token limit'))) {
    customError.translationErrorType = 'MAX_TOKENS';
  } else if (error.message && (error.message.includes('PROHIBITED_CONTENT') || error.message.includes('RECITATION'))) {
    // PROHIBITED_CONTENT and RECITATION are both safety filter violations
    customError.translationErrorType = 'PROHIBITED_CONTENT';
  } else if (error.message && (error.message.includes('SAFETY') || error.message.includes('safety filters'))) {
    // Generic SAFETY error
    customError.translationErrorType = 'PROHIBITED_CONTENT';
  } else if (error.message && (error.message.includes('invalid') || error.message.includes('corrupted') || error.message.includes('too small'))) {
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
  const parsed = parseApiError(error);
  return parsed.type === 'rate_limit';
}

/**
 * Check if an error is retryable
 * @param {Error} error - The error object
 * @returns {boolean} - True if error is retryable
 */
function isRetryableError(error) {
  const parsed = parseApiError(error);
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
