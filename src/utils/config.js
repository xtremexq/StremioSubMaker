const { DEFAULT_TRANSLATION_PROMPT } = require('../services/gemini');
const DEFAULT_API_KEYS = require('../config/defaultApiKeys');
const { getSessionManager } = require('./sessionManager');
const log = require('./logger');

// Language selection limits (configurable via environment)
const DEFAULT_SOURCE_LANGUAGE_LIMIT = 3;
const DEFAULT_TARGET_LANGUAGE_LIMIT = 6;
const DEFAULT_NO_TRANSLATION_LANGUAGE_LIMIT = 9;

function parseLanguageLimit(envVar, fallback, min = 1, max = 50) {
  const parsed = parseInt(process.env[envVar], 10);
  if (Number.isFinite(parsed) && parsed >= min) {
    return Math.min(max, parsed);
  }
  return fallback;
}

function getLanguageSelectionLimits() {
  return {
    maxSourceLanguages: parseLanguageLimit('MAX_SOURCE_LANGUAGES', DEFAULT_SOURCE_LANGUAGE_LIMIT),
    maxTargetLanguages: parseLanguageLimit('MAX_TARGET_LANGUAGES', DEFAULT_TARGET_LANGUAGE_LIMIT),
    maxNoTranslationLanguages: parseLanguageLimit('MAX_NO_TRANSLATION_LANGUAGES', DEFAULT_NO_TRANSLATION_LANGUAGE_LIMIT)
  };
}

const PROVIDER_PARAMETER_DEFAULTS = {
  openai: {
    temperature: 0.4,
    topP: 0.95,
    maxOutputTokens: 32768,
    translationTimeout: 60,
    maxRetries: 2,
    reasoningEffort: undefined // undefined = omit from API request (default behavior)
  },
  anthropic: {
    temperature: 0.4,
    topP: 0.95,
    maxOutputTokens: 32768,
    translationTimeout: 60,
    maxRetries: 2,
    thinkingBudget: 0
  },
  xai: {
    temperature: 0.4,
    topP: 0.95,
    maxOutputTokens: 32768,
    translationTimeout: 60,
    maxRetries: 2
  },
  deepseek: {
    temperature: 0.4,
    topP: 0.95,
    maxOutputTokens: 32768,
    translationTimeout: 60,
    maxRetries: 2
  },
  deepl: {
    temperature: 0, // Not used by DeepL, kept for UI consistency
    topP: 1,
    maxOutputTokens: 32768,
    translationTimeout: 60,
    maxRetries: 2,
    modelType: 'quality_optimized',
    formality: 'default',
    preserveFormatting: true
  },
  mistral: {
    temperature: 0.4,
    topP: 0.95,
    maxOutputTokens: 32768,
    translationTimeout: 60,
    maxRetries: 2
  },
  cfworkers: {
    temperature: 0.4,
    topP: 0.9,
    maxOutputTokens: 32768,
    translationTimeout: 60,
    maxRetries: 2
  },
  openrouter: {
    temperature: 0.4,
    topP: 0.95,
    maxOutputTokens: 32768,
    translationTimeout: 60,
    maxRetries: 2
  }
};

function sanitizeProviderNumber(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (min !== undefined && parsed < min) return min;
  if (max !== undefined && parsed > max) return max;
  return parsed;
}

function sanitizeReasoningEffort(value, fallback) {
  // Allow empty string to explicitly disable reasoning effort
  if (value === '' || value === null || value === undefined) {
    return undefined;
  }
  const allowed = ['low', 'medium', 'high'];
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return allowed.includes(normalized) ? normalized : fallback;
}

