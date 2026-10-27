/**
 * Offline Anime ID Resolver
 *
 * Provides instant O(1) anime-platform→IMDB lookups using Fribb/anime-lists
 * (https://github.com/Fribb/anime-lists) bundled JSON.
 *
 * Loaded once at startup, auto-refreshed weekly.
 * In multi-instance (multi-pod) deployments, a Redis leader lock ensures
 * only one pod downloads the refresh; others detect the update via a
 * Redis timestamp key and reload from disk / re-download.
 *
 * Falls through to null when no mapping exists — callers should then
 * fall back to the live API services (Kitsu, Jikan, AniList, Wikidata).
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const log = require('../utils/logger');
const { MAX_ANIME_LIST_BYTES } = require('../utils/resourceLimits');

// ── constants ────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const LOCAL_FILE = path.join(DATA_DIR, 'anime-list-full.json');
const REMOTE_URL =
    'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';

const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DOWNLOAD_TIMEOUT_MS = 60_000; // 60 s

// Redis keys for multi-instance coordination
const REDIS_LOCK_KEY = 'anime_list_refresh_lock';
const REDIS_LOCK_TTL_SECONDS = 5 * 60; // 5 min lock
const REDIS_UPDATED_KEY = 'anime_list_updated_at';

// ── state ────────────────────────────────────────────────────────────
/** @type {Map<number, {imdbId:string|null, tmdbId:number|null, tvdbId:number|null, type:string, season:number|null, seasonTvdb:number|null, seasonTmdb:number|null}>} */
let kitsuMap = new Map();
let malMap = new Map();
let anidbMap = new Map();
let anilistMap = new Map();
let tvdbMap = new Map();
let tmdbAnimeMap = new Map();
let simklMap = new Map();
let livechartMap = new Map();
let anisearchMap = new Map();

let _ready = false;
let _entryCount = 0;
let _loadedAt = 0;
let _refreshTimer = null;
let _readOnlyFilesystem = false; // Detected when write fails

const KNOWN_INVALID_TARGET_PAIRS = new Set([
    'tmdb:987654|tvdb:123456'
]);

// ── helpers ──────────────────────────────────────────────────────────

/**
 * Extract numeric ID from a prefixed anime ID string.
 * Handles "kitsu:1234", "kitsu-1234", or bare "1234".
 */
function extractNumeric(raw) {
    if (raw == null) return NaN;
    const s = String(raw);
    const m = s.match(/(?:[a-z]+[:\-])?(\d+)/i);
    return m ? parseInt(m[1], 10) : NaN;
}

