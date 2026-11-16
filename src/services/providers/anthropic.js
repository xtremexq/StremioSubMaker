const axios = require('axios');
const { handleTranslationError, isResponseTooLargeError, logApiError } = require('../../utils/apiErrorHandler');
const { httpAgent, httpsAgent } = require('../../utils/httpAgents');
const log = require('../../utils/logger');
const { sanitizeApiKeyForHeader } = require('../../utils/security');
const { MAX_AI_RESPONSE_BYTES } = require('../../utils/resourceLimits');
const { DEFAULT_TRANSLATION_PROMPT } = require('../gemini');
const { normalizeTargetLanguageForPrompt } = require('../utils/normalizeTargetLanguageForPrompt');

const ANTHROPIC_API_URL = process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || '2023-06-01';

// API version from which temperature/top_p/top_k are rejected on every model.
const SAMPLING_FREE_API_VERSION = '2026-10-21';
const LEGACY_CLAUDE_FAMILIES = new Set(['opus', 'sonnet', 'haiku']);

/**
 * Parse a Claude model id into { family, major, minor }.
 * Handles current ids (claude-opus-4-7, claude-sonnet-4-20250514, claude-haiku-4-5-20251001,
 * claude-fable-5-2) and Claude 3 ids (claude-3-5-sonnet-20241022). Returns null otherwise.
 */
function parseClaudeModelId(modelId) {
  const id = String(modelId || '').trim().toLowerCase();

  const current = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?=-|$))?/);
  if (current) {
    return {
      family: current[1],
      major: parseInt(current[2], 10),
      minor: current[3] !== undefined ? parseInt(current[3], 10) : 0
    };
  }

  const legacy = id.match(/^claude-(\d+)(?:-(\d+))?-([a-z]+)/);
  if (legacy) {
    return {
      family: legacy[3],
      major: parseInt(legacy[1], 10),
      minor: legacy[2] !== undefined ? parseInt(legacy[2], 10) : 0
    };
  }

  return null;
}

/**
 * Which request fields a Claude model accepts.
 *
 * - Opus 4.7+, Sonnet 5+, Haiku 5+, Fable and Mythos return 400 for temperature/top_p/top_k
 *   and for thinking.type "enabled" with budget_tokens (they take adaptive thinking only).
 * - Every Claude 4 model returns 400 when temperature and top_p are sent together.
 * - Opus 4.6+, Sonnet 4.6+ and the models above return 400 for a final assistant prefill.
 * - API version 2026-10-21 rejects temperature/top_p/top_k on every model.
 *
 * Unrecognized ids keep the original request shape; the retry handlers still adjust it
 * if the API rejects a field.
 *
 * @returns {{ sampling: 'all'|'temperature'|'none', thinking: 'budget'|'adaptive', assistantPrefill: boolean }}
 */
function getClaudeRequestCapabilities(modelId, apiVersion = ANTHROPIC_VERSION) {
  const capabilities = {
    sampling: 'all',
    thinking: 'budget',
    assistantPrefill: true
  };

  const parsed = parseClaudeModelId(modelId);
  if (parsed) {
    const { family, major, minor } = parsed;
    const atLeast = (m, n = 0) => major > m || (major === m && minor >= n);
    const isCurrentGeneration = !LEGACY_CLAUDE_FAMILIES.has(family)
      ? atLeast(5)
      : (family === 'opus' ? atLeast(4, 7) : atLeast(5));

    if (isCurrentGeneration) {
      capabilities.sampling = 'none';
      capabilities.thinking = 'adaptive';
      capabilities.assistantPrefill = false;
    } else if (major >= 4) {
      capabilities.sampling = 'temperature';
      if ((family === 'opus' || family === 'sonnet') && atLeast(4, 6)) {
        capabilities.assistantPrefill = false;
      }
    }
  }

  if (String(apiVersion || '') >= SAMPLING_FREE_API_VERSION) {
    capabilities.sampling = 'none';
  }

  return capabilities;
}

