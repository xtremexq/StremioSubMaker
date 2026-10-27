const Joi = require('joi');
const log = require('./logger');
const { inspectStremioIdSupport, parseStremioId } = require('./subtitle');
const { MAX_PROVIDER_FILE_ID_CHARS } = require('./providerUrlToken');

/**
 * Validation schemas for API endpoints
 */

// Validate fileId (subtitle file identifier)
// SCS uses opaque download tokens embedded in the provider URL, which can be long
// because they encode content metadata such as filename/video hash.
// Typical SCS IDs are 250-400 chars. Authenticated provider URL IDs can be
// longer when a dynamic CDN supplies a signed URL near the encoder's 4 KiB
// safety ceiling, so keep this bound aligned with providerUrlToken.js.
const fileIdSchema = Joi.string()
  .pattern(/^[a-zA-Z0-9_-]+$/)
  .min(1)
  .max(MAX_PROVIDER_FILE_ID_CHARS)
  .required();

// Validate language code (ISO-639-2, ISO-639-1, or BCP-47 subtags)
// Accepts: base (2-3 letter) + optional subtag:
//   - 2-letter alpha region (es-MX, en-GB)
//   - 4-letter alpha script (sr-Cyrl, zh-Hant)
//   - 3-digit numeric region (es-419)
const languageCodeSchema = Joi.string()
  .pattern(/^[a-z]{2,3}(-([a-zA-Z]{2,4}|[0-9]{3}))?$/)
  .min(2)
  .max(10)
  .required();

// More permissive language schema for file translation API
// Accepts BCP-47-like tags or human-readable names (e.g., 'pt-BR', 'zh-Hant', 'English', 'Brazilian Portuguese', 'es-419')
const looseLanguageSchema = Joi.string()
  .min(1)
  .max(50)
  .required();

// Validate supported Stremio video IDs (IMDb, TMDB, and supported anime prefixes)
const videoIdSchema = Joi.string()
  .min(1)
  .max(100)
  .custom((value, helpers) => {
    const support = inspectStremioIdSupport(value);
    if (!support.supported || !parseStremioId(value)) {
      return helpers.error('string.stremioVideoId');
    }
    return value;
  }, 'supported Stremio ID validation')
  .required()
  .messages({
    'string.stremioVideoId': '\"videoId\" must be a supported Stremio video ID'
  });

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

// Validate provider parameter overrides for translation
const providerParameterSchema = Joi.object({
  temperature: Joi.number().min(0).max(2).optional(),
  topP: Joi.number().min(0).max(1).optional(),
  maxOutputTokens: Joi.number().min(1).max(200000).optional(),
  translationTimeout: Joi.number().min(5).max(720).optional(),
  maxRetries: Joi.number().integer().min(0).max(5).optional(),
  thinkingBudget: Joi.number().min(-1).max(200000).optional(),
  thinkingLevel: Joi.string().valid('disabled', 'minimal', 'low', 'medium', 'high').optional(),
  samplingParametersEnabled: Joi.boolean().optional(),
  // Configure persists an empty modelType for providers that do not use the
  // DeepL-specific setting. File/Toolbox clients may submit the full saved
  // parameter block, so treat that ordinary empty value as unset instead of
  // rejecting the complete translation request before provider selection.
  modelType: Joi.string().max(100).allow('').optional(),
  formality: Joi.string().max(50).optional(),
  preserveFormatting: Joi.boolean().optional()
}).unknown(true);

// Validate translation overrides payload (optional provider/model/prompt tweaks)
const translationOverridesSchema = Joi.object({
  translationPrompt: Joi.string().max(8000).allow('').optional(),
  provider: Joi.string().max(50).optional(),
  providerModel: Joi.string().max(300).allow('').optional(),
  providerParameters: Joi.object().pattern(/.*/, providerParameterSchema).optional(),
  advancedSettings: Joi.object().unknown(true).optional()
}).optional();

// Optional translation engine toggles (workflow/timing)
const translationOptionsSchema = Joi.object({
  translationWorkflow: Joi.string().valid('xml', 'json', 'original', 'ai').optional(),
  singleBatchMode: Joi.boolean().optional(),
  enableBatchContext: Joi.boolean().optional(),
  // Legacy fields kept for backward compatibility with older clients
  workflow: Joi.string().valid('batched', 'single-pass', 'single-batch', 'one-pass').optional(),
  timingMode: Joi.string().valid('preserve-timing', 'ai-timing', 'ai-timestamps', 'source-timing').optional(),
  sendTimestampsToAI: Joi.boolean().optional()
}).unknown(true).optional();

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
 * Sanitize and validate typed subtitle content parameters
 */
const subtitleContentParamsSchema = Joi.object({
  config: configStringSchema,
  fileId: fileIdSchema,
  language: languageCodeSchema,
  ext: Joi.string().valid('srt', 'sub', 'vtt', 'ass', 'ssa').required(),
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
 * Sanitize and validate file translation request body
 */
const fileTranslationBodySchema = Joi.object({
  content: subtitleContentSchema,
  targetLanguage: looseLanguageSchema,
  sourceLanguage: looseLanguageSchema.optional(),
  configStr: configStringSchema,
  advancedSettings: Joi.object().unknown(true).optional(), // Allow advanced settings override
  overrides: translationOverridesSchema,
  options: translationOptionsSchema
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
  subtitleContentParamsSchema,
  translationParamsSchema,
  fileTranslationBodySchema,
};
