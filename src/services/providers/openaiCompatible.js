const axios = require('axios');
const { handleTranslationError, logApiError } = require('../../utils/apiErrorHandler');
const { httpAgent, httpsAgent } = require('../../utils/httpAgents');
const log = require('../../utils/logger');
const { sanitizeApiKeyForHeader } = require('../../utils/security');
const { DEFAULT_TRANSLATION_PROMPT } = require('../gemini');
const {
  findISO6391ByName,
  getLanguageName,
  toISO6391,
  toISO6392
} = require('../../utils/languages');
const { resolveLanguageDisplayName } = require('../../utils/languageResolver');
const { normalizeTargetLanguageForPrompt } = require('../utils/normalizeTargetLanguageForPrompt');

/**
 * Minimal OpenAI-compatible provider wrapper.
 * Used for OpenAI, XAI/Grok, DeepSeek, Mistral, OpenRouter and other
 * API-compatible backends by swapping the base URL and headers.
 */
class OpenAICompatibleProvider {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.model = options.model || '';
    this.baseUrl = (options.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    this.providerName = options.providerName || 'openai';
    this.headers = options.headers || {};
    this.temperature = options.temperature !== undefined ? options.temperature : 0.4;
    this.maxOutputTokens = options.maxOutputTokens || 4096;
    this.topP = options.topP !== undefined ? options.topP : 0.95;
    this.reasoningEffort = this.normalizeReasoningEffort(options.reasoningEffort);
    const timeoutSeconds = options.translationTimeout !== undefined ? options.translationTimeout : 60;
    this.translationTimeout = Math.max(5000, parseInt(timeoutSeconds * 1000, 10) || 60000);
    this.maxRetries = Number.isFinite(parseInt(options.maxRetries, 10))
      ? Math.max(0, parseInt(options.maxRetries, 10))
      : 2;
    // JSON structured output mode
    this.enableJsonOutput = options.enableJsonOutput === true;
    // Optional SSRF-safe DNS lookup for custom providers (closes TOCTOU gap)
    this._ssrfLookup = options.ssrfLookup || null;
    if (this._ssrfLookup) {
      const http = require('http');
      const https = require('https');
      this._ssrfHttpAgent = new http.Agent({ keepAlive: true, lookup: this._ssrfLookup });
      this._ssrfHttpsAgent = new https.Agent({ keepAlive: true, lookup: this._ssrfLookup });
    }
  }

  normalizeReasoningEffort(value) {
    const allowed = ['low', 'medium', 'high'];
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return allowed.includes(normalized) ? normalized : undefined;
  }
  /**
   * Return the appropriate HTTP agents for this provider.
   * Custom providers with SSRF-safe lookup use dedicated agents;
   * all others use the shared connection-pooled agents.
   */
  getHttpAgents() {
    if (this._ssrfLookup) {
      return { httpAgent: this._ssrfHttpAgent, httpsAgent: this._ssrfHttpsAgent };
    }
    return { httpAgent, httpsAgent };
  }



  isCfTranslationModel() {
    const model = String(this.model || '').toLowerCase();
    return (
      model.includes('m2m100') ||
      model.includes('nllb-200')
    );
  }

  normalizeCfModelId() {
    const raw = String(this.model || '').trim();
    const lower = raw.toLowerCase();
    // If already has @cf/ prefix, keep as-is
    if (lower.startsWith('@cf/')) {
      return raw;
    }
    // If already has meta/ prefix, add @cf/
    if (lower.startsWith('meta/')) {
      return `@cf/${raw}`;
    }
    // Default translation models live under meta namespace
    return `@cf/meta/${raw}`;
  }

