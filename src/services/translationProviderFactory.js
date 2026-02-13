const GeminiService = require('./gemini');
const OpenAICompatibleProvider = require('./providers/openaiCompatible');
const AnthropicProvider = require('./providers/anthropic');
const DeepLProvider = require('./providers/deepl');
const GoogleTranslateProvider = require('./providers/googleTranslate');
const log = require('../utils/logger');
const { validateCustomBaseUrl, areInternalEndpointsAllowed, createSsrfSafeLookup } = require('../utils/ssrfProtection');
const { getDefaultProviderParameters, mergeProviderParameters, selectGeminiApiKey } = require('../utils/config');

const KEY_OPTIONAL_PROVIDERS = new Set(['googletranslate']);

class FallbackTranslationProvider {
  constructor(primaryProvider, fallbackProvider, meta = {}) {
    this.primary = primaryProvider;
    this.fallback = fallbackProvider;
    this.primaryName = meta.primaryName || 'primary';
    this.fallbackName = meta.fallbackName || 'secondary';
  }

  formatError(error) {
    if (!error) return 'Unknown error';
    if (error.response?.data?.error?.message) return error.response.data.error.message;
    if (error.response?.data?.message) return error.response.data.message;
    if (error.message) return error.message;
    return String(error);
  }

  buildCombinedError(primaryError, secondaryError) {
    const combinedMessage = `Primary (${this.primaryName}) failed: ${this.formatError(primaryError)}\nSecondary (${this.fallbackName}) failed: ${this.formatError(secondaryError)}`;
    const err = new Error(combinedMessage);
    err.translationErrorType = 'MULTI_PROVIDER';
    err.primaryError = primaryError;
    err.secondaryError = secondaryError;
    err.primaryProvider = this.primaryName;
    err.secondaryProvider = this.fallbackName;
    return err;
  }

