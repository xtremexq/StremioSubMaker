const OpenSubtitlesService = require('../services/opensubtitles');
const OpenSubtitlesV3Service = require('../services/opensubtitles-v3');
const SubDLService = require('../services/subdl');
const SubSourceService = require('../services/subsource');
const TranslationEngine = require('../services/translationEngine');
const { createTranslationProvider } = require('../services/translationProviderFactory');
const AniDBService = require('../services/anidb');
const KitsuService = require('../services/kitsu');
const MALService = require('../services/mal');
const AniListService = require('../services/anilist');
const animeIdResolver = require('../services/animeIdResolver');
const StremioCommunitySubtitlesService = require('../services/stremioCommunitySubtitles');
const WyzieSubsService = require('../services/wyzieSubs');
const SubsRoService = require('../services/subsRo');
const { parseSRT, toSRT, parseStremioId, appendHiddenInformationalNote, normalizeImdbId, ensureSRTForTranslation, convertToSRT } = require('../utils/subtitle');
const { getLanguageName, getDisplayName, toISO6391, toISO6392, canonicalSyncLanguageCode } = require('../utils/languages');
const { getTranslator } = require('../utils/i18n');
const { deriveVideoHash } = require('../utils/videoHash');
const { LRUCache } = require('lru-cache');
const syncCache = require('../utils/syncCache');
const streamActivity = require('../utils/streamActivity');
const embeddedCache = require('../utils/embeddedCache');
const smdbCache = require('../utils/smdbCache');
const { StorageFactory, StorageAdapter } = require('../storage');
const { getCached: getDownloadCached, saveCached: saveDownloadCached } = require('../utils/downloadCache');
const log = require('../utils/logger');
const { handleCaughtError } = require('../utils/errorClassifier');
const { isHearingImpairedSubtitle } = require('../utils/subtitleFlags');
const { generateCacheKeys } = require('../utils/cacheKeys');
const { deduplicateSubtitles, logDeduplicationStats } = require('../utils/subtitleDeduplication');
const { version } = require('../../package.json');
const { isProviderHealthy, circuitBreaker } = require('../utils/httpAgents');
const { getShared, setShared, incrementCounter, decrementCounter, getCounter, CACHE_PREFIXES, CACHE_TTLS } = require('../utils/sharedCache');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

// Initialize storage adapter (will be set on first use)
let storageAdapter = null;
async function getStorageAdapter() {
  if (!storageAdapter) {
    storageAdapter = await StorageFactory.getStorageAdapter();
  }
  return storageAdapter;
}

// Initialize anime ID mapping services
const anidbService = new AniDBService();
const kitsuService = new KitsuService();
const malService = new MALService();
const anilistService = new AniListService();

// Initialize offline anime ID resolver (Fribb/anime-lists, ~42k entries, O(1) lookups)
// This runs async but non-blocking — maps are available within ~200ms of startup
animeIdResolver.initialize().catch(err =>
  log.warn(() => `[Subtitles] Offline anime ID resolver failed to initialize: ${err.message}`)
);

// Redact/noise-reduce helper for logging large cache keys
function shortKey(v) {
  try {
    return crypto.createHash('sha1').update(String(v)).digest('hex').slice(0, 8);
  } catch (_) {
    const s = String(v || '');
    return s.length > 12 ? s.slice(0, 12) + 'â€¦' : s;
  }
}

/**
 * Convert subtitle content to SRT if forceSRTOutput is enabled
 * @param {string} content - Subtitle content (SRT, VTT, ASS, etc.)
 * @param {Object} config - User configuration
 * @returns {string} - SRT content if conversion enabled, original otherwise
 */
function maybeConvertToSRT(content, config) {
  if (!config?.forceSRTOutput || !content || typeof content !== 'string') {
    return content;
  }
  return convertToSRT(content, '[SRT Conversion]');
}

// MULTI-INSTANCE: User concurrency tracking moved to Redis for cross-pod enforcement
// Using atomic counters with TTL for automatic cleanup of orphaned counts
const USER_CONCURRENCY_PREFIX = 'user_translations:';
const USER_CONCURRENCY_TTL_SECONDS = 30 * 60; // 30 min TTL (safety net for orphaned counts)
const DEFAULT_MAX_CONCURRENT_TRANSLATIONS_PER_USER = 3;
const GEMMA_MAX_CONCURRENT_TRANSLATIONS_PER_USER = 2;

/**
 * Atomically increment user's concurrent translation count in Redis
 * @param {string} userHash - User config hash
 * @returns {Promise<number>} New count, or -1 on failure (allow translation as fallback)
 */
async function incrementUserConcurrency(userHash) {
  const effectiveUserHash = (userHash && userHash.length > 0) ? userHash : 'anonymous';
  const key = `${USER_CONCURRENCY_PREFIX}${effectiveUserHash}`;
  const newCount = await incrementCounter(key, USER_CONCURRENCY_TTL_SECONDS);
  if (newCount > 0) {
    log.debug(() => `[Concurrency] Incremented user ${effectiveUserHash} to ${newCount}`);
  }
  return newCount;
}

/**
 * Atomically decrement user's concurrent translation count in Redis
 * @param {string} userHash - User config hash
 * @returns {Promise<number>} New count, or -1 on failure
 */
async function decrementUserConcurrency(userHash) {
  const effectiveUserHash = (userHash && userHash.length > 0) ? userHash : 'anonymous';
  const key = `${USER_CONCURRENCY_PREFIX}${effectiveUserHash}`;
  const newCount = await decrementCounter(key);
  if (newCount >= 0) {
    log.debug(() => `[Concurrency] Decremented user ${effectiveUserHash} to ${newCount}`);
  }
  return newCount;
}

/**
 * Get current concurrent translation count for a user from Redis
 * @param {string} userHash - User config hash
 * @returns {Promise<number>} Current count (0 if not found or on error)
 */
async function getUserConcurrencyCount(userHash) {
  const effectiveUserHash = (userHash && userHash.length > 0) ? userHash : 'anonymous';
  const key = `${USER_CONCURRENCY_PREFIX}${effectiveUserHash}`;
  return await getCounter(key);
}

function resolveProviderConfig(config, key) {
  if (!config || !key) return null;
  const providers = config.providers || {};
  if (providers[key]) return providers[key];
  const match = Object.keys(providers).find(k => String(k).toLowerCase() === String(key).toLowerCase());
  return match ? providers[match] : null;
}

function resolveModelNameFromConfig(config) {
  if (!config) return '';
  const multiEnabled = config.multiProviderEnabled === true;
  const mainProvider = String(multiEnabled ? (config.mainProvider || 'gemini') : 'gemini').toLowerCase();
  if (mainProvider === 'gemini') {
    return config.geminiModel || '';
  }
  const providerConfig = resolveProviderConfig(config, mainProvider);
  return providerConfig?.model || '';
}

function getMaxConcurrentTranslationsForConfig(config) {
  const modelName = resolveModelNameFromConfig(config);
  if (String(modelName || '').toLowerCase().includes('gemma')) {
    return GEMMA_MAX_CONCURRENT_TRANSLATIONS_PER_USER;
  }
  return DEFAULT_MAX_CONCURRENT_TRANSLATIONS_PER_USER;
}

// Security: LRU cache for in-progress translations (max 500 entries)
// TTL aligned with inFlightTranslations (30 min) to prevent duplicate translations
// when status expires before the in-flight promise completes
const translationStatus = new LRUCache({
  max: 500,
  ttl: 30 * 60 * 1000, // 30 minutes (aligned with inFlightTranslations TTL)
  updateAgeOnGet: false,
});

// MULTI-INSTANCE: TMDB → IMDB mapping cache moved to Redis via PROVIDER_METADATA
// Key format: tmdb_imdb:{tmdbId}:{mediaType}
const TMDB_IMDB_CACHE_TTL_POSITIVE = 24 * 60 * 60; // 24 hours for successful lookups
const TMDB_IMDB_CACHE_TTL_NEGATIVE = 10 * 60;      // 10 minutes for failed lookups

// History metadata cache (title/season/episode) to avoid repeat Cinemeta lookups
const historyTitleCache = new LRUCache({
  max: 500,
  ttl: 24 * 60 * 60 * 1000, // 24 hours
  updateAgeOnGet: true
});

// Track subtitle source metadata (videoId/filename/title) by sourceFileId for history enrichment
const translationSourceMeta = new LRUCache({
  max: 5000,
  ttl: 6 * 60 * 60 * 1000, // 6 hours
  updateAgeOnGet: true
});

// Security: LRU cache for request deduplication for subtitle searches (max 200 entries)
const inFlightSearches = new LRUCache({
  max: 200,
  ttl: 5000, // 5 seconds
  updateAgeOnGet: false,
});

// Performance: LRU cache for completed subtitle search results
// Caches completed subtitle searches to avoid repeated API calls for identical queries
// This significantly reduces latency and API load for popular content (e.g., trending shows)
// IMPORTANT: Cache is user-scoped (includes config hash) to prevent cache sharing between different configs
// Environment variable configuration:
// - SUBTITLE_SEARCH_CACHE_MAX: Maximum number of cached searches (default: 15000)
// - SUBTITLE_SEARCH_CACHE_TTL_MS: Time-to-live in milliseconds (default: 600000 = 10 minutes)
const SUBTITLE_SEARCH_CACHE_MAX = parseInt(process.env.SUBTITLE_SEARCH_CACHE_MAX) || 5000;
const SUBTITLE_SEARCH_CACHE_TTL_MS = parseInt(process.env.SUBTITLE_SEARCH_CACHE_TTL_MS) || (10 * 60 * 1000); // 10 minutes

// Performance: Maximum time to wait for subtitle provider API responses
// After this timeout, we return whatever results are available from faster providers
// Set to 0 to disable timeout (wait for all providers indefinitely)
// Default: 7000ms (7 seconds) - balances speed vs coverage
const PROVIDER_SEARCH_TIMEOUT_MS = parseInt(process.env.PROVIDER_SEARCH_TIMEOUT_MS) || 15000;

const subtitleSearchResultsCache = new LRUCache({
  max: SUBTITLE_SEARCH_CACHE_MAX,
  ttl: SUBTITLE_SEARCH_CACHE_TTL_MS,
  updateAgeOnGet: true, // Popular content stays cached longer
});

// Security: In-flight translation requests to prevent duplicate translations (max 500 entries)
// Maps cacheKey -> Promise that all simultaneous requests will wait for
const inFlightTranslations = new LRUCache({
  max: 500,
  ttl: 30 * 60 * 1000, // 30 minutes
  updateAgeOnGet: false,
});

// Feature flag (default ON): allow permanent translation cache usage
const ENABLE_PERMANENT_TRANSLATIONS = process.env.ENABLE_PERMANENT_TRANSLATIONS !== 'false';
// Single shared prefix for the permanent translation cache (content-only)
const TRANSLATION_STORAGE_PREFIX = 't2s__';   // Shared across configs/users (content-only)
// Shared translation lock configuration (cross-instance in-flight awareness)
const SHARED_TRANSLATION_LOCK_PREFIX = 'translation_lock:';
const SHARED_TRANSLATION_LOCK_TTL_SECONDS = Math.max(
  60,
  parseInt(process.env.TRANSLATION_LOCK_TTL_SECONDS, 10) || (30 * 60)
); // default 30 minutes

function getTranslationStorageKey(cacheKey) {
  if (!cacheKey || typeof cacheKey !== 'string') return '';
  if (cacheKey.startsWith(TRANSLATION_STORAGE_PREFIX)) return cacheKey;
  return `${TRANSLATION_STORAGE_PREFIX}${cacheKey}`;
}

function isValidTranslationKey(cacheKey) {
  if (typeof cacheKey !== 'string' || cacheKey.length === 0) return false;
  return cacheKey.startsWith(TRANSLATION_STORAGE_PREFIX);
}

// Directory for persistent translation cache (disk-only)
const CACHE_DIR = path.join(__dirname, '..', '..', '.cache', 'translations');
// Directory for bypass translation cache (disk-only, TTL-based) - for user bypass cache config
const BYPASS_CACHE_DIR = path.join(__dirname, '..', '..', '.cache', 'translations_bypass');
// Directory for partial translation cache during chunking/streaming - separate from user config
const PARTIAL_CACHE_DIR = path.join(__dirname, '..', '..', '.cache', 'translations_partial');

// Security: Maximum cache size (50GB)
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024 * 1024; // 50GB

// Cache metrics for monitoring
const cacheMetrics = {
  hits: 0,
  misses: 0,
  diskReads: 0,
  diskWrites: 0,
  apiCalls: 0,
  estimatedCostSaved: 0, // in USD
  totalCacheSize: 0, // in bytes
  filesEvicted: 0,
  lastReset: Date.now()
};

// Single-batch streaming throttles (streaming providers)
const SINGLE_BATCH_LOG_ENTRY_INTERVAL = Math.max(1, parseInt(process.env.SINGLE_BATCH_LOG_ENTRY_INTERVAL, 10) || 100);
const SINGLE_BATCH_SRT_REBUILD_STEP_SMALL = Math.max(1, parseInt(process.env.SINGLE_BATCH_SRT_REBUILD_STEP_SMALL, 10) || 75);
const SINGLE_BATCH_SRT_REBUILD_STEP_LARGE = Math.max(1, parseInt(process.env.SINGLE_BATCH_SRT_REBUILD_STEP_LARGE, 10) || 100);
const SINGLE_BATCH_SRT_REBUILD_LARGE_THRESHOLD = Math.max(1, parseInt(process.env.SINGLE_BATCH_SRT_REBUILD_LARGE_THRESHOLD, 10) || 600);
const STREAM_FIRST_PARTIAL_MIN_ENTRIES = Math.max(1, parseInt(process.env.STREAM_FIRST_PARTIAL_MIN_ENTRIES, 10) || 30);
const INFO_SUBTITLE_NOTE_DEFAULT = 'This informational subtitle was generated by the addon.';
const DEFAULT_INVALID_SUBTITLE_REASON = 'The subtitle file appears to be invalid or incomplete.';

// Pad addon-generated subtitles so they aren't dropped by minimum-size heuristics
function ensureInformationalSubtitleSize(srt, note = null, uiLanguage = 'en') {
  try {
    const tInfo = getTranslator(uiLanguage || 'en');
    const resolvedNote = note
      || tInfo('subtitle.infoNote', {}, tInfo('subtitleErrors.addonInfoNote', {}, INFO_SUBTITLE_NOTE_DEFAULT));
    return appendHiddenInformationalNote(srt, resolvedNote);
  } catch (_) {
    return srt;
  }
}

// Resolve IMDB ID when only TMDB ID is available (Stremio can send tmdb:{id})
// MULTI-INSTANCE: Uses Redis-backed shared cache for cross-pod consistency
async function resolveImdbIdFromTmdb(videoInfo, stremioType) {
  if (!videoInfo || videoInfo.imdbId || !videoInfo.tmdbId) {
    return videoInfo ? videoInfo.imdbId : null;
  }

  // Infer media type
  const mediaType = (() => {
    if (videoInfo.tmdbMediaType === 'movie' || videoInfo.tmdbMediaType === 'tv') {
      return videoInfo.tmdbMediaType;
    }
    if (stremioType === 'series') return 'tv';
    if (stremioType === 'movie') return 'movie';
    if (videoInfo.type === 'episode' || videoInfo.type === 'anime-episode') return 'tv';
    return 'movie';
  })();

  const cacheKey = `${CACHE_PREFIXES.TMDB_IMDB}${videoInfo.tmdbId}:${mediaType}`;

  // Check Redis shared cache first
  try {
    const cached = await getShared(cacheKey, StorageAdapter.CACHE_TYPES.PROVIDER_METADATA);
    if (cached !== null) {
      log.debug(() => `[Subtitles] Redis cache hit for TMDB ${videoInfo.tmdbId}:${mediaType}`);
      // Handle cached null values (stored as 'null' string)
      if (cached === 'null') {
        return null;
      }
      videoInfo.imdbId = cached;
      return cached;
    }
  } catch (e) {
    log.debug(() => `[Subtitles] TMDB cache lookup failed: ${e.message}`);
  }

  try {
    log.debug(() => [`[Subtitles] Attempting TMDB \u2192 IMDB mapping`, { tmdbId: videoInfo.tmdbId, mediaType }]);

    const stremioTypesToTry = (() => {
      if (mediaType === 'movie') return ['movie'];
      if (mediaType === 'tv') return ['series'];
      return ['series', 'movie']; // fallback when unknown
    })();

    let mapped = null;

    // Step 1: Try Cinemeta first (Stremio's metadata addon)
    for (const stremioMetaType of stremioTypesToTry) {
      const url = `https://v3-cinemeta.strem.io/meta/${stremioMetaType}/tmdb:${videoInfo.tmdbId}.json`;
      try {
        log.debug(() => [`[Subtitles] Cinemeta lookup for TMDB ${videoInfo.tmdbId} (${stremioMetaType})`, url]);
        const response = await axios.get(url, { timeout: 8000 });
        const imdbId = response?.data?.meta?.imdb_id || response?.data?.meta?.imdbId;
        if (imdbId) {
          mapped = normalizeImdbId(imdbId);
          if (mapped) break;
        }
      } catch (err) {
        const status = err?.response?.status;
        if (status && status !== 404) {
          log.warn(() => [`[Subtitles] Cinemeta TMDB mapping error for ${videoInfo.tmdbId} (${stremioMetaType}):`, err.message]);
        } else {
          log.debug(() => [`[Subtitles] Cinemeta TMDB mapping miss for ${videoInfo.tmdbId} (${stremioMetaType})`]);
        }
      }
    }

    // Step 2: If Cinemeta failed, try Wikidata (free, no API key required)
    // Wikidata has TMDB property P4947 (film) and P5607 (TV series) mapped to IMDB P345
    if (!mapped) {
      log.debug(() => [`[Subtitles] Cinemeta miss, trying Wikidata fallback for TMDB ${videoInfo.tmdbId}`]);
      mapped = await queryWikidataTmdbToImdb(videoInfo.tmdbId, mediaType);
    }

    // Cache result in Redis
    const ttl = mapped ? TMDB_IMDB_CACHE_TTL_POSITIVE : TMDB_IMDB_CACHE_TTL_NEGATIVE;
    try {
      await setShared(cacheKey, mapped || 'null', StorageAdapter.CACHE_TYPES.PROVIDER_METADATA, ttl);
    } catch (_) { }

    if (mapped) {
      videoInfo.imdbId = mapped;
      log.info(() => [`[Subtitles] Mapped TMDB ${mediaType} ${videoInfo.tmdbId} to IMDB ${mapped}`]);
      return mapped;
    }

    log.warn(() => [`[Subtitles] Could not map TMDB ${mediaType} ${videoInfo.tmdbId} to IMDB`]);
    return null;
  } catch (error) {
    // Cache errors for 5min only
    try {
      await setShared(cacheKey, 'null', StorageAdapter.CACHE_TYPES.PROVIDER_METADATA, 5 * 60);
    } catch (_) { }
    log.error(() => [`[Subtitles] TMDB \u2192 IMDB mapping failed for ${videoInfo.tmdbId} (${mediaType}):`, error.message]);
    return null;
  }
}

/**
 * Query Wikidata to get IMDB ID from TMDB ID
 * Wikidata is completely free and requires no API key
 * Uses SPARQL query to find entities with both TMDB and IMDB IDs
 * @param {string} tmdbId - The TMDB ID to look up
 * @param {string} mediaType - 'movie' or 'tv'
 * @returns {Promise<string|null>} - IMDB ID if found, null otherwise
 */
async function queryWikidataTmdbToImdb(tmdbId, mediaType) {
  try {
    // Sanitize tmdbId: TMDB IDs must be numeric. Reject anything else to prevent SPARQL injection.
    if (!/^\d+$/.test(String(tmdbId))) {
      log.warn(() => `[Subtitles] Invalid TMDB ID format for Wikidata lookup: ${tmdbId}`);
      return null;
    }

    // Wikidata properties:
    // P4947 = TMDB movie ID
    // P5607 = TMDB TV series ID  
    // P345 = IMDB ID
    // Try both properties since sometimes the mediaType inference can be wrong
    const tmdbMovieProp = 'wdt:P4947';  // TMDB movie ID
    const tmdbTvProp = 'wdt:P5607';     // TMDB TV series ID
    const imdbProp = 'wdt:P345';        // IMDB ID

    // Build SPARQL query that tries both movie and TV properties
    // This handles cases where mediaType might be incorrectly inferred
    const sparqlQuery = `
      SELECT ?imdb WHERE {
        { ?item ${tmdbMovieProp} "${tmdbId}". }
        UNION
        { ?item ${tmdbTvProp} "${tmdbId}". }
        ?item ${imdbProp} ?imdb.
      } LIMIT 1
    `.trim().replace(/\s+/g, ' ');

    const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(sparqlQuery)}&format=json`;

    const response = await axios.get(url, {
      timeout: 8000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'StremioSubMaker/1.0 (subtitle addon; contact via GitHub)'
      }
    });

    const bindings = response?.data?.results?.bindings;
    if (bindings && bindings.length > 0 && bindings[0]?.imdb?.value) {
      const imdbId = bindings[0].imdb.value;
      log.info(() => [`[Subtitles] Wikidata found IMDB ${imdbId} for TMDB ${mediaType} ${tmdbId}`]);
      return normalizeImdbId(imdbId);
    }

    log.debug(() => [`[Subtitles] Wikidata has no mapping for TMDB ${mediaType} ${tmdbId}`]);
    return null;
  } catch (error) {
    // Don't log as error since Wikidata is a fallback - some content won't be there
    log.debug(() => [`[Subtitles] Wikidata lookup failed for TMDB ${tmdbId}:`, error.message]);
    return null;
  }
}

// Ensure a usable IMDB ID exists on videoInfo (maps TMDB when needed)
async function ensureImdbId(videoInfo, stremioType, logContext = 'Subtitles') {
  if (!videoInfo) return null;

  if (!videoInfo.imdbId && videoInfo.tmdbId) {
    await resolveImdbIdFromTmdb(videoInfo, stremioType);
  }

  if (!videoInfo.imdbId) {
    log.warn(() => [`[${logContext}] No IMDB ID available after parsing/mapping`, { tmdbId: videoInfo.tmdbId }]);
    return null;
  }

  return videoInfo.imdbId;
}

function getVideoCacheIdComponent(videoInfo) {
  if (videoInfo?.imdbId) return videoInfo.imdbId;
  if (videoInfo?.tmdbId) return `tmdb:${videoInfo.tmdbId}`;
  return 'unknown';
}

/**
 * Create a single-cue loading subtitle that explains partial loading
 * @returns {string} - SRT formatted loading subtitle
 */
function createLoadingSubtitle(uiLanguage = 'en') {
  const t = getTranslator(uiLanguage);
  const srt = `1
00:00:00,000 --> 04:00:00,000
${t('subtitle.loadingTitle', {}, 'TRANSLATION IN PROGRESS')}
${t('subtitle.loadingBody', {}, 'Click the same subtitle to reload. Partial results will appear as they are ready.')}`;

  // Log the loading subtitle for debugging
  log.debug(() => ['[Subtitles] Created loading subtitle with', srt.split('\n\n').length, 'entries']);
  return ensureInformationalSubtitleSize(srt, null, uiLanguage);
}

// Helpers to build partial SRT with an end-of-file warning block
function srtTimeToMs(t) {
  // t like HH:MM:SS,mmm
  const m = /^([0-9]{2}):([0-9]{2}):([0-9]{2}),([0-9]{3})$/.exec(String(t).trim());
  if (!m) return 0;
  const hh = parseInt(m[1], 10) || 0;
  const mm = parseInt(m[2], 10) || 0;
  const ss = parseInt(m[3], 10) || 0;
  const ms = parseInt(m[4], 10) || 0;
  return (((hh * 60 + mm) * 60) + ss) * 1000 + ms;
}

function msToSrtTime(ms) {
  ms = Math.max(0, Math.floor(ms));
  const hh = Math.floor(ms / 3600000); ms %= 3600000;
  const mm = Math.floor(ms / 60000); ms %= 60000;
  const ss = Math.floor(ms / 1000); const mmm = ms % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)},${String(mmm).padStart(3, '0')}`;
}

function buildPartialSrtWithTail(mergedSrt, uiLanguage = 'en') {
  const t = getTranslator(uiLanguage);
  try {
    if (!mergedSrt || typeof mergedSrt !== 'string' || mergedSrt.trim().length === 0) {
      return null; // Nothing to work with
    }

    const entries = parseSRT(mergedSrt);
    if (!entries || entries.length === 0) {
      // If we have raw text but no valid SRT entries yet, still return something
      // so users see progress instead of a loading screen
      // Append a loading indicator
      const lineCount = mergedSrt.split('\n').length + 10;
      return `${mergedSrt}\n\n${lineCount}\n00:00:00,000 --> 04:00:00,000\n${t('subtitle.loadingTitle', {}, 'TRANSLATION IN PROGRESS')}\n${t('subtitle.loadingTail', {}, 'Reload this subtitle to get more as translation gets ready.')}`;
    }

    const reindexed = entries.map((e, idx) => ({ id: idx + 1, timecode: e.timecode, text: (e.text || '').trim() }))
      .filter(e => e.timecode && e.text);

    if (reindexed.length === 0) {
      // No valid entries after filtering, but we have content - append loading tail
      const lineCount = mergedSrt.split('\n').length + 10;
      return `${mergedSrt}\n\n${lineCount}\n00:00:00,000 --> 04:00:00,000\n${t('subtitle.loadingTitle', {}, 'TRANSLATION IN PROGRESS')}\n${t('subtitle.loadingTail', {}, 'Reload this subtitle later to get more')}`;
    }

    const last = reindexed[reindexed.length - 1];
    let end = '00:00:00,000';
    if (last && typeof last.timecode === 'string') {
      const parts = last.timecode.split('-->');
      if (parts[1]) end = parts[1].trim();
    }
    // Ensure tail starts after last end with a small gap to prevent overlap on some players
    const tailStartMs = srtTimeToMs(end) + 1000;
    const tailStart = msToSrtTime(tailStartMs);
    const tail = {
      id: reindexed.length + 1,
      timecode: `${tailStart} --> 04:00:00,000`,
      text: `${t('subtitle.loadingTitle', {}, 'TRANSLATION IN PROGRESS')}\n${t('subtitle.loadingTail', {}, 'Reload this subtitle later to get more')}`
    };
    const full = [...reindexed, tail];
    return toSRT(full);
  } catch (e) {
    log.warn(() => `[Subtitles] Error building partial SRT with tail: ${e.message}`);
    // As fallback, if we have content, append a simple loading tail
    if (mergedSrt && typeof mergedSrt === 'string' && mergedSrt.trim().length > 0) {
      const lineCount = mergedSrt.split('\n').length + 10;
      return `${mergedSrt}\n\n${lineCount}\n00:00:00,000 --> 04:00:00,000\n${t('subtitle.loadingTitle', {}, 'TRANSLATION IN PROGRESS')}\n${t('subtitle.loadingTail', {}, 'Reload this subtitle later to get more')}`;
    }
    return null;
  }
}

/**
 * Create an error subtitle for session token not found
 * @param {string|null} regeneratedToken - Optional regenerated token for quick reinstall link
 * @param {string|null} baseUrl - Optional base URL for generating reinstall link
 * @returns {string} - SRT formatted error subtitle
 */
function createSessionTokenErrorSubtitle(regeneratedToken = null, baseUrl = null, uiLanguage = 'en') {
  const t = getTranslator(uiLanguage);
  let reinstallInstruction = t('subtitle.sessionErrorAdvice', {}, 'Please reconfig and reinstall the addon.');

  // If we have a regenerated token, provide a direct reinstall link
  if (regeneratedToken && baseUrl) {
    const reinstallUrl = `${baseUrl}/configure/${regeneratedToken}`;
    reinstallInstruction = `${t('subtitle.sessionErrorQuickFix', {}, 'Quick fix: Open this link to reinstall with fresh config:')}\n${reinstallUrl}`;
  } else if (regeneratedToken) {
    // Token available but no base URL - just mention the token
    reinstallInstruction = `${t('subtitle.sessionErrorToken', {}, 'A fresh config was created. Use this token to reinstall:')}\n${regeneratedToken}`;
  }

  const srt = `1
00:00:00,000 --> 00:00:03,000
${t('subtitle.sessionErrorTitle', {}, 'Configuration Error')}\n${t('subtitle.sessionErrorBody', {}, 'Your session token was not found or has expired.')}

2
00:00:03,001 --> 00:00:06,000
${reinstallInstruction}

3
00:00:06,001 --> 04:00:00,000
${t('subtitle.sessionErrorTitle', {}, 'Session Token Error')}\n${t('subtitle.sessionErrorFooter', {}, 'Something is wrong or an update broke your SubMaker config.\nSorry! Please reconfig and reinstall the addon.')}
`;

  return ensureInformationalSubtitleSize(srt, null, uiLanguage);
}

/**
 * Create an error subtitle for OpenSubtitles authentication failure
 * Single cue from 0 to 4h with 2 lines
 * @returns {string}
 */
function createOpenSubtitlesAuthErrorSubtitle(uiLanguage = 'en') {
  const t = getTranslator(uiLanguage);
  return ensureInformationalSubtitleSize(`1
00:00:00,000 --> 04:00:00,000
${t('subtitle.osAuthFailTitle', {}, 'OpenSubtitles login failed')}
${t('subtitle.osAuthFailBody', {}, 'Please fix your username/password in addon config')}`, null, uiLanguage);
}

/**
 * Create an error subtitle when credentials failed to decrypt (encryption key mismatch)
 * This happens when the server's encryption key changed or on multi-pod deployments
 * Single cue from 0 to 4h with helpful guidance
 * @param {string[]} failedFields - List of fields that failed to decrypt
 * @param {string} uiLanguage - UI language
 * @returns {string}
 */
function createCredentialDecryptionErrorSubtitle(failedFields = [], uiLanguage = 'en') {
  const t = getTranslator(uiLanguage);
  const fieldsList = failedFields.length > 0 ? failedFields.join(', ') : 'credentials';
  return ensureInformationalSubtitleSize(`1
00:00:00,000 --> 04:00:00,000
${t('subtitle.credDecryptFailTitle', {}, 'Configuration Issue Detected')}
${t('subtitle.credDecryptFailBody', { fields: fieldsList }, `Your ${fieldsList} could not be loaded properly.\\nThis can happen after server updates.\\nPlease re-enter your credentials in the addon config page.`)}`, null, uiLanguage);
}

/**
 * Create an error subtitle for OpenSubtitles daily quota exceeded (20 downloads/24h)
 * Single cue from 0 to 4h with concise guidance
 * @returns {string}
 */
function createOpenSubtitlesQuotaExceededSubtitle(uiLanguage = 'en') {
  const t = getTranslator(uiLanguage);
  return ensureInformationalSubtitleSize(`1
00:00:00,000 --> 04:00:00,000
${t('subtitle.osQuotaTitle', {}, 'OpenSubtitles daily download limit reached')}
${t('subtitle.osQuotaBody', {}, 'You have downloaded the allowed 20 subtitles in the last 24 hours.\nWait until UTC midnight (00:00) or change to V3 on config page.')}`, null, uiLanguage);
}

/**
 * Create an error subtitle when OpenSubtitles Auth is selected but credentials are missing
 * Single cue from 0 to 4h with concise guidance
 * @returns {string}
 */
function createOpenSubtitlesAuthMissingSubtitle(uiLanguage = 'en') {
  const t = getTranslator(uiLanguage);
  return ensureInformationalSubtitleSize(`1
00:00:00,000 --> 04:00:00,000
${t('subtitle.osAuthMissingTitle', {}, 'OpenSubtitles credentials required')}
${t('subtitle.osAuthMissingBody', {}, 'Add your OpenSubtitles username/password in the addon config or switch to V3 (no login needed).')}`, null, uiLanguage);
}

/**
 * Create a single-cue error subtitle for OpenSubtitles V3 rate limiting
 * @returns {string}
 */
function createOpenSubtitlesV3RateLimitSubtitle(uiLanguage = 'en') {
  const t = getTranslator(uiLanguage);
  return ensureInformationalSubtitleSize(`1
00:00:00,000 --> 04:00:00,000
${t('subtitle.osV3RateTitle', {}, 'OpenSubtitles V3 download error (429)')}
${t('subtitle.osV3RateBody', {}, 'Too many requests to the V3 service. Please wait a few minutes and try again.')}`, null, uiLanguage);
}

/**
 * Create a single-cue error subtitle for OpenSubtitles V3 temporary unavailability
 * @returns {string}
 */
