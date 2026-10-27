const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const axios = require('axios');
const { Readable } = require('node:stream');

const GeminiService = require('./gemini');
const { createTranslationProvider } = require('./translationProviderFactory');
const { sanitizeApiKeyForHeader } = require('../utils/security');
const {
  cacheProviderAuthFailure,
  getProviderAuthFailureCacheKey,
  resetProviderAuthFailureCache
} = require('../utils/providerAuthFailureCache');
const { generateFileTranslationPage } = require('../utils/fileUploadPageGenerator');
const {
  generateEmbeddedSubtitlePage,
  generateAutoSubtitlePage
} = require('../utils/toolboxPageGenerator');
const {
  getDefaultConfig,
  getModelSpecificDefaults,
  normalizeConfig,
  normalizeGeminiModelName
} = require('../utils/config');

const projectRoot = path.resolve(__dirname, '..', '..');

test('AQ authorization keys bypass stale auth failures during explicit validation', async () => {
  const authKey = 'AQ.Ab8RN6_example-auth-key.with.dots_and-symbols';
  const originalGet = axios.get;
  let request = null;

  axios.get = async (url, options) => {
    request = { url, options };
    return {
      data: {
        models: [{
          name: 'models/gemini-3.7-flash',
          displayName: 'Gemini 3.7 Flash',
          supportedGenerationMethods: ['generateContent'],
          inputTokenLimit: 1048576
        }]
      }
    };
  };

  try {
    assert.equal(sanitizeApiKeyForHeader(`  ${authKey}\r\n`), authKey);
    const service = new GeminiService(`  ${authKey}  `, 'gemini-3.7-flash');
    await cacheProviderAuthFailure(getProviderAuthFailureCacheKey('gemini', authKey));

    await assert.rejects(
      service.getAvailableModels({ silent: true, throwOnError: true }),
      error => error.statusCode === 401 && error.type === 'authentication'
    );
    assert.equal(request, null);

    const models = await service.getAvailableModels({
      silent: true,
      throwOnError: true,
      bypassAuthFailureCache: true
    });

    assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models');
    assert.equal(request.options.headers['x-goog-api-key'], authKey);
    assert.match(request.options.headers['x-goog-api-client'], /^stremio-submaker\/1\.4\.\d+$/);
    assert.deepEqual(models.map(model => model.name), ['gemini-3.7-flash']);

    const serverSource = fs.readFileSync(path.join(projectRoot, 'index.js'), 'utf8');
    const configUiSource = fs.readFileSync(path.join(projectRoot, 'public', 'config.js'), 'utf8');
    assert.match(serverSource, /new GeminiService\(geminiApiKey\)[\s\S]{0,400}bypassAuthFailureCache: true/);
    assert.match(serverSource, /getGeminiPublicError\(apiError, t\)/);
    assert.match(serverSource, /function getGeminiPublicErrorStatus\(errorType\)[\s\S]{0,400}return 424/);
    assert.doesNotMatch(serverSource, /publicError\.errorType === 'authentication' \? 401 : 502/);
    assert.match(configUiSource, /const failure = await response\.json\(\)/);
    assert.match(configUiSource, /statusDiv\.textContent = `✗ \$\{message\}`/);
    assert.doesNotMatch(serverSource, /apiError\.response\?\.status === 400[\s\S]{0,500}invalidApiKey/);
    assert.doesNotMatch(serverSource, /generativelanguage\.googleapis\.com\/v1\/models/);
  } finally {
    axios.get = originalGet;
    resetProviderAuthFailureCache();
  }
});

