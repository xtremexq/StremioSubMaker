const { DEFAULT_TRANSLATION_PROMPT } = require('../services/gemini');
const DEFAULT_API_KEYS = require('../config/defaultApiKeys');
const { getSessionManager } = require('./sessionManager');
const log = require('./logger');

/**
 * Feature flag: Override deprecated/old model names with current default
 * Set to false in the future to allow users to select any model they want
 * Currently enabled to ensure all users get the latest stable model
 */
const OVERRIDE_DEPRECATED_MODELS = true;

/**
 * List of deprecated model names that should be replaced with the current default
 * This prevents old saved configs from using outdated or experimental models
 */
const DEPRECATED_MODEL_NAMES = [
  'gemini-flash-latest',
  'gemini-2.0-flash-exp',
  'gemini-2.5-flash-lite-09-2025', // Old name before preview version
  'gemini-2.5-flash-latest',
  'gemini-pro-latest',
  'gemini-2.5-pro-latest'
];

/**
 * Parse configuration from config string or session token
 * @param {string} configStr - Base64 encoded config string OR session token
 * @param {Object} options - Options { isLocalhost: boolean }
 * @returns {Promise<Object>} - Parsed configuration
 */
async function parseConfig(configStr, options = {}) {
  try {
    if (!configStr) {
      return getDefaultConfig();
    }

    // Check if this is a session token (32 hex chars) or base64 config
    const isSessionToken = /^[a-f0-9]{32}$/.test(configStr);

    if (isSessionToken) {
      // Try to get config from session (now with Redis fallback)
      const sessionManager = getSessionManager();
      const config = await sessionManager.getSession(configStr);

      if (config) {
        log.debug(() => '[Config] Retrieved config from session token');
        return normalizeConfig(config);
      } else {
        log.warn(() => `[Config] Session token not found: ${configStr}`);
        const defaultConfig = getDefaultConfig();
        // Mark this config as having a session token error so handlers can show appropriate error messages
        defaultConfig.__sessionTokenError = true;
        return defaultConfig;
      }
    }

    // For localhost, allow old base64 encoding method (backward compatibility)
    if (options.isLocalhost || process.env.ALLOW_BASE64_CONFIG === 'true') {
      return parseBase64Config(configStr);
    }

    // Production mode: reject base64 configs
    log.warn(() => '[Config] Base64 configs not allowed in production mode. Use session tokens.');
    return getDefaultConfig();

  } catch (error) {
    log.error(() => ['[Config] Unexpected error during config parsing:', error.message]);
    return getDefaultConfig();
  }
}

/**
 * Parse base64 encoded configuration (legacy method)
 * @param {string} configStr - Base64 encoded config string
 * @returns {Object} - Parsed configuration
 */
function parseBase64Config(configStr) {
  try {
    // Express automatically URL-decodes path params, so we can decode base64 directly
    let decoded;
    try {
      decoded = Buffer.from(configStr, 'base64').toString('utf-8');
    } catch (decodeError) {
      log.error(() => ['[Config] Base64 decode error. Config string length:', configStr.length]);
      log.error(() => ['[Config] First 50 chars:', configStr.substring(0, 50)]);
      return getDefaultConfig();
    }

    // Check if decoded string looks like JSON (should start with { or [)
    const trimmed = decoded.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      log.error(() => '[Config] Decoded content does not look like JSON');
      log.error(() => ['[Config] Decoded preview (first 100 chars):', decoded.substring(0, 100).replace(/[^\x20-\x7E]/g, ' ')]);
      return getDefaultConfig();
    }

    let config;
    try {
      config = JSON.parse(decoded);
    } catch (parseError) {
      log.error(() => ['[Config] JSON parse error:', parseError.message]);
      log.error(() => ['[Config] Problematic JSON preview (first 200 chars):', decoded.substring(0, 200)]);
      return getDefaultConfig();
    }

    return normalizeConfig(config);
  } catch (error) {
    log.error(() => ['[Config] Unexpected error during base64 config parsing:', error.message]);
    return getDefaultConfig();
  }
}

