const axios = require('axios');
const { parseSRT, toSRT } = require('../utils/subtitle');

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta';

// Strict prompt - preserves structure exactly as given
const STRICT_TRANSLATION_PROMPT = `Translate the following subtitles while:

1. Preserving the timing and structure exactly as given
2. Maintaining natural dialogue flow and colloquialisms appropriate to the target language
3. Keeping the same number of lines and line breaks
4. Preserving any formatting tags or special characters
5. Ensuring translations are contextually accurate for film/TV dialogue

Translate from {source_language} to {target_language}.

Do NOT include acknowledgements, explanations, notes or alternative translations.

Output ONLY the translated SRT file, nothing else.`;

// Natural prompt - allows adapting for natural flow
const NATURAL_TRANSLATION_PROMPT = `Please translate the following subtitles while:

1. Trying to preserve the timing and structure exactly as given, correctly adapting for natural target language subtitles flow if deemed necessary.
2. The same is true for number of lines and line breaks
3. Maintaining natural dialogue flow and colloquialisms appropriate to the target language
4. Preserving any formatting tags or special characters
5. Ensuring translations are contextually accurate for film/TV dialogue

Translate from {source_language} to {target_language}.

Do NOT include acknowledgements, explanations, notes or alternative translations.

Output ONLY the translated SRT file, nothing else.`;

// Default to Natural prompt
const DEFAULT_TRANSLATION_PROMPT = STRICT_TRANSLATION_PROMPT;

class GeminiService {
  constructor(apiKey, model = '', advancedSettings = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = GEMINI_API_URL;

          // Advanced settings with defaults
      this.maxOutputTokens = advancedSettings.maxOutputTokens || 65536;
      // Chunk size for splitting large subtitles (target 25k tokens per chunk for efficiency)
      this.chunkSize = advancedSettings.chunkSize || 25000;
      this.timeout = (advancedSettings.translationTimeout || 600) * 1000; // Convert to milliseconds
      this.maxRetries = advancedSettings.maxRetries !== undefined ? advancedSettings.maxRetries : 5;
      // Thinking budget for Gemini 2.5 models - reserves tokens for internal reasoning
      // This counts against maxOutputTokens, so we need to account for it
      // NOTE: Due to Gemini API bug, thinking budget is often not respected properly
      // For translation tasks, minimal thinking is recommended (1000 tokens)
      this.thinkingBudget = advancedSettings.thinkingBudget !== undefined ? advancedSettings.thinkingBudget : 1000;
  }

