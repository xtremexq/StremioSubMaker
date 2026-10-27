const axios = require('axios');
const { httpAgent, httpsAgent, dnsLookup } = require('../utils/httpAgents');
const { createPublicRemoteRequestConfig } = require('../utils/publicRemoteRequest');
const { detectAndConvertEncoding } = require('../utils/encodingDetector');
const {
    detectArchiveType,
    extractSubtitleFromArchive,
    convertSubtitleToVtt
} = require('../utils/archiveExtractor');
const { MAX_REMOTE_SUBTITLE_BYTES } = require('../utils/resourceLimits');
const { toISO6391, normalizeLanguageCode } = require('../utils/languages');
const log = require('../utils/logger');
const { version } = require('../utils/version');

const API_BASE_URL = 'https://api.thesubtitledb.org';
const PROVIDER_NAME = 'The Subtitle Database';
const USER_AGENT = `SubMaker v${version}`;
const DEFAULT_RESULT_LIMIT = 100;

const API_LANGUAGE_OVERRIDES = Object.freeze({
    pob: 'pb',
    zhs: 'zh',
    zht: 'zt',
    chi: 'zh,zt,ze,zc',
    zho: 'zh,zt,ze,zc',
    spa: 'es,ea,sp',
    por: 'pt,pb,pm',
    yue: 'zc',
    wen: 'sb',
    tp: 'tp'
});

const RESULT_LANGUAGE_OVERRIDES = Object.freeze({
    pb: 'pob',
    zt: 'zht',
    ea: 'spn',
    sp: 'spa',
    pm: 'por',
    zc: 'yue',
    me: 'mne',
    at: 'ast',
    ma: 'mni',
    sb: 'wen'
});

function toApiLanguageCode(language) {
    const normalized = String(language || '').trim().toLowerCase();
    if (!normalized) return null;

    const internalCode = normalizeLanguageCode(normalized) || normalized;
    if (API_LANGUAGE_OVERRIDES[internalCode]) {
        return API_LANGUAGE_OVERRIDES[internalCode].split(',');
    }

    const code = toISO6391(internalCode);
    if (!code) return [];
    return [code.toLowerCase().replace(/^pt-br$/, 'pb').replace(/^zh-cn$/, 'zh').replace(/^zh-tw$/, 'zt')];
}

function getApiLanguageCodes(languages = []) {
    return [...new Set((Array.isArray(languages) ? languages : []).flatMap(toApiLanguageCode).filter(Boolean))].slice(0, 16);
}

function getLookupPath(params = {}) {
    const rawImdbId = String(params.imdb_id || '').trim();
    const imdbMatch = rawImdbId.match(/^(tt\d+)(?::\d+:\d+)?$/i);
    const rawTmdbId = String(params.tmdb_id || '').trim();
    const tmdbId = rawTmdbId.match(/^\d+$/)?.[0] || null;
    const isEpisode = params.type === 'episode' || params.type === 'anime-episode';
    const season = Number.parseInt(params.season, 10);
    const episode = Number.parseInt(params.episode, 10);

    let path;
    if (imdbMatch) {
        path = `/v1/by-imdb/${imdbMatch[1].toLowerCase()}`;
    } else if (tmdbId) {
        const mediaType = isEpisode || String(params.tmdbMediaType || '').toLowerCase() === 'tv'
            ? 'tv'
            : 'movie';
        path = `/v1/by-tmdb/${mediaType}/${tmdbId}`;
    } else if (String(params.filename || '').trim()) {
        return '/v1/by-releasename';
    } else if (String(params.title || '').trim()) {
        return '/v1/by-title';
    } else {
        return null;
    }

    if (isEpisode && Number.isInteger(season) && season > 0) {
        path += `/season/${season}`;
        if (Number.isInteger(episode) && episode > 0) {
            path += `/episode/${episode}`;
        }
    }

    return path;
}

