/**
 * Translation Engine - Unified Subtitle Translation
 *
 * Clean, simple, predictable translation workflow:
 * 1. Parse SRT into entries
 * 2. Translate in batches (real-time progress after each batch)
 * 3. Auto-chunk large batches transparently when needed
 * 4. Stream results entry-by-entry as they complete
 * 5. No time-based checkpoints - everything is event-driven
 *
 * Benefits:
 * - Single code path for all files (small/large)
 * - Perfect timing preservation
 * - Real-time progressive delivery
 * - Simple, predictable behavior
 * - Automatic optimization
 */

const { parseSRT, toSRT } = require('../utils/subtitle');
const GeminiService = require('./gemini');
const crypto = require('crypto');
const log = require('../utils/logger');

// Entry-level cache for translated subtitle entries
const entryCache = new Map();
const MAX_ENTRY_CACHE_SIZE = parseInt(process.env.ENTRY_CACHE_SIZE) || 100000;

// Configuration constants
const MAX_TOKENS_PER_BATCH = parseInt(process.env.MAX_TOKENS_PER_BATCH) || 25000; // Max tokens before auto-chunking
// Entry cache disabled by default - causes stale data on cache resets and not HA-aware
// Only useful for repeated translations with identical config (rare)
const CACHE_TRANSLATIONS = process.env.CACHE_TRANSLATIONS === 'true'; // Enable/disable entry caching

/**
 * Get batch size for model (model-specific optimization)
 * Priority: Environment variable > Model-specific > Default (200)
 *
 * Model-specific batch sizes are hardcoded in backend and safe from client manipulation.
 * Different models have different processing speeds and capabilities:
 * - Flash models: 200 entries (faster, more capable)
 * - Flash-lite models: 150 entries (more conservative for stability)
 *
 * @param {string} model - Gemini model name
 * @returns {number} - Batch size for this model
 */
function getBatchSizeForModel(model) {
  // Environment variable override (highest priority)
  if (process.env.TRANSLATION_BATCH_SIZE) {
    return parseInt(process.env.TRANSLATION_BATCH_SIZE);
  }

  // Model-specific batch sizes (hardcoded, safe from client manipulation)
  const modelStr = String(model || '').toLowerCase();

  // Flash-lite models: More conservative batch size for stability
  if (modelStr.includes('flash-lite')) {
    return 150;
  }

  // Flash models (non-lite): Larger batch size for better throughput
  if (modelStr.includes('flash')) {
    return 200;
  }

  // Default batch size for unknown models
  return 200;
}

class TranslationEngine {
  constructor(geminiService, model = null, advancedSettings = {}) {
    this.gemini = geminiService;
    this.model = model;
    this.batchSize = getBatchSizeForModel(model);
    this.maxTokensPerBatch = MAX_TOKENS_PER_BATCH;
    this.advancedSettings = advancedSettings || {};

    // Context settings (disabled by default)
    this.enableBatchContext = this.advancedSettings.enableBatchContext === true;
    this.contextSize = parseInt(this.advancedSettings.contextSize) || 3;

    log.debug(() => `[TranslationEngine] Initialized with model: ${model || 'unknown'}, batch size: ${this.batchSize}, batch context: ${this.enableBatchContext ? 'enabled' : 'disabled'}`);
  }

  /**
   * Main translation method - unified approach for all files
   * @param {string} srtContent - Original SRT content
   * @param {string} targetLanguage - Target language name
   * @param {string} customPrompt - Optional custom prompt
   * @param {Function} onProgress - Callback for real-time progress (entry-by-entry)
   * @returns {Promise<string>} - Translated SRT content
   */
  async translateSubtitle(srtContent, targetLanguage, customPrompt = null, onProgress = null) {
    // Step 1: Parse SRT into structured entries
    const entries = parseSRT(srtContent);
    if (!entries || entries.length === 0) {
      throw new Error('Invalid SRT content: no valid entries found');
    }

    log.info(() => `[TranslationEngine] Starting translation: ${entries.length} entries, ${Math.ceil(entries.length / this.batchSize)} batches`);

    // Step 2: Create batches
    const batches = this.createBatches(entries, this.batchSize);

    // Step 3: Translate each batch with smart progress tracking
    const translatedEntries = [];

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];