/**
 * Normalize and merge config with defaults
 * @param {Object} config - User configuration
 * @returns {Object} - Normalized configuration
 */
function normalizeConfig(config) {
  // Migrate old config format to new format (backward compatibility)
  if (config.opensubtitlesApiKey && !config.subtitleProviders) {
    log.debug(() => '[Config] Migrating old config format to new format');
    config = migrateOldConfig(config);
  }

  // Merge with defaults to ensure all fields exist
  const defaults = getDefaultConfig();
  const mergedConfig = {
    ...defaults,
    ...config,
    // Deep merge subtitle providers to preserve individual provider settings
    subtitleProviders: {
      ...defaults.subtitleProviders,
      ...(config.subtitleProviders || {})
    },
    // Deep merge translation cache settings
    translationCache: {
      ...defaults.translationCache,
      ...(config.translationCache || {})
    },
    // Deep merge bypass cache settings (support old tempCache name for backward compatibility)
    bypassCacheConfig: {
      ...defaults.bypassCacheConfig,
      ...(config.bypassCacheConfig || config.tempCache || {})
    },
    // Deep merge advanced settings to preserve environment variable defaults
    advancedSettings: {
      ...defaults.advancedSettings,
      ...(config.advancedSettings || {})
    }
  };

  // If geminiModel is empty/null, use defaults (respects .env)
  if (!mergedConfig.geminiModel || mergedConfig.geminiModel.trim() === '') {
    mergedConfig.geminiModel = defaults.geminiModel;
  }

  // Override deprecated model names with current default (if feature flag enabled)
  // TO RE-ENABLE USER MODEL SELECTION: Set OVERRIDE_DEPRECATED_MODELS = false at top of file
  if (OVERRIDE_DEPRECATED_MODELS && mergedConfig.geminiModel && DEPRECATED_MODEL_NAMES.includes(mergedConfig.geminiModel)) {
    log.debug(() => `[Config] Overriding deprecated model '${mergedConfig.geminiModel}' with default '${defaults.geminiModel}'`);
    mergedConfig.geminiModel = defaults.geminiModel;
  }

  // Apply advanced settings model override if enabled
  if (mergedConfig.advancedSettings?.enabled && mergedConfig.advancedSettings?.geminiModel) {
    log.debug(() => `[Config] Advanced settings enabled: Overriding model '${mergedConfig.geminiModel}' with '${mergedConfig.advancedSettings.geminiModel}'`);
    mergedConfig.geminiModel = mergedConfig.advancedSettings.geminiModel;
  }

  // Force bypass cache when advanced settings are enabled
  // This ensures experimental translations don't pollute the shared database
  if (mergedConfig.advancedSettings?.enabled) {
    log.debug(() => '[Config] Advanced settings enabled: Forcing bypass cache');
    mergedConfig.bypassCache = true;
  }

  // Enforce permanent disk caching regardless of client config
  mergedConfig.translationCache.enabled = true;
  mergedConfig.translationCache.persistent = true;
  mergedConfig.translationCache.duration = 0;

  // If user disabled main caching in UI, interpret as bypass mode
  if (config.translationCache && config.translationCache.enabled === false) {
    mergedConfig.bypassCache = true;
  }

  // Normalize bypass flag
  mergedConfig.bypassCache = mergedConfig.bypassCache === true;

  // Ensure bypass cache config mirrors bypass flag and clamp duration to max 12h
  mergedConfig.bypassCacheConfig = mergedConfig.bypassCacheConfig || {};
  mergedConfig.bypassCacheConfig.enabled = mergedConfig.bypassCache === true;
  const bypassDur = Number(mergedConfig.bypassCacheConfig.duration);
  mergedConfig.bypassCacheConfig.duration = (Number.isFinite(bypassDur) && bypassDur > 0) ? Math.min(12, bypassDur) : 12;

  // Keep old tempCache for backward compatibility
  mergedConfig.tempCache = mergedConfig.bypassCacheConfig;

  return mergedConfig;
}