function createOpenSubtitlesV3ServiceUnavailableSubtitle(uiLanguage = 'en') {
  const t = getTranslator(uiLanguage);
  return ensureInformationalSubtitleSize(`1
00:00:00,000 --> 04:00:00,000
${t('subtitle.osV3UnavailableTitle', {}, 'OpenSubtitles V3 download error (503)')}
${t('subtitle.osV3UnavailableBody', {}, 'Service temporarily unavailable. Try again in a few minutes.')}`, null, uiLanguage);
}

// Create a concise error subtitle when a source file looks invalid/corrupted
function createInvalidSubtitleMessage(reason = null, uiLanguage = 'en') {
  const t = getTranslator(uiLanguage);
  const resolvedReason = reason || t('subtitleErrors.invalidGenericReason', {}, DEFAULT_INVALID_SUBTITLE_REASON);
  const srt = `1
00:00:00,000 --> 00:00:03,000
${t('subtitle.invalidSubtitleTitle', {}, 'Subtitle Problem Detected')}

2
00:00:03,001 --> 04:00:18,000
${resolvedReason}\n${t('subtitle.translationUnexpected', {}, 'An error occurred during translation.')}\n${t('subtitle.translationRetry', {}, 'Please try again.')}`;
  return ensureInformationalSubtitleSize(srt, null, uiLanguage);
}

// Create a user-facing subtitle when a provider returns an unusable or missing file (e.g., HTML page, broken ZIP)
function createProviderDownloadErrorSubtitle(serviceName, reason, uiLanguage = 'en') {
  const t = getTranslator(uiLanguage);
  let srt = `1
00:00:00,000 --> 00:00:04,000
${t('subtitle.providerDownloadFailTitle', { service: serviceName }, `${serviceName} download failed`)}

2
00:00:04,001 --> 04:00:00,000
${t('subtitle.providerDownloadFailBody', { reason }, `${reason}\nTry a different subtitle or provider.`)}`;

  return ensureInformationalSubtitleSize(srt, 'This informational subtitle was generated by the addon to explain the failure.', uiLanguage);
}

// Create an SRT explaining concurrency limit reached, visible across the whole video timeline
function createConcurrencyLimitSubtitle(limit = DEFAULT_MAX_CONCURRENT_TRANSLATIONS_PER_USER, uiLanguage = 'en') {
  const t = getTranslator(uiLanguage);
  return ensureInformationalSubtitleSize(`1
00:00:00,000 --> 04:00:00,000
${t('subtitle.concurrencyLimitTitle', { limit }, `Too many concurrent translations for this user (limit: ${limit}).`)}
${t('subtitle.concurrencyLimitBody', {}, 'Please wait for one to finish, then try again.')}`, null, uiLanguage);
}

// Create an SRT explaining a translation error, visible across the whole video timeline
// User can click again to retry the translation
function createTranslationErrorSubtitle(errorType, errorMessage, uiLanguage = 'en', providerName = null) {
  const t = getTranslator(uiLanguage);
  const provider = String(providerName || '').trim().toLowerCase();
  // Determine error title based on type
  let errorTitle = t('subtitle.translationFailed', {}, 'Translation Failed');
  let errorExplanation = errorMessage || t('subtitle.translationUnexpected', {}, 'An unexpected error occurred during translation.');
  let retryAdvice = t('subtitle.translationRetry', {}, 'An unexpected error occurred.\nClick this subtitle again to retry translation.');

  if (errorType === '403') {
    errorTitle = t('subtitle.translationAuth', {}, 'Translation Failed: Authentication Error (403)');
    errorExplanation = t('subtitle.translationAuthBody', {}, 'Your Gemini API key is invalid or rejected.\nPlease check that your API key is correct.');
    retryAdvice = t('subtitle.translationAuthRetry', {}, 'Update your Gemini API key in the addon configuration,\nthen reinstall the addon and try again.');
  } else if (errorType === '503') {
    errorTitle = t('subtitle.translationOverload', {}, 'Translation Failed: Service Overloaded (503)');
    errorExplanation = t('subtitle.translationOverloadBody', {}, 'The Gemini API is temporarily overloaded with requests.\nThis is usually temporary and resolves within minutes.');
    retryAdvice = t('subtitle.translationOverloadRetry', {}, '(503) Service Unavailable - Wait a moment for Gemini to recover,\nthen click this subtitle again to retry translation.');
  } else if (errorType === '429') {
    if (provider === 'gemini') {
      return ensureInformationalSubtitleSize(`1
00:00:00,000 --> 04:00:00,000
${t('subtitle.translationRateLimitGeminiTitle', {}, 'Translation Failed: Usage Limit Reached (429)')}
${t('subtitle.translationRateLimitGeminiBody', {}, 'Check API Key limits or retry in a few minutes.')}`, null, uiLanguage);
    }
    if (provider === 'deepl') {
      return ensureInformationalSubtitleSize(`1
00:00:00,000 --> 04:00:00,000
${t('subtitle.translationRateLimitDeeplTitle', {}, 'Translation Failed: Usage Limit Reached (DeepL)')}
${t('subtitle.translationRateLimitDeeplBody', {}, 'DeepL API rate/quota limit reached. Please wait a few minutes and try again.')}`, null, uiLanguage);
    }
    errorTitle = t('subtitle.translationRateLimit', {}, 'Translation Failed: Usage Limit Reached (429)');
    errorExplanation = t('subtitle.translationRateLimitBody', {}, 'Your Gemini API usage limit has been exceeded.\nThis may be a rate limit or quota limit.');
    retryAdvice = t('subtitle.translationRateLimitRetry', {}, '(429) API Rate/Quota Limit - Gemini API is limiting your API key requests.\nWait a few minutes, then click again to retry.');
  } else if (errorType === 'MAX_TOKENS') {
    errorTitle = t('subtitle.translationTooLarge', {}, 'Translation Failed: Content Too Large');
    errorExplanation = t('subtitle.translationTooLargeBody', {}, 'The subtitle file is too large for a single translation.\nThe system attempted chunking but still exceeded limits.');
    retryAdvice = t('subtitle.translationTooLargeRetry', {}, '(MAX_TOKENS) Try translating a different subtitle file.\nAnother model may help. Please let us know if this persists.');
  } else if (errorType === 'SAFETY') {
    errorTitle = t('subtitle.translationFiltered', {}, 'Translation Failed: Content Filtered');
    errorExplanation = t('subtitle.translationFilteredBody', {}, 'The subtitle content was blocked by safety filters.\nThis is rare and usually a false positive.');
    retryAdvice = t('subtitle.translationFilteredRetry', {}, '(PROHIBITED_CONTENT) Subtitle content was filtered by Gemini.\nPlease retry, or try a different subtitle from the list.');
  } else if (errorType === 'PROHIBITED_CONTENT') {
    errorTitle = t('subtitle.translationFiltered', {}, 'Translation Failed: Content Filtered');
    errorExplanation = t('subtitle.translationFilteredBody', {}, 'The subtitle content was blocked by safety filters.\nThis is rare and usually a false positive.');
    retryAdvice = t('subtitle.translationFilteredRetry', {}, '(PROHIBITED_CONTENT) Subtitle content was filtered by Gemini.\nPlease retry, or try a different subtitle from the list.');
  } else if (errorType === 'INVALID_SOURCE') {
    errorTitle = t('subtitle.translationInvalidSource', {}, 'Translation Failed: Invalid Source File');
    errorExplanation = t('subtitle.translationInvalidSourceBody', {}, 'The source subtitle file appears corrupted or invalid.\nIt may be too small or have formatting issues.');
    retryAdvice = t('subtitle.translationInvalidSourceRetry', {}, '(CORRUPT_SOURCE) Please retry or try a different subtitle from the list.');
  } else if (errorType === 'MULTI_PROVIDER') {
    // Combined provider failure should be surfaced as a single-entry error for clarity
    const explanation = errorMessage || t('subtitle.translationMultiProvider', {}, 'Both the main and secondary providers failed to translate this batch.');
    return ensureInformationalSubtitleSize(`1
00:00:00,000 --> 04:00:00,000
${explanation}`, null, uiLanguage);
  } else if (errorType === 'other') {
    // Generic error - still provide helpful message with actual error
    errorTitle = t('subtitle.translationFailed', {}, 'Translation Failed: Unexpected Error');
    errorExplanation = errorMessage ? `Error: ${errorMessage}` : t('subtitle.translationUnexpected', {}, 'An unexpected error occurred during translation.');
    retryAdvice = t('subtitle.translationRetry', {}, 'Unexpected error.\nClick this subtitle again to retry.\nIf the problem persists, try a different subtitle, reinstall the addon or contact us.');
  }

  return ensureInformationalSubtitleSize(`1
00:00:00,000 --> 00:00:03,000
${errorTitle}

2
00:00:03,001 --> 00:00:06,000
${errorExplanation}

3
00:00:06,001 --> 04:00:00,000
${retryAdvice}`, null, uiLanguage);
}

/**
 * Check if a user can start a new translation without hitting the concurrency limit
 * MULTI-INSTANCE: Uses Redis-backed atomic counters for cross-pod enforcement
 * @param {string} userHash - The user's config hash (for per-user limit tracking)
 * @param {Object} config - Optional config to determine per-model limits
 * @returns {Promise<boolean>} - True if the user can start a translation, false if at the limit
 */
async function canUserStartTranslation(userHash, config = null) {
  const effectiveUserHash = (userHash && userHash.length > 0) ? userHash : 'anonymous';
  const currentCount = await getUserConcurrencyCount(effectiveUserHash);
  const limit = getMaxConcurrentTranslationsForConfig(config);
  const canStart = currentCount < limit;

  if (!canStart) {
    log.debug(() => `[ConcurrencyCheck] User ${effectiveUserHash} cannot start translation: ${currentCount}/${limit} concurrent translations already in progress`);
  }

  return canStart;
}

// Initialize cache directory
function initializeCacheDirectory() {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      log.debug(() => '[Cache] Created translation cache directory');
    }
    if (!fs.existsSync(BYPASS_CACHE_DIR)) {
      fs.mkdirSync(BYPASS_CACHE_DIR, { recursive: true });
      log.debug(() => '[Cache] Created bypass translation cache directory');
    }
  } catch (error) {
    log.error(() => ['[Cache] Failed to create cache directory:', error.message]);
  }
}

async function verifyCacheIntegrity() {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      return;
    }

    const files = await fs.promises.readdir(CACHE_DIR);
    let validCount = 0;
    let expiredCount = 0;
    let corruptCount = 0;
    const now = Date.now();

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const filePath = path.join(CACHE_DIR, file);
      try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        const cached = JSON.parse(content);

        if (cached.expiresAt && now > cached.expiresAt) {
          await fs.promises.unlink(filePath);
          expiredCount++;
        } else {
          validCount++;
        }
      } catch (error) {
        log.error(() => [`[Cache] Corrupt cache file ${file}:`, error.message]);
        try {
          await fs.promises.unlink(filePath);
          corruptCount++;
        } catch (_) {
          // Ignore deletion errors
        }
      }
    }

    log.debug(() => `[Cache] Integrity check: ${validCount} valid, ${expiredCount} expired (cleaned), ${corruptCount} corrupt (removed)`);
  } catch (error) {
    log.error(() => ['[Cache] Failed to verify cache integrity:', error.message]);
  }
}

async function verifyBypassCacheIntegrity() {
  try {
    if (!fs.existsSync(BYPASS_CACHE_DIR)) {
      return;
    }

    const files = await fs.promises.readdir(BYPASS_CACHE_DIR);
    let removedCount = 0;
    const now = Date.now();

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const filePath = path.join(BYPASS_CACHE_DIR, file);
      try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        const cached = JSON.parse(content);
        if (!cached.expiresAt || now > cached.expiresAt) {
          await fs.promises.unlink(filePath);
          removedCount++;
        }
      } catch (error) {
        try { await fs.promises.unlink(filePath); } catch (_) { }
      }
    }

    if (removedCount > 0) {
      log.debug(() => `[Bypass Cache] Cleaned ${removedCount} expired entries`);
    }
  } catch (error) {
    log.error(() => ['[Bypass Cache] Failed to verify/clean bypass cache:', error.message]);
  }
}

// One-time cleanup to remove legacy/unscoped permanent translation entries
async function purgeLegacyTranslationCacheEntries() {
  try {
    const adapter = await getStorageAdapter();
    const keys = await adapter.list(StorageAdapter.CACHE_TYPES.TRANSLATION);
    if (!Array.isArray(keys) || keys.length === 0) {
      return;
    }

    const allowedPrefixes = new Set([TRANSLATION_STORAGE_PREFIX]);
    let removed = 0;
    let retained = 0;

    for (const rawKey of keys) {
      const keyStr = String(rawKey || '');
      const hasAllowedPrefix = Array.from(allowedPrefixes).some(p => keyStr.startsWith(p));
      // Remove anything not in allowed namespaces
      if (!hasAllowedPrefix) {
        try {
          await adapter.delete(keyStr, StorageAdapter.CACHE_TYPES.TRANSLATION);
          removed++;
        } catch (err) {
          log.warn(() => ['[Cache] Failed to delete legacy translation key', keyStr, err.message]);
        }
      } else {
        retained++;
      }
    }

    log.debug(() => `[Cache] Legacy translation purge complete: removed=${removed}, retained=${retained}`);
  } catch (error) {
    log.error(() => ['[Cache] Failed legacy translation purge:', error.message]);
  }
}

// Sanitize cache key to prevent path traversal attacks
function sanitizeCacheKey(cacheKey) {
  // Remove any path traversal attempts
  let sanitized = cacheKey.replace(/\.\./g, '');
  // Remove path separators
  sanitized = sanitized.replace(/[/\\]/g, '_');
  // Only allow alphanumeric, underscore, and hyphen
  sanitized = sanitized.replace(/[^a-zA-Z0-9_-]/g, '_');
  // Limit length to prevent extremely long filenames
  if (sanitized.length > 200) {
    // Use hash for very long keys
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(cacheKey).digest('hex');
    sanitized = sanitized.substring(0, 150) + '_' + hash.substring(0, 16);
  }
  return sanitized;
}

function getSharedTranslationLockKey(cacheKey) {
  const safeKey = sanitizeCacheKey(cacheKey || '');
  return `${SHARED_TRANSLATION_LOCK_PREFIX}${safeKey}`;
}

async function markSharedTranslationInFlight(cacheKey, userHash) {
  if (!cacheKey) return;
  try {
    const adapter = await getStorageAdapter();
    const key = getSharedTranslationLockKey(cacheKey);
    const payload = {
      inProgress: true,
      startedAt: Date.now(),
      userHash: userHash || 'anonymous'
    };
    await adapter.set(key, payload, StorageAdapter.CACHE_TYPES.SESSION, SHARED_TRANSLATION_LOCK_TTL_SECONDS);
  } catch (error) {
    log.warn(() => ['[TranslationLock] Failed to mark shared in-flight translation:', error.message]);
  }
}

async function clearSharedTranslationInFlight(cacheKey) {
  if (!cacheKey) return;
  try {
    const adapter = await getStorageAdapter();
    const key = getSharedTranslationLockKey(cacheKey);
    await adapter.delete(key, StorageAdapter.CACHE_TYPES.SESSION);
  } catch (error) {
    log.warn(() => ['[TranslationLock] Failed to clear shared in-flight translation:', error.message]);
  }
}

async function isSharedTranslationInFlight(cacheKey) {
  if (!cacheKey) return null;
  try {
    const adapter = await getStorageAdapter();
    const key = getSharedTranslationLockKey(cacheKey);
    const lock = await adapter.get(key, StorageAdapter.CACHE_TYPES.SESSION);
    return lock || null;
  } catch (error) {
    log.warn(() => ['[TranslationLock] Failed to read shared in-flight translation state:', error.message]);
    return null;
  }
}

// Read translation from storage (async)
async function readFromStorage(cacheKey) {
  try {
    const namespacedKey = getTranslationStorageKey(cacheKey);
    if (!isValidTranslationKey(namespacedKey)) {
      log.warn(() => `[Cache] Skipping permanent cache read for invalid key=${shortKey(cacheKey)}`);
      return null;
    }

    const adapter = await getStorageAdapter();
    const cached = await adapter.get(namespacedKey, StorageAdapter.CACHE_TYPES.TRANSLATION);

    if (!cached) {
      return null;
    }

    cacheMetrics.diskReads++;
    return cached;
  } catch (error) {
    log.error(() => [`[Cache] Failed to read from storage for key ${cacheKey}:`, error.message]);
    return null;
  }
}

// DEPRECATED: Removed - use async readFromStorage() instead
// This function caused blocking I/O. Legacy code has been migrated.

// Read translation from bypass storage (async)
async function readFromBypassStorage(cacheKey) {
  try {
    const adapter = await getStorageAdapter();
    const cached = await adapter.get(cacheKey, StorageAdapter.CACHE_TYPES.BYPASS);

    if (!cached) {
      return null;
    }

    cacheMetrics.diskReads++;
    return cached;
  } catch (error) {
    log.error(() => [`[Bypass Cache] Failed to read from bypass storage for key ${cacheKey}:`, error.message]);
    return null;
  }
}

// DEPRECATED: Removed - use async readFromBypassStorage() instead
// This function caused blocking I/O. Legacy code has been migrated.

// Helper: calculate wait timeout for mobile mode (clamp to sensible range)
function getMobileWaitTimeoutMs(config) {
  const timeoutSeconds = parseInt(config?.advancedSettings?.translationTimeout) || 600;
  const clampedSeconds = Math.max(30, Math.min(timeoutSeconds, 300)); // at least 30s, cap at 5m
  return clampedSeconds * 1000;
}

// Helper: fetch final translation/error from cache respecting bypass isolation
async function getFinalCachedTranslation(storageKey, bypassKey, { bypass, bypassEnabled, userHash, allowPermanent, uiLanguage }) {
  const lang = uiLanguage || 'en';
  try {
    if (bypass && bypassEnabled) {
      const bypassCached = await readFromBypassStorage(bypassKey);
      if (bypassCached) {
        if (bypassCached.configHash && bypassCached.configHash !== userHash) {
          log.warn(() => `[Translation] Bypass cache configHash mismatch while waiting for final result key=${bypassKey}`);
          return null;
        } else if (!bypassCached.configHash) {
          log.warn(() => `[Translation] Bypass cache entry missing configHash while waiting for final result key=${bypassKey}`);
          return null;
        }
        if (bypassCached.isError === true) {
          return createTranslationErrorSubtitle(bypassCached.errorType, bypassCached.errorMessage, lang, bypassCached.errorProvider);
        }
        return bypassCached.content || bypassCached;
      }
    }

    if (allowPermanent && ENABLE_PERMANENT_TRANSLATIONS) {
      const cached = await readFromStorage(storageKey);
      if (cached) {
        if (cached.isError === true) {
          return createTranslationErrorSubtitle(cached.errorType, cached.errorMessage, lang, cached.errorProvider);
        }
        return cached.content || cached;
      }
    }
  } catch (error) {
    log.warn(() => [`[Translation] Failed to fetch final cached result for ${storageKey}:`, error.message]);
  }
  return null;
}

// Helper: wait for final translation to appear in cache (used for mobile mode)
async function waitForFinalCachedTranslation(storageKey, bypassKey, cacheOptions, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await getFinalCachedTranslation(storageKey, bypassKey, cacheOptions);
    if (result) {
      return result;
    }
    await new Promise(res => setTimeout(res, 5000));
  }
  return null;
}

// Save translation to storage (async)
async function saveToStorage(cacheKey, cachedData, { allowPermanent = true, ttl: overrideTtl } = {}) {
  try {
    if (!allowPermanent) {
      log.warn(() => `[Cache] Skipping permanent cache write (disabled) key=${shortKey(cacheKey)}`);
      return;
    }
    const namespacedKey = getTranslationStorageKey(cacheKey);
    if (!isValidTranslationKey(namespacedKey)) {
      log.warn(() => `[Cache] Skipping permanent cache write for invalid key=${shortKey(cacheKey)}`);
      return;
    }

    const adapter = await getStorageAdapter();
    // Allow callers (e.g. error caching) to override the default TTL
    const ttl = overrideTtl !== undefined ? overrideTtl : StorageAdapter.DEFAULT_TTL[StorageAdapter.CACHE_TYPES.TRANSLATION];
    await adapter.set(namespacedKey, cachedData, StorageAdapter.CACHE_TYPES.TRANSLATION, ttl);

    cacheMetrics.diskWrites++;
    log.debug(() => `[Cache] Saved translation to storage: ${namespacedKey} (expires: ${cachedData.expiresAt ? new Date(cachedData.expiresAt).toISOString() : 'never'})`);
  } catch (error) {
    log.error(() => ['[Cache] Failed to save translation to storage:', error.message]);
  }
}

// DEPRECATED: Removed - use async saveToStorage() instead
// This function caused blocking I/O. Legacy code has been migrated.

// Save translation to bypass storage (async)
async function saveToBypassStorage(cacheKey, cachedData) {
  try {
    const adapter = await getStorageAdapter();
    const ttl = StorageAdapter.DEFAULT_TTL[StorageAdapter.CACHE_TYPES.BYPASS];
    await adapter.set(cacheKey, cachedData, StorageAdapter.CACHE_TYPES.BYPASS, ttl);

    cacheMetrics.diskWrites++;
  } catch (error) {
    log.error(() => ['[Bypass Cache] Failed to save translation to bypass storage:', error.message]);
  }
}

// DEPRECATED: Removed - use async saveToBypassStorage() instead
// This function caused blocking I/O. Legacy code has been migrated.

// Save partial translation to storage (async)
async function saveToPartialStorage(cacheKey, cachedData) {
  try {
    const adapter = await getStorageAdapter();
    const ttl = StorageAdapter.DEFAULT_TTL[StorageAdapter.CACHE_TYPES.PARTIAL];
    await adapter.set(cacheKey, cachedData, StorageAdapter.CACHE_TYPES.PARTIAL, ttl);

    cacheMetrics.diskWrites++;
  } catch (error) {
    log.error(() => ['[Partial Cache] Failed to save partial translation to storage:', error.message]);
  }
}

// DEPRECATED: Removed - use async saveToPartialStorage() instead
// This function caused blocking I/O. Legacy code has been migrated.

// Async helper for saving partial translations
// No queue needed - storage adapter handles concurrency
async function saveToPartialCacheAsync(cacheKey, cachedData) {
  return saveToPartialStorage(cacheKey, cachedData);
}

// Read partial translation result during chunking/streaming (async)
async function readFromPartialCache(cacheKey) {
  try {
    const adapter = await getStorageAdapter();
    const cached = await adapter.get(cacheKey, StorageAdapter.CACHE_TYPES.PARTIAL);

    if (!cached) {
      return null;
    }

    cacheMetrics.diskReads++;
    return cached;
  } catch (error) {
    log.error(() => [`[Partial Cache] Failed to read from partial for key ${cacheKey}:`, error.message]);
    return null;
  }
}

// Calculate total cache size
async function calculateCacheSize() {
  try {
    try {
      await fs.promises.access(CACHE_DIR);
    } catch (_) {
      return 0; // Directory does not exist
    }

    const files = await fs.promises.readdir(CACHE_DIR);
    let totalSize = 0;

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const filePath = path.join(CACHE_DIR, file);
        const stats = await fs.promises.stat(filePath);
        totalSize += stats.size;
      } catch (_) {
        // Ignore errors for individual files
      }
    }

    return totalSize;
  } catch (error) {
    log.error(() => ['[Cache] Failed to calculate cache size:', error.message]);
    return 0;
  }
}

async function enforceCacheSizeLimit() {
  try {
    try {
      await fs.promises.access(CACHE_DIR);
    } catch (_) {
      return; // Directory does not exist
    }

    const totalSize = await calculateCacheSize();
    cacheMetrics.totalCacheSize = totalSize;

    if (totalSize <= MAX_CACHE_SIZE_BYTES) {
      return; // Within limit
    }

    log.debug(() => `[Cache] Cache size (${(totalSize / 1024 / 1024 / 1024).toFixed(2)}GB) exceeds limit (${(MAX_CACHE_SIZE_BYTES / 1024 / 1024 / 1024).toFixed(2)}GB), performing LRU eviction`);

    const files = await fs.promises.readdir(CACHE_DIR);
    const fileStats = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const filePath = path.join(CACHE_DIR, file);
        const stats = await fs.promises.stat(filePath);
        fileStats.push({
          path: filePath,
          atime: stats.atime.getTime(),
          size: stats.size
        });
      } catch (_) {
        // Ignore errors for individual files
      }
    }

    fileStats.sort((a, b) => a.atime - b.atime);

    let currentSize = totalSize;
    let evictedCount = 0;

    for (const file of fileStats) {
      if (currentSize <= MAX_CACHE_SIZE_BYTES * 0.9) {
        break;
      }

      try {
        await fs.promises.unlink(file.path);
        currentSize -= file.size;
        evictedCount++;
        cacheMetrics.filesEvicted++;
      } catch (error) {
        log.error(() => [`[Cache] Failed to evict file ${file.path}:`, error.message]);
      }
    }

    log.debug(() => `[Cache] LRU eviction complete: removed ${evictedCount} files, new size: ${(currentSize / 1024 / 1024 / 1024).toFixed(2)}GB`);
    cacheMetrics.totalCacheSize = currentSize;
  } catch (error) {
    log.error(() => ['[Cache] Failed to enforce cache size limit:', error.message]);
  }
}

// Log cache metrics periodically
async function logCacheMetrics() {
  const uptime = Math.floor((Date.now() - cacheMetrics.lastReset) / 1000 / 60); // minutes
  const hitRate = cacheMetrics.hits + cacheMetrics.misses > 0
    ? ((cacheMetrics.hits / (cacheMetrics.hits + cacheMetrics.misses)) * 100).toFixed(1)
    : 0;
  const cacheSizeGB = (cacheMetrics.totalCacheSize / 1024 / 1024 / 1024).toFixed(2);

  log.debug(() => `[Cache Metrics] Uptime: ${uptime}m | Hits: ${cacheMetrics.hits} | Misses: ${cacheMetrics.misses} | Hit Rate: ${hitRate}% | Disk R/W: ${cacheMetrics.diskReads}/${cacheMetrics.diskWrites} | API Calls: ${cacheMetrics.apiCalls} | Est. Cost Saved: $${cacheMetrics.estimatedCostSaved.toFixed(3)} | Cache Size: ${cacheSizeGB}GB | Evicted: ${cacheMetrics.filesEvicted}`);

  // Also snapshot session namespace so Redis SCAN output includes sessions alongside other caches
  try {
    const adapter = await getStorageAdapter();
    if (adapter && typeof adapter.list === 'function') {
      await adapter.list(StorageAdapter.CACHE_TYPES.SESSION, '*');
    }
  } catch (err) {
    log.warn(() => `[Cache Metrics] Failed to list sessions for diagnostics: ${err?.message || err}`);
  }
}

// Initialize cache on module load
initializeCacheDirectory();
(async () => { try { await verifyCacheIntegrity(); } catch (err) { log.error(() => ['[Cache] Async integrity check failed:', err.message]); } })();
(async () => { try { await verifyBypassCacheIntegrity(); } catch (err) { log.error(() => ['[Bypass Cache] Async integrity check failed:', err.message]); } })();
(async () => { try { await purgeLegacyTranslationCacheEntries(); } catch (err) { log.error(() => ['[Cache] Legacy translation purge failed:', err.message]); } })();
(async () => {
  try {
    cacheMetrics.totalCacheSize = await calculateCacheSize();
    log.debug(() => `[Cache] Initial cache size: ${(cacheMetrics.totalCacheSize / 1024 / 1024 / 1024).toFixed(2)}GB`);
  } catch (err) {
    log.error(() => ['[Cache] Failed to measure initial cache size:', err.message]);
  }
})();

// If async measurement hasn't finished yet, keep a conservative default
if (!cacheMetrics.totalCacheSize) {
  cacheMetrics.totalCacheSize = 0;
}

// Log subtitle search cache configuration
log.debug(() => `[Subtitle Search Cache] Initialized: max=${SUBTITLE_SEARCH_CACHE_MAX} entries, ttl=${Math.floor(SUBTITLE_SEARCH_CACHE_TTL_MS / 1000 / 60)}min, user-scoped=true`);

// Log metrics every 30 minutes
setInterval(logCacheMetrics, 1000 * 60 * 30);

// Enforce cache size limit every 10 minutes (async)
setInterval(() => {
  enforceCacheSizeLimit().catch(err => log.error(() => ['[Cache] Failed in scheduled size enforcement:', err.message]));
}, 1000 * 60 * 10);
// Cleanup bypass cache periodically (async)
setInterval(() => {
  verifyBypassCacheIntegrity().catch(err => log.error(() => ['[Bypass Cache] Scheduled cleanup failed:', err.message]));
}, 1000 * 60 * 30);

/**
 * Deduplicates subtitle search requests by caching in-flight promises and completed results
 * @param {string} key - Unique key for the request
 * @param {Function} fn - Function to execute if not already in flight or cached
 * @returns {Promise} - Promise result
 */
// Minimum number of subtitles required to use cached results
// If cache has fewer results, we skip it and do a fresh search
const MIN_CACHED_SUBTITLES_THRESHOLD = 3;

async function deduplicateSearch(key, fn) {
  // Check completed results cache first (persistent cache)
  const cachedResult = subtitleSearchResultsCache.get(key);
  if (cachedResult) {
    // Skip cache if results are too sparse - do a fresh search instead
    if (cachedResult.length < MIN_CACHED_SUBTITLES_THRESHOLD) {
      log.debug(() => `[Subtitle Cache] Found cached search results for: ${shortKey(key)} (${cachedResult.length} subtitles) - too few, skipping cache`);
      subtitleSearchResultsCache.delete(key); // Remove sparse cache entry
    } else {
      log.debug(() => `[Subtitle Cache] Found cached search results for: ${shortKey(key)} (${cachedResult.length} subtitles)`);
      return cachedResult;
    }
  }

  // Check in-flight requests (prevents duplicate API calls for concurrent requests)
  const cached = inFlightSearches.get(key);
  if (cached) {
    log.debug(() => `[Dedup] Subtitle search already in flight: ${shortKey(key)}`);
    return cached.promise;
  }

  log.debug(() => `[Dedup] Processing new subtitle search: ${shortKey(key)}`);
  const promise = fn();

  inFlightSearches.set(key, { promise });

  try {
    const result = await promise;
    // Cache the completed result for future requests (only if enough results)
    if (result && Array.isArray(result)) {
      if (result.length >= MIN_CACHED_SUBTITLES_THRESHOLD) {
        subtitleSearchResultsCache.set(key, result);
        log.debug(() => `[Subtitle Cache] Cached search results for: ${shortKey(key)} (${result.length} subtitles)`);
      } else {
        log.debug(() => `[Subtitle Cache] Not caching sparse results for: ${shortKey(key)} (${result.length} subtitles < ${MIN_CACHED_SUBTITLES_THRESHOLD})`);
      }
    }
    return result;
  } finally {
    inFlightSearches.delete(key);
  }
}

/**
 * Extract quality tier and release group from filename
 * @param {string} filename - The filename to parse
 * @returns {Object} - Object with quality tier, resolution, codec, and release group
 */
