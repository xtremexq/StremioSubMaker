/**
 * Wyzie Subs Service
 * 
 * Wyzie Subs is a free, open-source subtitle scraping API that aggregates
 * from multiple sources:
 *   - subdl
 *   - subf2m
 *   - opensubtitles
 *   - podnapisi
 *   - gestdown (for TV shows)
 *   - animetosho (for anime)
 * 
 * API Docs: https://docs.wyzie.io/subs/usage/api-keys
 * Source: https://github.com/wyziedevs/wyzie-subs
 * Status: https://sub.wyzie.io/status
 * 
 * Features:
 * - Supports both IMDB and TMDB IDs (Wyzie converts TMDB→IMDB internally)
 * - Automatic ZIP extraction (handled server-side)
 * - Episode filtering for TV shows (done by Wyzie)
 * - Returns isHearingImpaired flag for client-side filtering
 * 
 * ============================================================================
 * PERFORMANCE NOTES (Why wyzie-lib NPM package won't help):
 * ============================================================================
 * 
 * The `wyzie-lib` NPM package (https://www.npmjs.com/package/wyzie-lib) is just
 * a thin client wrapper that makes HTTP requests to the same sub.wyzie.io API.
 * It does NOT bundle any scraping logic locally. See the source:
 * https://unpkg.com/wyzie-lib@2.2.6/lib/main.js
 * 
 * The slowness comes from Wyzie's server architecture:
 *   1. Our addon → Wyzie API (network hop to Cloudflare Workers)
 *   2. Wyzie API → i6.shark proxy (internal IPv6 rotation proxy)
 *   3. i6.shark → Actual sources (SubDL/OpenSubtitles/Subf2m/etc.)
 *   4. Response back through the chain
 * 
 * Each source is scraped ON-THE-FLY with no caching on Wyzie's end.
 * 
 * To improve performance, we:
 *   1. Use keep-alive connections (via httpAgents.js)
 *   2. Track response times for debugging
 *   3. For fastest results, users should prefer direct providers (SubDL, OpenSubtitles)
 *      which bypass the aggregation layer entirely.
 * ============================================================================
 */

const axios = require('axios');
const { toISO6391 } = require('../utils/languages');
const { httpAgent, httpsAgent, dnsLookup } = require('../utils/httpAgents');
const { detectAndConvertEncoding } = require('../utils/encodingDetector');
const { getSeasonHintCandidates } = require('../utils/animeSearchResolver');
const { convertSubtitleToVtt } = require('../utils/archiveExtractor');
const { redactApiKey } = require('../utils/security');
const log = require('../utils/logger');
const { version } = require('../utils/version');

const WYZIE_API_URL = 'https://sub.wyzie.io';
const USER_AGENT = `SubMaker v${version}`;
const ALL_WYZIE_SOURCES = ['opensubtitles', 'subf2m', 'subdl', 'podnapisi', 'gestdown', 'animetosho', 'kitsunekko', 'jimaku', 'yify'];

// Maximum results per language to prevent overwhelming the user with choices
const MAX_RESULTS_PER_LANGUAGE = 14;

