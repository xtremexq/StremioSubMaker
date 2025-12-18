const { DEFAULT_TRANSLATION_PROMPT } = require('../services/gemini');
const DEFAULT_API_KEYS = require('../config/defaultApiKeys');
const { getSessionManager } = require('./sessionManager');
const { StorageUnavailableError } = require('../storage/errors');
const log = require('./logger');
const { getTranslator } = require('./i18n');
const { redactApiKey } = require('./security');

// Language selection limits (configurable via environment)
const DEFAULT_SOURCE_LANGUAGE_LIMIT = 3;
const DEFAULT_TARGET_LANGUAGE_LIMIT = 6;
const DEFAULT_NO_TRANSLATION_LANGUAGE_LIMIT = 9;
const KEY_OPTIONAL_PROVIDERS = new Set(['googletranslate']);
const GEMINI_LOG_INTERVAL_MS = parseInt(process.env.GEMINI_CONFIG_LOG_INTERVAL_MS || `${5 * 60 * 1000}`, 10);
let lastGeminiConfigLog = 0;
let suppressedGeminiConfigLogs = 0;

// Maximum number of Gemini API keys allowed in rotation (configurable via env, default 5)
const MAX_GEMINI_API_KEYS = parseInt(process.env.MAX_GEMINI_API_KEYS, 10) || 5;

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
  },
  googletranslate: {
    temperature: 0,
    topP: 1,
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
      thinkingBudget: (() => {
        const requested = Number.isFinite(parseInt(raw?.thinkingBudget, 10))
          ? parseInt(raw.thinkingBudget, 10)
          : NaN;
        const fallback = Number.isFinite(parseInt(base.thinkingBudget, 10))
          ? parseInt(base.thinkingBudget, 10)
          : 0;
        const chosen = Number.isFinite(requested) ? requested : fallback;
        return Math.max(-1, Math.min(200000, chosen));
      })(),
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

function logGeminiConfigThrottled(mergedConfig) {
  const now = Date.now();
  if (now - lastGeminiConfigLog < GEMINI_LOG_INTERVAL_MS) {
    suppressedGeminiConfigLogs += 1;
    return;
  }
  lastGeminiConfigLog = now;
  const suppressed = suppressedGeminiConfigLogs;
  suppressedGeminiConfigLogs = 0;

  const thinkingDisplay = (() => {
    const val = mergedConfig.advancedSettings?.thinkingBudget;
    if (val === undefined || val === null) return 'dynamic';
    if (Number(val) === 0) return 'disabled';
    return val;
  })();

  const suffix = suppressed > 0 ? ` (suppressed ${suppressed} duplicate logs)` : '';
  log.debug(() => `[Config] Gemini API config: model=${mergedConfig.geminiModel}, temperature=${mergedConfig.advancedSettings.temperature}, topK=${mergedConfig.advancedSettings.topK}, topP=${mergedConfig.advancedSettings.topP}, thinkingBudget=${thinkingDisplay}, maxOutputTokens=${mergedConfig.advancedSettings.maxOutputTokens}, timeout=${mergedConfig.advancedSettings.translationTimeout}s, maxRetries=${mergedConfig.advancedSettings.maxRetries}, sendTimestampsToAI=${mergedConfig.advancedSettings.sendTimestampsToAI ? 'enabled' : 'disabled'}${suffix}`);
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
 * @param {Object} options - Options { allowBase64: boolean }
 * @returns {Promise<Object>} - Parsed configuration
 */
async function parseConfig(configStr, options = {}) {
  try {
    if (!configStr) {
      return getDefaultConfig();
    }

    const allowBase64 = options.allowBase64 === true || process.env.ALLOW_BASE64_CONFIG === 'true';
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

    // Allow legacy base64 configs only when explicitly enabled
    if (allowBase64) {
      return parseBase64Config(configStr);
    }

    // Production mode: reject base64 configs
    log.warn(() => '[Config] Base64 configs not allowed in production mode. Use session tokens.');
    return getDefaultConfig();

  } catch (error) {
    if (error instanceof StorageUnavailableError) {
      throw error;
    }
    log.error(() => ['[Config] Unexpected error during config parsing:', error.message]);
    return getDefaultConfig();
  }
}

/**
 * Normalize base64/base64url strings by restoring standard characters and padding
 * @param {string} input - Base64 or base64url string
 * @returns {string} - Normalized base64 string
 */
function normalizeBase64Input(input) {
  if (!input || typeof input !== 'string') return input;
  let normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4;
  if (padding) {
    normalized += '='.repeat(4 - padding);
  }
  return normalized;
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
      const normalized = normalizeBase64Input(configStr);
      decoded = Buffer.from(normalized, 'base64').toString('utf-8');
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
    },
    autoSubs: {
      ...defaults.autoSubs,
      ...(config.autoSubs || {})
    }
  };

  // Force Learn Mode placement to top-of-screen now that the UI no longer exposes this toggle
  mergedConfig.learnPlacement = 'top';

  // Strip out UI-only/fake languages that might have been saved accidentally
  mergedConfig.sourceLanguages = sanitizeLanguages(mergedConfig.sourceLanguages);
  mergedConfig.targetLanguages = sanitizeLanguages(mergedConfig.targetLanguages);
  mergedConfig.noTranslationLanguages = sanitizeLanguages(mergedConfig.noTranslationLanguages);
  mergedConfig.learnTargetLanguages = sanitizeLanguages(mergedConfig.learnTargetLanguages);
  mergedConfig.uiLanguage = (() => {
    const lang = (config.uiLanguage || defaults.uiLanguage || 'en').toString().trim().toLowerCase();
    return lang || 'en';
  })();

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
  const legacyToolboxEnabled = mergedConfig.fileTranslationEnabled === true || mergedConfig.syncSubtitlesEnabled === true;
  mergedConfig.subToolboxEnabled = mergedConfig.subToolboxEnabled === true || legacyToolboxEnabled;
  mergedConfig.fileTranslationEnabled = mergedConfig.subToolboxEnabled === true;
  mergedConfig.syncSubtitlesEnabled = mergedConfig.subToolboxEnabled === true;
  mergedConfig.singleBatchMode = mergedConfig.singleBatchMode === true;
  mergedConfig.multiProviderEnabled = mergedConfig.multiProviderEnabled === true;
  mergedConfig.excludeHearingImpairedSubtitles = mergedConfig.excludeHearingImpairedSubtitles === true;
  const advSettings = mergedConfig.advancedSettings || {};
  mergedConfig.advancedSettings = {
    ...advSettings,
    enabled: advSettings.enabled === true,
    sendTimestampsToAI: advSettings.sendTimestampsToAI === true
  };

  if (mergedConfig.noTranslationLanguages.length > maxNoTranslationLanguages) {
    mergedConfig.noTranslationLanguages = mergedConfig.noTranslationLanguages.slice(0, maxNoTranslationLanguages);
  }

  // Normalize Gemini API key rotation fields
  mergedConfig.geminiKeyRotationEnabled = mergedConfig.geminiKeyRotationEnabled === true;

  // Sanitize geminiApiKeys array: trim whitespace, remove empty strings, dedupe, enforce max limit
  const rawKeys = Array.isArray(mergedConfig.geminiApiKeys) ? mergedConfig.geminiApiKeys : [];
  const seenKeys = new Set();
  const sanitizedKeys = [];
  for (const key of rawKeys) {
    const trimmed = typeof key === 'string' ? key.trim() : '';
    if (trimmed && !seenKeys.has(trimmed)) {
      seenKeys.add(trimmed);
      sanitizedKeys.push(trimmed);
      if (sanitizedKeys.length >= MAX_GEMINI_API_KEYS) break;
    }
  }

  // Migration: if geminiApiKeys is empty but geminiApiKey exists, seed the array
  const singleKey = typeof mergedConfig.geminiApiKey === 'string' ? mergedConfig.geminiApiKey.trim() : '';
  if (sanitizedKeys.length === 0 && singleKey) {
    sanitizedKeys.push(singleKey);
  }

  mergedConfig.geminiApiKeys = sanitizedKeys;

  // Backward compat: keep geminiApiKey synced to first non-empty key from array
  // This ensures legacy code paths still work
  if (mergedConfig.geminiKeyRotationEnabled && sanitizedKeys.length > 0) {
    mergedConfig.geminiApiKey = sanitizedKeys[0];
  } else if (!singleKey && sanitizedKeys.length > 0) {
    // If user cleared single key but has array, use first from array
    mergedConfig.geminiApiKey = sanitizedKeys[0];
  } else {
    mergedConfig.geminiApiKey = singleKey;
  }

  // Normalize rotation mode - only allow valid values
  const validRotationModes = ['per-request', 'per-batch'];
  if (!validRotationModes.includes(mergedConfig.geminiKeyRotationMode)) {
    mergedConfig.geminiKeyRotationMode = 'per-request';
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
    if (KEY_OPTIONAL_PROVIDERS.has(String(resolved).toLowerCase())) {
      return cfg.enabled === true;
    }
    return !!(cfg.enabled && cfg.apiKey && cfg.model);
  };
  const firstConfiguredProvider = () => {
    const entry = Object.entries(mergedConfig.providers || {}).find(([key, cfg]) => {
      if (!cfg || cfg.enabled !== true) return false;
      const isKeyOptional = KEY_OPTIONAL_PROVIDERS.has(String(key).toLowerCase());
      return isKeyOptional || (cfg.apiKey && cfg.model);
    });
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

  // Normalize auto-subs defaults and feature flags
  const allowedAutoModes = new Set(['cloudflare', 'assemblyai', 'local']);
  const requestedMode = (mergedConfig.autoSubs?.defaultMode || defaults.autoSubs.defaultMode || 'cloudflare')
    .toString()
    .toLowerCase();
  mergedConfig.autoSubs = mergedConfig.autoSubs || {};
  mergedConfig.autoSubs.defaultMode = allowedAutoModes.has(requestedMode) ? requestedMode : defaults.autoSubs.defaultMode;
  mergedConfig.autoSubs.sendFullVideoToAssembly = mergedConfig.autoSubs.sendFullVideoToAssembly === true;
  mergedConfig.otherApiKeysEnabled = true;

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
      const fallbackKey = resolveProviderKey(mergedConfig.secondaryProvider);
      const validFallback = providerIsConfigured(fallbackKey);
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

  // Show all Gemini API configs that will be used (throttled to avoid spam on polling endpoints)
  logGeminiConfigThrottled(mergedConfig);

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
    // Normalize implementation type for legacy configs (default to v3)
    const impl = typeof openSubConfig.implementationType === 'string'
      ? openSubConfig.implementationType.trim().toLowerCase()
      : '';
    openSubConfig.implementationType = impl || 'v3';
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
  'gemini-2.5-flash-lite-preview-09-2025': {
    thinkingBudget: 0,      // No thinking for lite model
    temperature: 0.8        // Higher temperature for creativity
  },
  'gemini-2.5-flash-preview-09-2025': {
    thinkingBudget: -1,     // Dynamic thinking for flash model
    temperature: 0.5        // Lower temperature for consistency
  },
  'gemini-3-flash-preview': {
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
  const effectiveModel = modelName || process.env.GEMINI_MODEL || 'gemini-2.5-flash-preview-09-2025';
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
    // UI language for all addon pages/subtitles
    uiLanguage: process.env.UI_LANGUAGE_DEFAULT || 'en',
    // Learn Mode: create dual-language WebVTT entries
    learnMode: false,
    learnTargetLanguages: [],
    learnOrder: 'source-top',
    learnPlacement: 'top', // default: pin top language at top of screen
    geminiApiKey: '',
    // Gemini API key rotation: allows multiple keys to be cycled for load distribution
    geminiKeyRotationEnabled: false,
    geminiApiKeys: [], // Array of API keys to rotate through
    geminiKeyRotationMode: 'per-request', // 'per-request' = rotate once per file, 'per-batch' = rotate for each batch
    assemblyAiApiKey: DEFAULT_API_KEYS.ASSEMBLYAI || '',
    cloudflareWorkersApiKey: DEFAULT_API_KEYS.CF_WORKERS_AUTOSUBS || '',
    otherApiKeysEnabled: true,
    autoSubs: {
      defaultMode: 'cloudflare',
      sendFullVideoToAssembly: false
    },
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
      openrouter: { enabled: false, apiKey: '', model: '' },
      googletranslate: { enabled: false, apiKey: '', model: 'web' }
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
    subToolboxEnabled: false, // unified toolbox entry for file translation, sync, and upcoming tools
    fileTranslationEnabled: false, // legacy flag (mirrors subToolboxEnabled)
    syncSubtitlesEnabled: false, // legacy flag (mirrors subToolboxEnabled)
    // If true, filter out SDH/HI (hearing impaired) subtitles from provider results
    excludeHearingImpairedSubtitles: false,
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
  const t = getTranslator(config?.uiLanguage || 'en');

  if (!config) {
    errors.push(t('validation.configRequired', {}, 'Configuration is required'));
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

  // Check if Gemini is properly configured (handles both single key and rotation modes)
  const geminiConfigured = (() => {
    const hasModel = !!(config.geminiModel && config.geminiModel.trim() !== '');
    if (!hasModel) return false;

    // When rotation is enabled, check the keys array
    if (config.geminiKeyRotationEnabled === true) {
      const keys = Array.isArray(config.geminiApiKeys)
        ? config.geminiApiKeys.filter(k => typeof k === 'string' && k.trim() !== '')
        : [];
      return keys.length > 0;
    }

    // Single key mode
    return !!(config.geminiApiKey && config.geminiApiKey.trim() !== '');
  })();
  const providerIsConfigured = (key) => {
    const cfg = resolveProviderConfig(key);
    if (!cfg || cfg.enabled !== true) return false;
    if (KEY_OPTIONAL_PROVIDERS.has(String(key).toLowerCase())) {
      return true;
    }
    return !!(cfg.apiKey && String(cfg.apiKey).trim() !== '' && cfg.model && String(cfg.model).trim() !== '');
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
    errors.push(t('validation.mainProviderMissing', {}, 'Main provider must be selected'));
  } else if (mainProvider === 'gemini') {
    if (!geminiConfigured) {
      errors.push(t('validation.mainProviderGeminiMissing', {}, 'Gemini API key and model are required for the main provider'));
    }
  } else {
    if (!providerIsConfigured(mainProvider)) {
      errors.push(t('validation.mainProviderConfigured', { provider: mainProvider }, `API key, model, and enabled status are required for main provider '${mainProvider}'`));
    }
  }

  // Secondary provider requires a second configured provider and explicit selection
  if (multiEnabled && config.secondaryProviderEnabled === true) {
    const secondaryKey = String(config.secondaryProvider || '').toLowerCase();
    if (!secondaryKey) {
      errors.push(t('validation.secondaryMissing', {}, 'Secondary provider must be selected when enabled'));
    } else if (secondaryKey === mainProvider) {
      errors.push(t('validation.secondaryDifferent', {}, 'Secondary provider must be different from main provider'));
    } else if (secondaryKey === 'gemini') {
      if (!geminiConfigured) {
        errors.push(t('validation.secondaryGemini', {}, 'Gemini API key and model are required for the secondary provider'));
      }
    } else if (!providerIsConfigured(secondaryKey)) {
      errors.push(t('validation.secondaryConfigured', { provider: secondaryKey }, `API key, model, and enabled status are required for secondary provider '${secondaryKey}'`));
    }
  }

  // Require at least one configured AI provider overall
  if (configuredProviders.size === 0) {
    errors.push(t('validation.atLeastOneProvider', {}, 'At least one AI provider must be enabled with an API key and model'));
  }

  // When secondary is enabled, ensure we truly have two configured providers (main + fallback)
  if (multiEnabled && config.secondaryProviderEnabled === true && configuredProviders.size < 2) {
    errors.push(t('validation.secondaryTwoProviders', {}, 'Secondary Provider requires two configured AI providers with API keys'));
  }

  if (config.noTranslationMode) {
    if (!config.noTranslationLanguages || config.noTranslationLanguages.length === 0) {
      errors.push(t('validation.noTranslationMissing', {}, 'At least one no-translation language must be selected'));
    }
    if (config.noTranslationLanguages && config.noTranslationLanguages.length > maxNoTranslationLanguages) {
      errors.push(t('validation.noTranslationLimit', { limit: maxNoTranslationLanguages }, `Maximum of ${maxNoTranslationLanguages} no-translation languages allowed`));
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  if (!config.sourceLanguages || config.sourceLanguages.length === 0) {
    errors.push(t('validation.sourceMissing', {}, 'At least one source language must be selected'));
  }

  if (config.sourceLanguages && config.sourceLanguages.length > maxSourceLanguages) {
    errors.push(t('validation.sourceLimit', { limit: maxSourceLanguages }, `Maximum of ${maxSourceLanguages} source languages allowed`));
  }

  if (!config.targetLanguages || config.targetLanguages.length === 0) {
    errors.push(t('validation.targetMissing', {}, 'At least one target language must be selected'));
  }

  const combinedTargets = new Set([
    ...(config.targetLanguages || []),
    ...(config.learnTargetLanguages || [])
  ]);
  if (combinedTargets.size > maxTargetLanguages) {
    errors.push(t('validation.targetLimit', { limit: maxTargetLanguages }, `Maximum of ${maxTargetLanguages} total target languages allowed (including Learn Mode)`));
  }

  if (config.noTranslationLanguages && config.noTranslationLanguages.length > maxNoTranslationLanguages) {
    errors.push(t('validation.noTranslationLimit', { limit: maxNoTranslationLanguages }, `Maximum of ${maxNoTranslationLanguages} no-translation languages allowed`));
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
  const hasSessionTokenError = config.__sessionTokenError === true;
  const t = getTranslator((config && config.uiLanguage) || 'en');

  let sourceLanguageNames;
  let targetLanguageNames;
  let description;

  if (hasSessionTokenError) {
    sourceLanguageNames = 'ERROR';
    targetLanguageNames = 'ERROR';
    description = t('validation.sessionTokenError', {}, 'Configuration Error: Session token not found or expired.\n\nPlease reconfigure the addon to continue using it.');
  } else {
    sourceLanguageNames = (config.sourceLanguages || [])
      .map(code => code.toUpperCase())
      .join(', ');

    targetLanguageNames = (config.targetLanguages || [])
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
          openrouter: 'OpenRouter',
          googletranslate: 'Google Translate (unofficial)'
        };
        return labels[key] || key.charAt(0).toUpperCase() + key.slice(1);
      }
      return 'Gemini';
    })();

    description = t('manifest.description', {
      provider: `${providerLabel} AI`,
      sources: sourceLanguageNames || 'N/A',
      targets: targetLanguageNames || 'N/A'
    }, `Take control of your subtitles! Fetch and translate subtitles from OpenSubtitles, SubScene and SubDL with a free Gemini AI key or other AI providers, without ever leaving Stremio.\n\nSource languages: ${sourceLanguageNames}\nTarget languages: ${targetLanguageNames}`);
  }

  const geminiConfigured = config.geminiApiKey && config.geminiApiKey.trim() !== '' &&
    config.geminiModel && String(config.geminiModel).trim() !== '';
  const providerIsConfigured = (key) => {
    const providers = config.providers || {};
    const matchKey = Object.keys(providers).find(k => String(k).toLowerCase() === String(key).toLowerCase()) || key;
    const cfg = providers[matchKey];
    if (!cfg || cfg.enabled !== true) return false;
    if (KEY_OPTIONAL_PROVIDERS.has(String(key).toLowerCase())) {
      return true;
    }
    return !!(cfg.apiKey && String(cfg.apiKey).trim() !== '' && cfg.model);
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

  const logo = baseUrl ? `${baseUrl}/logo.png` : 'https://i.imgur.com/5qJc5Y5.png';
  const background = baseUrl ? `${baseUrl}/background.svg` : 'https://i.imgur.com/5qJc5Y5.png';

  const isElfHosted = process.env.ELFHOSTED === 'true';
  const addonName = isElfHosted
    ? 'SubMaker | ElfHosted'
    : t('manifest.name', {}, 'SubMaker - Subtitle Translator');

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
    icon: logo,
    background: background,

    contactEmail: 'support@submaker.example.com'
  };
}

// In-memory fallback counters for filesystem mode (keyed by configHash)
const memoryRotationCounters = new Map();

/**
 * Select a Gemini API key from config using per-user sequential rotation.
 * 
 * When rotation is enabled and there are multiple keys, uses Redis INCR for
 * atomic sequential rotation per user (identified by config hash). This ensures:
 * - Multi-instance safe: Redis stores the shared counter across all instances
 * - Sequential: Each call increments and picks the next key in order
 * - Per-user: Each user has their own independent rotation counter
 * - Resource-light: Single Redis INCR per call (atomic, O(1), negligible cost)
 * 
 * Falls back to in-memory counters per configHash for filesystem mode.
 * 
 * @param {Object} config - Normalized configuration
 * @returns {Promise<string>} - Selected API key (may be empty if none configured)
 */
async function selectGeminiApiKey(config) {
  if (!config) return '';

  // If rotation is enabled and we have keys in the array
  if (config.geminiKeyRotationEnabled === true) {
    const keys = Array.isArray(config.geminiApiKeys)
      ? config.geminiApiKeys.filter(k => typeof k === 'string' && k.trim() !== '')
      : [];

    if (keys.length > 0) {
      // Get the user's config hash for per-user rotation
      const configHash = config.__configHash || 'default';
      let counter = 0;

      try {
        // Try to use Redis for multi-instance safe rotation
        const StorageFactory = require('../storage/StorageFactory');
        const adapter = await StorageFactory.getStorageAdapter();

        // Check if this is a Redis adapter by checking for the client property
        if (adapter && adapter.client && typeof adapter.client.incr === 'function') {
          // Use Redis INCR for atomic sequential rotation
          const redisKey = `keyrotation:${configHash}`;
          counter = await adapter.client.incr(redisKey);
          // Set a TTL of 24 hours to auto-cleanup old counters
          await adapter.client.expire(redisKey, 86400);
        } else {
          // Filesystem mode: use in-memory counter per configHash
          counter = (memoryRotationCounters.get(configHash) || 0) + 1;
          memoryRotationCounters.set(configHash, counter);
        }
      } catch (err) {
        // If Redis fails, fall back to in-memory counter
        log.warn(() => `[Config] Redis key rotation counter failed, using in-memory: ${err.message}`);
        counter = (memoryRotationCounters.get(configHash) || 0) + 1;
        memoryRotationCounters.set(configHash, counter);
      }

      // Sequential round-robin: counter modulo number of keys
      const keyIndex = (counter - 1) % keys.length;
      const selectedKey = keys[keyIndex];
      log.info(() => `[Gemini] Key rotation: using key ${keyIndex + 1} of ${keys.length} (${redactApiKey(selectedKey)})`);
      return selectedKey;
    }
  }

  // Fallback to single key
  return config.geminiApiKey || '';
}

/**
 * Get the maximum number of Gemini API keys allowed
 * @returns {number}
 */
function getMaxGeminiApiKeys() {
  return MAX_GEMINI_API_KEYS;
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
  mergeProviderParameters,
  // Gemini key rotation
  selectGeminiApiKey,
  getMaxGeminiApiKeys,
  MAX_GEMINI_API_KEYS
};