function parseReleaseMetadata(filename) {
  const lower = filename.toLowerCase();

  // Resolution detection (highest priority for sync)
  let resolution = null;
  if (lower.includes('4k') || lower.includes('2160p')) resolution = '4k';
  else if (lower.includes('1080p')) resolution = '1080p';
  else if (lower.includes('720p')) resolution = '720p';
  else if (lower.includes('480p')) resolution = '480p';
  else if (lower.includes('360p')) resolution = '360p';

  // Rip type detection (CRITICAL for sync - different rips have different timing)
  // More specific types = lower tier number = higher priority
  let ripType = null;
  let ripTier = 0;

  // Web sources (most common, best quality for recent content)
  if (lower.includes('web-dl') || lower.includes('webdl')) {
    ripType = 'web-dl';
    ripTier = 1;
  } else if (lower.includes('webrip')) {
    ripType = 'webrip';
    ripTier = 2;
  } else if (lower.includes('web')) {
    ripType = 'web';
    ripTier = 3;
  }
  // Blu-ray sources (high quality, scene releases)
  else if (lower.includes('bluray') || lower.includes('blu-ray')) {
    ripType = 'bluray';
    ripTier = 4;
  } else if (lower.includes('bdrip') || lower.includes('brrip')) {
    ripType = 'bdrip';
    ripTier = 5;
  } else if (lower.includes('bdremux') || lower.includes('bd-remux')) {
    ripType = 'bdremux';
    ripTier = 4;
  }
  // TV sources
  else if (lower.includes('hdtv')) {
    ripType = 'hdtv';
    ripTier = 6;
  } else if (lower.includes('pdtv')) {
    ripType = 'pdtv';
    ripTier = 7;
  }
  // DVD sources
  else if (lower.includes('dvdrip')) {
    ripType = 'dvdrip';
    ripTier = 8;
  } else if (lower.includes('dvdscr')) {
    ripType = 'dvdscr';
    ripTier = 10;
  }
  // Lower quality sources
  else if (lower.includes('hdrip')) {
    ripType = 'hdrip';
    ripTier = 9;
  } else if (lower.includes('cam') || lower.includes('camrip')) {
    ripType = 'cam';
    ripTier = 12;
  } else if (lower.includes('telesync') || lower.includes('ts')) {
    ripType = 'telesync';
    ripTier = 11;
  } else if (lower.includes('screener') || lower.includes('scr')) {
    ripType = 'screener';
    ripTier = 10;
  }

  // Video codec detection
  let codec = null;
  if (lower.includes('x265') || lower.includes('h.265') || lower.includes('h265') || lower.includes('hevc')) codec = 'x265';
  else if (lower.includes('x264') || lower.includes('h.264') || lower.includes('h264') || lower.includes('avc')) codec = 'x264';
  else if (lower.includes('xvid')) codec = 'xvid';
  else if (lower.includes('av1')) codec = 'av1';

  // Audio codec detection (helps differentiate releases)
  let audio = null;
  if (lower.includes('atmos')) audio = 'atmos';
  else if (lower.includes('truehd')) audio = 'truehd';
  else if (lower.includes('dts-hd') || lower.includes('dtshd')) audio = 'dts-hd';
  else if (lower.includes('dts')) audio = 'dts';
  else if (lower.includes('dd5.1') || lower.includes('dd51') || lower.includes('ac3')) audio = 'ac3';
  else if (lower.includes('aac')) audio = 'aac';
  else if (lower.includes('eac3') || lower.includes('ddp')) audio = 'eac3';

  // HDR detection (4K releases often have multiple versions)
  let hdr = null;
  if (lower.includes('dolbyvision') || lower.includes('dv')) hdr = 'dolbyvision';
  else if (lower.includes('hdr10+') || lower.includes('hdr10plus')) hdr = 'hdr10+';
  else if (lower.includes('hdr10') || lower.includes('hdr')) hdr = 'hdr10';
  else if (lower.includes('sdr')) hdr = 'sdr';

  // Source platform (streaming service - different cuts/timings)
  let platform = null;
  if (lower.includes('netflix') || lower.includes('.nf.')) platform = 'netflix';
  else if (lower.includes('amazon') || lower.includes('amzn')) platform = 'amazon';
  else if (lower.includes('disney+') || lower.includes('dsnp')) platform = 'disney+';
  else if (lower.includes('hulu')) platform = 'hulu';
  else if (lower.includes('hbo') || lower.includes('hmax')) platform = 'hbo';
  else if (lower.includes('apple') || lower.includes('atvp')) platform = 'apple';
  else if (lower.includes('paramount') || lower.includes('pmtp')) platform = 'paramount';

  // Extract release group (usually at end, after last dash or in brackets)
  // Patterns: "Movie.Name-GROUP", "Movie.Name[GROUP]", "Movie.Name (GROUP)"
  let releaseGroup = null;

  // Try multiple patterns (most specific first)
  const patterns = [
    /\[([A-Z0-9]+)\]\s*$/i,           // [RARBG] at end
    /\(([A-Z0-9]+)\)\s*$/i,           // (YTS) at end
    /[-_]([A-Z0-9]{2,})\s*$/i,        // -ETRG or _PSA at end
    /\b([A-Z0-9]{2,})\s*$/i           // SPARKS at end (no separator)
  ];

  for (const pattern of patterns) {
    const match = filename.match(pattern);
    if (match) {
      releaseGroup = match[1].toLowerCase();
      break;
    }
  }

  // Determine if this is a popular/trusted release group
  const POPULAR_GROUPS = new Set([
    'rarbg', 'yts', 'etrg', 'psa', 'sparks', 'yify', 'ettv', 'galaxyrg',
    'cmrg', 'shaanig', 'nf', 'amzn', 'amiable', 'crimson', 'scene',
    'ntb', 'ntg', 'ghd', 'geckos', 'pahe', 'ion10', 'tigole', 'qxr',
    'joy', 'bokutox', 'iextreme', 'tgx', 'sigma', 'mrcs', 'xlf', 'hqc'
  ]);

  const isPopularGroup = releaseGroup && POPULAR_GROUPS.has(releaseGroup);

  return {
    resolution,
    ripType,
    ripTier,
    codec,
    audio,
    hdr,
    platform,
    releaseGroup,
    isPopularGroup
  };
}
/**
 * Create a normalized release fingerprint for exact matching
 * Returns a fingerprint object with critical metadata for matching
 * @param {string} filename - Release filename
 * @returns {Object} - Fingerprint object with critical metadata
 */
function createReleaseFingerprint(filename) {
  const metadata = parseReleaseMetadata(filename);
  // Extract normalized title (everything before year/season/resolution)
  const normalizedTitle = filename
    .toLowerCase()
    .replace(/\b(19|20)\d{2}\b.*/, '') // Remove year and everything after
    .replace(/\bs\d{1,2}e\d{1,2}\b.*/, '') // Remove season/episode and after
    .replace(/\b(720p|1080p|2160p|4k|480p|360p)\b.*/, '') // Remove resolution and after
    .replace(/[_\-\.]/g, ' ')
    .trim();
  return {
    title: normalizedTitle,
    releaseGroup: metadata.releaseGroup || null,
    ripType: metadata.ripType || null,
    resolution: metadata.resolution || null,
    codec: metadata.codec || null,
    platform: metadata.platform || null,
    hdr: metadata.hdr || null
  };
}

/**
 * Check if two release fingerprints match exactly on critical fields
 * Tier 1: High priority - all critical metadata matches
 * @param {Object} fp1 - First fingerprint
 * @param {Object} fp2 - Second fingerprint
 * @returns {number} - Match score (0 = no match, 1-5 = partial, 5 = perfect)
 */
function checkFingerprintMatch(fp1, fp2) {
  // Title must always match (basic requirement)
  if (!fp1.title || !fp2.title) return 0;
  if (!fp1.title.includes(fp2.title) && !fp2.title.includes(fp1.title)) return 0;
  // Count matching critical fields
  let matches = 0;
  const criticalFields = ['releaseGroup', 'ripType', 'resolution', 'codec', 'platform'];
  for (const field of criticalFields) {
    if (fp1[field] && fp2[field] && fp1[field] === fp2[field]) {
      matches++;
    }
  }
  // Return match score (0-5)
  return matches;
}
/**
 * Calculate filename match score for a subtitle
 * Prioritizes sync probability: exact releases > quality matches > partial matches
 * @param {string} streamFilename - The stream/video filename from Stremio
 * @param {string} subtitleName - The subtitle name from provider
 * @returns {number} - Match score (higher = better match = more likely to sync)
 */
function calculateFilenameMatchScore(streamFilename, subtitleName) {
  if (!streamFilename || !subtitleName) return 0;

  const stream = streamFilename.toLowerCase();
  const subtitle = subtitleName.toLowerCase();

  // Exact string match is perfect
  if (stream === subtitle) {
    return 10000;
  }

  let score = 0;

  // Parse metadata from both filenames
  const streamMeta = parseReleaseMetadata(streamFilename);
  const subtitleMeta = parseReleaseMetadata(subtitleName);

  // Extract core title (everything before year/resolution)
  const getTitleBase = (filename) => {
    return filename
      .replace(/\b(19|20)\d{2}\b.*/, '') // Remove year and everything after
      .replace(/[_\-\.]/g, ' ')
      .trim()
      .toLowerCase();
  };

  const streamTitle = getTitleBase(streamFilename);
  const subtitleTitle = getTitleBase(subtitleName);

  // CRITICAL: Title must match (very high penalty if it doesn't)
  const titleMatch = subtitleTitle.includes(streamTitle) || streamTitle.includes(subtitleTitle);
  if (!titleMatch) {
    return 0; // Completely different movie/show
  }
  score += 500; // Base score for title match

  // RELEASE GROUP MATCHING (highest priority for sync)
  // If both have release groups and they match = very likely to sync
  if (streamMeta.releaseGroup && subtitleMeta.releaseGroup) {
    if (streamMeta.releaseGroup === subtitleMeta.releaseGroup) {
      // Exact release group match = very high probability
      // Popular/trusted groups get extra weight (even more reliable)
      if (streamMeta.isPopularGroup || subtitleMeta.isPopularGroup) {
        score += 5000; // Popular group exact match (RARBG, YTS, etc.)
      } else {
        score += 4000; // Standard group exact match
      }
    } else {
      score -= 100; // Different release groups = lower probability
    }
  } else if (subtitleMeta.releaseGroup && subtitleMeta.isPopularGroup) {
    // Subtitle has popular release group (even without stream group match)
    // These are generally high-quality and well-synced
    score += 200; // Small bonus for popular group subtitles
  }

  // RIP TYPE MATCHING (second priority - CRITICAL for timing sync)
  // Different rip types (WEB-DL vs BluRay vs HDTV) have different frame timing
  if (streamMeta.ripType && subtitleMeta.ripType) {
    if (streamMeta.ripType === subtitleMeta.ripType) {
      score += 2500; // Exact rip type match = VERY high sync probability
    } else if (streamMeta.ripTier && subtitleMeta.ripTier) {
      const ripTierDiff = Math.abs(streamMeta.ripTier - subtitleMeta.ripTier);
      if (ripTierDiff === 1) {
        score += 800; // Adjacent rip tier (e.g., WEB-DL vs WEBRip)
      } else if (ripTierDiff === 2) {
        score += 300; // Close rip tier (might work)
      } else {
        score -= 500; // Very different rip types (CAM vs BluRay = bad sync)
      }
    }
  }

  // STREAMING PLATFORM MATCHING (important for WEB releases)
  // Netflix/Amazon/etc have different cuts and timing
  if (streamMeta.platform && subtitleMeta.platform) {
    if (streamMeta.platform === subtitleMeta.platform) {
      score += 1200; // Same platform = same cut/timing
    } else {
      score -= 200; // Different platforms = different cuts
    }
  }

  // RESOLUTION MATCHING (third priority)
  // Exact resolution match is good, but 1080p subs work on 720p streams
  if (streamMeta.resolution && subtitleMeta.resolution) {
    if (streamMeta.resolution === subtitleMeta.resolution) {
      score += 1000; // Perfect resolution match
    } else {
      // Resolution compatibility: 1080p/720p are compatible, but penalize mismatches
      const streamRes = parseInt(streamMeta.resolution);
      const subtitleRes = parseInt(subtitleMeta.resolution);

      if ((streamRes === 720 && subtitleRes === 1080) ||
        (streamRes === 1080 && subtitleRes === 720)) {
        score += 400; // 720p/1080p cross-match (still works)
      } else if (streamRes < subtitleRes) {
        score += 200; // Higher quality subtitle on lower res stream (works)
      } else {
        score -= 200; // Lower quality subtitle on higher res stream (mismatch)
      }
    }
  }

  // VIDEO CODEC MATCHING (different encodes can have timing shifts)
  if (streamMeta.codec && subtitleMeta.codec) {
    if (streamMeta.codec === subtitleMeta.codec) {
      score += 500; // Same video codec = better sync (increased from 300)
    } else {
      // x265 and x264 from same source are usually compatible
      const codecCompatible =
        (streamMeta.codec === 'x265' && subtitleMeta.codec === 'x264') ||
        (streamMeta.codec === 'x264' && subtitleMeta.codec === 'x265');
      if (codecCompatible) {
        score += 200; // Compatible codecs (same source, different encode)
      }
    }
  }

  // AUDIO CODEC MATCHING (helps identify exact release variant)
  if (streamMeta.audio && subtitleMeta.audio) {
    if (streamMeta.audio === subtitleMeta.audio) {
      score += 400; // Same audio codec = likely same exact release
    }
  }

  // HDR MATCHING (4K releases often have HDR/SDR variants with different timing)
  if (streamMeta.hdr && subtitleMeta.hdr) {
    if (streamMeta.hdr === subtitleMeta.hdr) {
      score += 600; // Same HDR type = same release variant
    } else {
      score -= 150; // Different HDR variants (DV vs HDR10) may have timing differences
    }
  }

  // TOKEN-BASED MATCHING for other distinguishing factors
  // Split by separators and match tokens
  const streamTokens = stream
    .replace(/\.[^.]+$/, '') // Remove extension
    .split(/[_\-\.\s]+/)
    .filter(t => t.length > 1); // Allow 2+ character tokens

  const subtitleTokens = subtitle
    .replace(/\.[^.]+$/, '')
    .split(/[_\-\.\s]+/)
    .filter(t => t.length > 1);

  // Match tokens (especially year, season/episode numbers, edition info)
  let tokenMatches = 0;
  const IMPORTANT_TOKENS = new Set([
    'repack', 'proper', 'extended', 'unrated', 'directors', 'cut',
    'theatrical', 'imax', 'remux', 'atmos', 'hybrid', 'hc', 'dual'
  ]);

  for (const token of streamTokens) {
    if (!subtitleTokens.includes(token)) continue;

    // Year matching (4-digit number starting with 19 or 20)
    if (/^(19|20)\d{2}$/.test(token)) {
      tokenMatches += 3; // Year is VERY important
    }
    // Season/Episode numbers (S01, E05, etc.)
    else if (/^[se]\d+$/i.test(token)) {
      tokenMatches += 4; // Episode/Season numbers are CRITICAL
    }
    // Other numeric tokens (could be episode number, part number, etc.)
    else if (/^\d+$/.test(token)) {
      tokenMatches += 2;
    }
    // Important edition/quality tokens
    else if (IMPORTANT_TOKENS.has(token)) {
      tokenMatches += 2; // Edition markers are important for correct version
    }
    // Regular token match
    else {
      tokenMatches += 1;
    }
  }

  if (tokenMatches > 0) {
    score += tokenMatches * 100;
  }

  // EDITION/CUT MATCHING (different cuts have different timing!)
  const EDITION_MARKERS = ['extended', 'unrated', 'directors.cut', 'theatrical', 'imax', 'remastered'];
  let streamEdition = null;
  let subtitleEdition = null;

  for (const marker of EDITION_MARKERS) {
    if (stream.includes(marker)) streamEdition = marker;
    if (subtitle.includes(marker)) subtitleEdition = marker;
  }

  if (streamEdition && subtitleEdition) {
    if (streamEdition === subtitleEdition) {
      score += 1500; // Same cut/edition = critical for sync
    } else {
      score -= 1000; // Different cuts = very likely desync
    }
  } else if (streamEdition && !subtitleEdition) {
    score -= 300; // Stream is special edition, subtitle is not
  } else if (!streamEdition && subtitleEdition) {
    score -= 300; // Subtitle is special edition, stream is not
  }

  // PROPER/REPACK MATCHING (scene release fixes)
  const streamIsProper = stream.includes('proper') || stream.includes('repack');
  const subtitleIsProper = subtitle.includes('proper') || subtitle.includes('repack');

  if (streamIsProper && subtitleIsProper) {
    score += 800; // Both PROPER/REPACK = same fixed release
  } else if (streamIsProper !== subtitleIsProper) {
    score -= 400; // One is PROPER, other is not = different releases
  }

  // PENALTY: If subtitle has minimal info (very short), it's less likely to be accurate match
  if (subtitleTokens.length < 2) {
    score *= 0.5;
  }

  // BONUS: If subtitle name is very similar in structure/length, it's probably the right one
  const tokenRatio = Math.min(streamTokens.length, subtitleTokens.length) /
    Math.max(streamTokens.length, subtitleTokens.length);
  if (tokenRatio > 0.8) {
    score *= 1.3; // Very similar structure = very good sign (increased threshold and bonus)
  } else if (tokenRatio > 0.6) {
    score *= 1.15; // Moderately similar structure = good sign
  }

  // BONUS: Exact match on multiple critical factors = compound boost
  let criticalMatches = 0;
  if (streamMeta.releaseGroup && streamMeta.releaseGroup === subtitleMeta.releaseGroup) criticalMatches++;
  if (streamMeta.ripType && streamMeta.ripType === subtitleMeta.ripType) criticalMatches++;
  if (streamMeta.resolution && streamMeta.resolution === subtitleMeta.resolution) criticalMatches++;

  if (criticalMatches >= 3) {
    score *= 1.5; // Triple match (group + rip + resolution) = extremely likely correct
  } else if (criticalMatches === 2) {
    score *= 1.25; // Double match = very likely correct
  }

  return Math.max(0, Math.round(score));
}

/**
 * Sort subtitles by filename match score with secondary quality-based ranking
 * @param {Array} subtitles - Array of subtitle objects
 * @param {string} streamFilename - Stream filename from Stremio
 * @param {Object} videoInfo - Video metadata (imdbId, type, season, episode)
 * @returns {Array} - Sorted subtitles (best matches first)
 */