// ISO 639-1 (2-letter) to ISO 639-2/B (3-letter) mapping
// Wyzie returns ISO 639-1, SubMaker uses ISO 639-2/B internally
// Comprehensive mapping based on other providers (SubDL, SubSource)
const ISO1_TO_ISO2B = {
    // Common European languages
    'en': 'eng', 'es': 'spa', 'pt': 'por', 'fr': 'fre', 'de': 'ger',
    'it': 'ita', 'nl': 'dut', 'pl': 'pol', 'ru': 'rus', 'cs': 'cze',
    'hu': 'hun', 'ro': 'rum', 'el': 'gre', 'uk': 'ukr', 'bg': 'bul',
    'hr': 'hrv', 'sk': 'slo', 'sl': 'slv', 'sr': 'srp', 'bs': 'bos',
    'mk': 'mac', 'sq': 'alb', 'be': 'bel', 'lv': 'lav', 'lt': 'lit',
    'et': 'est', 'is': 'ice', 'mt': 'mlt', 'ga': 'gle', 'cy': 'wel',
    // Scandinavian
    'sv': 'swe', 'da': 'dan', 'no': 'nor', 'fi': 'fin', 'nb': 'nor', 'nn': 'nor',
    // Asian languages
    'ja': 'jpn', 'ko': 'kor', 'zh': 'chi', 'vi': 'vie', 'th': 'tha',
    'id': 'ind', 'ms': 'may', 'tl': 'tgl', 'hi': 'hin', 'bn': 'ben',
    'ta': 'tam', 'te': 'tel', 'ml': 'mal', 'ur': 'urd', 'km': 'khm',
    'lo': 'lao', 'my': 'bur', 'ka': 'geo', 'az': 'aze',
    // Middle Eastern
    'ar': 'ara', 'tr': 'tur', 'he': 'heb', 'fa': 'per', 'ku': 'kur', 'sy': 'syr',
    // African
    'sw': 'swa', 'am': 'amh', 'so': 'som', 'ha': 'hau', 'yo': 'yor',
    'zu': 'zul', 'xh': 'xho', 'af': 'afr',
    // Regional variants
    'pt-br': 'pob', 'pb': 'pob',  // Wyzie uses 'pb' for Brazilian Portuguese
    'zh-cn': 'chi', 'zh-tw': 'chi', 'zh-hk': 'chi',
    'zt': 'chi', 'ze': 'chi',  // Wyzie uses 'zt' for Traditional Chinese, 'ze' for bilingual
    // Other
    'eu': 'baq', 'ca': 'cat', 'gl': 'glg', 'eo': 'epo', 'la': 'lat'
};

/**
 * Normalize language code from Wyzie format (ISO 639-1) to SubMaker's ISO 639-2/B
 * @param {string} lang - Language code from Wyzie (usually 2-letter ISO 639-1)
 * @returns {string} - Normalized 3-letter ISO 639-2/B code for SubMaker
 */
function normalizeLanguageCode(lang) {
    if (!lang) return '';
    const lower = lang.toLowerCase().trim();

    // Handle Portuguese Brazilian specially
    if (lower === 'pt-br' || lower === 'pb' || lower === 'pob') {
        return 'pob';
    }

    // If already 3 letters, assume it's ISO 639-2
    if (lower.length === 3 && /^[a-z]{3}$/.test(lower)) {
        return lower;
    }

    // Convert ISO 639-1 to ISO 639-2/B
    if (ISO1_TO_ISO2B[lower]) {
        return ISO1_TO_ISO2B[lower];
    }

    // Handle hyphenated codes (e.g., pt-br, zh-cn)
    const base = lower.split('-')[0];
    if (ISO1_TO_ISO2B[base]) {
        return ISO1_TO_ISO2B[base];
    }

    // Return as-is if no mapping found
    return lang;
}

function normalizeWyzieApiKey(apiKey) {
    if (typeof apiKey !== 'string') {
        return '';
    }
    return apiKey.trim();
}

function normalizeWyzieSources(sources) {
    const raw = (sources && typeof sources === 'object') ? sources : {};
    return {
        opensubtitles: raw.opensubtitles === true || raw.opensubs === true,
        subf2m: raw.subf2m === true,
        subdl: raw.subdl === true,
        podnapisi: raw.podnapisi === true,
        gestdown: raw.gestdown === true,
        animetosho: raw.animetosho === true,
        kitsunekko: raw.kitsunekko === true,
        jimaku: raw.jimaku === true,
        yify: raw.yify === true
    };
}

function redactWyzieUrl(url) {
    try {
        const parsed = new URL(url, WYZIE_API_URL);
        if (parsed.searchParams.has('key')) {
            parsed.searchParams.set('key', '[REDACTED]');
        }
        return `${parsed.pathname}${parsed.search}`;
    } catch (_) {
        return String(url || '').replace(/([?&]key=)[^&]+/i, '$1[REDACTED]');
    }
}

function getWyzieUpstreamMessage(payload, fallback = '') {
    if (typeof payload === 'string' && payload.trim()) {
        return payload.trim();
    }

    if (payload && typeof payload === 'object') {
        const details = typeof payload.details === 'string' ? payload.details.trim() : '';
        const message = typeof payload.message === 'string' ? payload.message.trim() : '';
        return details || message || fallback;
    }

    return fallback;
}

function isWyzieMissingIdMessage(message) {
    return /no id parameter/i.test(String(message || ''));
}

function isWyzieNoSubtitlesMessage(message) {
    return /no subtitles/i.test(String(message || ''));
}

class WyzieSubsService {
    static initLogged = false;