test('Gemini location rejection is not treated as an invalid key and uses a trusted fallback once', async () => {
  const originalGet = axios.get;
  const originalFallback = process.env.GEMINI_API_FALLBACK_BASE;
  const authKey = 'AQ.location-test-key.with-enough-characters';
  const requests = [];
  const locationError = Object.assign(new Error('Request failed with status code 400'), {
    response: {
      status: 400,
      data: {
        error: {
          code: 400,
          message: 'User location is not supported for the API use.',
          status: 'FAILED_PRECONDITION'
        }
      }
    }
  });

  process.env.GEMINI_API_FALLBACK_BASE = 'https://trusted-gemini-gateway.example/v1beta';
  axios.get = async (url, options) => {
    requests.push({ url, options });
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      throw locationError;
    }
    return {
      data: {
        models: [{
          name: 'models/gemini-3.6-flash',
          supportedGenerationMethods: ['generateContent']
        }]
      }
    };
  };

  try {
    const info = GeminiService.getErrorInfo(locationError);
    assert.equal(info.type, 'unsupported_location');
    assert.equal(info.googleStatus, 'FAILED_PRECONDITION');
    assert.equal(GeminiService.isAuthFailure(locationError), false);

    const service = new GeminiService(authKey, 'gemini-3.6-flash');
    const models = await service.getAvailableModels({
      silent: true,
      throwOnError: true,
      bypassAuthFailureCache: true
    });

    assert.deepEqual(requests.map(request => request.url), [
      'https://generativelanguage.googleapis.com/v1beta/models',
      'https://trusted-gemini-gateway.example/v1beta/models'
    ]);
    assert.equal(requests[1].options.headers['x-goog-api-key'], authKey);
    assert.match(requests[1].options.headers['x-goog-api-client'], /^stremio-submaker\/1\.4\.\d+$/);
    assert.deepEqual(models.map(model => model.name), ['gemini-3.6-flash']);
    assert.equal(service.baseUrl, 'https://trusted-gemini-gateway.example/v1beta');
  } finally {
    axios.get = originalGet;
    if (originalFallback === undefined) delete process.env.GEMINI_API_FALLBACK_BASE;
    else process.env.GEMINI_API_FALLBACK_BASE = originalFallback;
    resetProviderAuthFailureCache();
  }
});

test('Gemini location errors reach translation as a specific actionable failure', async () => {
  const originalPost = axios.post;
  const originalFallback = process.env.GEMINI_API_FALLBACK_BASE;
  delete process.env.GEMINI_API_FALLBACK_BASE;

  axios.post = async () => {
    throw Object.assign(new Error('Request failed with status code 400'), {
      response: {
        status: 400,
        data: {
          error: {
            code: 400,
            message: 'User location is not supported for the API use.',
            status: 'FAILED_PRECONDITION'
          }
        }
      }
    });
  };

  try {
    const service = new GeminiService('AIza-location-test-key-with-enough-characters', 'gemini-3.6-flash', {
      maxRetries: 0
    });
    service.getModelLimits = async () => ({ inputTokenLimit: 1048576, outputTokenLimit: 65536 });

    await assert.rejects(
      service.translateSubtitle('Hello', 'English', 'Portuguese'),
      error => {
        assert.equal(error.type, 'unsupported_location');
        assert.equal(error.translationErrorType, 'GEMINI_UNSUPPORTED_LOCATION');
        assert.match(error.message, /server network location/i);
        return true;
      }
    );
  } finally {
    axios.post = originalPost;
    if (originalFallback === undefined) delete process.env.GEMINI_API_FALLBACK_BASE;
    else process.env.GEMINI_API_FALLBACK_BASE = originalFallback;
  }
});

test('Gemini model-limit location rejection reaches translation before a generic generation 400 can replace it', async () => {
  const originalGet = axios.get;
  const originalPost = axios.post;
  const originalFallback = process.env.GEMINI_API_FALLBACK_BASE;
  delete process.env.GEMINI_API_FALLBACK_BASE;
  let generationRequests = 0;

  axios.get = async () => {
    throw Object.assign(new Error('Request failed with status code 400'), {
      response: {
        status: 400,
        data: {
          error: {
            code: 400,
            message: 'User location is not supported for the API use.',
            status: 'FAILED_PRECONDITION'
          }
        }
      }
    });
  };
  axios.post = async () => {
    generationRequests += 1;
    throw Object.assign(new Error('Request failed with status code 400'), {
      response: {
        status: 400,
        data: {
          error: {
            code: 400,
            message: 'A later generic generation error must not win.',
            status: 'INVALID_ARGUMENT'
          }
        }
      }
    });
  };

  try {
    const service = new GeminiService('AQ.location-preflight-test-key', 'gemini-3.6-flash', {
      maxRetries: 0
    });

    await assert.rejects(
      service.translateSubtitle('Hello', 'English', 'Portuguese'),
      error => {
        assert.equal(error.type, 'unsupported_location');
        assert.equal(error.translationErrorType, 'GEMINI_UNSUPPORTED_LOCATION');
        assert.match(error.message, /server network location/i);
        return true;
      }
    );
    assert.equal(generationRequests, 0);
  } finally {
    axios.get = originalGet;
    axios.post = originalPost;
    if (originalFallback === undefined) delete process.env.GEMINI_API_FALLBACK_BASE;
    else process.env.GEMINI_API_FALLBACK_BASE = originalFallback;
  }
});