function rankSubtitlesByFilename(subtitles, streamFilename, videoInfo = null) {
  if (!streamFilename || subtitles.length === 0) {
    return subtitles;
  }

  // Create fingerprint for stream once (for Tier 1 matching)
  const streamFingerprint = createReleaseFingerprint(streamFilename);
  const withScores = subtitles.map(sub => {
    let finalScore = 0;
    let matchTier = 'none';
    let matchDetails = '';

    // TIER 0: Hash Match (200,000+ points)
    // Highest priority - provider confirmed this subtitle matches the exact video file hash
    // Supported by: SCS (heuristic first-per-language), OpenSubtitles auth (moviehash_match)
    if (sub.hashMatch === true) {
      finalScore = 200000 - (sub.hashMatchPriority || 0); // Higher priority = higher score within tier
      matchTier = 'tier0-hash';
      matchDetails = `Hash match from ${sub.provider} - exact video file match`;
      log.debug(() => `[Tier 0 Match] ${sub.name}: ${matchDetails}`);
    }

    // TIER 1: Release Fingerprint Match (50,000-90,000 points)
    // High priority - critical metadata matches (group, rip, resolution, codec, platform)
    // Uses only sub.name for fair comparison across all providers
    if (finalScore === 0) {
      const subtitleFingerprint = createReleaseFingerprint(sub.name || '');
      const fingerprintMatchScore = checkFingerprintMatch(streamFingerprint, subtitleFingerprint);
      if (fingerprintMatchScore >= 5) {
        finalScore = 90000;
        matchTier = 'tier1-perfect';
        matchDetails = 'Perfect metadata match (5/5 fields)';
        log.debug(() => `[Tier 1 Perfect] ${sub.name}: ${matchDetails}`);
      } else if (fingerprintMatchScore === 4) {
        finalScore = 70000;
        matchTier = 'tier1-very-good';
        matchDetails = 'Very good metadata match (4/5 fields)';
        log.debug(() => `[Tier 1 Very Good] ${sub.name}: ${matchDetails}`);
      } else if (fingerprintMatchScore === 3) {
        finalScore = 50000;
        matchTier = 'tier1-good';
        matchDetails = 'Good metadata match (3/5 fields)';
        log.debug(() => `[Tier 1 Good] ${sub.name}: ${matchDetails}`);
      }
    }
    // TIER 2: Filename Similarity Match (0-20,000 points)
    // Standard priority - fuzzy matching based on sub.name only
    if (finalScore === 0) {
      const filenameScore = calculateFilenameMatchScore(streamFilename, sub.name || '');
      // Cap Tier 2 scores at 20,000 to keep them below Tier 1
      finalScore = Math.min(filenameScore, 20000);
      matchTier = finalScore > 0 ? 'tier2-filename' : 'tier3-fallback';
      if (finalScore === 0) {
        matchDetails = 'No match - fallback';
      }
    }
    return {
      ...sub,
      _matchScore: finalScore,
      _matchTier: matchTier,
      _matchDetails: matchDetails
    };
  });

  // Add episode metadata match bonus/penalty (for TV shows and anime)
  // This helps rank subtitles when filename matching fails (e.g., numeric IDs)
  if (videoInfo && (videoInfo.type === 'episode' || videoInfo.type === 'anime-episode') && videoInfo.episode) {
    // Default season to 1 for anime when not present
    const targetSeason = videoInfo.season || 1;
    const targetEpisode = videoInfo.episode;

    for (const sub of withScores) {
      const name = (sub.name || '').toLowerCase();

      // Check for season/episode patterns in subtitle name
      // Patterns: S02E01, s02e01, 2x01, S02.E01, etc.
      const seasonEpisodePatterns = [
        new RegExp(`s0*${targetSeason}e0*${targetEpisode}`, 'i'),        // S02E01, s02e01
        new RegExp(`${targetSeason}x0*${targetEpisode}`, 'i'),           // 2x01
        new RegExp(`s0*${targetSeason}\\.e0*${targetEpisode}`, 'i'),     // S02.E01
        new RegExp(`season\\s*0*${targetSeason}.*episode\\s*0*${targetEpisode}`, 'i')  // Season 2 Episode 1
      ];

      // Anime-friendly episode-only patterns when type is anime-episode
      // Expanded to match common anime naming without season markers
      const animeEpisodePatterns = [
        // E01 / EP01 / E 01 / EP 01 / (01) / [01] / - 01 / _01 / 01v2
        new RegExp(`(?<=\\b|\\s|\\[|\\(|-|_)e?p?\\s*0*${targetEpisode}(?:v\\d+)?(?=\\b|\\s|\\]|\\)|\\.|-|_|$)`, 'i'),
        new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${targetEpisode}(?:v\\d+)?(?=$|[\\s\\]\\)\\-_.])`, 'i'),

        // Explicit words
        new RegExp(`(?:^|[\\s\\[\\(\\-_])episode\\s*0*${targetEpisode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
        new RegExp(`(?:^|[\\s\\[\\(\\-_])ep\\s*0*${targetEpisode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),

        // Spanish/Portuguese
        new RegExp(`(?:^|[\\s\\[\\(\\-_])cap(?:itulo|\\.)?\\s*0*${targetEpisode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
        new RegExp(`(?:^|[\\s\\[\\(\\-_])epis[oó]dio\\s*0*${targetEpisode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),

        // Japanese/Chinese/Korean: 第01話 / 01話 / 01集 / 1화
        new RegExp(`第\\s*0*${targetEpisode}\\s*(?:話|集)`, 'i'),
        new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${targetEpisode}\\s*(?:話|集|화)(?=$|[\\s\\]\\)\\-_.])`, 'i'),

        // Multi-episode pack ranges that include the requested episode (e.g., 01-02 / 01~02)
        new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${targetEpisode}\\s*[-~](?=\\s*\\d)`, 'i'),
        new RegExp(`(?:^|[\\s\\[\\(\\-_])\\d+\\s*[-~]\\s*0*${targetEpisode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
      ];

      const hasCorrectEpisode = seasonEpisodePatterns.some(pattern => pattern.test(name)) ||
        (videoInfo.type === 'anime-episode' && animeEpisodePatterns.some(p => p.test(name)));

      if (hasCorrectEpisode) {
        // BONUS: Subtitle name explicitly mentions correct episode
        sub._matchScore += 2000; // Large bonus to prioritize correct episodes
      } else {
        // Check if subtitle has ANY episode number (wrong episode)
        const hasWrongEpisode = /s\d+e\d+|\d+x\d+|season\s*\d+.*episode\s*\d+|\b(ep?\d{1,3})\b/i.test(name);
        if (hasWrongEpisode) {
          // PENALTY: Subtitle is for wrong episode (e.g., S02E11 when we want S02E01)
          sub._matchScore -= 3000; // Heavy penalty for wrong episode
        }
      }
    }
  }

  // Apply penalty for season pack subtitles (rank them last)
  // Season packs are downloaded on-demand and we only know the filename after download
  // They should appear last in the list as a fallback option
  for (const sub of withScores) {
    if (sub.is_season_pack) {
      // PENALTY: Season pack subtitle - rank last as fallback
      sub._matchScore -= 5000; // Heavy penalty to ensure they appear last
      log.debug(() => `[Ranking] Season pack penalty applied: ${sub.name} (new score: ${sub._matchScore})`);
    }
  }

  // Provider reputation scores (used as final tiebreaker when all else is equal)
  const providerReputation = {
    'opensubtitles-v3': 3, // Highest reputation (largest database, most reliable)
    'subdl': 2,            // Good reputation
    'subsource': 2,        // Good reputation - API provides rating-sorted results with rich metadata
    'stremio-community-subtitles': 2, // Good reputation - community-curated subtitles
    'subsro': 2,           // Good reputation - Romanian subtitle database
    'wyzie': 2             // Good reputation - aggregator service
  };

  // Three-tier ranking system (provider-agnostic, sub.name only):
  // 0. Tier 0 (200,000+ pts): SCS hash match - exact video file match
  // 1. Tier 1 (50,000-90,000 pts): Release fingerprint match - critical metadata matches
  // 2. Tier 2 (0-20,000 pts): Filename similarity - fuzzy matching
  // 3. Tier 3 (negative pts): Fallbacks - season packs, wrong episodes

  // Within each tier, quality score (downloads, ratings, date) acts as tiebreaker
  // Helper: Calculate normalized quality score (0-100) from downloads, rating, and date
  // Missing metrics are treated neutrally (not penalized) to avoid unfairly ranking providers
  const calculateQualityScore = (sub) => {
    const metrics = [];
    const weights = [];

    // Normalize downloads using logarithmic scale (diminishing returns for high download counts)
    // log10(1) = 0, log10(10) = 1, log10(100) = 2, log10(1000) = 3
    const downloads = sub.downloads || 0;
    if (downloads > 0) {
      const normalizedDownloads = Math.min(100, (Math.log10(downloads + 1) / Math.log10(1000)) * 100);
      metrics.push(normalizedDownloads);
      weights.push(0.40);
    }

    // Normalize rating (assume 0-10 scale, though some providers use 0-5)
    // If rating > 10, assume it's out of 100
    const rating = sub.rating || 0;
    if (rating > 0) {
      const normalizedRating = rating > 10
        ? Math.min(100, rating)
        : (rating / 10) * 100;
      metrics.push(normalizedRating);
      weights.push(0.40);
    }

    // Normalize upload date (recent = 100, old = 0)
    // Consider subtitles from last 365 days as "fresh"
    const uploadDate = sub.uploadDate ? new Date(sub.uploadDate).getTime() : 0;
    if (uploadDate > 0) {
      const now = Date.now();
      const daysSinceUpload = (now - uploadDate) / (1000 * 60 * 60 * 24);
      const normalizedDate = Math.max(0, Math.min(100, 100 - (daysSinceUpload / 365) * 100));
      metrics.push(normalizedDate);
      weights.push(0.20);
    }

    // If no metrics available, return neutral score (50)
    if (metrics.length === 0) {
      return 50;
    }

    // Calculate weighted average, normalizing weights to sum to 1.0
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    const compositeScore = metrics.reduce((sum, metric, i) => {
      return sum + (metric * (weights[i] / totalWeight));
    }, 0);

    return compositeScore;
  };

  withScores.sort((a, b) => {
    // Primary sort: Filename match score (descending - higher is better)
    const scoreDiff = b._matchScore - a._matchScore;

    // If scores are significantly different (>1000 points), use filename score
    // High threshold ensures filename matching is DOMINANT over quality metrics
    // This prevents providers without download data (OpenSubtitles V3) from being unfairly penalized
    if (Math.abs(scoreDiff) > 1000) {
      return scoreDiff;
    }

    // Special case: When both scores are 0 (no filename match), prioritize by provider reputation first
    // This ensures quality providers aren't unfairly penalized when release names are missing
    if (a._matchScore === 0 && b._matchScore === 0) {
      const reputationDiff = (providerReputation[b.provider] || 0) - (providerReputation[a.provider] || 0);
      if (reputationDiff !== 0) {
        return reputationDiff;
      }
    }

    // Secondary sort: Composite quality score (balanced weighting of all metrics)
    const qualityScoreA = calculateQualityScore(a);
    const qualityScoreB = calculateQualityScore(b);
    const qualityDiff = qualityScoreB - qualityScoreA;

    if (Math.abs(qualityDiff) > 0.01) { // Use small threshold for floating point comparison
      return qualityDiff;
    }

    // Final tiebreaker: Provider reputation (for truly equal subtitles)
    return (providerReputation[b.provider] || 0) - (providerReputation[a.provider] || 0);
  });

  // Remove the temporary score properties before returning
  return withScores.map(({ _matchScore, _matchTier, _matchDetails, ...rest }) => rest);
}

/**
 * Create subtitle handler for Stremio addon
 * @param {Object} config - Addon configuration
 * @returns {Function} - Handler function
 */
function createSubtitleHandler(config) {
  return async (args) => {
    const handlerStartTime = Date.now();
    try {
      log.info(() => `[Subtitles] Handler called: type=${args.type}, id=${args.id?.substring(0, 30)}, extra.filename=${args.extra?.filename ? 'yes' : 'no'}, extra.videoHash=${args.extra?.videoHash ? 'yes' : 'no'}`);

      // CRITICAL DEFENSIVE CHECK: Validate config structure to detect contamination
      if (!config || typeof config !== 'object') {
        log.error(() => '[Subtitles] CRITICAL: Config is null or not an object!');
        return { subtitles: [] };
      }

      // Validate language arrays exist and are arrays
      const hasValidStructure =
        Array.isArray(config.sourceLanguages) &&
        Array.isArray(config.targetLanguages) &&
        Array.isArray(config.noTranslationLanguages);

      if (!hasValidStructure) {
        log.error(() => `[Subtitles] CRITICAL: Config has invalid structure! sourceLanguages=${typeof config.sourceLanguages}, targetLanguages=${typeof config.targetLanguages}`);
        return { subtitles: [] };
      }

      const { type, id, extra } = args;

      // Block known bogus Stremio internal UI requests (e.g. "Stream and Refresh" button)
      if (id === 'Stream and Refresh') {
        log.debug(() => '[Subtitles] Ignoring Stremio internal UI request: "Stream and Refresh"');
        return { subtitles: [] };
      }

      const videoInfo = parseStremioId(id, type);

      if (!videoInfo) {
        log.error(() => ['[Subtitles] Invalid video ID:', id]);
        return { subtitles: [] };
      }

      log.debug(() => `[Subtitles] Video info: ${JSON.stringify(videoInfo)}`);

      // Handle anime content and TMDB→IMDB resolution with a global timeout cap
      // This prevents the pre-resolution step from taking unbounded time before providers start
      const ID_RESOLUTION_TIMEOUT_MS = 30000; // 30s budget for all ID resolution
      try {
        let resolutionTimer;
        await Promise.race([
          (async () => {
            // Handle anime content - try to map anime ID to IMDB ID
            if (videoInfo.isAnime && videoInfo.animeId) {
              log.debug(() => `[Subtitles] Anime content detected (${videoInfo.animeIdType}), attempting to map to IMDB ID`);

              // Step 1: Try offline static mapping (instant, O(1) Map lookup, no API calls)
              const offlineResult = animeIdResolver.resolveImdbId(videoInfo.animeIdType, videoInfo.animeId);
              if (offlineResult?.imdbId) {
                videoInfo.imdbId = offlineResult.imdbId;
                // Also store TMDB ID from offline mapping if we don't already have one
                if (offlineResult.tmdbId && !videoInfo.tmdbId) {
                  videoInfo.tmdbId = String(offlineResult.tmdbId);
                }
                log.info(() => `[Subtitles] Offline mapped ${videoInfo.animeIdType} ${videoInfo.animeId} → ${offlineResult.imdbId}${offlineResult.tmdbId ? ` (tmdb:${offlineResult.tmdbId})` : ''}`);
              } else {
                // Step 2: Fallback to live API services (for entries not in the static list)
                log.debug(() => `[Subtitles] No offline mapping for ${videoInfo.animeIdType} ${videoInfo.animeId}, falling back to live API`);

                if (videoInfo.animeIdType === 'anidb') {
                  try {
                    const imdbId = await anidbService.getImdbId(videoInfo.anidbId);
                    if (imdbId) {
                      log.info(() => `[Subtitles] Live-mapped AniDB ${videoInfo.anidbId} → ${imdbId}`);
                      videoInfo.imdbId = imdbId;
                    } else {
                      log.warn(() => `[Subtitles] Could not find IMDB mapping for AniDB ${videoInfo.anidbId}, subtitles may be limited`);
                    }
                  } catch (error) {
                    log.error(() => [`[Subtitles] Error mapping AniDB to IMDB: ${error.message}`, error]);
                  }
                } else if (videoInfo.animeIdType === 'kitsu') {
                  try {
                    const imdbId = await kitsuService.getImdbId(videoInfo.animeId);
                    if (imdbId) {
                      log.info(() => `[Subtitles] Live-mapped Kitsu ${videoInfo.animeId} → ${imdbId}`);
                      videoInfo.imdbId = imdbId;
                    } else {
                      log.warn(() => `[Subtitles] Could not find IMDB mapping for Kitsu ${videoInfo.animeId}, subtitles may be limited`);
                    }
                  } catch (error) {
                    log.error(() => [`[Subtitles] Error mapping Kitsu to IMDB: ${error.message}`, error]);
                  }
                } else if (videoInfo.animeIdType === 'mal') {
                  try {
                    const imdbId = await malService.getImdbId(videoInfo.animeId);
                    if (imdbId) {
                      log.info(() => `[Subtitles] Live-mapped MAL ${videoInfo.animeId} → ${imdbId}`);
                      videoInfo.imdbId = imdbId;
                    } else {
                      log.warn(() => `[Subtitles] Could not find IMDB mapping for MAL ${videoInfo.animeId}, subtitles may be limited`);
                    }
                  } catch (error) {
                    log.error(() => [`[Subtitles] Error mapping MAL to IMDB: ${error.message}`, error]);
                  }
                } else if (videoInfo.animeIdType === 'anilist') {
                  try {
                    const imdbId = await anilistService.getImdbId(videoInfo.animeId, malService);
                    if (imdbId) {
                      log.info(() => `[Subtitles] Live-mapped AniList ${videoInfo.animeId} → ${imdbId}`);
                      videoInfo.imdbId = imdbId;
                    } else {
                      log.warn(() => `[Subtitles] Could not find IMDB mapping for AniList ${videoInfo.animeId}, subtitles may be limited`);
                    }
                  } catch (error) {
                    log.error(() => [`[Subtitles] Error mapping AniList to IMDB: ${error.message}`, error]);
                  }
                } else {
                  log.debug(() => `[Subtitles] Unknown anime ID type: ${videoInfo.animeIdType}, will search by anime metadata`);
                }
              }
            }

            await ensureImdbId(videoInfo, type, 'Subtitles');
          })(),
          new Promise((_, reject) => {
            resolutionTimer = setTimeout(() => reject(new Error('ID resolution timeout')), ID_RESOLUTION_TIMEOUT_MS);
          })
        ]).finally(() => clearTimeout(resolutionTimer));
      } catch (timeoutErr) {
        if (timeoutErr.message === 'ID resolution timeout') {
          log.warn(() => `[Subtitles] ID resolution timed out after ${ID_RESOLUTION_TIMEOUT_MS}ms, proceeding with ${videoInfo.imdbId ? 'partial' : 'no'} IMDB ID`);
        } else {
          log.error(() => `[Subtitles] Unexpected error during ID resolution: ${timeoutErr.message}`);
        }
      }

      // Check if this is a session token error - if so, return error entry immediately
      if (config.__sessionTokenError === true) {
        log.warn(() => '[Subtitles] Session token error detected - returning config error entry');
        return {
          subtitles: [{
            id: 'config_error_session_token',
            // Prefix with "!" so Stremio lists this error entry first
            lang: '!SubMaker Error',
            url: `{{ADDON_URL}}/error-subtitle/session-token-not-found.srt`
          }]
        };
      }

      // Check if credential decryption failed (encryption key mismatch on multi-pod deployment)
      // This happens when the server's encryption key changed or on multi-pod deployments
      // where pods don't share the same encryption key. We add an informational entry to
      // the subtitle list so users are aware they need to re-enter their credentials.
      if (config.__credentialDecryptionFailed === true) {
        const failedFields = config.__credentialDecryptionFailedFields || [];
        log.warn(() => `[Subtitles] Credential decryption failed for fields: ${failedFields.join(', ')}. ` +
          'This often indicates an encryption key mismatch between server instances. ' +
          'User will see V3 mode behavior until they re-enter their credentials.');

        // Add a warning entry to the top of the subtitle list
        // We continue with the search (fallback to V3 mode) but notify the user
        const warningEntry = {
          id: 'config_warning_credential_decryption',
          // Use "⚠" prefix to sort near the top and indicate warning (not error)
          lang: '⚠ SubMaker Notice',
          url: `{{ADDON_URL}}/error-subtitle/credential-decryption-failed.srt`
        };

        // Store the warning entry to prepend to results later
        // We'll add it to the response after completing the search
        config.__credentialWarningEntry = warningEntry;
      }

      // Reject requests without a valid config hash before doing any provider work or cache access
      if (!config || typeof config.__configHash !== 'string' || !config.__configHash.length) {
        log.warn(() => '[Subtitles] Missing/invalid config hash - returning session token error entry');
        return {
          subtitles: [{
            id: 'config_error_session_token',
            // Prefix with "!" so Stremio lists this error entry first
            lang: '!SubMaker Error',
            url: `{{ADDON_URL}}/error-subtitle/session-token-not-found.srt`
          }]
        };
      }

      // Extract stream filename for matching
      const streamFilename = extra?.filename || '';
      if (streamFilename) {
        log.debug(() => `[Subtitles] Stream filename for matching: ${streamFilename}`);
      }

      try {
        const configHash = (config && typeof config.__configHash === 'string' && config.__configHash.length)
          ? config.__configHash
          : null;
        if (configHash) {
          const videoHashForActivity = deriveVideoHash(streamFilename || '', id);
          // Also record the real Stremio hash (from streaming addons like Torrentio)
          // so SMDB can use it for cross-source subtitle matching
          const realStremioHash = (extra?.videoHash && typeof extra.videoHash === 'string' && extra.videoHash.length > 0)
            ? extra.videoHash : null;
          streamActivity.recordStreamActivity({
            configHash,
            videoId: id,
            filename: streamFilename || '',
            videoHash: videoHashForActivity,
            stremioHash: realStremioHash
          });

          // Persist stremioHash ↔ derivedHash mapping so SMDB can find subtitles
          // stored under either hash even after server restarts (stream activity is in-memory only)
          if (realStremioHash && videoHashForActivity && realStremioHash !== videoHashForActivity) {
            smdbCache.saveHashMapping(realStremioHash, videoHashForActivity).catch(e =>
              log.debug(() => ['[Subtitles] Failed to save SMDB hash mapping', e.message])
            );
          }
        }
      } catch (e) {
        log.warn(() => ['[Subtitles] Failed to record stream activity', e.message]);
      }

      // Get all languages for searching
      // In no-translation mode (just fetch), use noTranslationLanguages
      // In translation mode, use source + target languages
      const allLanguages = config.noTranslationMode
        ? [...new Set(config.noTranslationLanguages || [])]
        : [...new Set([...config.sourceLanguages, ...config.targetLanguages])];

      // Build search parameters for all providers
      // Check if we have a real videoHash from Stremio (OpenSubtitles format from streaming addon)
      // Real hashes come from streaming addons like Torrentio via behaviorHints.videoHash
      // This is NOT the same as our derived MD5 hash (in videoHash.js) which is only for internal caching
      const hasRealStremioHash = !!(extra?.videoHash && typeof extra.videoHash === 'string' && extra.videoHash.length > 0);

      // Validate videoSize is a positive integer (SCS expects numeric value)
      const validVideoSize = hasRealStremioHash && extra?.videoSize
        ? (typeof extra.videoSize === 'number' && extra.videoSize > 0 ? extra.videoSize
          : (typeof extra.videoSize === 'string' && /^\d+$/.test(extra.videoSize) ? parseInt(extra.videoSize, 10) : null))
        : null;

      if (hasRealStremioHash) {
        log.debug(() => `[Subtitles] Real Stremio videoHash available: ${extra.videoHash.substring(0, 8)}...${validVideoSize ? ` (size: ${validVideoSize})` : ''} - SCS hash matching enabled`);
      } else {
        // No hash = streaming source doesn't provide it (e.g., HTTP links, some debrid services)
        // Only torrent-based streaming addons (Torrentio, etc.) provide OpenSubtitles hashes
        log.debug(() => `[Subtitles] No Stremio videoHash (streaming source doesn't provide it) - SCS will use filename matching only`);
      }

      const searchParams = {
        imdb_id: videoInfo.imdbId,
        tmdb_id: videoInfo.tmdbId || null, // Pass TMDB ID for providers that support native TMDB search (WyzieSubs, SubsRo)
        animeId: videoInfo.animeId || null, // Pass anime ID for providers that support native anime IDs (e.g., SCS with kitsu:1234)
        animeIdType: videoInfo.animeIdType || null, // Platform name (kitsu, anidb, mal, anilist)
        type: videoInfo.type,
        season: videoInfo.season,
        episode: videoInfo.episode,
        languages: allLanguages,
        excludeHearingImpairedSubtitles: config.excludeHearingImpairedSubtitles === true,
        // Only send real hash from Stremio - our derived MD5 is useless for external providers like SCS
        // They store OpenSubtitles hashes, our MD5(filename+id) won't match anything
        videoHash: hasRealStremioHash ? extra.videoHash : null,
        videoSize: validVideoSize, // Validated to be positive integer or null
        filename: streamFilename,
        // Flag for SCS to know if hash matching is possible
        _isRealStremioHash: hasRealStremioHash,
        // Provider timeout from config (subtract 2s buffer for orchestration overhead)
        // Default to 10s (12s config default - 2s buffer) if not configured
        providerTimeout: Math.max(6, ((config.subtitleProviderTimeout || 12) - 2)) * 1000
      };

      // Get user config hash for cache isolation
      // Each user's config (API keys, provider settings) gets their own cached results
      const userHash = (config && typeof config.__configHash === 'string' && config.__configHash.length > 0)
        ? config.__configHash
        : 'default';

      const cacheIdComponent = getVideoCacheIdComponent(videoInfo);
      // Create user-scoped deduplication key based on video info, languages, and config hash
      // This ensures different users (or same user with different configs) get separate cached results
      // Cache automatically purges when user changes config (different hash = different cache key)
      const dedupKey = `subtitle-search:${cacheIdComponent}:${videoInfo.type}:${videoInfo.season || ''}:${videoInfo.episode || ''}:${allLanguages.join(',')}:${userHash}`;

      // Collect subtitles from all enabled providers with deduplication
      let openSubsAuthFailed = false; // track OpenSubtitles auth failures to append UX hint entries later
      const foundSubtitles = await deduplicateSearch(dedupKey, async () => {
        // Parallelize all provider searches using Promise.allSettled for better performance
        // This reduces search time from (OpenSubtitles + SubDL + SubSource) sequential
        // to max(OpenSubtitles, SubDL, SubSource) parallel
        const searchPromises = [];
        const skippedProviders = []; // Track providers skipped due to circuit breaker

        // Check if OpenSubtitles provider is enabled
        if (config.subtitleProviders?.opensubtitles?.enabled) {
          const implementationType = config.subtitleProviders.opensubtitles.implementationType || 'v3';

          // Check circuit breaker health before making request
          const providerKey = implementationType === 'v3' ? 'opensubtitles_v3' : 'opensubtitles_auth';
          const health = isProviderHealthy(providerKey);

          if (!health.healthy) {
            log.debug(() => `[Subtitles] Skipping OpenSubtitles (${implementationType}): ${health.reason} (retry in ${health.retryInSec}s)`);
            skippedProviders.push({ provider: `OpenSubtitles (${implementationType})`, reason: health.reason });
          } else {
            log.debug(() => `[Subtitles] OpenSubtitles provider is enabled (implementation: ${implementationType})`);

            let opensubtitles;
            if (implementationType === 'v3') {
              opensubtitles = new OpenSubtitlesV3Service();
            } else {
              opensubtitles = new OpenSubtitlesService(config.subtitleProviders.opensubtitles);
            }

            searchPromises.push(
              opensubtitles.searchSubtitles(searchParams)
                .then(results => {
                  // Record success for circuit breaker
                  circuitBreaker.recordSuccess(implementationType === 'v3' ? 'opensubtitlesV3' : 'opensubtitlesV3');
                  return { provider: `OpenSubtitles (${implementationType})`, results };
                })
                .catch(error => {
                  // Record failure for circuit breaker if it's a connection error
                  const code = error?.code || '';
                  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
                    circuitBreaker.recordFailure(implementationType === 'v3' ? 'opensubtitlesV3' : 'opensubtitlesV3', error);
                  }
                  try {
                    const msg = String(error?.message || '').toLowerCase();
                    if (error?.authError === true || error?.statusCode === 400 || error?.statusCode === 401 || error?.statusCode === 403 || msg.includes('auth')) {
                      openSubsAuthFailed = true;
                    }
                  } catch (_) { }
                  return ({ provider: `OpenSubtitles (${implementationType})`, results: [], error });
                })
            );
          }
        } else {
          log.debug(() => '[Subtitles] OpenSubtitles provider is disabled');
        }

        // Check if SubDL provider is enabled
        if (config.subtitleProviders?.subdl?.enabled) {
          const subdlHealth = isProviderHealthy('subdl');
          if (!subdlHealth.healthy) {
            log.debug(() => `[Subtitles] Skipping SubDL: ${subdlHealth.reason} (retry in ${subdlHealth.retryInSec}s)`);
            skippedProviders.push({ provider: 'SubDL', reason: subdlHealth.reason });
          } else {
            log.debug(() => '[Subtitles] SubDL provider is enabled');
            const subdl = new SubDLService(config.subtitleProviders.subdl.apiKey);
            searchPromises.push(
              subdl.searchSubtitles(searchParams)
                .then(results => {
                  circuitBreaker.recordSuccess('subdl');
                  return { provider: 'SubDL', results };
                })
                .catch(error => {
                  const code = error?.code || '';
                  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
                    circuitBreaker.recordFailure('subdl', error);
                  }
                  return { provider: 'SubDL', results: [], error };
                })
            );
          }
        } else {
          log.debug(() => '[Subtitles] SubDL provider is disabled');
        }

        // Check if SubSource provider is enabled
        if (config.subtitleProviders?.subsource?.enabled) {
          const subsourceHealth = isProviderHealthy('subsource');
          if (!subsourceHealth.healthy) {
            log.debug(() => `[Subtitles] Skipping SubSource: ${subsourceHealth.reason} (retry in ${subsourceHealth.retryInSec}s)`);
            skippedProviders.push({ provider: 'SubSource', reason: subsourceHealth.reason });
          } else {
            log.debug(() => '[Subtitles] SubSource provider is enabled');
            const subsource = new SubSourceService(config.subtitleProviders.subsource.apiKey);
            searchPromises.push(
              subsource.searchSubtitles(searchParams)
                .then(results => {
                  circuitBreaker.recordSuccess('subsource');
                  return { provider: 'SubSource', results };
                })
                .catch(error => {
                  const code = error?.code || '';
                  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
                    circuitBreaker.recordFailure('subsource', error);
                  }
                  return { provider: 'SubSource', results: [], error };
                })
            );
          }
        } else {
          log.debug(() => '[Subtitles] SubSource provider is disabled');
        }

        // Check if Stremio Community Subtitles (SCS) is enabled (user toggle)
        if (config.subtitleProviders?.scs?.enabled) {
          const scsHealth = isProviderHealthy('scs');
          if (!scsHealth.healthy) {
            log.debug(() => `[Subtitles] Skipping SCS: ${scsHealth.reason} (retry in ${scsHealth.retryInSec}s)`);
            skippedProviders.push({ provider: 'StremioCommunitySubtitles', reason: scsHealth.reason });
          } else {
            log.debug(() => '[Subtitles] SCS provider is enabled');

            // Warn if user's timeout is too low for SCS (it takes 10-22s to respond)
            // SCS is inherently slow due to server-side hash matching against a large database
            const userTimeoutMs = (config.subtitleProviderTimeout || 12) * 1000;
            if (userTimeoutMs < 28000) {
              log.debug(() => `[Subtitles] Note: SCS may be cut off by ${userTimeoutMs}ms timeout (SCS needs 28-35s). Increase timeout in settings for reliable SCS results.`);
            }

            const scs = new StremioCommunitySubtitlesService();
            searchPromises.push(
              scs.searchSubtitles(searchParams)
                .then(results => {
                  circuitBreaker.recordSuccess('scs');
                  return { provider: 'StremioCommunitySubtitles', results };
                })
                .catch(error => {
                  const code = error?.code || '';
                  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EPROTO') {
                    circuitBreaker.recordFailure('scs', error);
                  }
                  return { provider: 'StremioCommunitySubtitles', results: [], error };
                })
            );
          }
        } else {
          log.debug(() => '[Subtitles] SCS provider is disabled');
        }

        // Check if Wyzie Subs is enabled (user toggle) - free aggregator, no API key needed
        if (config.subtitleProviders?.wyzie?.enabled) {
          const wyzieHealth = isProviderHealthy('wyzie');
          if (!wyzieHealth.healthy) {
            log.debug(() => `[Subtitles] Skipping Wyzie Subs: ${wyzieHealth.reason} (retry in ${wyzieHealth.retryInSec}s)`);
            skippedProviders.push({ provider: 'WyzieSubs', reason: wyzieHealth.reason });
          } else {
            log.debug(() => '[Subtitles] Wyzie Subs provider is enabled');
            const wyzie = new WyzieSubsService();
            // Pass sources config so Wyzie only queries user-selected sources
            const wyzieParams = { ...searchParams, sources: config.subtitleProviders.wyzie.sources };
            searchPromises.push(
              wyzie.searchSubtitles(wyzieParams)
                .then(results => {
                  circuitBreaker.recordSuccess('wyzie');
                  return { provider: 'WyzieSubs', results };
                })
                .catch(error => {
                  const code = error?.code || '';
                  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
                    circuitBreaker.recordFailure('wyzie', error);
                  }
                  return { provider: 'WyzieSubs', results: [], error };
                })
            );
          }
        } else {
          log.debug(() => '[Subtitles] Wyzie Subs provider is disabled');
        }

        // Check if Subs.ro is enabled (user toggle) - Romanian subtitle database, requires API key
        if (config.subtitleProviders?.subsro?.enabled) {
          const subsroHealth = isProviderHealthy('subsro');
          if (!subsroHealth.healthy) {
            log.debug(() => `[Subtitles] Skipping Subs.ro: ${subsroHealth.reason} (retry in ${subsroHealth.retryInSec}s)`);
            skippedProviders.push({ provider: 'SubsRo', reason: subsroHealth.reason });
          } else {
            log.debug(() => '[Subtitles] Subs.ro provider is enabled');
            const subsro = new SubsRoService(config.subtitleProviders.subsro.apiKey);
            searchPromises.push(
              subsro.searchSubtitles(searchParams)
                .then(results => {
                  circuitBreaker.recordSuccess('subsro');
                  return { provider: 'SubsRo', results };
                })
                .catch(error => {
                  const code = error?.code || '';
                  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
                    circuitBreaker.recordFailure('subsro', error);
                  }
                  return { provider: 'SubsRo', results: [], error };
                })
            );
          }
        } else {
          log.debug(() => '[Subtitles] Subs.ro provider is disabled');
        }

        // Execute all searches in parallel with early timeout
        // After orchestrationTimeoutMs, return whatever results are available
        // This prevents slow/unresponsive providers from blocking the entire response
        let providerResults = [];

        // Use configurable timeout from config (default 12s), with env override still available
        // Orchestration timeout = config value (individual requests already have -2s buffer built in)
        const orchestrationTimeoutMs = process.env.PROVIDER_SEARCH_TIMEOUT_MS
          ? parseInt(process.env.PROVIDER_SEARCH_TIMEOUT_MS)
          : ((config.subtitleProviderTimeout || 12) * 1000);

        if (orchestrationTimeoutMs > 0 && searchPromises.length > 0) {
          // Create a collector for results as they arrive
          const collectedResults = [];
          let resolvedCount = 0;
          let timeoutFired = false;

          // Wrap each promise to collect results as they complete
          const wrappedPromises = searchPromises.map(p =>
            p.then(result => {
              if (!timeoutFired) {
                collectedResults.push(result);
              }
              resolvedCount++;
              return result;
            })
          );

          // Race between: all promises completing OR timeout
          const timeoutPromise = new Promise(resolve => {
            setTimeout(() => {
              timeoutFired = true;
              resolve('timeout');
            }, orchestrationTimeoutMs);
          });

          const allSettledPromise = Promise.all(wrappedPromises).then(() => 'completed');

          const winner = await Promise.race([allSettledPromise, timeoutPromise]);

          if (winner === 'timeout') {
            // Timeout fired - use whatever results we have so far
            providerResults = [...collectedResults];
            const pending = searchPromises.length - resolvedCount;
            if (pending > 0) {
              log.warn(() => `[Subtitles] Provider search timeout after ${orchestrationTimeoutMs}ms - returning ${resolvedCount}/${searchPromises.length} provider results (${pending} still pending)`);
            }
          } else {
            // All completed before timeout
            providerResults = collectedResults;
          }
        } else if (searchPromises.length > 0) {
          // Timeout disabled - wait for all providers
          providerResults = await Promise.all(searchPromises);
        }

        // Collect and log results from all providers
        let subtitles = [];
        for (const result of providerResults) {
          if (result.error) {
            log.warn(() => [`[Subtitles] ${result.provider} search failed:`, result.error.message]);
          } else {
            log.debug(() => `[Subtitles] Found ${result.results.length} subtitles from ${result.provider}`);
            subtitles = [...subtitles, ...result.results];
          }
        }

        // Log any providers that were skipped due to circuit breaker (saves waiting for timeout!)
        if (skippedProviders.length > 0) {
          const skippedNames = skippedProviders.map(s => s.provider).join(', ');
          log.info(() => `[Subtitles] Skipped ${skippedProviders.length} unhealthy provider(s): ${skippedNames}`);
        }

        return subtitles;
      });

      // Future providers can be added here
      // if (config.subtitleProviders?.anotherProvider?.enabled) {
      //   const results = await anotherProvider.search(...);
      //   foundSubtitles = [...foundSubtitles, ...results];
      // }

      // Normalize language codes to proper ISO-639-2 format
      const normalizeLanguageCode = (lang) => {
        const lower = lang.toLowerCase().replace(/[_-]/g, '');

        // Handle special cases for Portuguese Brazilian
        if (lower === 'ptbr' || lower === 'pt-br') {
          return 'pob';
        }

        // If it's already 3 letters, return as-is
        if (/^[a-z]{3}$/.test(lower)) {
          return lower;
        }

        // If it's 2 letters, try to convert to ISO-639-2
        if (lower.length === 2) {
          const { toISO6392 } = require('../utils/languages');
          const iso2Codes = toISO6392(lower);
          if (iso2Codes && iso2Codes.length > 0) {
            return iso2Codes[0].code2;
          }
        }

        // Return original if we can't normalize
        return lower;
      };

      // Normalize all configured languages (source + target) for filtering
      const normalizedAllLangs = new Set([...new Set(allLanguages.map(lang => normalizeLanguageCode(lang)))]);

      // Add language equivalents for providers that don't distinguish regional variants
      // E.g., SubDL treats Spanish (Spain) and Spanish (Latin America) the same way
      const languageEquivalents = {
        'spa': ['spn'],  // Spanish (Spain) ↔ Spanish (Latin America)
        'spn': ['spa']
      };

      // Expand normalizedAllLangs to include equivalents
      const expandedLangs = new Set(normalizedAllLangs);
      normalizedAllLangs.forEach(lang => {
        if (languageEquivalents[lang]) {
          languageEquivalents[lang].forEach(equiv => expandedLangs.add(equiv));
        }
      });

      // Filter results to only allowed languages (including equivalents)
      // When no languages are configured (just fetch mode), accept all subtitles
      let filteredFoundSubtitles = allLanguages.length > 0
        ? foundSubtitles.filter(sub => sub.languageCode && expandedLangs.has(sub.languageCode))
        : foundSubtitles;

      // Optional: exclude SDH/HI (hearing impaired) subtitles from results
      if (config.excludeHearingImpairedSubtitles === true) {
        const beforeCount = filteredFoundSubtitles.length;
        filteredFoundSubtitles = filteredFoundSubtitles.filter(sub => !isHearingImpairedSubtitle(sub));
        const removed = beforeCount - filteredFoundSubtitles.length;
        if (removed > 0) {
          log.debug(() => `[Subtitles] Excluded ${removed} hearing impaired subtitles (SDH/HI)`);
        }
      }

      // Optional: exclude season pack subtitles from results
      // Season packs contain multiple episodes and require extraction - some users prefer episode-specific subs
      // Default: enabled (backwards compatible) - only filter when explicitly disabled
      if (config.enableSeasonPacks === false) {
        const beforeCount = filteredFoundSubtitles.length;
        filteredFoundSubtitles = filteredFoundSubtitles.filter(sub => sub.is_season_pack !== true);
        const removed = beforeCount - filteredFoundSubtitles.length;
        if (removed > 0) {
          log.debug(() => `[Subtitles] Excluded ${removed} season pack subtitles (user preference)`);
        }
      }

      // Deduplicate subtitles from multiple providers
      // This removes exact duplicates (same release name) while preserving:
      // - Different languages (never dedupe across languages)
      // - HI vs non-HI variants (kept separate)
      // - Different formats (SRT vs ASS kept separate)
      // - Season packs vs episode-specific (kept separate)
      if (config.deduplicateSubtitles !== false) {
        const { deduplicated, stats } = deduplicateSubtitles(filteredFoundSubtitles, {
          enabled: true,
          respectHIVariants: true,
          respectFormats: true
        });
        filteredFoundSubtitles = deduplicated;
        logDeduplicationStats(stats);
      }

      // Rank subtitles by filename match + quality metrics before creating response lists
      // This ensures the best matches appear first in Stremio UI
      if (streamFilename) {
        filteredFoundSubtitles = rankSubtitlesByFilename(filteredFoundSubtitles, streamFilename, videoInfo);
        log.debug(() => `[Subtitles] Ranked ${filteredFoundSubtitles.length} subtitles by filename match + episode metadata + quality (downloads, rating, date)`);

        // Debug: Log top 3 ranked subtitles for verification
        if (filteredFoundSubtitles.length > 0) {
          const top3 = filteredFoundSubtitles.slice(0, 3);
          log.debug(() => ['[Subtitles] Top 3 AFTER ranking:', top3.map(s => ({
            name: s.name?.substring(0, 50) + (s.name?.length > 50 ? '...' : ''),
            provider: s.provider,
            downloads: s.downloads,
            rating: s.rating,
            uploadDate: s.uploadDate
          }))]);
        }
      }

      // Limit to top N subtitles per language (applied AFTER ranking all sources)
      // This prevents UI slowdown while ensuring best-quality subtitles are shown
      const MAX_SUBS_PER_LANGUAGE = Number.isFinite(config?.maxSubtitlesPerLanguage)
        ? config.maxSubtitlesPerLanguage
        : 8; // Default reduced from 12 to 8 for better performance
      const limitedByLanguage = new Map(); // language -> subtitle array


      for (const sub of filteredFoundSubtitles) {
        if (!limitedByLanguage.has(sub.languageCode)) {
          limitedByLanguage.set(sub.languageCode, []);
        }
        const langSubs = limitedByLanguage.get(sub.languageCode);
        if (langSubs.length < MAX_SUBS_PER_LANGUAGE) {
          langSubs.push(sub);
        }
      }

      // Flatten back to array, preserving ranked order within each language
      filteredFoundSubtitles = Array.from(limitedByLanguage.values()).flat();
      log.debug(() => `[Subtitles] Limited to ${MAX_SUBS_PER_LANGUAGE} subtitles per language (${filteredFoundSubtitles.length} total)`);

      // Determine URL extension based on urlExtensionTest config (dev mode testing)
      // Determine URL extension based on urlExtensionTest config (dev mode testing)
      // 'srt' = default (.srt), 'sub' = Option A (.sub), 'none' = Option B (no extension)
      let urlExtension = '.srt';
      if (config.urlExtensionTest === 'sub') {
        urlExtension = '.sub';
      } else if (config.urlExtensionTest === 'none') {
        urlExtension = '';
      }

      // Convert to Stremio subtitle format
      // Validate required fields before creating response objects
      const stremioSubtitles = filteredFoundSubtitles
        .filter(sub => {
          // Validate required fields exist and have valid values
          if (!sub.fileId || typeof sub.fileId !== 'string') {
            log.warn(() => ['[Subtitles] Skipping subtitle: missing or invalid fileId', sub]);
            return false;
          }
          if (!sub.languageCode || typeof sub.languageCode !== 'string') {
            log.warn(() => ['[Subtitles] Skipping subtitle: missing or invalid languageCode', sub]);
            return false;
          }
          return true;
        })
        .map(sub => {
          // Display-friendly label for Stremio UI while preserving code for URL
          const displayLang = (sub.languageCode && sub.languageCode.toLowerCase() === 'spn')
            ? 'Spanish (LA)'
            : sub.languageCode;

          const subtitle = {
            id: `${sub.fileId}`,
            lang: displayLang,
            url: `{{ADDON_URL}}/subtitle/${sub.fileId}/${sub.languageCode}${urlExtension}`
          };

          return subtitle;
        });

      const toolboxEnabled = config.subToolboxEnabled === true
        || config.fileTranslationEnabled === true
        || config.syncSubtitlesEnabled === true;

      // Derive a single stable video hash for cache lookups
      const primaryVideoHash = deriveVideoHash(streamFilename || '', id);
      const videoHashes = primaryVideoHash ? [primaryVideoHash] : [];

      // Preload embedded originals AND translations in parallel (used for display + translation sources)
      // Performance: Single parallel fetch avoids multiple sequential calls later
      const embeddedOriginalsByHash = new Map();
      const embeddedTranslationsByHash = new Map();
      if (videoHashes.length) {
        const preloadPromises = [];
        for (const hash of videoHashes) {
          // Preload originals
          preloadPromises.push(
            embeddedCache.listEmbeddedOriginals(hash)
              .then(originals => ({ type: 'original', hash, data: originals || [] }))
              .catch(error => {
                log.error(() => [`[Subtitles] Failed to load xEmbed originals for ${hash}:`, error.message]);
                return { type: 'original', hash, data: [] };
              })
          );
          // Preload translations in parallel
          preloadPromises.push(
            embeddedCache.listEmbeddedTranslations(hash)
              .then(translations => ({ type: 'translation', hash, data: translations || [] }))
              .catch(error => {
                log.error(() => [`[Subtitles] Failed to load xEmbed translations for ${hash}:`, error.message]);
                return { type: 'translation', hash, data: [] };
              })
          );
        }
        // Execute all preloads in parallel
        const preloadResults = await Promise.all(preloadPromises);
        for (const result of preloadResults) {
          if (result.type === 'original') {
            embeddedOriginalsByHash.set(result.hash, result.data);
          } else {
            embeddedTranslationsByHash.set(result.hash, result.data);
          }
        }
      }

      // Add translation buttons for each target language (skip in no-translation mode)
      const translationEntries = [];
      if (!config.noTranslationMode) {
        const translateQueryParts = [];
        if (id) translateQueryParts.push(`videoId=${encodeURIComponent(id)}`);
        if (streamFilename) translateQueryParts.push(`filename=${encodeURIComponent(streamFilename)}`);
        const translateQuery = translateQueryParts.length ? `?${translateQueryParts.join('&')}` : '';

        // Normalize and deduplicate target languages
        const normalizedTargetLangs = [...new Set(config.targetLanguages.map(lang => {
          const normalized = normalizeLanguageCode(lang);
          if (normalized !== lang) {
            log.debug(() => `[Subtitles] Normalized language code: "${lang}" -> "${normalized}"`);
          }
          return normalized;
        }))];

        // Create translation entries: for each target language, create entries for top source language subtitles
        // Note: filteredFoundSubtitles is already limited to MAX_SUBS_PER_LANGUAGE per language (including source languages)
        const providerSourceSubtitles = filteredFoundSubtitles.filter(sub =>
          config.sourceLanguages.some(sourceLang => {
            const normalized = normalizeLanguageCode(sourceLang);
            return sub.languageCode === normalized;
          })
        );

        // Add embedded originals as source subtitles when they match configured source languages
        const embeddedSourceSubtitles = [];
        for (const hash of videoHashes) {
          const originals = embeddedOriginalsByHash.get(hash) || [];
          for (const entry of originals) {
            if (!entry || !entry.trackId) continue;
            const normalizedSource = normalizeLanguageCode(entry.languageCode || '');
            if (!normalizedSource) continue;
            const isAllowedSource = config.sourceLanguages.some(sourceLang => normalizeLanguageCode(sourceLang) === normalizedSource);
            if (!isAllowedSource) continue;
            const embeddedFileId = entry.cacheKey ? `xembed_${entry.cacheKey}` : `xembed_${hash}_${entry.trackId}`;
            embeddedSourceSubtitles.push({
              fileId: embeddedFileId,
              languageCode: normalizedSource
            });
          }
        }

        // Merge provider + embedded sources without duplication
        const seenSourceIds = new Set(providerSourceSubtitles.map(sub => sub.fileId));
        const sourceSubtitles = [...providerSourceSubtitles];
        for (const embedded of embeddedSourceSubtitles) {
          if (!embedded.fileId || seenSourceIds.has(embedded.fileId)) continue;
          seenSourceIds.add(embedded.fileId);
          sourceSubtitles.push(embedded);
        }

        log.debug(() => `[Subtitles] Found ${sourceSubtitles.length} source language subtitles for translation (providers + embedded)`);

        // For each target language, create a translation entry for each source subtitle
        // Translation entries are created from the already-limited source subtitles (16 per source language)
        for (const targetLang of normalizedTargetLangs) {
          const baseName = getLanguageName(targetLang);
          const displayName = `Make ${baseName}`;
          log.debug(() => `[Subtitles] Creating translation entries for ${displayName} (${targetLang})`);

          for (const sourceSub of sourceSubtitles) {
            // Cache source metadata for later history enrichment (Stremio may drop query params)
            try {
              const metaKey = `${config.__configHash || config.userHash || 'default'}:${sourceSub.fileId}`;
              translationSourceMeta.set(metaKey, {
                videoId: id,
                filename: streamFilename,
                title: sourceSub.name || ''
              });
            } catch (_) { /* ignore */ }

            const translationEntry = {
              id: `translate_${sourceSub.fileId}_to_${targetLang}`,
              lang: displayName, // Display as "Make Language" in Stremio UI
              url: `{{ADDON_URL}}/translate/${sourceSub.fileId}/${targetLang}${urlExtension}${translateQuery}`
            };
            translationEntries.push(translationEntry);
          }
        }

        log.debug(() => `[Subtitles] Created ${translationEntries.length} translation options from ${sourceSubtitles.length} source subtitles`);
      }

      // Add Learn Mode entries (dual-language VTT output)
      const learnEntries = [];
      try {
        if (config.learnMode === true) {
          const normalizedLearnLangs = [...new Set((config.learnTargetLanguages || []).map(lang => normalizeLanguageCode(lang)))];
          const sourceSubtitles = filteredFoundSubtitles.filter(sub =>
            config.sourceLanguages.some(sourceLang => normalizeLanguageCode(sourceLang) === sub.languageCode)
          );

          for (const learnLang of normalizedLearnLangs) {
            const baseName = getLanguageName(learnLang);
            const displayName = `Learn ${baseName}`;
            for (const sourceSub of sourceSubtitles) {
              learnEntries.push({
                id: `learn_${sourceSub.fileId}_to_${learnLang}`,
                lang: displayName,
                url: `{{ADDON_URL}}/learn/${sourceSub.fileId}/${learnLang}.vtt`
              });
            }
          }
          if (learnEntries.length > 0) {
            log.debug(() => `[Subtitles] Added ${learnEntries.length} Learn Mode entries`);
          }
        }
      } catch (e) {
        log.warn(() => `[Subtitles] Failed to add Learn Mode entries: ${e.message}`);
      }

      // Add xSync entries (synced subtitles from cache) - only for user-configured languages
      // Performance: Execute all sync cache lookups in parallel instead of sequential nested loops
      const xSyncEntries = [];
      const allowedLanguages = Array.from(expandedLangs).filter(Boolean);
      if (toolboxEnabled && videoHashes.length && allowedLanguages.length) {
        const seenSync = new Set();
        const buildLangCandidates = (lang) => {
          const canonical = canonicalSyncLanguageCode(lang);
          return canonical ? [canonical] : [];
        };

        // Build all lookup combinations upfront
        const syncLookups = [];
        for (const hash of videoHashes) {
          for (const lang of allowedLanguages) {
            const langCandidates = buildLangCandidates(lang);
            for (const candidate of langCandidates) {
              syncLookups.push({ hash, lang, candidate });
            }
          }
        }

        // Execute all lookups in parallel
        const syncResults = await Promise.all(
          syncLookups.map(({ hash, lang, candidate }) =>
            syncCache.getSyncedSubtitles(hash, candidate)
              .then(subs => ({ hash, lang, candidate, subs: subs || [] }))
              .catch(error => {
                log.error(() => [`[Subtitles] Failed to get xSync entries for ${lang} (hash=${hash}):`, error.message]);
                return { hash, lang, candidate, subs: [] };
              })
          )
        );

        // Process results
        // Group by hash+lang to aggregate candidates
        const syncByHashLang = new Map();
        for (const result of syncResults) {
          const key = `${result.hash}_${result.lang}`;
          if (!syncByHashLang.has(key)) {
            syncByHashLang.set(key, { hash: result.hash, lang: result.lang, subs: [] });
          }
          if (result.subs?.length) {
            syncByHashLang.get(key).subs.push(...result.subs);
          }
        }

        // Build xSync entries from aggregated results
        for (const [, { hash, lang, subs: syncedSubs }] of syncByHashLang) {
          if (syncedSubs && syncedSubs.length > 0) {
            const langCandidates = buildLangCandidates(lang);
            const langName = getLanguageName(lang) || getLanguageName(langCandidates[0]) || lang;
            log.debug(() => `[Subtitles] Found ${syncedSubs.length} synced subtitle(s) for ${langName} (hash=${hash})`);

            for (let i = 0; i < syncedSubs.length; i++) {
              const syncedSub = syncedSubs[i];
              const seenKey = syncedSub.cacheKey || `${hash}_${lang}_${i}`;
              if (seenSync.has(seenKey)) continue;
              seenSync.add(seenKey);
              xSyncEntries.push({
                id: `xsync_${seenKey}`,
                lang: `xSync ${langName}${syncedSubs.length > 1 ? ` #${i + 1}` : ''}`,
                url: `{{ADDON_URL}}/xsync/${hash}/${lang}/${syncedSub.sourceSubId}`
              });
            }
          }
        }

        if (xSyncEntries.length > 0) {
          log.debug(() => `[Subtitles] Added ${xSyncEntries.length} xSync entries`);
        }
      }

      // Add xEmbed entries (translated embedded tracks from cache)
      // Performance: Reuse pre-fetched Maps instead of calling cache again
      const xEmbedEntries = [];
      const xEmbedOriginalEntries = [];
      if (videoHashes.length && expandedLangs.size > 0) {
        try {
          const seenKeys = new Set();
          const seenOriginals = new Set();
          for (const hash of videoHashes) {
            // Use pre-cached translations (fetched earlier in parallel)
            const translations = embeddedTranslationsByHash.get(hash) || [];
            for (const entry of translations) {
              if (!entry || !entry.trackId) continue;
              const targetCode = (entry.targetLanguageCode || entry.languageCode || '').toString().toLowerCase();
              if (!targetCode) continue;
              const normalizedTarget = normalizeLanguageCode(targetCode);
              if (!normalizedTarget || !expandedLangs.has(normalizedTarget)) continue; // only show for configured languages
              const dedupeKey = `${entry.trackId}_${targetCode}`;
              if (seenKeys.has(dedupeKey)) continue;
              seenKeys.add(dedupeKey);

              const langName = getLanguageName(normalizedTarget) || getLanguageName(targetCode) || targetCode;
              xEmbedEntries.push({
                id: `xembed_${entry.cacheKey}`,
                lang: `xEmbed (${langName})`,
                url: `{{ADDON_URL}}/xembedded/${hash}/${targetCode}/${entry.trackId}`
              });
            }

            // Use pre-cached originals (fetched earlier in parallel) - avoids duplicate call!
            const originals = embeddedOriginalsByHash.get(hash) || [];
            for (const entry of originals) {
              if (!entry || !entry.trackId) continue;
              const sourceCode = (entry.languageCode || '').toString().toLowerCase();
              if (!sourceCode) continue;
              const normalizedSource = normalizeLanguageCode(sourceCode);
              if (!normalizedSource || !expandedLangs.has(normalizedSource)) continue; // only show for configured languages
              const dedupeKey = `${entry.trackId}_${sourceCode}`;
              if (seenOriginals.has(dedupeKey)) continue;
              seenOriginals.add(dedupeKey);

              xEmbedOriginalEntries.push({
                id: `xembed_orig_${entry.cacheKey}`,
                lang: sourceCode,
                url: `{{ADDON_URL}}/xembedded/${hash}/${sourceCode}/${entry.trackId}/original`
              });
            }
          }
          if (xEmbedEntries.length > 0) {
            log.debug(() => `[Subtitles] Added ${xEmbedEntries.length} xEmbed entries`);
          }
          if (xEmbedOriginalEntries.length > 0) {
            log.debug(() => `[Subtitles] Added ${xEmbedOriginalEntries.length} xEmbed original entries`);
          }
        } catch (error) {
          log.error(() => [`[Subtitles] Failed to get xEmbed entries for ${videoHashes.join(',')}:`, error.message]);
        }
      }

      // ── SMDB entries (community-uploaded subtitles) ──────────────────────────
      const smdbEntries = [];
      if (primaryVideoHash) {
        try {
          // Start with directly-available hashes
          const directHashes = new Set();
          if (hasRealStremioHash && extra.videoHash) directHashes.add(extra.videoHash);
          directHashes.add(primaryVideoHash);

          // Expand via persistent hash mappings (stremioHash ↔ derivedHash stored in Redis)
          // This ensures subtitles uploaded under one hash are found even when only the other is available
          const expansionPromises = [...directHashes].map(h => smdbCache.getAssociatedHashes(h));
          const expansionResults = await Promise.all(expansionPromises);
          const smdbHashes = [...new Set(expansionResults.flat().filter(Boolean))];

          if (smdbHashes.length > directHashes.size) {
            log.debug(() => `[Subtitles] SMDB hash expansion: ${directHashes.size} direct → ${smdbHashes.length} total hashes`);
          }

          const smdbSubs = await smdbCache.listSubtitlesMultiHash(smdbHashes);
          for (const sub of smdbSubs) {
            const langName = getLanguageName(sub.languageCode) || sub.languageCode;
            smdbEntries.push({
              id: `smdb_${sub.videoHash}_${sub.languageCode}`,
              lang: `SMDB (${langName})`,
              url: `{{ADDON_URL}}/smdb/${sub.videoHash}/${sub.languageCode}.srt`
            });
          }
          if (smdbEntries.length > 0) {
            log.debug(() => `[Subtitles] Added ${smdbEntries.length} SMDB entries`);
          }
        } catch (error) {
          log.error(() => [`[Subtitles] Failed to get SMDB entries:`, error.message]);
        }
      }

      // Add special action buttons
      let allSubtitles = [
        ...stremioSubtitles,
        ...translationEntries,
        ...learnEntries,
        ...xSyncEntries,
        ...xEmbedOriginalEntries,
        ...xEmbedEntries,
        ...smdbEntries
      ];

      // If OpenSubtitles auth failed, append a final entry per language with a helpful SRT
      if (openSubsAuthFailed === true) {
        try {
          const languagesForAuthError = config.noTranslationMode
            ? (config.noTranslationLanguages || [])
            : config.sourceLanguages;
          const normalizedLangs = [...new Set(languagesForAuthError.map(lang => normalizeLanguageCode(lang)))].filter(Boolean);
          const authEntries = normalizedLangs.map(lang => ({
            id: `opensubtitles_auth_error_${lang}`,
            lang: lang,
            url: `{{ADDON_URL}}/error-subtitle/opensubtitles-auth.srt`
          }));
          if (authEntries.length > 0) {
            allSubtitles = [...allSubtitles, ...authEntries];
            log.debug(() => `[Subtitles] Appended ${authEntries.length} OpenSubtitles auth-fix entries at end of language lists`);
          }
        } catch (e) {
          log.warn(() => `[Subtitles] Failed to append OpenSubtitles auth hint entries: ${e.message}`);
        }
      }

      // Add unified Sub Toolbox action button
      const t = getTranslator(config.uiLanguage || 'en');
      let actionButtons = [];
      if (toolboxEnabled) {
        const toolboxEntry = {
          id: 'sub_toolbox',
          lang: t('subtitle.subToolboxLabel', {}, 'Sub Toolbox'),
          url: `{{ADDON_URL}}/sub-toolbox/${id}?filename=${encodeURIComponent(streamFilename || '')}`
        };
        actionButtons.push(toolboxEntry);
        log.debug(() => '[Subtitles] Sub Toolbox is enabled, added entry');
      }

      // Put action buttons at the top
      allSubtitles = [...actionButtons, ...allSubtitles];

      // Prepend credential warning entry if decryption failed
      // This goes at the very top so users notice the issue
      if (config.__credentialWarningEntry) {
        allSubtitles = [config.__credentialWarningEntry, ...allSubtitles];
        log.debug(() => '[Subtitles] Prepended credential decryption warning entry');
      }

      // Calculate total items for logging (AFTER all entries added including credential warning)
      const totalResponseItems = allSubtitles.length;
      const handlerDuration = Date.now() - handlerStartTime;
      log.info(() => `[Subtitles] Response: ${totalResponseItems} items in ${handlerDuration}ms (${stremioSubtitles.length} subs, ${translationEntries.length} trans, ${xSyncEntries.length + xEmbedEntries.length} cached)`);

      return {
        subtitles: allSubtitles
      };

    } catch (error) {
      const handlerDuration = Date.now() - handlerStartTime;
      // Pass Error object in array so Sentry captures it (especially for TypeErrors/programming bugs)
      log.error(() => [`[Subtitles] Handler error after ${handlerDuration}ms: ${error.message}`, error]);
      return { subtitles: [] };
    }
  };
}

/**
 * Handle subtitle download
 * 
 * NOTE: This function may be called automatically by Stremio when loading streams.
 * Stremio prefetches/validates subtitle URLs to check availability - this is normal
 * behavior and not a bug. The user may not have explicitly selected a subtitle.
 * 
 * @param {string} fileId - Subtitle file ID
 * @param {string} language - Language code
 * @param {Object} config - Addon configuration
 * @returns {Promise<string>} - Subtitle content
 */
async function handleSubtitleDownload(fileId, language, config) {
  if (config?.__sessionTokenError === true) {
    log.warn(() => '[Download] Blocked download because session token is missing/invalid');
    return createSessionTokenErrorSubtitle();
  }
  if (!config || typeof config.__configHash !== 'string' || !config.__configHash.length) {
    log.warn(() => '[Download] Blocked download because config hash is missing/invalid');
    return createSessionTokenErrorSubtitle();
  }

  // Normalize OpenSubtitles implementation/creds for downstream error handling and logs
  const openSubCfg = config.subtitleProviders?.opensubtitles || {};
  const openSubsImplementation = typeof openSubCfg.implementationType === 'string'
    ? openSubCfg.implementationType.trim().toLowerCase() || 'v3'
    : 'v3';
  const openSubsHasCreds = !!(openSubCfg.username && openSubCfg.password);

  try {
    log.debug(() => `[Download] Fetching subtitle ${fileId} for language ${language}`);

    // Download from the appropriate provider based on fileId format
    let content;

    // Download subtitle directly from provider (no memory caching)
    // Fixed download timeout (independent of search timeout config)
    const downloadTimeoutMs = 18000;

    const downloadPromise = (async () => {
      if (fileId.startsWith('subdl_')) {
        // SubDL subtitle
        if (!config.subtitleProviders?.subdl?.enabled) {
          throw new Error('SubDL provider is disabled');
        }

        const subdl = new SubDLService(config.subtitleProviders.subdl.apiKey);
        log.debug(() => '[Download] Downloading subtitle via SubDL API');
        return await subdl.downloadSubtitle(fileId, { timeout: downloadTimeoutMs, languageHint: language, skipAssConversion: config.convertAssToVtt === false && config.forceSRTOutput !== true });
      } else if (fileId.startsWith('subsource_')) {
        // SubSource subtitle
        if (!config.subtitleProviders?.subsource?.enabled) {
          throw new Error('SubSource provider is disabled');
        }

        const subsource = new SubSourceService(config.subtitleProviders.subsource.apiKey);
        log.debug(() => '[Download] Downloading subtitle via SubSource API');
        return await subsource.downloadSubtitle(fileId, { timeout: downloadTimeoutMs, languageHint: language, skipAssConversion: config.convertAssToVtt === false && config.forceSRTOutput !== true });
      } else if (fileId.startsWith('v3_')) {
        // OpenSubtitles V3 subtitle
        if (!config.subtitleProviders?.opensubtitles?.enabled) {
          throw new Error('OpenSubtitles provider is disabled');
        }

        const opensubtitlesV3 = new OpenSubtitlesV3Service();
        log.debug(() => '[Download] Downloading subtitle via OpenSubtitles V3 API');
        return await opensubtitlesV3.downloadSubtitle(fileId, { timeout: downloadTimeoutMs, languageHint: language, skipAssConversion: config.convertAssToVtt === false && config.forceSRTOutput !== true });
      } else if (fileId.startsWith('scs_')) {
        // Stremio Community Subtitles
        if (!config.subtitleProviders?.scs?.enabled) {
          throw new Error('SCS provider is disabled');
        }

        const scs = new StremioCommunitySubtitlesService();
        log.debug(() => '[Download] Downloading subtitle via SCS API');
        // Remove scs_ prefix to get the actual comm_ ID
        return await scs.downloadSubtitle(fileId.replace('scs_', ''), { timeout: downloadTimeoutMs, languageHint: language, skipAssConversion: config.convertAssToVtt === false && config.forceSRTOutput !== true });
      } else if (fileId.startsWith('wyzie_')) {
        // Wyzie Subs (free aggregator)
        if (!config.subtitleProviders?.wyzie?.enabled) {
          throw new Error('Wyzie Subs provider is disabled');
        }

        const wyzie = new WyzieSubsService();
        log.debug(() => '[Download] Downloading subtitle via Wyzie Subs API');
        return await wyzie.downloadSubtitle(fileId, { timeout: downloadTimeoutMs, languageHint: language, skipAssConversion: config.convertAssToVtt === false && config.forceSRTOutput !== true });
      } else if (fileId.startsWith('subsro_')) {
        // Subs.ro subtitle (Romanian subtitle database)
        if (!config.subtitleProviders?.subsro?.enabled) {
          throw new Error('Subs.ro provider is disabled');
        }

        const subsro = new SubsRoService(config.subtitleProviders.subsro.apiKey);
        log.debug(() => '[Download] Downloading subtitle via Subs.ro API');
        return await subsro.downloadSubtitle(fileId, { timeout: downloadTimeoutMs, languageHint: language, skipAssConversion: config.convertAssToVtt === false && config.forceSRTOutput !== true });
      } else {
        const wantsAuth = openSubsImplementation === 'auth';
        const missingCreds = wantsAuth && !openSubsHasCreds;
        if (missingCreds) {
          log.warn(() => '[Download] OpenSubtitles Auth selected without credentials; returning guidance subtitle instead of hitting basic quota');
          return createOpenSubtitlesAuthMissingSubtitle(config.uiLanguage || 'en');
        }

        // OpenSubtitles subtitle (Auth implementation - default)
        if (!config.subtitleProviders?.opensubtitles?.enabled) {
          throw new Error('OpenSubtitles provider is disabled');
        }

        const opensubtitles = new OpenSubtitlesService(config.subtitleProviders.opensubtitles);
        log.debug(() => '[Download] Downloading subtitle via OpenSubtitles Auth API');
        return await opensubtitles.downloadSubtitle(fileId, { timeout: downloadTimeoutMs, languageHint: language, skipAssConversion: config.convertAssToVtt === false && config.forceSRTOutput !== true });
      }
    })();

    // Wait for download to complete
    content = await downloadPromise;

    // Handle object returns from providers when skipAssConversion is enabled
    // In this case, the provider returns { content, format } instead of a string
    let subtitleFormat = null;
    if (content && typeof content === 'object' && content.content) {
      subtitleFormat = content.format; // 'ass' or 'ssa'
      content = content.content;
      log.debug(() => `[Download] Received original ${subtitleFormat?.toUpperCase() || 'ASS/SSA'} subtitle (conversion disabled)`);
    }

    // Validate content
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('Downloaded subtitle content is empty');
    }

    log.debug(() => '[Download] Subtitle downloaded successfully (' + content.length + ' bytes)');
    // Reject obviously broken/corrupted files by size (with intelligent content analysis)
    try {
      const minSize = Number(config.minSubtitleSizeBytes) || 200;
      const looksLikeInfoSubtitle = /episode s\d{2}e\d{2,4} not found in this subtitle pack/i.test(content)
        || /informational subtitle was generated by the addon/i.test(content)
        || /download failed:/i.test(content)
        || /subtitle pack is too large/i.test(content);

      if (content.length < minSize && !looksLikeInfoSubtitle) {
        // Analyze the content to provide better feedback
        const contentLower = content.toLowerCase();
        const trimmed = content.trim();

        // Check if it's actually a valid short subtitle (e.g., single credits line)
        const hasTimecodes = /\d{2}:\d{2}:\d{2}[,.:]\d{2,3}/.test(content);
        const hasMultipleLines = trimmed.split(/\r?\n/).filter(l => l.trim()).length >= 3;
        const looksLikeValidShort = hasTimecodes && hasMultipleLines;

        if (looksLikeValidShort) {
          // It looks like a valid but very short subtitle (credits, etc.) - allow it
          log.debug(() => `[Download] Small but valid-looking subtitle (${content.length} bytes, has ${trimmed.split(/\r?\n/).filter(l => l.trim()).length} lines)`);
        } else {
          // Analyze what we received for better error messaging
          let reason = 'The subtitle file is too small and seems corrupted.';

          if (contentLower.includes('<!doctype') || contentLower.includes('<html') || contentLower.includes('<head')) {
            reason = 'Received an HTML error page instead of subtitle content.';
            log.warn(() => `[Download] Content appears to be HTML (${content.length} bytes)`);
          } else if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            reason = 'Received a JSON error response instead of subtitle content.';
            log.warn(() => `[Download] Content appears to be JSON (${content.length} bytes)`);
          } else if (contentLower.includes('error') || contentLower.includes('not found') || contentLower.includes('denied')) {
            reason = 'The provider returned an error message instead of subtitle content.';
            log.warn(() => `[Download] Content appears to be an error message (${content.length} bytes)`);
          } else if (content.length < 50) {
            reason = `Response was only ${content.length} bytes - likely truncated or failed.`;
            log.warn(() => `[Download] Very short response: "${trimmed.slice(0, 100)}"`);
          } else {
            log.warn(() => `[Download] Subtitle content too small (${content.length} bytes < ${minSize}). First 100 chars: "${trimmed.slice(0, 100)}"`);
          }

          const effectiveUiLang = config.uiLanguage || 'en';
          log.debug(() => `[Download] Creating invalid subtitle message with uiLanguage=${effectiveUiLang} (raw config.uiLanguage=${config.uiLanguage})`);
          const tTooSmall = getTranslator(effectiveUiLang);
          return createInvalidSubtitleMessage(tTooSmall('subtitle.invalidSubtitleTooSmall', {}, reason), effectiveUiLang);
        }
      }
    } catch (_) { }

    // If we received original ASS/SSA (conversion disabled), return it directly
    // Skip the SRT conversion as user wants to preserve original styling
    if (subtitleFormat) {
      log.debug(() => `[Download] Returning original ${subtitleFormat.toUpperCase()} subtitle without conversion`);
      return content;
    }

    return maybeConvertToSRT(content, config);

  } catch (error) {
    const uiLanguage = config.uiLanguage || 'en';
    const t = getTranslator(uiLanguage);
    if (!error || !error._alreadyLogged) {
      log.warn(() => ['[Download] Error:', error?.message || String(error)]);
    }

    // Return error message as subtitle so user knows what happened
    const errorStatus = error.response?.status || error.statusCode;

    // Handle 429 errors - provider rate limiting
    if (errorStatus === 429 || String(error.message || '').includes('429') || error.type === 'rate_limit') {
      // Log which subtitle triggered the rate limit for easier debugging
      log.warn(() => `[Download] Rate limit while fetching ${fileId} (${language || 'unknown language'})`);

      // Special-case OpenSubtitles Auth: surface guidance so users know how to fix it
      // Must exclude all non-OpenSubtitles providers by prefix
      const isOpenSubsAuth = !fileId.startsWith('subdl_') && !fileId.startsWith('subsource_') && !fileId.startsWith('v3_') && !fileId.startsWith('wyzie_') && !fileId.startsWith('scs_') && !fileId.startsWith('subsro_');
      if (isOpenSubsAuth) {
        log.warn(() => `[Download] OpenSubtitles Auth rate limited (impl=${openSubsImplementation}, creds=${openSubsHasCreds ? 'set' : 'missing'}) for ${fileId}`);
        const hint = openSubsHasCreds
          ? t('subtitle.osAuthRateLimited', {}, 'OpenSubtitles is rate limiting your account. Wait a few minutes, then retry or switch to V3 in the addon config.')
          : t('subtitle.osAuthMissingRateLimited', {}, 'OpenSubtitles Auth mode is active without credentials, so downloads hit the basic rate limit. Add your username/password or switch to V3 (no login).');

        return ensureInformationalSubtitleSize(`1
00:00:00,000 --> 00:00:03,000
${t('subtitle.osRateLimitTitle', {}, 'OpenSubtitles rate limit reached (429)')}

2
00:00:03,001 --> 04:00:00,000
${hint}`, null, uiLanguage);
      }

      // Special-case OpenSubtitles V3: return a single-cue 0→4h error
      if (fileId.startsWith('v3_')) {
        return createOpenSubtitlesV3RateLimitSubtitle(config.uiLanguage || 'en');
      }

      // Determine which service based on fileId (generic two-cue fallback)
      let serviceName = 'Subtitle Provider';
      if (fileId.startsWith('subdl_')) serviceName = 'SubDL';
      else if (fileId.startsWith('subsource_')) serviceName = 'SubSource';
      else if (fileId.startsWith('scs_')) serviceName = 'Stremio Community Subtitles';
      else if (fileId.startsWith('wyzie_')) serviceName = 'Wyzie Subs';
      else if (fileId.startsWith('subsro_')) serviceName = 'Subs.ro';
      else if (!fileId.startsWith('v3_')) serviceName = 'OpenSubtitles';

      return ensureInformationalSubtitleSize(`1
00:00:00,000 --> 00:00:03,000
${t('subtitle.providerRateLimitTitle', { service: serviceName }, `${serviceName} rate limit reached (429)`)}

2
00:00:03,001 --> 04:00:00,000
${t('subtitle.providerRateLimitBody', {}, 'Too many requests in a short period.\nPlease wait a few minutes and try again.')}`, null, uiLanguage);
    }
    const rawMsg = (error.response?.data?.message || error.message || '').toString();
    const lowerMsg = rawMsg.toLowerCase();
    // CDN 403 (file unavailable) and rate-limit 403 (cannot consume) are NOT auth failures
    const is403ButNotAuth = errorStatus === 403 && (
      lowerMsg.includes('cdn') ||
      lowerMsg.includes('file unavailable') ||
      lowerMsg.includes('varnish') ||
      lowerMsg.includes('cannot consume') ||
      lowerMsg.includes('throttle') ||
      lowerMsg.includes('rate limit') ||
      lowerMsg.includes('too many')
    );
    const isAuthError =
      errorStatus === 401 ||
      (errorStatus === 403 && !is403ButNotAuth) ||
      lowerMsg.includes('authentication failed') ||
      lowerMsg.includes('invalid username/password');

    // Handle 401/403 errors - API key/authentication failures
    if (isAuthError) {
      // Determine which service based on fileId
      let serviceName = 'Subtitle Provider';
      let apiKeyInstructions = 'Please check your API key in the addon configuration.';

      if (fileId.startsWith('subdl_')) {
        serviceName = 'SubDL';
        apiKeyInstructions = 'SubDL API key error\nThen update your addon configuration and reinstall.';
      } else if (fileId.startsWith('subsource_')) {
        serviceName = 'SubSource';
        apiKeyInstructions = 'SubSource API key error\nPlease update your addon configuration and reinstall.';
      } else if (fileId.startsWith('scs_')) {
        serviceName = 'Stremio Community Subtitles';
        apiKeyInstructions = 'SCS download failed.\nThis may be a temporary issue with the community service.';
      } else if (fileId.startsWith('wyzie_')) {
        serviceName = 'Wyzie Subs';
        apiKeyInstructions = 'Wyzie Subs download failed.\nThis may be a temporary issue with the aggregator service.';
      } else if (fileId.startsWith('subsro_')) {
        serviceName = 'Subs.ro';
        apiKeyInstructions = 'Subs.ro API key error.\nPlease check your API key at subs.ro and update your addon configuration.';
      } else if (fileId.startsWith('v3_')) {
        serviceName = 'OpenSubtitles V3';
        apiKeyInstructions = 'OpenSubtitles v3 should not require an API key.\nPlease report this issue if it persists.';
      } else {
        serviceName = 'OpenSubtitles';
        apiKeyInstructions = 'Please check your OpenSubtitles credentials\nin the addon configuration and reinstall.';
      }

      return ensureInformationalSubtitleSize(`1
00:00:00,000 --> 00:00:03,000
${t('subtitle.providerAuthErrorTitle', {}, 'Authentication Error')}

2
00:00:03,001 --> 00:00:06,000
${t('subtitle.providerAuthErrorBody', { service: serviceName }, `${serviceName} rejected your API key or credentials`)}

3
00:00:06,001 --> 04:00:00,000
${apiKeyInstructions}`, null, uiLanguage);
    }

    // Handle 404 errors specifically - subtitle not available
    if (errorStatus === 404 || error.message.includes('Subtitle not available') || error.message.includes('404')) {
      return ensureInformationalSubtitleSize(`1
00:00:00,000 --> 04:00:00,000
${t('subtitle.notAvailableTitle', {}, 'Subtitle Not Available (Error 404)')}\n${t('subtitle.notAvailableBody', {}, 'This often happens with subtitles that were removed.\nPlease try a different subtitle from the list')}`, null, uiLanguage);
    }

    if (errorStatus === 503) {
      // Special-case OpenSubtitles V3: return a single-cue 0→4h error
      if (fileId.startsWith('v3_')) {
        return createOpenSubtitlesV3ServiceUnavailableSubtitle(config.uiLanguage || 'en');
      }

      // Determine service name for provider-specific messaging
      let serviceName = 'Subtitle Provider';
      if (fileId.startsWith('subdl_')) serviceName = 'SubDL';
      else if (fileId.startsWith('subsource_')) serviceName = 'SubSource';
      else if (fileId.startsWith('scs_')) serviceName = 'Stremio Community Subtitles';
      else if (fileId.startsWith('wyzie_')) serviceName = 'Wyzie Subs';
      else if (fileId.startsWith('subsro_')) serviceName = 'Subs.ro';
      else serviceName = 'OpenSubtitles';

      return ensureInformationalSubtitleSize(`1
00:00:00,000 --> 04:00:00,000
${t('subtitle.providerUnavailableTitle', { service: serviceName }, `${serviceName} temporarily unavailable (Error 503)`)}
${t('subtitle.providerUnavailableBody', {}, 'Please try again in a few minutes or try a different subtitle.')}`, null, uiLanguage);
    }

    // Handle 500/502/504 gateway/server errors
    if (errorStatus === 500 || errorStatus === 502 || errorStatus === 504) {
      // Determine service name for provider-specific messaging
      let serviceName = 'Subtitle Provider';
      if (fileId.startsWith('subdl_')) serviceName = 'SubDL';
      else if (fileId.startsWith('subsource_')) serviceName = 'SubSource';
      else if (fileId.startsWith('v3_')) serviceName = 'OpenSubtitles V3';
      else if (fileId.startsWith('scs_')) serviceName = 'Stremio Community Subtitles';
      else if (fileId.startsWith('wyzie_')) serviceName = 'Wyzie Subs';
      else if (fileId.startsWith('subsro_')) serviceName = 'Subs.ro';
      else serviceName = 'OpenSubtitles';

      const errorLabel = errorStatus === 500 ? 'Internal Server Error' : errorStatus === 502 ? 'Bad Gateway' : 'Gateway Timeout';
      return ensureInformationalSubtitleSize(`1
00:00:00,000 --> 04:00:00,000
${t('subtitle.providerServerErrorTitle', { service: serviceName, code: errorStatus }, `${serviceName} server error (${errorStatus} ${errorLabel})`)}
${t('subtitle.providerServerErrorBody', {}, 'The subtitle server is experiencing issues.\nPlease try again in a few minutes or pick a different subtitle.')}`, null, uiLanguage);
    }


    // Handle OpenSubtitles daily quota exceeded (HTTP 406 with specific message)
    // Only applies to OpenSubtitles Auth (v1) path where fileId has no provider prefix
    if (!fileId.startsWith('subdl_') && !fileId.startsWith('subsource_') && !fileId.startsWith('v3_') && !fileId.startsWith('wyzie_') && !fileId.startsWith('scs_') && !fileId.startsWith('subsro_')) {
      const isOsQuota = (errorStatus === 406) ||
        lowerMsg.includes('allowed 20 subtitles') ||
        (lowerMsg.includes('quota') && lowerMsg.includes('renew'));
      if (isOsQuota) {
        return createOpenSubtitlesQuotaExceededSubtitle(config.uiLanguage || 'en');
      }
    }

    // Handle SubSource download timeouts with a user-facing subtitle (0 -> 4h)
    // Detect axios-style timeout/network signals and fileId prefix
    const msg = String(error.message || '');
    const origMsg = String(error.originalError?.message || '');
    const origCode = error.originalError?.code;
    const isTimeout = (
      error.type === 'timeout' ||
      error.code === 'ECONNABORTED' ||
      error.code === 'ETIMEDOUT' ||
      origCode === 'ECONNABORTED' ||
      origCode === 'ETIMEDOUT' ||
      /timeout|timed out|time out/i.test(msg) ||
      /timeout|timed out|time out/i.test(origMsg)
    );
    if (fileId.startsWith('subsource_') && isTimeout) {
      log.warn(() => '[SubSource] Request timed out during download - informing user via subtitle');
      return ensureInformationalSubtitleSize(`1
00:00:00,000 --> 04:00:00,000
${t('subtitle.subsourceTimeoutTitle', {}, 'SubSource download failed (timeout)')}
${t('subtitle.subsourceTimeoutBody', {}, 'SubSource API did not respond in time. Try again in a few minutes or pick a different subtitle.')}`, null, uiLanguage);
    }

    // SubDL timeout
    if (fileId.startsWith('subdl_') && isTimeout) {
      log.warn(() => '[SubDL] Request timed out during download - informing user via subtitle');
      return createProviderDownloadErrorSubtitle('SubDL', 'SubDL API did not respond in time. Try again in a few minutes or pick a different subtitle.', config.uiLanguage || 'en');
    }

    // Wyzie Subs timeout
    if (fileId.startsWith('wyzie_') && isTimeout) {
      log.warn(() => '[Wyzie] Request timed out during download - informing user via subtitle');
      return createProviderDownloadErrorSubtitle('Wyzie Subs', 'Wyzie Subs did not respond in time. Try again in a few minutes or pick a different subtitle.', config.uiLanguage || 'en');
    }

    // Stremio Community Subtitles (SCS) timeout
    if (fileId.startsWith('scs_') && isTimeout) {
      log.warn(() => '[SCS] Request timed out during download - informing user via subtitle');
      return createProviderDownloadErrorSubtitle('Stremio Community Subtitles', 'The community subtitle server did not respond in time. Try again in a few minutes or pick a different subtitle.', config.uiLanguage || 'en');
    }

    // OpenSubtitles V3 timeout
    if (fileId.startsWith('v3_') && isTimeout) {
      log.warn(() => '[OpenSubtitles V3] Request timed out during download - informing user via subtitle');
      return createProviderDownloadErrorSubtitle('OpenSubtitles V3', 'OpenSubtitles V3 did not respond in time. Try again in a few minutes or pick a different subtitle.', config.uiLanguage || 'en');
    }

    // Subs.ro timeout
    if (fileId.startsWith('subsro_') && isTimeout) {
      log.warn(() => '[Subs.ro] Request timed out during download - informing user via subtitle');
      return createProviderDownloadErrorSubtitle('Subs.ro', 'Subs.ro did not respond in time. Try again in a few minutes or pick a different subtitle.', config.uiLanguage || 'en');
    }

    // OpenSubtitles Auth timeout (no prefix = OS Auth)
    const isOpenSubsAuth = !fileId.startsWith('subdl_') && !fileId.startsWith('subsource_') && !fileId.startsWith('v3_') && !fileId.startsWith('wyzie_') && !fileId.startsWith('scs_') && !fileId.startsWith('subsro_');
    if (isOpenSubsAuth && isTimeout) {
      log.warn(() => '[OpenSubtitles Auth] Request timed out during download - informing user via subtitle');
      return createProviderDownloadErrorSubtitle('OpenSubtitles', 'OpenSubtitles did not respond in time. Try again in a few minutes or pick a different subtitle.', config.uiLanguage || 'en');
    }

    // Handle network-level errors (connection refused, DNS failures, connection reset, SSL errors)
    const errorCode = error.code || error.originalError?.code || '';
    const isNetworkError = (
      errorCode === 'ECONNREFUSED' ||
      errorCode === 'ENOTFOUND' ||
      errorCode === 'ECONNRESET' ||
      errorCode === 'EHOSTUNREACH' ||
      errorCode === 'ENETUNREACH' ||
      /ssl|tls|certificate|cert/i.test(msg) ||
      /ssl|tls|certificate|cert/i.test(origMsg) ||
      /EPROTO|ERR_SSL/i.test(errorCode)
    );

    if (isNetworkError) {
      // Determine service name for provider-specific messaging
      let serviceName = 'Subtitle Provider';
      if (fileId.startsWith('subdl_')) serviceName = 'SubDL';
      else if (fileId.startsWith('subsource_')) serviceName = 'SubSource';
      else if (fileId.startsWith('v3_')) serviceName = 'OpenSubtitles V3';
      else if (fileId.startsWith('scs_')) serviceName = 'Stremio Community Subtitles';
      else if (fileId.startsWith('wyzie_')) serviceName = 'Wyzie Subs';
      else if (fileId.startsWith('subsro_')) serviceName = 'Subs.ro';
      else serviceName = 'OpenSubtitles';

      let networkErrorReason = 'Could not connect to the subtitle server.';
      if (errorCode === 'ECONNREFUSED') networkErrorReason = 'Connection refused by the subtitle server.';
      else if (errorCode === 'ENOTFOUND') networkErrorReason = 'Could not resolve the subtitle server address (DNS error).';
      else if (errorCode === 'ECONNRESET') networkErrorReason = 'Connection was reset by the subtitle server.';
      else if (errorCode === 'EHOSTUNREACH' || errorCode === 'ENETUNREACH') networkErrorReason = 'The subtitle server is unreachable.';
      else if (/ssl|tls|certificate|cert|EPROTO|ERR_SSL/i.test(`${errorCode} ${msg} ${origMsg}`)) networkErrorReason = 'SSL/TLS connection error with the subtitle server.';

      log.warn(() => `[Download] Network error for ${fileId}: ${errorCode} - ${networkErrorReason}`);
      return createProviderDownloadErrorSubtitle(serviceName, `${networkErrorReason} Try again later or pick a different subtitle.`, config.uiLanguage || 'en');
    }

    // Handle corrupted/missing payloads (HTML/error pages, invalid ZIPs) across providers
    const message = String(error.message || '');
    const originalMessage = String(error.originalError?.message || '');
    const combined = `${message} ${originalMessage}`.toLowerCase();
    const looksLikeHtmlError = combined.includes('error page') || combined.includes('<!doctype') || combined.includes('<html');
    const looksLikeBadZip = combined.includes('invalid zip') || combined.includes('not a valid zip') || combined.includes('central directory');

    if (fileId.startsWith('subdl_') && (looksLikeHtmlError || looksLikeBadZip)) {
      return createProviderDownloadErrorSubtitle('SubDL', 'SubDL returned an error page instead of the subtitle file. It may have been removed.', config.uiLanguage || 'en');
    }

    if (fileId.startsWith('subsource_') && (looksLikeHtmlError || looksLikeBadZip)) {
      return createProviderDownloadErrorSubtitle('SubSource', 'The SubSource file looked corrupted or missing. The subtitle might have been removed.', config.uiLanguage || 'en');
    }

    if (fileId.startsWith('v3_') && (looksLikeHtmlError || looksLikeBadZip)) {
      return createProviderDownloadErrorSubtitle('OpenSubtitles V3', 'The download response was invalid. Please try another subtitle.', config.uiLanguage || 'en');
    }

    if (fileId.startsWith('subsro_') && (looksLikeHtmlError || looksLikeBadZip)) {
      return createProviderDownloadErrorSubtitle('Subs.ro', 'The download response was invalid. The subtitle may have been removed from subs.ro.', config.uiLanguage || 'en');
    }

    if (fileId.startsWith('wyzie_') && (looksLikeHtmlError || looksLikeBadZip)) {
      return createProviderDownloadErrorSubtitle('Wyzie Subs', 'The download response was invalid. The subtitle may have been removed or the source is unavailable.', config.uiLanguage || 'en');
    }

    if (fileId.startsWith('scs_') && (looksLikeHtmlError || looksLikeBadZip)) {
      return createProviderDownloadErrorSubtitle('Stremio Community Subtitles', 'The download response was invalid. The subtitle may have been removed from the community database.', config.uiLanguage || 'en');
    }

    if (!fileId.startsWith('subdl_') && !fileId.startsWith('subsource_') && !fileId.startsWith('v3_') && !fileId.startsWith('wyzie_') && !fileId.startsWith('scs_') && !fileId.startsWith('subsro_') && (looksLikeHtmlError || looksLikeBadZip)) {
      return createProviderDownloadErrorSubtitle('OpenSubtitles', 'The download response was invalid. Please try another subtitle.', config.uiLanguage || 'en');
    }

    // Generic fallback for any unhandled errors - return informational subtitle instead of throwing
    // This ensures users ALWAYS see a helpful message instead of a generic 404
    log.warn(() => `[Download] Unhandled error for ${fileId}: ${error.message || error}`);

    // Determine service name for fallback message
    let fallbackServiceName = 'Subtitle Provider';
    if (fileId.startsWith('subdl_')) fallbackServiceName = 'SubDL';
    else if (fileId.startsWith('subsource_')) fallbackServiceName = 'SubSource';
    else if (fileId.startsWith('v3_')) fallbackServiceName = 'OpenSubtitles V3';
    else if (fileId.startsWith('scs_')) fallbackServiceName = 'Stremio Community Subtitles';
    else if (fileId.startsWith('wyzie_')) fallbackServiceName = 'Wyzie Subs';
    else if (fileId.startsWith('subsro_')) fallbackServiceName = 'Subs.ro';
    else fallbackServiceName = 'OpenSubtitles';

    return createProviderDownloadErrorSubtitle(
      fallbackServiceName,
      `Download failed unexpectedly. Please try a different subtitle or try again later.`,
      config.uiLanguage || 'en'
    );
  }
}