function parsePositiveInteger(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeImdbId(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return /^tt\d+$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

function extractSeasonHints(rawSeason) {
    const directSeason = parsePositiveInteger(rawSeason);
    if (directSeason) {
        return {
            season: directSeason,
            seasonTvdb: directSeason,
            seasonTmdb: directSeason
        };
    }

    if (!rawSeason || typeof rawSeason !== 'object' || Array.isArray(rawSeason)) {
        return {
            season: null,
            seasonTvdb: null,
            seasonTmdb: null
        };
    }

    const seasonTvdb = parsePositiveInteger(rawSeason.tvdb);
    const seasonTmdb = parsePositiveInteger(rawSeason.tmdb);

    return {
        // Stremio/Cinemeta/IMDb season numbering aligns with TVDB-style seasons
        // more often than TMDB's anime-specific season splits.
        season: seasonTvdb || seasonTmdb || null,
        seasonTvdb,
        seasonTmdb
    };
}

function isKnownInvalidTargetPair({ tmdbId = null, tvdbId = null } = {}) {
    if (!tmdbId || !tvdbId) return false;
    return KNOWN_INVALID_TARGET_PAIRS.has(`tmdb:${tmdbId}|tvdb:${tvdbId}`);
}

function addMeta(map, id, meta) {
    const existing = map.get(id);
    if (!existing) {
        map.set(id, { ...meta, _ambiguousFields: new Set(), _variants: [{ ...meta }] });
        return;
    }

    const ambiguousFields = existing._ambiguousFields || new Set();
    const fields = ['imdbId', 'tmdbId', 'tvdbId', 'anilistId', 'type', 'season', 'seasonTvdb', 'seasonTmdb'];
    const merged = {
        _ambiguousFields: ambiguousFields,
        _variants: [...(existing._variants || []), { ...meta }]
    };

    for (const field of fields) {
        if (ambiguousFields.has(field)) {
            merged[field] = null;
            continue;
        }

        const existingValue = existing[field];
        const incomingValue = meta[field];

        if (existingValue == null) {
            merged[field] = incomingValue ?? null;
            continue;
        }

        if (incomingValue == null) {
            merged[field] = existingValue;
            continue;
        }

        if (existingValue === incomingValue) {
            merged[field] = existingValue;
            continue;
        }

        merged[field] = null;
        ambiguousFields.add(field);
    }

    map.set(id, merged);
}

function publicMeta(meta) {
    return {
        imdbId: meta?.imdbId ?? null,
        tmdbId: meta?.tmdbId ?? null,
        tvdbId: meta?.tvdbId ?? null,
        anilistId: meta?.anilistId ?? null,
        type: meta?.type ?? null,
        season: meta?.season ?? null,
        seasonTvdb: meta?.seasonTvdb ?? null,
        seasonTmdb: meta?.seasonTmdb ?? null
    };
}

function collapseVariants(variants) {
    const fields = ['imdbId', 'tmdbId', 'tvdbId', 'anilistId', 'type', 'season', 'seasonTvdb', 'seasonTmdb'];
    const collapsed = {};

    for (const field of fields) {
        const values = [...new Set(
            variants
                .map(variant => variant?.[field])
                .filter(value => value != null)
        )];
        collapsed[field] = values.length === 1 ? values[0] : null;
    }

    return collapsed;
}

function backfillMetaFromSharedTvdb(meta) {
    if (!meta || meta.imdbId || !meta.tvdbId) {
        return meta;
    }

    const sharedTvdbMeta = tvdbMap.get(meta.tvdbId);
    if (!sharedTvdbMeta?.imdbId) {
        return meta;
    }

    return {
        ...meta,
        imdbId: sharedTvdbMeta.imdbId,
        type: meta.type ?? sharedTvdbMeta.type ?? null
    };
}

function finalizeResolvedMeta(meta, aggregate = null) {
    return publicMeta(backfillMetaFromSharedTvdb({
        imdbId: meta?.imdbId ?? aggregate?.imdbId ?? null,
        tmdbId: meta?.tmdbId ?? aggregate?.tmdbId ?? null,
        tvdbId: meta?.tvdbId ?? aggregate?.tvdbId ?? null,
        anilistId: meta?.anilistId ?? aggregate?.anilistId ?? null,
        type: meta?.type ?? aggregate?.type ?? null,
        season: meta?.season ?? aggregate?.season ?? null,
        seasonTvdb: meta?.seasonTvdb ?? aggregate?.seasonTvdb ?? null,
        seasonTmdb: meta?.seasonTmdb ?? aggregate?.seasonTmdb ?? null
    }));
}

/**
 * Build all lookup Maps from the raw JSON array.
 * Each map: numericPlatformId → { imdbId, tmdbId, type, season, seasonTvdb, seasonTmdb }
 */
function buildMaps(entries) {
    const kMap = new Map();
    const mMap = new Map();
    const adbMap = new Map();
    const alMap = new Map();
    const tvMap = new Map();
    const tmMap = new Map();
    const skMap = new Map();
    const lcMap = new Map();
    const asMap = new Map();
    let structuredSeasonEntries = 0;
    let skippedSuspiciousEntries = 0;

    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        // An entry is only useful if it has at least one resolvable target
        const imdbId = normalizeImdbId(e.imdb_id);
        const tmdbId = parsePositiveInteger(e.themoviedb_id);
        const tvdbId = parsePositiveInteger(e.tvdb_id);
        if (!imdbId && !tmdbId) continue; // skip entries with no useful mapping

        if (isKnownInvalidTargetPair({ tmdbId, tvdbId })) {
            skippedSuspiciousEntries++;
            continue;
        }

        const { season, seasonTvdb, seasonTmdb } = extractSeasonHints(e.season);
        if (!parsePositiveInteger(e.season) && season && e.season && typeof e.season === 'object' && !Array.isArray(e.season)) {
            structuredSeasonEntries++;
        }
        const meta = {
            imdbId,
            tmdbId,
            tvdbId,
            anilistId: parsePositiveInteger(e.anilist_id),
            type: e.type || null,
            season,
            seasonTvdb,
            seasonTmdb
        };

        const kitsuId = parsePositiveInteger(e.kitsu_id);
        const malId = parsePositiveInteger(e.mal_id);
        const anidbId = parsePositiveInteger(e.anidb_id);
        const anilistId = parsePositiveInteger(e.anilist_id);
        const simklId = parsePositiveInteger(e.simkl_id);
        const livechartId = parsePositiveInteger(e.livechart_id);
        const anisearchId = parsePositiveInteger(e.anisearch_id);

        if (kitsuId) addMeta(kMap, kitsuId, meta);
        if (malId) addMeta(mMap, malId, meta);
        if (anidbId) addMeta(adbMap, anidbId, meta);
        if (anilistId) addMeta(alMap, anilistId, meta);
        if (tvdbId) addMeta(tvMap, tvdbId, meta);
        if (tmdbId) addMeta(tmMap, tmdbId, meta);
        if (simklId) addMeta(skMap, simklId, meta);
        if (livechartId) addMeta(lcMap, livechartId, meta);
        if (anisearchId) addMeta(asMap, anisearchId, meta);
    }

    return {
        kMap,
        mMap,
        adbMap,
        alMap,
        tvMap,
        tmMap,
        skMap,
        lcMap,
        asMap,
        stats: {
            structuredSeasonEntries,
            skippedSuspiciousEntries
        }
    };
}

// ── download / load ──────────────────────────────────────────────────

/** Ensure data/ directory exists */
function ensureDataDir() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        return true;
    } catch (err) {
        if (err.code === 'EROFS' || err.code === 'EPERM' || err.code === 'EACCES') {
            _readOnlyFilesystem = true;
            log.debug(() => '[AnimeIdResolver] Read-only filesystem detected, will use bundled data only');
            return false;
        }
        return true; // Directory might already exist
    }
}