  /**
   * Get available models from Gemini API
   * @returns {Promise<Array>} - Array of model objects
   */
  async getAvailableModels() {
    try {
      const response = await axios.get(`${this.baseUrl}/models`, {
        params: { key: this.apiKey },
        timeout: 10000
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
      console.error('[Gemini] Error fetching models:', error.message);
      return [];
    }
  }

  /**
   * Fetch model limits (input/output token limits) and cache them
   * @returns {Promise<{inputTokenLimit?: number, outputTokenLimit?: number}>}
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

      console.log(`[Gemini] Model: ${this.model}, Output limit: ${limits.outputTokenLimit}, Input limit: ${limits.inputTokenLimit || 'unlimited'}`);
      this._modelLimits = limits;
      return limits;
    } catch (error) {
      console.warn('[Gemini] Could not fetch model limits, using conservative defaults:', error.message);
      const modelName = String(this.model).toLowerCase();
      const limits = {
        inputTokenLimit: undefined,
        outputTokenLimit: modelName.includes('2.5') ? 65536 : 8192 // 2.0 = 8k, 2.5 = 65k
      };
      console.log(`[Gemini] Fallback limits for ${this.model}: ${limits.outputTokenLimit} output tokens`);
      this._modelLimits = limits;
      return limits;
    }
  }

  /**
   * Get default models as fallback
   * @returns {Array} - Array of default model objects
   */
  getDefaultModels() {
    return [];
  }

  /**
   * Retry a function with exponential backoff
   * @param {Function} fn - Function to retry
   * @param {number} maxRetries - Maximum number of retries (uses configured value if not specified)
   * @param {number} baseDelay - Base delay in milliseconds
   * @returns {Promise<any>} - Result of the function
   */
  async retryWithBackoff(fn, maxRetries = null, baseDelay = 2000) {
    maxRetries = maxRetries !== null ? maxRetries : this.maxRetries;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const isLastAttempt = attempt === maxRetries;
        const isTimeout = error.message.includes('timeout') || error.code === 'ECONNABORTED';
        const isNetworkError = error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND';
        const isSocketHangup = error.message.includes('socket hang up') || error.code === 'ECONNRESET';
        
        if (isLastAttempt || (!isTimeout && !isNetworkError && !isSocketHangup)) {
          throw error;
        }
        
        const delay = baseDelay * Math.pow(2, attempt);
        const errorType = isSocketHangup ? 'socket hang up' : isTimeout ? 'timeout' : 'network error';
        console.log(`[Gemini] Attempt ${attempt + 1} failed (${errorType}), retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Translate subtitle content
   * @param {string} subtitleContent - Original subtitle content (SRT format)
   * @param {string} sourceLanguage - Source language name
   * @param {string} targetLanguage - Target language name
   * @param {string} customPrompt - Custom translation prompt (optional)
   * @returns {Promise<string>} - Translated subtitle content
   */
  async translateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt = null) {
    return this.retryWithBackoff(async () => {
      try {
        console.log(`[Gemini] Translating from ${sourceLanguage} to ${targetLanguage}`);

      // Prepare the prompt
      const systemPrompt = (customPrompt || DEFAULT_TRANSLATION_PROMPT)
        .replace('{source_language}', sourceLanguage)
        .replace('{target_language}', targetLanguage);

      const userPrompt = `${systemPrompt}\n\nSubtitles to translate:\n\n${subtitleContent}`;

              // Calculate dynamic output token limit
        // Estimate input tokens and allocate 2.5x for output to handle translation expansion
        // (most translations expand 1.5-2x, use 2.5x for safety margin)
        const estimatedInputTokens = this.estimateTokenCount(userPrompt);
        const estimatedSubtitleTokens = this.estimateTokenCount(subtitleContent);

        // Fetch model output limits and respect them with a safety margin
        const limits = await this.getModelLimits();
        const modelOutputCap = typeof limits.outputTokenLimit === 'number' ? limits.outputTokenLimit : this.maxOutputTokens;
        const safetyMargin = Math.floor(modelOutputCap * 0.05); // 5% safety margin

        // Reserve tokens for thinking budget (Gemini 2.5 models use thinking tokens from output budget)
        // thinking_token_count + output_token_count must be <= maxOutputTokens
        const thinkingReserve = this.thinkingBudget > 0 ? this.thinkingBudget : 0;
        const availableForOutput = Math.max(1024, Math.min(this.maxOutputTokens, modelOutputCap - safetyMargin - thinkingReserve));

        // Use 3.5x multiplier for subtitle content (translations can expand 2-3x+, especially verbose languages)
        const estimatedOutputTokens = Math.floor(Math.min(
          availableForOutput,
          Math.max(8192, estimatedSubtitleTokens * 3.5)
        ));
      
      console.log(`[Gemini] Estimated input tokens: ${estimatedInputTokens}, thinking budget: ${thinkingReserve}, output limit: ${estimatedOutputTokens} (total: ${estimatedOutputTokens + thinkingReserve})`);

      // Call Gemini API
      const response = await axios.post(
        `${this.baseUrl}/models/${this.model}:generateContent`,
        {
          contents: [{
            parts: [{
              text: userPrompt
            }]
          }],
          generationConfig: {
            temperature: 0.8,
            topK: 40,
            topP: 0.95,
            // Total budget includes thinking + output (thinking_tokens + output_tokens <= maxOutputTokens)
            maxOutputTokens: estimatedOutputTokens + thinkingReserve,
            thinkingConfig: {
              thinkingBudget: this.thinkingBudget  // Reserve tokens for thinking (counts against maxOutputTokens)
            }
          }
        },
                  {
            params: { key: this.apiKey },
            timeout: this.timeout, // Configurable timeout (default 10 minutes)
            // Add socket keepalive to prevent premature disconnection
            httpAgent: new (require('http')).Agent({ keepAlive: true }),
            httpsAgent: new (require('https')).Agent({ keepAlive: true })
          }
      );

      // Detailed response validation
      if (!response.data) {
        console.error('[Gemini] No data in response');
        throw new Error('No data returned from Gemini API');
      }

      if (!response.data.candidates || response.data.candidates.length === 0) {
        console.error('[Gemini] No candidates in response:', JSON.stringify(response.data, null, 2));
        throw new Error('No response candidates from Gemini API - possibly content filtered or API error');
      }

      const candidate = response.data.candidates[0];

      // Aggregate all parts text defensively
      const aggregatedText = candidate?.content?.parts?.map(p => (p && typeof p.text === 'string') ? p.text : '').join('') || '';

      // Check for finish reason issues
      if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        console.error('[Gemini] Unusual finish reason:', candidate.finishReason);
        console.error('[Gemini] Full candidate:', JSON.stringify(candidate, null, 2));
        
                  if (candidate.finishReason === 'SAFETY') {
            throw new Error('Translation blocked by safety filters');
          } else if (candidate.finishReason === 'RECITATION') {
            throw new Error('Translation blocked due to recitation concerns');
          } else if (candidate.finishReason === 'MAX_TOKENS') {
            // Log warning but check if we got usable output
            console.log('[Gemini] MAX_TOKENS reached - translation may be incomplete');
            const outputText = aggregatedText;
            
            if (outputText.length < subtitleContent.length * 0.3) {
              const error = new Error('Translation exceeded maximum token limit with minimal output');
              error.shouldChunk = true;
              error.needsSmallerChunks = true;
              throw error;
            }
            
            const error = new Error('Translation exceeded maximum token limit');
            error.shouldChunk = true;
            throw error;
          } else {
          throw new Error(`Translation stopped with reason: ${candidate.finishReason}`);
        }
      }

      // Check for content
      if (!candidate.content) {
        console.error('[Gemini] No content in candidate:', JSON.stringify(candidate, null, 2));
        throw new Error('No content in response candidate');
      }

      if (!candidate.content.parts || candidate.content.parts.length === 0) {
        console.error('[Gemini] No parts in content:', JSON.stringify(candidate.content, null, 2));
        throw new Error('No content parts in response');
      }

      if (!candidate.content.parts[0].text && aggregatedText.length === 0) {
        console.error('[Gemini] No text in content parts:', JSON.stringify(candidate.content.parts, null, 2));
        throw new Error('No text in response content');
      }

      const translatedText = aggregatedText.length > 0 ? aggregatedText : candidate.content.parts[0].text;
      console.log('[Gemini] Translation completed successfully');

      return this.cleanTranslatedSubtitle(translatedText);

    } catch (error) {
      console.error('[Gemini] Translation error:', error.message);
      if (error.response) {
        console.error('[Gemini] Response status:', error.response.status);
        console.error('[Gemini] Response data:', JSON.stringify(error.response.data, null, 2));
      }
      // Preserve custom flags so callers can decide on chunked fallback
      if (error && (error.shouldChunk || error.needsSmallerChunks)) {
        const wrapped = new Error(`Translation failed: ${error.message}`);
        if (error.shouldChunk) wrapped.shouldChunk = true;
        if (error.needsSmallerChunks) wrapped.needsSmallerChunks = true;
        throw wrapped;
      }
      throw new Error(`Translation failed: ${error.message}`);
    }
    });
  }

  /**
   * Clean the translated subtitle text
   * @param {string} text - Translated text
   * @returns {string} - Cleaned subtitle text
   */
  cleanTranslatedSubtitle(text) {
    // Remove markdown code blocks if present
    let cleaned = text.replace(/```srt\n?/g, '').replace(/```\n?/g, '');

    // Ensure proper line endings
    cleaned = cleaned.replace(/\r\n/g, '\n');

    // Remove any leading/trailing whitespace
    cleaned = cleaned.trim();

    return cleaned;
  }

  /**
   * Translate in chunks for large subtitle files
   * @param {string} subtitleContent - Original subtitle content
   * @param {string} sourceLanguage - Source language name
   * @param {string} targetLanguage - Target language name
   * @param {string} customPrompt - Custom translation prompt
   * @param {number} targetTokensPerChunk - Target tokens per chunk (uses configured value if not specified)
   * @returns {Promise<string>} - Translated subtitle content
   */
  async translateSubtitleInChunks(subtitleContent, sourceLanguage, targetLanguage, customPrompt = null, targetTokensPerChunk = null) {
    targetTokensPerChunk = targetTokensPerChunk !== null ? targetTokensPerChunk : this.chunkSize;
    try {
              console.log('[Gemini] Starting chunked translation');
  
        // Split by subtitle entries (separated by double newlines)
        // Handle both Unix (\n) and Windows (\r\n) line endings
        const entries = subtitleContent.split(/(\r?\n){2,}/);
        
        // Filter out empty entries and the captured newline groups from split
        const validEntries = entries.filter(entry => entry && entry.trim() && !entry.match(/^(\r?\n)+$/));
        
                console.log(`[Gemini] Split subtitle into ${validEntries.length} entries`);
        const chunks = [];
        
               // Dynamically create chunks based on token count, not fixed entry count
         // No overhead - use full target for chunks (context is added separately)
         const contextOverhead = 0;
         const effectiveTarget = targetTokensPerChunk;

         let currentChunk = [];
         let currentChunkTokens = 0;

         for (const entry of validEntries) {
          const entryTokens = this.estimateTokenCount(entry);

                     // If this single entry is larger than effective target, we need to split it further
           if (entryTokens > effectiveTarget * 1.5) {
             // Save current chunk if it has content
             if (currentChunk.length > 0) {
               chunks.push(currentChunk.join('\n\n'));
               currentChunk = [];
               currentChunkTokens = 0;
             }
             // Add oversized entry as its own chunk (will be handled by retry logic)
             console.log(`[Gemini] Warning: Single entry with ${entryTokens} tokens exceeds effective target ${effectiveTarget} - will process separately`);
             chunks.push(entry);
             continue;
           }

          // If adding this entry would exceed 1.2x target, start a new chunk (allows chunks to reach full target)
          if (currentChunkTokens + entryTokens > effectiveTarget * 1.2 && currentChunk.length > 0) {
            chunks.push(currentChunk.join('\n\n'));
            currentChunk = [entry];
            currentChunkTokens = entryTokens;
          } else {
            currentChunk.push(entry);
            currentChunkTokens += entryTokens;
          }
        }
        
        // Don't forget the last chunk
        if (currentChunk.length > 0) {
          chunks.push(currentChunk.join('\n\n'));
        }

      // Calculate total tokens for better logging
      const totalTokens = chunks.reduce((sum, chunk) => sum + this.estimateTokenCount(chunk), 0);
      console.log(`[Gemini] Split into ${chunks.length} chunks (avg ~${Math.round(totalTokens / chunks.length)} tokens each)`);

      // Translate each chunk
      const translatedChunks = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunkText = chunks[i];
        const chunkTokens = this.estimateTokenCount(chunkText);

        // Build small context window by mapping chunk back to entries
        const thisEntries = chunkText.split(/(\r?\n){2,}/).filter(s => s && s.trim() && !s.match(/^\s*$/));
        let beforeCtx = '';
        let afterCtx = '';
        if (thisEntries.length > 0) {
          const first = thisEntries[0];
          const last = thisEntries[thisEntries.length - 1];
          const startIndex = validEntries.indexOf(first);
          const endIndex = validEntries.indexOf(last);
          if (startIndex !== -1) {
            const beforeStart = Math.max(0, startIndex - 6);
            beforeCtx = validEntries.slice(beforeStart, startIndex).join('\n\n');
          }
          if (endIndex !== -1) {
            const afterEnd = Math.min(validEntries.length, endIndex + 1 + 3);
            afterCtx = validEntries.slice(endIndex + 1, afterEnd).join('\n\n');
          }
        }
        const composed = [
          beforeCtx ? 'CONTEXT BEFORE (DO NOT TRANSLATE):' : '',
          beforeCtx,
          '-----',
          'TRANSLATE ONLY THE FOLLOWING SUBTITLES (RETURN ONLY THE TRANSLATED SUBTITLES):',
          chunkText,
          '-----',
          afterCtx ? 'CONTEXT AFTER (DO NOT TRANSLATE):' : '',
          afterCtx
        ].filter(Boolean).join('\n\n');

        // Log ACTUAL tokens including context
        const totalTokens = this.estimateTokenCount(composed);
        const contextTokens = totalTokens - chunkTokens;
        console.log(`[Gemini] Translating chunk ${i + 1}/${chunks.length}: ${chunkTokens} chunk + ${contextTokens} context = ${totalTokens} total tokens`);
        const translated = await this.translateSubtitle(composed, sourceLanguage, targetLanguage, customPrompt);
        translatedChunks.push(translated);

        // Small delay to avoid rate limiting
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      console.log('[Gemini] All chunks translated');
      const merged = translatedChunks.join('\n\n');
      const parsed = parseSRT(merged);
      if (parsed.length > 0) {
        const reindexed = parsed.map((e, idx) => ({ id: idx + 1, timecode: e.timecode, text: (e.text || '').trim() })).filter(e => e.timecode && e.text);
        return toSRT(reindexed);
      }
      return merged;

    } catch (error) {
      console.error('[Gemini] Chunked translation error:', error.message);
      throw error;
    }
  }

  /**
   * Estimate token count (conservative estimation)
   * @param {string} text - Text to estimate
   * @returns {number} - Estimated token count
   */
  estimateTokenCount(text) {
    if (!text) return 0;
    // Conservative: ~3 characters per token + 10% overhead for SRT structure/punctuation
    const approx = Math.ceil(text.length / 3);
    return Math.ceil(approx * 1.1);
  }
}

module.exports = GeminiService;
module.exports.DEFAULT_TRANSLATION_PROMPT = DEFAULT_TRANSLATION_PROMPT;
module.exports.STRICT_TRANSLATION_PROMPT = STRICT_TRANSLATION_PROMPT;
module.exports.NATURAL_TRANSLATION_PROMPT = NATURAL_TRANSLATION_PROMPT;