/**
 * Handle translation request with race-condition protection
 * Prevents multiple simultaneous translation requests for the same subtitle/language pair
 * @param {string} sourceFileId - Source subtitle file ID
 * @param {string} targetLanguage - Target language code
 * @param {Object} config - Addon configuration
 * @param {Object} options - Optional behavior flags
 * @returns {Promise<string>} - Translated subtitle content or loading message
 */
async function handleTranslation(sourceFileId, targetLanguage, config, options = {}) {
  try {
    log.debug(() => `[Translation] Handling translation request for ${sourceFileId} to ${targetLanguage}`);

    if (config?.__sessionTokenError === true) {
      log.warn(() => '[Translation] Blocked translation because session token is missing/invalid');
      return createSessionTokenErrorSubtitle();
    }
    if (!config || typeof config.__configHash !== 'string' || !config.__configHash.length) {
      log.warn(() => '[Translation] Blocked translation because config hash is missing/invalid');
      return createSessionTokenErrorSubtitle();
    }

    const waitForFullTranslation = options.waitForFullTranslation === true;
    const mobileWaitTimeoutMs = waitForFullTranslation ? getMobileWaitTimeoutMs(config) : null;

    // If translating an xEmbed original, pull source directly from embedded cache
    let embeddedSource = null;
    let embeddedSourceContent = null;
    if (sourceFileId.startsWith('xembed_')) {
      const cacheKey = sourceFileId.replace(/^xembed_/, '');
      try {
        const embeddedEntry = await embeddedCache.getEmbeddedByCacheKey(cacheKey);
        if (embeddedEntry && embeddedEntry.content && embeddedEntry.type === 'original') {
          embeddedSource = {
            cacheKey,
            videoHash: embeddedEntry.videoHash,
            trackId: embeddedEntry.trackId,
            languageCode: canonicalSyncLanguageCode(embeddedEntry.languageCode || 'und') || 'und',
            metadata: embeddedEntry.metadata || {}
          };
          embeddedSourceContent = embeddedEntry.content;
          log.debug(() => `[Translation] Using embedded ORIGINAL source from cache ${cacheKey} (${embeddedSource.languageCode})`);
        } else {
          const type = embeddedEntry?.type || 'unknown';
          log.warn(() => `[Translation] Embedded source not usable for ${sourceFileId} (type=${type})`);
        }
      } catch (err) {
        log.warn(() => [`[Translation] Failed to load embedded source ${sourceFileId}:`, err.message]);
      }
    }

    // Generate cache keys using shared utility (single source of truth for cache key scoping)
    const { baseKey, cacheKey, runtimeKey, bypass, bypassEnabled, userHash, allowPermanent } = generateCacheKeys(
      config,
      sourceFileId,
      targetLanguage
    );
    // Generate a unique ID for this translation request to track it
    const requestId = crypto.randomUUID();
    const historyUserHash = resolveHistoryUserHash(config, userHash);
    const historyEnabled = !!historyUserHash;
    if (!historyEnabled) {
      auditHistorySkip('missing user hash for translation history', {
        requestId,
        sourceFileId,
        targetLanguage
      });
    }
    // Shared in-flight key for permanent translations so other configs don't start duplicate work
    const sharedInFlightKey = (!bypass && allowPermanent && ENABLE_PERMANENT_TRANSLATIONS) ? baseKey : null;
    const sharedLockKey = sharedInFlightKey || runtimeKey;

    log.debug(() => `[Translation] Cache key: ${cacheKey} (bypass: ${bypass && bypassEnabled}, runtimeKey=${runtimeKey})`);

    let historyEntry = null;
    const isPlaceholder = (val) => {
      const v = (val || '').toString().trim().toLowerCase();
      if (!v) return true;
      return v === 'stream and refresh' || v === 'unknown' || v === 'unknown title';
    };
    const pickBest = (...candidates) => {
      for (const c of candidates) {
        if (c === undefined || c === null) continue;
        const str = c.toString().trim();
        if (!str) continue;
        if (isPlaceholder(str)) continue;
        return str;
      }
      return '';
    };

    const ensureHistoryEntry = () => {
      if (!historyEnabled) return false;
      if (historyEntry) return true;
      const metaKey = `${config.__configHash || config.userHash || 'default'}:${sourceFileId}`;
      const cachedMeta = translationSourceMeta.get(metaKey) || {};
      const latestStream = (() => {
        try {
          return config?.__configHash ? streamActivity.getLatestStreamActivity(config.__configHash) : null;
        } catch (_) {
          return null;
        }
      })();
      const fallbackFilename = pickBest(
        options.filename,
        cachedMeta.filename,
        cachedMeta.title,
        latestStream?.filename,
        config?.lastStream?.filename,
        config?.streamFilename,
        options.sourceFileId,
        sourceFileId
      ) || 'unknown';
      const fallbackVideoId = pickBest(
        options.videoId,
        cachedMeta.videoId,
        latestStream?.videoId,
        config?.lastStream?.videoId,
        config?.videoId
      ) || 'unknown';
      const fallbackSourceLang =
        options.sourceLanguage
        || (Array.isArray(config.sourceLanguages) && config.sourceLanguages[0])
        || 'auto';
      const videoHash = deriveVideoHash(fallbackFilename, fallbackVideoId || sourceFileId || '');
      historyEntry = {
        id: requestId,
        status: 'processing',
        scope: options.from || 'standard',
        title: fallbackFilename,
        filename: fallbackFilename,
        videoId: fallbackVideoId,
        videoHash: videoHash || '',
        sourceFileId: options.sourceFileId || sourceFileId || 'unknown',
        sourceLanguage: fallbackSourceLang, // Will update if detected
        targetLanguage: targetLanguage,
        createdAt: Date.now(),
        provider: config.mainProvider || 'unknown',
        model: config.geminiModel || 'default'
      };
      saveRequestToHistory(historyUserHash, historyEntry).catch(err => {
        log.warn(() => [`[History] Failed to save initial history for ${requestId}:`, err.message]);
      });
      // Best-effort metadata enrichment (async, non-blocking)
      resolveHistoryTitle(options.videoId || '', fallbackFilename, options.season, options.episode)
        .then(meta => {
          updateHistory(null, {
            title: meta.title,
            season: meta.season,
            episode: meta.episode,
            videoHash: videoHash || historyEntry.videoHash,
            videoId: historyEntry.videoId === 'unknown' ? (options.videoId || cachedMeta.videoId || meta.videoId || historyEntry.videoId) : historyEntry.videoId
          });
        })
        .catch(() => { /* ignore */ });
      return true;
    };
    const updateHistory = (status, extra = {}) => {
      if (!historyEnabled || !historyEntry) return;
      if (status) historyEntry.status = status;
      if ((status === 'completed' || status === 'failed') && !historyEntry.completedAt) {
        historyEntry.completedAt = Date.now();
      }
      if (extra && extra.cacheKey && !historyEntry.cacheKey) {
        historyEntry.cacheKey = extra.cacheKey;
      }
      if (extra && extra.sourceLanguage && (!historyEntry.sourceLanguage || historyEntry.sourceLanguage === 'auto')) {
        historyEntry.sourceLanguage = extra.sourceLanguage;
      }
      Object.assign(historyEntry, extra);
      saveRequestToHistory(historyUserHash, historyEntry).catch(err => {
        log.warn(() => [`[History] Failed to save history update for ${requestId}:`, err.message]);
      });
      if (historyEntry.status === 'completed' || historyEntry.status === 'failed') {
        try {
          const metaKey = `${config.__configHash || config.userHash || 'default'}:${sourceFileId}`;
          translationSourceMeta.delete(metaKey);
        } catch (_) { /* ignore */ }
      }
    };



    if (bypass) {
      // Skip reading permanent cache; optionally read bypass cache
      if (bypassEnabled) {
        const bypassCached = await readFromBypassStorage(cacheKey);
        if (bypassCached) {
          // SECURITY: Validate that the cached entry belongs to this user
          // This prevents cache poisoning and ensures user isolation
          if (bypassCached.configHash && bypassCached.configHash !== userHash) {
            log.warn(() => `[Translation] Bypass cache configHash mismatch for key=${cacheKey} (cached: ${bypassCached.configHash}, current: ${userHash}) - treating as cache miss`);
            // Don't return the cached entry - treat as cache miss
            // This shouldn't happen normally, but protects against cache key collisions
          } else if (!bypassCached.configHash) {
            log.warn(() => `[Translation] Bypass cache entry missing configHash for key=${cacheKey} - treating as cache miss for security`);
            // Legacy entry without configHash - treat as cache miss for security
          } else {
            // Valid cache entry with matching configHash
            // Check if this is a cached error
            if (bypassCached.isError === true) {
              log.debug(() => ['[Translation] Cached error found (bypass) key=', cacheKey, 'â€” showing error and clearing cache']);
              const errorSrt = createTranslationErrorSubtitle(bypassCached.errorType, bypassCached.errorMessage, config.uiLanguage || 'en', bypassCached.errorProvider);

              // Delete the error cache so next click retries translation
              const adapter = await getStorageAdapter();
              try {
                await adapter.delete(cacheKey, StorageAdapter.CACHE_TYPES.BYPASS);
                log.debug(() => '[Translation] Cleared error cache for retry');
              } catch (e) {
                log.warn(() => ['[Translation] Failed to delete error cache:', e.message]);
              }

              return errorSrt;
            }

            log.debug(() => ['[Translation] Cache hit (bypass) key=', cacheKey, 'userHash=', userHash, 'â€” serving cached translation']);
            cacheMetrics.hits++;
            cacheMetrics.estimatedCostSaved += 0.004;
            return bypassCached.content || bypassCached;
          }
        }
      }
    } else if (allowPermanent && ENABLE_PERMANENT_TRANSLATIONS) {
      const cached = await readFromStorage(baseKey);
      if (cached) {
        // Check if this is a cached error
        if (cached.isError === true) {
          log.debug(() => ['[Translation] Cached error found (permanent) key=', cacheKey, ' - showing error and clearing cache']);
          const errorSrt = createTranslationErrorSubtitle(cached.errorType, cached.errorMessage, config.uiLanguage || 'en', cached.errorProvider);

          // Delete the error cache so next click retries translation
          const adapter = await getStorageAdapter();
          try {
            await adapter.delete(getTranslationStorageKey(baseKey), StorageAdapter.CACHE_TYPES.TRANSLATION);
            log.debug(() => '[Translation] Cleared error cache for retry');
          } catch (e) {
            log.warn(() => ['[Translation] Failed to delete error cache:', e.message]);
          }

          return errorSrt;
        }

        log.debug(() => ['[Translation] Cache hit (permanent) key=', cacheKey, ' - serving cached translation']);
        cacheMetrics.hits++;
        cacheMetrics.estimatedCostSaved += 0.004; // Estimated $0.004 per translation
        return cached.content || cached;
      }
    } else {
      log.debug(() => `[Translation] Permanent cache disabled for this request (allowPermanent=${allowPermanent}, flag=${ENABLE_PERMANENT_TRANSLATIONS})`);
    }

    // Cache miss
    cacheMetrics.misses++;
    log.debug(() => ['[Translation] Cache miss key=', cacheKey, 'â€” not cached']);

    // === RACE CONDITION PROTECTION ===
    // Check if there's already an in-flight request for this exact key
    // All simultaneous requests will share the same promise
    const inFlightPromise = inFlightTranslations.get(runtimeKey)
      || (sharedInFlightKey ? inFlightTranslations.get(sharedInFlightKey) : null);
    if (inFlightPromise) {
      log.debug(() => `[Translation] Detected in-flight translation for key=${sharedInFlightKey || runtimeKey}; ${waitForFullTranslation ? 'waiting for completion (mobile mode)' : 'checking for partial results'}`);
      try {
        if (waitForFullTranslation) {
          const waitedResult = await waitForFinalCachedTranslation(
            baseKey,
            cacheKey,
            { bypass, bypassEnabled, userHash, allowPermanent: allowPermanent && ENABLE_PERMANENT_TRANSLATIONS, uiLanguage: config.uiLanguage || 'en' },
            mobileWaitTimeoutMs
          );

          if (waitedResult) {
            log.debug(() => `[Translation] Mobile mode: returning final result after wait for key=${cacheKey}`);
            return waitedResult;
          }

          log.warn(() => `[Translation] Mobile mode wait timed out without final result for key=${cacheKey}`);
          return createTranslationErrorSubtitle('other', 'Translation did not finish in time. Please retry.', config.uiLanguage || 'en');
        } else {
          // DON'T WAIT for completion - immediately return available partials instead
          // Check storage first (in case it just completed)
          const cachedResult = (allowPermanent && ENABLE_PERMANENT_TRANSLATIONS)
            ? await readFromStorage(baseKey)
            : null;
          if (cachedResult) {
            log.debug(() => '[Translation] Final result already cached; returning it');
            cacheMetrics.hits++;
            return cachedResult.content || cachedResult;
          }

          // Check partial cache (most common case - translation in progress)
          const partialResult = await readFromPartialCache(runtimeKey);
          if (partialResult && typeof partialResult.content === 'string' && partialResult.content.length > 0) {
            log.debug(() => `[Translation] Returning partial result (${partialResult.content.length} chars) without waiting for completion`);
            return partialResult.content;
          }

          // No cached/partial result yet - return loading message and let user retry
          const loadingMsg = createLoadingSubtitle(config.uiLanguage || 'en');
          log.debug(() => `[Translation] No partial result yet for duplicate request; returning loading message`);
          return loadingMsg;
        }
      } catch (err) {
        log.warn(() => [`[Translation] Error checking partials for duplicate request (${cacheKey}):`, err.message]);
        // Return loading message on any error
        const loadingMsg = createLoadingSubtitle(config.uiLanguage || 'en');
        return loadingMsg;
      }
    }

    // Check if another instance has an in-flight translation lock
    let sharedLock = null;
    let sharedLockInProgress = false;
    try {
      sharedLock = await isSharedTranslationInFlight(sharedLockKey);
      sharedLockInProgress = !!(sharedLock && sharedLock.inProgress !== false);
    } catch (_) { }

    // Stale lock detection: if the shared lock is older than the translation timeout
    // and there's no in-memory promise backing it, the original translation likely died
    // without cleaning up. Clear the stale lock and let a new translation start.
    const staleLockThresholdMs = Math.max(10 * 60 * 1000, (parseInt(config?.advancedSettings?.translationTimeout) || 600) * 1000);
    if (sharedLockInProgress && sharedLock?.startedAt) {
      const lockAge = Date.now() - sharedLock.startedAt;
      const hasInMemoryBacking = inFlightTranslations.has(runtimeKey)
        || (sharedInFlightKey && inFlightTranslations.has(sharedInFlightKey));
      if (lockAge > staleLockThresholdMs && !hasInMemoryBacking) {
        log.warn(() => `[Translation] Stale shared lock detected for key=${sharedLockKey} (age ${Math.floor(lockAge / 1000)}s > threshold ${Math.floor(staleLockThresholdMs / 1000)}s, no in-memory promise). Clearing stale lock.`);
        sharedLockInProgress = false;
        try {
          await clearSharedTranslationInFlight(sharedLockKey);
          translationStatus.delete(runtimeKey);
          if (sharedInFlightKey) translationStatus.delete(sharedInFlightKey);
        } catch (_) { }
      }
    }

    // Check if translation is in progress (for backward compatibility)
    const status = translationStatus.get(runtimeKey)
      || (sharedInFlightKey ? translationStatus.get(sharedInFlightKey) : null)
      || (sharedLockInProgress ? {
        inProgress: true,
        startedAt: sharedLock?.startedAt || Date.now(),
        userHash: sharedLock?.userHash || userHash
      } : null);
    if (status && status.inProgress) {
      const elapsedTime = Math.floor((Date.now() - status.startedAt) / 1000);

      // Also detect stale in-memory status entries with no backing promise
      const hasInMemoryBacking = inFlightTranslations.has(runtimeKey)
        || (sharedInFlightKey && inFlightTranslations.has(sharedInFlightKey));
      if (elapsedTime * 1000 > staleLockThresholdMs && !hasInMemoryBacking) {
        log.warn(() => `[Translation] Stale in-memory translation status detected for key=${runtimeKey} (elapsed ${elapsedTime}s, no in-flight promise). Clearing and retrying.`);
        try {
          translationStatus.delete(runtimeKey);
          if (sharedInFlightKey) translationStatus.delete(sharedInFlightKey);
          await clearSharedTranslationInFlight(sharedLockKey);
        } catch (_) { }
        // Fall through to start a new translation
      } else {
        log.debug(() => `[Translation] In-progress existing translation key=${sharedInFlightKey || runtimeKey} (elapsed ${elapsedTime}s); ${waitForFullTranslation ? 'waiting for final result (mobile mode)' : 'attempting partial SRT'}`);
        if (waitForFullTranslation) {
          const waitedResult = await waitForFinalCachedTranslation(
            baseKey,
            cacheKey,
            { bypass, bypassEnabled, userHash, allowPermanent: allowPermanent && ENABLE_PERMANENT_TRANSLATIONS, uiLanguage: config.uiLanguage || 'en' },
            mobileWaitTimeoutMs
          );

          if (waitedResult) {
            log.debug(() => `[Translation] Mobile mode: returning final result after waiting for status-only path key=${cacheKey}`);
            return waitedResult;
          }

          log.warn(() => `[Translation] Mobile mode wait timed out on status-only path for key=${cacheKey}`);
          return createTranslationErrorSubtitle('other', 'Translation did not finish in time. Please retry.', config.uiLanguage || 'en');
        } else {
          try {
            const partial = await readFromPartialCache(runtimeKey);
            if (partial && typeof partial.content === 'string' && partial.content.length > 0) {
              log.debug(() => '[Translation] Serving partial SRT from partial cache');
              return partial.content;
            }
          } catch (_) { }
          const loadingMsg = createLoadingSubtitle(config.uiLanguage || 'en');
          log.debug(() => `[Translation] No partial available, returning loading SRT (size=${loadingMsg.length})`);
          return loadingMsg;
        }
      }
    }

    // Enforce per-user concurrency limit only when starting a new translation
    // MULTI-INSTANCE: This check is now also coordinated via Redis
    const effectiveUserHash = (userHash && userHash.length > 0) ? userHash : 'anonymous';
    const currentCount = await getUserConcurrencyCount(effectiveUserHash);
    const maxConcurrent = getMaxConcurrentTranslationsForConfig(config);
    if (currentCount >= maxConcurrent) {
      log.warn(() => `[Translation] Concurrency limit reached for user=${effectiveUserHash}: ${currentCount} in progress (limit ${maxConcurrent}).`);
      return createConcurrencyLimitSubtitle(maxConcurrent, config.uiLanguage || 'en');
    }

    // === PRE-FLIGHT VALIDATION ===
    ensureHistoryEntry();
    // Download and validate source subtitle BEFORE returning loading message
    // This prevents users from being stuck at "TRANSLATION IN PROGRESS" if subtitle is corrupted
    log.debug(() => `[Translation] Pre-flight validation: downloading source subtitle ${sourceFileId}`);

    let sourceContent;
    try {
      if (embeddedSourceContent) {
        sourceContent = embeddedSourceContent;
      } else {
        // Check download cache first
        sourceContent = getDownloadCached(sourceFileId);

        if (!sourceContent) {
          // Download from provider
          log.debug(() => `[Translation] Pre-flight: downloading from provider`);

          // Fixed download timeout (independent of search timeout config)
          const downloadTimeoutMs = 18000;

          // Use source language as encoding hint when available
          const sourceLanguageHint = options.sourceLanguage
            || (Array.isArray(config.sourceLanguages) && config.sourceLanguages[0])
            || null;

          if (sourceFileId.startsWith('subdl_')) {
            if (!config.subtitleProviders?.subdl?.enabled) {
              throw new Error('SubDL provider is disabled');
            }
            const subdl = new SubDLService(config.subtitleProviders.subdl.apiKey);
            sourceContent = await subdl.downloadSubtitle(sourceFileId, { timeout: downloadTimeoutMs, languageHint: sourceLanguageHint });
          } else if (sourceFileId.startsWith('subsource_')) {
            if (!config.subtitleProviders?.subsource?.enabled) {
              throw new Error('SubSource provider is disabled');
            }
            const subsource = new SubSourceService(config.subtitleProviders.subsource.apiKey);
            sourceContent = await subsource.downloadSubtitle(sourceFileId, { timeout: downloadTimeoutMs, languageHint: sourceLanguageHint });
          } else if (sourceFileId.startsWith('v3_')) {
            if (!config.subtitleProviders?.opensubtitles?.enabled) {
              throw new Error('OpenSubtitles provider is disabled');
            }
            const opensubtitlesV3 = new OpenSubtitlesV3Service();
            sourceContent = await opensubtitlesV3.downloadSubtitle(sourceFileId, { timeout: downloadTimeoutMs, languageHint: sourceLanguageHint });
          } else if (sourceFileId.startsWith('scs_')) {
            // Stremio Community Subtitles
            if (!config.subtitleProviders?.scs?.enabled) {
              throw new Error('SCS provider is disabled');
            }
            const scs = new StremioCommunitySubtitlesService();
            sourceContent = await scs.downloadSubtitle(sourceFileId.replace('scs_', ''), { timeout: downloadTimeoutMs, languageHint: sourceLanguageHint });
          } else if (sourceFileId.startsWith('wyzie_')) {
            // Wyzie Subs (free aggregator)
            if (!config.subtitleProviders?.wyzie?.enabled) {
              throw new Error('Wyzie Subs provider is disabled');
            }
            const wyzie = new WyzieSubsService();
            sourceContent = await wyzie.downloadSubtitle(sourceFileId, { timeout: downloadTimeoutMs, languageHint: sourceLanguageHint });
          } else if (sourceFileId.startsWith('subsro_')) {
            // Subs.ro subtitle (Romanian subtitle database)
            if (!config.subtitleProviders?.subsro?.enabled) {
              throw new Error('Subs.ro provider is disabled');
            }
            const subsro = new SubsRoService(config.subtitleProviders.subsro.apiKey);
            sourceContent = await subsro.downloadSubtitle(sourceFileId, { timeout: downloadTimeoutMs, languageHint: sourceLanguageHint });
          } else {
            // OpenSubtitles subtitle (Auth implementation - default fallback)
            if (!config.subtitleProviders?.opensubtitles?.enabled) {
              throw new Error('OpenSubtitles provider is disabled');
            }
            const opensubtitles = new OpenSubtitlesService(config.subtitleProviders.opensubtitles);
            sourceContent = await opensubtitles.downloadSubtitle(sourceFileId, { timeout: downloadTimeoutMs, languageHint: sourceLanguageHint });
          }

          // Save to download cache for subsequent operations
          try {
            saveDownloadCached(sourceFileId, sourceContent);
          } catch (_) { }
        } else {
          log.debug(() => `[Translation] Pre-flight: using cached source (${sourceContent.length} bytes)`);
        }
      }

      // Validate source size - same check as in performTranslation
      const minSize = Number(config.minSubtitleSizeBytes) || 200;
      if (!sourceContent || sourceContent.length < minSize) {
        log.warn(() => `[Translation] Pre-flight validation failed: source too small (${sourceContent?.length || 0} bytes < ${minSize})`);
        // Return corruption error immediately instead of loading message
        const tTooSmall = getTranslator(config.uiLanguage || 'en');
        return createInvalidSubtitleMessage(tTooSmall('subtitle.invalidSubtitleTooSmall', {}, 'Selected subtitle seems invalid (too small).'), config.uiLanguage || 'en');
      }

      log.debug(() => `[Translation] Pre-flight validation passed: ${sourceContent.length} bytes`);

    } catch (error) {
      if (!error || !error._alreadyLogged) {
        log.error(() => ['[Translation] Pre-flight validation failed:', error?.message || String(error)]);
      }
      updateHistory('failed', { error: error?.message || 'Pre-flight validation failed' });
      // Return error message instead of loading message
      const tError = getTranslator(config.uiLanguage || 'en');
      const reasonText = tError('subtitleErrors.downloadFailedReason', { reason: error.message || '' }, `Download failed: ${error.message}`);
      return createInvalidSubtitleMessage(reasonText, config.uiLanguage || 'en');
    }

    // === START BACKGROUND TRANSLATION ===
    // Mark translation as in progress and start it in background
    log.debug(() => ['[Translation] Not cached and not in-progress; starting translation key=', cacheKey]);
    translationStatus.set(runtimeKey, { inProgress: true, startedAt: Date.now(), userHash: effectiveUserHash });
    if (sharedInFlightKey) {
      translationStatus.set(sharedInFlightKey, { inProgress: true, startedAt: Date.now(), userHash: effectiveUserHash });
    }
    await markSharedTranslationInFlight(sharedLockKey, effectiveUserHash);
    // MULTI-INSTANCE: Increment concurrency counter in Redis with TTL safety
    await incrementUserConcurrency(effectiveUserHash);

    // Create a promise for this translation that all simultaneous requests will wait for
    // Pass the already-downloaded sourceContent to avoid re-downloading
    const translationPromise = performTranslation(
      sourceFileId,
      targetLanguage,
      config,
      { cacheKey, runtimeKey, baseKey, sharedInFlightKey },
      effectiveUserHash,
      allowPermanent,
      sourceContent,
      embeddedSource
    );
    inFlightTranslations.set(runtimeKey, translationPromise);
    if (sharedInFlightKey) {
      inFlightTranslations.set(sharedInFlightKey, translationPromise);
    }

    // Start translation in background (don't await here)
    translationPromise
      .then((result) => {
        // Update history with success
        const sourceLang = (result && typeof result === 'object') ? (result.detectedLanguage || historyEntry?.sourceLanguage) : historyEntry?.sourceLanguage;
        updateHistory('completed', sourceLang ? { sourceLanguage: sourceLang } : {});
        return result;
      })
      .catch(error => {
        // Update history with failure
        updateHistory('failed', { error: error.message || 'Unknown error' });

        // Only log if not already logged by upstream handler
        if (!error._alreadyLogged) {
          log.error(() => ['[Translation] Background translation failed:', error.message]);
        }
        // Mark as failed so it can be retried
        try {
          translationStatus.delete(runtimeKey);
          if (sharedInFlightKey) translationStatus.delete(sharedInFlightKey);
        } catch (_) { }
      }).finally(async () => {
        // Clean up the in-flight promise when done
        inFlightTranslations.delete(runtimeKey);
        if (sharedInFlightKey) inFlightTranslations.delete(sharedInFlightKey);
        try {
          await clearSharedTranslationInFlight(sharedLockKey);
        } catch (_) { }
      });

    // In mobile mode, hold the response until the translation finishes to avoid stale Android caching
    if (waitForFullTranslation) {
      const waitedResult = await waitForFinalCachedTranslation(
        baseKey,
        cacheKey,
        { bypass, bypassEnabled, userHash, allowPermanent: allowPermanent && ENABLE_PERMANENT_TRANSLATIONS, uiLanguage: config.uiLanguage || 'en' },
        mobileWaitTimeoutMs
      );

      if (waitedResult) {
        log.debug(() => `[Translation] Mobile mode: returning final translation after wait for new request key=${cacheKey}`);
        return waitedResult;
      }

      log.warn(() => `[Translation] Mobile mode wait timed out for new translation key=${cacheKey}`);
      return createTranslationErrorSubtitle('other', 'Translation did not finish in time. Please retry.', config.uiLanguage || 'en');
    }

    // Return loading message immediately (desktop/standard behavior)
    const loadingMsg = createLoadingSubtitle(config.uiLanguage || 'en');
    log.debug(() => `[Translation] Returning initial loading message (${loadingMsg.length} characters)`);
    return loadingMsg;
  } catch (error) {
    log.error(() => ['[Translation] Error:', error.message]);
    throw error;
  }
}