  async translateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt = null) {
    try {
      return await this.primary.translateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt);
    } catch (primaryError) {
      if (!this.fallback || typeof this.fallback.translateSubtitle !== 'function') {
        throw primaryError;
      }
      log.warn(() => [`[Providers] Primary ${this.primaryName} failed, trying secondary ${this.fallbackName}:`, this.formatError(primaryError)]);
      try {
        const translated = await this.fallback.translateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt);
        log.info(() => `[Providers] Secondary ${this.fallbackName} succeeded after ${this.primaryName} failure`);
        return translated;
      } catch (secondaryError) {
        log.error(() => [`[Providers] Secondary ${this.fallbackName} also failed:`, this.formatError(secondaryError)]);
        throw this.buildCombinedError(primaryError, secondaryError);
      }
    }
  }

  async streamTranslateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt = null, onPartial = null) {
    if (typeof this.primary.streamTranslateSubtitle === 'function') {
      try {
        return await this.primary.streamTranslateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt, onPartial);
      } catch (primaryError) {
        if (!this.fallback) {
          throw primaryError;
        }
        log.warn(() => `[Providers] Primary ${this.primaryName} stream failed, falling back to ${this.fallbackName} (non-stream)`);
        try {
          const full = await this.fallback.translateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt);
          if (typeof onPartial === 'function') {
            try { await onPartial(full); } catch (_) { }
          }
          log.info(() => `[Providers] Secondary ${this.fallbackName} succeeded after streaming failure on ${this.primaryName}`);
          return full;
        } catch (secondaryError) {
          throw this.buildCombinedError(primaryError, secondaryError);
        }
      }
    }
    // If primary does not support streaming, use translateSubtitle (includes fallback handling)
    return this.translateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt);
  }

  async countTokensForTranslation(...args) {
    if (typeof this.primary.countTokensForTranslation === 'function') {
      return this.primary.countTokensForTranslation(...args);
    }
    if (this.fallback && typeof this.fallback.countTokensForTranslation === 'function') {
      try {
        return await this.fallback.countTokensForTranslation(...args);
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  estimateTokenCount(text) {
    if (typeof this.primary.estimateTokenCount === 'function') {
      return this.primary.estimateTokenCount(text);
    }
    if (this.fallback && typeof this.fallback.estimateTokenCount === 'function') {
      return this.fallback.estimateTokenCount(text);
    }
    if (!text) return 0;
    const approx = Math.ceil(String(text).length / 3);
    return Math.ceil(approx * 1.1);
  }

  buildUserPrompt(subtitleContent, targetLanguage, customPrompt = null) {
    if (typeof this.primary.buildUserPrompt === 'function') {
      return this.primary.buildUserPrompt(subtitleContent, targetLanguage, customPrompt);
    }
    if (this.fallback && typeof this.fallback.buildUserPrompt === 'function') {
      return this.fallback.buildUserPrompt(subtitleContent, targetLanguage, customPrompt);
    }
    return {
      userPrompt: String(customPrompt || ''),
      systemPrompt: '',
      normalizedTarget: targetLanguage || ''
    };
  }
}

function createOpenRouterHeaders() {
  const headers = {};
  if (process.env.OPENROUTER_REFERRER) {
    headers['HTTP-Referer'] = process.env.OPENROUTER_REFERRER;
  }
  if (process.env.OPENROUTER_TITLE) {
    headers['X-Title'] = process.env.OPENROUTER_TITLE;
  }
  return headers;
}

function buildCfWorkersBaseUrl(apiKey) {
  const { accountId, token } = resolveCfWorkersCredentials(apiKey);
  return {
    accountId,
    token
  };
}

function resolveCfWorkersCredentials(rawKey) {
  const cleaned = typeof rawKey === 'string' ? rawKey.trim() : '';
  let accountId = '';
  let token = '';

  if (cleaned) {
    // Accept ACCOUNT|TOKEN (preferred) or ACCOUNT:TOKEN to reduce user friction
    const delimiters = ['|', ':'];
    for (const delim of delimiters) {
      if (cleaned.includes(delim)) {
        const [account, ...rest] = cleaned.split(delim);
        accountId = (account || '').trim();
        token = rest.join(delim).trim();
        break;
      }
    }

    // If no delimiter was found, treat the whole thing as a token
    if (!accountId && !token) {
      token = cleaned;
    }
  }

  // Validate accountId to prevent path traversal / injection in URL construction.
  // Cloudflare account IDs are 32-character lowercase hex strings.
  if (accountId && !/^[a-f0-9]{32}$/.test(accountId)) {
    log.warn(() => `[TranslationProviderFactory] Invalid CF Workers account ID format (expected 32-char hex), rejecting`);
    throw new Error('Invalid Cloudflare Workers account ID format. Expected a 32-character hexadecimal string.');
  }

  return {
    accountId,
    token
  };
}

async function createProviderInstance(providerKey, providerConfig = {}, providerParams = {}, globalOptions = {}) {
  const key = String(providerKey || '').toLowerCase();
  const enableJsonOutput = globalOptions.enableJsonOutput === true;
  switch (key) {
    case 'gemini':
      return new GeminiService(
        providerConfig.apiKey,
        providerConfig.model,
        {
          ...providerParams,
          // Keep compatibility with existing advancedSettings usage
          maxOutputTokens: providerParams.maxOutputTokens,
          translationTimeout: providerParams.translationTimeout,
          maxRetries: providerParams.maxRetries,
          thinkingBudget: providerParams.thinkingBudget,
          temperature: providerParams.temperature,
          topP: providerParams.topP,
          enableJsonOutput
        }
      );
    case 'openai':
      return new OpenAICompatibleProvider({
        apiKey: providerConfig.apiKey,
        model: providerConfig.model,
        providerName: 'openai',
        baseUrl: process.env.OPENAI_API_BASE || 'https://api.openai.com/v1',
        temperature: providerParams.temperature,
        topP: providerParams.topP,
        maxOutputTokens: providerParams.maxOutputTokens,
        translationTimeout: providerParams.translationTimeout,
        maxRetries: providerParams.maxRetries,
        reasoningEffort: providerParams.reasoningEffort,
        enableJsonOutput
      });
    case 'xai':
      return new OpenAICompatibleProvider({
        apiKey: providerConfig.apiKey,
        model: providerConfig.model,
        providerName: 'xai',
        baseUrl: process.env.XAI_API_BASE || 'https://api.x.ai/v1',
        temperature: providerParams.temperature,
        topP: providerParams.topP,
        maxOutputTokens: providerParams.maxOutputTokens,
        translationTimeout: providerParams.translationTimeout,
        maxRetries: providerParams.maxRetries,
        enableJsonOutput
      });
    case 'deepseek':
      return new OpenAICompatibleProvider({
        apiKey: providerConfig.apiKey,
        model: providerConfig.model,
        providerName: 'deepseek',
        baseUrl: process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com/v1',
        temperature: providerParams.temperature,
        topP: providerParams.topP,
        maxOutputTokens: providerParams.maxOutputTokens,
        translationTimeout: providerParams.translationTimeout,
        maxRetries: providerParams.maxRetries,
        enableJsonOutput
      });
    case 'deepl':
      return new DeepLProvider({
        apiKey: providerConfig.apiKey,
        model: providerConfig.model,
        providerName: 'deepl',
        modelType: providerParams.modelType,
        formality: providerParams.formality,
        preserveFormatting: providerParams.preserveFormatting,
        translationTimeout: providerParams.translationTimeout,
        maxRetries: providerParams.maxRetries
      });
    case 'googletranslate':
      return new GoogleTranslateProvider({
        providerName: 'googletranslate',
        translationTimeout: providerParams.translationTimeout,
        maxRetries: providerParams.maxRetries
      });
    case 'mistral':
      return new OpenAICompatibleProvider({
        apiKey: providerConfig.apiKey,
        model: providerConfig.model,
        providerName: 'mistral',
        baseUrl: process.env.MISTRAL_API_BASE || 'https://api.mistral.ai/v1',
        temperature: providerParams.temperature,
        topP: providerParams.topP,
        maxOutputTokens: providerParams.maxOutputTokens,
        translationTimeout: providerParams.translationTimeout,
        maxRetries: providerParams.maxRetries,
        enableJsonOutput
      });
    case 'openrouter':
      return new OpenAICompatibleProvider({
        apiKey: providerConfig.apiKey,
        model: providerConfig.model,
        providerName: 'openrouter',
        baseUrl: process.env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1',
        headers: createOpenRouterHeaders(),
        temperature: providerParams.temperature,
        topP: providerParams.topP,
        maxOutputTokens: providerParams.maxOutputTokens,
        translationTimeout: providerParams.translationTimeout,
        maxRetries: providerParams.maxRetries,
        enableJsonOutput
      });
    case 'cfworkers': {
      const creds = buildCfWorkersBaseUrl(providerConfig.apiKey);
      if (!creds.accountId || !creds.token) {
        log.warn(() => '[Providers] Cloudflare Workers AI requires an account ID and token. Provide as ACCOUNT_ID|TOKEN.');
        return null;
      }
      return new OpenAICompatibleProvider({
        apiKey: creds.token,
        model: providerConfig.model,
        providerName: 'cfWorkers',
        baseUrl: `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/v1`,
        temperature: providerParams.temperature,
        topP: providerParams.topP,
        maxOutputTokens: providerParams.maxOutputTokens,
        translationTimeout: providerParams.translationTimeout,
        maxRetries: providerParams.maxRetries,
        enableJsonOutput
      });
    }
    case 'anthropic':
      return new AnthropicProvider({
        apiKey: providerConfig.apiKey,
        model: providerConfig.model,
        providerName: 'anthropic',
        temperature: providerParams.temperature,
        topP: providerParams.topP,
        maxOutputTokens: providerParams.maxOutputTokens,
        thinkingBudget: providerParams.thinkingBudget,
        translationTimeout: providerParams.translationTimeout,
        maxRetries: providerParams.maxRetries,
        enableJsonOutput
      });
    case 'custom': {
      const baseUrl = providerConfig.baseUrl;
      if (!baseUrl) {
        log.warn(() => '[Providers] Custom provider requires a baseUrl');
        return null;
      }

      // SSRF protection: validate baseUrl is not internal/private (unless allowed)
      // This is async because it performs DNS resolution to defend against DNS rebinding
      const validation = await validateCustomBaseUrl(baseUrl);
      if (!validation.valid) {
        log.warn(() => `[Providers] Custom provider baseUrl blocked: ${validation.error}`);
        return null;
      }

      return new OpenAICompatibleProvider({
        apiKey: providerConfig.apiKey || '',
        model: providerConfig.model,
        providerName: 'custom',
        baseUrl: validation.sanitized,
        temperature: providerParams.temperature,
        topP: providerParams.topP,
        maxOutputTokens: providerParams.maxOutputTokens,
        translationTimeout: providerParams.translationTimeout,
        maxRetries: providerParams.maxRetries,
        enableJsonOutput,
        ssrfLookup: createSsrfSafeLookup()
      });
    }
    default:
      return null;
  }
}

/**
 * Create the translation provider based on configuration.
 * Falls back to Gemini when multi-provider mode is disabled or misconfigured.
 */
async function createTranslationProvider(config) {
  const multiEnabled = config?.multiProviderEnabled === true;
  const providersConfig = config?.providers || {};
  const mainProvider = String(config?.mainProvider || (multiEnabled ? 'gemini' : 'gemini')).toLowerCase();
  const normalizedWorkflow = String(config?.advancedSettings?.translationWorkflow || '').toLowerCase();
  const structuredJsonEnabled = normalizedWorkflow === 'json' || config?.advancedSettings?.enableJsonOutput === true;
  const secondaryEnabled = multiEnabled && config?.secondaryProviderEnabled === true;
  const secondaryProviderKey = secondaryEnabled
    ? String(config?.secondaryProvider || '').toLowerCase()
    : '';
  // Build globalOptions for non-Gemini providers (Gemini gets it via advancedSettings)
  const jsonOutputOptions = {
    enableJsonOutput: structuredJsonEnabled
  };
  const defaultProviderParams = getDefaultProviderParameters();
  const mergedProviderParams = mergeProviderParameters(
    defaultProviderParams,
    config?.providerParameters || {}
  );
  const findProviderConfig = (key) => {
    if (!providersConfig || typeof providersConfig !== 'object') return {};
    if (providersConfig[key]) return providersConfig[key];
    const matchKey = Object.keys(providersConfig).find(k => String(k).toLowerCase() === key);
    return matchKey ? providersConfig[matchKey] : {};
  };
  const findProviderParams = (key) => {
    const lower = String(key || '').toLowerCase();
    const matchKey = Object.keys(mergedProviderParams || {}).find(k => String(k).toLowerCase() === lower);
    return matchKey ? mergedProviderParams[matchKey] : (mergedProviderParams?.[lower] || {});
  };
  const getGeminiAdvancedSettings = () => {
    const settings = config?.advancedSettings || {};
    const base = settings.enabled === true ? settings : {};
    // Keep provider JSON mode aligned with workflow-based JSON structured mode.
    if (structuredJsonEnabled) {
      base.enableJsonOutput = true;
    } else {
      base.enableJsonOutput = false;
    }
    return base;
  };
  const findSecondaryConfig = async (key) => {
    if (!secondaryEnabled) return null;
    const normalized = String(key || '').toLowerCase();
    if (normalized === 'gemini') {
      return {
        enabled: true,
        apiKey: await selectGeminiApiKey(config),
        model: config?.geminiModel
      };
    }
    const matchKey = Object.keys(providersConfig || {}).find(k => String(k).toLowerCase() === normalized);
    return matchKey ? providersConfig[matchKey] : null;
  };
  const isConfigured = (cfg, key) => {
    if (!cfg || cfg.enabled !== true) return false;
    const keyOptional = KEY_OPTIONAL_PROVIDERS.has(String(key || '').toLowerCase());
    if (keyOptional) {
      return !!cfg.model; // no API key required
    }
    return !!(cfg.apiKey && cfg.model);
  };

  const buildGeminiProvider = async () => ({
    providerName: 'gemini',
    provider: new GeminiService(
      await selectGeminiApiKey(config),
      config?.geminiModel,
      getGeminiAdvancedSettings()
    ),
    model: config?.geminiModel
  });

  if (!multiEnabled) {
    return await buildGeminiProvider();
  }

  if (mainProvider === 'gemini') {
    const primary = await buildGeminiProvider();
    let fallbackProvider = null;
    let fallbackName = '';
    let fallbackModel = '';

    if (secondaryEnabled && secondaryProviderKey && secondaryProviderKey !== 'gemini') {
      const secondaryConfig = await findSecondaryConfig(secondaryProviderKey);
      if (isConfigured(secondaryConfig, secondaryProviderKey)) {
        const secondaryParams = findProviderParams(secondaryProviderKey);
        fallbackProvider = await createProviderInstance(secondaryProviderKey, secondaryConfig, secondaryParams, jsonOutputOptions);
        fallbackName = secondaryProviderKey;
        fallbackModel = secondaryConfig.model;
      } else {
        log.warn(() => `[Providers] Secondary provider '${secondaryProviderKey}' is not fully configured; skipping fallback setup`);
      }
    }

    const wrappedProvider = fallbackProvider
      ? new FallbackTranslationProvider(primary.provider, fallbackProvider, {
        primaryName: 'gemini',
        fallbackName,
        fallbackModel
      })
      : primary.provider;

    return {
      providerName: 'gemini',
      provider: wrappedProvider,
      model: primary.model,
      fallbackProvider: fallbackProvider || null,
      fallbackProviderName: fallbackProvider ? fallbackName : null,
      fallbackModel: fallbackModel || null
    };
  }

  const selectedConfig = findProviderConfig(mainProvider) || {};
  if (!isConfigured(selectedConfig, mainProvider)) {
    log.warn(() => `[Providers] Missing configuration for main provider '${mainProvider}', falling back to Gemini`);
    return {
      providerName: 'gemini',
      provider: new GeminiService(
        await selectGeminiApiKey(config),
        config?.geminiModel,
        getGeminiAdvancedSettings()
      ),
      model: config?.geminiModel
    };
  }

  const providerParams = findProviderParams(mainProvider);
  const provider = await createProviderInstance(mainProvider, selectedConfig, providerParams, jsonOutputOptions);
  if (!provider) {
    log.warn(() => `[Providers] Unsupported provider '${mainProvider}', falling back to Gemini`);
    return {
      providerName: 'gemini',
      provider: new GeminiService(
        await selectGeminiApiKey(config),
        config?.geminiModel,
        getGeminiAdvancedSettings()
      ),
      model: config?.geminiModel
    };
  }

  let fallbackProvider = null;
  let fallbackName = '';
  let fallbackModel = '';

  if (secondaryEnabled && secondaryProviderKey && secondaryProviderKey !== mainProvider) {
    const secondaryConfig = await findSecondaryConfig(secondaryProviderKey);
    if (isConfigured(secondaryConfig, secondaryProviderKey)) {
      if (secondaryProviderKey === 'gemini') {
        fallbackProvider = new GeminiService(
          secondaryConfig.apiKey,
          secondaryConfig.model,
          getGeminiAdvancedSettings()
        );
        fallbackName = 'gemini';
        fallbackModel = secondaryConfig.model;
      } else {
        const secondaryParams = findProviderParams(secondaryProviderKey);
        fallbackProvider = await createProviderInstance(secondaryProviderKey, secondaryConfig, secondaryParams, jsonOutputOptions);
        fallbackName = secondaryProviderKey;
        fallbackModel = secondaryConfig.model;
      }
    } else {
      log.warn(() => `[Providers] Secondary provider '${secondaryProviderKey}' is not fully configured; skipping fallback setup`);
    }
  }

  const wrappedProvider = fallbackProvider
    ? new FallbackTranslationProvider(provider, fallbackProvider, {
      primaryName: mainProvider,
      fallbackName,
      fallbackModel
    })
    : provider;

  return {
    providerName: mainProvider,
    provider: wrappedProvider,
    model: selectedConfig.model,
    fallbackProvider: fallbackProvider || null,
    fallbackProviderName: fallbackProvider ? fallbackName : null,
    fallbackModel: fallbackModel || null
  };
}

module.exports = {
  createTranslationProvider,
  createProviderInstance,
  resolveCfWorkersCredentials
};