function normalizeFormat(format) {
    const normalized = String(format || 'srt').trim().toLowerCase();
    return /^[a-z0-9]{1,8}$/.test(normalized) ? normalized : 'srt';
}

function isEpisodePack(releaseName, isEpisode) {
    if (!isEpisode) return false;
    const name = String(releaseName || '');
    return /\bS\d{1,2}E\d{1,2}\s*(?:-|~|to)\s*(?:S\d{1,2})?E?\d{1,2}\b/i.test(name)
        || /\b(?:season[ ._-]*pack|season\s+\d+\s+(?:complete|pack)|complete\s+season)\b/i.test(name);
}

function mapSubtitle(subtitle, params = {}) {
    const rawId = String(subtitle?.id ?? '').trim();
    if (!/^\d+$/.test(rawId)) return null;

    const language = String(subtitle.language || '').trim().toLowerCase();
    const languageCode = RESULT_LANGUAGE_OVERRIDES[language] || normalizeLanguageCode(language);
    const format = normalizeFormat(subtitle.format);
    const name = String(subtitle.release_name || '').trim() || `${PROVIDER_NAME} (${language || 'unknown'})`;
    const isSeasonPack = isEpisodePack(name, params.type === 'episode' || params.type === 'anime-episode');
    const season = Number.parseInt(params.season, 10);
    const episode = Number.parseInt(params.episode, 10);
    const seasonPackSuffix = isSeasonPack && Number.isInteger(season) && season > 0 && Number.isInteger(episode) && episode > 0
        ? `_seasonpack_s${season}e${episode}`
        : '';
    const fileId = `tsdb_${rawId}_${format}${seasonPackSuffix}`;

    return {
        id: fileId,
        fileId,
        language,
        languageCode,
        name,
        url: `${API_BASE_URL}/get/${rawId}`,
        downloads: Number(subtitle.downloads) || 0,
        rating: Number(subtitle.rating) || 0,
        uploadDate: subtitle.added_at || null,
        format,
        hearing_impaired: subtitle.hearing_impaired === true,
        foreign_parts_only: false,
        machine_translated: subtitle.ai_transcribed === true,
        provider: 'thesubtitledb',
        fps: Number(subtitle.fps) || null,
        is_season_pack: isSeasonPack,
        season_pack_season: isSeasonPack && Number.isInteger(season) ? season : null,
        season_pack_episode: isSeasonPack && Number.isInteger(episode) ? episode : null,
        _tsdbId: rawId
    };
}

class TheSubtitleDatabaseService {
    constructor() {
        this.client = axios.create({
            baseURL: API_BASE_URL,
            headers: {
                'User-Agent': USER_AGENT,
                Accept: 'application/json, text/plain, text/vtt, application/x-subrip, */*'
            },
            httpAgent,
            httpsAgent,
            lookup: dnsLookup,
            timeout: 12000,
            maxContentLength: MAX_REMOTE_SUBTITLE_BYTES,
            maxBodyLength: MAX_REMOTE_SUBTITLE_BYTES
        });
    }

    async searchSubtitles(params = {}) {
        const path = getLookupPath(params);
        if (!path) {
            log.debug(() => '[TSDB] Skipping search: no supported IMDb or TMDB ID');
            return [];
        }

        const languageCodes = getApiLanguageCodes(params.languages);
        const timeout = Number.parseInt(params.providerTimeout, 10) || 12000;
        const query = {
            ...(languageCodes.length ? { lang: languageCodes.join(',') } : {}),
            limit: DEFAULT_RESULT_LIMIT
        };
        if (path === '/v1/by-releasename') {
            query.release = String(params.filename || '').trim().slice(0, 512);
        } else if (path === '/v1/by-title') {
            query.q = String(params.title || '').trim().slice(0, 200);
            query.type = String(params.tmdbMediaType || '').toLowerCase() === 'tv'
                || params.stremioType === 'series'
                || params.type === 'series'
                || params.type === 'episode'
                || params.type === 'anime-episode'
                ? 'tv'
                : 'movie';
        }
        const isEpisodeLookup = params.type === 'episode' || params.type === 'anime-episode';
        const isSeriesRoot = !isEpisodeLookup && (
            params.stremioType === 'series'
            || params.type === 'series'
            || String(params.tmdbMediaType || '').toLowerCase() === 'tv'
        );
        if (isSeriesRoot) query.limit = 20;
        const response = await this.client.get(path, {
            params: query,
            timeout
        });

        const items = Array.isArray(response.data?.subtitles?.items)
            ? response.data.subtitles.items
            : [];
        let results = items.map(item => mapSubtitle(item, params)).filter(Boolean);

        if (params.excludeHearingImpairedSubtitles === true) {
            results = results.filter(subtitle => !subtitle.hearing_impaired);
        }

        log.debug(() => `[TSDB] Found ${results.length} subtitle(s) for ${path}`);
        return results;
    }