test('Gemini fallback is not used for an invalid legacy API key', async () => {
  const originalGet = axios.get;
  const originalFallback = process.env.GEMINI_API_FALLBACK_BASE;
  const requests = [];
  const invalidKey = 'AIza-invalid-test-key-with-enough-characters';
  process.env.GEMINI_API_FALLBACK_BASE = 'https://trusted-gemini-gateway.example/v1beta';

  axios.get = async url => {
    requests.push(url);
    throw Object.assign(new Error('Request failed with status code 400'), {
      response: {
        status: 400,
        data: {
          error: {
            code: 400,
            message: `API key not valid. Please pass a valid API key: ${invalidKey}`,
            status: 'INVALID_ARGUMENT'
          }
        }
      }
    });
  };

  try {
    const service = new GeminiService(invalidKey);
    await assert.rejects(
      service.getAvailableModels({
        silent: true,
        throwOnError: true,
        bypassAuthFailureCache: true
      }),
      error => {
        const info = GeminiService.getErrorInfo(error);
        assert.equal(info.type, 'authentication');
        assert.equal(info.message.includes(invalidKey), false);
        assert.match(info.message, /\[REDACTED_API_KEY\]/);
        return true;
      }
    );
    assert.deepEqual(requests, ['https://generativelanguage.googleapis.com/v1beta/models']);
  } finally {
    axios.get = originalGet;
    if (originalFallback === undefined) delete process.env.GEMINI_API_FALLBACK_BASE;
    else process.env.GEMINI_API_FALLBACK_BASE = originalFallback;
    resetProviderAuthFailureCache();
  }
});

test('Gemini 3.x uses thinking levels without legacy sampling fields', () => {
  const service = new GeminiService('test-key', 'models/gemini-3.5-flash', {
    thinkingBudget: 1000,
    thinkingLevel: 'high',
    samplingParametersEnabled: true,
    temperature: 0.5,
    topK: 40,
    topP: 0.95
  });

  assert.equal(service.model, 'gemini-3.5-flash');
  assert.equal(service.samplingParametersEnabled, false);
  assert.deepEqual(service.buildGenerationConfig(4096), {
    maxOutputTokens: 4096,
    thinkingConfig: { thinkingLevel: 'high' }
  });

  const disabled37 = new GeminiService('test-key', 'gemini-3.7-flash', { thinkingLevel: 'disabled' });
  assert.equal(disabled37.buildGenerationConfig(4096).thinkingConfig.thinkingLevel, 'low');

  const dated37 = new GeminiService('test-key', 'gemini-3.7-flash-001', { thinkingLevel: 'minimal' });
  assert.equal(dated37.buildGenerationConfig(4096).thinkingConfig.thinkingLevel, 'low');

  const latestLite = new GeminiService('test-key', 'gemini-flash-lite-latest', {
    thinkingBudget: 0,
    thinkingLevel: 'minimal',
    temperature: 0.8
  });
  assert.equal(latestLite.isThinkingEnabled(), true);
  assert.deepEqual(latestLite.buildGenerationConfig(4096), {
    maxOutputTokens: 4096,
    thinkingConfig: { thinkingLevel: 'minimal' }
  });
});