/**
 * Perform the actual translation in the background
 * @param {string} sourceFileId - Source subtitle file ID
 * @param {string} targetLanguage - Target language code
 * @param {Object} config - Addon configuration
 * @param {string} cacheKey - Cache key for storing result
 * @param {string} userHash - User hash for concurrency tracking
 * @param {string} preDownloadedContent - Optional pre-downloaded source content (from pre-flight validation)
 */
async function performTranslation(sourceFileId, targetLanguage, config, { cacheKey, runtimeKey, baseKey, sharedInFlightKey = null }, userHash, allowPermanent, preDownloadedContent = null, embeddedSource = null) {
  try {
    log.debug(() => `[Translation] Background translation started for ${sourceFileId} to ${targetLanguage}`);
    cacheMetrics.apiCalls++;

    let sourceContent;

    // Use pre-downloaded content if provided (from pre-flight validation)
    if (preDownloadedContent) {
      log.debug(() => `[Translation] Using pre-downloaded source from pre-flight validation (${preDownloadedContent.length} bytes)`);
      sourceContent = preDownloadedContent;
      // Skip download and validation since it was already done in pre-flight
    } else {
      // Fallback: Fetch subtitle content, preferring 10min download cache first
      // This avoids re-downloading the same source when translating after a direct download
      sourceContent = getDownloadCached(sourceFileId);
      if (sourceContent) {
        log.debug(() => `[Translation] Using cached source subtitle for ${sourceFileId} (${sourceContent.length} bytes)`);
      } else {
        // Download subtitle from provider
        log.debug(() => `[Translation] Cache miss – downloading source subtitle from provider`);

        // Fixed download timeout (independent of search timeout config)
        const downloadTimeoutMs = 18000;

        if (sourceFileId.startsWith('subdl_')) {
          // SubDL subtitle
          if (!config.subtitleProviders?.subdl?.enabled) {
            throw new Error('SubDL provider is disabled');
          }

          const subdl = new SubDLService(config.subtitleProviders.subdl.apiKey);
          sourceContent = await subdl.downloadSubtitle(sourceFileId, { timeout: downloadTimeoutMs });
        } else if (sourceFileId.startsWith('subsource_')) {
          // SubSource subtitle
          if (!config.subtitleProviders?.subsource?.enabled) {
            throw new Error('SubSource provider is disabled');
          }

          const subsource = new SubSourceService(config.subtitleProviders.subsource.apiKey);
          sourceContent = await subsource.downloadSubtitle(sourceFileId, { timeout: downloadTimeoutMs });
        } else if (sourceFileId.startsWith('v3_')) {
          // OpenSubtitles V3 subtitle
          if (!config.subtitleProviders?.opensubtitles?.enabled) {
            throw new Error('OpenSubtitles provider is disabled');
          }

          const opensubtitlesV3 = new OpenSubtitlesV3Service();
          sourceContent = await opensubtitlesV3.downloadSubtitle(sourceFileId, { timeout: downloadTimeoutMs });
        } else if (sourceFileId.startsWith('scs_')) {
          // Stremio Community Subtitles
          if (!config.subtitleProviders?.scs?.enabled) {
            throw new Error('SCS provider is disabled');
          }
          const scs = new StremioCommunitySubtitlesService();
          // Remove scs_ prefix to get the actual comm_ ID
          sourceContent = await scs.downloadSubtitle(sourceFileId.replace('scs_', ''), { timeout: downloadTimeoutMs });
        } else if (sourceFileId.startsWith('wyzie_')) {
          // Wyzie Subs (free aggregator)
          if (!config.subtitleProviders?.wyzie?.enabled) {
            throw new Error('Wyzie Subs provider is disabled');
          }
          const wyzie = new WyzieSubsService();
          sourceContent = await wyzie.downloadSubtitle(sourceFileId, { timeout: downloadTimeoutMs });
        } else if (sourceFileId.startsWith('subsro_')) {
          // Subs.ro subtitle (Romanian subtitle database)
          if (!config.subtitleProviders?.subsro?.enabled) {
            throw new Error('Subs.ro provider is disabled');
          }
          const subsro = new SubsRoService(config.subtitleProviders.subsro.apiKey);
          sourceContent = await subsro.downloadSubtitle(sourceFileId, { timeout: downloadTimeoutMs });
        } else {
          // OpenSubtitles subtitle (Auth implementation - default fallback)
          if (!config.subtitleProviders?.opensubtitles?.enabled) {
            throw new Error('OpenSubtitles provider is disabled');
          }

          const opensubtitles = new OpenSubtitlesService(config.subtitleProviders.opensubtitles);
          sourceContent = await opensubtitles.downloadSubtitle(sourceFileId, { timeout: downloadTimeoutMs });
        }

        // Save the freshly downloaded source to the 10min download cache for subsequent operations
        try {
          saveDownloadCached(sourceFileId, sourceContent);
        } catch (_) { }
      }

      // Validate source size before translation (only if not pre-validated)
      try {
        const minSize = Number(config.minSubtitleSizeBytes) || 200;
        if (!sourceContent || sourceContent.length < minSize) {
          const tTooSmall = getTranslator(config.uiLanguage || 'en');
          const msg = createInvalidSubtitleMessage(tTooSmall('subtitle.invalidSubtitleTooSmall', {}, 'Selected subtitle seems invalid (too small).'), config.uiLanguage || 'en');
          // Save short-lived cache to bypass storage so we never overwrite permanent translations
          await saveToBypassStorage(cacheKey, {
            content: msg,
            // expire after 10 minutes so user can try again later
            expiresAt: Date.now() + 10 * 60 * 1000,
            configHash: userHash  // Include user hash for isolation
          });
          translationStatus.delete(runtimeKey);
          if (sharedInFlightKey) translationStatus.delete(sharedInFlightKey);
          log.debug(() => '[Translation] Aborted due to invalid/corrupted source subtitle (too small).');
          return;
        }
      } catch (_) { }
    }

    // Convert non-SRT formats (VTT, ASS/SSA) to SRT for translation
    // This handles all formats centrally: ASS/SSA → VTT → SRT, VTT → SRT, SRT passthrough
    sourceContent = ensureSRTForTranslation(sourceContent, '[Translation]');

    // Get language names for better translation context
    const targetLangName = getLanguageName(targetLanguage) || targetLanguage;

    // Initialize translation provider (Gemini default, others when enabled)
    const { provider, providerName, model, fallbackProviderName } = await createTranslationProvider(config);
    const effectiveModel = model || config.geminiModel;
    log.debug(() => `[Translation] Using provider=${providerName} model=${effectiveModel}`);

    // Initialize new Translation Engine (structure-first approach)
    // Pass model to enable model-specific batch size optimization
    // Pass advancedSettings to enable optional features (like batch context)
    // Pass keyRotationConfig for per-batch key rotation when enabled
    const keyRotationConfig = (config.geminiKeyRotationEnabled === true && providerName === 'gemini') ? {
      enabled: true,
      mode: config.geminiKeyRotationMode || 'per-batch',
      keys: Array.isArray(config.geminiApiKeys) ? config.geminiApiKeys.filter(k => typeof k === 'string' && k.trim()) : [],
      advancedSettings: config.advancedSettings || {}
    } : null;

    const translationEngine = new TranslationEngine(
      provider,
      effectiveModel,
      config.advancedSettings || {},
      {
        singleBatchMode: config.singleBatchMode === true,
        providerName,
        fallbackProviderName,
        keyRotationConfig
      }
    );

    log.debug(() => '[Translation] Using unified translation engine');

    // Translate with smart partial delivery to reduce Redis I/O
    // Strategy: 1st batch â†’ save, then next 3 â†’ save, then next 5 â†’ save, then every 5
    let translatedContent;
    let lastSavedBatch = 0;
    let lastStreamSequence = 0;
    let lastStreamEntries = 0;
    let lastStreamSavedAt = 0;
    let lastLoggedEntries = 0;
    let nextPartialRebuildAt = null;
    const STREAM_SAVE_MIN_STEP = 10;
    const STREAM_SAVE_DEBOUNCE_MS = 3000;
    const streamingProviderMode = translationEngine.enableStreaming === true;
    const logIntervalEntries = Math.max(1, SINGLE_BATCH_LOG_ENTRY_INTERVAL);

    const shouldSavePartial = (currentBatch) => {
      return true; // Save after every batch for faster partial delivery
    };

    const computeRebuildStep = (totalEntries) => {
      const threshold = SINGLE_BATCH_SRT_REBUILD_LARGE_THRESHOLD;
      const step = totalEntries > threshold ? SINGLE_BATCH_SRT_REBUILD_STEP_LARGE : SINGLE_BATCH_SRT_REBUILD_STEP_SMALL;
      return Math.max(1, step);
    };

    // Log checkpoint schedule at start so we know exactly when partial saves will trigger
    if (streamingProviderMode) {
      const isSingleBatch = config.singleBatchMode === true;
      // Rough entry count estimate from SRT structure (actual count comes from parser inside translateSubtitle)
      const roughEntryCount = sourceContent ? (sourceContent.match(/\n\n/g) || []).length : 0;
      const step = computeRebuildStep(roughEntryCount);
      const firstTarget = STREAM_FIRST_PARTIAL_MIN_ENTRIES;
      const checkpoints = [firstTarget];
      let cp = firstTarget + step;
      const limit = roughEntryCount || 1000;
      while (cp < limit) {
        checkpoints.push(cp);
        cp += step;
      }
      if (roughEntryCount > 0) checkpoints.push(roughEntryCount);
      log.debug(() => `[Translation] Partial delivery config (streaming=${true}, singleBatch=${isSingleBatch}): first=${firstTarget}, step=${step}, checkpoints=[${checkpoints.slice(0, 12).join(', ')}${checkpoints.length > 12 ? '...' : ''}], debounce=${STREAM_SAVE_DEBOUNCE_MS}ms, minDelta=${STREAM_SAVE_MIN_STEP}, logInterval=${logIntervalEntries}`);
    }

    const shouldRebuildPartial = (completedEntries, totalEntries, isStreaming = false) => {
      // Always save the final partial to cover the gap before permanent cache is written (Fix #10)
      if (totalEntries > 0 && completedEntries >= totalEntries) return true;

      const throttle = streamingProviderMode && (config.singleBatchMode === true || isStreaming);
      if (!throttle) return true;
      const total = totalEntries || 0;
      const step = computeRebuildStep(total);
      if (nextPartialRebuildAt === null) {
        // Allow the first streaming partial to land earlier (~100 entries) to give feedback
        if (isStreaming) {
          const firstTarget = total > 0 ? Math.min(total, STREAM_FIRST_PARTIAL_MIN_ENTRIES) : STREAM_FIRST_PARTIAL_MIN_ENTRIES;
          nextPartialRebuildAt = firstTarget;
        } else {
          nextPartialRebuildAt = Math.min(step, total || step);
        }
      }
      const reached = completedEntries >= nextPartialRebuildAt || (total > 0 && completedEntries >= total);
      if (!reached) return false;

      // Advance to the next checkpoint to prevent duplicate rebuilds at the same count
      while (nextPartialRebuildAt <= completedEntries) {
        nextPartialRebuildAt += step;
      }
      if (total > 0 && nextPartialRebuildAt > total) {
        nextPartialRebuildAt = total;
      }
      return true;
    };

    const shouldLogProgress = (completedEntries, totalEntries, isStreaming = false) => {
      const throttle = streamingProviderMode && (config.singleBatchMode === true || isStreaming);
      if (!throttle) return true;
      if (!Number.isFinite(completedEntries)) return false;
      if (completedEntries <= lastLoggedEntries) return false;
      const hitInterval = completedEntries - lastLoggedEntries >= logIntervalEntries;
      const atEnd = totalEntries && completedEntries >= totalEntries;
      if (hitInterval || atEnd) {
        lastLoggedEntries = completedEntries;
        return true;
      }
      return false;
    };

    // Track consecutive partial save failures to warn about persistent issues (Fix #7)
    let consecutivePartialSaveFailures = 0;
    const MAX_SILENT_PARTIAL_FAILURES = 3;
    // Serialization guard: prevent concurrent partial saves from racing (Fix #6)
    // If a save is in-flight, the next one waits for it to finish before starting.
    // This prevents an older, slower write from overwriting a newer one.
    let partialSaveChain = Promise.resolve();
    // Track whether partial delivery has been permanently disabled for this translation
    let partialDeliveryDisabled = false;

    try {
      translatedContent = await translationEngine.translateSubtitle(
        sourceContent,
        targetLangName,
        config.translationPrompt,
        async (progress) => {
          const persistPartial = async (partialText) => {
            if (partialDeliveryDisabled) return false;
            const partialSrt = buildPartialSrtWithTail(partialText, config.uiLanguage || 'en');
            if (!partialSrt || partialSrt.length === 0) return false;

            // Chain saves sequentially to prevent race conditions
            let saved = false;
            partialSaveChain = partialSaveChain.then(async () => {
              try {
                await saveToPartialCacheAsync(runtimeKey, {
                  content: partialSrt,
                  isComplete: false,
                  expiresAt: Date.now() + 60 * 60 * 1000
                });
                consecutivePartialSaveFailures = 0; // Reset on success
                // Always log partial saves — they only happen at checkpoint boundaries so they are rare
                log.debug(() => `[Translation] Partial SAVED: batch ${progress.currentBatch}/${progress.totalBatches}, ${progress.completedEntries}/${progress.totalEntries} entries${progress.streaming ? ' (streaming)' : ''}, nextCheckpoint=${nextPartialRebuildAt}`);
                saved = true;
              } catch (saveErr) {
                consecutivePartialSaveFailures++;
                if (consecutivePartialSaveFailures <= MAX_SILENT_PARTIAL_FAILURES) {
                  log.warn(() => `[Translation] Partial save failed (${consecutivePartialSaveFailures}/${MAX_SILENT_PARTIAL_FAILURES}): ${saveErr.message}`);
                } else if (consecutivePartialSaveFailures === MAX_SILENT_PARTIAL_FAILURES + 1) {
                  log.error(() => `[Translation] Partial save has failed ${consecutivePartialSaveFailures} consecutive times — disabling partial delivery for key=${runtimeKey}.`);
                  partialDeliveryDisabled = true;
                }
              }
            }).catch(() => { }); // Prevent unhandled rejection from breaking the chain
            await partialSaveChain;
            return saved;
          };

          // Smart partial delivery: save at strategic points to reduce Redis I/O
          if (progress.partialSRT) {
            const isStreaming = progress.streaming === true;
            const completed = progress.completedEntries || 0;
            const total = progress.totalEntries || 0;
            const logThisProgress = shouldLogProgress(completed, total, isStreaming);
            const allowRebuild = shouldRebuildPartial(completed, total, isStreaming);
            const throttleLogging = streamingProviderMode && (config.singleBatchMode === true || isStreaming);
            const firstStreamTarget = Math.min(total || STREAM_FIRST_PARTIAL_MIN_ENTRIES, STREAM_FIRST_PARTIAL_MIN_ENTRIES);
            const forceFirstStreamSave = isStreaming && lastStreamSequence === 0 && completed >= firstStreamTarget;
            let didPersist = false;

            if (isStreaming) {
              const now = Date.now();
              const seq = progress.streamSequence || 0;
              const enoughDelta = completed - lastStreamEntries >= STREAM_SAVE_MIN_STEP;
              const timeElapsed = now - lastStreamSavedAt >= STREAM_SAVE_DEBOUNCE_MS;
              const shouldSaveStream = forceFirstStreamSave || (seq > lastStreamSequence && (enoughDelta || timeElapsed || completed === progress.totalEntries) && allowRebuild);
              if (shouldSaveStream) {
                // If we forced the very first streaming partial, advance the rebuild pointer too
                if (forceFirstStreamSave && !allowRebuild) {
                  shouldRebuildPartial(completed, total, isStreaming);
                }
                lastStreamSequence = seq;
                if (completed > 0) lastStreamEntries = completed;
                lastStreamSavedAt = now;
                didPersist = await persistPartial(progress.partialSRT);
              }
            } else if (shouldSavePartial(progress.currentBatch) && progress.currentBatch > lastSavedBatch && allowRebuild) {
              lastSavedBatch = progress.currentBatch;
              didPersist = await persistPartial(progress.partialSRT);
            }

            // Log progress with accurate skip reason when not persisted
            if (logThisProgress && throttleLogging && !didPersist) {
              // Determine the actual reason the save was skipped for clarity
              let skipReason;
              if (!allowRebuild) {
                skipReason = `checkpoint not reached (next=${nextPartialRebuildAt})`;
              } else if (isStreaming) {
                const seq = progress.streamSequence || 0;
                const enoughDelta = completed - lastStreamEntries >= STREAM_SAVE_MIN_STEP;
                const timeElapsed = (Date.now() - lastStreamSavedAt) >= STREAM_SAVE_DEBOUNCE_MS;
                if (seq <= lastStreamSequence) {
                  skipReason = `stale sequence (seq=${seq}, last=${lastStreamSequence})`;
                } else if (!enoughDelta && !timeElapsed) {
                  skipReason = `debounce (delta=${completed - lastStreamEntries}<${STREAM_SAVE_MIN_STEP}, elapsed=${Date.now() - lastStreamSavedAt}ms<${STREAM_SAVE_DEBOUNCE_MS}ms)`;
                } else {
                  skipReason = 'unknown';
                }
              } else {
                skipReason = 'batch already saved';
              }
              log.debug(() => `[Translation] Streaming progress: batch ${progress.currentBatch}/${progress.totalBatches}, ${completed}/${total} entries (not saved: ${skipReason})`);
            }
          }
        }
      );

      log.debug(() => '[Translation] Translation completed successfully');

    } catch (error) {
      // Only log if not already logged by upstream handler
      if (!error._alreadyLogged) {
        log.error(() => ['[Translation] Structure-first translation failed:', error.message]);
      }
      throw error;
    }

    log.debug(() => '[Translation] Background translation completed successfully');

    // Cache the translation (disk-only, permanent by default)
    const cacheConfig = config.translationCache || { enabled: true, duration: 0, persistent: true };
    const bypass = config.bypassCache === true;
    const bypassCfg = config.bypassCacheConfig || config.tempCache || {}; // Support both old and new names
    const bypassEnabled = bypass && (bypassCfg.enabled !== false);

    if (bypass && bypassEnabled) {
      // Save only to bypass storage with TTL
      const bypassDuration = (typeof bypassCfg.duration === 'number') ? bypassCfg.duration : 12;
      const expiresAt = Date.now() + (bypassDuration * 60 * 60 * 1000);

      // CRITICAL: Ensure we have a valid configHash before saving
      // At this point, userHash should always be valid due to earlier validation
      if (!userHash) {
        log.error(() => `[Translation] CRITICAL: Attempted to save bypass cache without valid userHash for key=${cacheKey} - skipping cache write`);
        // Skip bypass cache write if we somehow got here without a userHash
      } else {
        const cachedData = {
          key: cacheKey,
          content: translatedContent,
          createdAt: Date.now(),
          expiresAt,
          sourceFileId,
          targetLanguage,
          isComplete: true,
          configHash: userHash  // Always set configHash for user isolation
        };
        await saveToBypassStorage(cacheKey, cachedData);
        log.debug(() => `[Translation] Saved to bypass cache: key=${cacheKey}, userHash=${userHash}, expiresAt=${new Date(expiresAt).toISOString()}`);
      }
    } else if (cacheConfig.enabled && cacheConfig.persistent !== false && allowPermanent && ENABLE_PERMANENT_TRANSLATIONS) {
      // Save to permanent storage (no expiry)
      const cacheDuration = cacheConfig.duration; // 0 = permanent
      const expiresAt = cacheDuration > 0 ? Date.now() + (cacheDuration * 60 * 60 * 1000) : null;
      const cachedData = {
        key: baseKey,
        content: translatedContent,
        createdAt: Date.now(),
        expiresAt,
        sourceFileId,
        targetLanguage,
        isComplete: true
      };
      await saveToStorage(baseKey, cachedData, { allowPermanent });
    } else {
      log.debug(() => `[Translation] Skipped permanent cache write (allow=${allowPermanent}, flag=${ENABLE_PERMANENT_TRANSLATIONS}, persistent=${cacheConfig.persistent !== false}, enabled=${cacheConfig.enabled})`);
    }

    // If translation originated from an embedded source, persist to xEmbed cache too
    if (embeddedSource && embeddedSource.videoHash && embeddedSource.trackId && translatedContent) {
      try {
        const canonicalSourceLang = canonicalSyncLanguageCode(embeddedSource.languageCode || 'und') || 'und';
        const canonicalTargetLang = canonicalSyncLanguageCode(targetLanguage) || targetLanguage;
        const translationMeta = {
          ...(embeddedSource.metadata || {}),
          provider: providerName,
          model: effectiveModel,
          savedFrom: 'stremio_make'
        };
        await embeddedCache.saveTranslatedEmbedded(
          embeddedSource.videoHash,
          embeddedSource.trackId,
          canonicalSourceLang,
          canonicalTargetLang,
          translatedContent,
          translationMeta
        );
        log.debug(() => `[Translation] Saved xEmbed translation for ${embeddedSource.videoHash}_${embeddedSource.trackId} -> ${canonicalTargetLang}`);
      } catch (e) {
        log.warn(() => [`[Translation] Failed to save xEmbed translation for ${embeddedSource?.videoHash}_${embeddedSource?.trackId}:`, e.message]);
      }
    }

    // Mark translation as complete
    translationStatus.set(runtimeKey, { inProgress: false, completedAt: Date.now() });
    if (sharedInFlightKey) {
      translationStatus.set(sharedInFlightKey, { inProgress: false, completedAt: Date.now() });
    }

    // Verify the final translation is readable from cache before deleting partial.
    // This closes the race window where a concurrent request could find neither
    // the partial (just deleted) nor the final result (async write not yet flushed).
    let finalCacheVerified = false;
    try {
      if (bypass && bypassEnabled) {
        const verify = await readFromBypassStorage(cacheKey);
        finalCacheVerified = !!(verify && (verify.content || verify.isComplete));
      } else if (allowPermanent && ENABLE_PERMANENT_TRANSLATIONS) {
        const verify = await readFromStorage(baseKey);
        finalCacheVerified = !!(verify && (verify.content || verify.isComplete));
      }
    } catch (verifyErr) {
      log.warn(() => `[Translation] Final cache verification failed for ${cacheKey}: ${verifyErr.message}`);
    }

    if (!finalCacheVerified) {
      log.warn(() => `[Translation] Final cache not yet readable for ${cacheKey} — keeping partial cache as fallback`);
    }

    // Clean up partial cache now that final translation is confirmed in storage
    // Retry once on failure to reduce orphaned partials (Fix #4)
    if (finalCacheVerified) {
      try {
        const adapter = await getStorageAdapter();
        await adapter.delete(runtimeKey, StorageAdapter.CACHE_TYPES.PARTIAL);
        log.debug(() => `[Translation] Cleaned up partial cache for ${runtimeKey}`);
      } catch (e) {
        log.warn(() => `[Translation] Partial cache cleanup failed, retrying in 2s: ${e.message}`);
        try {
          await new Promise(resolve => setTimeout(resolve, 2000));
          const adapter = await getStorageAdapter();
          await adapter.delete(runtimeKey, StorageAdapter.CACHE_TYPES.PARTIAL);
          log.debug(() => `[Translation] Partial cache cleanup succeeded on retry for ${runtimeKey}`);
        } catch (retryErr) {
          log.error(() => `[Translation] Partial cache cleanup failed after retry for ${runtimeKey}: ${retryErr.message} — orphaned partial will expire via TTL`);
        }
      }
    }

    log.debug(() => '[Translation] Translation cached and ready to serve');

  } catch (error) {
    // Only log if not already logged by upstream handler
    if (!error._alreadyLogged) {
      log.error(() => ['[Translation] Background translation error:', error.message]);
    }

    // Determine error type for user-friendly message
    let errorType = 'other';
    let errorMessage = error.message;

    // FIRST: Check for translationErrorType set by apiErrorHandler.js (most reliable)
    if (error.translationErrorType) {
      errorType = error.translationErrorType;
    }
    // SECOND: Check for statusCode set by apiErrorHandler.js
    else if (error.statusCode) {
      if (error.statusCode === 403) {
        errorType = '403';
      } else if (error.statusCode === 503) {
        errorType = '503';
      } else if (error.statusCode === 429) {
        errorType = '429';
      }
    }
    // THIRD: Check HTTP status codes from axios error.response
    else if (error.response?.status) {
      const statusCode = error.response.status;
      if (statusCode === 403) {
        errorType = '403';
      } else if (statusCode === 503) {
        errorType = '503';
      } else if (statusCode === 429) {
        errorType = '429';
      }
    }

    // FOURTH: Check error message content (as fallback)
    if (errorType === 'other' && error.message) {
      if (error.message.includes('403')) {
        errorType = '403';
      } else if (error.message.includes('503')) {
        errorType = '503';
      } else if (error.message.includes('429')) {
        errorType = '429';
      } else if (error.message.includes('MAX_TOKENS') || error.message.includes('exceeded maximum token limit')) {
        errorType = 'MAX_TOKENS';
      } else if (error.message.includes('SAFETY') || error.message.includes('PROHIBITED_CONTENT') || error.message.includes('safety filters') || error.message.includes('RECITATION')) {
        errorType = 'PROHIBITED_CONTENT';
      } else if (error.message.includes('invalid') || error.message.includes('corrupted') || error.message.includes('too small')) {
        errorType = 'INVALID_SOURCE';
      }
    }

    log.debug(() => `[Translation] Caching error (type: ${errorType}) for user retry`);

    // Cache the error so user can see what went wrong and retry
    const bypass = config.bypassCache === true;
    const bypassCfg = config.bypassCacheConfig || config.tempCache || {};
    const bypassEnabled = bypass && (bypassCfg.enabled !== false);

    try {
      const errorCache = {
        isError: true,
        errorType: errorType,
        errorMessage: errorMessage,
        errorProvider: error.serviceName || error.providerName || null,
        timestamp: Date.now(),
        expiresAt: Date.now() + 15 * 60 * 1000 // 15 minutes - auto-expire old errors
      };

      if (bypass && bypassEnabled) {
        // Save to bypass storage with short TTL
        errorCache.configHash = userHash;  // Include user hash for isolation
        await saveToBypassStorage(cacheKey, errorCache);
        log.debug(() => '[Translation] Error cached to bypass storage');
      } else if (allowPermanent && ENABLE_PERMANENT_TRANSLATIONS) {
        // Save error to permanent storage with a short TTL so it auto-expires.
        // Without an explicit TTL the TRANSLATION cache type has no expiry (null),
        // which would cause the error entry to persist indefinitely and block the
        // cache key until a user manually triggers the delete-on-read path.
        const ERROR_TTL_SECONDS = 15 * 60; // 15 minutes — matches expiresAt above
        await saveToStorage(baseKey, errorCache, { allowPermanent, ttl: ERROR_TTL_SECONDS });
        log.debug(() => '[Translation] Error cached to permanent storage (TTL 15m)');
      } else {
        log.debug(() => `[Translation] Skipping error cache (bypass=${bypass}, allow=${allowPermanent}, flag=${ENABLE_PERMANENT_TRANSLATIONS})`);
      }
    } catch (cacheError) {
      log.warn(() => ['[Translation] Failed to cache error:', cacheError.message]);
    }

    // Remove from status so it can be retried
    try {
      translationStatus.delete(runtimeKey);
      if (sharedInFlightKey) translationStatus.delete(sharedInFlightKey);
    } catch (_) { }

    // Clean up partial cache on error as well (with retry — Fix #4)
    try {
      const adapter = await getStorageAdapter();
      await adapter.delete(runtimeKey, StorageAdapter.CACHE_TYPES.PARTIAL);
      log.debug(() => `[Translation] Cleaned up partial cache after error for ${runtimeKey}`);
    } catch (e) {
      log.warn(() => `[Translation] Partial cache error-cleanup failed, retrying in 2s: ${e.message}`);
      try {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const adapter = await getStorageAdapter();
        await adapter.delete(runtimeKey, StorageAdapter.CACHE_TYPES.PARTIAL);
        log.debug(() => `[Translation] Partial cache error-cleanup succeeded on retry for ${runtimeKey}`);
      } catch (retryErr) {
        log.error(() => `[Translation] Partial cache error-cleanup failed after retry for ${runtimeKey}: ${retryErr.message} — orphaned partial will expire via TTL`);
      }
    }

    throw error;
  } finally {
    // MULTI-INSTANCE: Decrement per-user concurrency counter in Redis
    // This is critical for preventing concurrency leaks across pods
    try {
      const effectiveUserHash = (userHash && userHash.length > 0) ? userHash : 'anonymous';
      await decrementUserConcurrency(effectiveUserHash);
    } catch (e) {
      log.warn(() => `[Translation] Failed to decrement user concurrency: ${e.message}`);
    }
  }
}