  /**
   * Normalize target language name in prompt for better model guidance
   */
  normalizeTargetName(name) {
    const raw = String(name || '').trim();
    if (!raw) return 'target language';

    // Resolve to a canonical code first (preserves regional variants)
    const code = this.normalizeLanguageCode(raw);

    // Prefer explicit regional display names when we know them
    const variantDisplay = this.variantNameFromCode(code);
    if (variantDisplay) return normalizeTargetLanguageForPrompt(variantDisplay);

    const displayFromUi = resolveLanguageDisplayName(code) || resolveLanguageDisplayName(raw);
    if (displayFromUi) {
      return normalizeTargetLanguageForPrompt(this.normalizeVariantDisplayName(displayFromUi));
    }

    // Try direct name lookup by code (covers ISO-639-2 codes and custom variants like pt-br)
    const nameFromCode = getLanguageName(code) || getLanguageName(code.replace(/-/g, ''));
    if (nameFromCode) {
      return normalizeTargetLanguageForPrompt(this.normalizeVariantDisplayName(nameFromCode));
    }

    // ISO-639-1 -> ISO-639-2 -> display name
    if (/^[a-z]{2}$/i.test(code)) {
      const iso2 = toISO6392(code);
      if (Array.isArray(iso2) && iso2.length > 0) {
        const display = getLanguageName(iso2[0].code2);
        if (display) {
          return normalizeTargetLanguageForPrompt(this.normalizeVariantDisplayName(display));
        }
      }
    }

    return normalizeTargetLanguageForPrompt(this.normalizeVariantDisplayName(raw) || raw);
  }

  /**
   * Normalize human-friendly names (e.g., Brazilian Portuguese) to a canonical display name
   */
  normalizeVariantDisplayName(name) {
    const n = String(name || '').trim();
    if (!n) return '';
    const rules = [
      [/^brazilian portuguese$/i, 'Portuguese (Brazilian)'],
      [/^portuguese\s*\(brazil(ian)?\)$/i, 'Portuguese (Brazilian)'],
      [/^portuguese\s*\(portugal\)$/i, 'Portuguese (Portugal)'],
      [/^european portuguese$/i, 'Portuguese (Portugal)'],
      [/^portuguese$/i, 'Portuguese (Portugal)'],
      [/^spanish\s*\(latin america\)$/i, 'Spanish (Latin America)'],
      [/^latin american spanish$/i, 'Spanish (Latin America)'],
      [/^spanish$/i, 'Spanish (Spain)'],
      [/^chinese\s*\(traditional\)$/i, 'Chinese (Traditional)'],
      [/^chinese\s*\(simplified\)$/i, 'Chinese (Simplified)'],
      [/^chinese$/i, 'Chinese (Simplified)']
    ];
    for (const [re, out] of rules) {
      if (re.test(n)) return out;
    }
    return n;
  }

  /**
   * Map normalized codes to explicit variant names for prompts
   */
  variantNameFromCode(code) {
    const normalized = String(code || '').toLowerCase();
    switch (normalized) {
      case 'pt-br':
        return 'Portuguese (Brazilian)';
      case 'pt-pt':
        return 'Portuguese (Portugal)';
      case 'es-419':
        return 'Spanish (Latin America)';
      case 'zh-hant':
        return 'Chinese (Traditional)';
      case 'zh-hans':
        return 'Chinese (Simplified)';
      default:
        return null;
    }
  }

  normalizeCfLanguage(code) {
    const normalized = this.normalizeLanguageCode(code);
    if (!normalized || normalized === 'detected' || normalized === 'auto') return '';
    const base = normalized.split('-')[0];
    return base || normalized;
  }

  buildCfTranslationRequest(subtitleContent, sourceLanguage, targetLanguage) {
    const modelId = this.normalizeCfModelId();
    const url = `${this.baseUrl.replace(/\/v1$/, '')}/run/${modelId}`;
    const targetLang = this.normalizeCfLanguage(targetLanguage) || 'en';
    const sourceLang = this.normalizeCfLanguage(sourceLanguage);

    const body = {
      text: subtitleContent || '',
      target_lang: targetLang
    };

    if (sourceLang) {
      body.source_lang = sourceLang;
    }

    if (this.temperature !== undefined) {
      body.temperature = this.temperature;
    }
    if (this.topP !== undefined) {
      body.top_p = this.topP;
    }
    if (this.maxOutputTokens) {
      body.max_tokens = this.maxOutputTokens;
    }

    return { body, url };
  }