test('Gemini 3 translation and structured-output paths send the current request shape', async () => {
  const originalPost = axios.post;
  let requestBody = null;
  const service = new GeminiService('AQ.test-key', 'gemini-3.7-flash', {
    thinkingLevel: 'medium',
    enableJsonOutput: true,
    maxRetries: 0
  });
  service.getModelLimits = async () => ({ inputTokenLimit: 1048576, outputTokenLimit: 65536 });

  axios.post = async (url, body) => {
    assert.match(url, /\/v1beta\/models\/gemini-3\.7-flash:generateContent$/);
    requestBody = body;
    return {
      data: {
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: '{"entries":["Olá"]}' }] }
        }]
      }
    };
  };

  try {
    const output = await service.translateSubtitle('Hello', 'English', 'Portuguese');
    assert.equal(output, '{"entries":["Olá"]}');
    assert.equal(requestBody.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(requestBody.generationConfig.thinkingConfig, { thinkingLevel: 'medium' });
    assert.equal('thinkingBudget' in requestBody.generationConfig.thinkingConfig, false);
    assert.equal('temperature' in requestBody.generationConfig, false);
    assert.equal('topK' in requestBody.generationConfig, false);
    assert.equal('topP' in requestBody.generationConfig, false);
  } finally {
    axios.post = originalPost;
  }
});

test('legacy numeric thinking budgets and sampling controls remain unchanged for Gemini 2.x', () => {
  const service = new GeminiService('test-key', 'gemini-2.5-flash', {
    thinkingBudget: 1000,
    temperature: 0.5,
    topK: 20,
    topP: 0.9
  });

  assert.deepEqual(service.buildGenerationConfig(4096), {
    maxOutputTokens: 4096,
    temperature: 0.5,
    topK: 20,
    topP: 0.9,
    thinkingConfig: { thinkingBudget: 1000 }
  });

  const modelDefaults = new GeminiService('test-key', 'gemini-2.0-flash', {
    thinkingBudget: 1000,
    samplingParametersEnabled: false,
    temperature: 0.5,
    topK: 20,
    topP: 0.9
  });
  assert.equal(modelDefaults.samplingParametersEnabled, false);
  assert.deepEqual(modelDefaults.buildGenerationConfig(4096), {
    maxOutputTokens: 4096,
    thinkingConfig: { thinkingBudget: 1000 }
  });
});

test('legacy Gemini sampling can be disabled through the environment default', () => {
  const original = process.env.GEMINI_SAMPLING_PARAMETERS_ENABLED;
  process.env.GEMINI_SAMPLING_PARAMETERS_ENABLED = 'false';
  try {
    const service = new GeminiService('test-key', 'gemini-2.0-flash', {
      temperature: 0.5,
      topK: 20,
      topP: 0.9
    });
    assert.equal(service.samplingParametersEnabled, false);
    assert.equal('temperature' in service.buildGenerationConfig(4096), false);
  } finally {
    if (original === undefined) delete process.env.GEMINI_SAMPLING_PARAMETERS_ENABLED;
    else process.env.GEMINI_SAMPLING_PARAMETERS_ENABLED = original;
  }
});

test('streaming Gemini requests honor the same sampling opt-out', async () => {
  const service = new GeminiService('test-key', 'gemini-2.0-flash', {
    samplingParametersEnabled: false,
    temperature: 0.5,
    topK: 20,
    topP: 0.9,
    maxRetries: 0
  });
  service.getModelLimits = async () => ({ inputTokenLimit: 1048576, outputTokenLimit: 8192 });

  let requestBody = null;
  service.request = async (method, requestPath, body) => {
    assert.equal(method, 'post');
    assert.match(requestPath, /:streamGenerateContent$/);
    requestBody = body;
    return {
      headers: { 'content-type': 'text/event-stream' },
      data: Readable.from([
        'data: {"candidates":[{"content":{"parts":[{"text":"Olá"}]},"finishReason":"STOP"}]}\n\n'
      ])
    };
  };

  const output = await service.streamTranslateSubtitle('Hello', 'English', 'Portuguese');
  assert.equal(output, 'Olá');
  assert.equal('temperature' in requestBody.generationConfig, false);
  assert.equal('topP' in requestBody.generationConfig, false);
  assert.equal('topK' in requestBody.generationConfig, false);
});

