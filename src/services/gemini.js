const axios = require('axios');
const { handleTranslationError, logApiError } = require('../utils/apiErrorHandler');
const { httpAgent, httpsAgent } = require('../utils/httpAgents');
const log = require('../utils/logger');
const { resolveLanguageDisplayName } = require('../utils/languageResolver');
const { normalizeTargetLanguageForPrompt } = require('./utils/normalizeTargetLanguageForPrompt');

// Use v1beta endpoint - v1 endpoint doesn't support /models/{model} operations
const GEMINI_API_URL = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';

// Normalize human-readable target language names for Gemini prompts
function normalizeTargetName(name) {
  const raw = String(name || '').trim();
  if (!raw) return 'target language';

  const resolved = resolveLanguageDisplayName(raw) || raw;
  return normalizeTargetLanguageForPrompt(resolved);
}

// Default translation prompt (base - thinking rules added conditionally)
const DEFAULT_TRANSLATION_PROMPT = `Translate the following subtitles while:

1. Preserving the timing and structure exactly as given
2. Maintaining natural dialogue flow and colloquialisms appropriate to the target language
3. Keeping the same number of lines and line breaks
4. Preserving any formatting tags or special characters
5. Ensuring translations are contextually accurate for film/TV dialogue

Translate to {target_language}.

Do NOT include acknowledgements, explanations, notes or alternative translations.

Output ONLY the translated content, nothing else.`;

class GeminiService {
  constructor(apiKey, model = '', advancedSettings = {}) {
    this.apiKey = apiKey;
    // Fallback to default if model not provided (config.js handles env var override)
    this.model = model || 'gemini-3-flash-preview';
    this.isGemmaModel = String(this.model).toLowerCase().includes('gemma');
    this.baseUrl = GEMINI_API_URL;

    // Advanced settings with environment variable fallbacks
    // Priority: advancedSettings param > environment variables > hardcoded defaults

    // Max output tokens (default: 65536)
    this.maxOutputTokens = advancedSettings.maxOutputTokens
      || parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS)
      || 65536;

    // Timeout in milliseconds (env is in seconds, convert to ms)
    const timeoutSeconds = advancedSettings.translationTimeout
      || parseInt(process.env.GEMINI_TRANSLATION_TIMEOUT)
      || 600;
    this.timeout = timeoutSeconds * 1000;

    // Max retries (default: 3)
    this.maxRetries = advancedSettings.maxRetries !== undefined
      ? advancedSettings.maxRetries
      : (process.env.GEMINI_MAX_RETRIES !== undefined ? parseInt(process.env.GEMINI_MAX_RETRIES) : 3);

    // Thinking budget (default: 0)
    // Special handling: -1 means dynamic thinking (null to API)
    const envThinking = process.env.GEMINI_THINKING_BUDGET !== undefined
      ? parseInt(process.env.GEMINI_THINKING_BUDGET)
      : 0;
    this.thinkingBudget = advancedSettings.thinkingBudget !== undefined
      ? advancedSettings.thinkingBudget
      : envThinking;

    // Temperature (default: 0.8)
    this.temperature = advancedSettings.temperature !== undefined
      ? advancedSettings.temperature
      : (process.env.GEMINI_TEMPERATURE !== undefined ? parseFloat(process.env.GEMINI_TEMPERATURE) : 0.8);

    // Top-K (default: 40)
    this.topK = advancedSettings.topK !== undefined
      ? advancedSettings.topK
      : (process.env.GEMINI_TOP_K !== undefined ? parseInt(process.env.GEMINI_TOP_K) : 40);

    // Top-P (default: 0.95)
    this.topP = advancedSettings.topP !== undefined
      ? advancedSettings.topP
      : (process.env.GEMINI_TOP_P !== undefined ? parseFloat(process.env.GEMINI_TOP_P) : 0.95);