/**
 * Download the latest anime-list-full.json from GitHub.
 * @returns {Promise<boolean>} true on success
 */
async function downloadList() {
    // Skip download attempt if filesystem is read-only
    if (_readOnlyFilesystem) {
        log.debug(() => '[AnimeIdResolver] Skipping download - read-only filesystem');
        return false;
    }

    if (!ensureDataDir()) {
        return false;
    }

    try {
        log.info(() => '[AnimeIdResolver] Downloading anime-list-full.json from GitHub…');
        const resp = await axios.get(REMOTE_URL, {
            timeout: DOWNLOAD_TIMEOUT_MS,
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'StremioSubMaker/1.0',
                Accept: 'application/json',
            },
            maxContentLength: MAX_ANIME_LIST_BYTES,
        });
        fs.writeFileSync(LOCAL_FILE, resp.data);
        const sizeMB = (resp.data.length / (1024 * 1024)).toFixed(1);
        log.info(() => `[AnimeIdResolver] Downloaded anime-list-full.json (${sizeMB} MB)`);
        return true;
    } catch (err) {
        // Detect read-only filesystem errors
        if (err.code === 'EROFS' || err.code === 'EPERM' || err.code === 'EACCES') {
            _readOnlyFilesystem = true;
            log.info(() => '[AnimeIdResolver] Read-only filesystem detected, will use bundled data only');
            return false;
        }
        log.error(() => [`[AnimeIdResolver] Download failed:`, err.message]);
        return false;
    }
}

/**
 * Load from disk, parse JSON, build maps.
 * @returns {boolean} true on success
 */