test('saved model IDs and Gemini 3.x defaults normalize without breaking old configs', () => {
  assert.equal(normalizeGeminiModelName(' models/gemini-3.7-flash '), 'gemini-3.7-flash');
  assert.equal(normalizeGeminiModelName('gemini-3.1-flash-lite-preview'), 'gemini-3.1-flash-lite');
  assert.equal(normalizeGeminiModelName('gemini-3-pro-preview'), 'gemini-3.1-pro-preview');
  assert.equal(normalizeGeminiModelName('gemini-2.5-flash-lite'), 'gemini-2.5-flash-lite');
  assert.equal(normalizeGeminiModelName('gemini-2.5-flash'), 'gemini-2.5-flash');
  assert.equal(normalizeGeminiModelName('gemini-2.5-pro'), 'gemini-2.5-pro');
  assert.equal(normalizeGeminiModelName('gemini-3-flash-preview'), 'gemini-3-flash-preview');
  assert.equal(normalizeGeminiModelName('gemini-2.0-flash'), 'gemini-3.6-flash');

  const defaults = getDefaultConfig('gemini-3.6-flash');
  assert.equal(defaults.geminiModel, 'gemini-3.6-flash');
  assert.equal(defaults.advancedSettings.thinkingBudget, -1);
  assert.equal(defaults.advancedSettings.thinkingLevel, 'medium');
  assert.equal(defaults.advancedSettings.samplingParametersEnabled, false);

  const legacyDefaults = getDefaultConfig('gemini-2.5-flash');
  assert.equal(legacyDefaults.advancedSettings.samplingParametersEnabled, true);

  const oldFlashDefaults = getModelSpecificDefaults('gemini-3.6-flash');
  for (const model of ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash']) {
    assert.deepEqual(getModelSpecificDefaults(model), oldFlashDefaults);
  }
  const oldLiteDefaults = getModelSpecificDefaults('gemini-3.1-flash-lite');
  for (const model of ['gemini-3.5-flash-lite', 'gemini-3.8-flash-lite-preview']) {
    assert.deepEqual(getModelSpecificDefaults(model), oldLiteDefaults);
  }

  const normalized = normalizeConfig({
    geminiApiKey: 'AQ.saved.key',
    geminiModel: 'models/gemini-3.5-flash-lite',
    advancedSettings: {
      enabled: true,
      geminiModel: 'models/gemini-3.7-flash',
      thinkingLevel: 'HIGH'
    }
  });
  assert.equal(normalized.geminiApiKey, 'AQ.saved.key');
  assert.equal(normalized.geminiModel, 'gemini-3.5-flash-lite');
  assert.equal(normalized.advancedSettings.geminiModel, 'gemini-3.7-flash');
  assert.equal(normalized.advancedSettings.thinkingLevel, 'high');
  assert.equal(normalized.advancedSettings.samplingParametersEnabled, false);

  const normalizedLegacyOptOut = normalizeConfig({
    geminiApiKey: 'legacy-key',
    geminiModel: 'gemini-2.0-flash',
    advancedSettings: {
      enabled: false,
      samplingParametersEnabled: false
    }
  });
  assert.equal(normalizedLegacyOptOut.advancedSettings.samplingParametersEnabled, false);

  const migratedLegacy = normalizeConfig({
    geminiApiKey: 'legacy-key',
    geminiModel: 'gemini-2.5-flash-lite',
    advancedSettings: {
      enabled: true,
      geminiModel: 'gemini-2.5-flash'
    }
  });
  assert.equal(migratedLegacy.geminiModel, 'gemini-2.5-flash-lite');
  assert.equal(migratedLegacy.advancedSettings.geminiModel, 'gemini-2.5-flash');
});

