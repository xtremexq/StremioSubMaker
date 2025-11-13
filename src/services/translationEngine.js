/**
 * Translation Engine - Structure-First Subtitle Translation
 *
 * This engine solves subtitle sync problems by:
 * 1. Parsing SRT into structured entries (id, timecode, text)
 * 2. Translating ONLY text content in batches
 * 3. Reconstructing SRT with ORIGINAL timings (guaranteed preservation)
 * 4. Validating structure at every step
 * 5. Streaming results entry-by-entry as they're validated
 *
 * Benefits:
 * - Perfect timing preservation (timings never sent to AI)
 * - No sync issues (structure controlled by us)
 * - Entry-level caching for maximum reuse
 * - Simple, predictable behavior
 */

const { parseSRT, toSRT } = require('../utils/subtitle');
const GeminiService = require('./gemini');
const crypto = require('crypto');
const log = require('../utils/logger');

// Entry-level cache for translated subtitle entries
// Key: hash of (source_text + target_language)
// Value: translated text
const entryCache = new Map();
// Entry cache size (default: 50K entries = ~5-10MB RAM)
// Configurable via ENTRY_CACHE_SIZE environment variable
// Higher values improve cache hit rates but use more memory
// Estimate: 1000 entries ≈ 100KB-200KB RAM
const MAX_ENTRY_CACHE_SIZE = parseInt(process.env.ENTRY_CACHE_SIZE) || 50000; // Cache up to 50k individual entries (was 10k)

class TranslationEngine {
  constructor(geminiService) {
    this.gemini = geminiService;
    this.batchSize = 100; // Translate 100 entries at a time (adjustable)
  }

