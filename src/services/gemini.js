const axios = require('axios');
const { handleTranslationError, logApiError } = require('../utils/apiErrorHandler');
const { httpAgent, httpsAgent } = require('../utils/httpAgents');
const log = require('../utils/logger');

// Prefer stable v1 endpoint; some keys return 400 against v1beta
const GEMINI_API_URL = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1';

// Normalize human-readable target language names for Gemini prompts
function normalizeTargetName(name) {
  let n = String(name || '').trim();
  const rules = [
    [/^Portuguese\s*\(Brazil\)$/i, 'Brazilian Portuguese'],
    [/^Spanish\s*\(Latin America\)$/i, 'Latin American Spanish'],
    [/^Chinese\s*\(Simplified\)$/i, 'Simplified Chinese'],
    [/^Chinese\s*\(Traditional\)$/i, 'Traditional Chinese'],
    [/^Portuguese\s*\(Portugal\)$/i, 'European Portuguese'],
    [/^Portuguese\s*\(European\)$/i, 'European Portuguese']
  ];
  for (const [re, out] of rules) {
    if (re.test(n)) return out;
  }
  return n;
}

// Default translation prompt
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
    this.model = model || 'gemini-2.5-flash-lite-preview-09-2025';
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
        params: { key: this.apiKey },
        timeout: 10000
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
        // Normalize target language to a human-readable form
        const normalizedTarget = normalizeTargetName(targetLanguage);

        // Prepare the prompt
        const systemPrompt = (customPrompt || DEFAULT_TRANSLATION_PROMPT)
          .replace('{target_language}', normalizedTarget);

        const userPrompt = `${systemPrompt}\n\nContent to translate:\n\n${subtitleContent}`;

        // Calculate dynamic output token limit
        const estimatedInputTokens = this.estimateTokenCount(userPrompt);
        const estimatedSubtitleTokens = this.estimateTokenCount(subtitleContent);

        // Fetch model output limits and respect them with a safety margin
        const limits = await this.getModelLimits();
        const modelOutputCap = typeof limits.outputTokenLimit === 'number' ? limits.outputTokenLimit : this.maxOutputTokens;
        const safetyMargin = Math.floor(modelOutputCap * 0.05); // 5% safety margin

        // Reserve tokens for thinking budget
        const thinkingReserve = this.thinkingBudget > 0 ? this.thinkingBudget : 0;
        const availableForOutput = Math.max(1024, Math.min(this.maxOutputTokens, modelOutputCap - safetyMargin - thinkingReserve));

        // Use 3.5x multiplier for subtitle content (translations can expand 2-3x+)
        const estimatedOutputTokens = Math.floor(Math.min(
          availableForOutput,
          Math.max(8192, estimatedSubtitleTokens * 3.5)
        ));

        // Prepare generation config
        const generationConfig = {
          temperature: this.temperature,
          topK: this.topK,
          topP: this.topP,
          maxOutputTokens: estimatedOutputTokens + thinkingReserve
        };

        // Add thinking config based on thinking budget setting
        // -1 = dynamic thinking (null), 0 = disabled (omit), >0 = fixed budget
        if (this.thinkingBudget === -1) {
          // Dynamic thinking: let the model decide
          generationConfig.thinkingConfig = {
            thinkingBudget: null  // null means dynamic
          };
        } else if (this.thinkingBudget > 0) {
          // Fixed thinking budget
          generationConfig.thinkingConfig = {
            thinkingBudget: this.thinkingBudget
          };
        }
        // If thinkingBudget is 0, don't add thinkingConfig at all (disabled)

        // Call Gemini API
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
            params: { key: this.apiKey },
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
          log.error(() => ['[Gemini] No candidates in response:', JSON.stringify(response.data, null, 2)]);
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
}

module.exports = GeminiService;
module.exports.DEFAULT_TRANSLATION_PROMPT = DEFAULT_TRANSLATION_PROMPT;
