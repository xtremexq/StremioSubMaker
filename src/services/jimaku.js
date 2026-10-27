'use strict';

const axios = require('axios');
const path = require('node:path');
const animeIdResolver = require('./animeIdResolver');
const { httpAgent, httpsAgent, dnsLookup } = require('../utils/httpAgents');
const { detectAndConvertEncoding } = require('../utils/encodingDetector');
const { detectArchiveType, extractSubtitleFromArchive, convertSubtitleToVtt } = require('../utils/archiveExtractor');
const { encodeProviderUrl, decodeProviderUrl } = require('../utils/providerUrlToken');
const {
    MAX_REMOTE_SUBTITLE_BYTES,
    createPublicRemoteRequestConfig
} = require('../utils/publicRemoteRequest');
const {
    getProviderAuthFailureCacheKey,
    hasCachedProviderAuthFailure,
    cacheProviderAuthFailure,
    clearCachedProviderAuthFailure
} = require('../utils/providerAuthFailureCache');
const { version } = require('../utils/version');
const log = require('../utils/logger');

const API_BASE_URL = 'https://jimaku.cc/api';
const SITE_ORIGIN = 'https://jimaku.cc';
const PROVIDER_NAME = 'Jimaku';
const USER_AGENT = `SubMaker v${version} (subtitle provider; https://github.com/xtremexq/StremioSubMaker)`;
const MAX_ENTRIES_PER_SEARCH = 3;
const MAX_FILES_PER_SEARCH = 14;
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([
    '.srt', '.ass', '.ssa', '.vtt', '.sub', '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.br'
]);

function normalizeApiKey(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeAniListId(params = {}) {
    const raw = String(params.anilistId || (params.animeIdType === 'anilist' ? params.animeId : '') || '').trim();
    const direct = raw.match(/^(?:anilist:)?(\d+)$/i);
    if (direct) return positiveInteger(direct[1]);

    const platform = String(params.animeIdType || '').trim().toLowerCase();
    if (platform && params.animeId && typeof animeIdResolver.resolveAniListId === 'function') {
        return animeIdResolver.resolveAniListId(platform, params.animeId, {
            seasonHint: params.season || null
        });
    }

    if (params.tmdb_id && params.isAnime === true && typeof animeIdResolver.resolveAniListId === 'function') {
        return animeIdResolver.resolveAniListId('tmdb', params.tmdb_id, {
            seasonHint: params.tmdbSeason || params.season || null
        });
    }
    return null;
}

function getSearchTerm(params = {}) {
    const supplied = [params.seriesTitle, params.title, params.filename]
        .find(value => typeof value === 'string' && value.trim().length >= 3);
    if (!supplied) return '';
    const cleaned = supplied.trim()
        .replace(/\.[a-z0-9]{1,8}$/i, '')
        .replace(/[._]+/g, ' ')
        .replace(/\[[^\]]{1,40}\]/g, ' ')
        .replace(/\([^)]{1,60}\)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned.length > 160 ? cleaned.slice(0, 160).trim() : cleaned;
}

function isAllowedDownloadUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        return parsed.protocol === 'https:'
            && parsed.hostname.toLowerCase() === 'jimaku.cc'
            && parsed.port === ''
            && parsed.username === ''
            && parsed.password === ''
            && /^\/entry\/\d+\/download\//.test(parsed.pathname);
    } catch (_) {
        return false;
    }
}