  /**
   * Main translation method - structure-first approach
   * @param {string} srtContent - Original SRT content
   * @param {string} targetLanguage - Target language name
   * @param {string} customPrompt - Optional custom prompt
   * @param {Function} onProgress - Callback for progress updates (entry-by-entry)
   * @returns {Promise<string>} - Translated SRT content
   */
  async translateSubtitle(srtContent, targetLanguage, customPrompt = null, onProgress = null) {
    log.debug(() => '[TranslationEngine] Starting structure-first translation');

    // Step 0: Check if input is malformed or needs Gemini-level chunking
    const estimatedTotalTokens = this.gemini.estimateTokenCount(srtContent);
    log.debug(() => `[TranslationEngine] Estimated total input tokens: ${estimatedTotalTokens}`);

    // Parse to check entry count
    const entries = parseSRT(srtContent);
    if (!entries || entries.length === 0) {
      throw new Error('Invalid SRT content: no valid entries found');
    }

    log.debug(() => `[TranslationEngine] Parsed ${entries.length} subtitle entries`);

    // Detect malformed sources: very few entries but substantial content
    // Common issue: entire subtitle file parsed as 1 entry due to formatting issues
    const avgTokensPerEntry = entries.length > 0 ? estimatedTotalTokens / entries.length : 0;
    const isMalformed = entries.length <= 5 && avgTokensPerEntry > 500; // Aggressive: 1 entry with 2.5k+ tokens = malformed

    // Route to Gemini chunking if:
    // 1. File is too large (> 30k tokens), OR
    // 2. File appears malformed (few entries but high tokens per entry)
    if (estimatedTotalTokens > 30000 || isMalformed) {
      log.debug(() => `[TranslationEngine] Routing to Gemini chunking:`);
      log.debug(() => `  - Total tokens: ${estimatedTotalTokens}`);
      log.debug(() => `  - Parsed entries: ${entries.length}`);
      log.debug(() => `  - Avg tokens/entry: ${Math.floor(avgTokensPerEntry)}`);
      log.debug(() => `  - Malformed: ${isMalformed ? 'YES' : 'NO'}`);

      // Use Gemini's chunking with streaming and progress callback
      // Use indexed array to maintain chunk order when processing in parallel
      let chunkResults = []; // Indexed array: chunkResults[chunkIndex] = translated content
      let streamBuffers = []; // Indexed array: streamBuffers[chunkIndex] = streaming buffer

      const translatedSrt = await this.gemini.translateSubtitleInChunksWithStreaming(
        srtContent,
        'detected',
        targetLanguage,
        customPrompt,
        null, // Use default chunk size
        async (info) => {
          // Call progress callback if provided
          if (typeof onProgress === 'function') {
            try {
              if (info.isDelta) {
                // Accumulate streaming deltas in indexed array (order-preserving)
                // Saving incomplete streaming deltas causes malformed SRT with overlapping timestamps
                if (!streamBuffers[info.index]) {
                  streamBuffers[info.index] = '';
                }
                streamBuffers[info.index] += info.translatedChunk;
              } else {
                // Chunk completed - store in indexed array to maintain order
                if (streamBuffers[info.index] && streamBuffers[info.index].length > 0) {
                  chunkResults[info.index] = streamBuffers[info.index];
                  streamBuffers[info.index] = ''; // Clear buffer for this chunk
                }

                // Collect all completed chunks IN ORDER (skip undefined/empty slots)
                const completedChunks = chunkResults.filter(chunk => chunk && chunk.length > 0);

                // Only save partial if we have at least one complete chunk
                if (completedChunks.length === 0) {
                  return;
                }

                // Merge chunks in order and parse to get entries
                const mergedChunks = completedChunks.join('\n\n');
                const parsedEntries = parseSRT(mergedChunks);

                // Validate that we have well-formed SRT before saving as partial
                if (parsedEntries.length === 0) {
                  log.warn(() => '[TranslationEngine] Skipping partial save: no valid SRT entries parsed');
                  return;
                }

                // Re-index entries to fix any numbering issues from merged chunks
                const reindexedEntries = parsedEntries.map((entry, idx) => ({
                  id: idx + 1,
                  timecode: entry.timecode,
                  text: entry.text
                }));

                const totalEstimatedEntries = Math.floor(estimatedTotalTokens / 50); // Rough estimate
                const completedEntries = reindexedEntries.length;

                // Convert back to SRT for partial caching
                const reindexedSrt = toSRT(reindexedEntries);

                // Provide ONLY validated, complete chunks for partial caching
                // This prevents malformed SRT from being displayed to users
                await onProgress({
                  totalEntries: totalEstimatedEntries,
                  completedEntries: completedEntries,
                  currentBatch: info.index + 1,
                  totalBatches: info.total,
                  entry: null, // No individual entry
                  partialContent: reindexedSrt // Provide re-indexed, validated SRT
                });
              }
            } catch (err) {
              log.warn(() => ['[TranslationEngine] Progress callback error:', err.message]);
            }
          }
        }
      );

      log.debug(() => `[TranslationEngine] Gemini chunking completed successfully`);
      return translatedSrt;
    }

    // Step 2: Split entries into batches
    const batches = this.createBatches(entries, this.batchSize);
    log.debug(() => `[TranslationEngine] Created ${batches.length} batches (${this.batchSize} entries each)`);

    // Step 3: Translate each batch
    const translatedEntries = [];

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      log.debug(() => `[TranslationEngine] Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} entries)`);

      try {
        const translatedBatch = await this.translateBatch(
          batch,
          targetLanguage,
          customPrompt,
          batchIndex,
          batches.length
        );

        // Note: translateBatch now handles entry count mismatches internally
        // and ensures the returned array always matches batch.length
        if (translatedBatch.length !== batch.length) {
          log.error(() => `[TranslationEngine] UNEXPECTED: translateBatch returned ${translatedBatch.length} entries, expected ${batch.length}`);
          log.error(() => `[TranslationEngine] This should have been fixed by translateBatch - continuing anyway`);
        }

        // Merge translated text with original structure
        for (let i = 0; i < batch.length; i++) {
          const original = batch[i];
          const translated = translatedBatch[i];

          // Clean translated text: remove any embedded timecodes that Gemini might have included
          // Gemini sometimes preserves original timecodes in translation output
          let cleanedText = translated.text.trim();
          // Pattern: HH:MM:SS,MMM --> HH:MM:SS,MMM followed by optional newline
          // Use global flag to remove ALL occurrences (Gemini sometimes includes multiple)
          const timecodePattern = /\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}\s*\n?/g;
          cleanedText = cleanedText.replace(timecodePattern, '').trim();

          // Normalize line endings: Convert CRLF (\r\n) to LF (\n) only
          // This fixes the issue on Linux where CRLF causes extra spacing between subtitle lines
          cleanedText = cleanedText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

          // Create entry with original timing and cleaned translated text
          const translatedEntry = {
            id: original.id,
            timecode: original.timecode, // PRESERVE ORIGINAL TIMING
            text: cleanedText
          };

          translatedEntries.push(translatedEntry);

          // Call progress callback if provided
          if (typeof onProgress === 'function') {
            try {
              await onProgress({
                totalEntries: entries.length,
                completedEntries: translatedEntries.length,
                currentBatch: batchIndex + 1,
                totalBatches: batches.length,
                entry: translatedEntry
              });
            } catch (err) {
              log.warn(() => ['[TranslationEngine] Progress callback error:', err.message]);
            }
          }
        }

        log.debug(() => `[TranslationEngine] Batch ${batchIndex + 1}/${batches.length} completed successfully`);

        // Small delay between batches to avoid rate limiting
        if (batchIndex < batches.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

      } catch (error) {
        log.error(() => [`[TranslationEngine] Error in batch ${batchIndex + 1}:`, error.message]);
        throw new Error(`Translation failed at batch ${batchIndex + 1}: ${error.message}`);
      }
    }