/**
 * Migrate old configuration format to new format
 * @param {Object} oldConfig - Old configuration format
 * @returns {Object} - New configuration format
 */
function migrateOldConfig(oldConfig) {
  const newConfig = { ...oldConfig };
  const defaults = getDefaultConfig();

  // Migrate opensubtitlesApiKey to subtitleProviders structure
  // Include all providers from defaults to ensure none are missing
  newConfig.subtitleProviders = {
    ...defaults.subtitleProviders,
    opensubtitles: {
      enabled: true,
      username: '',
      password: ''
    }
  };

  // Remove old field
  delete newConfig.opensubtitlesApiKey;

  return newConfig;
}

/**
 * Encode configuration to base64 string
 * @param {Object} config - Configuration object
 * @returns {string} - Base64 config string
 */
function encodeConfig(config) {
  try {
    const json = JSON.stringify(config);
    return Buffer.from(json, 'utf-8').toString('base64');
  } catch (error) {
    log.error(() => ['[Config] Encode error:', error.message]);
    return '';
  }
}

/**
 * Get default configuration
 * @returns {Object} - Default configuration
 */
function getDefaultConfig() {
  // Read advanced settings from environment variables with fallback defaults
  const advancedSettings = {
    maxOutputTokens: parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 65536,
    chunkSize: 12000,
    translationTimeout: parseInt(process.env.GEMINI_TRANSLATION_TIMEOUT) || 600, // seconds
    maxRetries: process.env.GEMINI_MAX_RETRIES !== undefined ? parseInt(process.env.GEMINI_MAX_RETRIES) : 3,
    // Extended thinking (0 = disabled, -1 = dynamic, >0 = fixed budget)
    thinkingBudget: process.env.GEMINI_THINKING_BUDGET !== undefined ? parseInt(process.env.GEMINI_THINKING_BUDGET) : 0,
    // Sampling parameters
    temperature: process.env.GEMINI_TEMPERATURE !== undefined ? parseFloat(process.env.GEMINI_TEMPERATURE) : 0.8,
    topK: process.env.GEMINI_TOP_K !== undefined ? parseInt(process.env.GEMINI_TOP_K) : 40,
    topP: process.env.GEMINI_TOP_P !== undefined ? parseFloat(process.env.GEMINI_TOP_P) : 0.95
  };

  return {
    noTranslationMode: false, // If true, skip translation and just fetch subtitles
    noTranslationLanguages: [], // Languages to fetch when in no-translation mode
    sourceLanguages: [],
    targetLanguages: [],
    geminiApiKey: '',
    // Use env variable for model if set, otherwise use default
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite-preview-09-2025',
    translationPrompt: DEFAULT_TRANSLATION_PROMPT,
    subtitleProviders: {
      opensubtitles: {
        enabled: true,
        username: '', // OpenSubtitles account username (required)
        password: ''   // OpenSubtitles account password (required)
      },
      subdl: {
        enabled: true,
        apiKey: DEFAULT_API_KEYS.SUBDL
      },
      subsource: {
        enabled: true,
        apiKey: DEFAULT_API_KEYS.SUBSOURCE
      }
    },
    translationCache: {
      enabled: true,
      duration: 0, // hours, 0 = permanent
      persistent: true // save to disk
    },
    bypassCache: false,
    bypassCacheConfig: {
      enabled: true,
      duration: 12
    },
    tempCache: { // Deprecated: kept for backward compatibility, use bypassCacheConfig instead
      enabled: true,
      duration: 12
    },
    fileTranslationEnabled: false, // enable file upload translation feature
    syncSubtitlesEnabled: false, // enable 'Sync Subtitles' action in subtitles list
    // Minimum size for a subtitle file to be considered valid (bytes)
    // Prevents attempting to load/translate obviously broken files
    minSubtitleSizeBytes: 200,
    advancedSettings
  };
}