function loadFromDisk() {
    try {
        if (!fs.existsSync(LOCAL_FILE)) {
            log.debug(() => '[AnimeIdResolver] No local file found, will download');
            return false;
        }
        const raw = fs.readFileSync(LOCAL_FILE, 'utf-8');
        const entries = JSON.parse(raw);
        if (!Array.isArray(entries) || entries.length === 0) {
            log.warn(() => '[AnimeIdResolver] Local file is empty or invalid');
            return false;
        }

        const { kMap, mMap, adbMap, alMap, tvMap, tmMap, skMap, lcMap, asMap, stats } = buildMaps(entries);
        kitsuMap = kMap;
        malMap = mMap;
        anidbMap = adbMap;
        anilistMap = alMap;
        tvdbMap = tvMap;
        tmdbAnimeMap = tmMap;
        simklMap = skMap;
        livechartMap = lcMap;
        anisearchMap = asMap;
        _entryCount = entries.length;
        _loadedAt = Date.now();
        _ready = true;

        log.info(() =>
            `[AnimeIdResolver] Loaded ${entries.length} entries → ` +
            `kitsu:${kMap.size} mal:${mMap.size} anidb:${adbMap.size} anilist:${alMap.size} tvdb:${tvMap.size} tmdb:${tmMap.size} simkl:${skMap.size} livechart:${lcMap.size} anisearch:${asMap.size}` +
            (stats.structuredSeasonEntries > 0 ? ` structuredSeason:${stats.structuredSeasonEntries}` : '') +
            (stats.skippedSuspiciousEntries > 0 ? ` skippedSuspicious:${stats.skippedSuspiciousEntries}` : '')
        );
        return true;
    } catch (err) {
        log.error(() => [`[AnimeIdResolver] Failed to load from disk:`, err.message]);
        return false;
    }
}

// ── Redis leader election for multi-instance refresh ─────────────────

/**
 * Try to acquire a Redis lock for refresh.
 * Uses SET NX EX pattern for atomic lock acquisition.
 * @returns {Promise<boolean>}
 */
async function tryAcquireRefreshLock() {
    try {
        const { StorageAdapter, StorageFactory } = require('../storage');
        const redisClient = StorageFactory.getRedisClient();

        // Preferred path: true atomic lock with SET key value NX EX ttl
        if (redisClient) {
            const adapter = await StorageFactory.getStorageAdapter();
            const fullKey = adapter._getKey(REDIS_LOCK_KEY, StorageAdapter.CACHE_TYPES.PROVIDER_METADATA);
            const result = await redisClient.set(
                fullKey,
                String(Date.now()),
                'EX',
                REDIS_LOCK_TTL_SECONDS,
                'NX'
            );
            return result === 'OK';
        }

        // Fallback path for standalone/filesystem mode (best effort)
        const { getShared, setShared } = require('../utils/sharedCache');
        const existing = await getShared(REDIS_LOCK_KEY, StorageAdapter.CACHE_TYPES.PROVIDER_METADATA);
        if (existing) return false;
        await setShared(REDIS_LOCK_KEY, String(Date.now()), StorageAdapter.CACHE_TYPES.PROVIDER_METADATA, REDIS_LOCK_TTL_SECONDS);
        return true;
    } catch (err) {
        // If Redis is not available, allow this instance to refresh (standalone mode)
        log.debug(() => `[AnimeIdResolver] Redis lock unavailable (standalone mode): ${err.message}`);
        return true;
    }
}

/**
 * Release the Redis refresh lock.
 */
async function releaseRefreshLock() {
    try {
        const { StorageAdapter } = require('../storage');
        const { setShared } = require('../utils/sharedCache');
        // Set to expired value (1s TTL effectively deletes it)
        await setShared(
            REDIS_LOCK_KEY,
            '',
            StorageAdapter.CACHE_TYPES.PROVIDER_METADATA,
            1
        );
    } catch (_) { /* best effort */ }
}

/**
 * Publish the updated-at timestamp to Redis so other pods know to reload.
 */
async function publishUpdateTimestamp() {
    try {
        const { StorageAdapter } = require('../storage');
        const { setShared } = require('../utils/sharedCache');
        await setShared(
            REDIS_UPDATED_KEY,
            String(Date.now()),
            StorageAdapter.CACHE_TYPES.PROVIDER_METADATA,
            REFRESH_INTERVAL_MS / 1000 + 3600 // keep a bit longer than refresh interval
        );
    } catch (_) { /* best effort */ }
}