    // Step 4: Final validation
    // Note: Entry count mismatches are now handled gracefully in translateBatch
    if (translatedEntries.length !== entries.length) {
      log.warn(() => `[TranslationEngine] Final validation: expected ${entries.length} entries, got ${translatedEntries.length}`);
      log.warn(() => `[TranslationEngine] This should have been fixed by translateBatch, but continuing with what we have`);
    }

    log.debug(() => `[TranslationEngine] Translation completed: ${translatedEntries.length} entries translated`);

    // Step 5: Convert back to SRT format
    const translatedSRT = toSRT(translatedEntries);

    return translatedSRT;
  }

  /**
   * Create batches from entries
   * @param {Array} entries - Subtitle entries
   * @param {number} batchSize - Number of entries per batch
   * @returns {Array<Array>} - Array of batches
   */
  createBatches(entries, batchSize) {
    const batches = [];
    for (let i = 0; i < entries.length; i += batchSize) {
      batches.push(entries.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Translate a batch of entries
   * @param {Array} batch - Batch of subtitle entries
   * @param {string} targetLanguage - Target language name
   * @param {string} customPrompt - Optional custom prompt
   * @param {number} batchIndex - Current batch index
   * @param {number} totalBatches - Total number of batches
   * @returns {Promise<Array>} - Array of translated entries
   */
  async translateBatch(batch, targetLanguage, customPrompt, batchIndex, totalBatches) {
    // Check cache first
    const cacheResults = this.checkBatchCache(batch, targetLanguage);

    // If all entries are cached, return immediately
    if (cacheResults.allCached) {
      log.debug(() => `[TranslationEngine] Batch ${batchIndex + 1} fully cached (${batch.length} entries)`);
      return cacheResults.entries;
    }

    // Prepare batch for translation
    const batchText = this.prepareBatchText(batch);

    // Create translation prompt
    const prompt = this.createBatchPrompt(batchText, targetLanguage, customPrompt, batch.length);

    // Check if we need to chunk due to large input (> 30k tokens)
    const estimatedInputTokens = this.gemini.estimateTokenCount(batchText + prompt);

    if (estimatedInputTokens > 30000 && batch.length > 1) {
      // Split batch in half to avoid output token limit
      log.debug(() => `[TranslationEngine] Batch ${batchIndex + 1} has ${estimatedInputTokens} estimated input tokens (> 30k), splitting into 2 parts`);

      const midpoint = Math.floor(batch.length / 2);
      const firstHalf = batch.slice(0, midpoint);
      const secondHalf = batch.slice(midpoint);

      log.debug(() => `[TranslationEngine] Split batch ${batchIndex + 1}: Part 1 has ${firstHalf.length} entries, Part 2 has ${secondHalf.length} entries`);

      // Recursively translate each half
      const firstHalfTranslated = await this.translateBatch(firstHalf, targetLanguage, customPrompt, batchIndex, totalBatches);
      const secondHalfTranslated = await this.translateBatch(secondHalf, targetLanguage, customPrompt, batchIndex, totalBatches);

      // Combine results
      return [...firstHalfTranslated, ...secondHalfTranslated];
    }

    // Translate with retry logic for 503 errors
    log.debug(() => `[TranslationEngine] Translating batch ${batchIndex + 1}/${totalBatches}`);
    let translatedText;
    let lastError;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        translatedText = await this.gemini.translateSubtitle(
          batchText,
          'detected',
          targetLanguage,
          prompt
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
          log.debug(() => `[TranslationEngine] Batch ${batchIndex + 1} got 503 error, retrying in ${delayMs}ms (attempt ${attempt}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        } else {
          // Not a 503 or out of retries
          throw error;
        }
      }
    }

    if (!translatedText) {
      throw lastError || new Error('Translation failed after retries');
    }

    // Parse translated text back into entries
    const translatedEntries = this.parseBatchResponse(translatedText, batch.length);

    // Handle entry count mismatches gracefully instead of throwing away translations
    if (translatedEntries.length !== batch.length) {
      log.warn(() => `[TranslationEngine] Batch validation: expected ${batch.length} entries, got ${translatedEntries.length}`);

      if (translatedEntries.length < batch.length) {
        // Missing entries - fill in with original text (untranslated)
        const missingCount = batch.length - translatedEntries.length;
        log.warn(() => `[TranslationEngine] ${missingCount} entries missing in translation, using original text for those entries`);

        // Create a map of translated entries by index
        const translatedMap = new Map();
        for (const entry of translatedEntries) {
          translatedMap.set(entry.index, entry.text);
        }

        // Build complete array, using original text for missing entries
        const completeEntries = [];
        for (let i = 0; i < batch.length; i++) {
          if (translatedMap.has(i)) {
            completeEntries.push({
              index: i,
              text: translatedMap.get(i)
            });
          } else {
            // Use original text for missing entry (no per-entry logging to avoid spam)
            completeEntries.push({
              index: i,
              text: batch[i].text
            });
          }
        }

        // Replace translatedEntries with the complete version
        translatedEntries.length = 0;
        translatedEntries.push(...completeEntries);

      } else if (translatedEntries.length > batch.length) {
        // Too many entries - truncate to expected count
        log.debug(() => `[TranslationEngine] Removing ${translatedEntries.length - batch.length} extra entries`);

        // Keep only the first batch.length entries
        translatedEntries.length = batch.length;

        // Ensure indices are correct (0 to batch.length-1)
        for (let i = 0; i < translatedEntries.length; i++) {
          translatedEntries[i].index = i;
        }
      }

      log.debug(() => `[TranslationEngine] Entry count fixed: now have ${translatedEntries.length} entries`);
    }

    // Cache individual entries
    for (let i = 0; i < batch.length; i++) {
      this.cacheEntry(batch[i].text, targetLanguage, translatedEntries[i].text);
    }

    log.debug(() => `[TranslationEngine] Batch ${batchIndex + 1} translated and validated (${translatedEntries.length} entries)`);

    return translatedEntries;
  }

  /**
   * Prepare batch text for translation
   * Format: numbered list of texts
   * @param {Array} batch - Batch of subtitle entries
   * @returns {string} - Formatted batch text
   */
  prepareBatchText(batch) {
    const lines = batch.map((entry, index) => {
      const num = index + 1;
      // Clean text: remove extra whitespace, normalize line breaks
      const cleanText = entry.text.trim().replace(/\n+/g, '\n');
      return `${num}. ${cleanText}`;
    });

    return lines.join('\n\n');
  }

  /**
   * Create translation prompt for a batch
   * @param {string} batchText - Formatted batch text
   * @param {string} targetLanguage - Target language name
   * @param {string} customPrompt - Optional custom prompt
   * @param {number} expectedCount - Expected number of entries
   * @returns {string} - Complete prompt
   */
  createBatchPrompt(batchText, targetLanguage, customPrompt, expectedCount) {
    if (customPrompt) {
      // Use custom prompt if provided
      return customPrompt.replace('{target_language}', targetLanguage);
    }

    // Default structured prompt
    const prompt = `You are translating subtitle text to ${targetLanguage}.

CRITICAL RULES:
1. Translate ONLY the text content
2. PRESERVE the numbering exactly (1. 2. 3. etc.)
3. Return EXACTLY ${expectedCount} numbered entries
4. Keep line breaks within each entry
5. Maintain natural dialogue flow for ${targetLanguage}
6. Use appropriate colloquialisms for ${targetLanguage}

DO NOT:
- Add ANY explanations, notes, or commentary before, after, or between entries
- Add alternative translations or suggestions
- Include meta-text like "Here are the translations:" or "Translation notes:"
- Skip any entries
- Merge or split entries
- Change the numbering
- Add extra entries beyond ${expectedCount}

YOUR RESPONSE MUST:
- Start immediately with "1." (the first entry)
- End with "${expectedCount}." (the last entry)
- Contain NOTHING else

INPUT (${expectedCount} entries):

${batchText}

OUTPUT (EXACTLY ${expectedCount} numbered entries, NO OTHER TEXT):`;

    return prompt;
  }

  /**
   * Parse batch translation response
   * @param {string} translatedText - Raw translated text from Gemini
   * @param {number} expectedCount - Expected number of entries
   * @returns {Array} - Array of translated entries (with index and text)
   */
  parseBatchResponse(translatedText, expectedCount) {
    // Clean the response
    let cleaned = translatedText.trim();

    // Remove markdown code blocks if present
    cleaned = cleaned.replace(/```[a-z]*\n?/g, '');

    // Try to extract numbered entries
    // Pattern: "1. text" or "1) text" or "1 - text"
    const entries = [];

    // Split by double newlines first (entry separator)
    const blocks = cleaned.split(/\n\n+/);

    for (const block of blocks) {
      // Don't stop at expectedCount - parse everything we can
      const trimmed = block.trim();
      if (!trimmed) continue;

      // Try to match numbered entry: "N. text" or "N) text" or "N - text"
      const match = trimmed.match(/^(\d+)[.):\s-]+(.+)$/s);

      if (match) {
        const num = parseInt(match[1]);
        const text = match[2].trim();

        entries.push({
          index: num - 1, // Convert to 0-based index
          text: text
        });
      }
      // REMOVED: Don't add unnumbered blocks as entries - they're likely explanations
    }

    // Sort by index to ensure correct order
    entries.sort((a, b) => a.index - b.index);

    // Validate: must have expected count
    if (entries.length !== expectedCount) {
      log.warn(() => `[TranslationEngine] Entry count mismatch: expected ${expectedCount}, parsed ${entries.length}`);

      // Try alternative parsing: split by newlines and look for patterns
      const lines = cleaned.split('\n');
      const altEntries = [];
      let currentEntry = null;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const match = trimmed.match(/^(\d+)[.):\s-]+(.+)$/);

        if (match) {
          // Save previous entry if we have one
          if (currentEntry) {
            altEntries.push(currentEntry);
          }
          const num = parseInt(match[1]);
          currentEntry = {
            index: num - 1,
            text: match[2].trim()
          };
        } else if (currentEntry) {
          // Continue current entry (multi-line text)
          currentEntry.text += '\n' + trimmed;
        }
        // REMOVED: Don't add non-numbered lines as new entries
      }

      // Add final entry
      if (currentEntry) {
        altEntries.push(currentEntry);
      }

      if (altEntries.length > 0) {
        log.debug(() => `[TranslationEngine] Alternative parsing found ${altEntries.length} entries`);
        altEntries.sort((a, b) => a.index - b.index);

        // Use alternative parsing if it's better than the first attempt
        if (altEntries.length > entries.length) {
          return altEntries;
        }
      }
    }

    return entries;
  }

  /**
   * Check if batch entries are cached
   * @param {Array} batch - Batch of entries
   * @param {string} targetLanguage - Target language
   * @returns {Object} - { allCached: boolean, entries: Array }
   */
  checkBatchCache(batch, targetLanguage) {
    const cachedEntries = [];
    let cacheHits = 0;

    for (const entry of batch) {
      const cached = this.getCachedEntry(entry.text, targetLanguage);
      if (cached) {
        cachedEntries.push({ index: entry.id - 1, text: cached });
        cacheHits++;
      } else {
        cachedEntries.push(null);
      }
    }

    const allCached = cacheHits === batch.length;

    if (cacheHits > 0) {
      log.debug(() => `[TranslationEngine] Cache: ${cacheHits}/${batch.length} entries cached`);
    }

    return {
      allCached,
      entries: allCached ? cachedEntries : []
    };
  }

  /**
   * Get cached entry translation
   * @param {string} sourceText - Source text
   * @param {string} targetLanguage - Target language
   * @returns {string|null} - Cached translation or null
   */
  getCachedEntry(sourceText, targetLanguage) {
    const key = this.createCacheKey(sourceText, targetLanguage);
    return entryCache.get(key) || null;
  }

  /**
   * Cache an entry translation
   * @param {string} sourceText - Source text
   * @param {string} targetLanguage - Target language
   * @param {string} translatedText - Translated text
   */
  cacheEntry(sourceText, targetLanguage, translatedText) {
    // Enforce cache size limit (LRU-like behavior)
    if (entryCache.size >= MAX_ENTRY_CACHE_SIZE) {
      // Remove oldest entries (first 10% of max size to reduce eviction frequency)
      const evictionCount = Math.floor(MAX_ENTRY_CACHE_SIZE * 0.1);
      const keysToDelete = Array.from(entryCache.keys()).slice(0, evictionCount);
      for (const key of keysToDelete) {
        entryCache.delete(key);
      }
      log.debug(() => `[TranslationEngine] Evicted ${evictionCount} entries from cache (size: ${entryCache.size})`);
    }

    const key = this.createCacheKey(sourceText, targetLanguage);
    entryCache.set(key, translatedText);
  }

  /**
   * Create cache key for an entry
   * @param {string} sourceText - Source text
   * @param {string} targetLanguage - Target language
   * @returns {string} - Cache key
   */
  createCacheKey(sourceText, targetLanguage) {
    const normalized = sourceText.trim().toLowerCase();
    const hash = crypto.createHash('md5')
      .update(`${normalized}:${targetLanguage}`)
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
   * @returns {Object} - Cache stats
   */
  getCacheStats() {
    return {
      size: entryCache.size,
      maxSize: MAX_ENTRY_CACHE_SIZE
    };
  }
}

module.exports = TranslationEngine;
