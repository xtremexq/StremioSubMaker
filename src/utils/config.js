const { DEFAULT_TRANSLATION_PROMPT } = require('../services/gemini');
const DEFAULT_API_KEYS = require('../config/defaultApiKeys');
const { getSessionManager } = require('./sessionManager');

/**
 * Parse configuration from config string or session token
 * @param {string} configStr - Base64 encoded config string OR session token
 * @param {Object} options - Options { isLocalhost: boolean }
 * @returns {Object} - Parsed configuration
 */
function parseConfig(configStr, options = {}) {
  try {
    if (!configStr) {
      return getDefaultConfig();
    }

    // Check if this is a session token (32 hex chars) or base64 config
    const isSessionToken = /^[a-f0-9]{32}$/.test(configStr);

    if (isSessionToken) {
      // Try to get config from session
      const sessionManager = getSessionManager();
      const config = sessionManager.getSession(configStr);

      if (config) {
        console.log(`[Config] Retrieved config from session token`);
        return normalizeConfig(config);
      } else {
        console.warn(`[Config] Session token not found: ${configStr}`);
        return getDefaultConfig();
      }
    }

    // For localhost, allow old base64 encoding method (backward compatibility)
    if (options.isLocalhost || process.env.ALLOW_BASE64_CONFIG === 'true') {
      return parseBase64Config(configStr);
    }

    // Production mode: reject base64 configs
    console.warn('[Config] Base64 configs not allowed in production mode. Use session tokens.');
    return getDefaultConfig();

  } catch (error) {
    console.error('[Config] Unexpected error during config parsing:', error.message);
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
      console.error('[Config] Base64 decode error. Config string length:', configStr.length);
      console.error('[Config] First 50 chars:', configStr.substring(0, 50));
      return getDefaultConfig();
    }

    // Check if decoded string looks like JSON (should start with { or [)
    const trimmed = decoded.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      console.error('[Config] Decoded content does not look like JSON');
      console.error('[Config] Decoded preview (first 100 chars):', decoded.substring(0, 100).replace(/[^\x20-\x7E]/g, '�'));
      return getDefaultConfig();
    }

    let config;
    try {
      config = JSON.parse(decoded);
    } catch (parseError) {
      console.error('[Config] JSON parse error:', parseError.message);
      console.error('[Config] Problematic JSON preview (first 200 chars):', decoded.substring(0, 200));
      return getDefaultConfig();
    }

    return normalizeConfig(config);
  } catch (error) {
    console.error('[Config] Unexpected error during base64 config parsing:', error.message);
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
    console.log('[Config] Migrating old config format to new format');
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
    }
  };

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
    },
    podnapisi: {
      enabled: false,
      apiKey: DEFAULT_API_KEYS.PODNAPISI
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
    console.error('[Config] Encode error:', error.message);
    return '';
  }
}

/**
 * Get default configuration
 * @returns {Object} - Default configuration
 */
function getDefaultConfig() {
  return {
    noTranslationMode: false, // If true, skip translation and just fetch subtitles
    noTranslationLanguages: [], // Languages to fetch when in no-translation mode
    sourceLanguages: [],
    targetLanguages: [],
    geminiApiKey: '',
    geminiModel: '',
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
      },
      podnapisi: {
        enabled: false, // Disabled by default - not accessible from UI
        apiKey: DEFAULT_API_KEYS.PODNAPISI
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
    // Minimum size for a subtitle file to be considered valid (bytes)
    // Prevents attempting to load/translate obviously broken files
    minSubtitleSizeBytes: 200,
    advancedSettings: {
      maxOutputTokens: 65536,
      chunkSize: 12000,
      translationTimeout: 600, // seconds
      maxRetries: 5
    }
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
  const sourceLanguageNames = config.sourceLanguages
    .map(code => code.toUpperCase())
    .join(', ');

  const targetLanguageNames = config.targetLanguages
    .map(code => code.toUpperCase())
    .join(', ');

  // Check if this is a configured instance (has API key)
  const isConfigured = config.geminiApiKey && config.geminiApiKey.trim() !== '';

  // Use local assets when baseUrl is provided
  const logo = baseUrl ? `${baseUrl}/logo.png` : 'https://i.imgur.com/5qJc5Y5.png';
  const background = baseUrl ? `${baseUrl}/background.svg` : 'https://i.imgur.com/5qJc5Y5.png';

  return {
    id: 'com.stremio.submaker',
    version: version,
    name: 'SubMaker - Subtitle Translator',
    description: `Fetches subtitles from OpenSubtitles and translates them using Gemini AI.\n\nSource languages: ${sourceLanguageNames}\nTarget languages: ${targetLanguageNames}`,

    catalogs: [],
    resources: ['subtitles'],
    types: ['movie', 'series'],

    idPrefixes: ['tt'],

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
  buildManifest
};