    constructor(apiKey = null) {
        this.apiKey = normalizeWyzieApiKey(apiKey);
        this.client = axios.create({
            baseURL: WYZIE_API_URL,
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'application/json'
            },
            httpAgent,
            httpsAgent,
            lookup: dnsLookup,
            timeout: 15000 // Default 15s fallback, overridden by user's providerTimeout setting
        });

        if (!WyzieSubsService.initLogged) {
            log.debug(() => `[WyzieSubs] Initialized Wyzie Subs service (API key: ${this.apiKey ? redactApiKey(this.apiKey) : 'missing'})`);
            WyzieSubsService.initLogged = true;
        }
    }

    /**
     * Search for subtitles using Wyzie Subs API
     * @param {Object} params - Search parameters
     * @param {string} params.imdb_id - IMDB ID (with 'tt' prefix) or TMDB ID (numeric)
     * @param {string} params.type - 'movie' or 'episode'
     * @param {number} params.season - Season number (for episodes)
     * @param {number} params.episode - Episode number (for episodes)
     * @param {Array<string>} params.languages - Array of ISO-639-2 language codes
     * @param {boolean} params.excludeHearingImpairedSubtitles - Whether to filter out HI subtitles
     * @param {string} params.filename - Optional filename for better matching
     * @param {Object} params.sources - Source config {opensubtitles: true, subf2m: true, ...}
     * @returns {Promise<Array>} - Array of subtitle objects
     */
    async searchSubtitles(params) {
        const searchStartTime = Date.now();
        try {
            const { imdb_id, tmdb_id, type, season, episode, languages, excludeHearingImpairedSubtitles, filename, sources } = params;

            if (!this.apiKey) {
                log.warn(() => '[WyzieSubs] API key is required for Wyzie search requests');
                return [];
            }

            // Wyzie supports both IMDB and TMDB IDs
            // IMDB: id=tt1234567, TMDB: id=286217 (numeric)
            let searchId = null;

            if (imdb_id && imdb_id !== 'undefined') {
                // Ensure IMDB ID has 'tt' prefix
                searchId = imdb_id.startsWith('tt') ? imdb_id : `tt${imdb_id}`;
            } else if (tmdb_id && tmdb_id !== 'undefined') {
                // TMDB ID - Wyzie will convert internally
                searchId = String(tmdb_id).replace(/^tt/, ''); // Remove tt prefix if accidentally included
            }

            if (!searchId) {
                log.debug(() => '[WyzieSubs] No IMDB/TMDB ID available, skipping search');
                return [];
            }

            // Build query parameters
            const queryParams = new URLSearchParams();
            queryParams.set('id', searchId);
            queryParams.set('key', this.apiKey);

            const isEpisodeSearch = (type === 'episode' || type === 'anime-episode') && episode;
            const seasonCandidates = isEpisodeSearch
                ? getSeasonHintCandidates(params, { fallback: 1 })
                : [];

            // Convert requested languages to ISO 639-1 for Wyzie
            // IMPORTANT: Wyzie validates languages with regex /^[a-z]{2}$/ - must be exactly 2 letters
            // Our toISO6391() returns 'pt-br' for Brazilian Portuguese, but Wyzie uses 'pb'
            if (languages && languages.length > 0) {
                const iso1Langs = languages
                    .map(lang => {
                        // Special-case: Filipino (fil) has a 3-letter ISO 639-1 code which Wyzie rejects.
                        // Map fil → tl (Tagalog) since they share the same written standard.
                        // Also handle tgl (Tagalog ISO 639-2) the same way.
                        const lower = lang.toLowerCase().trim();
                        if (lower === 'fil' || lower === 'tgl') return 'tl';
                        const code = toISO6391(lang);
                        if (!code) return null;
                        // Wyzie uses 'pb' for Brazilian Portuguese, not 'pt-br'
                        if (code === 'pt-br' || code === 'pt-BR') return 'pb';
                        // Wyzie uses 'zt' for Traditional Chinese, 'ze' for bilingual Chinese
                        if (code === 'zh-tw' || code === 'zh-TW') return 'zt';
                        if (code === 'zh-cn' || code === 'zh-CN') return 'zh';
                        // Strip any remaining regional suffixes (e.g., 'es-la' -> 'es')
                        // Wyzie only accepts 2-letter codes
                        const base = code.split('-')[0];
                        return base.length === 2 ? base : null;
                    })
                    .filter(Boolean);
                if (iso1Langs.length > 0) {
                    // Wyzie accepts comma-separated language codes
                    queryParams.set('language', [...new Set(iso1Langs)].join(','));
                }
            }

            // Request SRT format by default (most compatible)
            queryParams.set('format', 'srt');

            // IMPORTANT: By default, Wyzie only queries OpenSubtitles.
            // We explicitly request sources so the UI source toggles map 1:1 to the API.
            const normalizedSources = normalizeWyzieSources(sources);
            const enabledSources = ALL_WYZIE_SOURCES.filter(src => {
                // Source is enabled if: no sources config provided (edge case), OR source is explicitly true
                // Note: UI sends false for unchecked sources, so sources[src] !== false correctly handles this
                return !sources || normalizedSources[src] === true;
            });
            if (enabledSources.length > 0) {
                queryParams.set('source', enabledSources.join(','));
                log.debug(() => `[WyzieSubs] Using sources: ${enabledSources.join(', ')}`);
            } else {
                // Fallback to opensubtitles if user disabled all sources
                queryParams.set('source', 'opensubtitles');
                log.warn(() => '[WyzieSubs] All sources disabled, falling back to opensubtitles');
            }

            // NOTE: Wyzie's `hi` parameter is a filter that returns ONLY hearing impaired subtitles
            // when set (regardless of true/false value). To exclude HI subtitles, we filter
            // client-side using the isHearingImpaired property in the response.
            // We do NOT pass the hi parameter to get all subtitles and filter ourselves.

            // NOTE: Wyzie's `release` parameter filters by release GROUP name (e.g., "YIFY", "SPARKS")
            // not by filename. Passing a full filename would cause zero matches.
            // We omit this parameter to get all results and let ranking handle matching.

            // Use configured timeout from user settings if provided, otherwise use client default (15s)
            const { providerTimeout } = params;
            const requestConfig = providerTimeout ? { timeout: providerTimeout } : {};

            const runSeasonSearch = async (seasonHint = null) => {
                const seasonQuery = new URLSearchParams(queryParams);
                if (isEpisodeSearch) {
                    seasonQuery.set('season', seasonHint || 1);
                    seasonQuery.set('episode', episode);
                }

                const url = `/search?${seasonQuery.toString()}`;
                log.debug(() => `[WyzieSubs] Searching: ${redactWyzieUrl(url)}`);

                const fetchStartTime = Date.now();
                const response = await this.client.get(url, requestConfig);
                const fetchDuration = Date.now() - fetchStartTime;

                log.debug(() => `[WyzieSubs] API response received in ${fetchDuration}ms`);

                const results = Array.isArray(response?.data) ? response.data : [];
                return { url, seasonHint, results, fetchDuration };
            };

            let searchResult;
            if (isEpisodeSearch && !imdb_id && tmdb_id && seasonCandidates.length > 1) {
                searchResult = await runSeasonSearch(seasonCandidates[0]);
                if (searchResult.results.length === 0) {
                    const fallbackResult = await runSeasonSearch(seasonCandidates[1]);
                    if (fallbackResult.results.length > 0) {
                        log.debug(() => `[WyzieSubs] Falling back from season ${seasonCandidates[0]} to alternate TMDB season ${seasonCandidates[1]}`);
                        searchResult = fallbackResult;
                    }
                }
            } else if (isEpisodeSearch) {
                searchResult = await runSeasonSearch(seasonCandidates[0] || 1);
            } else {
                searchResult = await runSeasonSearch();
            }

            if (!searchResult.results.length) {
                log.debug(() => `[WyzieSubs] No subtitles found (total: ${Date.now() - searchStartTime}ms)`);
                return [];
            }

            log.debug(() => `[WyzieSubs] Found ${searchResult.results.length} subtitle(s) in ${searchResult.fetchDuration}ms`);

            // Track language stats for debugging
            const langStats = new Map();
            const languageResults = new Map();

            // First, filter out hearing impaired subtitles if requested (client-side filtering)
            // We do this BEFORE mapping to avoid processing subtitles we'll discard
            let filteredData = searchResult.results;
            if (excludeHearingImpairedSubtitles === true) {
                const beforeCount = filteredData.length;
                filteredData = filteredData.filter(sub => sub.isHearingImpaired !== true);
                const afterCount = filteredData.length;
                if (beforeCount !== afterCount) {
                    log.debug(() => `[WyzieSubs] Filtered out ${beforeCount - afterCount} hearing impaired subtitle(s)`);
                }
            }

            const results = filteredData.map(sub => {
                // Normalize language code from ISO 639-1 to ISO 639-2/B
                const normalizedLang = normalizeLanguageCode(sub.language);

                // Track for stats
                const key = sub.language === normalizedLang ? sub.language : `${sub.language}→${normalizedLang}`;
                langStats.set(key, (langStats.get(key) || 0) + 1);

                // Build display name from available data
                let displayName = sub.release || sub.fileName || sub.media || `[Wyzie] ${sub.display || sub.language}`;
                // Include source if available
                if (sub.source && !displayName.includes(sub.source)) {
                    const sourceStr = Array.isArray(sub.source) ? sub.source.join(', ') : sub.source;
                    displayName = `[${sourceStr}] ${displayName}`;
                }

                // Encode the download URL in the fileId for later retrieval
                // The URL is the Wyzie proxy URL which handles ZIP extraction server-side
                const encodedUrl = Buffer.from(sub.url).toString('base64url');

                return {
                    id: `wyzie_${sub.id}`,
                    language: sub.language,
                    languageCode: normalizedLang, // ISO 639-2/B for SubMaker filtering
                    name: displayName,
                    url: sub.url, // Direct download URL (Wyzie proxy handles ZIPs)
                    downloads: Number.parseInt(sub.downloadCount, 10) || 0,
                    rating: 0,
                    format: sub.format || 'srt',
                    hearing_impaired: sub.isHearingImpaired === true,
                    foreign_parts_only: false,
                    machine_translated: false,
                    is_season_pack: false, // Wyzie does episode filtering server-side; season packs are not expected
                    provider: 'wyzie', // Use lowercase for providerReputation matching
                    source: sub.source, // Original source (subdl, subf2m, opensubtitles, etc.)
                    releases: sub.releases || (sub.release ? [sub.release] : []),
                    fileName: sub.fileName, // Original filename if available
                    origin: sub.origin, // Origin type (DVD, WEB, BluRay) if available
                    fileId: `wyzie_${encodedUrl}`, // Encoded URL for download
                    _wyzieUrl: sub.url // Store original URL for reference
                };
            });

            // Apply per-language result limit
            const limitedResults = [];
            const languageCounts = new Map();

            for (const sub of results) {
                const lang = sub.languageCode || 'unknown';
                const count = languageCounts.get(lang) || 0;
                if (count < MAX_RESULTS_PER_LANGUAGE) {
                    limitedResults.push(sub);
                    languageCounts.set(lang, count + 1);
                }
            }

            // Log language stats
            if (langStats.size > 0) {
                const statsStr = Array.from(langStats.entries())
                    .map(([k, v]) => `${k}:${v}`)
                    .join(', ');
                log.debug(() => `[WyzieSubs] Languages received: ${statsStr}`);
            }

            if (limitedResults.length < results.length) {
                log.debug(() => `[WyzieSubs] Limited results from ${results.length} to ${limitedResults.length} (max ${MAX_RESULTS_PER_LANGUAGE} per language)`);
            }

            const totalDuration = Date.now() - searchStartTime;
            log.debug(() => `[WyzieSubs] Search complete: ${limitedResults.length} results in ${totalDuration}ms`);

            return limitedResults;

        } catch (error) {
            // Use warn instead of error for operational failures
            if (error.response?.status === 401) {
                const details = error.response?.data?.details || error.response?.data?.message || 'API key required';
                log.warn(() => `[WyzieSubs] Search rejected: ${details}`);
            } else if (error.response?.status === 403) {
                const details = error.response?.data?.details || error.response?.data?.message || 'Invalid API key';
                log.warn(() => `[WyzieSubs] Search rejected: ${details}`);
            } else if (error.response?.status === 404) {
                log.debug(() => `[WyzieSubs] No results (404) for requested content`);
            } else if (error.response?.status === 400) {
                // Wyzie returns 400 when no subtitles found (quirky API design)
                const msg = error.response?.data?.message || error.message;
                if (msg?.toLowerCase().includes('no subtitles')) {
                    log.debug(() => `[WyzieSubs] No subtitles found for requested content`);
                } else {
                    log.debug(() => `[WyzieSubs] Bad request (400): ${msg}`);
                }
            } else {
                log.warn(() => `[WyzieSubs] Search failed: ${error.message}`);
            }
            return [];
        }
    }

    async validateApiKey(options = {}) {
        const timeout = Number(options.timeout) > 0 ? Number(options.timeout) : 10000;
        const authProbeTimeout = Math.min(timeout, 4000);

        if (!this.apiKey) {
            return { valid: false, error: 'API key is required' };
        }

        try {
            const runValidationProbe = async (params, { label, probeTimeout = timeout } = {}) => {
                const probeStartedAt = Date.now();
                const response = await this.client.get('/search', {
                    params: {
                        ...params,
                        key: this.apiKey
                    },
                    timeout: probeTimeout,
                    validateStatus: () => true
                });

                const duration = Date.now() - probeStartedAt;
                const upstream = getWyzieUpstreamMessage(response?.data, response?.statusText || '');
                log.debug(() => `[WyzieSubs] Validation ${label} returned ${response.status} in ${duration}ms${upstream ? ` (${upstream})` : ''}`);

                return { response, upstream };
            };

            const interpretProbeResult = ({ response, upstream }, validationMode) => {
                const status = Number(response?.status) || 0;

                if (status === 401 || status === 403) {
                    return { valid: false, error: upstream || 'Invalid API key', status };
                }

                if (status === 429) {
                    return {
                        valid: true,
                        message: 'API key is valid, but Wyzie is rate limiting requests right now.',
                        validationMode,
                        status
                    };
                }

                if (status >= 200 && status < 300) {
                    const results = Array.isArray(response?.data) ? response.data : [];
                    return {
                        valid: true,
                        resultsCount: results.length,
                        validationMode,
                        status
                    };
                }

                if (validationMode === 'auth-probe' && status === 400 && isWyzieMissingIdMessage(upstream)) {
                    return {
                        valid: true,
                        validationMode,
                        status
                    };
                }

                if (validationMode === 'search-probe') {
                    if (status === 400 && isWyzieNoSubtitlesMessage(upstream)) {
                        return {
                            valid: true,
                            resultsCount: 0,
                            validationMode,
                            status
                        };
                    }

                    if (status === 404) {
                        return {
                            valid: true,
                            resultsCount: 0,
                            validationMode,
                            status
                        };
                    }
                }

                return null;
            };

            // Wyzie auth failures return quickly on /search before content lookup.
            // Probe that path first so config-page validation does not wait on a real scrape.
            const authProbe = await runValidationProbe({}, {
                label: 'auth probe',
                probeTimeout: authProbeTimeout
            });
            const authResult = interpretProbeResult(authProbe, 'auth-probe');
            if (authResult) {
                return authResult;
            }

            // Fallback to a deliberately low-cost search probe when Wyzie changes
            // the auth/error ordering and the auth probe becomes ambiguous.
            const searchProbe = await runValidationProbe({
                id: 'tt0',
                language: 'en',
                format: 'srt',
                source: 'opensubtitles'
            }, {
                label: 'fallback search probe'
            });
            const searchResult = interpretProbeResult(searchProbe, 'search-probe');
            if (searchResult) {
                return searchResult;
            }

            return {
                valid: false,
                error: searchProbe.upstream || 'Request failed',
                status: searchProbe.response?.status || 0
            };
        } catch (error) {
            const status = error.response?.status;
            const upstream = getWyzieUpstreamMessage(error.response?.data, error.message || 'Request failed');

            if (status === 401 || status === 403) {
                return { valid: false, error: upstream, status };
            }

            if (status === 429) {
                return {
                    valid: true,
                    message: 'API key is valid, but Wyzie is rate limiting requests right now.',
                    validationMode: 'request-error',
                    status
                };
            }

            if (error.code === 'ECONNABORTED' || /timeout/i.test(upstream)) {
                return { valid: false, error: 'Request timed out', status: status || 0 };
            }

            return { valid: false, error: upstream, status };
        }
    }

    /**
     * Download subtitle content from Wyzie
     * Wyzie provides direct download URLs that handle ZIP extraction server-side
     * @param {string} fileId - File ID from search results (format: wyzie_{base64url_encoded_url})
     * @param {Object} options - Download options
     * @param {number} options.timeout - Request timeout in ms (default: 15000)
     * @param {number} options.maxRetries - Maximum number of retries (default: 3)
     * @returns {Promise<string>} - Subtitle content as text
     */
    async downloadSubtitle(fileId, options = {}) {
        const downloadStartTime = Date.now();
        const maxRetries = options?.maxRetries || 3;
        const timeout = options?.timeout || 15000;
        // Extract encoded URL from fileId
        // Format: wyzie_{base64url_encoded_url}
        if (!fileId.startsWith('wyzie_')) {
            throw new Error('Invalid Wyzie file ID format');
        }

        const encodedUrl = fileId.substring(6); // Remove 'wyzie_' prefix
        let downloadUrl;
        try {
            downloadUrl = Buffer.from(encodedUrl, 'base64url').toString('utf-8');
        } catch (e) {
            throw new Error(`Failed to decode Wyzie download URL: ${e.message}`);
        }

        // Validate URL format - should be a Wyzie URL
        if (!downloadUrl.includes('sub.wyzie.io') && !downloadUrl.includes('sub.wyzie.ru') && !downloadUrl.includes('wyzie.io') && !downloadUrl.includes('wyzie.ru')) {
            log.warn(() => `[WyzieSubs] Unexpected download URL format (not Wyzie): ${downloadUrl.substring(0, 50)}...`);
        }

        log.debug(() => `[WyzieSubs] Downloading subtitle from: ${downloadUrl.substring(0, 80)}...`);

        // Retry logic with exponential backoff
        let lastError;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                log.debug(() => `[WyzieSubs] Download attempt ${attempt}/${maxRetries}`);

                // Use axios directly for full URL (not relative to baseURL)
                const response = await axios.get(downloadUrl, {
                    responseType: 'arraybuffer',
                    timeout,
                    headers: {
                        'User-Agent': USER_AGENT,
                        'Accept': 'text/plain, text/vtt, application/x-subrip, */*'
                    },
                    httpAgent,
                    httpsAgent
                });

                const buffer = Buffer.from(response.data);

                // Handle encoding detection and conversion
                const text = detectAndConvertEncoding(buffer, 'WyzieSubs', options.languageHint || null);

                // Basic validation
                if (!text || text.trim().length === 0) {
                    throw new Error('Empty subtitle file received');
                }

                // Format detection and logging
                const trimmed = text.trimStart();
                if (trimmed.startsWith('WEBVTT')) {
                    log.debug(() => '[WyzieSubs] Received VTT format subtitle');
                } else if (trimmed.startsWith('[Script Info]') || trimmed.startsWith('[V4+ Styles]') || /\[events\]/i.test(trimmed)) {
                    log.debug(() => '[WyzieSubs] Received ASS/SSA format subtitle, converting to VTT');
                    // Convert ASS/SSA to VTT using centralized converter
                    const converted = await convertSubtitleToVtt(text, 'subtitle.ass', 'WyzieSubs', { skipAssConversion: options.skipAssConversion });
                    const downloadDuration = Date.now() - downloadStartTime;
                    const convertedLen = typeof converted === 'string' ? converted.length : converted.content?.length || 0;
                    log.debug(() => `[WyzieSubs] Downloaded and converted subtitle: ${convertedLen} chars in ${downloadDuration}ms`);
                    return converted;
                } else if (/^\d+\s*\r?\n\d{2}:\d{2}:\d{2}/.test(trimmed)) {
                    log.debug(() => '[WyzieSubs] Received SRT format subtitle');
                }

                const downloadDuration = Date.now() - downloadStartTime;
                log.debug(() => `[WyzieSubs] Downloaded subtitle: ${text.length} bytes in ${downloadDuration}ms`);
                return text;

            } catch (error) {
                lastError = error;
                const status = error.response?.status;

                // Don't retry for non-retryable errors
                if (status === 404 || status === 401 || status === 403) {
                    log.warn(() => `[WyzieSubs] Non-retryable error (${status}), aborting`);
                    break;
                }

                // Retry with backoff for server errors
                if (status >= 500 && attempt < maxRetries) {
                    const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                    log.warn(() => `[WyzieSubs] Download failed (status ${status}), retrying in ${backoffMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    continue;
                }

                // Rate limit - retry with longer backoff
                if (status === 429 && attempt < maxRetries) {
                    const backoffMs = 3000 * attempt;
                    log.warn(() => `[WyzieSubs] Rate limited (429), retrying in ${backoffMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    continue;
                }
            }
        }

        throw new Error(`WyzieSubs download failed after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
    }
}

module.exports = WyzieSubsService;