/**
 * Check if another pod has published a newer update than our loadedAt.
 * @returns {Promise<boolean>}
 */
async function hasNewerRemoteUpdate() {
    try {
        const { StorageAdapter } = require('../storage');
        const { getShared } = require('../utils/sharedCache');
        const ts = await getShared(REDIS_UPDATED_KEY, StorageAdapter.CACHE_TYPES.PROVIDER_METADATA);
        if (!ts) return false;
        const remoteTs = parseInt(ts, 10);
        return !isNaN(remoteTs) && remoteTs > _loadedAt;
    } catch (_) {
        return false;
    }
}

// ── public API ───────────────────────────────────────────────────────

/**
 * Initialize the resolver: load from disk, download if missing, schedule refresh.
 * Safe to call multiple times (idempotent after first success).
 */
async function initialize() {
    if (_ready) return;

    // Try loading from disk first (instant) - this includes bundled data
    if (!loadFromDisk()) {
        // No local file — try to download then load
        const ok = await downloadList();
        if (ok) {
            loadFromDisk();
        } else if (!_ready) {
            // Download failed and no bundled data - warn but don't crash
            log.warn(() => '[AnimeIdResolver] No anime-list data available. Anime ID resolution will be disabled.');
        }
    }

    // Schedule periodic refresh (only if filesystem is writable)
    if (!_refreshTimer && !_readOnlyFilesystem) {
        _refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
        // Ensure the timer doesn't prevent process exit
        if (_refreshTimer.unref) _refreshTimer.unref();
        log.debug(() => `[AnimeIdResolver] Weekly refresh scheduled (every ${REFRESH_INTERVAL_MS / (1000 * 60 * 60)} hours)`);
    } else if (_readOnlyFilesystem && _ready) {
        log.info(() => '[AnimeIdResolver] Using bundled anime-list data (read-only filesystem, refresh disabled)');
    }
}

/**
 * Refresh the data: download new copy and rebuild maps.
 * Multi-instance safe: uses Redis leader lock.
 */
async function refresh() {
    // Skip refresh on read-only filesystems
    if (_readOnlyFilesystem) {
        log.debug(() => '[AnimeIdResolver] Skipping refresh - read-only filesystem');
        return;
    }

    log.debug(() => '[AnimeIdResolver] Starting refresh cycle');

    // Check if another pod already refreshed recently
    const newerExists = await hasNewerRemoteUpdate();
    if (newerExists) {
        log.info(() => '[AnimeIdResolver] Another instance refreshed recently, reloading from disk/download');
        // Re-download to make sure we have the latest
        await downloadList();
        loadFromDisk();
        return;
    }

    // Try to become the leader
    const isLeader = await tryAcquireRefreshLock();
    if (!isLeader) {
        log.debug(() => '[AnimeIdResolver] Another instance is refreshing, will check for updates later');
        // Wait a bit then check if the other instance published an update
        setTimeout(async () => {
            const updated = await hasNewerRemoteUpdate();
            if (updated) {
                await downloadList();
                loadFromDisk();
            }
        }, 60_000); // Check after 1 minute
        return;
    }

    try {
        const ok = await downloadList();
        if (ok) {
            loadFromDisk();
            await publishUpdateTimestamp();
        }
    } finally {
        await releaseRefreshLock();
    }
}

/**
 * Resolve an anime platform ID to IMDB (and optionally TMDB).
 *
 * @param {string} platform - 'kitsu' | 'mal' | 'myanimelist' | 'anidb' | 'anilist' | 'tvdb' | 'tmdb' | 'simkl' | 'livechart' | 'anisearch'
 * @param {string|number} rawId - e.g. "kitsu:1376", "mal:20", or just "1376"
 * @param {{ seasonHint?: number|null }} [options]
 * @returns {{ imdbId: string|null, tmdbId: number|null, tvdbId:number|null, type: string|null, season:number|null, seasonTvdb:number|null, seasonTmdb:number|null } | null}
 */