function mergeProviderParameters(defaults, incoming) {
  const merged = {};
  const incomingParams = incoming || {};
  Object.keys(defaults || {}).forEach(key => {
    const matchKey = Object.keys(incomingParams).find(k => String(k).toLowerCase() === String(key).toLowerCase());
    const raw = matchKey ? incomingParams[matchKey] : {};
    const base = defaults[key] || {};
    merged[key] = {
      temperature: sanitizeProviderNumber(raw?.temperature, base.temperature, 0, 2),
      topP: sanitizeProviderNumber(raw?.topP, base.topP, 0, 1),
      maxOutputTokens: Math.max(1, sanitizeProviderNumber(raw?.maxOutputTokens, base.maxOutputTokens, 1, 200000)),
      translationTimeout: Math.max(5, sanitizeProviderNumber(raw?.translationTimeout, base.translationTimeout, 5, 600)),
      maxRetries: Math.max(0, Math.min(5, parseInt(raw?.maxRetries) || base.maxRetries || 0)),
      reasoningEffort: sanitizeReasoningEffort(raw?.reasoningEffort, base.reasoningEffort),
      thinkingBudget: Math.max(
        0,
        Math.min(200000, parseInt(raw?.thinkingBudget) || parseInt(base.thinkingBudget) || 0)
      ),
      formality: typeof raw?.formality === 'string'
        ? raw.formality
        : (typeof base.formality === 'string' ? base.formality : 'default'),
      modelType: typeof raw?.modelType === 'string'
        ? raw.modelType
        : (typeof base.modelType === 'string' ? base.modelType : ''),
      preserveFormatting: raw?.preserveFormatting !== undefined
        ? raw.preserveFormatting === true
        : base.preserveFormatting === true
    };
  });
  return merged;
}

function getDefaultProviderParameters() {
  return JSON.parse(JSON.stringify(PROVIDER_PARAMETER_DEFAULTS));
}

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
 * Remove UI-only/fake language entries and normalize common variants
 * @param {Array} list - Array of language codes
 * @returns {Array} - Sanitized list (deduped, lowercased)
 */
