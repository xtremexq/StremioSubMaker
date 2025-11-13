const Joi = require('joi');
const log = require('./logger');

/**
 * Validation schemas for API endpoints
 */

// Validate fileId (subtitle file identifier)
const fileIdSchema = Joi.string()
  .pattern(/^[a-zA-Z0-9_-]+$/)
  .min(1)
  .max(200)
  .required();

// Validate language code (ISO-639-2 or ISO-639-1)
// Strict schema used for URL params where we expect codes
const languageCodeSchema = Joi.string()
  .pattern(/^[a-z]{2,3}(-[a-zA-Z]{2})?$/)
  .min(2)
  .max(10)
  .required();

// More permissive language schema for file translation API
// Accepts BCP-47-like tags or human-readable names (e.g., 'pt-BR', 'zh-Hant', 'English', 'Brazilian Portuguese', 'es-419')
const looseLanguageSchema = Joi.string()
  .min(1)
  .max(50)
  .required();

// Validate video ID (Stremio format: tt0133093 or tt0133093:1:1)
const videoIdSchema = Joi.string()
  .pattern(/^tt\d+(:[\d]+)?(:[\d]+)?$/)
  .min(1)
  .max(50)
  .required();

// Validate subtitle content (SRT format)
const subtitleContentSchema = Joi.string()
  .min(1)
  .max(1024 * 1024) // 1MB max
  .required();

// Validate config string (base64 encoded JSON)
const configStringSchema = Joi.string()
  .min(1)
  .max(10000) // 10KB max for config
  .required();

/**
 * Validate request parameters
 * @param {Object} data - Data to validate
 * @param {Object} schema - Joi schema
 * @returns {Object} - { error, value }
 */
function validateInput(data, schema) {
  return schema.validate(data, {
    abortEarly: false,
    stripUnknown: true,
  });
}

/**
 * Middleware factory to validate request parameters
 * @param {Object} schema - Joi schema for validation
 * @param {string} source - 'body', 'params', or 'query'
 * @returns {Function} - Express middleware
 */
function validateRequest(schema, source = 'body') {
  return (req, res, next) => {
    const data = req[source];
    const { error, value } = schema.validate(data, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const errors = error.details.map(detail => detail.message);
      log.error(() => [`[Validation] ${source} validation failed:`, errors]);
      return res.status(400).json({
        error: 'Validation failed',
        details: errors,
      });
    }

    // Replace request data with validated data
    req[source] = value;
    next();
  };
}

/**
 * Sanitize and validate subtitle file parameters
 */
const subtitleParamsSchema = Joi.object({
  config: configStringSchema,
  fileId: fileIdSchema,
  language: languageCodeSchema,
});

/**
 * Sanitize and validate translation parameters
 */
const translationParamsSchema = Joi.object({
  config: configStringSchema,
  sourceFileId: fileIdSchema,
  targetLang: languageCodeSchema,
});

/**
 * Sanitize and validate translation selector parameters
 */
const translationSelectorParamsSchema = Joi.object({
  config: configStringSchema,
  videoId: videoIdSchema,
  targetLang: languageCodeSchema,
});

/**
 * Sanitize and validate file translation request body
 */
const fileTranslationBodySchema = Joi.object({
  content: subtitleContentSchema,
  targetLanguage: looseLanguageSchema,
  configStr: configStringSchema,
});

module.exports = {
  validateInput,
  validateRequest,
  fileIdSchema,
  languageCodeSchema,
  looseLanguageSchema,
  videoIdSchema,
  subtitleContentSchema,
  configStringSchema,
  subtitleParamsSchema,
  translationParamsSchema,
  translationSelectorParamsSchema,
  fileTranslationBodySchema,
};
