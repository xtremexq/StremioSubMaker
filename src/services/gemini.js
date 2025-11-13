const axios = require('axios');
const { parseSRT, toSRT } = require('../utils/subtitle');
const { handleTranslationError, logApiError } = require('../utils/apiErrorHandler');
const { httpAgent, httpsAgent } = require('../utils/httpAgents');
const log = require('../utils/logger');

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta';

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

// Strict prompt - preserves structure exactly as given
const STRICT_TRANSLATION_PROMPT = `Translate the following subtitles while:

1. Preserving the timing and structure exactly as given
2. Maintaining natural dialogue flow and colloquialisms appropriate to the target language
3. Keeping the same number of lines and line breaks
4. Preserving any formatting tags or special characters
5. Ensuring translations are contextually accurate for film/TV dialogue

Translate to {target_language}.

Do NOT include acknowledgements, explanations, notes or alternative translations.

Output ONLY the translated SRT file, nothing else.`;

// Natural prompt - allows adapting for natural flow
const NATURAL_TRANSLATION_PROMPT = `Please translate the following subtitles while:

1. Trying to preserve the timing and structure exactly as given, correctly adapting for natural target language subtitles flow if deemed necessary.
2. The same is true for number of lines and line breaks
3. Maintaining natural dialogue flow and colloquialisms appropriate to the target language
4. Preserving any formatting tags or special characters
5. Ensuring translations are contextually accurate for film/TV dialogue

Translate to {target_language}.

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
      // Chunk size for splitting large subtitles (target 12k tokens per chunk for faster progressive updates)
      this.chunkSize = advancedSettings.chunkSize || 12000;
      this.timeout = (advancedSettings.translationTimeout || 600) * 1000; // Convert to milliseconds
      this.maxRetries = advancedSettings.maxRetries !== undefined ? advancedSettings.maxRetries : 0;
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
      logApiError(error, 'Gemini', 'Fetch models', { skipResponseData: true });
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
        log.debug(() => `[Gemini] Attempt ${attempt + 1} failed (${errorType}), retrying in ${delay}ms...`);
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
        // Normalize target language to a human-readable form
        const normalizedTarget = normalizeTargetName(targetLanguage);
        log.debug(() => `[Gemini] Translating to ${normalizedTarget}`);

      // Prepare the prompt
      const systemPrompt = (customPrompt || DEFAULT_TRANSLATION_PROMPT)
        .replace('{target_language}', normalizedTarget);

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

      log.debug(() => `[Gemini] Estimated input tokens: ${estimatedInputTokens}, thinking budget: ${thinkingReserve}, output limit: ${estimatedOutputTokens} (total: ${estimatedOutputTokens + thinkingReserve})`);

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
            // Use shared HTTP agents with connection pooling
            httpAgent,
            httpsAgent
          }
      );

      // Detailed response validation
      if (!response.data) {
        log.error(() => '[Gemini] No data in response');
        throw new Error('No data returned from Gemini API');
      }

      if (!response.data.candidates || response.data.candidates.length === 0) {
        log.error(() => ['[Gemini] No candidates in response:', JSON.stringify(response.data, null, 2)]);
        throw new Error('No response candidates from Gemini API - possibly content filtered or API error');
      }

      const candidate = response.data.candidates[0];

      // Aggregate all parts text defensively
      const aggregatedText = candidate?.content?.parts?.map(p => (p && typeof p.text === 'string') ? p.text : '').join('') || '';

      // Check for finish reason issues
      if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        log.error(() => ['[Gemini] Unusual finish reason:', candidate.finishReason]);
        log.error(() => ['[Gemini] Full candidate:', JSON.stringify(candidate, null, 2)]);
        
                  if (candidate.finishReason === 'SAFETY') {
            throw new Error('Translation blocked by safety filters');
          } else if (candidate.finishReason === 'RECITATION') {
            throw new Error('Translation blocked due to recitation concerns');
          } else if (candidate.finishReason === 'MAX_TOKENS') {
            // Log warning but check if we got usable output
            log.debug(() => '[Gemini] MAX_TOKENS reached - translation may be incomplete');
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
        log.error(() => ['[Gemini] No content in candidate:', JSON.stringify(candidate, null, 2)]);
        throw new Error('No content in response candidate');
      }

      if (!candidate.content.parts || candidate.content.parts.length === 0) {
        log.error(() => ['[Gemini] No parts in content:', JSON.stringify(candidate.content, null, 2)]);
        throw new Error('No content parts in response');
      }

      if (!candidate.content.parts[0].text && aggregatedText.length === 0) {
        log.error(() => ['[Gemini] No text in content parts:', JSON.stringify(candidate.content.parts, null, 2)]);
        throw new Error('No text in response content');
      }

      const translatedText = aggregatedText.length > 0 ? aggregatedText : candidate.content.parts[0].text;
      log.debug(() => '[Gemini] Translation completed successfully');

      return this.cleanTranslatedSubtitle(translatedText);

    } catch (error) {
      // Preserve custom flags so callers can decide on chunked fallback
      if (error && (error.shouldChunk || error.needsSmallerChunks)) {
        const wrapped = new Error(`Translation failed: ${error.message}`);
        if (error.shouldChunk) wrapped.shouldChunk = true;
        if (error.needsSmallerChunks) wrapped.needsSmallerChunks = true;
        throw wrapped;
      }
      // Use centralized error handler for all other errors
      handleTranslationError(error, 'Gemini', { skipResponseData: true });
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

    // Ensure proper line endings: Convert CRLF (\r\n) and CR (\r) to LF (\n) only
    // This fixes the issue on Linux where CRLF causes extra spacing between subtitle lines
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

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
    const normalizedTarget = normalizeTargetName(targetLanguage);
    try {
              log.debug(() => '[Gemini] Starting chunked translation');

        // Split by subtitle entries (separated by double newlines)
        // Handle both Unix (\n) and Windows (\r\n) line endings
        const entries = subtitleContent.split(/(\r?\n){2,}/);

        // Filter out empty entries and the captured newline groups from split
        const validEntries = entries.filter(entry => entry && entry.trim() && !entry.match(/^(\r?\n)+$/));

                log.debug(() => `[Gemini] Split subtitle into ${validEntries.length} entries`);
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
             log.debug(() => `[Gemini] Warning: Single entry with ${entryTokens} tokens exceeds effective target ${effectiveTarget} - will process separately`);
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
      log.debug(() => `[Gemini] Split into ${chunks.length} chunks (avg ~${Math.round(totalTokens / chunks.length)} tokens each)`);

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
        log.debug(() => `[Gemini] Translating chunk ${i + 1}/${chunks.length}: ${chunkTokens} chunk + ${contextTokens} context = ${totalTokens} total tokens`);
        const translated = await this.translateSubtitle(composed, sourceLanguage, normalizedTarget, customPrompt);
        translatedChunks.push(translated);

        // Small delay to avoid rate limiting
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      log.debug(() => '[Gemini] All chunks translated');
      const merged = translatedChunks.join('\n\n');
      const parsed = parseSRT(merged);
      if (parsed.length > 0) {
        const reindexed = parsed.map((e, idx) => {
          let text = (e.text || '').trim();
          
          // Fix: Remove any embedded timecode at the start of the text
          // Gemini sometimes preserves original timecodes in translation
          // Pattern: HH:MM:SS,MMM --> HH:MM:SS,MMM followed by newline
          // Use global flag to remove ALL occurrences
          const timecodePattern = /\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}\s*\n?/g;
          text = text.replace(timecodePattern, '').trim();
          
          return { id: idx + 1, timecode: e.timecode, text };
        }).filter(e => e.timecode && e.text);
        return toSRT(reindexed);
      }
      return merged;

    } catch (error) {
      log.error(() => ['[Gemini] Chunked translation error:', error.message]);
      throw error;
    }
  }

  /**
   * Translate subtitle in chunks with a progress callback for partial updates.
   * Callers can persist partial merged outputs between chunks.
   * @param {string} subtitleContent
   * @param {string} sourceLanguage
   * @param {string} targetLanguage
   * @param {string|null} customPrompt
   * @param {number|null} targetTokensPerChunk
   * @param {(info: { index:number, total:number, translatedChunk:string })=>Promise<void>|void} [onChunk]
   * @returns {Promise<string>} - Full translated SRT
   */
  async translateSubtitleInChunksWithProgress(subtitleContent, sourceLanguage, targetLanguage, customPrompt = null, targetTokensPerChunk = null, onChunk = null) {
    const normalizedTarget = normalizeTargetName(targetLanguage);
    // Reuse chunking strategy from translateSubtitleInChunks but notify per-chunk
    targetTokensPerChunk = targetTokensPerChunk !== null ? targetTokensPerChunk : this.chunkSize;
    try {
      // Split by subtitle entries (separated by double newlines)
      // Handle both Unix (\n) and Windows (\r\n) line endings
      const entries = subtitleContent.split(/(\r?\n){2,}/);
      const validEntries = entries.filter(entry => entry && entry.trim() && !entry.match(/^(\r?\n)+$/));

      const chunks = [];
      const effectiveTarget = targetTokensPerChunk;
      let currentChunk = [];
      let currentChunkTokens = 0;
      for (const entry of validEntries) {
        const entryTokens = this.estimateTokenCount(entry);
        if (entryTokens > effectiveTarget * 1.5) {
          if (currentChunk.length > 0) {
            chunks.push(currentChunk.join('\n\n'));
            currentChunk = [];
            currentChunkTokens = 0;
          }
          chunks.push(entry);
          continue;
        }
        if (currentChunkTokens + entryTokens > effectiveTarget * 1.2 && currentChunk.length > 0) {
          chunks.push(currentChunk.join('\n\n'));
          currentChunk = [entry];
          currentChunkTokens = entryTokens;
        } else {
          currentChunk.push(entry);
          currentChunkTokens += entryTokens;
        }
      }
      if (currentChunk.length > 0) chunks.push(currentChunk.join('\n\n'));

      const translatedChunks = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunkText = chunks[i];
        const translated = await this.translateSubtitle(
          chunkText,
          sourceLanguage,
          targetLanguage,
          customPrompt
        );
        translatedChunks.push(translated);
        if (typeof onChunk === 'function') {
          try { await onChunk({ index: i, total: chunks.length, translatedChunk: translated }); } catch (_) {}
        }
        if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
      }

      const merged = translatedChunks.join('\n\n');
      return this.cleanTranslatedSubtitle(merged);
    } catch (error) {
      log.error(() => ['[Gemini] translateSubtitleInChunksWithProgress error:', error.message]);
      throw error;
    }
  }

  /**
   * Translate subtitle in chunks with token-level streaming per chunk for progressive updates.
   * Best for large files (>25k tokens) - streams each chunk for faster progressive delivery.
   * Each chunk uses streaming which provides token-level updates as they arrive.
   * @param {string} subtitleContent
   * @param {string} sourceLanguage
   * @param {string} targetLanguage
   * @param {string|null} customPrompt
   * @param {number|null} targetTokensPerChunk
   * @param {(info: { index:number, total:number, translatedChunk:string, isDelta?:boolean })=>Promise<void>|void} [onChunk] - Called with full chunk on completion, or with isDelta:true for token updates
   * @returns {Promise<string>} - Full translated SRT
   */
  async translateSubtitleInChunksWithStreaming(subtitleContent, sourceLanguage, targetLanguage, customPrompt = null, targetTokensPerChunk = null, onChunk = null) {
    const normalizedTarget = normalizeTargetName(targetLanguage);
    targetTokensPerChunk = targetTokensPerChunk !== null ? targetTokensPerChunk : this.chunkSize;
    try {
      // Split by subtitle entries
      const entries = subtitleContent.split(/(\r?\n){2,}/);
      const validEntries = entries.filter(entry => entry && entry.trim() && !entry.match(/^(\r?\n)+$/));

      const chunks = [];
      const effectiveTarget = targetTokensPerChunk;
      let currentChunk = [];
      let currentChunkTokens = 0;

      for (const entry of validEntries) {
        const entryTokens = this.estimateTokenCount(entry);
        if (entryTokens > effectiveTarget * 1.5) {
          if (currentChunk.length > 0) {
            chunks.push(currentChunk.join('\n\n'));
            currentChunk = [];
            currentChunkTokens = 0;
          }
          chunks.push(entry);
          continue;
        }
        if (currentChunkTokens + entryTokens > effectiveTarget * 1.2 && currentChunk.length > 0) {
          chunks.push(currentChunk.join('\n\n'));
          currentChunk = [entry];
          currentChunkTokens = entryTokens;
        } else {
          currentChunk.push(entry);
          currentChunkTokens += entryTokens;
        }
      }
      if (currentChunk.length > 0) chunks.push(currentChunk.join('\n\n'));

      log.debug(() => `[Gemini] Streaming chunks: Split into ${chunks.length} chunks for streaming translation`);

      const translatedChunks = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunkText = chunks[i];
        const chunkTokens = this.estimateTokenCount(chunkText);

        // Build small context window by mapping chunk back to entries (same as non-streaming mode)
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
        log.debug(() => `[Gemini] Streaming chunk ${i + 1}/${chunks.length}: ${chunkTokens} chunk + ${contextTokens} context = ${totalTokens} total tokens`);

        // Use streaming for each chunk to get progressive per-chunk updates with retry logic
        let chunkBuffer = '';
        let lastError;
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            chunkBuffer = '';
            await this.translateSubtitleStream(
              composed,
              sourceLanguage,
              normalizedTarget,
              customPrompt,
              (delta) => {
                chunkBuffer += delta;
                // Forward token deltas to the callback so handler can flush partials
                if (typeof onChunk === 'function') {
                  try {
                    onChunk({ index: i, total: chunks.length, translatedChunk: delta, isDelta: true });
                  } catch (_) {}
                }
              }
            );
            break; // Success, exit retry loop
          } catch (error) {
            lastError = error;

            // Check if it's a 503 (service overloaded) error
            const is503 = error.message && (
              error.message.includes('503') ||
              error.message.includes('overloaded') ||
              error.message.includes('UNAVAILABLE')
            );

            if (is503 && attempt < maxRetries) {
              // Exponential backoff: 2s, 4s, 8s
              const delayMs = Math.pow(2, attempt) * 1000;
              log.debug(() => `[Gemini] Chunk ${i + 1} got 503 error, retrying in ${delayMs}ms (attempt ${attempt}/${maxRetries})`);
              await new Promise(resolve => setTimeout(resolve, delayMs));
            } else {
              // Not a 503 or out of retries
              throw error;
            }
          }
        }

        if (!chunkBuffer) {
          throw lastError || new Error(`Chunk ${i + 1} translation failed after retries`);
        }

        const translated = this.cleanTranslatedSubtitle(chunkBuffer);
        translatedChunks.push(translated);

        // Notify completion of full chunk
        if (typeof onChunk === 'function') {
          try {
            await onChunk({ index: i, total: chunks.length, translatedChunk: translated, isDelta: false });
          } catch (_) {}
        }

        // Small delay between chunks to avoid rate limiting
        if (i < chunks.length - 1) {
          await new Promise(r => setTimeout(r, 500));
        }
      }

      log.debug(() => `[Gemini] All chunks streamed and translated (${chunks.length} chunks)`);
      const merged = translatedChunks.join('\n\n');
      const parsed = parseSRT(merged);
      if (parsed.length > 0) {
        const reindexed = parsed.map((e, idx) => {
          let text = (e.text || '').trim();
          
          // Fix: Remove any embedded timecode at the start of the text
          // Gemini sometimes preserves original timecodes in translation
          // Pattern: HH:MM:SS,MMM --> HH:MM:SS,MMM followed by newline
          // Use global flag to remove ALL occurrences
          const timecodePattern = /\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}\s*\n?/g;
          text = text.replace(timecodePattern, '').trim();
          
          return { id: idx + 1, timecode: e.timecode, text };
        }).filter(e => e.timecode && e.text);
        return toSRT(reindexed);
      }
      return merged;
    } catch (error) {
      log.error(() => ['[Gemini] Streaming chunks translation error:', error.message]);
      throw error;
    }
  }

  /**
   * Experimental: token-level streaming using Gemini stream endpoint.
   * Caller should buffer deltas and persist only complete SRT blocks.
   * @param {string} subtitleContent
   * @param {string} sourceLanguage
   * @param {string} targetLanguage
   * @param {string|null} customPrompt
   * @param {(delta:string)=>void} onDelta
   */
  async translateSubtitleStream(subtitleContent, sourceLanguage, targetLanguage, customPrompt, onDelta) {
    const systemPrompt = customPrompt || DEFAULT_TRANSLATION_PROMPT;
    const normalizedTarget = normalizeTargetName(targetLanguage);
    const userPrompt = `${systemPrompt}\n\nSubtitles to translate:\n\n${subtitleContent}`.replace('{target_language}', normalizedTarget);

    // Estimate tokens to set appropriate output limit
    const estimatedInputTokens = this.estimateTokenCount(userPrompt);
    const limits = await this.getModelLimits();
    const modelOutputCap = typeof limits.outputTokenLimit === 'number' ? limits.outputTokenLimit : this.maxOutputTokens;
    const safetyMargin = Math.floor(modelOutputCap * 0.05);
    const thinkingReserve = this.thinkingBudget > 0 ? this.thinkingBudget : 0;
    const availableForOutput = Math.max(1024, Math.min(this.maxOutputTokens, modelOutputCap - safetyMargin - thinkingReserve));

    log.debug(() => `[Gemini] Stream: Estimated input tokens: ${estimatedInputTokens}, output limit: ${availableForOutput}`);

    // Gemini streaming API requires SSE format and alt=sse parameter
    const url = `${this.baseUrl}/models/${this.model}:streamGenerateContent`;
    log.debug(() => ['[Gemini] Starting stream request to:', url]);

    try {
      const response = await axios.post(
        url,
        {
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.8,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: availableForOutput + thinkingReserve,
            thinkingConfig: {
              thinkingBudget: this.thinkingBudget
            }
          }
        },
        {
          params: {
            key: this.apiKey,
            alt: 'sse' // Server-Sent Events format for streaming
          },
          responseType: 'stream',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream'
          },
          timeout: this.timeout || 600000,
          // Use shared HTTP agents with connection pooling
          httpAgent,
          httpsAgent
        }
      );
      log.debug(() => ['[Gemini] Stream response received, status:', response.status]);

      await new Promise((resolve, reject) => {
        let buffer = '';
        let deltaCount = 0;
        response.data.on('data', (chunk) => {
          const data = chunk.toString('utf8');
          buffer += data;
          const lines = buffer.split(/\r?\n/);
          // Keep incomplete line in buffer for next chunk
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // With alt=sse, lines are prefixed with "data: "
            let jsonStr = trimmed;
            if (trimmed.startsWith('data:')) {
              jsonStr = trimmed.substring(5).trim();
            }

            if (!jsonStr) continue;

            try {
              const obj = JSON.parse(jsonStr);
              // Gemini API returns text in candidates[0].content.parts[0].text
              const delta = obj?.candidates?.[0]?.content?.parts?.[0]?.text;
              if (typeof delta === 'string' && delta.length > 0) {
                if (typeof onDelta === 'function') {
                  try {
                    onDelta(delta);
                  } catch (e) {
                    log.warn(() => ['[Gemini] Error in onDelta callback:', e.message]);
                  }
                }
                deltaCount++;
              }
            } catch (parseError) {
              // Silently skip lines that aren't valid JSON (e.g., empty SSE markers)
              if (jsonStr.length > 0 && jsonStr !== '{}' && !jsonStr.startsWith('[')) {
                log.debug(() => ['[Gemini] Failed to parse stream line (non-critical):', jsonStr.substring(0, 80)]);
              }
            }
          }
        });
        response.data.on('end', () => {
          log.debug(() => `[Gemini] Stream ended with ${deltaCount} deltas received`);
          resolve();
        });
        response.data.on('error', reject);
      });
    } catch (error) {
      handleTranslationError(error, 'Gemini', { skipResponseData: true });
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