  buildChatRequest(userPrompt, stream = false, meta = {}) {
    const disableStructuredOutput = meta?.disableStructuredOutput === true;
    const isCfRun = this.isCfWorkersRunModel();
    const isCfTranslation = isCfRun && this.isCfTranslationModel();

    if (isCfTranslation) {
      const { body, url } = this.buildCfTranslationRequest(
        meta.subtitleContent,
        meta.sourceLanguage,
        meta.targetLanguage
      );
      return { body, url, isCfRun: true, isCfTranslation: true };
    }

    const body = isCfRun
      ? {
        prompt: userPrompt,
        stream
      }
      : {
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a subtitle translation engine.' },
          { role: 'user', content: userPrompt }
        ],
        temperature: this.temperature,
        max_tokens: this.maxOutputTokens,
        stream
      };

    // JSON structured output mode for OpenAI-compatible APIs
    if (!isCfRun && this.enableJsonOutput && !disableStructuredOutput) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'subtitle_entries',
          strict: true,
          schema: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                text: { type: 'string' }
              },
              required: ['id', 'text'],
              additionalProperties: false
            }
          }
        }
      };
    }

    if (!isCfRun && this.providerName === 'openai') {
      const effort = this.normalizeReasoningEffort(this.reasoningEffort);
      if (effort) {
        body.reasoning = { effort };
      }
    }

    if (isCfRun) {
      if (this.temperature !== undefined) {
        body.temperature = this.temperature;
      }
      if (this.topP !== undefined) {
        body.top_p = this.topP;
      }
      if (this.maxOutputTokens) {
        body.max_tokens = this.maxOutputTokens;
      }
    } else if (this.topP !== undefined) {
      body.top_p = this.topP;
    }

    const url = isCfRun
      ? `${this.baseUrl.replace(/\/v1$/, '')}/run/${this.model}`
      : `${this.baseUrl}/chat/completions`;

    return { body, url, isCfRun, isCfTranslation: false };
  }

  buildUserPrompt(subtitleContent, targetLanguage, customPrompt = null) {
    const normalizedTarget = this.normalizeTargetName(targetLanguage);
    const systemPrompt = (customPrompt || DEFAULT_TRANSLATION_PROMPT).replace('{target_language}', normalizedTarget);
    const userPrompt = `${systemPrompt}\n\nContent to translate:\n\n${subtitleContent}`;
    return { userPrompt, systemPrompt, normalizedTarget };
  }

  estimateTokenCount(text) {
    if (!text) return 0;
    const str = String(text);
    try {
      const { countTokens } = require('gpt-tokenizer');
      return countTokens(str);
    } catch (_) {
      // Fallback to heuristic if tokenizer fails
      const approx = Math.ceil(str.length / 3);
      return Math.ceil(approx * 1.1);
    }
  }

  getAuthHeaders() {
    // Sanitize API key to prevent header injection vulnerabilities
    const sanitizedKey = sanitizeApiKeyForHeader(this.apiKey) || '';
    return {
      Authorization: `Bearer ${sanitizedKey}`,
      ...this.headers
    };
  }

  isCfWorkersRunModel() {
    return this.providerName === 'cfWorkers';
  }

  normalizeLanguageCode(code) {
    const raw = String(code || '').trim();
    if (!raw) return 'en';

    // Resolve human-friendly names to codes first
    const fromName = findISO6391ByName(raw);
    if (fromName) {
      return this.normalizeLanguageCode(fromName);
    }

    let cleaned = raw.toLowerCase().replace(/[\s_]/g, '-');

    // Preserve explicit regional variants
    const variantMap = {
      'pob': 'pt-br',
      'ptbr': 'pt-br',
      'pt-br': 'pt-br',
      'ptbrazil': 'pt-br',
      'pt-brazil': 'pt-br',
      'pt-pt': 'pt-pt',
      'pt_portugal': 'pt-pt',
      'spn': 'es-419',
      'es-419': 'es-419',
      'es_la': 'es-419',
      'es-la': 'es-419',
      'es-latam': 'es-419',
      'es-mx': 'es-419',
      'zht': 'zh-hant',
      'zh-hant': 'zh-hant',
      'zh-tw': 'zh-hant',
      'zhs': 'zh-hans',
      'zh-hans': 'zh-hans',
      'zh-cn': 'zh-hans'
    };
    if (variantMap[cleaned]) {
      return variantMap[cleaned];
    }

    // Drop translation suffix if present
    cleaned = cleaned.replace(/-tr$/, '');

    // ISO-639-2 -> ISO-639-1
    if (/^[a-z]{3}$/.test(cleaned)) {
      const iso1 = toISO6391(cleaned);
      if (iso1) {
        cleaned = iso1.toLowerCase();
      }
    }

    cleaned = cleaned.replace(/[^a-z-]/g, '');

    if (/^[a-z]{2}(-[a-z0-9]{2,})?$/.test(cleaned)) {
      return cleaned;
    }

    if (/^[a-z]{2}$/.test(cleaned)) {
      return cleaned;
    }

    // Fallback to first two chars to avoid empty strings
    return cleaned.slice(0, 2) || 'en';
  }

  async getAvailableModels() {
    try {
      const isCfWorkers = this.providerName === 'cfWorkers';
      const baseModelsUrl = isCfWorkers
        ? `${this.baseUrl.replace(/\/v1$/, '')}/models`
        : `${this.baseUrl}/models`;

      const agents = this.getHttpAgents();
      const requestConfig = {
        headers: this.getAuthHeaders(),
        timeout: 10000,
        httpAgent: agents.httpAgent,
        httpsAgent: agents.httpsAgent
      };

      let response;

      if (isCfWorkers) {
        const searchUrl = `${this.baseUrl.replace(/\/v1$/, '')}/models/search`;
        try {
          // Cloudflare Workers AI uses GET for /models/search endpoint
          response = await axios.get(searchUrl, requestConfig);
        } catch (searchError) {
          // Fallback to base /models endpoint if search is unavailable
          response = await axios.get(baseModelsUrl, requestConfig);
        }
      } else {
        response = await axios.get(baseModelsUrl, requestConfig);
      }

      const data = response.data || {};
      const modelsRaw = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.models)
          ? data.models
          : Array.isArray(data?.result)
            ? data.result
            : (Array.isArray(data?.result?.models) ? data.result.models : undefined);

      const models = Array.isArray(modelsRaw)
        ? modelsRaw.map(m => {
          const isCf = this.providerName === 'cfWorkers';
          // Cloudflare returns a UUID in `id` and the human slug in `name`/`slug`
          const name = isCf
            ? (m.name || m.slug || m.id || m.model)
            : (m.id || m.name || m.model);
          const displayName = m.display_name
            || m.displayName
            || m.name
            || m.slug
            || m.id
            || m.model;
          return {
            name,
            displayName,
            description: m.description || '',
            maxTokens: m.max_tokens || m.maxTokens || undefined
          };
        }).filter(m => !!m.name)
        : [];

      if (this.providerName === 'cfWorkers' && models.length === 0) {
        const hints = []
          .concat(data?.messages || [])
          .concat(data?.errors || [])
          .concat(data?.result?.messages || [])
          .concat(data?.result?.errors || []);
        const firstHint = hints
          .map(msg => (typeof msg === 'string' ? msg : msg?.message || msg?.error))
          .find(Boolean)
          || (typeof data?.result === 'string' ? data.result : null);
        const detail = firstHint || 'Cloudflare returned no models. Ensure Workers AI is enabled and the token has Workers AI read access.';
        const error = new Error(detail);
        error.responseData = data;
        throw error;
      }

      return models;
    } catch (error) {
      logApiError(error, this.providerName, 'Fetch models', { skipResponseData: true });
      if (this.providerName === 'cfWorkers') {
        throw error;
      }
      return [];
    }
  }

  isStructuredOutputUnsupportedError(error) {
    if (!error) return false;
    const status = error?.response?.status || error?.status || error?.statusCode || 0;
    const msg = String(
      error?.response?.data?.error?.message ||
      error?.response?.data?.message ||
      error?.message ||
      ''
    ).toLowerCase();
    const requestIssue = status === 400 || status === 404 || status === 405 || status === 415 || status === 422 || status === 501;
    const mentionsStructuredMode =
      msg.includes('response_format') ||
      msg.includes('json_schema') ||
      msg.includes('json_object') ||
      msg.includes('unknown parameter') ||
      msg.includes('unsupported') ||
      msg.includes('does not support');
    return requestIssue && mentionsStructuredMode;
  }

  async translateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt = null, requestOptions = {}) {
    const { userPrompt } = this.buildUserPrompt(subtitleContent, targetLanguage, customPrompt);

    let lastError;
    let disableStructuredOutput = requestOptions?.disableStructuredOutput === true;
    let structuredDowngradeUsed = disableStructuredOutput;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const { body, url, isCfRun } = this.buildChatRequest(
          userPrompt,
          false,
          {
            subtitleContent,
            sourceLanguage,
            targetLanguage,
            disableStructuredOutput
          }
        );
        const agents = this.getHttpAgents();
        const response = await axios.post(
          url,
          body,
          {
            headers: this.getAuthHeaders(),
            timeout: this.translationTimeout,
            httpAgent: agents.httpAgent,
            httpsAgent: agents.httpsAgent
          }
        );

        let text;
        if (isCfRun) {
          text =
            response.data?.result?.translated_text ||
            response.data?.result?.output ||
            response.data?.result?.response ||
            response.data?.result;
        } else {
          text = response.data?.choices?.[0]?.message?.content;
        }

        if (!text) {
          throw new Error('No translation returned from API');
        }

        return this.cleanTranslatedSubtitle(text);
      } catch (error) {
        lastError = error;
        if (
          this.enableJsonOutput &&
          !disableStructuredOutput &&
          !structuredDowngradeUsed &&
          this.isStructuredOutputUnsupportedError(error)
        ) {
          structuredDowngradeUsed = true;
          disableStructuredOutput = true;
          log.warn(() => [`[${this.providerName}] Structured output not supported by this model/base, retrying without response_format`]);
          continue;
        }
        if (attempt < this.maxRetries) {
          log.warn(() => [`[${this.providerName}] Retry ${attempt + 1}/${this.maxRetries} after error:`, error.message]);
          continue;
        }
        handleTranslationError(error, this.providerName, { skipResponseData: true });
      }
    }

    // If retries exhausted and no throw occurred, surface last error cleanly
    if (lastError) {
      throw lastError;
    }
  }

  async streamTranslateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt = null, onPartial = null, requestOptions = {}) {
    const { userPrompt } = this.buildUserPrompt(subtitleContent, targetLanguage, customPrompt);
    const request = this.buildChatRequest(
      userPrompt,
      true,
      {
        subtitleContent,
        sourceLanguage,
        targetLanguage,
        disableStructuredOutput: requestOptions?.disableStructuredOutput === true
      }
    );

    if (request.isCfTranslation) {
      const full = await this.translateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt, requestOptions);
      if (typeof onPartial === 'function') {
        try { await onPartial(full); } catch (_) { }
      }
      return full;
    }

    const { body, url, isCfRun } = request;

    const executeStream = async () => {
      const agents = this.getHttpAgents();
      const response = await axios.post(
        url,
        body,
        {
          headers: this.getAuthHeaders(),
          timeout: this.translationTimeout,
          httpAgent: agents.httpAgent,
          httpsAgent: agents.httpsAgent,
          responseType: 'stream'
        }
      );

      const contentType = (response.headers && (response.headers['content-type'] || response.headers['Content-Type'])) || '';

      return await new Promise((resolve, reject) => {
        let buffer = '';
        let aggregated = '';
        let finishReason = null;
        let rawStream = '';

        const processPayload = (payloadStr) => {
          if (!payloadStr || !payloadStr.trim()) return;
          const cleaned = payloadStr.trim().startsWith('data:')
            ? payloadStr.trim().slice(5).trim()
            : payloadStr.trim();
          if (!cleaned || cleaned === '[DONE]') return;

          let data;
          try {
            data = JSON.parse(cleaned);
          } catch (_) {
            return;
          }

          if (isCfRun && (data.finished || data.done === true)) {
            finishReason = finishReason || 'stop';
          }

          const choice = data?.choices?.[0];
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }

          const chunkText = isCfRun
            ? this.extractCfChunkText(data)
            : this.extractChunkText(choice);
          if (chunkText) {
            aggregated += chunkText;
            const cleanedAgg = this.cleanTranslatedSubtitle(aggregated);
            if (typeof onPartial === 'function') {
              try { onPartial(cleanedAgg); } catch (_) { }
            }
          }
        };

        response.data.on('data', (chunk) => {
          try {
            const str = chunk.toString('utf8');
            rawStream += str;
            buffer += str;
            const parts = buffer.split(/\r?\n/);
            buffer = parts.pop();
            parts.forEach(processPayload);
          } catch (err) {
            log.warn(() => [`[${this.providerName}] Stream chunk processing failed:`, err.message]);
          }
        });

        response.data.on('end', () => {
          try {
            if (buffer && buffer.trim()) {
              processPayload(buffer);
            }

            if (!aggregated && rawStream.trim()) {
              const recovered = this.recoverStreamPayload(rawStream, isCfRun);
              aggregated = recovered.text || aggregated;
              finishReason = finishReason || recovered.finishReason;
            }

            const cleaned = this.cleanTranslatedSubtitle(aggregated);

            if (!cleaned) {
              if (finishReason === 'content_filter') {
                const err = new Error('PROHIBITED_CONTENT: content_filter');
                err.translationErrorType = 'PROHIBITED_CONTENT';
                reject(err);
                return;
              }
              reject(new Error('No content returned from stream'));
              return;
            }

            if (finishReason && finishReason !== 'stop' && finishReason !== 'tool_calls') {
              if (finishReason === 'content_filter') {
                const err = new Error('PROHIBITED_CONTENT: content_filter');
                err.translationErrorType = 'PROHIBITED_CONTENT';
                reject(err);
                return;
              }
              if (finishReason === 'length' && cleaned.length < subtitleContent.length * 0.3) {
                const err = new Error('MAX_TOKENS: Translation exceeded maximum token limit with minimal output');
                err.translationErrorType = 'MAX_TOKENS';
                reject(err);
                return;
              }
              log.warn(() => [`[${this.providerName}] Stream finished with reason: ${finishReason}`]);
            }

            resolve(cleaned);
          } catch (err) {
            reject(err);
          }
        });

        response.data.on('error', (err) => reject(err));
      });
    };

    let lastError;
    let fallbackUsed = false;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await executeStream();
      } catch (error) {
        lastError = error;

        // If streaming is not supported, fall back to non-stream once
        const status = error?.response?.status;
        const looksUnsupported = status === 400 || status === 404 || status === 405 || status === 501
          || (error.message && /stream/i.test(error.message));
        if (!fallbackUsed && looksUnsupported) {
          fallbackUsed = true;
          log.warn(() => [`[${this.providerName}] Streaming not supported for this model/base, falling back to non-stream`]);
          const full = await this.translateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt, requestOptions);
          if (typeof onPartial === 'function') {
            try { await onPartial(full); } catch (_) { }
          }
          return full;
        }

        if (attempt < this.maxRetries) {
          log.warn(() => [`[${this.providerName}] Stream retry ${attempt + 1}/${this.maxRetries} after error:`, error.message]);
          continue;
        }
        handleTranslationError(error, this.providerName, { skipResponseData: true });
      }
    }

    if (lastError) {
      throw lastError;
    }
  }

  async countTokensForTranslation() {
    return null; // Not supported on generic OpenAI-compatible APIs
  }

  extractChunkText(choice) {
    if (!choice) return '';

    // Modern responses may return delta.content as array of blocks
    const delta = choice.delta || {};
    const collect = [];

    if (Array.isArray(delta.content)) {
      for (const part of delta.content) {
        if (!part) continue;
        if (typeof part === 'string') {
          collect.push(part);
        } else if (typeof part.text === 'string') {
          collect.push(part.text);
        }
      }
    } else if (typeof delta.content === 'string') {
      collect.push(delta.content);
    } else if (typeof delta.text === 'string') {
      collect.push(delta.text);
    }

    // Fallback to full message content if delta missing
    if (collect.length === 0) {
      const msgContent = choice.message?.content;
      if (typeof msgContent === 'string') {
        collect.push(msgContent);
      } else if (Array.isArray(msgContent)) {
        collect.push(...msgContent.map(part => (typeof part === 'string' ? part : part?.text || '')).filter(Boolean));
      }
    }

    return collect.join('');
  }

  extractCfChunkText(payload) {
    if (!payload || typeof payload !== 'object') return '';
    if (typeof payload.response === 'string') return payload.response;
    if (payload.result) {
      if (typeof payload.result.response === 'string') return payload.result.response;
      if (typeof payload.result.output === 'string') return payload.result.output;
    }
    return '';
  }

  cleanTranslatedSubtitle(text) {
    let cleaned = String(text || '');
    cleaned = cleaned.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return cleaned.trim();
  }

  recoverStreamPayload(rawStream, isCfRun = false) {
    const result = {
      text: '',
      finishReason: null,
      payloadCount: 0
    };

    if (!rawStream || typeof rawStream !== 'string') {
      return result;
    }

    const processPayload = (payloadStr) => {
      if (!payloadStr) return;
      let data;
      try {
        data = JSON.parse(payloadStr);
      } catch (_) {
        return;
      }

      if (isCfRun) {
        const chunkText = this.extractCfChunkText(data);
        if (chunkText) {
          result.text += chunkText;
        }
        result.payloadCount += 1;
        return;
      }

      const choice = data?.choices?.[0];
      if (choice?.finish_reason && !result.finishReason) {
        result.finishReason = choice.finish_reason;
      }
      const chunkText = this.extractChunkText(choice);
      if (chunkText) {
        result.text += chunkText;
      }
      result.payloadCount += 1;
    };

    const blocks = rawStream.split(/\r?\n\r?\n/);
    for (const block of blocks) {
      const cleaned = block.split(/\r?\n/).map(line => line.replace(/^data:\s*/, '').trim()).filter(Boolean).join('');
      processPayload(cleaned);
    }

    if (result.payloadCount === 0) {
      const lines = rawStream.split(/\r?\n/);
      for (const line of lines) {
        const cleaned = line.replace(/^data:\s*/, '').trim();
        processPayload(cleaned);
      }
    }

    if (result.payloadCount === 0 && rawStream.includes('}{')) {
      const pieces = rawStream.split(/}\s*(?=\{)/).map((piece, idx, arr) => (idx < arr.length - 1 ? `${piece}}` : piece));
      for (let i = 0; i < pieces.length; i++) {
        let segment = pieces[i];
        if (segment && segment[0] !== '{') segment = `{${segment}`;
        processPayload(segment.trim());
      }
    }

    return result;
  }
}

module.exports = OpenAICompatibleProvider;