function getExtension(nameOrUrl) {
    try {
        const pathname = new URL(nameOrUrl, SITE_ORIGIN).pathname;
        return path.extname(decodeURIComponent(pathname)).toLowerCase();
    } catch (_) {
        return path.extname(String(nameOrUrl || '').split(/[?#]/)[0]).toLowerCase();
    }
}

function detectSeasonPack(filename) {
    const name = String(filename || '');
    return /\b\d{1,3}\s*[-~]\s*\d{1,3}\b/i.test(name)
        || /\b(?:batch|complete|season[ ._-]*pack|全集)\b/i.test(name);
}

function matchesRequestedEpisode(filename, episodeValue, seasonValue = null) {
    const episode = positiveInteger(episodeValue);
    if (!episode) return true;
    const season = positiveInteger(seasonValue);
    const name = String(filename || '');
    const seasonEpisodeMatches = [...name.matchAll(/(?:^|[^a-z0-9])s(\d{1,2})[ ._-]*e(\d{1,3})(?:v\d+)?(?=$|[^0-9])/ig)];
    if (seasonEpisodeMatches.length) {
        return seasonEpisodeMatches.some(match => Number(match[2]) === episode && (!season || Number(match[1]) === season));
    }
    const xEpisodeMatches = [...name.matchAll(/(?:^|[^0-9])(\d{1,2})x(\d{1,3})(?:v\d+)?(?=$|[^0-9])/ig)];
    if (xEpisodeMatches.length) {
        return xEpisodeMatches.some(match => Number(match[2]) === episode && (!season || Number(match[1]) === season));
    }

    const numericTokens = [...name.matchAll(/(?:^|[\s._\[(\-])(?:ep(?:isode)?[ ._-]*)?0*(\d{1,3})(?:v\d+)?(?=$|[\s.\])\-_,])/ig)]
        .map(match => Number(match[1]));
    const ranges = [...name.matchAll(/(?:^|[^0-9])0*(\d{1,3})\s*[-~]\s*0*(\d{1,3})(?=$|[^0-9])/g)]
        .map(match => [Number(match[1]), Number(match[2])]);
    if (ranges.some(([start, end]) => episode >= Math.min(start, end) && episode <= Math.max(start, end))) {
        return true;
    }
    if (numericTokens.length) return numericTokens.includes(episode);
    // Keep files without recognizable episode numbers; archives and some fansub
    // naming styles omit numbers even when Jimaku's episode filter matched them.
    return true;
}

function addEpisodeContextToUrl(rawUrl, params = {}, isSeasonPack = false, filename = '') {
    const url = new URL(rawUrl);
    const season = positiveInteger(params.season);
    const episode = positiveInteger(params.episode);
    // The fragment is sealed into the opaque provider file ID and never sent
    // upstream. It preserves the original extension for extensionless download
    // URLs and lets archive extraction select the requested episode.
    const context = new URLSearchParams();
    if (episode) {
        context.set('submaker-season', String(season || 0));
        context.set('episode', String(episode));
        context.set('pack', isSeasonPack ? '1' : '0');
    }
    if (filename) context.set('name', filename);
    url.hash = context.toString();
    return url.toString();
}

function parseEpisodeContext(url) {
    const hash = String(url.hash || '').replace(/^#/, '');
    const params = new URLSearchParams(hash);
    const season = positiveInteger(params.get('submaker-season'));
    const episode = positiveInteger(params.get('episode'));
    return {
        season,
        episode,
        isSeasonPack: params.get('pack') === '1',
        filename: path.basename(String(params.get('name') || '').replace(/\\/g, '/'))
    };
}

function mapFileEntry(file, entry, params = {}) {
    const name = typeof file?.name === 'string' ? file.name.trim() : '';
    const rawUrl = typeof file?.url === 'string' ? file.url : '';
    const extension = getExtension(name || rawUrl);
    if (!name || !SUPPORTED_EXTENSIONS.has(extension) || !isAllowedDownloadUrl(rawUrl)) return null;
    if (!matchesRequestedEpisode(name, params.episode, params.season)) return null;

    const isArchive = extension === '.zip' || extension === '.rar' || extension === '.7z' || extension === '.tar'
        || extension === '.gz' || extension === '.bz2' || extension === '.xz' || extension === '.br';
    const isSeasonPack = isArchive && detectSeasonPack(name);
    const downloadUrl = addEpisodeContextToUrl(rawUrl, params, isSeasonPack, name);
    const fileId = encodeProviderUrl('jimaku_', downloadUrl);
    const releaseName = String(entry?.name || '').trim();

    return {
        id: fileId,
        fileId,
        language: 'jpn',
        languageCode: 'jpn',
        name: `${PROVIDER_NAME}: ${name}${releaseName ? ` — ${releaseName}` : ''}`,
        downloads: 0,
        rating: 0,
        uploadDate: file.last_modified || null,
        format: extension.slice(1),
        hearing_impaired: /\[(?:sdh|cc|hi)\]/i.test(name),
        foreign_parts_only: false,
        machine_translated: false,
        provider: 'jimaku',
        is_season_pack: isSeasonPack,
        season_pack_season: isSeasonPack ? positiveInteger(params.season) : null,
        season_pack_episode: isSeasonPack ? positiveInteger(params.episode) : null,
        _jimakuEntryId: positiveInteger(entry?.id)
    };
}

class JimakuService {
    constructor(apiKey = '') {
        this.apiKey = normalizeApiKey(apiKey);
        this.authFailureCacheKey = getProviderAuthFailureCacheKey('jimaku', this.apiKey);
        this.client = axios.create({
            baseURL: API_BASE_URL,
            headers: {
                Authorization: this.apiKey,
                'User-Agent': USER_AGENT,
                Accept: 'application/json'
            },
            httpAgent,
            httpsAgent,
            lookup: dnsLookup,
            timeout: 10000,
            maxContentLength: MAX_API_RESPONSE_BYTES,
            maxBodyLength: MAX_API_RESPONSE_BYTES
        });
    }

    async validateApiKey({ timeout = 10000, cacheAuthFailures = true } = {}) {
        if (!this.apiKey) return { valid: false, error: 'Jimaku API key is required' };
        try {
            const response = await this.client.get('/entries/search', {
                params: { query: 'Frieren' },
                timeout,
                validateStatus: () => true
            });
            if (response.status === 200 && Array.isArray(response.data)) {
                await clearCachedProviderAuthFailure(this.authFailureCacheKey).catch(() => {});
                return { valid: true, resultsCount: response.data.length };
            }
            if (response.status === 401 || response.status === 403) {
                if (cacheAuthFailures) await cacheProviderAuthFailure(this.authFailureCacheKey);
                return { valid: false, error: 'Jimaku rejected the API key' };
            }
            return { valid: false, error: `Jimaku returned HTTP ${response.status}` };
        } catch (error) {
            return { valid: false, error: error.message || 'Jimaku validation request failed' };
        }
    }

    async searchSubtitles(params = {}) {
        if (!this.apiKey) return [];
        if (await hasCachedProviderAuthFailure(this.authFailureCacheKey)) {
            log.warn(() => '[Jimaku] Search skipped because the API key was previously rejected');
            return [];
        }

        const requestedLanguages = Array.isArray(params.languages) ? params.languages : [];
        const wantsJapanese = requestedLanguages.length === 0 || requestedLanguages.some(language => {
            const normalized = String(language || '').trim().toLowerCase();
            return normalized === 'jpn' || normalized === 'ja' || normalized === 'japanese' || normalized === 'und';
        });
        if (!wantsJapanese) return [];

        const isAnime = params.isAnime === true || params.type === 'anime' || params.type === 'anime-episode';
        if (!isAnime) return [];

        const timeout = Math.max(1000, Math.min(15000, Number.parseInt(params.providerTimeout, 10) || 10000));
        const anilistId = normalizeAniListId(params);
        const query = anilistId ? { anilist_id: anilistId } : { query: getSearchTerm(params) };
        if (!anilistId && !query.query) return [];

        try {
            const entryResponse = await this.client.get('/entries/search', {
                params: query,
                timeout
            });
            const entries = Array.isArray(entryResponse.data) ? entryResponse.data : [];
            if (!entries.length) return [];

            const uniqueEntries = entries
                .filter(entry => positiveInteger(entry?.id))
                .filter(entry => entry?.flags?.anime !== false)
                .slice(0, MAX_ENTRIES_PER_SEARCH);
            const filesByEntry = await Promise.all(uniqueEntries.map(async entry => {
                try {
                    const response = await this.client.get(`/entries/${positiveInteger(entry.id)}/files`, {
                        params: (params.type === 'episode' || params.type === 'anime-episode') && positiveInteger(params.episode)
                            ? { episode: positiveInteger(params.episode) }
                            : undefined,
                        timeout
                    });
                    return { entry, files: Array.isArray(response.data) ? response.data : [] };
                } catch (error) {
                    log.warn(() => `[Jimaku] File listing failed for an entry (status=${error?.response?.status || 'network'})`);
                    return { entry, files: [] };
                }
            }));

            const results = filesByEntry.flatMap(({ entry, files }) => files
                .map(file => mapFileEntry(file, entry, params))
                .filter(Boolean))
                .slice(0, MAX_FILES_PER_SEARCH);
            log.debug(() => `[Jimaku] Found ${results.length} Japanese subtitle file(s)`);
            return results;
        } catch (error) {
            const status = error?.response?.status;
            if ((status === 401 || status === 403) && this.authFailureCacheKey) {
                await cacheProviderAuthFailure(this.authFailureCacheKey).catch(() => {});
            }
            log.warn(() => `[Jimaku] Search request failed (status=${status || 'network'}${error?.code ? `, code=${error.code}` : ''})`);
            return [];
        }
    }

    async downloadSubtitle(fileId, options = {}) {
        const rawUrl = decodeProviderUrl(fileId, 'jimaku_');
        const url = new URL(rawUrl);
        if (!isAllowedDownloadUrl(url.toString())) {
            throw new Error('Jimaku returned an invalid subtitle download URL');
        }
        const episodeContext = parseEpisodeContext(url);
        url.hash = '';
        const timeout = Math.max(1000, Math.min(30000, Number.parseInt(options.timeout, 10) || 18000));
        const response = await axios.get(url.toString(), createPublicRemoteRequestConfig(url.toString(), {
            responseType: 'arraybuffer',
            timeout,
            headers: {
                'User-Agent': USER_AGENT,
                Accept: 'application/octet-stream, text/plain, */*'
            }
        }, {
            requireHttps: true,
            maxBytes: MAX_REMOTE_SUBTITLE_BYTES,
            context: 'Jimaku subtitle download'
        }));

        const buffer = Buffer.from(response.data);
        if (!buffer.length) throw new Error('Jimaku returned an empty subtitle file');
        if (buffer.length > MAX_REMOTE_SUBTITLE_BYTES) {
            throw new Error(`Jimaku subtitle exceeds the ${MAX_REMOTE_SUBTITLE_BYTES} byte limit`);
        }

        const filename = episodeContext.filename || path.basename(decodeURIComponent(url.pathname));
        const archiveType = detectArchiveType(buffer);
        if (archiveType) {
            return extractSubtitleFromArchive(buffer, {
                providerName: PROVIDER_NAME,
                maxBytes: MAX_REMOTE_SUBTITLE_BYTES,
                isSeasonPack: episodeContext.isSeasonPack,
                season: episodeContext.season,
                episode: episodeContext.episode,
                languageHint: options.languageHint || 'jpn',
                skipAssConversion: options.skipAssConversion
            });
        }

        const content = detectAndConvertEncoding(buffer, PROVIDER_NAME, options.languageHint || 'jpn');
        const trimmed = content.trim();
        if (!trimmed || /^<(?:!doctype\s+html|html\b)/i.test(trimmed)) {
            throw new Error('Jimaku returned an invalid subtitle response');
        }
        const extension = getExtension(filename);
        return convertSubtitleToVtt(content, filename || `subtitle${extension || '.srt'}`, PROVIDER_NAME, {
            skipAssConversion: options.skipAssConversion
        });
    }
}

module.exports = JimakuService;
module.exports.__testing = {
    normalizeAniListId,
    getSearchTerm,
    isAllowedDownloadUrl,
    getExtension,
    detectSeasonPack,
    matchesRequestedEpisode,
    mapFileEntry,
    addEpisodeContextToUrl,
    parseEpisodeContext
};