    async downloadSubtitle(fileId, options = {}) {
        const match = String(fileId || '').match(/^tsdb_(\d+)_([a-z0-9]{1,8})(?:_seasonpack_s(\d+)e(\d+))?$/i);
        if (!match) {
            throw new Error('Invalid The Subtitle Database file ID format');
        }

        const [, id, rawFormat, rawSeason, rawEpisode] = match;
        const format = normalizeFormat(rawFormat);
        const isSeasonPack = Boolean(rawSeason && rawEpisode);
        const season = isSeasonPack ? Number.parseInt(rawSeason, 10) : null;
        const episode = isSeasonPack ? Number.parseInt(rawEpisode, 10) : null;
        const timeout = Number.parseInt(options.timeout, 10) || 20000;
        const downloadUrl = `${API_BASE_URL}/get/${id}`;
        const response = await axios.get(downloadUrl, createPublicRemoteRequestConfig(downloadUrl, {
            responseType: 'arraybuffer',
            timeout,
            headers: {
                'User-Agent': USER_AGENT,
                Accept: 'application/octet-stream, text/plain, text/vtt, application/x-subrip, */*'
            },
            maxContentLength: MAX_REMOTE_SUBTITLE_BYTES,
            maxBodyLength: MAX_REMOTE_SUBTITLE_BYTES
        }, {
            requireHttps: true,
            maxBytes: MAX_REMOTE_SUBTITLE_BYTES,
            context: `${PROVIDER_NAME} subtitle download`
        }));

        const buffer = Buffer.from(response.data);
        if (!buffer.length) {
            throw new Error('The Subtitle Database returned an empty subtitle file');
        }
        if (buffer.length > MAX_REMOTE_SUBTITLE_BYTES) {
            throw new Error(`The Subtitle Database subtitle exceeds the ${MAX_REMOTE_SUBTITLE_BYTES} byte limit`);
        }

        const archiveType = detectArchiveType(buffer);
        if (archiveType) {
            return extractSubtitleFromArchive(buffer, {
                providerName: PROVIDER_NAME,
                maxBytes: MAX_REMOTE_SUBTITLE_BYTES,
                isSeasonPack,
                season,
                episode,
                languageHint: options.languageHint || null,
                skipAssConversion: options.skipAssConversion
            });
        }

        const content = detectAndConvertEncoding(buffer, PROVIDER_NAME, options.languageHint || null);
        const trimmed = content.trim();
        if (!trimmed || /^<(?:!doctype\s+html|html\b)/i.test(trimmed)) {
            throw new Error('The Subtitle Database returned an invalid subtitle response');
        }

        return convertSubtitleToVtt(content, `subtitle.${format}`, PROVIDER_NAME, {
            skipAssConversion: options.skipAssConversion
        });
    }
}

module.exports = TheSubtitleDatabaseService;
module.exports.__testing = {
    getLookupPath,
    toApiLanguageCode,
    mapSubtitle,
    isEpisodePack,
    normalizeFormat,
    getApiLanguageCodes
};
