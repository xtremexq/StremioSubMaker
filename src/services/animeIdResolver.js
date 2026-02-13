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
/** @type {Map<number, {imdbId:string|null, tmdbId:number|null, type:string, season:number|null}>} */
let kitsuMap = new Map();
let malMap = new Map();
let anidbMap = new Map();
let anilistMap = new Map();
let tvdbMap = new Map();
let simklMap = new Map();
let livechartMap = new Map();
let anisearchMap = new Map();

let _ready = false;
let _entryCount = 0;
let _loadedAt = 0;
let _refreshTimer = null;

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

/**
 * Build all lookup Maps from the raw JSON array.
 * Each map: numericPlatformId → { imdbId, tmdbId, type }
 */
function buildMaps(entries) {
    const kMap = new Map();
    const mMap = new Map();
    const adbMap = new Map();
    const alMap = new Map();
    const tvMap = new Map();
    const skMap = new Map();
    const lcMap = new Map();
    const asMap = new Map();

    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        // An entry is only useful if it has at least one resolvable target
        const imdbId = e.imdb_id || null;
        const tmdbId = e.themoviedb_id || null;
        if (!imdbId && !tmdbId) continue; // skip entries with no useful mapping

        const season = Number.isFinite(Number(e.season)) ? Number(e.season) : null;
        const meta = { imdbId, tmdbId, type: e.type || null, season };

        if (e.kitsu_id) kMap.set(e.kitsu_id, meta);
        if (e.mal_id) mMap.set(e.mal_id, meta);
        if (e.anidb_id) adbMap.set(e.anidb_id, meta);
        if (e.anilist_id) alMap.set(e.anilist_id, meta);
        if (e.tvdb_id) tvMap.set(e.tvdb_id, meta);
        if (e.simkl_id) skMap.set(e.simkl_id, meta);
        if (e.livechart_id) lcMap.set(e.livechart_id, meta);
        if (e.anisearch_id) asMap.set(e.anisearch_id, meta);
    }

    return { kMap, mMap, adbMap, alMap, tvMap, skMap, lcMap, asMap };
}

// ── download / load ──────────────────────────────────────────────────

/** Ensure data/ directory exists */
function ensureDataDir() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (_) { /* already exists */ }
}

/**
 * Download the latest anime-list-full.json from GitHub.
 * @returns {Promise<boolean>} true on success
 */
async function downloadList() {
    ensureDataDir();
    try {
        log.info(() => '[AnimeIdResolver] Downloading anime-list-full.json from GitHub…');
        const resp = await axios.get(REMOTE_URL, {
            timeout: DOWNLOAD_TIMEOUT_MS,
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'StremioSubMaker/1.0',
                Accept: 'application/json',
            },
        });
        fs.writeFileSync(LOCAL_FILE, resp.data);
        const sizeMB = (resp.data.length / (1024 * 1024)).toFixed(1);
        log.info(() => `[AnimeIdResolver] Downloaded anime-list-full.json (${sizeMB} MB)`);
        return true;
    } catch (err) {
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

        const { kMap, mMap, adbMap, alMap, tvMap, skMap, lcMap, asMap } = buildMaps(entries);
        kitsuMap = kMap;
        malMap = mMap;
        anidbMap = adbMap;
        anilistMap = alMap;
        tvdbMap = tvMap;
        simklMap = skMap;
        livechartMap = lcMap;
        anisearchMap = asMap;
        _entryCount = entries.length;
        _loadedAt = Date.now();
        _ready = true;

        log.info(() =>
            `[AnimeIdResolver] Loaded ${entries.length} entries → ` +
            `kitsu:${kMap.size} mal:${mMap.size} anidb:${adbMap.size} anilist:${alMap.size} tvdb:${tvMap.size} simkl:${skMap.size} livechart:${lcMap.size} anisearch:${asMap.size}`
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

    // Try loading from disk first (instant)
    if (!loadFromDisk()) {
        // No local file — download then load
        const ok = await downloadList();
        if (ok) loadFromDisk();
    }

    // Schedule periodic refresh
    if (!_refreshTimer) {
        _refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
        // Ensure the timer doesn't prevent process exit
        if (_refreshTimer.unref) _refreshTimer.unref();
        log.debug(() => `[AnimeIdResolver] Weekly refresh scheduled (every ${REFRESH_INTERVAL_MS / (1000 * 60 * 60)} hours)`);
    }
}

/**
 * Refresh the data: download new copy and rebuild maps.
 * Multi-instance safe: uses Redis leader lock.
 */
async function refresh() {
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
 * @param {string} platform - 'kitsu' | 'mal' | 'myanimelist' | 'anidb' | 'anilist' | 'tvdb' | 'simkl' | 'livechart' | 'anisearch'
 * @param {string|number} rawId - e.g. "kitsu:1376", "mal:20", or just "1376"
 * @returns {{ imdbId: string|null, tmdbId: number|null, type: string|null, season:number|null } | null}
 */
function resolveImdbId(platform, rawId) {
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
    else if (p === 'simkl') map = simklMap;
    else if (p === 'livechart') map = livechartMap;
    else if (p === 'anisearch') map = anisearchMap;
    else return null;

    const result = map.get(numericId);
    return result || null;
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
    isReady,
    getStats,
};