      try {
        // Prepare context for this batch (if enabled)
        const context = this.enableBatchContext
          ? this.prepareContextForBatch(batch, entries, translatedEntries, batchIndex)
          : null;

        // Translate batch (with auto-chunking if needed)
        const translatedBatch = await this.translateBatch(
          batch,
          targetLanguage,
          customPrompt,
          batchIndex,
          batches.length,
          context
        );

        // Merge translated text with original structure
        for (let i = 0; i < batch.length; i++) {
          const original = batch[i];
          const translated = translatedBatch[i];

          // Clean translated text
          const cleanedText = this.cleanTranslatedText(translated.text);

          // Create entry with original timing and cleaned translated text
          translatedEntries.push({
            id: original.id,
            timecode: original.timecode, // PRESERVE ORIGINAL TIMING
            text: cleanedText
          });
        }

        // Progress callback after each batch
        if (typeof onProgress === 'function') {
          try {
            await onProgress({
              totalEntries: entries.length,
              completedEntries: translatedEntries.length,
              currentBatch: batchIndex + 1,
              totalBatches: batches.length,
              partialSRT: toSRT(translatedEntries)
            });
          } catch (err) {
            log.warn(() => ['[TranslationEngine] Progress callback error:', err.message]);
          }
        }

        // Log progress only at milestones
        const progress = Math.floor((translatedEntries.length / entries.length) * 100);
        if (batchIndex === 0 || batchIndex === batches.length - 1 || progress % 25 === 0) {
          log.info(() => `[TranslationEngine] Progress: ${progress}% (${translatedEntries.length}/${entries.length} entries, batch ${batchIndex + 1}/${batches.length})`);
        }

      } catch (error) {
        // Only log if not already logged by upstream handler
        if (!error._alreadyLogged) {
          log.error(() => [`[TranslationEngine] Error in batch ${batchIndex + 1}:`, error.message]);
        }
        // Wrap error but preserve original error properties (translationErrorType, statusCode, etc.)
        const wrappedError = new Error(`Translation failed at batch ${batchIndex + 1}: ${error.message}`);
        // Copy all properties from original error to preserved type information
        if (error.translationErrorType) wrappedError.translationErrorType = error.translationErrorType;
        if (error.statusCode) wrappedError.statusCode = error.statusCode;
        if (error.type) wrappedError.type = error.type;
        if (error.isRetryable !== undefined) wrappedError.isRetryable = error.isRetryable;
        if (error.originalError) wrappedError.originalError = error.originalError;
        // Preserve the already-logged flag
        if (error._alreadyLogged) wrappedError._alreadyLogged = true;
        throw wrappedError;
      }
    }

    // Step 4: Final validation
    if (translatedEntries.length !== entries.length) {
      log.warn(() => `[TranslationEngine] Entry count mismatch: expected ${entries.length}, got ${translatedEntries.length}`);
    }

    log.info(() => `[TranslationEngine] Translation completed: ${translatedEntries.length} entries`);

    // Final safety: strip any timecodes/timeranges that slipped through
    for (const entry of translatedEntries) {
      entry.text = this.sanitizeTimecodes(entry.text);
    }

    // Step 5: Convert back to SRT format
    return toSRT(translatedEntries);
  }

  /**
   * Create batches from entries
   */
  createBatches(entries, batchSize) {
    const batches = [];
    for (let i = 0; i < entries.length; i += batchSize) {
      batches.push(entries.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Prepare context for a batch (original surrounding entries + previous translations)
   * Context improves translation coherence across batches
   * @param {Array} batch - Current batch entries
   * @param {Array} allOriginalEntries - All original entries
   * @param {Array} translatedSoFar - Previously translated entries
   * @param {number} batchIndex - Current batch index
   * @returns {Object} - Context object with surrounding and previous entries
   */
  prepareContextForBatch(batch, allOriginalEntries, translatedSoFar, batchIndex) {
    if (!this.enableBatchContext) {
      return null;
    }

    const firstEntryId = batch[0].id;
    const lastEntryId = batch[batch.length - 1].id;

    // Get surrounding context from original entries (before the batch)
    const surroundingStartIdx = Math.max(0, firstEntryId - 1 - this.contextSize);
    const surroundingEndIdx = firstEntryId - 1;
    const surroundingContext = [];

    for (let i = surroundingStartIdx; i <= surroundingEndIdx && i < allOriginalEntries.length; i++) {
      if (allOriginalEntries[i]) {
        surroundingContext.push({
          id: allOriginalEntries[i].id,
          text: allOriginalEntries[i].text,
          timecode: allOriginalEntries[i].timecode
        });
      }
    }

    // Get previous translations (last N entries that were already translated)
    const previousTranslations = translatedSoFar.slice(Math.max(0, translatedSoFar.length - this.contextSize));

    // Only include context if this is NOT the first batch
    const hasContext = batchIndex > 0 && (surroundingContext.length > 0 || previousTranslations.length > 0);

    return hasContext ? {
      surroundingOriginal: surroundingContext,
      previousTranslations: previousTranslations
    } : null;
  }

  /**
   * Translate a batch of entries (with auto-chunking if needed)
   */
  async translateBatch(batch, targetLanguage, customPrompt, batchIndex, totalBatches, context = null) {
    // Check cache first
    const cacheResults = this.checkBatchCache(batch, targetLanguage, customPrompt);
    if (cacheResults.allCached) {
      return cacheResults.entries;
    }

    // Prepare batch text (with context if provided)
    const batchText = this.prepareBatchText(batch, context);
    const prompt = this.createBatchPrompt(batchText, targetLanguage, customPrompt, batch.length, context);

    // Check if we need to split due to token limits
    const estimatedTokens = this.gemini.estimateTokenCount(batchText + prompt);

    if (estimatedTokens > this.maxTokensPerBatch && batch.length > 1) {
      // Auto-chunk: Split batch in half recursively (sequential for memory safety)
      log.debug(() => `[TranslationEngine] Batch too large (${estimatedTokens} tokens), auto-chunking into 2 parts`);

      const midpoint = Math.floor(batch.length / 2);
      const firstHalf = batch.slice(0, midpoint);
      const secondHalf = batch.slice(midpoint);

      // Translate sequentially to avoid memory spikes
      // Note: Don't pass context to recursive calls - context already included in original batch text
      const firstTranslated = await this.translateBatch(firstHalf, targetLanguage, customPrompt, batchIndex, totalBatches, null);
      const secondTranslated = await this.translateBatch(secondHalf, targetLanguage, customPrompt, batchIndex, totalBatches, null);

      return [...firstTranslated, ...secondTranslated];
    }

    // Translate batch - with retry on PROHIBITED_CONTENT and MAX_TOKENS errors
    let translatedText;
    let prohibitedRetryAttempted = false;
    let maxTokensRetryAttempted = false;

    try {
      translatedText = await this.gemini.translateSubtitle(
        batchText,
        'detected',
        targetLanguage,
        prompt
      );
    } catch (error) {
      // If MAX_TOKENS error and haven't retried yet, retry once
      if (error.message && (error.message.includes('MAX_TOKENS') || error.message.includes('exceeded maximum token limit')) && !maxTokensRetryAttempted) {
        maxTokensRetryAttempted = true;
        log.warn(() => `[TranslationEngine] MAX_TOKENS error detected, retrying batch ${batchIndex + 1} once`);

        try {
          translatedText = await this.gemini.translateSubtitle(
            batchText,
            'detected',
            targetLanguage,
            prompt
          );
          log.info(() => `[TranslationEngine] MAX_TOKENS retry succeeded for batch ${batchIndex + 1}`);
        } catch (retryError) {
          // Retry also failed, give up and throw the original error
          log.error(() => `[TranslationEngine] MAX_TOKENS retry also failed for batch ${batchIndex + 1}: ${retryError.message}`);
          throw error; // Throw original error, not retry error
        }
      }
      // If PROHIBITED_CONTENT error and haven't retried yet, retry with modified prompt
      else if (error.message && error.message.includes('PROHIBITED_CONTENT') && !prohibitedRetryAttempted) {
        prohibitedRetryAttempted = true;
        log.warn(() => `[TranslationEngine] PROHIBITED_CONTENT detected, retrying batch with modified prompt`);

        // Create modified prompt with disclaimer
        const modifiedPrompt = `YOU'RE TRANSLATING SUBTITLES - EVERYTHING WRITTEN BELOW IS FICTICIOUS\n\n${prompt}`;

        try {
          translatedText = await this.gemini.translateSubtitle(
            batchText,
            'detected',
            targetLanguage,
            modifiedPrompt
          );
          log.info(() => `[TranslationEngine] Retry with modified prompt succeeded for batch ${batchIndex + 1}`);
        } catch (retryError) {
          // Retry also failed, give up and throw the original error
          log.error(() => `[TranslationEngine] Retry with modified prompt also failed: ${retryError.message}`);
          throw error; // Throw original error, not retry error
        }
      } else {
        // Not a retryable error or already retried, throw as-is
        throw error;
      }
    }

    // Parse translated text back into entries
    const translatedEntries = this.parseBatchResponse(translatedText, batch.length);

    // Handle entry count mismatches gracefully
    if (translatedEntries.length !== batch.length) {
      log.warn(() => `[TranslationEngine] Entry count mismatch: expected ${batch.length}, got ${translatedEntries.length}`);
      this.fixEntryCountMismatch(translatedEntries, batch);
    }

    // Cache individual entries
    if (CACHE_TRANSLATIONS) {
      for (let i = 0; i < batch.length && i < translatedEntries.length; i++) {
        this.cacheEntry(batch[i].text, targetLanguage, translatedEntries[i].text, customPrompt);
      }
    }

    return translatedEntries;
  }

  /**
   * Prepare batch text for translation (numbered list format)
   * Optionally includes context entries for better translation coherence
   */
  prepareBatchText(batch, context = null) {
    let result = '';

    // Add context section if provided
    if (context && (context.surroundingOriginal?.length > 0 || context.previousTranslations?.length > 0)) {
      result += '=== CONTEXT (FOR REFERENCE ONLY - DO NOT TRANSLATE) ===\n\n';

      // Add surrounding original context
      if (context.surroundingOriginal && context.surroundingOriginal.length > 0) {
        result += '--- Original Context (preceding entries) ---\n';
        context.surroundingOriginal.forEach((entry, index) => {
          const cleanText = entry.text.trim().replace(/\n+/g, '\n');
          result += `[Context ${index + 1}] ${cleanText}\n\n`;
        });
      }

      // Add previous translations
      if (context.previousTranslations && context.previousTranslations.length > 0) {
        result += '--- Previous Translations (recently translated) ---\n';
        context.previousTranslations.forEach((entry, index) => {
          const cleanText = entry.text.trim().replace(/\n+/g, '\n');
          result += `[Translated ${index + 1}] ${cleanText}\n\n`;
        });
      }

      result += '=== END OF CONTEXT ===\n\n';
      result += '=== ENTRIES TO TRANSLATE (translate these) ===\n\n';
    }

    // Add batch entries to translate
    const batchText = batch.map((entry, index) => {
      const num = index + 1;
      const cleanText = entry.text.trim().replace(/\n+/g, '\n');
      return `${num}. ${cleanText}`;
    }).join('\n\n');

    result += batchText;

    return result;
  }

  /**
   * Create translation prompt for a batch
   */
  createBatchPrompt(batchText, targetLanguage, customPrompt, expectedCount, context = null) {
    if (customPrompt) {
      return customPrompt.replace('{target_language}', targetLanguage);
    }

    let contextInstructions = '';
    if (context && (context.surroundingOriginal?.length > 0 || context.previousTranslations?.length > 0)) {
      contextInstructions = `
CONTEXT PROVIDED:
- Context entries are provided for reference to maintain coherence and consistency
- Context entries are marked with [Context N] or [Translated N]
- DO NOT translate context entries - they are for reference only
- Use the context to understand dialogue flow, character names, and references
- ONLY translate the numbered entries (1. 2. 3. etc.)

`;
    }

    return `You are translating subtitle text to ${targetLanguage}.
${contextInstructions}
CRITICAL RULES:
1. Translate ONLY the numbered text entries (1. 2. 3. etc.)
2. PRESERVE the numbering exactly (1. 2. 3. etc.)
3. Return EXACTLY ${expectedCount} numbered entries
4. Keep line breaks within each entry
5. Maintain natural dialogue flow for ${targetLanguage}
6. Use appropriate colloquialisms for ${targetLanguage}${context ? '\n7. Use the provided context to ensure consistency with previous translations' : ''}

DO NOT add ANY acknowledgements, explanations, notes, or commentary.
Do not add alternative translations
Do not skip any entries
Do not merge or split entries
Do not change the numbering
Do not add extra entries
Do not include any timestamps/timecodes or time ranges
${context ? 'Do not translate context entries - only translate numbered entries' : ''}

YOUR RESPONSE MUST:
- Start immediately with "1." (the first entry)
- End with "${expectedCount}." (the last entry)
- Contain NOTHING else

INPUT (${expectedCount} entries):

${batchText}

OUTPUT (EXACTLY ${expectedCount} numbered entries, NO OTHER TEXT):`;
  }

  /**
   * Parse batch translation response
   */
  parseBatchResponse(translatedText, expectedCount) {
    let cleaned = translatedText.trim();

    // Remove markdown code blocks
    cleaned = cleaned.replace(/```[a-z]*(?:\r?\n)?/g, '');

    const entries = [];
    const blocks = cleaned.split(/(?:\r?\n){2,}/);

    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      // Match numbered entry: "N. text" or "N) text"
      const match = trimmed.match(/^(\d+)[.):\s-]+(.+)$/s);

      if (match) {
        const num = parseInt(match[1]);
        const text = match[2].trim();

        entries.push({
          index: num - 1,
          text: text
        });
      }
    }

    // Sort by index
    entries.sort((a, b) => a.index - b.index);

    return entries;
  }

  /**
   * Fix entry count mismatches by filling missing entries with original text
   */
  fixEntryCountMismatch(translatedEntries, originalBatch) {
    if (translatedEntries.length === originalBatch.length) {
      return; // Already correct
    }

    if (translatedEntries.length < originalBatch.length) {
      // Missing entries - fill with original text
      const translatedMap = new Map();
      for (const entry of translatedEntries) {
        translatedMap.set(entry.index, entry.text);
      }

      translatedEntries.length = 0;
      for (let i = 0; i < originalBatch.length; i++) {
        if (translatedMap.has(i)) {
          translatedEntries.push({ index: i, text: translatedMap.get(i) });
        } else {
          translatedEntries.push({ index: i, text: originalBatch[i].text });
        }
      }
    } else {
      // Too many entries - keep only first N
      translatedEntries.length = originalBatch.length;
    }
  }

  /**
   * Clean translated text (remove timecodes, normalize line endings)
   */
  cleanTranslatedText(text) {
    let cleaned = text.trim();

    // Remove any embedded timecodes
    const timecodePattern = /\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}\s*\n?/g;
    cleaned = cleaned.replace(timecodePattern, '').trim();

    // Normalize line endings (CRLF → LF)
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    return cleaned;
  }

  /**
   * Remove timecodes/timeranges from arbitrary text (defensive post-clean)
   */
  sanitizeTimecodes(text) {
    let cleaned = String(text || '').trim();

    // Full-line time ranges with various separators (optional milliseconds)
    const rangeLine = /^(?:\s*)\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?\s*(?:-->|–>|—>|->|→|to)\s*\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?(?:\s*)$/gm;
    cleaned = cleaned.replace(rangeLine, '');

    // Inline time ranges
    const rangeInline = /\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?\s*(?:-->|–>|—>|->|→|to)\s*\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?/g;
    cleaned = cleaned.replace(rangeInline, '').trim();

    // Standalone full-line timestamps (with or without ms)
    const tsLine = /^(?:\s*)\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?(?:\s*)$/gm;
    cleaned = cleaned.replace(tsLine, '');

    // Bracketed/parenthesized timestamps
    const bracketedTs = /[\[(]\s*\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?\s*[\])]/g;
    cleaned = cleaned.replace(bracketedTs, '');

    // Normalize line endings and collapse blanks
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    cleaned = cleaned
      .split('\n')
      .map(l => l.trimEnd())
      .filter(l => l.trim().length > 0)
      .join('\n')
      .trim();

    return cleaned;
  }

  /**
   * Check if batch entries are cached
   */
  checkBatchCache(batch, targetLanguage, customPrompt) {
    if (!CACHE_TRANSLATIONS) {
      return { allCached: false, entries: [] };
    }

    const cachedEntries = [];
    let cacheHits = 0;

    for (const entry of batch) {
      const cached = this.getCachedEntry(entry.text, targetLanguage, customPrompt);
      if (cached) {
        cachedEntries.push({ index: entry.id - 1, text: cached });
        cacheHits++;
      } else {
        cachedEntries.push(null);
      }
    }

    const allCached = cacheHits === batch.length;
    return { allCached, entries: allCached ? cachedEntries : [] };
  }

  /**
   * Get cached entry translation
   */
  getCachedEntry(sourceText, targetLanguage, customPrompt) {
    if (!CACHE_TRANSLATIONS) return null;

    const key = this.createCacheKey(sourceText, targetLanguage, customPrompt);
    return entryCache.get(key) || null;
  }

  /**
   * Cache an entry translation
   */
  cacheEntry(sourceText, targetLanguage, translatedText, customPrompt) {
    if (!CACHE_TRANSLATIONS) return;

    // Enforce cache size limit (LRU eviction)
    if (entryCache.size >= MAX_ENTRY_CACHE_SIZE) {
      const evictionCount = Math.floor(MAX_ENTRY_CACHE_SIZE * 0.1);
      const keysToDelete = Array.from(entryCache.keys()).slice(0, evictionCount);
      for (const key of keysToDelete) {
        entryCache.delete(key);
      }
    }

    const key = this.createCacheKey(sourceText, targetLanguage, customPrompt);
    entryCache.set(key, translatedText);
  }

  /**
   * Create cache key for an entry
   */
  createCacheKey(sourceText, targetLanguage, customPrompt) {
    const normalized = sourceText.trim().toLowerCase();
    const promptHash = customPrompt
      ? crypto.createHash('md5').update(customPrompt).digest('hex').substring(0, 8)
      : 'default';
    const hash = crypto.createHash('md5')
      .update(`${normalized}:${targetLanguage}:${promptHash}`)
      .digest('hex');
    return hash;
  }

  /**
   * Clear entry cache
   */
  clearCache() {
    entryCache.clear();
    log.debug(() => '[TranslationEngine] Entry cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      size: entryCache.size,
      maxSize: MAX_ENTRY_CACHE_SIZE
    };
  }
}

module.exports = TranslationEngine;
