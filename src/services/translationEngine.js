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
const { DEFAULT_TRANSLATION_PROMPT } = GeminiService;
const crypto = require('crypto');
const log = require('../utils/logger');
const { normalizeTargetLanguageForPrompt } = require('./utils/normalizeTargetLanguageForPrompt');

// Extract normalized tokens from a language label/code (split on common separators)
function tokenizeLanguageValue(value) {
  return String(value || '')
    .normalize('NFKD') // strip accents/diacritics for safer comparisons
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9+]+/g)
    .filter(Boolean);
}

// RTL language detection (codes and human-readable names)
function isRtlLanguage(lang) {
  const tokens = tokenizeLanguageValue(lang);
  if (tokens.length === 0) return false;

  const rtlTokens = new Set([
    'ar', 'ara', 'arabic',
    'he', 'heb', 'hebrew',
    'fa', 'fas', 'per', 'persian', 'farsi',
    'ur', 'urd', 'urdu',
    'ps', 'pus', 'pushto', 'pashto',
    'ku', 'ckb', 'kur', 'kurdish', 'sorani',
    'dv', 'div', 'dhivehi',
    'yi', 'yid', 'yiddish'
  ]);

  // Match against individual tokens only (prevents false positives like "Turkish" matching "ur")
  return tokens.some(token => {
    // Avoid false positives like "Sichuan Yi" (Yi is LTR; Yiddish uses the same ISO-639-1 code)
    if (token === 'yi') {
      return tokens.length === 1 || tokens.includes('yid') || tokens.includes('yiddish');
    }
    return rtlTokens.has(token);
  });
}

function wrapRtlText(text) {
  const str = String(text || '');
  // Skip if already contains bidi markers
  if (/(?:\u200e|\u200f|\u202a|\u202b|\u202c|\u202d|\u202e)/u.test(str)) {
    return str;
  }
  const start = '\u202B'; // RLE - start RTL embedding
  const end = '\u202C';   // PDF - pop directional formatting
  return str
    .split('\n')
    .map(line => (line ? `${start}${line}${end}` : line))
    .join('\n');
}

// Entry-level cache for translated subtitle entries
const entryCache = new Map();
const MAX_ENTRY_CACHE_SIZE = parseInt(process.env.ENTRY_CACHE_SIZE) || 100000;

// Configuration constants
const MAX_TOKENS_PER_BATCH = parseInt(process.env.MAX_TOKENS_PER_BATCH) || 25000; // Max tokens before auto-chunking
const SINGLE_BATCH_MAX_TOKENS_PER_CHUNK = parseInt(process.env.SINGLE_BATCH_MAX_TOKENS_PER_CHUNK) || 120000;
const SINGLE_BATCH_TOKEN_SOFT_LIMIT = Math.floor(SINGLE_BATCH_MAX_TOKENS_PER_CHUNK * 0.9);
// Entry cache disabled by default - causes stale data on cache resets and not HA-aware
// Only useful for repeated translations with identical config (rare)
const CACHE_TRANSLATIONS = process.env.CACHE_TRANSLATIONS === 'true'; // Enable/disable entry caching