/**
 * Validate configuration
 * @param {Object} config - Configuration to validate
 * @returns {Object} - Validation result { valid: boolean, errors: Array }
 */
function validateConfig(config) {
  const errors = [];

  if (!config) {
    errors.push('Configuration is required');
    return { valid: false, errors };
  }

  // Check Gemini API key
  if (!config.geminiApiKey || config.geminiApiKey.trim() === '') {
    errors.push('Gemini API key is required');
  }

  // Check if 1-3 source languages are selected
  if (!config.sourceLanguages || config.sourceLanguages.length === 0) {
    errors.push('At least one source language must be selected');
  }

  if (config.sourceLanguages && config.sourceLanguages.length > 3) {
    errors.push('Maximum of 3 source languages allowed');
  }

  if (!config.targetLanguages || config.targetLanguages.length === 0) {
    errors.push('At least one target language must be selected');
  }

  // Check Gemini model
  if (!config.geminiModel || config.geminiModel.trim() === '') {
    errors.push('Gemini model must be selected');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Build addon manifest from configuration
 * @param {Object} config - Configuration object
 * @param {string} baseUrl - Base URL of the addon server (optional)
 * @returns {Object} - Stremio addon manifest
 */
const { version } = require('./version');

function buildManifest(config, baseUrl = '') {
  // Check if this is a session token error
  const hasSessionTokenError = config.__sessionTokenError === true;

  // For session token errors, use placeholder languages to ensure Stremio calls the subtitle handler
  // This allows the handler to display error subtitles to the user
  let sourceLanguageNames, targetLanguageNames, description;

  if (hasSessionTokenError) {
    sourceLanguageNames = 'ERROR';
    targetLanguageNames = 'ERROR';
    description = '⚠️ Configuration Error: Session token not found or expired.\n\nPlease reconfigure the addon to continue using it.';
  } else {
    sourceLanguageNames = config.sourceLanguages
      .map(code => code.toUpperCase())
      .join(', ');

    targetLanguageNames = config.targetLanguages
      .map(code => code.toUpperCase())
      .join(', ');

    description = `Fetches subtitles from OpenSubtitles and translates them using Gemini AI.\n\nSource languages: ${sourceLanguageNames}\nTarget languages: ${targetLanguageNames}`;
  }

  // Check if this is a configured instance (has API key)
  const isConfigured = config.geminiApiKey && config.geminiApiKey.trim() !== '';

  // Use local assets when baseUrl is provided
  const logo = baseUrl ? `${baseUrl}/logo.png` : 'https://i.imgur.com/5qJc5Y5.png';
  const background = baseUrl ? `${baseUrl}/background.svg` : 'https://i.imgur.com/5qJc5Y5.png';

  // ElfHosted branding support
  const isElfHosted = process.env.ELFHOSTED === 'true';
  const addonName = isElfHosted ? 'SubMaker | ElfHosted' : 'SubMaker - Subtitle Translator';

  return {
    id: 'com.stremio.submaker',
    version: version,
    name: addonName,
    description: description,

    catalogs: [],
    resources: ['subtitles'],
    types: ['movie', 'series', 'anime'],

    idPrefixes: ['tt', 'tmdb', 'anidb', 'kitsu', 'mal', 'anilist'],

    behaviorHints: {
      configurable: true,
      configurationRequired: false
    },

    logo: logo,
    // Some Stremio clients look for `icon`; keep it in sync with `logo`
    icon: logo,
    background: background,

    contactEmail: 'support@submaker.example.com'
  };
}

module.exports = {
  parseConfig,
  encodeConfig,
  getDefaultConfig,
  validateConfig,
  buildManifest,
  // Exported for async token resolution paths in routes
  normalizeConfig
};