function resolveImdbId(platform, rawId, options = {}) {
    if (!_ready) return null;

    const numericId = extractNumeric(rawId);
    if (isNaN(numericId)) return null;

    const rawPlatform = String(platform).toLowerCase();
    const p = rawPlatform === 'myanimelist' ? 'mal' : rawPlatform;
    let map;
    if (p === 'kitsu') map = kitsuMap;
    else if (p === 'mal') map = malMap;
    else if (p === 'anidb') map = anidbMap;
    else if (p === 'anilist') map = anilistMap;
    else if (p === 'tvdb') map = tvdbMap;
    else if (p === 'tmdb') map = tmdbAnimeMap;
    else if (p === 'simkl') map = simklMap;
    else if (p === 'livechart') map = livechartMap;
    else if (p === 'anisearch') map = anisearchMap;
    else return null;

    const result = map.get(numericId);
    if (!result) return null;

    const seasonHint = parsePositiveInteger(options?.seasonHint);
    if (seasonHint && Array.isArray(result._variants) && result._variants.length > 1) {
        const seasonField = p === 'tvdb'
            ? 'seasonTvdb'
            : p === 'tmdb'
                ? 'seasonTmdb'
                : 'season';
        const matchingVariants = result._variants.filter(variant => parsePositiveInteger(variant?.[seasonField]) === seasonHint);
        if (matchingVariants.length === 1) {
            return finalizeResolvedMeta(matchingVariants[0], result);
        }
        if (matchingVariants.length > 1) {
            return finalizeResolvedMeta(collapseVariants(matchingVariants), result);
        }
    }

    return finalizeResolvedMeta(result);
}

/**
 * Resolve a supported anime/catalog ID to its AniList ID for AniList-native
 * providers such as Jimaku. Ambiguous mappings fail closed unless a season hint
 * uniquely selects a variant.
 */
function resolveAniListId(platform, rawId, options = {}) {
    if (!_ready) return null;

    const numericId = extractNumeric(rawId);
    if (isNaN(numericId)) return null;

    const rawPlatform = String(platform || '').toLowerCase();
    const p = rawPlatform === 'myanimelist' ? 'mal' : rawPlatform;
    const maps = {
        kitsu: kitsuMap,
        mal: malMap,
        anidb: anidbMap,
        anilist: anilistMap,
        tvdb: tvdbMap,
        tmdb: tmdbAnimeMap,
        simkl: simklMap,
        livechart: livechartMap,
        anisearch: anisearchMap
    };
    const result = maps[p]?.get(numericId);
    if (!result) return null;

    const seasonHint = parsePositiveInteger(options?.seasonHint);
    if (seasonHint && Array.isArray(result._variants) && result._variants.length > 1) {
        const seasonField = p === 'tvdb' ? 'seasonTvdb' : p === 'tmdb' ? 'seasonTmdb' : 'season';
        const matchingVariants = result._variants.filter(variant => parsePositiveInteger(variant?.[seasonField]) === seasonHint);
        const matchingIds = [...new Set(matchingVariants.map(variant => parsePositiveInteger(variant?.anilistId)).filter(Boolean))];
        if (matchingIds.length === 1) return matchingIds[0];
        if (matchingIds.length > 1) return null;
    }

    const ids = [...new Set((result._variants || [result])
        .map(variant => parsePositiveInteger(variant?.anilistId))
        .filter(Boolean))];
    return ids.length === 1 ? ids[0] : null;
}

/** Whether the maps are loaded and ready for queries */
function isReady() {
    return _ready;
}

/** Entry counts per map for diagnostics */
function getStats() {
    return {
        ready: _ready,
        totalEntries: _entryCount,
        loadedAt: _loadedAt ? new Date(_loadedAt).toISOString() : null,
        maps: {
            kitsu: kitsuMap.size,
            mal: malMap.size,
            anidb: anidbMap.size,
            anilist: anilistMap.size,
            tvdb: tvdbMap.size,
            tmdb: tmdbAnimeMap.size,
            simkl: simklMap.size,
            livechart: livechartMap.size,
            anisearch: anisearchMap.size,
        },
    };
}

module.exports = {
    initialize,
    refresh,
    resolveImdbId,
    resolveAniListId,
    isReady,
    getStats,
};