class AnthropicProvider {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.model = options.model || '';
    this.providerName = options.providerName || 'anthropic';
    this.maxOutputTokens = Number.isFinite(parseInt(options.maxOutputTokens, 10))
      ? Math.max(1, parseInt(options.maxOutputTokens, 10))
      : 4000;
    this.temperature = options.temperature !== undefined
      ? Math.max(0, Math.min(2, parseFloat(options.temperature)))
      : 0.4;
    this.topP = options.topP !== undefined
      ? Math.max(0, Math.min(1, parseFloat(options.topP)))
      : 0.95;
    this.thinkingBudget = Number.isFinite(parseInt(options.thinkingBudget, 10))
      ? Math.max(0, parseInt(options.thinkingBudget, 10))
      : 0;
    const timeoutSeconds = options.translationTimeout !== undefined ? options.translationTimeout : 60;
    this.translationTimeout = Math.max(5000, parseInt(timeoutSeconds * 1000, 10) || 60000);
    this.maxRetries = Number.isFinite(parseInt(options.maxRetries, 10))
      ? Math.max(0, parseInt(options.maxRetries, 10))
      : 2;
    // JSON structured output mode
    this.enableJsonOutput = options.enableJsonOutput === true;
    this.capabilities = getClaudeRequestCapabilities(this.model);
  }

  normalizeTargetName(name) {
    return normalizeTargetLanguageForPrompt(name);
  }

  buildUserPrompt(subtitleContent, targetLanguage, customPrompt = null) {
    const normalizedTarget = this.normalizeTargetName(targetLanguage);
    const systemPrompt = (customPrompt || DEFAULT_TRANSLATION_PROMPT).replace('{target_language}', normalizedTarget);
    const userPrompt = `${systemPrompt}\n\nContent to translate:\n\n${subtitleContent}`;
    return { systemPrompt, userPrompt };
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

  buildRequestBody(subtitleContent, targetLanguage, customPrompt = null, stream = false, requestOptions = {}) {
    const { systemPrompt, userPrompt } = this.buildUserPrompt(subtitleContent, targetLanguage, customPrompt);
    const { maxTokens, thinkingBudget, thinkingEnabled } = this.buildTokenBudgets();
    const capabilities = this.capabilities;
    const omitSampling = requestOptions.omitSampling === true || capabilities.sampling === 'none';
    const useAdaptiveThinking = requestOptions.useAdaptiveThinking === true || capabilities.thinking === 'adaptive';
    const forceTemperatureOne = requestOptions.forceTemperatureOne === true || thinkingEnabled;
    const disableTopP = requestOptions.disableTopP === true || thinkingEnabled || capabilities.sampling === 'temperature';
    const disableJsonPrefill = requestOptions.disableJsonPrefill === true || !capabilities.assistantPrefill;
    const effectiveTemperature = forceTemperatureOne ? 1 : this.temperature;

    const body = {
      model: this.model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt }
      ]
    };

    if (!omitSampling) {
      body.temperature = effectiveTemperature;
      if (!disableTopP && this.topP !== undefined) {
        body.top_p = this.topP;
      }
    }
    if (thinkingEnabled && thinkingBudget > 0) {
      body.thinking = useAdaptiveThinking
        ? { type: 'adaptive' }
        : { type: 'enabled', budget_tokens: thinkingBudget };
    }

    // JSON structured output: prefill assistant response with "[" to force JSON array output.
    // Skipped when thinking is enabled (prefill conflicts with thinking) and on models that
    // reject a final assistant message.
    const usedJsonPrefill = this.enableJsonOutput && !thinkingEnabled && !disableJsonPrefill;
    if (usedJsonPrefill) {
      body.messages.push({ role: 'assistant', content: '[' });
    }

    if (stream) {
      body.stream = true;
    }

    return { body, systemPrompt, userPrompt, thinkingBudget, thinkingEnabled, usedJsonPrefill };
  }

  /**
   * Claude "thinking" consumes tokens from the same max_tokens budget as text.
   * Keep a small output reserve and cap to the Anthropic limit to avoid request errors.
   */
  buildTokenBudgets() {
    const MAX_TOTAL_TOKENS = 200000;
    const MIN_OUTPUT_TOKENS_WITH_THINKING = 512;

    const outputTokens = Math.max(1, Math.floor(this.maxOutputTokens));
    const requestedThinking = Math.max(0, Math.floor(this.thinkingBudget));

    // No thinking requested; just cap total tokens to Anthropic limit
    if (requestedThinking === 0) {
      return {
        maxTokens: Math.min(MAX_TOTAL_TOKENS, outputTokens),
        thinkingBudget: 0,
        thinkingEnabled: false
      };
    }

    // Sum output + requested thinking, then cap to provider limit
    let combined = outputTokens + requestedThinking;
    let maxTokens = Math.min(MAX_TOTAL_TOKENS, combined);

    // Ensure we keep some room for actual output tokens
    let thinkingBudget = Math.min(requestedThinking, maxTokens - MIN_OUTPUT_TOKENS_WITH_THINKING);
    if (thinkingBudget <= 0) {
      log.warn(() => `[${this.providerName}] Dropping thinking budget (${requestedThinking}) because it leaves insufficient room for output (max_tokens=${maxTokens}, reserve=${MIN_OUTPUT_TOKENS_WITH_THINKING}).`);
      return {
        maxTokens: Math.min(MAX_TOTAL_TOKENS, outputTokens),
        thinkingBudget: 0,
        thinkingEnabled: false
      };
    }

    if (thinkingBudget !== requestedThinking || combined > MAX_TOTAL_TOKENS) {
      log.warn(() => `[${this.providerName}] Adjusted thinking budget to ${thinkingBudget} tokens (requested ${requestedThinking}) and max_tokens to ${maxTokens} to respect Claude thinking limits.`);
    }

    return {
      maxTokens,
      thinkingBudget,
      thinkingEnabled: true
    };
  }

  getHeaders() {
    // Sanitize API key to prevent header injection vulnerabilities
    return {
      'x-api-key': sanitizeApiKeyForHeader(this.apiKey) || '',
      'anthropic-version': ANTHROPIC_VERSION
    };
  }

  async getAvailableModels() {
    try {
      const response = await axios.get(`${ANTHROPIC_API_URL}/models`, {
        headers: this.getHeaders(),
        timeout: 10000,
        httpAgent,
        httpsAgent,
        maxContentLength: MAX_AI_RESPONSE_BYTES
      });

      const models = Array.isArray(response.data?.data) ? response.data.data : [];
      return models.map(m => ({
        name: m.id || m.name,
        displayName: m.display_name || m.displayName || m.id || m.name,
        description: m.description || '',
        maxTokens: m.input_tokens || m.max_tokens || undefined
      })).filter(m => !!m.name);
    } catch (error) {
      logApiError(error, this.providerName, 'Fetch models', { skipResponseData: true });
      return [];
    }
  }

  extractErrorMessage(error) {
    return String(
      error?.response?.data?.error?.message ||
      error?.response?.data?.message ||
      error?.message ||
      ''
    ).toLowerCase();
  }

  isTopPTemperatureConflict(error) {
    const status = error?.response?.status || error?.status || error?.statusCode || 0;
    const msg = this.extractErrorMessage(error);
    return status === 400 && msg.includes('temperature') && msg.includes('top_p') && msg.includes('cannot both');
  }

  isThinkingTemperatureConstraint(error) {
    const status = error?.response?.status || error?.status || error?.statusCode || 0;
    const msg = this.extractErrorMessage(error);
    return status === 400
      && msg.includes('thinking')
      && msg.includes('temperature')
      && (msg.includes('must be') || msg.includes('required'));
  }

  isPrefillUnsupported(error) {
    const status = error?.response?.status || error?.status || error?.statusCode || 0;
    const msg = this.extractErrorMessage(error);
    return status === 400
      && (msg.includes('assistant prefill') || msg.includes('prefill'))
      && (msg.includes('not supported') || msg.includes('deprecated') || msg.includes('unsupported'));
  }

  // Newer models reject sampling parameters outright (any value, or any non-default value).
  isSamplingParameterUnsupported(error) {
    const status = error?.response?.status || error?.status || error?.statusCode || 0;
    if (status !== 400) return false;
    if (this.isTopPTemperatureConflict(error) || this.isThinkingTemperatureConstraint(error)) return false;
    const msg = this.extractErrorMessage(error);
    return /\b(temperature|top_p|top_k)\b/.test(msg);
  }

  // Newer models accept adaptive thinking only, not thinking.type "enabled" with budget_tokens.
  isBudgetThinkingUnsupported(error) {
    const status = error?.response?.status || error?.status || error?.statusCode || 0;
    const msg = this.extractErrorMessage(error);
    return status === 400
      && (msg.includes('budget_tokens') || (msg.includes('thinking') && msg.includes('adaptive')));
  }

  isStreamingUnsupported(error) {
    const status = error?.response?.status || error?.status || error?.statusCode || 0;
    const msg = this.extractErrorMessage(error);
    if (status === 404 || status === 405 || status === 501) return true;
    if (status === 400 && (msg.includes('stream') || msg.includes('sse') || msg.includes('event-stream'))) return true;
    return !!(error?.message && /stream/i.test(error.message));
  }

  async translateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt = null, requestOptions = {}) {
    let lastError;
    let disableTopP = requestOptions?.disableTopP === true;
    let disableJsonPrefill = requestOptions?.disableJsonPrefill === true;
    let forceTemperatureOne = requestOptions?.forceTemperatureOne === true;
    let omitSampling = requestOptions?.omitSampling === true;
    let useAdaptiveThinking = requestOptions?.useAdaptiveThinking === true;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const { body, usedJsonPrefill } = this.buildRequestBody(
          subtitleContent,
          targetLanguage,
          customPrompt,
          false,
          { disableTopP, disableJsonPrefill, forceTemperatureOne, omitSampling, useAdaptiveThinking }
        );
        const response = await axios.post(
          `${ANTHROPIC_API_URL}/messages`,
          body,
          {
            headers: this.getHeaders(),
            timeout: this.translationTimeout,
            httpAgent,
            httpsAgent,
            maxContentLength: MAX_AI_RESPONSE_BYTES
          }
        );

        const blocks = response.data?.content || [];
        const text = blocks.map(block => block.text).filter(Boolean).join('\n').trim();
        if (!text) {
          throw new Error('No translation returned from Anthropic');
        }

        // When JSON prefill was used, the response won't include the leading "["
        // we sent as the assistant prefill — prepend it so downstream JSON parsing works.
        const fullText = usedJsonPrefill ? `[${text}` : text;

        return this.cleanTranslatedSubtitle(fullText);
      } catch (error) {
        lastError = error;
        if (isResponseTooLargeError(error)) {
          handleTranslationError(error, this.providerName, { skipResponseData: true });
        }
        if (!disableTopP && this.isTopPTemperatureConflict(error)) {
          disableTopP = true;
          log.warn(() => [`[${this.providerName}] Model rejected temperature+top_p together, retrying without top_p`]);
          continue;
        }
        if (!forceTemperatureOne && this.isThinkingTemperatureConstraint(error)) {
          forceTemperatureOne = true;
          disableTopP = true;
          log.warn(() => [`[${this.providerName}] Model requires temperature=1 with thinking, retrying with compliant settings`]);
          continue;
        }
        if (!omitSampling && this.isSamplingParameterUnsupported(error)) {
          omitSampling = true;
          log.warn(() => [`[${this.providerName}] Model rejected sampling parameters, retrying without temperature/top_p`]);
          continue;
        }
        if (!useAdaptiveThinking && this.isBudgetThinkingUnsupported(error)) {
          useAdaptiveThinking = true;
          log.warn(() => [`[${this.providerName}] Model rejected budget_tokens thinking, retrying with adaptive thinking`]);
          continue;
        }
        if (this.enableJsonOutput && !disableJsonPrefill && this.isPrefillUnsupported(error)) {
          disableJsonPrefill = true;
          log.warn(() => [`[${this.providerName}] Assistant prefill unsupported on this model, retrying without prefill`]);
          continue;
        }
        if (attempt < this.maxRetries) {
          log.warn(() => [`[${this.providerName}] Retry ${attempt + 1}/${this.maxRetries} after error:`, error.message]);
          continue;
        }
        handleTranslationError(error, this.providerName, { skipResponseData: true });
      }
    }

    if (lastError) {
      throw lastError;
    }
  }

  async streamTranslateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt = null, onPartial = null, requestOptions = {}) {
    const executeStream = async (body, usedJsonPrefill) => {
      const response = await axios.post(
        `${ANTHROPIC_API_URL}/messages`,
        body,
        {
          headers: this.getHeaders(),
          timeout: this.translationTimeout,
          httpAgent,
          httpsAgent,
          responseType: 'stream',
          maxContentLength: MAX_AI_RESPONSE_BYTES
        }
      );

      return await new Promise((resolve, reject) => {
        let buffer = '';
        let aggregated = '';
        let finishReason = null;
        let rawStream = '';
        const blockTypes = new Map();

        const processEventBlock = (block) => {
          if (!block || !block.trim()) return;

          const lines = block.split(/\r?\n/).filter(Boolean);
          let eventType = '';
          const dataLines = [];

          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trim());
            } else {
              dataLines.push(line.trim());
            }
          }

          const dataStr = dataLines.join('');
          if (!dataStr) return;

          let payload;
          try {
            payload = JSON.parse(dataStr);
          } catch (_) {
            return;
          }

          // Record content block types so we can ignore thinking/tool blocks
          if (eventType === 'content_block_start' && typeof payload.index === 'number') {
            if (payload.content_block?.type) {
              blockTypes.set(payload.index, payload.content_block.type);
            }
            return;
          }

          if (eventType === 'content_block_delta' && typeof payload.index === 'number') {
            const blockType = blockTypes.get(payload.index) || payload.delta?.type;
            const delta = payload.delta || {};
            if (blockType === 'text' && delta.type === 'text_delta' && typeof delta.text === 'string') {
              aggregated += delta.text;
              const cleanedAgg = this.cleanTranslatedSubtitle(aggregated);
              if (typeof onPartial === 'function') {
                try { onPartial(cleanedAgg); } catch (_) { }
              }
            }
            return;
          }

          if (eventType === 'message_delta') {
            const reason = payload?.delta?.stop_reason;
            if (reason) {
              finishReason = finishReason || reason;
            }
            return;
          }

          if (eventType === 'message_stop') {
            const reason = payload?.stop_reason;
            if (reason) {
              finishReason = finishReason || reason;
            }
            return;
          }

          if (eventType === 'error') {
            const message = payload?.error?.message || 'Stream error';
            const err = new Error(message);
            reject(err);
          }
        };

        response.data.on('data', (chunk) => {
          try {
            const str = chunk.toString('utf8');
            rawStream += str;
            buffer += str;
            const parts = buffer.split(/\r?\n\r?\n/);
            buffer = parts.pop();
            parts.forEach(processEventBlock);
          } catch (err) {
            log.warn(() => [`[${this.providerName}] Stream chunk processing failed:`, err.message]);
          }
        });

        response.data.on('end', () => {
          try {
            if (buffer && buffer.trim()) {
              processEventBlock(buffer);
            }

            if (!aggregated && rawStream.trim()) {
              const recovered = this.recoverStreamPayload(rawStream);
              aggregated = recovered.text || aggregated;
              finishReason = finishReason || recovered.finishReason;
            }

            // Prepend the "[" prefill for JSON mode (same as non-stream path)
            const fullAggregated = usedJsonPrefill ? `[${aggregated}` : aggregated;

            const cleaned = this.cleanTranslatedSubtitle(fullAggregated);

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

            if (finishReason && finishReason !== 'end_turn' && finishReason !== 'stop') {
              if (finishReason === 'content_filter') {
                const err = new Error('PROHIBITED_CONTENT: content_filter');
                err.translationErrorType = 'PROHIBITED_CONTENT';
                reject(err);
                return;
              }
              if ((finishReason === 'max_tokens' || finishReason === 'length') && cleaned.length < subtitleContent.length * 0.3) {
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
    let disableTopP = requestOptions?.disableTopP === true;
    let disableJsonPrefill = requestOptions?.disableJsonPrefill === true;
    let forceTemperatureOne = requestOptions?.forceTemperatureOne === true;
    let omitSampling = requestOptions?.omitSampling === true;
    let useAdaptiveThinking = requestOptions?.useAdaptiveThinking === true;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const { body, usedJsonPrefill } = this.buildRequestBody(
          subtitleContent,
          targetLanguage,
          customPrompt,
          true,
          { disableTopP, disableJsonPrefill, forceTemperatureOne, omitSampling, useAdaptiveThinking }
        );
        return await executeStream(body, usedJsonPrefill);
      } catch (error) {
        lastError = error;

        if (isResponseTooLargeError(error)) {
          handleTranslationError(error, this.providerName, { skipResponseData: true });
        }

        if (!disableTopP && this.isTopPTemperatureConflict(error)) {
          disableTopP = true;
          log.warn(() => [`[${this.providerName}] Model rejected temperature+top_p together (stream), retrying without top_p`]);
          continue;
        }
        if (!forceTemperatureOne && this.isThinkingTemperatureConstraint(error)) {
          forceTemperatureOne = true;
          disableTopP = true;
          log.warn(() => [`[${this.providerName}] Model requires temperature=1 with thinking (stream), retrying with compliant settings`]);
          continue;
        }
        if (!omitSampling && this.isSamplingParameterUnsupported(error)) {
          omitSampling = true;
          log.warn(() => [`[${this.providerName}] Model rejected sampling parameters (stream), retrying without temperature/top_p`]);
          continue;
        }
        if (!useAdaptiveThinking && this.isBudgetThinkingUnsupported(error)) {
          useAdaptiveThinking = true;
          log.warn(() => [`[${this.providerName}] Model rejected budget_tokens thinking (stream), retrying with adaptive thinking`]);
          continue;
        }
        if (this.enableJsonOutput && !disableJsonPrefill && this.isPrefillUnsupported(error)) {
          disableJsonPrefill = true;
          log.warn(() => [`[${this.providerName}] Assistant prefill unsupported on this model (stream), retrying without prefill`]);
          continue;
        }

        const status = error?.response?.status;
        const looksUnsupported = this.isStreamingUnsupported(error);
        const shouldFallbackToNonStream = !fallbackUsed && (looksUnsupported || status === 400);
        if (shouldFallbackToNonStream) {
          fallbackUsed = true;
          if (looksUnsupported) {
            log.warn(() => [`[${this.providerName}] Streaming not supported for this model/base, falling back to non-stream`]);
          } else {
            log.warn(() => [`[${this.providerName}] Stream request returned 400, retrying via non-stream path for better compatibility`]);
          }
          const full = await this.translateSubtitle(
            subtitleContent,
            sourceLanguage,
            targetLanguage,
            customPrompt,
            { disableTopP, disableJsonPrefill, forceTemperatureOne, omitSampling, useAdaptiveThinking }
          );
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
    return null;
  }

  cleanTranslatedSubtitle(text) {
    let cleaned = String(text || '');
    cleaned = cleaned.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return cleaned.trim();
  }

  recoverStreamPayload(rawStream) {
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

      if (data?.type === 'content_block_delta' && data.delta?.type === 'text_delta' && typeof data.delta.text === 'string') {
        result.text += data.delta.text;
      }
      if (data?.type === 'message_delta' && data.delta?.stop_reason && !result.finishReason) {
        result.finishReason = data.delta.stop_reason;
      }
      result.payloadCount += 1;
    };

    const lines = rawStream.split(/\r?\n/);
    for (const line of lines) {
      const cleaned = line.replace(/^data:\s*/, '').trim();
      if (!cleaned) continue;
      processPayload(cleaned);
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

module.exports = AnthropicProvider;
module.exports.getClaudeRequestCapabilities = getClaudeRequestCapabilities;
module.exports.parseClaudeModelId = parseClaudeModelId;