    if (this.isGemmaModel) {
      // Gemma models don't support thinkingConfig and have lower output limits.
      this.maxOutputTokens = 8192;
    }
  }

  getEffectiveThinkingBudget() {
    return this.isGemmaModel ? 0 : this.thinkingBudget;
  }

  /**
   * Get available models from Gemini API
   */
  async getAvailableModels(options = {}) {
    const silent = !!options.silent;
    try {
      const response = await axios.get(`${this.baseUrl}/models`, {
        // Use header form for API key to avoid query parsing/proxy quirks
        headers: { 'x-goog-api-key': String(this.apiKey || '').trim() },
        timeout: 10000,
        httpAgent,
        httpsAgent
      });

      if (!response.data || !response.data.models) {
        return [];
      }

      const models = response.data.models
        .filter(model => model.supportedGenerationMethods?.includes('generateContent'))
        .map(model => ({
          name: model.name.replace('models/', ''),
          displayName: model.displayName || model.name,
          description: model.description || '',
          maxTokens: model.inputTokenLimit || 30000
        }));

      return models;

    } catch (error) {
      if (!silent) {
        // Log response details to help diagnose issues when not in config UI
        logApiError(error, 'Gemini', 'Fetch models', { skipResponseData: true });
      }
      return [];
    }
  }

  /**
   * Fetch model limits (input/output token limits) and cache them
   */
  async getModelLimits() {
    if (this._modelLimits) {
      return this._modelLimits;
    }

    try {
      const response = await axios.get(`${this.baseUrl}/models/${this.model}`, {
        headers: { 'x-goog-api-key': String(this.apiKey || '').trim() },
        timeout: 10000,
        httpAgent,
        httpsAgent
      });

      const data = response.data || {};
      const limits = {
        inputTokenLimit: data.inputTokenLimit,
        outputTokenLimit: data.outputTokenLimit
      };

      // Fallback heuristics by model family if not provided
      if (!limits.outputTokenLimit) {
        const modelName = String(this.model).toLowerCase();
        // Gemini 2.0 models have 8k output, 2.5 models have 65k output
        if (modelName.includes('2.0') || modelName.includes('-flash-001') || modelName.includes('-flash-lite-001')) {
          limits.outputTokenLimit = 8192;
        } else if (modelName.includes('2.5')) {
          limits.outputTokenLimit = 65536;
        } else {
          // Unknown model - use conservative 8k limit for safety
          limits.outputTokenLimit = 8192;
        }
      }

      log.debug(() => `[Gemini] Model: ${this.model}, Output limit: ${limits.outputTokenLimit}, Input limit: ${limits.inputTokenLimit || 'unlimited'}`);

      // Log Gemini API configuration for debugging
      const effectiveThinkingBudget = this.getEffectiveThinkingBudget();
      const thinkingDisplay = effectiveThinkingBudget === -1 ? 'dynamic' :
        effectiveThinkingBudget === 0 ? 'disabled' :
          effectiveThinkingBudget;
      log.debug(() => `[Gemini] API config: temperature=${this.temperature}, topK=${this.topK}, topP=${this.topP}, thinkingBudget=${thinkingDisplay}, maxOutputTokens=${this.maxOutputTokens}, timeout=${this.timeout / 1000}s, maxRetries=${this.maxRetries}`);

      this._modelLimits = limits;
      return limits;
    } catch (error) {
      log.warn(() => ['[Gemini] Could not fetch model limits, using conservative defaults:', error.message]);
      const modelName = String(this.model).toLowerCase();
      const limits = {
        inputTokenLimit: undefined,
        outputTokenLimit: modelName.includes('2.5') ? 65536 : 8192 // 2.0 = 8k, 2.5 = 65k
      };
      log.debug(() => `[Gemini] Fallback limits for ${this.model}: ${limits.outputTokenLimit} output tokens`);
      this._modelLimits = limits;
      return limits;
    }
  }

  /**
   * Get default models as fallback
   */
  getDefaultModels() {
    return [];
  }

  /**
   * Retry a function with exponential backoff
   */
  async retryWithBackoff(fn, maxRetries = null, baseDelay = 3000) {
    maxRetries = maxRetries !== null ? maxRetries : this.maxRetries;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const isLastAttempt = attempt === maxRetries;
        const isTimeout = error.message.includes('timeout') || error.code === 'ECONNABORTED';
        const isNetworkError = error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND';
        const isSocketHangup = error.message.includes('socket hang up') || error.code === 'ECONNRESET';
        const isRateLimit = error.response?.status === 429;
        const isServiceUnavailable = error.response?.status === 503;

        // Retry for: timeouts, network errors, rate limits (429), and service unavailable (503)
        const isRetryable = isTimeout || isNetworkError || isSocketHangup || isRateLimit || isServiceUnavailable;

        if (isLastAttempt || !isRetryable) {
          throw error;
        }

        const delay = baseDelay * Math.pow(2, attempt);
        const errorType = isRateLimit ? '429 rate limit' :
          isServiceUnavailable ? '503 service unavailable' :
            isSocketHangup ? 'socket hang up' :
              isTimeout ? 'timeout' : 'network error';
        log.debug(() => `[Gemini] Attempt ${attempt + 1} failed (${errorType}), retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Build the user prompt exactly as used for translation (shared between translation and token counting)
   * @param {string} subtitleContent
   * @param {string} targetLanguage
   * @param {string|null} customPrompt
   * @returns {{userPrompt: string, systemPrompt: string, normalizedTarget: string}}
   */
  buildUserPrompt(subtitleContent, targetLanguage, customPrompt = null) {
    // Normalize target language to a human-readable form
    const normalizedTarget = normalizeTargetName(targetLanguage);

    // Prepare the prompt
    let systemPrompt = (customPrompt || DEFAULT_TRANSLATION_PROMPT)
      .replace('{target_language}', normalizedTarget);

    // Add thinking-specific rules only when thinking is enabled (thinkingBudget !== 0)
    // When thinking is disabled (thinkingBudget === 0), these rules are unnecessary
    const effectiveThinkingBudget = this.getEffectiveThinkingBudget();
    if (effectiveThinkingBudget !== 0) {
      // Find the last "Do NOT" line and add the thinking rules after it
      const doNotPattern = /(Do NOT include acknowledgements[^\n]+)\n/;
      if (doNotPattern.test(systemPrompt)) {
        systemPrompt = systemPrompt.replace(
          doNotPattern,
          '$1\nDo NOT overthink. Do NOT overplan.\n'
        );
      } else {
        // Fallback: add before "Output ONLY" if pattern not found
        systemPrompt = systemPrompt.replace(
          /\n(Output ONLY)/,
          '\n\nDo NOT overthink. Do NOT overplan.\n\n$1'
        );
      }
    }

    const userPrompt = `${systemPrompt}\n\nContent to translate:\n\n${subtitleContent}`;

    return { userPrompt, systemPrompt, normalizedTarget };
  }

  /**
   * Ask Gemini to count tokens for a translation request (real value from API)
   * Falls back to null when unavailable so callers can use estimates.
   */
  async countTokensForTranslation(subtitleContent, targetLanguage, customPrompt = null) {
    const { userPrompt } = this.buildUserPrompt(subtitleContent, targetLanguage, customPrompt);

    try {
      const response = await axios.post(
        `${this.baseUrl}/models/${this.model}:countTokens`,
        {
          contents: [{
            parts: [{ text: userPrompt }]
          }]
        },
        {
          headers: { 'x-goog-api-key': String(this.apiKey || '').trim() },
          timeout: 10000,
          httpAgent,
          httpsAgent
        }
      );

      if (response.data && typeof response.data.totalTokens === 'number') {
        return response.data.totalTokens;
      }

      log.warn(() => '[Gemini] Token count response missing totalTokens, falling back to estimate');
      return null;
    } catch (error) {
      logApiError(error, 'Gemini', 'Count tokens', { skipResponseData: true });
      return null;
    }
  }

  /**
   * Translate subtitle content (single API call)
   * @param {string} subtitleContent - Content to translate
   * @param {string} sourceLanguage - Source language name (unused, kept for compatibility)
   * @param {string} targetLanguage - Target language name
   * @param {string} customPrompt - Custom translation prompt (optional)
   * @returns {Promise<string>} - Translated content
   */
  async translateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt = null) {
    return this.retryWithBackoff(async () => {
      try {
        const { userPrompt } = this.buildUserPrompt(subtitleContent, targetLanguage, customPrompt);

        // Calculate dynamic output token limit
        const estimatedInputTokens = this.estimateTokenCount(userPrompt);
        const estimatedSubtitleTokens = this.estimateTokenCount(subtitleContent);

        // Fetch model output limits and respect them with a safety margin
        const limits = await this.getModelLimits();
        const modelOutputCap = typeof limits.outputTokenLimit === 'number' ? limits.outputTokenLimit : this.maxOutputTokens;
        const safetyMargin = Math.floor(modelOutputCap * 0.05); // 5% safety margin

        // Reserve tokens for thinking budget
        const thinkingBudget = this.getEffectiveThinkingBudget();
        const thinkingReserve = thinkingBudget > 0 ? thinkingBudget : 0;
        const availableForOutput = Math.max(1024, Math.min(this.maxOutputTokens, modelOutputCap - safetyMargin - thinkingReserve));

        // When thinking is enabled (dynamic or fixed budget), don't limit output based on subtitle size
        // Thinking can consume significant tokens, so we need the full available output capacity
        let estimatedOutputTokens;
        if (thinkingBudget !== 0) {
          // Thinking enabled: use full available output (thinking will consume part of maxOutputTokens)
          estimatedOutputTokens = availableForOutput;
        } else {
          // Thinking disabled: use 3.5x multiplier for subtitle content (translations can expand 2-3x+)
          estimatedOutputTokens = Math.floor(Math.min(
            availableForOutput,
            Math.max(8192, estimatedSubtitleTokens * 3.5)
          ));
        }

        // Prepare generation config
        const generationConfig = {
          temperature: this.temperature,
          topK: this.topK,
          topP: this.topP,
          maxOutputTokens: estimatedOutputTokens + thinkingReserve
        };

        // Add thinking config based on thinking budget setting
        // -1 = dynamic thinking (null), 0 = disabled (omit), >0 = fixed budget
        if (thinkingBudget === -1) {
          // Dynamic thinking: let the model decide
          generationConfig.thinkingConfig = {
            thinkingBudget: null  // null means dynamic
          };
        } else if (thinkingBudget > 0) {
          // Fixed thinking budget
          generationConfig.thinkingConfig = {
            thinkingBudget: thinkingBudget
          };
        }
        // If thinkingBudget is 0, don't add thinkingConfig at all (disabled)

        // Call Gemini API (use header auth for consistency and security)
        const response = await axios.post(
          `${this.baseUrl}/models/${this.model}:generateContent`,
          {
            contents: [{
              parts: [{
                text: userPrompt
              }]
            }],
            generationConfig
          },
          {
            headers: { 'x-goog-api-key': String(this.apiKey || '').trim() },
            timeout: this.timeout,
            httpAgent,
            httpsAgent
          }
        );

        // Validate response
        if (!response.data) {
          log.error(() => '[Gemini] No data in response');
          throw new Error('No data returned from Gemini API');
        }

        if (!response.data.candidates || response.data.candidates.length === 0) {
          // Some safety blocks return promptFeedback without candidates
          const pf = response.data.promptFeedback || {};
          const blockReason = pf.blockReason || null;
          const safetyRatings = pf.safetyRatings || null;

          // Truncate noisy Gemini responses to keep logs readable
          const truncatedResponse = (() => {
            try {
              const serialized = JSON.stringify(response.data, null, 2);
              const MAX_LEN = 2000;
              return serialized.length > MAX_LEN
                ? `${serialized.slice(0, MAX_LEN)}... [truncated]`
                : serialized;
            } catch (err) {
              return '[unserializable Gemini response]';
            }
          })();

          log.error(() => ['[Gemini] No candidates in response (truncated):', truncatedResponse]);

          // If Gemini flagged safety, classify explicitly so upstream shows proper error subtitles
          if (blockReason || safetyRatings) {
            const err = new Error(`PROHIBITED_CONTENT: ${blockReason || 'SAFETY'}`);
            // Hint downstream handlers to produce the right UX
            err.translationErrorType = 'PROHIBITED_CONTENT';
            throw err;
          }

          // Otherwise, propagate a generic error
          throw new Error('No response candidates from Gemini API');
        }

        const candidate = response.data.candidates[0];

        // Aggregate all parts text
        const aggregatedText = candidate?.content?.parts?.map(p => (p && typeof p.text === 'string') ? p.text : '').join('') || '';

        // Check for finish reason issues
        if (candidate.finishReason && candidate.finishReason !== 'STOP') {
          log.error(() => ['[Gemini] Unusual finish reason:', candidate.finishReason]);

          if (candidate.finishReason === 'SAFETY') {
            throw new Error('Translation blocked by safety filters');
          } else if (candidate.finishReason === 'RECITATION') {
            throw new Error('Translation blocked due to recitation concerns');
          } else if (candidate.finishReason === 'MAX_TOKENS') {
            log.warn(() => '[Gemini] MAX_TOKENS reached - translation may be incomplete');

            if (aggregatedText.length < subtitleContent.length * 0.3) {
              throw new Error('Translation exceeded maximum token limit with minimal output');
            }

            // Continue with partial output
            log.warn(() => '[Gemini] Continuing with partial translation due to MAX_TOKENS');
          } else {
            throw new Error(`Translation stopped with reason: ${candidate.finishReason}`);
          }
        }

        // Check for content
        if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
          log.error(() => ['[Gemini] No content in candidate:', JSON.stringify(candidate, null, 2)]);
          throw new Error('No content in response candidate');
        }

        if (!candidate.content.parts[0].text && aggregatedText.length === 0) {
          log.error(() => ['[Gemini] No text in content parts:', JSON.stringify(candidate.content.parts, null, 2)]);
          throw new Error('No text in response content');
        }

        const translatedText = aggregatedText.length > 0 ? aggregatedText : candidate.content.parts[0].text;
        return this.cleanTranslatedSubtitle(translatedText);

      } catch (error) {
        // Use centralized error handler
        handleTranslationError(error, 'Gemini', { skipResponseData: true });
      }
    });
  }

  /**
   * Stream subtitle translation and yield partial text
   */
  async streamTranslateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt = null, onChunk = null) {
    return this.retryWithBackoff(async () => {
      try {
        const { userPrompt } = this.buildUserPrompt(subtitleContent, targetLanguage, customPrompt);

        const estimatedInputTokens = this.estimateTokenCount(userPrompt);
        const estimatedSubtitleTokens = this.estimateTokenCount(subtitleContent);

        const limits = await this.getModelLimits();
        const modelOutputCap = typeof limits.outputTokenLimit === 'number' ? limits.outputTokenLimit : this.maxOutputTokens;
        const safetyMargin = Math.floor(modelOutputCap * 0.05);

        const thinkingBudget = this.getEffectiveThinkingBudget();
        const thinkingReserve = thinkingBudget > 0 ? thinkingBudget : 0;
        const availableForOutput = Math.max(1024, Math.min(this.maxOutputTokens, modelOutputCap - safetyMargin - thinkingReserve));

        let estimatedOutputTokens;
        if (thinkingBudget !== 0) {
          estimatedOutputTokens = availableForOutput;
        } else {
          estimatedOutputTokens = Math.floor(Math.min(
            availableForOutput,
            Math.max(8192, estimatedSubtitleTokens * 3.5)
          ));
        }

        const generationConfig = {
          temperature: this.temperature,
          topK: this.topK,
          topP: this.topP,
          maxOutputTokens: estimatedOutputTokens + thinkingReserve
        };

        if (thinkingBudget === -1) {
          generationConfig.thinkingConfig = { thinkingBudget: null };
        } else if (thinkingBudget > 0) {
          generationConfig.thinkingConfig = { thinkingBudget: thinkingBudget };
        }

        const response = await axios.post(
          `${this.baseUrl}/models/${this.model}:streamGenerateContent`,
          {
            contents: [{
              parts: [{
                text: userPrompt
              }]
            }],
            generationConfig
          },
          {
            headers: {
              'x-goog-api-key': String(this.apiKey || '').trim(),
              'Accept': 'text/event-stream'
            },
            params: { alt: 'sse' },
            timeout: this.timeout,
            httpAgent,
            httpsAgent,
            responseType: 'stream'
          }
        );

        const contentType = (response.headers && (response.headers['content-type'] || response.headers['Content-Type'])) || '';

        return await new Promise((resolve, reject) => {
          let buffer = '';
          let aggregated = '';
          let finishReason = null;
          let blockReason = null;
          let safetyRatings = null;
          let rawStream = '';

          const processPayload = (payloadStr) => {
            if (!payloadStr || !payloadStr.trim()) return;
            const cleaned = payloadStr.trim().startsWith('data:')
              ? payloadStr.trim().slice(5).trim()
              : payloadStr.trim();
            if (!cleaned) return;
            let data;
            try {
              data = JSON.parse(cleaned);
            } catch (_) {
              return;
            }
            // Capture safety metadata so we can classify empty streams
            if (data.promptFeedback) {
              blockReason = data.promptFeedback.blockReason || blockReason;
              if (Array.isArray(data.promptFeedback.safetyRatings) && data.promptFeedback.safetyRatings.length > 0) {
                safetyRatings = data.promptFeedback.safetyRatings;
              }
            }

            const candidate = data?.candidates?.[0];
            if (candidate && candidate.finishReason) {
              finishReason = candidate.finishReason;
            }
            if (candidate && Array.isArray(candidate.safetyRatings) && candidate.safetyRatings.length > 0) {
              safetyRatings = candidate.safetyRatings;
            }

            const parts = candidate?.content?.parts || [];
            const chunkText = parts.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
            if (chunkText) {
              aggregated += chunkText;
              const cleanedAgg = this.cleanTranslatedSubtitle(aggregated);
              if (typeof onChunk === 'function') {
                try { onChunk(cleanedAgg); } catch (_) { }
              }
            }
          };

          response.data.on('data', (chunk) => {
            try {
              const chunkStr = chunk.toString('utf8');
              rawStream += chunkStr;
              buffer += chunkStr;
              const parts = buffer.split(/\r?\n/);
              buffer = parts.pop();
              parts.forEach(processPayload);
            } catch (err) {
              log.warn(() => ['[Gemini] Stream chunk processing failed:', err.message]);
            }
          });

          response.data.on('end', () => {
            try {
              if (buffer && buffer.trim()) {
                processPayload(buffer);
              }

              if (!aggregated && rawStream.trim()) {
                try {
                  const recovered = this.recoverStreamPayload(rawStream);
                  if (recovered.text) {
                    aggregated = recovered.text;
                    finishReason = finishReason || recovered.finishReason;
                    blockReason = blockReason || recovered.blockReason;
                    safetyRatings = safetyRatings || recovered.safetyRatings;
                    log.debug(() => `[Gemini] Stream parsed via fallback (${recovered.payloadCount} payloads, content-type=${contentType || 'unknown'})`);
                  } else if (contentType && !contentType.includes('text/event-stream')) {
                    log.warn(() => `[Gemini] Streaming response was '${contentType}' with no text; check API base/alt=sse config`);
                  }
                } catch (recoverErr) {
                  log.warn(() => ['[Gemini] Stream recovery parse failed:', recoverErr.message]);
                }
              }

              const cleaned = this.cleanTranslatedSubtitle(aggregated);

              // If Gemini blocked the request, surface a classified error
              if (!cleaned && (blockReason || safetyRatings)) {
                const reason = blockReason || 'SAFETY';
                const err = new Error(`PROHIBITED_CONTENT: ${reason}`);
                err.translationErrorType = 'PROHIBITED_CONTENT';
                reject(err);
                return;
              }

              // Handle finish reasons like the non-stream path
              if (finishReason && finishReason !== 'STOP') {
                if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
                  const err = new Error(finishReason === 'RECITATION'
                    ? 'RECITATION: Translation blocked due to recitation concerns'
                    : 'PROHIBITED_CONTENT: SAFETY');
                  err.translationErrorType = 'PROHIBITED_CONTENT';
                  reject(err);
                  return;
                }

                if (finishReason === 'MAX_TOKENS') {
                  if (cleaned.length < subtitleContent.length * 0.3) {
                    const err = new Error('MAX_TOKENS: Translation exceeded maximum token limit with minimal output');
                    err.translationErrorType = 'MAX_TOKENS';
                    reject(err);
                    return;
                  }
                  log.warn(() => '[Gemini] MAX_TOKENS reached in stream - continuing with partial translation');
                } else {
                  const err = new Error(`Translation stopped with reason: ${finishReason}`);
                  reject(err);
                  return;
                }
              }

              if (!cleaned) {
                reject(new Error('No content returned from Gemini stream'));
                return;
              }

              resolve(cleaned);
            } catch (err) {
              reject(err);
            }
          });

          response.data.on('error', (err) => reject(err));
        });

      } catch (error) {
        handleTranslationError(error, 'Gemini', { skipResponseData: true });
      }
    });
  }

  /**
   * Clean the translated subtitle text
   */
  cleanTranslatedSubtitle(text) {
    // Remove markdown code blocks if present
    let cleaned = text.replace(/```srt\n?/g, '').replace(/```\n?/g, '');

    // Normalize line endings (CRLF/CR → LF)
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Remove any leading/trailing whitespace
    cleaned = cleaned.trim();

    return cleaned;
  }

  /**
   * Estimate token count (conservative estimation)
   * @param {string} text - Text to estimate
   * @returns {number} - Estimated token count
   */
  estimateTokenCount(text) {
    if (!text) return 0;
    // Conservative: ~3 characters per token + 10% overhead for structure/punctuation
    const approx = Math.ceil(text.length / 3);
    return Math.ceil(approx * 1.1);
  }

  /**
   * Recover stream payloads from raw stream text when chunk parsing fails.
   * Handles SSE (data: ...), JSONL, and concatenated JSON objects.
   */
  recoverStreamPayload(rawStream) {
    const result = {
      text: '',
      finishReason: null,
      blockReason: null,
      safetyRatings: null,
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

      const candidate = data?.candidates?.[0];
      if (data?.promptFeedback?.blockReason) {
        result.blockReason = result.blockReason || data.promptFeedback.blockReason;
      }
      if (Array.isArray(data?.promptFeedback?.safetyRatings) && data.promptFeedback.safetyRatings.length > 0) {
        result.safetyRatings = result.safetyRatings || data.promptFeedback.safetyRatings;
      }
      if (candidate) {
        if (candidate.finishReason && !result.finishReason) {
          result.finishReason = candidate.finishReason;
        }
        if (Array.isArray(candidate.safetyRatings) && candidate.safetyRatings.length > 0 && !result.safetyRatings) {
          result.safetyRatings = candidate.safetyRatings;
        }
        const parts = candidate?.content?.parts || [];
        const chunkText = parts.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
        if (chunkText) {
          result.text += chunkText;
        }
      }

      result.payloadCount += 1;
    };

    // Strategy 1: split by blank lines (SSE events)
    const blocks = rawStream.split(/\r?\n\r?\n/);
    for (const block of blocks) {
      const cleaned = block.split(/\r?\n/).map(line => line.replace(/^data:\s*/, '').trim()).filter(Boolean).join('');
      processPayload(cleaned);
    }

    // Strategy 2: line-by-line (JSONL)
    if (result.payloadCount === 0) {
      const lines = rawStream.split(/\r?\n/);
      for (const line of lines) {
        const cleaned = line.replace(/^data:\s*/, '').trim();
        processPayload(cleaned);
      }
    }

    // Strategy 3: concatenated JSON objects without delimiters
    if (result.payloadCount === 0 && rawStream.includes('}{')) {
      const pieces = rawStream.split(/}\s*(?=\{)/).map((piece, idx, arr) => {
        if (idx < arr.length - 1) return piece + '}';
        return piece;
      });
      for (let i = 0; i < pieces.length; i++) {
        let segment = pieces[i];
        if (segment && segment[0] !== '{') segment = `{${segment}`;
        processPayload(segment.trim());
      }
    }

    return result;
  }
}

module.exports = GeminiService;
module.exports.DEFAULT_TRANSLATION_PROMPT = DEFAULT_TRANSLATION_PROMPT;