/**
 * Get available subtitles for translation selector
 * @param {string} videoId - Stremio video ID
 * @param {Object} config - Addon configuration
 * @returns {Promise<Array>} - Array of available subtitles
 */
async function getAvailableSubtitlesForTranslation(videoId, config) {
  try {
    log.debug(() => ['[Translation Selector] Getting subtitles for:', videoId]);

    const videoInfo = parseStremioId(videoId);
    if (!videoInfo) {
      throw new Error('Invalid video ID');
    }

    await ensureImdbId(videoInfo, null, 'Translation Selector');

    // Get ONLY source languages for translation selector
    // Users will configure one source language, and selector shows only those subtitles
    const sourceLanguages = config.sourceLanguages;

    // Build search parameters for source language subtitles only
    const searchParams = {
      imdb_id: videoInfo.imdbId,
      type: videoInfo.type,
      season: videoInfo.season,
      episode: videoInfo.episode,
      languages: sourceLanguages,
      excludeHearingImpairedSubtitles: config.excludeHearingImpairedSubtitles === true,
      // Provider timeout from config (subtract 2s buffer for orchestration overhead)
      providerTimeout: Math.max(6, ((config.subtitleProviderTimeout || 12) - 2)) * 1000
    };

    // Create user-scoped deduplication key based on video info, source languages, and user config
    const userHash = (config && typeof config.__configHash === 'string' && config.__configHash.length > 0)
      ? config.__configHash
      : 'default';
    const cacheIdComponent = getVideoCacheIdComponent(videoInfo);
    const dedupKey = `translation-search:${cacheIdComponent}:${videoInfo.type}:${videoInfo.season || ''}:${videoInfo.episode || ''}:${sourceLanguages.join(',')}:${userHash}`;

    // Collect subtitles from all enabled providers with deduplication
    const subtitles = await deduplicateSearch(dedupKey, async () => {
      // Parallelize all provider searches using Promise.all for better performance
      const searchPromises = [];
      const skippedProviders = []; // Track providers skipped due to circuit breaker

      // Check if OpenSubtitles provider is enabled
      if (config.subtitleProviders?.opensubtitles?.enabled) {
        const implementationType = config.subtitleProviders.opensubtitles.implementationType || 'v3';
        const providerKey = implementationType === 'v3' ? 'opensubtitles_v3' : 'opensubtitles_auth';
        const health = isProviderHealthy(providerKey);

        if (!health.healthy) {
          skippedProviders.push({ provider: `OpenSubtitles (${implementationType})`, reason: health.reason });
        } else {
          let opensubtitles;
          if (implementationType === 'v3') {
            opensubtitles = new OpenSubtitlesV3Service();
          } else {
            opensubtitles = new OpenSubtitlesService(config.subtitleProviders.opensubtitles);
          }

          searchPromises.push(
            opensubtitles.searchSubtitles(searchParams)
              .then(results => {
                circuitBreaker.recordSuccess(implementationType === 'v3' ? 'opensubtitlesV3' : 'opensubtitlesV3');
                return { provider: `OpenSubtitles (${implementationType})`, results };
              })
              .catch(error => {
                const code = error?.code || '';
                if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
                  circuitBreaker.recordFailure(implementationType === 'v3' ? 'opensubtitlesV3' : 'opensubtitlesV3', error);
                }
                return { provider: `OpenSubtitles (${implementationType})`, results: [], error };
              })
          );
        }
      }

      // Check if SubDL provider is enabled
      if (config.subtitleProviders?.subdl?.enabled) {
        const health = isProviderHealthy('subdl');
        if (!health.healthy) {
          skippedProviders.push({ provider: 'SubDL', reason: health.reason });
        } else {
          const subdl = new SubDLService(config.subtitleProviders.subdl.apiKey);
          searchPromises.push(
            subdl.searchSubtitles(searchParams)
              .then(results => {
                circuitBreaker.recordSuccess('subdl');
                return { provider: 'SubDL', results };
              })
              .catch(error => {
                const code = error?.code || '';
                if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
                  circuitBreaker.recordFailure('subdl', error);
                }
                return { provider: 'SubDL', results: [], error };
              })
          );
        }
      }

      // Check if SubSource provider is enabled
      if (config.subtitleProviders?.subsource?.enabled) {
        const health = isProviderHealthy('subsource');
        if (!health.healthy) {
          skippedProviders.push({ provider: 'SubSource', reason: health.reason });
        } else {
          const subsource = new SubSourceService(config.subtitleProviders.subsource.apiKey);
          searchPromises.push(
            subsource.searchSubtitles(searchParams)
              .then(results => {
                circuitBreaker.recordSuccess('subsource');
                return { provider: 'SubSource', results };
              })
              .catch(error => {
                const code = error?.code || '';
                if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
                  circuitBreaker.recordFailure('subsource', error);
                }
                return { provider: 'SubSource', results: [], error };
              })
          );
        }
      }

      // Check if SCS provider is enabled
      if (config.subtitleProviders?.scs?.enabled) {
        const health = isProviderHealthy('scs');
        if (!health.healthy) {
          skippedProviders.push({ provider: 'StremioCommunitySubtitles', reason: health.reason });
        } else {
          const scs = new StremioCommunitySubtitlesService();
          searchPromises.push(
            scs.searchSubtitles(searchParams)
              .then(results => {
                circuitBreaker.recordSuccess('scs');
                return { provider: 'StremioCommunitySubtitles', results };
              })
              .catch(error => {
                const code = error?.code || '';
                if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EPROTO') {
                  circuitBreaker.recordFailure('scs', error);
                }
                return { provider: 'StremioCommunitySubtitles', results: [], error };
              })
          );
        }
      }

      // Check if Wyzie Subs provider is enabled
      if (config.subtitleProviders?.wyzie?.enabled) {
        const health = isProviderHealthy('wyzie');
        if (!health.healthy) {
          skippedProviders.push({ provider: 'WyzieSubs', reason: health.reason });
        } else {
          const wyzie = new WyzieSubsService();
          // Pass sources config so Wyzie only queries user-selected sources
          const wyzieParams = { ...searchParams, sources: config.subtitleProviders.wyzie.sources };
          searchPromises.push(
            wyzie.searchSubtitles(wyzieParams)
              .then(results => {
                circuitBreaker.recordSuccess('wyzie');
                return { provider: 'WyzieSubs', results };
              })
              .catch(error => {
                const code = error?.code || '';
                if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
                  circuitBreaker.recordFailure('wyzie', error);
                }
                return { provider: 'WyzieSubs', results: [], error };
              })
          );
        }
      }

      // Check if Subs.ro provider is enabled
      if (config.subtitleProviders?.subsro?.enabled) {
        const health = isProviderHealthy('subsro');
        if (!health.healthy) {
          skippedProviders.push({ provider: 'SubsRo', reason: health.reason });
        } else {
          const subsro = new SubsRoService(config.subtitleProviders.subsro.apiKey);
          searchPromises.push(
            subsro.searchSubtitles(searchParams)
              .then(results => {
                circuitBreaker.recordSuccess('subsro');
                return { provider: 'SubsRo', results };
              })
              .catch(error => {
                const code = error?.code || '';
                if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
                  circuitBreaker.recordFailure('subsro', error);
                }
                return { provider: 'SubsRo', results: [], error };
              })
          );
        }
      }

      // Execute all searches in parallel
      const providerResults = await Promise.all(searchPromises);

      // Collect results from all providers
      let subs = [];
      for (const result of providerResults) {
        if (result.error) {
          log.error(() => [`[Translation Selector] ${result.provider} search failed:`, result.error.message]);
        } else {
          subs = [...subs, ...result.results];
        }
      }

      // Log any providers that were skipped due to circuit breaker
      if (skippedProviders.length > 0) {
        const skippedNames = skippedProviders.map(s => s.provider).join(', ');
        log.info(() => `[Translation Selector] Skipped ${skippedProviders.length} unhealthy provider(s): ${skippedNames}`);
      }

      // Future providers can be added here

      log.debug(() => `[Translation Selector] Found ${subs.length} subtitles total`);
      return subs;
    });

    if (config && config.excludeHearingImpairedSubtitles === true && Array.isArray(subtitles)) {
      const beforeCount = subtitles.length;
      const filtered = subtitles.filter(sub => !isHearingImpairedSubtitle(sub));
      const removed = beforeCount - filtered.length;
      if (removed > 0) {
        log.debug(() => `[Translation Selector] Excluded ${removed} hearing impaired subtitles (SDH/HI)`);
      }
      return filtered;
    }

    return subtitles;

  } catch (error) {
    log.error(() => ['[Translation Selector] Error:', error.message]);
    return [];
  }
}