/**
 * Get batch size for model (model-specific optimization)
 * Priority: Environment variable > Model-specific > Default (250)
 *
 * Model-specific batch sizes are hardcoded in backend and safe from client manipulation.
 * Different models have different processing speeds and capabilities:
 * - Flash models: 250 entries (faster, more capable)
 * - Flash-lite models: 200 entries (more conservative for stability)
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

  // Gemini 3.0 Flash: Large context window, higher batch size for throughput
  if (modelStr.includes('gemini-3-flash')) {
    return 400;
  }

  // Gemma models: Lower batch size for stability
  if (modelStr.includes('gemma')) {
    return 200;
  }

  // Flash-lite models: More conservative batch size for stability
  if (modelStr.includes('flash-lite')) {
    return 200;
  }

  // Flash models (non-lite): Larger batch size for better throughput
  if (modelStr.includes('flash')) {
    return 250;
  }

  // Default batch size for unknown models
  return 250;
}

// Module-level shared key health tracking across engine instances.
// Keys with repeated errors are skipped by all engines within the same process,
// preventing a bad key from being retried by a new translation request.
const _sharedKeyHealthErrors = new Map(); // apiKey -> { count: number, lastError: number }

class TranslationEngine {
  constructor(geminiService, model = null, advancedSettings = {}, options = {}) {
      this.gemini = geminiService?.primary || geminiService;
      this.fallbackProvider = geminiService?.fallback || null;
      this.providerName = options.providerName || 'gemini';
      this.fallbackProviderName = options.fallbackProviderName || (this.fallbackProvider ? 'fallback' : '');
      if (!this.fallbackProviderName && this.fallbackProvider?.providerName) {
        this.fallbackProviderName = this.fallbackProvider.providerName;
      }
      this.model = model;
      this.batchSize = getBatchSizeForModel(model);
      this.singleBatchMode = options.singleBatchMode === true;
      this.enableStreaming = options.enableStreaming !== false
        && typeof (this.gemini?.streamTranslateSubtitle) === 'function';
      this.maxTokensPerBatch = this.singleBatchMode ? SINGLE_BATCH_MAX_TOKENS_PER_CHUNK : MAX_TOKENS_PER_BATCH;
      this.advancedSettings = advancedSettings || {};

      // Context settings (disabled by default)
      this.enableBatchContext = this.advancedSettings.enableBatchContext === true;
      this.contextSize = parseInt(this.advancedSettings.contextSize) || 3;

      // Mismatch retry: number of retries when AI returns wrong entry count (default: 1)
      const rawMismatchRetries = parseInt(this.advancedSettings.mismatchRetries);
      this.mismatchRetries = Number.isFinite(rawMismatchRetries) ? Math.max(0, Math.min(3, rawMismatchRetries)) : 1;

      // Translation workflow mode: 'original' (numbered list), 'ai' (send timestamps), 'xml' (XML-tagged entries)
      const rawWorkflow = String(this.advancedSettings.translationWorkflow || '').toLowerCase();
      if (rawWorkflow === 'xml') {
        this.translationWorkflow = 'xml';
        this.sendTimestampsToAI = false;
      } else if (rawWorkflow === 'ai' || this.advancedSettings.sendTimestampsToAI === true) {
        this.translationWorkflow = 'ai';
        this.sendTimestampsToAI = true;
      } else {
        this.translationWorkflow = 'original';
        this.sendTimestampsToAI = false;
      }

      // JSON structured output mode (disabled by default, opt-in via config)
      // Force-disable for non-LLM providers — they don't support structured output
      const NON_LLM_PROVIDERS = new Set(['deepl', 'googletranslate']);
      this.isNativeBatchProvider = NON_LLM_PROVIDERS.has(this.providerName);
      this.enableJsonOutput = this.isNativeBatchProvider ? false : this.advancedSettings.enableJsonOutput === true;

      // --- Fix #9: Warn (and disable) when JSON output is enabled with 'ai' workflow.
      // JSON structured output is incompatible with 'ai' (timestamp/SRT) mode because the
      // AI must return valid SRT, not a JSON array. Silently ignoring it is confusing.
      if (this.enableJsonOutput && this.translationWorkflow === 'ai') {
        log.warn(() => `[TranslationEngine] JSON structured output is not compatible with 'ai' (timestamp) workflow — disabling JSON output. Use 'original' or 'xml' workflow for JSON output.`);
        this.enableJsonOutput = false;
      }

      // Cap batch size when JSON output is enabled — large JSON arrays (300-400 objects)
      // are extremely error-prone for LLMs. Keep batches at ≤150 entries for reliable JSON.
      const JSON_OUTPUT_MAX_BATCH_SIZE = 150;
      if (this.enableJsonOutput && this.batchSize > JSON_OUTPUT_MAX_BATCH_SIZE) {
        log.debug(() => `[TranslationEngine] Capping batch size from ${this.batchSize} to ${JSON_OUTPUT_MAX_BATCH_SIZE} for JSON output mode`);
        this.batchSize = JSON_OUTPUT_MAX_BATCH_SIZE;
      }

      // Force workflow to 'original' for non-LLM providers — XML tags and AI timestamps are LLM-only features
      if (this.isNativeBatchProvider && this.translationWorkflow !== 'original') {
        log.debug(() => `[TranslationEngine] Forcing workflow to 'original' for non-LLM provider ${this.providerName} (was '${this.translationWorkflow}')`);
        this.translationWorkflow = 'original';
        this.sendTimestampsToAI = false;
      }

      // Key rotation configuration for per-batch and per-request rotation
      // keyRotationConfig: { enabled: boolean, mode: 'per-request' | 'per-batch', keys: string[], advancedSettings: {} }
      // SECURITY: Store keys in a non-enumerable property to prevent accidental serialization
      if (options.keyRotationConfig && Array.isArray(options.keyRotationConfig.keys)) {
        const filteredKeys = options.keyRotationConfig.keys.filter(k => typeof k === 'string' && k.trim());
        const sanitizedConfig = {
          enabled: options.keyRotationConfig.enabled === true,
          mode: options.keyRotationConfig.mode || 'per-batch',
          // Merge advancedSettings with engine-level settings so enableJsonOutput etc. are never lost
          advancedSettings: { ...this.advancedSettings, ...(options.keyRotationConfig.advancedSettings || {}) }
        };
        // Make keys non-enumerable so they won't appear in JSON.stringify or Object.keys
        Object.defineProperty(sanitizedConfig, 'keys', {
          value: filteredKeys,
          enumerable: false,
          writable: false,
          configurable: false
        });
        this.keyRotationConfig = sanitizedConfig;
      } else {
        this.keyRotationConfig = null;
      }

      // Rotation is available when enabled, we have >1 key, and provider is Gemini
      const rotationAvailable = this.keyRotationConfig?.enabled === true &&
        Array.isArray(this.keyRotationConfig?.keys) &&
        this.keyRotationConfig.keys.length > 1 &&
        this.providerName === 'gemini';

      // Per-batch: rotate before every batch. Per-request: single key per file but retry rotation still works.
      this.perBatchRotationEnabled = rotationAvailable && this.keyRotationConfig?.mode === 'per-batch';
      // Retry rotation: enabled for BOTH per-batch and per-request modes so error retries can try a different key
      this.retryRotationEnabled = rotationAvailable;

      // Global counter for round-robin key rotation (shared across batches and retries).
      // Seed from the initial key's position so the first rotation advances to the next key
      // instead of always restarting at index 0 (which would waste the initial selectGeminiApiKey call).
      const initialApiKey = this.gemini?.apiKey;
      const initialKeyIndex = (initialApiKey && this.keyRotationConfig?.keys)
        ? this.keyRotationConfig.keys.indexOf(initialApiKey)
        : -1;
      this._keyRotationCounter = initialKeyIndex >= 0 ? initialKeyIndex + 1 : 0;

      // Cache model limits across key rotations to avoid redundant API calls
      this._sharedModelLimits = null;

      // Key health tracking: use module-level shared map so errors persist across engine instances.
      // Keys with >= KEY_HEALTH_ERROR_THRESHOLD errors within KEY_HEALTH_COOLDOWN_MS are skipped.
      this._keyHealthErrors = _sharedKeyHealthErrors;

      if (this.perBatchRotationEnabled) {
        log.debug(() => `[TranslationEngine] Per-batch key rotation enabled with ${this.keyRotationConfig.keys.length} keys`);
      } else if (this.retryRotationEnabled) {
        log.debug(() => `[TranslationEngine] Per-request key rotation enabled with ${this.keyRotationConfig.keys.length} keys (retry rotation active)`);
      }

      // isNativeBatchProvider already set above during JSON/workflow normalization

      const rotationLabel = this.perBatchRotationEnabled ? 'per-batch' : (this.retryRotationEnabled ? 'per-request' : '');
      log.debug(() => `[TranslationEngine] Initialized with model: ${model || 'unknown'}, batch size: ${this.batchSize}, batch context: ${this.enableBatchContext ? 'enabled' : 'disabled'}, workflow: ${this.translationWorkflow}, mode: ${this.singleBatchMode ? 'single-batch' : 'batched'}, mismatchRetries: ${this.mismatchRetries}, jsonOutput: ${this.enableJsonOutput}${rotationLabel ? `, key-rotation: ${rotationLabel}, keys: ${this.keyRotationConfig.keys.length}` : ''}${this.isNativeBatchProvider ? ', native-batch: true' : ''}`);
    }

  /**
   * Rotate to a new API key before translating a batch (when per-batch rotation is enabled)
   * Creates a fresh GeminiService instance with a sequentially selected key (round-robin)
   */
  maybeRotateKeyForBatch(batchIndex) {
    if (!this.perBatchRotationEnabled) return;

    // Skip rotation for the first batch — the initial GeminiService was already created
    // with the key selected by selectGeminiApiKey(), so rotating here would waste that
    // instance and create a duplicate. Subsequent batches rotate normally.
    if (batchIndex === 0) return;

    // Use the global rotation counter so retries naturally advance to the next key
    this._rotateToNextKey(`batch ${batchIndex + 1}`);
  }

  /**
   * Key health tracking constants
   */
  static KEY_HEALTH_ERROR_THRESHOLD = 5;
  static KEY_HEALTH_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

  /**
   * Record an error for the current API key (for health tracking).
   * @param {string} apiKey - The key that errored
   */
  _recordKeyError(apiKey) {
    if (!this.retryRotationEnabled || !apiKey) return;
    const now = Date.now();
    const entry = this._keyHealthErrors.get(apiKey) || { count: 0, lastError: 0 };
    // Reset counter if cooldown has elapsed since last error
    if (now - entry.lastError > TranslationEngine.KEY_HEALTH_COOLDOWN_MS) {
      entry.count = 0;
    }
    entry.count++;
    entry.lastError = now;
    this._keyHealthErrors.set(apiKey, entry);
    if (entry.count >= TranslationEngine.KEY_HEALTH_ERROR_THRESHOLD) {
      log.warn(() => `[TranslationEngine] Key ${this._redactKey(apiKey)} reached ${entry.count} errors, will be skipped for ~1h cooldown`);
    }
  }

  /**
   * Check if a key is currently in cooldown (unhealthy).
   * @param {string} apiKey
   * @returns {boolean}
   */
  _isKeyCoolingDown(apiKey) {
    if (!apiKey) return false;
    const entry = this._keyHealthErrors.get(apiKey);
    if (!entry) return false;
    const now = Date.now();
    // If cooldown has elapsed, reset and allow the key
    if (now - entry.lastError > TranslationEngine.KEY_HEALTH_COOLDOWN_MS) {
      this._keyHealthErrors.delete(apiKey);
      return false;
    }
    return entry.count >= TranslationEngine.KEY_HEALTH_ERROR_THRESHOLD;
  }

  /**
   * Redact an API key for safe logging (first 4 + last 4 chars).
   * @param {string} key
   * @returns {string}
   */
  _redactKey(key) {
    if (!key || key.length < 10) return '[REDACTED]';
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
  }

  /**
   * Advance the global key rotation counter and swap to the next key.
   * Every call (whether for a new batch or a retry) moves to the next key in round-robin order.
   * Skips keys that are in cooldown (too many recent errors), falling back to the next healthy key.
   * Preserves cached model limits across rotations to avoid redundant API calls.
   * @param {string} reason - Human-readable reason for the rotation (used in debug logs)
   */
  _rotateToNextKey(reason) {
    if (!this.retryRotationEnabled) return;

    const keys = this.keyRotationConfig.keys;
    const totalKeys = keys.length;

    // Always capture the latest model limits from the current instance before replacing it.
    // This ensures limits fetched after the first rotation (or updated from fallback to real values)
    // are preserved for subsequent rotations.
    if (this.gemini?._modelLimits) {
      this._sharedModelLimits = this.gemini._modelLimits;
    }

    // Find the next healthy key, trying up to totalKeys candidates
    let selectedKey = null;
    let keyIndex = -1;
    for (let attempt = 0; attempt < totalKeys; attempt++) {
      const candidateIndex = this._keyRotationCounter % totalKeys;
      this._keyRotationCounter++;
      const candidate = keys[candidateIndex];
      if (!this._isKeyCoolingDown(candidate)) {
        selectedKey = candidate;
        keyIndex = candidateIndex;
        break;
      }
      log.debug(() => `[TranslationEngine] Skipping key ${candidateIndex + 1}/${totalKeys} (in cooldown) for ${reason}`);
    }

    // If all keys are in cooldown, use the next one anyway (best effort)
    if (!selectedKey) {
      keyIndex = (this._keyRotationCounter - totalKeys) % totalKeys; // rewind to first candidate
      selectedKey = keys[keyIndex];
      log.warn(() => `[TranslationEngine] All ${totalKeys} keys are in cooldown, using key ${keyIndex + 1} anyway for ${reason}`);
    }

    this.gemini = new GeminiService(
      selectedKey,
      this.model,
      this.keyRotationConfig.advancedSettings
    );
    this.gemini._totalKeys = totalKeys;

    // Restore cached model limits so the new instance doesn't re-fetch them
    if (this._sharedModelLimits) {
      this.gemini._modelLimits = this._sharedModelLimits;
    }

    // Re-verify streaming capability on the new instance. Currently all GeminiService
    // instances support streaming, but this guards against future provider heterogeneity.
    this.enableStreaming = this.enableStreaming && typeof this.gemini.streamTranslateSubtitle === 'function';

    log.debug(() => `[TranslationEngine] Rotated to key index ${keyIndex + 1}/${totalKeys} for ${reason} (counter: ${this._keyRotationCounter})`);
  }

  /**
   * Perform a translation call, using streaming or non-streaming based on the provided flag.
   * Centralizes the call pattern so retry paths don't accidentally drop streaming.
   * @param {string} batchText
   * @param {string} targetLanguage
   * @param {string} prompt
   * @param {boolean} useStreaming - Whether to use streaming
   * @param {Function|null} onStreamChunk - Streaming progress callback (only used when useStreaming=true)
   * @returns {Promise<string>}
   */
  async _translateCall(batchText, targetLanguage, prompt, useStreaming, onStreamChunk) {
    if (useStreaming && typeof this.gemini.streamTranslateSubtitle === 'function') {
      return this.gemini.streamTranslateSubtitle(
        batchText,
        'detected',
        targetLanguage,
        prompt,
        onStreamChunk || null
      );
    }
    return this.gemini.translateSubtitle(
      batchText,
      'detected',
      targetLanguage,
      prompt
    );
  }

  /**
   * Check if an error is a retryable HTTP error (429 Too Many Requests or 503 Service Unavailable).
   * @param {Error} error
   * @returns {boolean}
   */
  _isRetryableHttpError(error) {
    if (!error) return false;
    const msg = error.message || '';
    const status = error.statusCode || error.status || error.response?.status || 0;
    return status === 429 || status === 503 ||
      msg.includes('429') || msg.includes('Too Many Requests') ||
      msg.includes('503') || msg.includes('Service Unavailable') ||
      msg.includes('RESOURCE_EXHAUSTED') || msg.includes('rate limit');
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
    // Track per-run RTL so all cleanups (including streaming) can apply markers consistently
    this.isRtlTarget = isRtlLanguage(targetLanguage);

    // Step 1: Parse SRT into structured entries
    const entries = parseSRT(srtContent);
    if (!entries || entries.length === 0) {
      throw new Error('Invalid SRT content: no valid entries found');
    }

    // Single-batch mode: translate the whole file (with limited auto-splitting)
    if (this.singleBatchMode) {
      return this.translateSubtitleSingleBatch(entries, targetLanguage, customPrompt, onProgress);
    }

    log.info(() => `[TranslationEngine] Starting translation: ${entries.length} entries, ${Math.ceil(entries.length / this.batchSize)} batches`);

    const streamingEnabled = this.enableStreaming && !this.singleBatchMode;
    let globalStreamSequence = 0;

    // Step 2: Create batches
    const batches = this.createBatches(entries, this.batchSize);

    // Step 3: Translate each batch with smart progress tracking
    const translatedEntries = [];
    // Streaming optimization: keep a pre-built SRT string for completed batches
    // so we only rebuild the current streaming batch on each progress callback.
    let completedSRT = '';
    let completedEntryCount = 0;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const batchStartId = batch[0]?.id || 1;
      const streamingBatchEntries = new Map();

      try {
        // Rotate API key for this batch if per-batch rotation is enabled
        this.maybeRotateKeyForBatch(batchIndex);

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
          context,
          {
            streaming: streamingEnabled,
            onStreamProgress: async (payload) => {
              if (typeof onProgress !== 'function' || !payload?.partialSRT) return;

              const parsed = parseSRT(payload.partialSRT) || [];
              const offset = (payload.batchStartId || batchStartId) - 1;
              for (const entry of parsed) {
                const globalId = (entry.id || 0) + offset;
                if (globalId <= 0) continue;
                streamingBatchEntries.set(globalId, {
                  id: globalId,
                  timecode: entry.timecode,
                  text: this.cleanTranslatedText(entry.text || '')
                });
              }

              // Only rebuild SRT for the current streaming batch entries,
              // then prepend the already-built completed SRT string.
              const streamEntries = Array.from(streamingBatchEntries.values()).sort((a, b) => a.id - b.id);
              const streamNormalized = streamEntries.map((entry, idx) => ({
                id: completedEntryCount + idx + 1,
                timecode: entry.timecode,
                text: entry.text
              }));
              const streamSRT = toSRT(streamNormalized);
              const partialSRT = completedSRT
                ? completedSRT + '\n\n' + streamSRT
                : streamSRT;

              const seq = ++globalStreamSequence;
              try {
                await onProgress({
                  totalEntries: entries.length,
                  completedEntries: Math.min(entries.length, completedEntryCount + streamingBatchEntries.size),
                  currentBatch: payload.currentBatch || (batchIndex + 1),
                  totalBatches: batches.length,
                  partialSRT,
                  streaming: true,
                  streamSequence: seq
                });
              } catch (err) {
                log.warn(() => ['[TranslationEngine] Streaming progress callback error (batched):', err.message]);
              }
            }
          }
        );

        // Merge translated text with original structure
        for (let i = 0; i < batch.length; i++) {
          const original = batch[i];
          const translated = translatedBatch[i] || {};

          // Clean translated text
          const cleanedText = this.cleanTranslatedText(translated.text || original.text);

          // Create entry with timing from AI when requested, otherwise preserve original timing
          const timecode = (this.sendTimestampsToAI && translated.timecode) ? translated.timecode : original.timecode;
          translatedEntries.push({
            id: original.id,
            timecode,
            text: cleanedText
          });
        }

        // Update the completed SRT snapshot for streaming optimization
        completedEntryCount = translatedEntries.length;
        completedSRT = toSRT(translatedEntries);

        // Progress callback after each batch
        if (typeof onProgress === 'function') {
          try {
            await onProgress({
              totalEntries: entries.length,
              completedEntries: translatedEntries.length,
              currentBatch: batchIndex + 1,
              totalBatches: batches.length,
              partialSRT: completedSRT
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

    // Final safety: strip any timecodes/timeranges that slipped through.
    // Skip in 'ai' mode — the SRT parser already extracts timecodes into entry.timecode,
    // and sanitizeTimecodes() is too aggressive for dialogue text (e.g. "Meet me at 12:30:00"
    // on its own line would be stripped as a standalone timestamp).
    if (this.translationWorkflow !== 'ai') {
      for (const entry of translatedEntries) {
        entry.text = this.sanitizeTimecodes(entry.text);
      }
    }

    // Step 5: Convert back to SRT format
    return toSRT(translatedEntries);
  }

  /**
   * Single-batch translation workflow with optional streaming partials
   */
  async translateSubtitleSingleBatch(entries, targetLanguage, customPrompt = null, onProgress = null) {
    log.info(() => `[TranslationEngine] Single-batch translation: ${entries.length} entries`);

    const fullBatchText = this.prepareBatchContent(entries, null);

    const promptForCache = this.createPromptForWorkflow(fullBatchText, targetLanguage, customPrompt, entries.length, null, 0, 1);

    let actualTokenCount = null;
    try {
      actualTokenCount = await this.gemini.countTokensForTranslation(fullBatchText, targetLanguage, promptForCache);
    } catch (err) {
      log.debug(() => ['[TranslationEngine] Single-batch token count failed, using estimate:', err.message]);
    }

    let estimatedTokens = actualTokenCount;
    if (!estimatedTokens) {
      try {
        const { userPrompt } = this.gemini.buildUserPrompt(fullBatchText, targetLanguage, promptForCache);
        estimatedTokens = this.safeEstimateTokens(userPrompt);
      } catch (estimateErr) {
        log.debug(() => ['[TranslationEngine] Single-batch prompt estimation failed, falling back:', estimateErr.message]);
        estimatedTokens = this.safeEstimateTokens(fullBatchText + (promptForCache || ''));
      }
    }

    // Dynamic chunk sizing: keep each chunk comfortably under the max token limit
    const softLimit = Math.max(1000, SINGLE_BATCH_TOKEN_SOFT_LIMIT);
    let chunkCount = Math.max(1, Math.ceil(estimatedTokens / softLimit));
    // Never create more chunks than entries (prevents empty chunks on tiny files)
    chunkCount = Math.min(chunkCount, Math.max(1, entries.length));

    if (chunkCount > 1) {
      const basis = actualTokenCount ? 'actual' : 'estimated';
      log.info(() => `[TranslationEngine] Single-batch token split: ${estimatedTokens} tokens (${basis}) -> ${chunkCount} chunks (limit ~${SINGLE_BATCH_MAX_TOKENS_PER_CHUNK}/chunk)`);
    }

    const chunks = chunkCount > 1 ? this.splitIntoChunks(entries, chunkCount) : [entries];
    const translatedEntries = [];
    // Track completed SRT from previous chunks so streaming partials include all progress
    let completedChunksSRT = '';
    let completedChunksEntryCount = 0;

    for (let batchIndex = 0; batchIndex < chunks.length; batchIndex++) {
      const batch = chunks[batchIndex];
      const useStreaming = chunkCount === 1 && this.enableStreaming;

      // Rotate API key for this batch if per-batch rotation is enabled
      this.maybeRotateKeyForBatch(batchIndex);

      // Preserve coherence when the "single-batch" path auto-splits by reusing the same context builder
      const context = this.enableBatchContext
        ? this.prepareContextForBatch(batch, entries, translatedEntries, batchIndex)
        : null;

      // Capture accumulated state for the streaming closure
      const prevSRT = completedChunksSRT;
      const prevEntryCount = completedChunksEntryCount;

      const translatedBatch = await this.translateBatch(
        batch,
        targetLanguage,
        customPrompt,
        batchIndex,
        chunks.length,
        context,
        {
          allowAutoChunking: false,
          streaming: useStreaming,
          onStreamProgress: async (payload) => {
            if (typeof onProgress === 'function' && payload?.partialSRT) {
              try {
                // Prepend completed chunks so the partial includes all translated entries
                const fullPartialSRT = prevSRT
                  ? prevSRT + '\n\n' + payload.partialSRT
                  : payload.partialSRT;
                await onProgress({
                  totalEntries: entries.length,
                  completedEntries: prevEntryCount + (payload.completedEntries || 0),
                  currentBatch: batchIndex + 1,
                  totalBatches: chunks.length,
                  partialSRT: fullPartialSRT,
                  streaming: true,
                  streamSequence: payload.streamSequence
                });
              } catch (err) {
                log.warn(() => ['[TranslationEngine] Streaming progress callback error:', err.message]);
              }
            }
          }
        }
      );

      // Merge translated text with original structure
      for (let i = 0; i < batch.length; i++) {
        const original = batch[i];
        const translated = translatedBatch[i] || {};

        const cleanedText = this.cleanTranslatedText(translated.text || original.text);
        const timecode = (this.sendTimestampsToAI && translated.timecode) ? translated.timecode : original.timecode;
        translatedEntries.push({
          id: original.id,
          timecode,
          text: cleanedText
        });
      }

      // Update accumulated SRT snapshot for next chunk's streaming closure
      completedChunksEntryCount = translatedEntries.length;
      completedChunksSRT = toSRT(translatedEntries);

      // Progress callback after each chunk
      if (typeof onProgress === 'function') {
        try {
          await onProgress({
            totalEntries: entries.length,
            completedEntries: translatedEntries.length,
            currentBatch: batchIndex + 1,
            totalBatches: chunks.length,
            partialSRT: completedChunksSRT
          });
        } catch (err) {
          log.warn(() => ['[TranslationEngine] Progress callback error (single-batch):', err.message]);
        }
      }
    }

    if (translatedEntries.length !== entries.length) {
      log.warn(() => `[TranslationEngine] Single-batch entry count mismatch: expected ${entries.length}, got ${translatedEntries.length}`);
    }

    // Skip sanitizeTimecodes in 'ai' mode — SRT parser already handles timecode extraction,
    // and the broad patterns would strip timecode-like dialogue text (e.g. "Meet me at 12:30:00").
    if (this.translationWorkflow !== 'ai') {
      for (const entry of translatedEntries) {
        entry.text = this.sanitizeTimecodes(entry.text);
      }
    }

    log.info(() => `[TranslationEngine] Single-batch translation completed: ${translatedEntries.length} entries (tokens: est ${estimatedTokens}${actualTokenCount ? `, actual ${actualTokenCount}` : ''})`);

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
   * Split entries into N roughly equal chunks
   */
  splitIntoChunks(entries, parts) {
    const chunks = [];
    const size = Math.ceil(entries.length / parts);
    for (let i = 0; i < entries.length; i += size) {
      chunks.push(entries.slice(i, i + size));
    }
    return chunks;
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
  async translateBatch(batch, targetLanguage, customPrompt, batchIndex, totalBatches, context = null, options = {}) {
    const opts = options || {};

    // Native batch providers (DeepL, Google Translate): send raw SRT directly,
    // skip numbered-list prompt construction and response parsing entirely.
    if (this.isNativeBatchProvider) {
      return this.translateBatchNative(batch, targetLanguage, batchIndex, totalBatches);
    }

    const allowAutoChunking = opts.allowAutoChunking !== false;
    const streamingRequested = opts.streaming && typeof this.gemini.streamTranslateSubtitle === 'function';
    const tryFallback = async (primaryError) => {
      if (!this.fallbackProvider) {
        return { handled: false, error: primaryError };
      }
      try {
        const translated = await this.fallbackProvider.translateSubtitle(
          batchText,
          'detected',
          targetLanguage,
          prompt
        );
        log.info(() => `[TranslationEngine] Fallback provider ${this.fallbackProviderName || 'secondary'} succeeded for batch ${batchIndex + 1}`);
        return { handled: true, text: translated };
      } catch (fallbackError) {
        const combined = new Error(`Primary (${this.providerName}) failed: ${primaryError.message || primaryError}\nSecondary (${this.fallbackProviderName || 'fallback'}) failed: ${fallbackError.message || fallbackError}`);
        combined.translationErrorType = 'MULTI_PROVIDER';
        combined.primaryError = primaryError;
        combined.secondaryError = fallbackError;
        combined.primaryProvider = this.providerName;
        combined.secondaryProvider = this.fallbackProviderName || 'fallback';
        return { handled: false, error: combined };
      }
    };
    // Prepare batch text (with context if provided)
    const batchText = this.prepareBatchContent(batch, context);

    const prompt = this.createPromptForWorkflow(batchText, targetLanguage, customPrompt, batch.length, context, batchIndex, totalBatches);

    // Check cache first (includes prompt variant so AI-mode differences are respected)
    const cacheResults = this.checkBatchCache(batch, targetLanguage, prompt);
    if (cacheResults.allCached) {
      return cacheResults.entries;
    }

    // Check if we need to split due to token limits
    let actualTokenCount = null;
    if (typeof this.gemini?.countTokensForTranslation === 'function') {
      try {
        actualTokenCount = await this.gemini.countTokensForTranslation(batchText, targetLanguage, prompt);
      } catch (err) {
        log.debug(() => ['[TranslationEngine] Token count check failed, using estimate:', err.message]);
      }
    }

    const estimatedTokens = actualTokenCount || this.safeEstimateTokens(batchText + prompt);

    // Sequence counter for streaming progress events (used by both auto-chunk and normal paths)
    let streamSequence = 0;

    if (allowAutoChunking && estimatedTokens > this.maxTokensPerBatch && batch.length > 1) {
      // Auto-chunk: Split batch in half recursively (sequential for memory safety)
      log.debug(() => `[TranslationEngine] Batch too large (${estimatedTokens}${actualTokenCount ? ' actual' : ' est.'} tokens), auto-chunking into 2 parts`);

      const midpoint = Math.floor(batch.length / 2);
      const firstHalf = batch.slice(0, midpoint);
      const secondHalf = batch.slice(midpoint);

      // Translate sequentially to avoid memory spikes
      // Note: Don't pass context to recursive calls - context already included in original batch text
      const firstTranslated = await this.translateBatch(firstHalf, targetLanguage, customPrompt, batchIndex, totalBatches, null, opts);

      // Emit streaming progress after first half completes so partial delivery picks it up
      if (typeof opts.onStreamProgress === 'function' && firstTranslated.length > 0) {
        const halfEntries = firstHalf.map((orig, i) => {
          const translated = firstTranslated[i] || {};
          return {
            id: orig.id,
            timecode: (this.sendTimestampsToAI && translated.timecode) ? translated.timecode : orig.timecode,
            text: this.cleanTranslatedText(translated.text || orig.text)
          };
        });
        const normalized = halfEntries.map((entry, idx) => ({ id: idx + 1, timecode: entry.timecode, text: entry.text }));
        try {
          await opts.onStreamProgress({
            partialSRT: toSRT(normalized),
            completedEntries: firstTranslated.length,
            totalEntries: batch.length,
            batchStartId: firstHalf[0]?.id || 1,
            batchEndId: firstHalf[firstHalf.length - 1]?.id || 1,
            currentBatch: batchIndex + 1,
            totalBatches,
            streaming: true,
            streamSequence: ++streamSequence
          });
        } catch (_) { }
      }

      const secondTranslated = await this.translateBatch(secondHalf, targetLanguage, customPrompt, batchIndex, totalBatches, null, opts);

      return [...firstTranslated, ...secondTranslated];
    }

    // Translate batch - with retry on PROHIBITED_CONTENT and MAX_TOKENS errors
    let translatedText;
    let prohibitedRetryAttempted = false;
    let maxTokensRetryAttempted = false;
    let httpRetryAttempted = false;

    // Build a streaming callback for reuse in retry paths (Bug 1 fix: retries preserve streaming)
    const streamCallback = streamingRequested ? async (partialText) => {
      if (typeof opts.onStreamProgress !== 'function') return;
      const payload = this.buildStreamingProgress(partialText, batch);
      if (!payload) return;
      payload.currentBatch = batchIndex + 1;
      payload.totalBatches = totalBatches;
      payload.streaming = true;
      payload.streamSequence = ++streamSequence;
      try {
        await opts.onStreamProgress(payload);
      } catch (err) {
        log.warn(() => ['[TranslationEngine] Stream progress handler failed:', err.message]);
      }
    } : null;

    try {
      translatedText = await this._translateCall(batchText, targetLanguage, prompt, streamingRequested, streamCallback);
    } catch (error) {
      // Track the error against the current key for health tracking
      if (this.retryRotationEnabled && this.gemini?.apiKey) {
        this._recordKeyError(this.gemini.apiKey);
      }

      // 429/503: rotate to next key and retry once (before other error-specific retries)
      if (this._isRetryableHttpError(error) && !httpRetryAttempted && this.retryRotationEnabled) {
        httpRetryAttempted = true;
        this._rotateToNextKey(`429/503 retry for batch ${batchIndex + 1}`);
        log.warn(() => `[TranslationEngine] 429/503 error detected, retrying batch ${batchIndex + 1} with next key`);

        try {
          translatedText = await this._translateCall(batchText, targetLanguage, prompt, streamingRequested, streamCallback);
          log.info(() => `[TranslationEngine] 429/503 key-rotation retry succeeded for batch ${batchIndex + 1}`);
        } catch (retryError) {
          if (this.retryRotationEnabled && this.gemini?.apiKey) {
            this._recordKeyError(this.gemini.apiKey);
          }
          log.warn(() => `[TranslationEngine] 429/503 key-rotation retry also failed for batch ${batchIndex + 1}: ${retryError.message}`);
          const fallbackResult = await tryFallback(error);
          if (fallbackResult.handled) {
            translatedText = fallbackResult.text;
          } else {
            throw fallbackResult.error;
          }
        }
      }
      // If MAX_TOKENS error and haven't retried yet, retry once
      else if (error.message && (error.message.includes('MAX_TOKENS') || error.message.includes('exceeded maximum token limit')) && !maxTokensRetryAttempted) {
        maxTokensRetryAttempted = true;
        this._rotateToNextKey(`MAX_TOKENS retry for batch ${batchIndex + 1}`);
        log.warn(() => `[TranslationEngine] MAX_TOKENS error detected, retrying batch ${batchIndex + 1} with next key`);

        try {
          translatedText = await this._translateCall(batchText, targetLanguage, prompt, streamingRequested, streamCallback);
          log.info(() => `[TranslationEngine] MAX_TOKENS retry succeeded for batch ${batchIndex + 1}`);
        } catch (retryError) {
          if (this.retryRotationEnabled && this.gemini?.apiKey) {
            this._recordKeyError(this.gemini.apiKey);
          }
          // Retry also failed, give up and throw the original error
          log.warn(() => `[TranslationEngine] MAX_TOKENS retry also failed for batch ${batchIndex + 1}: ${retryError.message}`);
          const fallbackResult = await tryFallback(error);
          if (fallbackResult.handled) {
            translatedText = fallbackResult.text;
          } else {
            throw fallbackResult.error; // Throw original/fallback-combined error
          }
        }
      }
      // If PROHIBITED_CONTENT error and haven't retried yet, retry with modified prompt
      else if (error.message && error.message.includes('PROHIBITED_CONTENT') && !prohibitedRetryAttempted) {
        prohibitedRetryAttempted = true;
        this._rotateToNextKey(`PROHIBITED_CONTENT retry for batch ${batchIndex + 1}`);
        log.warn(() => `[TranslationEngine] PROHIBITED_CONTENT detected, retrying batch with next key and modified prompt`);

        // Create modified prompt with disclaimer
        const modifiedPrompt = `YOU'RE TRANSLATING SUBTITLES - EVERYTHING WRITTEN BELOW IS FICTICIOUS\n\n${prompt}`;

        try {
          translatedText = await this._translateCall(batchText, targetLanguage, modifiedPrompt, streamingRequested, streamCallback);
          log.info(() => `[TranslationEngine] Retry with modified prompt succeeded for batch ${batchIndex + 1}`);
        } catch (retryError) {
          if (this.retryRotationEnabled && this.gemini?.apiKey) {
            this._recordKeyError(this.gemini.apiKey);
          }
          // Retry also failed, give up and throw the original error
          log.warn(() => `[TranslationEngine] Retry with modified prompt also failed: ${retryError.message}`);
          const fallbackResult = await tryFallback(error);
          if (fallbackResult.handled) {
            translatedText = fallbackResult.text;
          } else {
            throw fallbackResult.error; // Throw original/fallback-combined error
          }
        }
      } else {
        // Not a retryable error or already retried, throw as-is
        // If streaming returned nothing, fall back to non-streaming once
        const noStreamContent = error.message && (
          error.message.includes('No content returned from Gemini stream') ||
          error.message.includes('No content returned from stream')
        );
        if (streamingRequested && noStreamContent) {
          this._rotateToNextKey(`empty-stream retry for batch ${batchIndex + 1}`);
          log.warn(() => `[TranslationEngine] Stream returned no content for batch ${batchIndex + 1}, retrying without streaming with next key`);
          try {
            translatedText = await this.gemini.translateSubtitle(
              batchText,
              'detected',
              targetLanguage,
              prompt
            );
          } catch (nonStreamErr) {
            if (this.retryRotationEnabled && this.gemini?.apiKey) {
              this._recordKeyError(this.gemini.apiKey);
            }
            throw nonStreamErr;
          }
        } else {
          const fallbackResult = await tryFallback(error);
          if (fallbackResult.handled) {
            translatedText = fallbackResult.text;
          } else {
            throw fallbackResult.error;
          }
        }
      }
    }

    // Parse translated text back into entries
    let translatedEntries = this.parseResponseForWorkflow(translatedText, batch.length, batch);

    // Handle entry count mismatches with two-pass recovery
    if (translatedEntries.length !== batch.length) {
      log.warn(() => `[TranslationEngine] Entry count mismatch: expected ${batch.length}, got ${translatedEntries.length}`);

      // Pass 1: Align what we can by index, identify missing entries
      const { aligned, missingIndices } = this.alignTranslatedEntries(translatedEntries, batch);

      if (missingIndices.length > 0 && missingIndices.length <= Math.ceil(batch.length * 0.3)) {
        // Pass 2: Re-translate only the missing entries individually
        log.info(() => `[TranslationEngine] Two-pass recovery: ${missingIndices.length} missing entries, attempting targeted re-translation`);
        try {
          this._rotateToNextKey(`two-pass targeted retry for batch ${batchIndex + 1}`);
          const missingBatch = missingIndices.map(i => batch[i]);
          const missingText = this.prepareBatchContent(missingBatch, null);
          const missingPrompt = this.createPromptForWorkflow(missingText, targetLanguage, customPrompt, missingBatch.length, null, batchIndex, totalBatches);
          const retryText = await this._translateCall(missingText, targetLanguage, missingPrompt, false, null);
          const retryEntries = this.parseResponseForWorkflow(retryText, missingBatch.length, missingBatch);

          // Merge recovered entries back into aligned result
          // Use ID-based matching when available (JSON/XML parsers provide meaningful indices),
          // fall back to positional mapping for numbered-list responses
          const retryHasIds = retryEntries.some(e => typeof e.index === 'number' && e.index >= 0);
          if (retryHasIds && retryEntries.length === missingBatch.length) {
            // Map retry entry indices (0-based within the mini-batch) back to original batch positions
            for (let i = 0; i < retryEntries.length; i++) {
              const retryIdx = retryEntries[i].index;
              // retryIdx is relative to the mini-batch (0..missingBatch.length-1)
              if (retryIdx >= 0 && retryIdx < missingIndices.length) {
                const targetIdx = missingIndices[retryIdx];
                if (retryEntries[i].text) {
                  aligned[targetIdx] = {
                    index: targetIdx,
                    text: retryEntries[i].text,
                    timecode: retryEntries[i].timecode || (batch[targetIdx] ? batch[targetIdx].timecode : undefined)
                  };
                }
              }
            }
          } else {
            // Positional fallback: map sequentially
            for (let i = 0; i < missingIndices.length && i < retryEntries.length; i++) {
              const targetIdx = missingIndices[i];
              if (retryEntries[i] && retryEntries[i].text) {
                aligned[targetIdx] = {
                  index: targetIdx,
                  text: retryEntries[i].text,
                  timecode: retryEntries[i].timecode || (batch[targetIdx] ? batch[targetIdx].timecode : undefined)
                };
              }
            }
          }
          const stillMissing = missingIndices.filter(i => !aligned[i] || aligned[i].text.startsWith('[⚠]'));
          if (stillMissing.length > 0) {
            log.warn(() => `[TranslationEngine] Two-pass recovery: ${stillMissing.length} entries still missing after targeted retry`);
          } else {
            log.info(() => `[TranslationEngine] Two-pass recovery succeeded: all ${missingIndices.length} missing entries recovered`);
          }
        } catch (retryErr) {
          if (this.retryRotationEnabled && this.gemini?.apiKey) {
            this._recordKeyError(this.gemini.apiKey);
          }
          log.warn(() => `[TranslationEngine] Two-pass targeted retry failed: ${retryErr.message}`);
        }
        translatedEntries = Object.values(aligned).sort((a, b) => a.index - b.index);
      } else if (missingIndices.length > 0) {
        // Too many missing entries for targeted retry, fall back to full batch retry
        let retrySuccess = false;
        for (let retryAttempt = 0; retryAttempt < this.mismatchRetries; retryAttempt++) {
          log.info(() => `[TranslationEngine] Full batch retry ${retryAttempt + 1}/${this.mismatchRetries} (${missingIndices.length} missing entries too many for targeted recovery)`);
          try {
            this._rotateToNextKey(`full batch mismatch retry ${retryAttempt + 1} for batch ${batchIndex + 1}`);
            await new Promise(resolve => setTimeout(resolve, 500));
            const retryText = await this._translateCall(batchText, targetLanguage, prompt, false, null);
            const retryEntries = this.parseResponseForWorkflow(retryText, batch.length, batch);
            if (retryEntries.length === batch.length) {
              translatedEntries = retryEntries;
              retrySuccess = true;
              break;
            }
          } catch (retryErr) {
            if (this.retryRotationEnabled && this.gemini?.apiKey) {
              this._recordKeyError(this.gemini.apiKey);
            }
            log.warn(() => `[TranslationEngine] Full batch retry ${retryAttempt + 1} failed: ${retryErr.message}`);
          }
        }
        if (!retrySuccess) {
          // Use the aligned result with markers for missing entries
          translatedEntries = Object.values(aligned).sort((a, b) => a.index - b.index);
          const markedCount = translatedEntries.filter(e => e.text.startsWith('[⚠]')).length;
          if (markedCount > 0) {
            log.warn(() => `[TranslationEngine] Marked ${markedCount} entries as untranslated after all retries`);
          }
        }
      } else {
        // All entries aligned despite count mismatch (extras were trimmed)
        translatedEntries = Object.values(aligned).sort((a, b) => a.index - b.index);
      }
    }

    // Cache individual entries
    if (CACHE_TRANSLATIONS) {
      for (let i = 0; i < batch.length && i < translatedEntries.length; i++) {
        this.cacheEntry(batch[i].text, targetLanguage, translatedEntries[i].text, prompt);
      }
    }

    return translatedEntries;
  }

  /**
   * Translate a batch using a native (non-LLM) provider like DeepL or Google Translate.
   * Sends raw SRT directly — no numbered-list prompt, no response parsing overhead.
   */
  async translateBatchNative(batch, targetLanguage, batchIndex, totalBatches) {
    const srtContent = this.prepareBatchSrt(batch);

    log.debug(() => `[TranslationEngine] Native batch ${batchIndex + 1}/${totalBatches}: ${batch.length} entries via ${this.providerName}`);

    let translatedText;
    try {
      translatedText = await this.gemini.translateSubtitle(
        srtContent,
        'detected',
        targetLanguage,
        null
      );
    } catch (error) {
      if (this.fallbackProvider) {
        log.warn(() => `[TranslationEngine] Native provider ${this.providerName} failed, trying fallback: ${error.message}`);
        try {
          translatedText = await this.fallbackProvider.translateSubtitle(srtContent, 'detected', targetLanguage, null);
        } catch (fallbackError) {
          const combined = new Error(`Primary (${this.providerName}) failed: ${error.message}\nSecondary (${this.fallbackProviderName || 'fallback'}) failed: ${fallbackError.message}`);
          combined.translationErrorType = 'MULTI_PROVIDER';
          throw combined;
        }
      } else {
        throw error;
      }
    }

    // Parse the provider's response back into entries
    // Native providers return either SRT or numbered-list format
    let translatedEntries;
    const trimmed = String(translatedText || '').trim();

    if (trimmed.includes('-->')) {
      // Provider returned SRT — parse it directly
      translatedEntries = this.parseBatchSrtResponse(trimmed, batch.length, batch);
    } else {
      // Provider returned numbered list — parse that
      translatedEntries = this.parseBatchResponse(trimmed, batch.length);
    }

    // Handle count mismatches (no retries for native providers — they're deterministic)
    if (translatedEntries.length !== batch.length) {
      log.warn(() => `[TranslationEngine] Native batch entry mismatch: expected ${batch.length}, got ${translatedEntries.length}`);
      this.fixEntryCountMismatch(translatedEntries, batch, false);
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
   * Prepare batch text that includes timestamps (SRT format)
   * This is used when we trust the AI to preserve/repair timecodes.
   */
  prepareBatchSrt(batch) {
    const srtEntries = batch.map(entry => ({
      id: entry.id,
      timecode: entry.timecode,
      text: entry.text
    }));
    return toSRT(srtEntries).trim();
  }

  /**
   * Prepare batch text using XML tags for robust entry identification
   * Each entry is wrapped in <s id="N">...</s> tags
   */
  prepareBatchXml(batch, context = null) {
    let result = '';

    // Add context section if provided
    if (context && (context.surroundingOriginal?.length > 0 || context.previousTranslations?.length > 0)) {
      result += '=== CONTEXT (FOR REFERENCE ONLY - DO NOT TRANSLATE) ===\n\n';
      if (context.surroundingOriginal && context.surroundingOriginal.length > 0) {
        result += '--- Original Context (preceding entries) ---\n';
        context.surroundingOriginal.forEach((entry, index) => {
          const cleanText = entry.text.trim().replace(/\n+/g, '\n');
          result += `[Context ${index + 1}] ${cleanText}\n\n`;
        });
      }
      if (context.previousTranslations && context.previousTranslations.length > 0) {
        result += '--- Previous Translations (recently translated) ---\n';
        context.previousTranslations.forEach((entry, index) => {
          const cleanText = entry.text.trim().replace(/\n+/g, '\n');
          result += `[Translated ${index + 1}] ${cleanText}\n\n`;
        });
      }
      result += '=== END OF CONTEXT ===\n\n';
      result += '=== ENTRIES TO TRANSLATE ===\n\n';
    }

    const xmlEntries = batch.map((entry, index) => {
      const num = index + 1;
      const cleanText = entry.text.trim().replace(/\n+/g, '\n');
      return `<s id="${num}">${cleanText}</s>`;
    }).join('\n');

    result += xmlEntries;
    return result;
  }

  /**
   * Create translation prompt for XML-tagged batches
   */
  createXmlBatchPrompt(batchText, targetLanguage, customPrompt, expectedCount, context = null, batchIndex = 0, totalBatches = 1) {
    const targetLabel = normalizeTargetLanguageForPrompt(targetLanguage);
    const customPromptText = customPrompt ? customPrompt.replace('{target_language}', targetLabel) : '';

    let contextInstructions = '';
    if (context && (context.surroundingOriginal?.length > 0 || context.previousTranslations?.length > 0)) {
      contextInstructions = `
CONTEXT PROVIDED:
- Context entries are provided for reference to maintain coherence and consistency
- DO NOT translate context entries - they are for reference only
- ONLY translate entries inside <s id="N"> tags

`;
    }

    const promptBody = `You are translating subtitle text to ${targetLabel}.
${contextInstructions}
CRITICAL RULES:
1. Translate ONLY the text inside each <s id="N"> tag
2. PRESERVE the XML tags exactly: <s id="N">translated text</s>
3. Return EXACTLY ${expectedCount} tagged entries
4. Keep line breaks within each entry
5. Maintain natural dialogue flow for ${targetLabel}
6. Use appropriate colloquialisms for ${targetLabel}${context ? '\n7. Use the provided context to ensure consistency' : ''}

${customPromptText ? `ADDITIONAL INSTRUCTIONS:\n${customPromptText}\n\n` : ''}
Do NOT add acknowledgements, explanations, notes, or commentary.
Do not skip, merge, or split entries.
Do not include any timestamps/timecodes.

YOUR RESPONSE MUST:
- Start with <s id="1"> and end with </s> after entry ${expectedCount}
- Contain ONLY the XML-tagged translated entries

INPUT (${expectedCount} entries):

${batchText}

OUTPUT (EXACTLY ${expectedCount} XML-tagged entries):`;
    return this.addBatchHeader(promptBody, batchIndex, totalBatches);
  }

  /**
   * Fix #12: Build a clean prompt that uses XML as input format but requests JSON output.
   * This replaces the old fragile approach of regex-stripping XML output rules from the
   * XML prompt. By constructing the prompt from scratch, we avoid contradictory instructions
   * (e.g. "return XML tags" + "return JSON array") that confused the AI when the regex
   * cleanup failed due to minor prompt text changes.
   */
  _buildXmlInputJsonOutputPrompt(batchText, targetLanguage, customPrompt, expectedCount, context = null, batchIndex = 0, totalBatches = 1) {
    const targetLabel = normalizeTargetLanguageForPrompt(targetLanguage);
    const customPromptText = customPrompt ? customPrompt.replace('{target_language}', targetLabel) : '';

    let contextInstructions = '';
    if (context && (context.surroundingOriginal?.length > 0 || context.previousTranslations?.length > 0)) {
      contextInstructions = `
CONTEXT PROVIDED:
- Context entries are provided for reference to maintain coherence and consistency
- DO NOT translate context entries - they are for reference only
- ONLY translate entries inside <s id="N"> tags

`;
    }

    const promptBody = `You are translating subtitle text to ${targetLabel}.
${contextInstructions}
CRITICAL RULES:
1. Translate ONLY the text inside each <s id="N"> tag
2. Return EXACTLY ${expectedCount} entries
3. Keep line breaks within each entry
4. Maintain natural dialogue flow for ${targetLabel}
5. Use appropriate colloquialisms for ${targetLabel}${context ? '\n6. Use the provided context to ensure consistency' : ''}

${customPromptText ? `ADDITIONAL INSTRUCTIONS:\n${customPromptText}\n\n` : ''}
Do NOT add acknowledgements, explanations, notes, or commentary.
Do not skip, merge, or split entries.
Do not include any timestamps/timecodes.

YOUR RESPONSE MUST be a JSON array of objects with "id" (number, 1-indexed) and "text" (string) fields.
Example format: [{"id":1,"text":"translated text"},{"id":2,"text":"translated text"}]
Return ONLY the JSON array with EXACTLY ${expectedCount} entries, no other text.

INPUT (${expectedCount} entries):

${batchText}

OUTPUT (EXACTLY ${expectedCount} entries as JSON array):`;
    return this.addBatchHeader(promptBody, batchIndex, totalBatches);
  }

  /**
   * Parse XML-tagged translation response
   * Matches <s id="N">text</s> patterns and recovers entries by ID
   */
  parseXmlBatchResponse(translatedText, expectedCount) {
    let cleaned = String(translatedText || '').trim();
    // Remove markdown code blocks
    cleaned = cleaned.replace(/```[a-z]*(?:\r?\n)?/g, '');

    // Strip any trailing content after the last </s> tag.
    // AI models sometimes append commentary after the entries (e.g. "Hope this helps!").
    // This ensures the $ anchor in our lookahead matches correctly for the final entry.
    const lastClosingTag = cleaned.lastIndexOf('</s>');
    if (lastClosingTag !== -1) {
      cleaned = cleaned.slice(0, lastClosingTag + 4); // 4 = '</s>'.length
    }

    const entries = [];
    // Fix #13: Use a lazy quantifier with a lookahead to match up to the correct </s>.
    // The old lazy [\s\S]*? would terminate at the FIRST </s>, truncating entries whose
    // translated text contains literal "</s>" (e.g. HTML-like content). The lookahead
    // requires the closing </s> to be followed by either the next <s tag or end-of-string,
    // so inner "</s>" occurrences are skipped. Combined with the trailing-content strip
    // above, this correctly handles all edge cases.
    const xmlPattern = /<s\s+id\s*=\s*"?(\d+)"?\s*>([\s\S]*?)<\/s>(?=\s*(?:<s[\s>]|$))/gi;
    let match;
    while ((match = xmlPattern.exec(cleaned)) !== null) {
      const id = parseInt(match[1], 10);
      const text = match[2].trim();
      // Fix #14: Accept entries with empty text (legitimate for "♪", sound effects, etc.)
      // Only require a valid positive ID. Empty translations are preserved to avoid
      // count mismatches in fixEntryCountMismatch().
      if (id > 0) {
        entries.push({
          index: id - 1,
          text: text
        });
      }
    }

    // Sort by index and deduplicate (keep first occurrence per ID)
    const seen = new Set();
    const deduped = [];
    entries.sort((a, b) => a.index - b.index);
    for (const entry of entries) {
      if (!seen.has(entry.index)) {
        seen.add(entry.index);
        deduped.push(entry);
      }
    }

    return deduped;
  }


  /**
   * Route to the correct batch content preparation method based on workflow
   */
  prepareBatchContent(batch, context) {
    if (this.translationWorkflow === 'ai') {
      return this.prepareBatchSrt(batch);
    }
    if (this.translationWorkflow === 'xml') {
      return this.prepareBatchXml(batch, context);
    }
    return this.prepareBatchText(batch, context);
  }

  /**
   * Route to the correct prompt creation method based on workflow
   * When JSON output is enabled, wraps the prompt with JSON format instructions
   */
  createPromptForWorkflow(batchText, targetLanguage, customPrompt, expectedCount, context, batchIndex, totalBatches) {
    let basePrompt;
    if (this.translationWorkflow === 'ai') {
      basePrompt = this.createTimestampPrompt(targetLanguage, batchIndex, totalBatches);
    } else if (this.translationWorkflow === 'xml') {
      basePrompt = this.createXmlBatchPrompt(batchText, targetLanguage, customPrompt, expectedCount, context, batchIndex, totalBatches);
    } else {
      basePrompt = this.createBatchPrompt(batchText, targetLanguage, customPrompt, expectedCount, context, batchIndex, totalBatches);
    }

    // Wrap with JSON output instructions when enabled
    // For XML workflow: replace the XML output format with JSON (they're complementary —
    // XML controls how entries are *sent*, JSON controls how the AI *responds*)
    if (this.enableJsonOutput && this.translationWorkflow !== 'ai') {
      if (this.translationWorkflow === 'xml') {
        // Fix #12: Build the XML+JSON prompt cleanly instead of fragile regex surgery.
        // The old approach used lastIndexOf('YOUR RESPONSE MUST:') and brittle regexes
        // to strip XML-specific output rules — if the prompt text changed even slightly,
        // the cleanup would fail and the AI would get contradictory instructions (both
        // XML and JSON format). Instead, we rebuild the prompt from scratch, keeping
        // XML as the *input* format but requesting JSON as the *output* format.
        basePrompt = this._buildXmlInputJsonOutputPrompt(
          batchText, targetLanguage, customPrompt, expectedCount, context, batchIndex, totalBatches
        );
      } else {
        basePrompt += `\n\nIMPORTANT: Return your response as a JSON array of objects with "id" (number) and "text" (string) fields.
Example format: [{"id":1,"text":"translated text"},{"id":2,"text":"translated text"}]
Return ONLY the JSON array, no other text.`;
      }
    }

    return basePrompt;
  }

  /**
   * Route to the correct response parser based on workflow
   * When JSON output is enabled, attempts JSON parsing first with fallback
   */
  parseResponseForWorkflow(translatedText, expectedCount, batch) {
    // Try JSON parsing first when enabled
    if (this.enableJsonOutput && this.translationWorkflow !== 'ai') {
      const jsonEntries = this.parseJsonResponse(translatedText, expectedCount);
      if (jsonEntries && jsonEntries.length > 0) {
        return jsonEntries;
      }
      // JSON parsing failed — the response is likely JSON-shaped but malformed.
      // Before falling through to numbered-list/XML parsers (which can't parse JSON),
      // try one more extraction pass with the regex extractor directly on the raw text.
      const rawCleaned = String(translatedText || '').trim()
        .replace(/```json\s*/gi, '').replace(/```\s*/g, '');
      const regexEntries = this.extractJsonEntries(rawCleaned);
      if (regexEntries && regexEntries.length > 0) {
        const mapped = regexEntries.map(item => {
          const index = item.id >= 1 ? item.id - 1 : (item.id === 0 ? 0 : -1);
          return index >= 0 ? { index, text: String(item.text).trim() } : null;
        }).filter(Boolean);
        mapped.sort((a, b) => a.index - b.index);
        if (mapped.length > 0) {
          log.info(() => `[TranslationEngine] JSON fallback regex recovered ${mapped.length}/${expectedCount} entries from malformed response`);
          return mapped;
        }
      }
      log.warn(() => `[TranslationEngine] JSON parsing failed, falling back to standard parser`);
    }

    if (this.translationWorkflow === 'ai') {
      return this.parseBatchSrtResponse(translatedText, expectedCount, batch);
    }
    if (this.translationWorkflow === 'xml') {
      return this.parseXmlBatchResponse(translatedText, expectedCount);
    }
    return this.parseBatchResponse(translatedText, expectedCount);
  }

  /**
   * Parse JSON structured output response
   * Expects: [{"id": 1, "text": "translated"}, ...]
   * Includes repair logic for common LLM JSON mistakes.
   */
  parseJsonResponse(translatedText, expectedCount) {
    try {
      let cleaned = String(translatedText || '').trim();
      // Remove markdown code blocks
      cleaned = cleaned.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
      // Find the JSON array in the response
      const arrayStart = cleaned.indexOf('[');
      const arrayEnd = cleaned.lastIndexOf(']');
      if (arrayStart === -1 || arrayEnd === -1 || arrayEnd <= arrayStart) {
        return null;
      }
      cleaned = cleaned.slice(arrayStart, arrayEnd + 1);

      let parsed = null;

      // Attempt 1: direct parse
      try {
        parsed = JSON.parse(cleaned);
      } catch (_directErr) {
        // Attempt 2: repair common LLM JSON mistakes and retry
        parsed = this.repairAndParseJson(cleaned);
      }

      // Attempt 3: if full-array parse failed, extract individual objects via regex
      if (!parsed) {
        const extracted = this.extractJsonEntries(cleaned);
        if (extracted && extracted.length > 0) {
          log.debug(() => `[TranslationEngine] JSON repair: extracted ${extracted.length} entries via regex fallback`);
          parsed = extracted;
        }
      }

      if (!Array.isArray(parsed)) return null;

      const entries = [];
      for (const item of parsed) {
        if (item && typeof item.id === 'number' && typeof item.text === 'string') {
          // Accept both 0-indexed and 1-indexed IDs from the model
          const index = item.id >= 1 ? item.id - 1 : (item.id === 0 ? 0 : -1);
          if (index >= 0) {
            entries.push({
              index,
              text: item.text.trim()
            });
          }
        }
      }

      entries.sort((a, b) => a.index - b.index);

      if (entries.length === 0) return null;

      // Warn if the count doesn't match expectations (helps diagnose issues early)
      if (expectedCount && entries.length !== expectedCount) {
        log.debug(() => `[TranslationEngine] JSON response entry count: ${entries.length}, expected: ${expectedCount}`);
      }

      return entries;
    } catch (err) {
      log.debug(() => `[TranslationEngine] JSON response parse error: ${err.message}`);
      return null;
    }
  }

  /**
   * Attempt to repair common LLM JSON mistakes and parse.
   * Handles: trailing commas, missing commas between objects, unescaped newlines in strings,
   * single quotes instead of double quotes, unescaped control characters.
   * @returns {Array|null}
   */
  repairAndParseJson(jsonStr) {
    try {
      let repaired = jsonStr;

      // Fix unescaped newlines/tabs inside string values (between quotes)
      // Replace literal newlines/tabs inside JSON strings with escaped versions
      // Use [\s\S] to match across literal newlines within the string
      repaired = repaired.replace(/"((?:[^"\\]|\\[\s\S])*)"/g, (match) => {
        return match
          .replace(/(?<!\\)\t/g, '\\t')
          .replace(/\r\n/g, '\\n')
          .replace(/(?<!\\)\r/g, '\\n')
          .replace(/(?<!\\)\n/g, '\\n');
      });

      // Fix trailing commas before ] or }
      repaired = repaired.replace(/,\s*([\]}])/g, '$1');

      // Fix missing commas between objects: }{ or }\n{
      repaired = repaired.replace(/\}\s*\{/g, '},{');

      // Fix single quotes used as JSON delimiters (but not inside strings)
      // Only do this if there are no double-quoted strings (avoids breaking mixed content)
      if (!repaired.includes('"id"') && repaired.includes("'id'")) {
        repaired = repaired.replace(/'/g, '"');
      }

      const parsed = JSON.parse(repaired);
      if (Array.isArray(parsed)) {
        log.debug(() => `[TranslationEngine] JSON repair: successfully repaired and parsed`);
        return parsed;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Last-resort extraction: pull individual {"id":N,"text":"..."} objects from malformed JSON
   * using regex. Handles cases where the overall array structure is broken but individual
   * objects are valid.
   * @returns {Array|null}
   */
  extractJsonEntries(jsonStr) {
    const entries = [];
    // Match individual JSON objects with id and text fields
    // Handles both {"id":N,"text":"..."} and {"text":"...","id":N} orderings
    // Use [\s\S] instead of . to match across newlines in text values
    const objectPattern = /\{\s*"id"\s*:\s*(\d+)\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"\s*\}/g;
    const objectPatternAlt = /\{\s*"text"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"\s*,\s*"id"\s*:\s*(\d+)\s*\}/g;

    let match;
    while ((match = objectPattern.exec(jsonStr)) !== null) {
      const id = parseInt(match[1], 10);
      let text = match[2];
      try { text = JSON.parse(`"${text}"`); } catch (_) { /* use raw */ }
      if (id >= 0 && text !== undefined) {
        entries.push({ id, text: String(text) });
      }
    }

    // Also try alternate field ordering
    while ((match = objectPatternAlt.exec(jsonStr)) !== null) {
      const id = parseInt(match[2], 10);
      let text = match[1];
      try { text = JSON.parse(`"${text}"`); } catch (_) { /* use raw */ }
      // Avoid duplicates
      if (id >= 0 && text !== undefined && !entries.some(e => e.id === id)) {
        entries.push({ id, text: String(text) });
      }
    }

    return entries.length > 0 ? entries : null;
  }

  /**
   * Align translated entries to original batch by index, identifying missing entries
   * Used by two-pass mismatch recovery
   */
  alignTranslatedEntries(translatedEntries, originalBatch) {
    const aligned = {};
    const translatedMap = new Map();

    for (const entry of translatedEntries) {
      if (typeof entry.index === 'number' && !translatedMap.has(entry.index)) {
        translatedMap.set(entry.index, entry);
      }
    }

    const missingIndices = [];
    for (let i = 0; i < originalBatch.length; i++) {
      const existing = translatedMap.get(i);
      if (existing && existing.text) {
        aligned[i] = {
          index: i,
          text: existing.text,
          timecode: existing.timecode || undefined
        };
      } else {
        missingIndices.push(i);
        aligned[i] = {
          index: i,
          text: `[⚠] ${originalBatch[i].text}`,
          timecode: originalBatch[i].timecode || undefined
        };
      }
    }

    return { aligned, missingIndices };
  }

  /**
   * Create translation prompt for timestamp-aware batches
   */
  createTimestampPrompt(targetLanguage, batchIndex = 0, totalBatches = 1) {
    const targetLabel = normalizeTargetLanguageForPrompt(targetLanguage);
    const base = DEFAULT_TRANSLATION_PROMPT.replace('{target_language}', targetLabel);
    return this.addBatchHeader(base, batchIndex, totalBatches);
  }

  /**
   * Create translation prompt for a batch
   */
  createBatchPrompt(batchText, targetLanguage, customPrompt, expectedCount, context = null, batchIndex = 0, totalBatches = 1) {
    const targetLabel = normalizeTargetLanguageForPrompt(targetLanguage);
    const customPromptText = customPrompt ? customPrompt.replace('{target_language}', targetLabel) : '';

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

    const promptBody = `You are translating subtitle text to ${targetLabel}.
${contextInstructions}
CRITICAL RULES:
1. Translate ONLY the numbered text entries (1. 2. 3. etc.)
2. PRESERVE the numbering exactly (1. 2. 3. etc.)
3. Return EXACTLY ${expectedCount} numbered entries
4. Keep line breaks within each entry
5. Maintain natural dialogue flow for ${targetLabel}
6. Use appropriate colloquialisms for ${targetLabel}${context ? '\n7. Use the provided context to ensure consistency with previous translations' : ''}

${customPromptText ? `ADDITIONAL INSTRUCTIONS (from user/config):\n${customPromptText}\n\n` : ''}
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
    return this.addBatchHeader(promptBody, batchIndex, totalBatches);
  }

  /**
   * Prefix prompt with batch marker so the model knows which chunk it is handling
   */
  addBatchHeader(prompt, batchIndex, totalBatches) {
    const header = `BATCH ${batchIndex + 1}/${totalBatches}`;
    return `${header}\n\n${prompt}`;
  }

  /**
   * Build streaming progress payload from partial text
   */
  buildStreamingProgress(partialText, originalBatch = []) {
    if (!partialText) return null;

    const batchStartId = originalBatch?.[0]?.id || 1;
    const batchEndId = originalBatch?.[originalBatch.length - 1]?.id || batchStartId;

    let parsedEntries = [];

    // When JSON output is enabled, extract completed entries from partial JSON.
    // Use extractJsonEntries() directly instead of parseJsonResponse() because
    // streaming chunks are almost always incomplete JSON (e.g. [{"id":1,"text":"hello"},{"id":2,"te)
    // that will always fail JSON.parse(), generating noise in logs and wasting cycles.
    // The regex extractor reliably pulls out fully-formed {"id":N,"text":"..."} objects
    // from partial text without needing the overall array to be valid JSON.
    if (this.enableJsonOutput && this.translationWorkflow !== 'ai') {
      const rawCleaned = String(partialText).trim()
        .replace(/```json\s*/gi, '').replace(/```\s*/g, '');
      const extracted = this.extractJsonEntries(rawCleaned);
      if (extracted && extracted.length > 0) {
        parsedEntries = extracted.map(item => {
          const index = item.id >= 1 ? item.id - 1 : (item.id === 0 ? 0 : -1);
          return index >= 0 ? { index, text: String(item.text).trim() } : null;
        }).filter(Boolean);
      }
    }

    // Fall back to workflow-specific parsing if JSON didn't yield results
    if (parsedEntries.length === 0) {
      if (this.translationWorkflow === 'ai') {
        const parsed = parseSRT(partialText) || [];
        parsedEntries = parsed.map((entry, idx) => ({
          index: (typeof entry.id === 'number') ? entry.id - 1 : idx,
          text: (entry.text || '').trim(),
          timecode: entry.timecode || ''
        }));
      } else if (this.translationWorkflow === 'xml') {
        // Parse partial XML tags from streaming output
        const xmlPattern = /<s\s+id\s*=\s*"?(\d+)"?\s*>([\s\S]*?)<\/s>/gi;
        let match;
        while ((match = xmlPattern.exec(partialText)) !== null) {
          const id = parseInt(match[1], 10);
          const text = match[2].trim();
          if (id > 0 && text) {
            parsedEntries.push({ index: id - 1, text });
          }
        }
      } else {
        // Use the same robust parsing as parseBatchResponse:
        // line-by-line to handle multi-line entries, with context stripping and dedup
        let cleaned = partialText.trim();
        cleaned = cleaned.replace(/```[a-z]*(?:\r?\n)?/g, '');
        // Strip echoed context sections
        cleaned = cleaned.replace(/===\s*CONTEXT\s*\(FOR REFERENCE ONLY[^=]*===[\s\S]*?===\s*END OF CONTEXT\s*===/gi, '');
        cleaned = cleaned.replace(/===\s*ENTRIES TO TRANSLATE[^=]*===/gi, '');
        cleaned = cleaned.replace(/^---\s*(?:Original Context|Previous Translations)\s*.*---\s*$/gm, '');

        const lines = cleaned.split(/\r?\n/);
        let currentNum = null;
        let currentLines = [];

        for (const line of lines) {
          const headerMatch = line.match(/^(\d+)[.):\s-]+(.*)$/);
          if (headerMatch) {
            if (currentNum !== null && currentLines.length > 0) {
              const text = currentLines.join('\n').trim();
              if (text && !text.match(/^\[(?:Context|Translated)\s+\d+\]/i)) {
                parsedEntries.push({ index: currentNum - 1, text });
              }
            }
            currentNum = parseInt(headerMatch[1], 10);
            currentLines = [headerMatch[2]];
          } else if (currentNum !== null) {
            currentLines.push(line);
          }
        }
        if (currentNum !== null && currentLines.length > 0) {
          const text = currentLines.join('\n').trim();
          if (text && !text.match(/^\[(?:Context|Translated)\s+\d+\]/i)) {
            parsedEntries.push({ index: currentNum - 1, text });
          }
        }

        // Deduplicate by index (keep first occurrence)
        const seen = new Set();
        parsedEntries = parsedEntries.filter(entry => {
          if (seen.has(entry.index)) return false;
          seen.add(entry.index);
          return true;
        });
      }
    }

    if (!parsedEntries || parsedEntries.length === 0) {
      return null;
    }

    const merged = [];
    for (const entry of parsedEntries) {
      const original = originalBatch[entry.index];
      if (!original) continue;
      const cleanedText = this.cleanTranslatedText(entry.text || original.text);
      const timecode = (this.sendTimestampsToAI && entry.timecode) ? entry.timecode : original.timecode;
      merged.push({
        id: original.id,
        timecode,
        text: cleanedText
      });
    }

    if (merged.length === 0) return null;

    merged.sort((a, b) => a.id - b.id);
    const normalized = merged.map((entry, idx) => ({
      id: idx + 1,
      timecode: entry.timecode,
      text: entry.text
    }));

    return {
      partialSRT: toSRT(normalized),
      completedEntries: merged.length,
      totalEntries: originalBatch.length,
      batchStartId,
      batchEndId
    };
  }

  /**
   * Parse batch translation response when timestamps are included (expects SRT-like output)
   */
  parseBatchSrtResponse(translatedText, expectedCount, originalBatch = []) {
    const parsed = parseSRT(translatedText);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [];
    }

    // --- Fix #10: Use SRT IDs (1-based) to derive 0-based indices instead of array position.
    // This ensures that if the AI skips or reorders entries, translations are mapped to the
    // correct original entries rather than silently assigned by position.
    const entries = parsed.map((entry, idx) => ({
      index: (typeof entry.id === 'number' && entry.id >= 1) ? entry.id - 1 : idx,
      text: (entry.text || '').trim(),
      timecode: entry.timecode || ''
    }));

    // Deduplicate by index (keep first occurrence), matching the approach used by other parsers
    const seen = new Set();
    const deduped = [];
    for (const entry of entries) {
      if (!seen.has(entry.index)) {
        seen.add(entry.index);
        deduped.push(entry);
      }
    }

    // Don't fix count mismatches here — let the outer translateBatch handle retries first.
    // Only fill missing timecodes with originals to avoid gaps.
    for (const entry of deduped) {
      if (!entry.timecode && originalBatch[entry.index]) {
        entry.timecode = originalBatch[entry.index].timecode;
      }
    }

    return deduped;
  }

  /**
   * Parse batch translation response (numbered list mode)
   */
  parseBatchResponse(translatedText, expectedCount) {
    let cleaned = translatedText.trim();

    // Remove markdown code blocks
    cleaned = cleaned.replace(/```[a-z]*(?:\r?\n)?/g, '');

    // --- Fix #8: Strip context sections before parsing ---
    // Remove entire context blocks the AI may have echoed back
    cleaned = cleaned.replace(/===\s*CONTEXT\s*\(FOR REFERENCE ONLY[^=]*===[\s\S]*?===\s*END OF CONTEXT\s*===/gi, '');
    cleaned = cleaned.replace(/===\s*ENTRIES TO TRANSLATE[^=]*===/gi, '');
    // Remove stray context markers that may appear inline
    cleaned = cleaned.replace(/^---\s*(?:Original Context|Previous Translations)\s*.*---\s*$/gm, '');

    // --- Fix #6: Use a line-by-line approach instead of splitting on blank lines ---
    // This prevents multi-line translated entries with internal blank lines from being split apart.
    const lines = cleaned.split(/\r?\n/);
    const entries = [];
    let currentNum = null;
    let currentLines = [];

    for (const line of lines) {
      // Check if this line starts a new numbered entry
      const headerMatch = line.match(/^(\d+)[.):\s-]+(.*)$/);

      if (headerMatch) {
        // Save the previous entry if we had one
        if (currentNum !== null && currentLines.length > 0) {
          const text = currentLines.join('\n').trim();
          // --- Fix #8: Skip entries that are context markers ---
          if (text && !text.match(/^\[(?:Context|Translated)\s+\d+\]/i)) {
            entries.push({ index: currentNum - 1, text });
          }
        }
        // Start a new entry
        currentNum = parseInt(headerMatch[1]);
        currentLines = [headerMatch[2]];
      } else if (currentNum !== null) {
        // Continuation line (including blank lines) belongs to the current entry
        currentLines.push(line);
      }
      // Lines before the first numbered entry are ignored (preamble/context echoes)
    }

    // Don't forget the last entry
    if (currentNum !== null && currentLines.length > 0) {
      const text = currentLines.join('\n').trim();
      if (text && !text.match(/^\[(?:Context|Translated)\s+\d+\]/i)) {
        entries.push({ index: currentNum - 1, text });
      }
    }

    // --- Fix #7: Deduplicate by index (keep first occurrence, like XML parser) ---
    const seen = new Set();
    const deduped = [];
    entries.sort((a, b) => a.index - b.index);
    for (const entry of entries) {
      if (!seen.has(entry.index)) {
        seen.add(entry.index);
        deduped.push(entry);
      }
    }

    return deduped;
  }


  /**
   * Fix entry count mismatches by filling missing entries with original text
   */
  fixEntryCountMismatch(translatedEntries, originalBatch, preserveTimecodes = false) {
      if (translatedEntries.length === originalBatch.length) {
        return { hadMismatch: false, untranslatedIndices: [] };
      }

      const untranslatedIndices = [];

      if (translatedEntries.length < originalBatch.length) {
        // Missing entries - fill with original text marked as untranslated
        const translatedMap = new Map();
        for (const entry of translatedEntries) {
          translatedMap.set(entry.index, entry);
        }

        translatedEntries.length = 0;
        for (let i = 0; i < originalBatch.length; i++) {
          const existing = translatedMap.get(i);
          if (existing) {
            translatedEntries.push({
              index: i,
              text: existing.text,
              timecode: preserveTimecodes ? (existing.timecode || originalBatch[i].timecode) : existing.timecode
            });
          } else {
            untranslatedIndices.push(i);
            translatedEntries.push({
              index: i,
              text: `[⚠] ${originalBatch[i].text}`,
              timecode: preserveTimecodes ? originalBatch[i].timecode : undefined
            });
          }
        }
      } else {
        // Too many entries - keep only first N
        translatedEntries.length = originalBatch.length;
        for (let i = 0; i < translatedEntries.length; i++) {
          translatedEntries[i].index = i;
          if (preserveTimecodes && !translatedEntries[i].timecode && originalBatch[i]) {
            translatedEntries[i].timecode = originalBatch[i].timecode;
          }
        }
      }

      return { hadMismatch: true, untranslatedIndices };
    }

  /**
   * Clean translated text (remove timecodes, normalize line endings)
   */
  cleanTranslatedText(text) {
    let cleaned = String(text || '').trim();

    // Remove any embedded timecodes
    const timecodePattern = /\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}\s*\n?/g;
    cleaned = cleaned.replace(timecodePattern, '').trim();

    // Normalize line endings (CRLF → LF)
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // For RTL targets, wrap lines with embedding markers so punctuation renders on the correct side
    if (this.isRtlTarget) {
      cleaned = wrapRtlText(cleaned);
    }

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
   * Estimate token count with a safe fallback when provider doesn't expose it
   */
  safeEstimateTokens(text) {
    const content = String(text || '');
    if (typeof this.gemini?.estimateTokenCount === 'function') {
      try {
        const tokens = this.gemini.estimateTokenCount(content);
        if (Number.isFinite(tokens)) {
          return tokens;
        }
      } catch (err) {
        log.debug(() => ['[TranslationEngine] Token estimate failed, using fallback:', err.message]);
      }
    }
    // Rough heuristic: ~4 characters per token
    return Math.max(1, Math.ceil(content.length / 4));
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