function sanitizeLanguages(list) {
  if (!Array.isArray(list)) return [];

  const blocked = new Set(['translate srt', '__']);
  const deduped = new Set();

  for (const lang of list) {
    let value = String(lang || '').trim().toLowerCase();
    if (!value || blocked.has(value) || value.startsWith('___')) continue;
    if (value === 'ptbr' || value === 'pt-br') value = 'pob';
    deduped.add(value);
  }

  return Array.from(deduped);
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

  // Determine the model to use (from config or default)
  const configModel = config.geminiModel || process.env.GEMINI_MODEL || 'gemini-flash-latest';

  // Get model-specific defaults based on the selected model
  const defaults = getDefaultConfig(configModel);
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
    providers: Object.keys(defaults.providers).reduce((acc, key) => {
      const incoming = config.providers || {};
      const matchKey = Object.keys(incoming).find(k => k.toLowerCase() === key.toLowerCase());
      acc[key] = {
        ...defaults.providers[key],
        ...(matchKey ? incoming[matchKey] : {})
      };
      return acc;
    }, {}),
    providerParameters: mergeProviderParameters(
      defaults.providerParameters,
      config.providerParameters || {}
    ),
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

  // Force Learn Mode placement to top-of-screen now that the UI no longer exposes this toggle
  mergedConfig.learnPlacement = 'top';

  // Strip out UI-only/fake languages that might have been saved accidentally
  mergedConfig.sourceLanguages = sanitizeLanguages(mergedConfig.sourceLanguages);
  mergedConfig.targetLanguages = sanitizeLanguages(mergedConfig.targetLanguages);
  mergedConfig.noTranslationLanguages = sanitizeLanguages(mergedConfig.noTranslationLanguages);
  mergedConfig.learnTargetLanguages = sanitizeLanguages(mergedConfig.learnTargetLanguages);

  // Enforce language selection limits (configurable via env)
  const { maxSourceLanguages, maxTargetLanguages, maxNoTranslationLanguages } = getLanguageSelectionLimits();
  if (mergedConfig.sourceLanguages.length > maxSourceLanguages) {
    mergedConfig.sourceLanguages = mergedConfig.sourceLanguages.slice(0, maxSourceLanguages);
  }

  const seenTargets = new Set();
  const trimmedTargets = [];
  const trimmedLearns = [];

  const pushWithLimit = (code, dest) => {
    if (!code) return;
    if (seenTargets.has(code)) {
      dest.push(code);
      return;
    }
    if (seenTargets.size >= maxTargetLanguages) return;
    seenTargets.add(code);
    dest.push(code);
  };

  (mergedConfig.targetLanguages || []).forEach(code => pushWithLimit(code, trimmedTargets));
  (mergedConfig.learnTargetLanguages || []).forEach(code => pushWithLimit(code, trimmedLearns));

  mergedConfig.targetLanguages = trimmedTargets;
  mergedConfig.learnTargetLanguages = trimmedLearns;

  // Normalize key toggles early so downstream logic always sees booleans
  mergedConfig.fileTranslationEnabled = mergedConfig.fileTranslationEnabled === true;
  mergedConfig.syncSubtitlesEnabled = mergedConfig.syncSubtitlesEnabled === true;
  mergedConfig.singleBatchMode = mergedConfig.singleBatchMode === true;
  mergedConfig.multiProviderEnabled = mergedConfig.multiProviderEnabled === true;
  const advSettings = mergedConfig.advancedSettings || {};
  mergedConfig.advancedSettings = {
    ...advSettings,
    enabled: advSettings.enabled === true,
    sendTimestampsToAI: advSettings.sendTimestampsToAI === true
  };

  if (mergedConfig.noTranslationLanguages.length > maxNoTranslationLanguages) {
    mergedConfig.noTranslationLanguages = mergedConfig.noTranslationLanguages.slice(0, maxNoTranslationLanguages);
  }

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
  if (mergedConfig.advancedSettings.enabled && mergedConfig.advancedSettings?.geminiModel) {
    log.debug(() => `[Config] Advanced settings enabled: Overriding model '${mergedConfig.geminiModel}' with '${mergedConfig.advancedSettings.geminiModel}'`);
    mergedConfig.geminiModel = mergedConfig.advancedSettings.geminiModel;
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

  // Normalize multi-provider settings
  mergedConfig.multiProviderEnabled = mergedConfig.multiProviderEnabled === true;
  mergedConfig.mainProvider = mergedConfig.multiProviderEnabled ? (mergedConfig.mainProvider || 'gemini') : 'gemini';
  mergedConfig.mainProvider = String(mergedConfig.mainProvider || 'gemini').toLowerCase();
  mergedConfig.secondaryProviderEnabled = mergedConfig.multiProviderEnabled && mergedConfig.secondaryProviderEnabled === true;
  mergedConfig.secondaryProvider = mergedConfig.secondaryProviderEnabled ? String(mergedConfig.secondaryProvider || '').toLowerCase() : '';
  const resolveProviderKey = (key) => {
    const lower = String(key || '').toLowerCase();
    const match = Object.keys(mergedConfig.providers || {}).find(k => String(k).toLowerCase() === lower);
    return match || key;
  };
  const providerIsConfigured = (key) => {
    const resolved = resolveProviderKey(key);
    const cfg = mergedConfig.providers?.[resolved] || {};
    return !!(cfg.enabled && cfg.apiKey && cfg.model);
  };
  const firstConfiguredProvider = () => {
    const entry = Object.entries(mergedConfig.providers || {}).find(([, cfg]) => cfg && cfg.enabled && cfg.apiKey && cfg.model);
    return entry ? String(entry[0]).toLowerCase() : null;
  };
  if (mergedConfig.providers && typeof mergedConfig.providers === 'object') {
    for (const [key, value] of Object.entries(mergedConfig.providers)) {
      mergedConfig.providers[key] = {
        enabled: value?.enabled === true,
        apiKey: typeof value?.apiKey === 'string' ? value.apiKey : '',
        model: typeof value?.model === 'string' ? value.model : ''
      };
    }
  }

  if (mergedConfig.multiProviderEnabled) {
    const mainKey = mergedConfig.mainProvider || 'gemini';
    const geminiConfigured = !!(mergedConfig.geminiApiKey && mergedConfig.geminiModel);
    const mainConfigured = mainKey === 'gemini' ? geminiConfigured : providerIsConfigured(mainKey);
    if (!mainConfigured) {
      const fallbackProvider = firstConfiguredProvider();
      if (fallbackProvider) {
        log.warn(() => `[Config] Main provider '${mainKey}' is not fully configured, switching to '${fallbackProvider}'`);
        mergedConfig.mainProvider = fallbackProvider;
      } else if (geminiConfigured) {
        log.warn(() => `[Config] Main provider '${mainKey}' is not fully configured, falling back to Gemini`);
        mergedConfig.mainProvider = 'gemini';
      } else {
        log.warn(() => `[Config] No configured AI providers found; translations will fail until an API key is set`);
      }
    }
  } else {
    mergedConfig.mainProvider = 'gemini';
  }

  if (mergedConfig.secondaryProviderEnabled) {
    if (!mergedConfig.secondaryProvider || mergedConfig.secondaryProvider === mergedConfig.mainProvider) {
      log.warn(() => '[Config] Secondary provider not set or matches main provider; disabling fallback');
      mergedConfig.secondaryProviderEnabled = false;
      mergedConfig.secondaryProvider = '';
    } else if (mergedConfig.secondaryProvider === 'gemini') {
      if (!mergedConfig.geminiApiKey || !mergedConfig.geminiModel) {
        log.warn(() => '[Config] Secondary provider Gemini is missing API key/model; disabling fallback');
        mergedConfig.secondaryProviderEnabled = false;
        mergedConfig.secondaryProvider = '';
      }
    } else {
      const fallbackKey = Object.keys(mergedConfig.providers || {}).find(k => k.toLowerCase() === mergedConfig.secondaryProvider) || mergedConfig.secondaryProvider;
      const fallbackCfg = mergedConfig.providers?.[fallbackKey] || {};
      const validFallback = fallbackCfg.enabled && fallbackCfg.apiKey && fallbackCfg.model;
      if (!validFallback) {
        log.warn(() => `[Config] Secondary provider '${mergedConfig.secondaryProvider}' is not fully configured; disabling fallback`);
        mergedConfig.secondaryProviderEnabled = false;
        mergedConfig.secondaryProvider = '';
      }
    }
  }

  // Only keep multi-provider mode enabled when a non-Gemini main OR a fallback is active
  const hasActiveMultiProvider = mergedConfig.multiProviderEnabled && (
    mergedConfig.mainProvider !== 'gemini' || mergedConfig.secondaryProviderEnabled
  );
  if (!hasActiveMultiProvider) {
    mergedConfig.multiProviderEnabled = false;
    mergedConfig.secondaryProviderEnabled = false;
    mergedConfig.secondaryProvider = '';
  }

  // Force bypass cache when experimental/one-off modes are enabled to avoid polluting shared cache
  const bypassReasons = [];
  if (mergedConfig.advancedSettings.enabled) bypassReasons.push('advanced-settings');
  if (mergedConfig.singleBatchMode) bypassReasons.push('single-batch');
  if (hasActiveMultiProvider) bypassReasons.push('multi-provider');
  if (bypassReasons.length > 0) {
    log.debug(() => `[Config] Forcing bypass cache (${bypassReasons.join(', ')})`);
    mergedConfig.bypassCache = true;
  }

  // Ensure bypass cache config mirrors bypass flag and clamp duration to max 12h
  mergedConfig.bypassCacheConfig = mergedConfig.bypassCacheConfig || {};
  mergedConfig.bypassCacheConfig.enabled = mergedConfig.bypassCache === true;
  const bypassDur = Number(mergedConfig.bypassCacheConfig.duration);
  mergedConfig.bypassCacheConfig.duration = (Number.isFinite(bypassDur) && bypassDur > 0) ? Math.min(12, bypassDur) : 12;

  // Keep old tempCache for backward compatibility
  mergedConfig.tempCache = mergedConfig.bypassCacheConfig;

  // Normalize mobile mode flag
  mergedConfig.mobileMode = mergedConfig.mobileMode === true;

  // Show all Gemini API configs that will be used
  const thinkingDisplay = mergedConfig.advancedSettings.thinkingBudget === -1 ? 'dynamic' :
                         mergedConfig.advancedSettings.thinkingBudget === 0 ? 'disabled' :
                         mergedConfig.advancedSettings.thinkingBudget;
  log.debug(() => `[Config] Gemini API config: model=${mergedConfig.geminiModel}, temperature=${mergedConfig.advancedSettings.temperature}, topK=${mergedConfig.advancedSettings.topK}, topP=${mergedConfig.advancedSettings.topP}, thinkingBudget=${thinkingDisplay}, maxOutputTokens=${mergedConfig.advancedSettings.maxOutputTokens}, timeout=${mergedConfig.advancedSettings.translationTimeout}s, maxRetries=${mergedConfig.advancedSettings.maxRetries}, sendTimestampsToAI=${mergedConfig.advancedSettings.sendTimestampsToAI ? 'enabled' : 'disabled'}`);

  // Guardrail: if OpenSubtitles Auth is selected without credentials, fall back to V3 to avoid runtime auth errors
  const openSubConfig = mergedConfig.subtitleProviders?.opensubtitles;
  if (openSubConfig) {
    const normalizeCredential = (value) => {
      if (value === undefined || value === null) return '';
      // Accept non-string values but always coerce to string to prevent trim() type errors
      const normalized = String(value).trim();
      // Extra safeguard: reject values that look like failed JSON serialization
      if (normalized === '[object Object]' || normalized === '[object Array]') {
        log.warn(() => `[Config] OpenSubtitles credential appears to be a serialized object, clearing it`);
        return '';
      }
      return normalized;
    };
    openSubConfig.username = normalizeCredential(openSubConfig.username);
    openSubConfig.password = normalizeCredential(openSubConfig.password);
    const wantsAuth = openSubConfig.implementationType === 'auth';
    const missingCreds = !openSubConfig.username || !openSubConfig.password;
    if (wantsAuth && missingCreds) {
      log.warn(() => '[Config] OpenSubtitles Auth selected without credentials; switching to V3 (no login required).');
      // Preserve the username/password fields even when switching to V3 so they're not lost
      mergedConfig.subtitleProviders.opensubtitles = {
        ...openSubConfig,
        implementationType: 'v3',
        // Keep username/password in config even when using V3, so user can switch back to Auth without re-entering
        username: openSubConfig.username,
        password: openSubConfig.password
      };
    }
  }

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

  // Backfill new provider parameters with defaults
  newConfig.providerParameters = { ...defaults.providerParameters };

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
 * Model-specific default configurations
 * Each model has its own optimal settings for thinking and temperature
 */
const MODEL_SPECIFIC_DEFAULTS = {
  'gemini-flash-lite-latest': {
    thinkingBudget: 0,      // No thinking for lite model
    temperature: 0.8        // Higher temperature for creativity
  },
  'gemini-flash-latest': {
    thinkingBudget: -1,     // Dynamic thinking for flash model
    temperature: 0.5        // Lower temperature for consistency
  },
  'gemini-2.5-flash-lite-preview-09-2025': {
    thinkingBudget: 0,      // No thinking for lite model
    temperature: 0.8        // Higher temperature for creativity
  },
  'gemini-2.5-flash-preview-09-2025': {
    thinkingBudget: -1,     // Dynamic thinking for flash model
    temperature: 0.5        // Lower temperature for consistency
  },
  'gemini-2.5-pro': {
    thinkingBudget: 0,      // No thinking for pro model (faster)
    temperature: 0.5        // Lower temperature for consistency
  }
};

/**
 * Get model-specific defaults for thinking and temperature
 * @param {string} modelName - The Gemini model name
 * @returns {Object} - Model-specific settings { thinkingBudget, temperature }
 */
function getModelSpecificDefaults(modelName) {
  return MODEL_SPECIFIC_DEFAULTS[modelName] || {
    thinkingBudget: 0,
    temperature: 0.8
  };
}

/**
 * Get default configuration
 * @param {string} modelName - Optional model name to get model-specific defaults
 * @returns {Object} - Default configuration
 */
function getDefaultConfig(modelName = null) {
  // Determine the model to use for defaults
  const effectiveModel = modelName || process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const modelDefaults = getModelSpecificDefaults(effectiveModel);

  // Read advanced settings from environment variables with fallback to model-specific defaults
  const advancedSettings = {
    maxOutputTokens: parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 65536,
    chunkSize: 12000,
    translationTimeout: parseInt(process.env.GEMINI_TRANSLATION_TIMEOUT) || 600, // seconds
    maxRetries: process.env.GEMINI_MAX_RETRIES !== undefined ? parseInt(process.env.GEMINI_MAX_RETRIES) : 3,
    // When enabled, trust the AI to return timestamps for each batch instead of reusing originals
    sendTimestampsToAI: process.env.SEND_TIMESTAMPS_TO_AI === 'true',
    // Extended thinking (priority: .env > model-specific > global default)
    thinkingBudget: process.env.GEMINI_THINKING_BUDGET !== undefined
      ? parseInt(process.env.GEMINI_THINKING_BUDGET)
      : modelDefaults.thinkingBudget,
    // Sampling parameters (priority: .env > model-specific > global default)
    temperature: process.env.GEMINI_TEMPERATURE !== undefined
      ? parseFloat(process.env.GEMINI_TEMPERATURE)
      : modelDefaults.temperature,
    topK: process.env.GEMINI_TOP_K !== undefined ? parseInt(process.env.GEMINI_TOP_K) : 40,
    topP: process.env.GEMINI_TOP_P !== undefined ? parseFloat(process.env.GEMINI_TOP_P) : 0.95,
    // Batch context: Include original surrounding context and previous translations for better coherence
    // Disabled by default for performance (can be enabled for improved translation quality)
    enableBatchContext: process.env.ENABLE_BATCH_CONTEXT === 'true' ? true : false,
    contextSize: parseInt(process.env.BATCH_CONTEXT_SIZE) || 3 // Number of surrounding entries to include as context
  };

  // UI/results limits
  // Limit the number of subtitles returned per language in the list to avoid UI slowdown
  // Clamp to a safe range [1, 50] with default 12
  const envSubsPerLang = parseInt(process.env.MAX_SUBTITLES_PER_LANGUAGE, 10);
  const maxSubtitlesPerLanguage = (Number.isFinite(envSubsPerLang) && envSubsPerLang > 0)
    ? Math.min(50, envSubsPerLang)
    : 12;

  return {
    noTranslationMode: false, // If true, skip translation and just fetch subtitles
    noTranslationLanguages: [], // Languages to fetch when in no-translation mode
    sourceLanguages: [],
    targetLanguages: [],
    // Learn Mode: create dual-language WebVTT entries
    learnMode: false,
    learnTargetLanguages: [],
    learnOrder: 'source-top',
    learnPlacement: 'top', // default: pin top language at top of screen
    geminiApiKey: '',
    // Use effective model (from parameter, env variable, or default)
    geminiModel: effectiveModel,
    multiProviderEnabled: false,
    mainProvider: 'gemini',
    secondaryProviderEnabled: false,
    secondaryProvider: '',
    providers: {
      openai: { enabled: false, apiKey: '', model: '' },
      anthropic: { enabled: false, apiKey: '', model: '' },
      xai: { enabled: false, apiKey: '', model: '' },
      deepseek: { enabled: false, apiKey: '', model: '' },
      deepl: { enabled: false, apiKey: '', model: '' },
      mistral: { enabled: false, apiKey: '', model: '' },
      cfworkers: { enabled: false, apiKey: '', model: '' },
      openrouter: { enabled: false, apiKey: '', model: '' }
    },
    providerParameters: getDefaultProviderParameters(),
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
    mobileMode: false, // Hold translation responses until full translation is ready (Android cache workaround)
    singleBatchMode: false, // Translate whole file at once (streaming partials)
    // Minimum size for a subtitle file to be considered valid (bytes)
    // Prevents attempting to load/translate obviously broken files
    minSubtitleSizeBytes: 200,
    // Maximum number of subtitles to display per language in Stremio UI
    // Configurable via env var MAX_SUBTITLES_PER_LANGUAGE (default 12, max 50)
    maxSubtitlesPerLanguage,
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

  const { maxSourceLanguages, maxTargetLanguages, maxNoTranslationLanguages } = getLanguageSelectionLimits();
  const multiEnabled = config.multiProviderEnabled === true;
  const mainProvider = String(multiEnabled ? (config.mainProvider || 'gemini') : 'gemini').toLowerCase();
  const resolveProviderConfig = (key) => {
    const providers = config.providers || {};
    if (providers[key]) return providers[key];
    const match = Object.keys(providers).find(k => String(k).toLowerCase() === String(key).toLowerCase());
    return match ? providers[match] : null;
  };

  const geminiConfigured = !!(config.geminiApiKey && config.geminiApiKey.trim() !== '' && config.geminiModel && config.geminiModel.trim() !== '');
  const providerIsConfigured = (key) => {
    const cfg = resolveProviderConfig(key);
    return !!(cfg && cfg.enabled === true && cfg.apiKey && String(cfg.apiKey).trim() !== '' && cfg.model && String(cfg.model).trim() !== '');
  };

  const configuredProviders = new Set();
  if (geminiConfigured) configuredProviders.add('gemini');
  Object.keys(config.providers || {}).forEach(key => {
    if (providerIsConfigured(key)) {
      configuredProviders.add(String(key).toLowerCase());
    }
  });

  // Main provider must always be fully configured so we have at least one AI provider available
  if (!mainProvider) {
    errors.push('Main provider must be selected');
  } else if (mainProvider === 'gemini') {
    if (!geminiConfigured) {
      errors.push('Gemini API key and model are required for the main provider');
    }
  } else {
    if (!providerIsConfigured(mainProvider)) {
      errors.push(`API key, model, and enabled status are required for main provider '${mainProvider}'`);
    }
  }

  // Secondary provider requires a second configured provider and explicit selection
  if (multiEnabled && config.secondaryProviderEnabled === true) {
    const secondaryKey = String(config.secondaryProvider || '').toLowerCase();
    if (!secondaryKey) {
      errors.push('Secondary provider must be selected when enabled');
    } else if (secondaryKey === mainProvider) {
      errors.push('Secondary provider must be different from main provider');
    } else if (secondaryKey === 'gemini') {
      if (!geminiConfigured) {
        errors.push('Gemini API key and model are required for the secondary provider');
      }
    } else if (!providerIsConfigured(secondaryKey)) {
      errors.push(`API key, model, and enabled status are required for secondary provider '${secondaryKey}'`);
    }
  }

  // Require at least one configured AI provider overall
  if (configuredProviders.size === 0) {
    errors.push('At least one AI provider must be enabled with an API key and model');
  }

  // When secondary is enabled, ensure we truly have two configured providers (main + fallback)
  if (multiEnabled && config.secondaryProviderEnabled === true && configuredProviders.size < 2) {
    errors.push('Secondary Provider requires two configured AI providers with API keys');
  }

  if (config.noTranslationMode) {
    if (!config.noTranslationLanguages || config.noTranslationLanguages.length === 0) {
      errors.push('At least one no-translation language must be selected');
    }
    if (config.noTranslationLanguages && config.noTranslationLanguages.length > maxNoTranslationLanguages) {
      errors.push(`Maximum of ${maxNoTranslationLanguages} no-translation languages allowed`);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  if (!config.sourceLanguages || config.sourceLanguages.length === 0) {
    errors.push('At least one source language must be selected');
  }

  if (config.sourceLanguages && config.sourceLanguages.length > maxSourceLanguages) {
    errors.push(`Maximum of ${maxSourceLanguages} source languages allowed`);
  }

  if (!config.targetLanguages || config.targetLanguages.length === 0) {
    errors.push('At least one target language must be selected');
  }

  const combinedTargets = new Set([
    ...(config.targetLanguages || []),
    ...(config.learnTargetLanguages || [])
  ]);
  if (combinedTargets.size > maxTargetLanguages) {
    errors.push(`Maximum of ${maxTargetLanguages} total target languages allowed (including Learn Mode)`);
  }

  if (config.noTranslationLanguages && config.noTranslationLanguages.length > maxNoTranslationLanguages) {
    errors.push(`Maximum of ${maxNoTranslationLanguages} no-translation languages allowed`);
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

    const providerLabel = (() => {
      if (config.multiProviderEnabled && config.mainProvider && config.mainProvider !== 'gemini') {
        const key = String(config.mainProvider).toLowerCase();
        const labels = {
          openai: 'OpenAI',
          anthropic: 'Anthropic',
          xai: 'XAI',
          deepseek: 'DeepSeek',
          deepl: 'DeepL',
          mistral: 'Mistral',
          cfworkers: 'Cloudflare Workers AI',
          openrouter: 'OpenRouter'
        };
        return labels[key] || key.charAt(0).toUpperCase() + key.slice(1);
      }
      return 'Gemini';
    })();

    description = `Fetches subtitles from OpenSubtitles and translates them using ${providerLabel} AI.\n\nSource languages: ${sourceLanguageNames}\nTarget languages: ${targetLanguageNames}`;
  }

  // Check if this is a configured instance (has API key)
  const geminiConfigured = config.geminiApiKey && config.geminiApiKey.trim() !== '' &&
    config.geminiModel && String(config.geminiModel).trim() !== '';
  const providerIsConfigured = (key) => {
    const providers = config.providers || {};
    const matchKey = Object.keys(providers).find(k => String(k).toLowerCase() === String(key).toLowerCase()) || key;
    const cfg = providers[matchKey];
    return !!(cfg && cfg.enabled && cfg.apiKey && String(cfg.apiKey).trim() !== '' && cfg.model);
  };
  const configuredProviders = new Set();
  if (geminiConfigured) configuredProviders.add('gemini');
  Object.keys(config.providers || {}).forEach(key => {
    if (providerIsConfigured(key)) {
      configuredProviders.add(String(key).toLowerCase());
    }
  });
  const mainProviderKey = config.multiProviderEnabled
    ? String(config.mainProvider || 'gemini').toLowerCase()
    : 'gemini';
  const mainConfigured = mainProviderKey === 'gemini'
    ? geminiConfigured
    : providerIsConfigured(mainProviderKey);
  let isConfigured = mainConfigured || configuredProviders.size > 0;

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
  getModelSpecificDefaults,
  validateConfig,
  buildManifest,
  // Exported for async token resolution paths in routes
  normalizeConfig,
  getLanguageSelectionLimits,
  getDefaultProviderParameters,
  mergeProviderParameters
};