test('base-model selections apply their cloned runtime defaults without enabling advanced overrides', async () => {
  const flashConfig = getDefaultConfig('gemini-3.6-flash');
  flashConfig.geminiApiKey = 'AQ.test-key';
  flashConfig.advancedSettings.enabled = false;

  const currentFlash = await createTranslationProvider(flashConfig);
  assert.equal(currentFlash.provider.model, 'gemini-3.6-flash');
  assert.equal(currentFlash.provider.thinkingBudget, -1);
  assert.equal(currentFlash.provider.thinkingLevel, 'medium');
  assert.equal(currentFlash.provider.temperature, 0.5);
  assert.equal(currentFlash.provider.samplingParametersEnabled, false);

  const legacyFlashConfig = getDefaultConfig('gemini-2.5-flash');
  legacyFlashConfig.geminiApiKey = 'legacy-test-key';
  legacyFlashConfig.advancedSettings.enabled = false;

  const legacyFlash = await createTranslationProvider(legacyFlashConfig);
  assert.equal(legacyFlash.provider.model, 'gemini-2.5-flash');
  assert.equal(legacyFlash.provider.thinkingBudget, -1);
  assert.equal(legacyFlash.provider.thinkingLevel, '');
  assert.equal(legacyFlash.provider.temperature, 0.5);
  assert.equal(legacyFlash.provider.samplingParametersEnabled, true);

  const legacyOptOutConfig = getDefaultConfig('gemini-2.5-flash');
  legacyOptOutConfig.geminiApiKey = 'legacy-test-key';
  legacyOptOutConfig.advancedSettings.enabled = false;
  legacyOptOutConfig.advancedSettings.samplingParametersEnabled = false;
  const legacyOptOut = await createTranslationProvider(legacyOptOutConfig);
  assert.equal(legacyOptOut.provider.model, 'gemini-2.5-flash');
  assert.equal(legacyOptOut.provider.samplingParametersEnabled, false);
  assert.equal('temperature' in legacyOptOut.provider.buildGenerationConfig(4096), false);
});

test('Configure and Toolbox pages expose current Gemini choices and model-aware controls', async () => {
  const html = fs.readFileSync(path.join(projectRoot, 'public', 'partials', 'main.html'), 'utf8');
  const requiredModels = [
    'gemini-3.8-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-pro'
  ];

  for (const model of requiredModels) {
    assert.match(html, new RegExp(`value=["']${model}["']`));
  }
  assert.match(html, /id="advancedThinkingLevel"/);
  assert.match(html, /id="advancedSamplingParametersEnabled"/);
  assert.match(html, /id="advancedTopK"/);
  for (const retiredModel of ['gemini-3.5-flash', 'gemini-3-pro-preview']) {
    assert.doesNotMatch(html, new RegExp(`value=["']${retiredModel}["']`));
  }
  const configUi = fs.readFileSync(path.join(projectRoot, 'public', 'config.js'), 'utf8');
  assert.match(configUi, /!isDeprecatedGeminiModelName\(model\.name\)/);

  const uploadPage = generateFileTranslationPage(
    'tt-test',
    'test-config',
    getDefaultConfig('gemini-3.7-flash'),
    'test.srt'
  );
  assert.match(uploadPage, /id="advancedThinkingLevel"/);
  assert.match(uploadPage, /id="advancedSamplingParametersEnabled"/);
  assert.match(uploadPage, /samplingParametersEnabled,/);
  assert.match(uploadPage, /updateSamplingControls\('gemini'/);
  assert.match(uploadPage, /thinkingLevel: usesThinkingLevel \? thinkingLevel : undefined/);
  assert.match(uploadPage, /function getGeminiModelFamilyDefaults/);
  assert.match(uploadPage, /applyGeminiModelDefaults\(advancedModel\.value\)/);

  const toolboxConfig = getDefaultConfig('gemini-3.7-flash');
  toolboxConfig.geminiApiKey = 'AQ.test-key';
  toolboxConfig.multiProviderEnabled = true;
  toolboxConfig.mainProvider = 'gemini';
  const [embeddedPage, autoPage] = await Promise.all([
    generateEmbeddedSubtitlePage('test-config', '', '', toolboxConfig),
    generateAutoSubtitlePage('test-config', '', '', toolboxConfig)
  ]);
  assert.match(embeddedPage, /Gemini \(gemini-3\.7-flash\)/);
  assert.match(autoPage, /Gemini \(gemini-3\.7-flash\)/);

  for (const page of [uploadPage, embeddedPage, autoPage]) {
    for (const match of page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      if (match[1].trim()) new vm.Script(match[1]);
    }
  }

  const indexSource = fs.readFileSync(path.join(projectRoot, 'index.js'), 'utf8');
  assert.match(indexSource, /const getProviderParams = \(key\) => key === 'gemini'/);
  assert.match(indexSource, /generationSettingsSignature/);
});
