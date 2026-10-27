/**
 * Security utility functions for sanitizing and redacting sensitive data
 * Prevents exposure of session tokens, API keys, and other credentials in logs
 */

const crypto = require('crypto');

/**
 * Redact a session token for safe logging
 * Shows only first 4 and last 4 characters
 * @param {string} token - Session token to redact
 * @returns {string} - Redacted token or '[INVALID_TOKEN]'
 */
function redactToken(token) {
  if (!token || typeof token !== 'string') {
    return '[INVALID_TOKEN]';
  }

  // Validate token format (32 hex characters for session tokens)
  if (!/^[a-f0-9]{32}$/i.test(token)) {
    return '[MALFORMED_TOKEN]';
  }

  // Show first 4 and last 4 characters
  return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
}

/**
 * Redact an API key for safe logging
 * Shows only first 8 characters (or less for shorter keys)
 * @param {string} apiKey - API key to redact
 * @returns {string} - Redacted API key or '[REDACTED]'
 */
function redactApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') {
    return '[REDACTED]';
  }

  const length = apiKey.length;
  if (length <= 8) {
    // Very short keys - don't show any characters
    return '[REDACTED]';
  } else if (length <= 20) {
    // Short-medium keys - show first 4 chars
    return `${apiKey.substring(0, 4)}...[REDACTED]`;
  } else {
    // Long keys - show first 8 chars
    return `${apiKey.substring(0, 8)}...[REDACTED]`;
  }
}

/**
 * Redact an API key for concise logging (shows first 3 and last 3 chars)
 * Used for identifying which key is being used in rotation logs
 * @param {string} apiKey - API key to redact
 * @returns {string} - Redacted API key in format "abc...[REDACTED]...xyz"
 */
function redactKeyShort(apiKey) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8) {
    return '[REDACTED]';
  }
  return `${apiKey.substring(0, 8)}...[REDACTED]...${apiKey.substring(apiKey.length - 3)}`;
}

/**
 * Sanitize an error object to remove sensitive data
 * @param {Error} error - Error object to sanitize
 * @param {Array<string>} sensitiveValues - Array of sensitive strings to redact (e.g., API keys)
 * @returns {Object} - Sanitized error object safe for logging
 */
function sanitizeError(error, sensitiveValues = []) {
  if (!error) return error;

  const sanitized = {
    message: error.message || '',
    name: error.name || 'Error',
    code: error.code,
    stack: error.stack || ''
  };

  // Redact sensitive values from message and stack
  for (const sensitive of sensitiveValues) {
    if (!sensitive || typeof sensitive !== 'string' || sensitive.length < 8) {
      continue;
    }

    // Create a pattern to match the sensitive value
    // Use first 6 chars to create pattern (safer than full value)
    const pattern = new RegExp(escapeRegex(sensitive.substring(0, 10)), 'gi');

    sanitized.message = sanitized.message.replace(pattern, '[REDACTED]');
    sanitized.stack = sanitized.stack.replace(pattern, '[REDACTED]');
  }

  return sanitized;
}

/**
 * Escape special regex characters in a string
 * @private
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sanitize a config object for logging
 * Redacts all sensitive fields (API keys, credentials)
 * @param {Object} config - Config object to sanitize
 * @returns {Object} - Sanitized config safe for logging
 */
function sanitizeConfig(config) {
  if (!config || typeof config !== 'object') {
    return config;
  }

  const sanitized = { ...config };

  // List of sensitive field names to redact
  const sensitiveFields = [
    'geminiApiKey',
    'geminiApiKeys', // Array of Gemini API keys (rotation feature)
    'assemblyAiApiKey',
    'apiKey',
    'password',
    'secret',
    'token',
    'accessToken',
    'refreshToken',
    'opensubtitlesPassword',
    'subdlApiKey',
    'subsourceApiKey',
    'jimakuApiKey'
  ];

  // Redact sensitive fields
  for (const field of sensitiveFields) {
    if (field in sanitized) {
      const value = sanitized[field];
      // Handle array-type sensitive fields (e.g., geminiApiKeys)
      if (Array.isArray(value)) {
        sanitized[field] = value.map(item => redactApiKey(item));
      } else {
        sanitized[field] = redactApiKey(value);
      }
    }
  }

  // Redact provider keys
  if (sanitized.providers && typeof sanitized.providers === 'object') {
    const sanitizedProviders = {};
    for (const [providerName, providerConfig] of Object.entries(sanitized.providers)) {
      sanitizedProviders[providerName] = {
        ...providerConfig,
        apiKey: redactApiKey(providerConfig?.apiKey)
      };
    }
    sanitized.providers = sanitizedProviders;
  }

  if (sanitized.subtitleProviders && typeof sanitized.subtitleProviders === 'object') {
    const sanitizedSubtitleProviders = {};
    for (const [providerName, providerConfig] of Object.entries(sanitized.subtitleProviders)) {
      sanitizedSubtitleProviders[providerName] = {
        ...providerConfig,
        apiKey: redactApiKey(providerConfig?.apiKey),
        password: redactApiKey(providerConfig?.password)
      };
    }
    sanitized.subtitleProviders = sanitizedSubtitleProviders;
  }

  return sanitized;
}

/**
 * Sanitize a cache key to prevent Redis injection
 * Removes wildcard characters and limits length
 * @param {string} key - Cache key to sanitize
 * @returns {string} - Sanitized cache key
 */
function sanitizeCacheKey(key) {
  if (!key || typeof key !== 'string') {
    throw new Error('Cache key must be a non-empty string');
  }

  // Remove Redis wildcard and special characters
  let sanitized = key.replace(/[\*\?\[\]\\]/g, '_');

  // Remove control characters
  sanitized = sanitized.replace(/[\r\n\0]/g, '_');

  // Limit length
  const MAX_LENGTH = 250;
  if (sanitized.length > MAX_LENGTH) {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    sanitized = sanitized.substring(0, 200) + '_' + hash.substring(0, 16);
  }

  return sanitized;
}

/**
 * Constant-time string comparison to prevent timing attacks
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} - True if strings are equal
 */
function constantTimeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  if (a.length !== b.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch (error) {
    // If timingSafeEqual fails (e.g., length mismatch), return false
    return false;
  }
}

/**
 * Sanitize an API key for safe use in HTTP headers
 * Removes control characters, newlines, and other invalid bytes that
 * would cause "Invalid character in header content" errors
 * @param {string} apiKey - API key to sanitize
 * @returns {string|null} - Sanitized API key or null if invalid
 */
function sanitizeApiKeyForHeader(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') {
    return null;
  }

  // Remove control characters (U+0000-U+001F except tab U+0009) and other problematic chars
  // HTTP headers can only contain printable ASCII (0x20-0x7E) plus tab (0x09)
  // Also remove DEL (0x7F) and non-ASCII characters for safety
  const sanitized = apiKey
    .replace(/[\x00-\x08\x0A-\x1F\x7F]/g, '') // Remove control chars except tab
    .replace(/[\u0080-\uFFFF]/g, '') // Remove non-ASCII
    .trim();

  // If sanitization changed the key significantly, it's probably corrupted
  // Return the sanitized version but log a warning if too much was removed
  if (sanitized.length < apiKey.length * 0.5) {
    // More than 50% of the key was invalid characters - likely corrupted
    return null;
  }

  return sanitized.length > 0 ? sanitized : null;
}

module.exports = {
  redactToken,
  redactApiKey,
  redactKeyShort,
  sanitizeError,
  sanitizeConfig,
  sanitizeCacheKey,
  constantTimeCompare,
  sanitizeApiKeyForHeader
};