// Clean up expired disk cache entries periodically (only needed for non-permanent caches)
setInterval(() => {
  (async () => {
    try {
      if (!fs.existsSync(CACHE_DIR)) {
        return;
      }

      const now = Date.now();
      const files = await fs.promises.readdir(CACHE_DIR);
      let removedCount = 0;

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const filePath = path.join(CACHE_DIR, file);
          const content = await fs.promises.readFile(filePath, 'utf8');
          const cached = JSON.parse(content);

          if (cached.expiresAt && now > cached.expiresAt) {
            await fs.promises.unlink(filePath);
            removedCount++;
          }
        } catch (_) {
          // Ignore errors for individual files
        }
      }

      if (removedCount > 0) {
        log.debug(() => `[Cache] Cleaned up ${removedCount} expired disk cache entries`);
      }
    } catch (error) {
      log.error(() => ['[Cache] Failed to clean up disk cache:', error.message]);
    }
  })();
}, 1000 * 60 * 60); // Every hour (less frequent for disk operations)

setInterval(() => {
  verifyBypassCacheIntegrity().catch(() => { });
}, 1000 * 60 * 60);

// Note: No manual cleanup needed for translationStatus - LRU cache handles TTL automatically


module.exports = {
  createSubtitleHandler,
  handleSubtitleDownload,
  handleTranslation,
  getAvailableSubtitlesForTranslation,
  createLoadingSubtitle, // Export for loading message in translation endpoint
  createSessionTokenErrorSubtitle, // Export for session token error subtitle
  createOpenSubtitlesAuthErrorSubtitle, // Export for OpenSubtitles auth error subtitle
  createOpenSubtitlesAuthMissingSubtitle, // Export for OpenSubtitles missing credentials subtitle
  createOpenSubtitlesQuotaExceededSubtitle, // Export for OpenSubtitles daily quota exceeded subtitle
  createCredentialDecryptionErrorSubtitle, // Export for credential decryption failure subtitle (encryption key mismatch)
  createProviderDownloadErrorSubtitle, // Export for provider-specific download failure subtitles
  createInvalidSubtitleMessage, // Export for corrupted/invalid subtitle error message
  readFromPartialCache, // Export for checking in-flight partial results during duplicate requests
  translationStatus, // Export for safety block to check if translation is in progress
  /**
   * Check if a translated subtitle exists in cache (bypass or permanent)
   * Mirrors the cache key logic used in handleTranslation
   */
  hasCachedTranslation: async function (sourceFileId, targetLanguage, config) {
    try {
      const { cacheKey, baseKey, bypass, bypassEnabled, userHash, allowPermanent } = generateCacheKeys(config, sourceFileId, targetLanguage);

      if (bypass && bypassEnabled && userHash) {
        // Check bypass cache with user-scoped key
        const cached = await readFromBypassStorage(cacheKey);
        return !!(cached && ((cached.content && typeof cached.content === 'string' && cached.content.length > 0) || (typeof cached === 'string' && cached.length > 0)));
      } else if (allowPermanent && ENABLE_PERMANENT_TRANSLATIONS) {
        // Check permanent cache
        let cached = await readFromStorage(baseKey);
        return !!(cached && ((cached.content && typeof cached.content === 'string' && cached.content.length > 0) || (typeof cached === 'string' && cached.length > 0)));
      }
    } catch (_) {
      return false;
    }
  },
  /**
   * Purge cached translation based on user's cache type and reset in-progress state
   * CACHE-TYPE AWARE: Only deletes the cache type the user is using
   */
  purgeTranslationCache: async function (sourceFileId, targetLanguage, config) {
    try {
      const { cacheKey, baseKey, runtimeKey, bypass, bypassEnabled, userHash, allowPermanent } = generateCacheKeys(config, sourceFileId, targetLanguage);
      const adapter = await getStorageAdapter();

      // CACHE-TYPE AWARE DELETION: Only delete the cache type the user is using
      if (bypass && bypassEnabled && userHash) {
        // User is using BYPASS CACHE - only delete bypass cache entries
        log.debug(() => `[Purge] User is using bypass cache - deleting bypass entries only`);

        try {
          // Delete user-scoped bypass cache (primary key)
          await adapter.delete(cacheKey, StorageAdapter.CACHE_TYPES.BYPASS);
          log.debug(() => `[Purge] Removed user-scoped bypass cache for ${cacheKey}`);

          // Also try deleting unscoped bypass cache (legacy fallback)
          // This handles old entries created before user isolation was implemented
          try {
            await adapter.delete(baseKey, StorageAdapter.CACHE_TYPES.BYPASS);
            log.debug(() => `[Purge] Removed legacy unscoped bypass cache for ${baseKey}`);
          } catch (e) {
            // Ignore - legacy key might not exist
          }
        } catch (e) {
          log.warn(() => [`[Purge] Failed removing bypass cache for ${baseKey}:`, e.message]);
        }

        // Clear user-scoped translation status
        try {
          translationStatus.delete(runtimeKey);
          log.debug(() => `[Purge] Cleared user-scoped translation status for ${runtimeKey}`);
        } catch (_) { }

      } else {
        // User is using PERMANENT CACHE - only delete permanent cache
        log.debug(() => `[Purge] User is using permanent cache - deleting permanent entries only`);

        if (allowPermanent && ENABLE_PERMANENT_TRANSLATIONS) {
          try {
            await adapter.delete(getTranslationStorageKey(baseKey), StorageAdapter.CACHE_TYPES.TRANSLATION);
            log.debug(() => `[Purge] Removed permanent cache for ${baseKey}`);
            // Best-effort cleanup of legacy un-namespaced keys
            try {
              await adapter.delete(getTranslationStorageKey(cacheKey), StorageAdapter.CACHE_TYPES.TRANSLATION);
            } catch (_) { }
          } catch (e) {
            log.warn(() => [`[Purge] Failed removing permanent cache for ${baseKey}:`, e.message]);
          }
        } else {
          log.debug(() => `[Purge] Skipped permanent cache purge (allow=${allowPermanent}, flag=${ENABLE_PERMANENT_TRANSLATIONS})`);
        }

        // Clear unscoped translation status
        try {
          translationStatus.delete(runtimeKey);
          translationStatus.delete(baseKey);
          log.debug(() => `[Purge] Cleared translation status for ${runtimeKey}`);
        } catch (_) { }
      }

      // ALWAYS delete partial cache (in-flight translations)
      // Partial cache stores incomplete translations that are still being generated
      // IMPORTANT: For bypass cache, partial cache is also user-scoped
      try {
        await adapter.delete(runtimeKey, StorageAdapter.CACHE_TYPES.PARTIAL);
        log.debug(() => `[Purge] Removed partial cache for ${runtimeKey}`);
      } catch (e) {
        // Ignore - partial cache might not exist
      }

      return true;
    } catch (error) {
      log.error(() => ['[Purge] Error purging translation cache:', error.message]);
      return false;
    }
  }
};

// Max history items per user to fetch/store (soft limit for display)
const MAX_HISTORY_ITEMS = 20;
// Hard cap stored per user (keep extra to absorb rapid updates without churn)
const MAX_HISTORY_STORE_ITEMS = 40;
const historyMetrics = {
  skippedMissingHash: 0
};

function sanitizeHistoryComponent(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 200);
}

function buildHistoryStoreKey(userHash) {
  const safeHash = sanitizeHistoryComponent(userHash);
  return `histset__${safeHash}`;
}

function buildHistoryKey(userHash, entryId) {
  const safeHash = sanitizeHistoryComponent(userHash);
  const safeId = sanitizeHistoryComponent(entryId);
  // Double underscore separators avoid collision with legacy single-underscore form
  return `hist__${safeHash}__${safeId}`;
}

function buildHistoryPatterns(userHash) {
  const safeHash = sanitizeHistoryComponent(userHash);
  // Preferred key format plus legacy single-underscore and colon-delimited formats for backward compatibility
  return [
    `hist__${safeHash}__*`,
    `hist_${safeHash}_*`,
    `hist:${safeHash}:*`
  ];
}

async function resolveHistoryTitle(videoId, fallbackTitle = '', seasonHint = null, episodeHint = null) {
  if (!videoId || typeof videoId !== 'string') {
    return { title: fallbackTitle || 'Unknown title', season: seasonHint, episode: episodeHint };
  }

  if (historyTitleCache.has(videoId)) {
    const cached = historyTitleCache.get(videoId);
    if (cached) return cached;
  }

  let title = fallbackTitle || '';
  let season = seasonHint;
  let episode = episodeHint;

  try {
    const parsed = parseStremioId(videoId);

    // Handle anime IDs - resolve title via offline mapping → Cinemeta, with Kitsu API fallback
    if (parsed?.isAnime && parsed?.animeId) {
      if (parsed.episode) episode = parsed.episode;
      if (parsed.season) season = parsed.season;

      // Step 1: Try offline mapping to get IMDB/TMDB ID, then use Cinemeta for title
      // This works for ALL anime platforms (kitsu, anidb, mal, anilist)
      const offlineResult = animeIdResolver.resolveImdbId(parsed.animeIdType, parsed.animeId);
      let resolvedTitle = false;

      if (offlineResult?.imdbId) {
        try {
          const metaType = offlineResult.type === 'MOVIE' || offlineResult.type === 'Movie' ? 'movie' : 'series';
          const metaUrl = `https://v3-cinemeta.strem.io/meta/${metaType}/${encodeURIComponent(offlineResult.imdbId)}.json`;
          const metaResp = await axios.get(metaUrl, { timeout: 7500 });
          if (metaResp?.data?.meta?.name) {
            title = metaResp.data.meta.name;
            resolvedTitle = true;
            log.debug(() => `[History] Resolved ${parsed.animeIdType} ${parsed.animeId} title via offline→Cinemeta: "${title}"`);
          }
        } catch (metaErr) {
          log.debug(() => `[History] Cinemeta lookup failed for ${offlineResult.imdbId}: ${metaErr.message}`);
        }
      }

      // Step 2: Fallback — try Kitsu API directly for Kitsu IDs (if offline/Cinemeta failed)
      if (!resolvedTitle && parsed.animeIdType === 'kitsu') {
        const numericIdMatch = parsed.animeId.match(/kitsu[:-]?(\d+)/i);
        if (numericIdMatch) {
          const numericId = numericIdMatch[1];
          try {
            const kitsuResp = await axios.get(`https://kitsu.io/api/edge/anime/${numericId}`, {
              timeout: 7500,
              headers: {
                'Accept': 'application/vnd.api+json',
                'User-Agent': 'StremioSubMaker/1.0'
              }
            });
            const animeData = kitsuResp?.data?.data?.attributes;
            if (animeData) {
              title = animeData.canonicalTitle || animeData.titles?.en || animeData.titles?.en_us || title;
              resolvedTitle = true;
            }
          } catch (kitsuErr) {
            log.debug(() => [`[History] Kitsu API fallback failed for ${videoId}:`, kitsuErr.message]);
          }
        }
      }

    } else {
      // Handle IMDB/TMDB IDs - use Cinemeta
      const metaType = parsed?.type === 'movie' ? 'movie' : 'series';
      let metaId = parsed?.imdbId;
      if (!metaId && parsed?.tmdbId) {
        metaId = 'tmdb:' + parsed.tmdbId;
      }
      if (parsed?.season) season = parsed.season;
      if (parsed?.episode) episode = parsed.episode;

      if (metaId) {
        const url = `https://v3-cinemeta.strem.io/meta/${metaType}/${encodeURIComponent(metaId)}.json`;
        const resp = await axios.get(url, { timeout: 7500 });
        const meta = resp?.data?.meta;
        if (meta?.name) title = meta.name;
        if (!season && Number.isFinite(Number(meta?.season))) season = Number(meta.season);
        if (!episode && Number.isFinite(Number(meta?.episode))) episode = Number(meta.episode);
      }
    }
  } catch (err) {
    log.debug(() => [`[History] Metadata lookup failed for ${videoId}:`, err.message]);
  }

  const resolved = {
    title: title || fallbackTitle || videoId || 'Unknown title',
    season: seasonHint ?? season ?? null,
    episode: episodeHint ?? episode ?? null
  };
  historyTitleCache.set(videoId, resolved);
  return resolved;
}


function normalizeHistoryUserHash(rawHash) {
  if (!rawHash || typeof rawHash !== 'string') return '';
  const trimmed = rawHash.trim();
  if (!trimmed || trimmed === 'anonymous') return '';
  return trimmed;
}

function pruneHistoryEntries(entries = []) {
  // Dedup by id and keep newest first
  const deduped = new Map();
  for (const entry of entries) {
    if (!entry || !entry.id) continue;
    const existing = deduped.get(entry.id);
    if (!existing || (entry.createdAt || 0) > (existing.createdAt || 0)) {
      deduped.set(entry.id, entry);
    }
  }
  return Array.from(deduped.values())
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, MAX_HISTORY_STORE_ITEMS);
}

function resolveHistoryUserHash(config = {}, explicitHash = '') {
  return normalizeHistoryUserHash(explicitHash)
    || normalizeHistoryUserHash(config.userHash)
    || normalizeHistoryUserHash(config.__configHash)
    || '';
}

function auditHistorySkip(reason, context = {}) {
  historyMetrics.skippedMissingHash++;
  const ctxParts = [];
  if (context.requestId) ctxParts.push(`req=${context.requestId}`);
  if (context.sourceFileId) ctxParts.push(`src=${context.sourceFileId}`);
  if (context.targetLanguage) ctxParts.push(`target=${context.targetLanguage}`);
  const contextStr = ctxParts.length ? ` | ${ctxParts.join(' ')}` : '';
  log.warn(() => `[History] Skipping history: ${reason}${contextStr}`);
}

async function saveRequestToHistory(userHash, entry) {
  try {
    const normalizedHash = normalizeHistoryUserHash(userHash);
    if (!normalizedHash || !entry || !entry.id) {
      if (!normalizedHash && entry && entry.id) {
        auditHistorySkip('missing user hash in saveRequestToHistory', { requestId: entry.id, status: entry.status });
      }
      return;
    }
    const adapter = await getStorageAdapter();
    const storeKey = buildHistoryStoreKey(normalizedHash);
    const ttlSeconds = StorageAdapter.DEFAULT_TTL[StorageAdapter.CACHE_TYPES.HISTORY];

    // Load existing store (single hash per user)
    let store = await adapter.get(storeKey, StorageAdapter.CACHE_TYPES.HISTORY);
    let entries = {};
    if (store && typeof store === 'object' && !Array.isArray(store)) {
      entries = store.entries && typeof store.entries === 'object' ? store.entries : {};
    }

    const existing = entries[entry.id] || {};
    const merged = { ...existing, ...entry };
    if (!merged.createdAt) merged.createdAt = existing.createdAt || entry.createdAt || Date.now();
    entries[entry.id] = merged;

    // Prune and rebuild compact map
    const pruned = pruneHistoryEntries(Object.values(entries));
    const compactMap = Object.fromEntries(pruned.map(e => [e.id, e]));

    await adapter.set(
      storeKey,
      { entries: compactMap, updatedAt: Date.now() },
      StorageAdapter.CACHE_TYPES.HISTORY,
      ttlSeconds
    );
  } catch (err) {
    log.warn(() => [`[History] Error saving history entry:`, err.message]);
  }
}

async function getHistoryForUser(userHash) {
  try {
    const normalizedHash = normalizeHistoryUserHash(userHash);
    if (!normalizedHash) return [];
    const adapter = await getStorageAdapter();
    const storeKey = buildHistoryStoreKey(normalizedHash);
    const store = await adapter.get(storeKey, StorageAdapter.CACHE_TYPES.HISTORY);
    const storeEntries = (store && store.entries && typeof store.entries === 'object') ? store.entries : {};
    const storeArray = pruneHistoryEntries(Object.values(storeEntries));
    if (storeArray.length > 0) {
      return storeArray.slice(0, MAX_HISTORY_ITEMS);
    }

    // Legacy fallback: scan individual entry keys, then migrate into store
    const patterns = buildHistoryPatterns(normalizedHash);
    const keySets = await Promise.all(patterns.map(p => adapter.list(StorageAdapter.CACHE_TYPES.HISTORY, p)));
    const keys = Array.from(new Set((keySets || []).flat().filter(Boolean)));

    if (!keys || keys.length === 0) return [];

    const fetched = await Promise.all(
      keys.map(k => adapter.get(k, StorageAdapter.CACHE_TYPES.HISTORY))
    );

    const deduped = pruneHistoryEntries(fetched);
    const result = deduped.slice(0, MAX_HISTORY_ITEMS);

    try {
      if (deduped.length > 0) {
        const compactMap = Object.fromEntries(deduped.map(e => [e.id, e]));
        await adapter.set(
          storeKey,
          { entries: compactMap, updatedAt: Date.now() },
          StorageAdapter.CACHE_TYPES.HISTORY,
          StorageAdapter.DEFAULT_TTL[StorageAdapter.CACHE_TYPES.HISTORY]
        );
      }
    } catch (_) { /* best-effort migration */ }

    return result;
  } catch (err) {
    log.error(() => [`[History] Error fetching history for ${userHash}:`, err.message]);
    return [];
  }
}

// Re-export everything properly
module.exports = {
  createSubtitleHandler,
  handleSubtitleDownload,
  handleTranslation,
  getAvailableSubtitlesForTranslation,
  createLoadingSubtitle,
  createSessionTokenErrorSubtitle,
  createCredentialDecryptionErrorSubtitle,
  createOpenSubtitlesAuthErrorSubtitle,
  createOpenSubtitlesAuthMissingSubtitle,
  createOpenSubtitlesQuotaExceededSubtitle,
  createProviderDownloadErrorSubtitle,
  createInvalidSubtitleMessage,
  maybeConvertToSRT,
  createOpenSubtitlesV3RateLimitSubtitle,
  createOpenSubtitlesV3ServiceUnavailableSubtitle,
  createConcurrencyLimitSubtitle,
  createTranslationErrorSubtitle,
  readFromPartialCache,
  translationStatus,
  // Export methods from the object above if needed, but they seem to be attached to module.exports?
  // Wait, existing code had a mix of exports. 
  // Let's look at lines 3843-3856 in Step 85. 
  // The code HAD `module.exports = { ... }` starting at 3843.
  // And `hasCachedTranslation` was inside it.

  hasCachedTranslation: module.exports.hasCachedTranslation, // This won't work if I replaced the block.
  // I need to redefine them or move them out.
  // The complexity is that `hasCachedTranslation` and `purgeTranslationCache` WERE inside the module.exports block.

  // Okay, easier path: Define them as standalone functions first, then export.

  canUserStartTranslation,
  inFlightTranslations,
  initializeCacheDirectory,
  purgeLegacyTranslationCacheEntries,
  verifyCacheIntegrity,
  verifyBypassCacheIntegrity,
  markSharedTranslationInFlight,
  clearSharedTranslationInFlight,
  isSharedTranslationInFlight,
  readFromStorage,
  resolveHistoryUserHash,
  getHistoryForUser,
  saveRequestToHistory,
  resolveHistoryTitle
};

// Append the complex object methods to module.exports since they were defined inline
module.exports.hasCachedTranslation = async function (sourceFileId, targetLanguage, config) {
  try {
    const { cacheKey, baseKey, bypass, bypassEnabled, userHash, allowPermanent } = generateCacheKeys(config, sourceFileId, targetLanguage);

    if (bypass && bypassEnabled && userHash) {
      const cached = await readFromBypassStorage(cacheKey);
      return !!(cached && ((cached.content && typeof cached.content === 'string' && cached.content.length > 0) || (typeof cached === 'string' && cached.length > 0)));
    } else if (allowPermanent && ENABLE_PERMANENT_TRANSLATIONS) {
      let cached = await readFromStorage(baseKey);
      return !!(cached && ((cached.content && typeof cached.content === 'string' && cached.content.length > 0) || (typeof cached === 'string' && cached.length > 0)));
    }
  } catch (_) {
    return false;
  }
};

module.exports.purgeTranslationCache = async function (sourceFileId, targetLanguage, config) {
  try {
    const { cacheKey, baseKey, runtimeKey, bypass, bypassEnabled, userHash, allowPermanent } = generateCacheKeys(config, sourceFileId, targetLanguage);
    const adapter = await getStorageAdapter();

    if (bypass && bypassEnabled && userHash) {
      log.debug(() => `[Purge] User is using bypass cache - deleting bypass entries only`);
      try {
        await adapter.delete(cacheKey, StorageAdapter.CACHE_TYPES.BYPASS);
        log.debug(() => `[Purge] Removed user-scoped bypass cache for ${cacheKey}`);
        try {
          await adapter.delete(baseKey, StorageAdapter.CACHE_TYPES.BYPASS);
        } catch (e) { }
      } catch (e) {
        log.warn(() => [`[Purge] Failed removing bypass cache for ${baseKey}:`, e.message]);
      }
      try {
        translationStatus.delete(runtimeKey);
      } catch (_) { }

    } else {
      log.debug(() => `[Purge] User is using permanent cache - deleting permanent entries only`);
      if (allowPermanent && ENABLE_PERMANENT_TRANSLATIONS) {
        try {
          await adapter.delete(getTranslationStorageKey(baseKey), StorageAdapter.CACHE_TYPES.TRANSLATION);
          try {
            await adapter.delete(getTranslationStorageKey(cacheKey), StorageAdapter.CACHE_TYPES.TRANSLATION);
          } catch (_) { }
        } catch (e) {
          log.warn(() => [`[Purge] Failed removing permanent cache for ${baseKey}:`, e.message]);
        }
      }
      try {
        translationStatus.delete(runtimeKey);
        translationStatus.delete(baseKey);
      } catch (_) { }
    }

    try {
      await adapter.delete(runtimeKey, StorageAdapter.CACHE_TYPES.PARTIAL);
      log.debug(() => `[Purge] Removed partial cache for ${runtimeKey}`);
    } catch (e) { }

    return true;
  } catch (error) {
    log.error(() => ['[Purge] Error purging translation cache:', error.message]);
    return false;
  }
};
