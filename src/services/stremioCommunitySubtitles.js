const axios = require('axios');
const { httpAgent, dnsLookup } = require('../utils/httpAgents');
const { scsHttpsAgent } = require('../utils/scsHttpAgent');
const { detectAndConvertEncoding } = require('../utils/encodingDetector');
const { convertSubtitleToVtt } = require('../utils/archiveExtractor');
const { MAX_REMOTE_SUBTITLE_BYTES } = require('../utils/resourceLimits');
const log = require('../utils/logger');
const { version } = require('../utils/version');

/**
 * Check if error is an HTTP parser error (malformed/incomplete response)
 * HPE_INVALID_CONSTANT occurs when the server sends corrupt data or
 * the connection is cut mid-response (e.g., due to timeout)
 * @param {Error} error - The error to check
 * @returns {boolean} - True if this is an HTTP parser error
 */
function isHttpParserError(error) {
    const code = error.code || '';
    const message = error.message || '';
    // HPE_* errors are from llhttp (Node's HTTP parser)
    // These occur when response is malformed or truncated
    return code.startsWith('HPE_') ||
        message.includes('Parse Error') ||
        message.includes('Expected HTTP');
}

/**
 * Check if error is an SSL/TLS related error
 * @param {Error} error - The error to check
 * @returns {boolean} - True if this is an SSL error
 */
function isSSLError(error) {
    const code = error.code || '';
    const message = error.message || '';
    // EPROTO: SSL protocol error (includes alert 49)
    // ECONNRESET: Connection reset during SSL handshake
    // ETIMEDOUT: Can occur during SSL negotiation 
    // ERR_SSL_*: OpenSSL specific errors
    return code === 'EPROTO' ||
        code === 'ECONNRESET' ||
        message.includes('SSL') ||
        message.includes('TLS') ||
        message.includes('ssl3_') ||
        message.includes('alert');
}

/**
 * Make request with automatic retry on SSL errors and circuit breaker integration
 * SSL errors can occur when pooled connections go stale
 * @param {Function} requestFn - Function that returns a promise for the request
 * @param {string} context - Context for logging
 * @returns {Promise} - Response from the request
 */
async function makeRequestWithRetry(requestFn, context) {
    try {
        const result = await requestFn();
        recordSuccess(); // Record success for circuit breaker
        return result;
    } catch (error) {
        // Check if this is an HTTP parser error (truncated/corrupt response)
        // This usually means the server is slow and our timeout cut off the response
        if (isHttpParserError(error)) {
            log.debug(() => `[SCS] HTTP parser error in ${context} (likely slow server response): ${error.code || error.message}`);
            // Don't retry parser errors - they indicate server-side slowness
            // Just record for circuit breaker and throw
            recordFailure(error);
            throw error;
        }

        if (isSSLError(error)) {
            log.debug(() => `[SCS] SSL error detected in ${context}, retrying with fresh connection...`);
            // Destroy any stale sockets in the agent
            scsHttpsAgent.destroy();
            // Small delay before retry
            await new Promise(resolve => setTimeout(resolve, 500));
            // Retry once with fresh connection
            try {
                const result = await requestFn();
                recordSuccess();
                return result;
            } catch (retryError) {
                // Retry also failed - record failure for circuit breaker
                if (isCircuitBreakerError(retryError)) {
                    recordFailure(retryError);
                }
                throw retryError;
            }
        }
        // Non-SSL error - still record if it's a connection error
        if (isCircuitBreakerError(error)) {
            recordFailure(error);
        }
        throw error;
    }
}

const SCS_API_URL = 'https://stremio-community-subtitles.top';
const SCS_FALLBACK_TOKEN = 'yNejf3661w9R1Agdh7ARxE8MzhSVpL2TzMn5jueHFzw'; // Default community token
const USER_AGENT = `SubMaker v${version}`;
const SAFE_SCS_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;
const ENCODED_IDENTIFIER_PREFIX = 'idb64_';

function normalizeManifestToken(value) {
    if (value === undefined || value === null) {
        return '';
    }

    let normalized = String(value).trim();
    try {
        const parsed = new URL(normalized);
        const tokenSegment = parsed.pathname
            .split('/')
            .map(segment => segment.trim())
            .filter(Boolean)
            .find(segment => segment !== 'manifest.json');
        if (tokenSegment) {
            normalized = tokenSegment;
        }
    } catch (_) {
        // Plain tokens are expected; URL parsing is only for pasted manifest URLs.
    }

    normalized = normalized.replace(/^\/+|\/+$/g, '');
    if (!normalized || normalized === '[object Object]' || normalized === '[object Array]') {
        return '';
    }
    return normalized;
}

// ============================================================================
// SCS TIMEOUT CONFIGURATION
// ============================================================================
// NOTE: SCS server is slow (~10-22s for queries) but we respect user's choice.
// If user sets a low timeout, SCS will likely timeout - that's their decision.
// Default timeout used when none specified.
// ============================================================================
const SCS_DEFAULT_TIMEOUT_MS = 15000;

/**
 * Extract the real SCS download identifier from a subtitle URL.
 * Live SCS responses expose a human-readable `id`, but downloads are keyed by
 * the opaque token embedded in `sub.url`.
 * @param {string} downloadUrl
 * @returns {string|null}
 */
function extractDownloadIdentifier(downloadUrl) {
    if (!downloadUrl || typeof downloadUrl !== 'string') {
        return null;
    }

    const matchIdentifier = (value) => {
        const match = value.match(/\/download\/([^/]+)\.(?:vtt|srt|ass|ssa|sub)(?:[?#]|$)/i);
        if (!match || !match[1]) {
            return null;
        }

        try {
            return decodeURIComponent(match[1]);
        } catch (_) {
            return match[1];
        }
    };

    try {
        const parsed = new URL(downloadUrl, SCS_API_URL);
        return matchIdentifier(parsed.pathname);
    } catch (_) {
        return matchIdentifier(downloadUrl);
    }
}

/**
 * Normalize SCS file IDs for the download endpoint.
 * Legacy SubMaker builds stored `comm_*` identifiers while live SCS responses
 * now use the opaque download token directly.
 * @param {string} fileId
 * @returns {string}
 */
function normalizeDownloadIdentifier(fileId) {
    const raw = String(fileId || '').trim();
    if (!raw) {
        throw new Error(`Invalid SCS file ID format: ${fileId}`);
    }

    if (raw.startsWith(ENCODED_IDENTIFIER_PREFIX)) {
        const encoded = raw.slice(ENCODED_IDENTIFIER_PREFIX.length);
        if (!encoded) {
            throw new Error(`Invalid SCS encoded file ID format: ${fileId}`);
        }

        try {
            return Buffer.from(encoded, 'base64url').toString('utf8');
        } catch (_) {
            throw new Error(`Invalid SCS encoded file ID format: ${fileId}`);
        }
    }

    return raw.startsWith('comm_') ? raw.slice(5) : raw;
}

/**
 * Resolve the actual SCS identifier exposed by the upstream API.
 * Prefer the live opaque download token extracted from `sub.url`, but fall back
 * to `sub.id` if SCS starts exposing the real identifier there directly.
 * @param {{ id?: string, url?: string }} sub
 * @returns {string|null}
 */
function resolveSearchResultIdentifier(sub) {
    const urlIdentifier = extractDownloadIdentifier(sub?.url);
    if (urlIdentifier) {
        return urlIdentifier;
    }

    const candidateId = String(sub?.id || '').trim();
    if (candidateId) {
        return candidateId;
    }

    return null;
}

/**
 * Convert an upstream SCS identifier into a route-safe SubMaker fileId payload.
 * Safe identifiers pass through unchanged; unsafe ones are base64url-encoded
 * so the generic fileId validation contract can stay strict.
 * @param {string} identifier
 * @returns {string|null}
 */
function toRouteSafeIdentifier(identifier) {
    const raw = String(identifier || '').trim();
    if (!raw) {
        return null;
    }

    if (SAFE_SCS_IDENTIFIER_PATTERN.test(raw)) {
        return raw;
    }

    return `${ENCODED_IDENTIFIER_PREFIX}${Buffer.from(raw, 'utf8').toString('base64url')}`;
}

// Circuit breaker pattern for SCS service resilience
// Prevents repeated failed requests when service is down (SSL errors, Cloudflare blocks, etc.)
const circuitBreaker = {
    state: 'CLOSED',              // CLOSED (normal), OPEN (blocked), HALF_OPEN (testing)
    failureCount: 0,              // Consecutive failure count
    lastFailureTime: null,        // Timestamp of last failure
    lastSuccessTime: null,        // Timestamp of last success
    FAILURE_THRESHOLD: 3,         // Open circuit after this many failures
    RESET_TIMEOUT_MS: 300000,     // 5 minutes before trying again (OPEN -> HALF_OPEN)
    LOG_INTERVAL_MS: 300000,      // Only log circuit state changes every 5 minutes
    lastLogTime: 0
};

/**
 * Check if the circuit breaker allows a request
 * @returns {{ allowed: boolean, reason?: string }} - Whether request is allowed
 */
function isRequestAllowed() {
    const now = Date.now();

    if (circuitBreaker.state === 'CLOSED') {
        return { allowed: true };
    }

    if (circuitBreaker.state === 'OPEN') {
        // Check if enough time has passed to try again
        const timeSinceLastFailure = now - circuitBreaker.lastFailureTime;
        if (timeSinceLastFailure >= circuitBreaker.RESET_TIMEOUT_MS) {
            // Transition to HALF_OPEN - allow one request to test
            circuitBreaker.state = 'HALF_OPEN';
            log.info(() => '[SCS] Circuit breaker entering HALF_OPEN state - testing connection');
            return { allowed: true };
        }

        // Still in cooldown period
        const remainingSecs = Math.ceil((circuitBreaker.RESET_TIMEOUT_MS - timeSinceLastFailure) / 1000);
        return {
            allowed: false,
            reason: `Circuit breaker OPEN - service unreachable. Retry in ${remainingSecs}s`
        };
    }

    // HALF_OPEN - allow the test request
    return { allowed: true };
}

/**
 * Record a failed request (SSL error, connection error, etc.)
 */
function recordFailure(error) {
    const now = Date.now();
    circuitBreaker.failureCount++;
    circuitBreaker.lastFailureTime = now;

    // Detect specific SSL access denied error which indicates security software blocking
    const errorMsg = error.message || '';
    const isAccessDenied = errorMsg.includes('alert access denied') ||
        errorMsg.includes('alert number 49') ||
        error.code === 'ERR_SSL_TLSV1_ALERT_ACCESS_DENIED';

    if (circuitBreaker.state === 'HALF_OPEN') {
        // Test request failed - go back to OPEN
        circuitBreaker.state = 'OPEN';
        if (now - circuitBreaker.lastLogTime >= circuitBreaker.LOG_INTERVAL_MS) {
            if (isAccessDenied) {
                log.warn(() => `[SCS] TLS connection blocked - possibly by firewall/security software`);
            } else {
                log.warn(() => `[SCS] Circuit breaker OPEN - service still unreachable (${error.code || error.message})`);
            }
            circuitBreaker.lastLogTime = now;
        }
    } else if (circuitBreaker.failureCount >= circuitBreaker.FAILURE_THRESHOLD) {
        // Too many failures - open the circuit
        if (circuitBreaker.state !== 'OPEN') {
            circuitBreaker.state = 'OPEN';
            if (isAccessDenied) {
                log.warn(() => `[SCS] Circuit OPEN - TLS blocked. This is likely caused by firewall/security software blocking connections to stremio-community-subtitles.top. Consider adding SubMaker to your firewall exclusions.`);
            } else {
                log.warn(() => `[SCS] Circuit breaker OPEN after ${circuitBreaker.failureCount} failures - pausing requests for 5 minutes`);
            }
            circuitBreaker.lastLogTime = now;
        }
    }
}

/**
 * Record a successful request
 */
function recordSuccess() {
    if (circuitBreaker.state !== 'CLOSED') {
        log.info(() => `[SCS] Circuit breaker CLOSED - service recovered after ${circuitBreaker.failureCount} failure(s)`);
    }
    circuitBreaker.state = 'CLOSED';
    circuitBreaker.failureCount = 0;
    circuitBreaker.lastSuccessTime = Date.now();
}

/**
 * Check if error is an SSL/TLS related error that should trigger circuit breaker
 * @param {Error} error - The error to check
 * @returns {boolean} - True if this is a connection/SSL error
 */
function isCircuitBreakerError(error) {
    const code = error.code || '';
    const message = error.message || '';
    // EPROTO: SSL protocol error (includes alert 49 - access denied)
    // ECONNRESET: Connection reset
    // ECONNREFUSED: Connection refused  
    // ETIMEDOUT: Connection timeout
    // ENOTFOUND: DNS resolution failed
    // HPE_*: HTTP parser errors (server sent malformed/truncated response)
    return code === 'EPROTO' ||
        code === 'ECONNRESET' ||
        code === 'ECONNREFUSED' ||
        code === 'ETIMEDOUT' ||
        code === 'ENOTFOUND' ||
        code.startsWith('HPE_') ||
        message.includes('SSL') ||
        message.includes('TLS') ||
        message.includes('ssl3_') ||
        message.includes('alert') ||
        message.includes('Parse Error') ||
        message.includes('LOGON_DENIED');
}
// Language code mapping
// SCS uses ISO 639-2/T codes (fra, deu, zho) in their languages.py
// SubMaker internally uses OpenSubtitles-style ISO 639-2/B codes (fre, ger, chi)
// This map converts SCS codes (T variant) to SubMaker codes (B variant) where they differ

// ISO 639-2/T to ISO 639-2/B mapping (only for codes that differ)
const SCS_TO_SUBMAKER_LANG = {
    'fra': 'fre',  // French: T=fra, B=fre
    'deu': 'ger',  // German: T=deu, B=ger
    'zho': 'chi',  // Chinese: T=zho, B=chi
    'ces': 'cze',  // Czech: T=ces, B=cze
    'nld': 'dut',  // Dutch: T=nld, B=dut
    'ell': 'gre',  // Greek: T=ell, B=gre
    'fas': 'per',  // Persian: T=fas, B=per
    'ron': 'rum',  // Romanian: T=ron, B=rum
    'slk': 'slo',  // Slovak: T=slk, B=slo
    'msa': 'may',  // Malay: T=msa, B=may
    'mya': 'bur',  // Burmese: T=mya, B=bur
    'sqi': 'alb',  // Albanian: T=sqi, B=alb
    'mkd': 'mac',  // Macedonian: T=mkd, B=mac
    'eus': 'baq',  // Basque: T=eus, B=baq
    'kat': 'geo',  // Georgian: T=kat, B=geo
    'hye': 'arm',  // Armenian: T=hye, B=arm
    'isl': 'ice',  // Icelandic: T=isl, B=ice
    'bod': 'tib',  // Tibetan: T=bod, B=tib
    'cym': 'wel',  // Welsh: T=cym, B=wel
};

// Reverse mapping (SubMaker B-codes to SCS T-codes) for request filtering if needed
const SUBMAKER_TO_SCS_LANG = Object.fromEntries(
    Object.entries(SCS_TO_SUBMAKER_LANG).map(([k, v]) => [v, k])
);

const SCS_SUPPORTED_LANGS = new Set([
    'eng', 'pol', 'spa', 'fra', 'deu', 'ita', 'por', 'pob', 'rus', 'jpn',
    'zho', 'kor', 'ara', 'hin', 'tur', 'nld', 'swe', 'nor', 'dan', 'fin',
    'ces', 'slk', 'hun', 'ron', 'bul', 'ell', 'heb', 'tha', 'vie', 'ind',
    'msa', 'ukr', 'srp', 'hrv', 'slv', 'est', 'lav', 'lit', 'fas', 'pus',
    'urd', 'ben', 'mya', 'cat', 'eus', 'epo', 'mkd', 'tel', 'sqi'
]);

const SUBMAKER_TO_SCS_EQUIVALENT_LANG = {
    spn: 'spa',
    zhs: 'zho',
    zht: 'zho',
    ze: 'zho',
    fil: 'tgl'
};

// Legacy ISO 639-1 (2-letter) to ISO 639-2/B mapping (fallback for any 2-letter codes)
const ISO1_TO_ISO2B = {
    'en': 'eng', 'es': 'spa', 'pt': 'por', 'fr': 'fre', 'de': 'ger',
    'it': 'ita', 'nl': 'dut', 'pl': 'pol', 'ru': 'rus', 'ja': 'jpn',
    'ko': 'kor', 'zh': 'chi', 'ar': 'ara', 'tr': 'tur', 'he': 'heb',
    'sv': 'swe', 'da': 'dan', 'no': 'nor', 'fi': 'fin', 'cs': 'cze',
    'hu': 'hun', 'ro': 'rum', 'el': 'gre', 'id': 'ind', 'th': 'tha',
    'vi': 'vie', 'uk': 'ukr', 'bg': 'bul', 'hr': 'hrv', 'sk': 'slo',
    'sl': 'slv', 'sr': 'srp', 'ms': 'may', 'hi': 'hin', 'bn': 'ben',
    'fa': 'per', 'ta': 'tam', 'te': 'tel', 'tl': 'tgl'
};

/**
 * Normalize language code from SCS format to SubMaker's ISO 639-2/B format
 * SCS returns ISO 639-2/T codes (fra, deu, zho), SubMaker uses B codes (fre, ger, chi)
 * @param {string} lang - Language code from SCS (usually 3-letter ISO 639-2/T)
 * @returns {string} - Normalized 3-letter ISO 639-2/B code for SubMaker
 */
function normalizeLanguageCode(lang) {
    if (!lang) return '';
    const lower = lang.toLowerCase().replace(/[_-]/g, '');

    // Handle special case for Portuguese Brazilian
    if (lower === 'ptbr' || lower === 'pob') {
        return 'pob';
    }

    // If 3 letters (ISO 639-2), check if it needs T->B conversion
    if (lower.length === 3) {
        // Convert T variant to B variant if needed
        if (SCS_TO_SUBMAKER_LANG[lower]) {
            return SCS_TO_SUBMAKER_LANG[lower];
        }
        // Already a valid code (either B variant or same in both)
        return lower;
    }

    // If 2 letters (ISO 639-1), convert to ISO 639-2/B
    if (lower.length === 2 && ISO1_TO_ISO2B[lower]) {
        return ISO1_TO_ISO2B[lower];
    }

    return lang;
}

function normalizeLanguageForScsRequest(lang) {
    if (!lang) return '';

    let lower = String(lang).trim().toLowerCase();
    if (!lower) return '';

    if (lower === 'pt-br' || lower === 'pt_br' || lower === 'ptbr') {
        lower = 'pob';
    } else {
        lower = lower.replace(/[_-]/g, '');
    }

    if (lower.length === 2 && ISO1_TO_ISO2B[lower]) {
        lower = ISO1_TO_ISO2B[lower];
    }

    if (SUBMAKER_TO_SCS_EQUIVALENT_LANG[lower]) {
        lower = SUBMAKER_TO_SCS_EQUIVALENT_LANG[lower];
    }

    const scsLang = SUBMAKER_TO_SCS_LANG[lower] || lower;
    return SCS_SUPPORTED_LANGS.has(scsLang) ? scsLang : '';
}

function buildScsLanguageOverride(languages) {
    if (!Array.isArray(languages) || languages.length === 0) {
        return '';
    }

    const seen = new Set();
    const normalized = [];

    for (const lang of languages) {
        const scsLang = normalizeLanguageForScsRequest(lang);
        if (!scsLang || seen.has(scsLang)) {
            continue;
        }
        seen.add(scsLang);
        normalized.push(scsLang);
    }

    return normalized.join(',');
}

class StremioCommunitySubtitlesService {
    static initLogged = false;

    // Static/singleton axios client - shared across all instances for connection reuse
    static client = axios.create({
        baseURL: SCS_API_URL,
        headers: {
            'User-Agent': USER_AGENT
        },
        httpAgent,
        httpsAgent: scsHttpsAgent, // Use custom SCS agent with TLS config for SSL compatibility
        lookup: dnsLookup,
        timeout: SCS_DEFAULT_TIMEOUT_MS // Default timeout, will be overridden by user config
    });

    constructor(manifestToken = null, options = {}) {
        if (manifestToken && typeof manifestToken === 'object') {
            options = manifestToken;
            manifestToken = options.manifestToken || options.apiKey || null;
        }

        const userManifestToken = normalizeManifestToken(manifestToken);
        const envManifestToken = normalizeManifestToken(process.env.SCS_MANIFEST_TOKEN);

        // Use user auth token when configured, otherwise preserve the existing
        // shared community-token behavior.
        this.manifestToken = userManifestToken || envManifestToken || SCS_FALLBACK_TOKEN;
        this.useLanguageOverride = options?.useLanguageOverride === true && !!userManifestToken;
        this.usesUserManifestToken = !!userManifestToken;

        // Use static client for all instances (connection pooling optimization)
        this.client = StremioCommunitySubtitlesService.client;

        if (!StremioCommunitySubtitlesService.initLogged) {
            if (userManifestToken) {
                log.debug(() => '[SCS] Initialized with user auth manifest token');
            } else if (envManifestToken) {
                log.debug(() => '[SCS] Initialized with custom manifest token from env');
            } else {
                log.debug(() => '[SCS] Initialized with default community token');
            }
            StremioCommunitySubtitlesService.initLogged = true;
        }
    }

    /**
     * Search for subtitles using SCS addon API
     * @param {Object} params - Search parameters
     */
    async searchSubtitles(params) {
        // Check circuit breaker first - don't make requests if service is known to be down
        const circuitCheck = isRequestAllowed();
        if (!circuitCheck.allowed) {
            log.debug(() => `[SCS] ${circuitCheck.reason}`);
            return [];
        }

        // Token is always available (env or fallback)
        try {
            const { type, imdb_id, videoHash, videoSize, filename, providerTimeout, languages } = params;
            // videoHash is now only set when Stremio provides a real OpenSubtitles hash
            // (our derived MD5 hashes are no longer passed - they're useless for SCS matching)
            const hasRealHash = !!videoHash;
            const hasFilename = !!filename;
            const usesMatchingParams = hasRealHash || hasFilename;

            // SCS requires a content ID. It works best with videoHash, but filename is sufficient.
            // We can search by IMDB ID or native anime IDs (kitsu, anidb, etc.)
            const hasAnimeId = !!(params.animeId && params.animeIdType);
            if (!imdb_id && !hasAnimeId) {
                log.debug(() => '[SCS] Skipping search: no IMDB ID or anime ID provided');
                return [];
            }

            // Use user's configured timeout directly - respect their choice
            const effectiveTimeout = providerTimeout || SCS_DEFAULT_TIMEOUT_MS;

            // Log what matching mode SCS will use
            if (hasRealHash) {
                log.debug(() => `[SCS] Hash matching enabled: ${videoHash.substring(0, 8)}... (timeout: ${effectiveTimeout}ms)`);
            } else if (hasFilename) {
                log.debug(() => `[SCS] No hash available, using filename matching (timeout: ${effectiveTimeout}ms)`);
            } else {
                log.debug(() => `[SCS] Searching by content ID only (timeout: ${effectiveTimeout}ms)`);
            }

            // Construct Stremio-style path params
            // Format: videoHash=xxx&videoSize=yyy&filename=zzz
            const queryParts = [];
            if (videoHash) queryParts.push(`videoHash=${videoHash}`);
            if (videoSize) queryParts.push(`videoSize=${videoSize}`);
            if (filename) queryParts.push(`filename=${encodeURIComponent(filename)}`);
            if (this.useLanguageOverride) {
                const langsOverride = buildScsLanguageOverride(languages);
                if (langsOverride) queryParts.push(`langs=${encodeURIComponent(langsOverride)}`);
            }

            const paramsJson = queryParts.join('&') + '.json';

            // SCS endpoint: /{token}/subtitles/{type}/{id}/{params}.json
            // Note: type is 'movie' or 'series'
            let stremioType = type;
            if (type === 'episode' || type === 'anime-episode') stremioType = 'series';

            // For series, ID should be in Stremio format: tt12345:s:e
            // Also handle anime IDs (kitsu, anidb, etc.) for native SCS lookup
            let contentId = imdb_id;

            // For anime content, prefer IMDB ID when available (SCS database is primarily IMDB-indexed).
            // Fall back to native anime IDs (kitsu:1234, anidb:5678) only when IMDB mapping failed.
            if (!imdb_id && params.animeId && params.animeIdType) {
                contentId = params.animeId; // Already in platform:id format (e.g., "kitsu:8640")
                if ((type === 'episode' || type === 'anime-episode') && params.episode) {
                    contentId = params.season
                        ? `${contentId}:${params.season}:${params.episode}`
                        : `${contentId}:${params.episode}`;
                }
                log.debug(() => `[SCS] Using anime ID (no IMDB mapping): ${contentId}`);
            } else if ((type === 'episode' || type === 'anime-episode') && params.season && params.episode) {
                // Stremio ID format for series: tt12345:1:2
                contentId = `${imdb_id}:${params.season}:${params.episode}`;
            }

            const url = `/${this.manifestToken}/subtitles/${stremioType}/${contentId}/${paramsJson}`;

            log.debug(() => `[SCS] Search: type=${stremioType}, id=${contentId}, hash=${videoHash || 'none'}, filename=${filename ? filename.substring(0, 50) : 'none'}`);

            // Build request config with intelligent timeout
            const requestConfig = { timeout: effectiveTimeout };

            // Track request timing for performance monitoring
            const searchStartTime = Date.now();

            // Use retry wrapper for SSL error resilience
            const response = await makeRequestWithRetry(
                () => this.client.get(url, requestConfig),
                'search'
            );

            // Log performance timing (SCS is expected to be slow, but this helps diagnose issues)
            const searchDuration = Date.now() - searchStartTime;
            if (searchDuration > 15000) {
                log.info(() => `[SCS] Search completed in ${(searchDuration / 1000).toFixed(1)}s (slow but expected for hash matching)`);
            } else {
                log.debug(() => `[SCS] Search completed in ${(searchDuration / 1000).toFixed(1)}s`);
            }

            if (!response.data || !response.data.subtitles) {
                log.debug(() => `[SCS] No subtitles in response`);
                return [];
            }

            log.debug(() => `[SCS] Found ${response.data.subtitles.length} subtitle(s)${hasRealHash ? ' (with real videoHash)' : ''}`);


            // Track unique languages for debugging and hash match assignment
            const langStats = new Map();
            // Track first result per language (for hash match priority)
            const firstPerLang = new Set();

            const results = response.data.subtitles.map((sub, index) => {
                // Normalize language code: SCS uses ISO 639-2/T, SubMaker uses ISO 639-2/B
                const normalizedLang = normalizeLanguageCode(sub.lang);
                const upstreamIdentifier = resolveSearchResultIdentifier(sub);
                const downloadIdentifier = toRouteSafeIdentifier(upstreamIdentifier);

                if (!downloadIdentifier) {
                    log.warn(() => `[SCS] Skipping subtitle with unusable identifier (id=${sub.id || 'unknown'}): ${sub.url || 'missing'}`);
                    return null;
                }

                // Track for stats
                const key = sub.lang === normalizedLang ? sub.lang : `${sub.lang}→${normalizedLang}`;
                langStats.set(key, (langStats.get(key) || 0) + 1);

                // Preserve the first result per language as SCS's recommendation
                // for this hash-aware search. The API does not prove an exact hash
                // match unless it explicitly returns the corresponding flag.
                const isFirstForThisLang = !firstPerLang.has(normalizedLang);
                if (isFirstForThisLang) {
                    firstPerLang.add(normalizedLang);
                }

                const providerBestMatch = hasRealHash && isFirstForThisLang;
                const hashMatch = sub.hash_match === true || sub.moviehash_match === true;

                const hashMatchPriority = hashMatch ? index : undefined;

                return {
                    id: `scs_${downloadIdentifier}`, // Prefix to identify provider
                    language: sub.lang,
                    languageCode: normalizedLang, // Normalized to ISO 639-2/B for SubMaker filtering
                    name: sub.release || sub.release_name || sub.filename || sub.fileName || sub.name
                        || (hashMatch ? '[SCS] Exact file match' : providerBestMatch ? '[SCS] Best hash-search result' : '[SCS] Community Subtitle'),
                    url: sub.url,
                    downloads: 0,
                    rating: 0,
                    format: 'vtt',
                    score: hashMatch ? 200000 : (providerBestMatch ? 40000 : 0),
                    provider: 'stremio-community-subtitles',
                    is_season_pack: false, // SCS handles matching internally
                    fileId: `scs_${downloadIdentifier}`, // Use the real download token from sub.url
                    // Distinct confidence levels for exact and provider-ranked matches.
                    hashMatch: hashMatch,
                    hashMatchPriority: hashMatchPriority,
                    providerBestMatch,
                    providerBestMatchPriority: providerBestMatch ? 0 : undefined,
                    _scsHasRealHash: hasRealHash // Internal flag for ranking logic
                };
            }).filter(Boolean);

            // Log hash match stats
            const providerBestCount = results.filter(r => r.providerBestMatch).length;
            if (providerBestCount > 0) {
                log.info(() => `[SCS] ${providerBestCount} provider-ranked subtitle(s) found for the supplied video hash`);
            }

            // Log language stats
            if (langStats.size > 0) {
                const statsStr = Array.from(langStats.entries()).map(([k, v]) => `${k}:${v}`).join(', ');
                log.debug(() => `[SCS] Languages received: ${statsStr}`);
            }

            return results;

        } catch (error) {
            // Use warn instead of error for operational failures (API errors, network issues)
            const statusCode = error.response?.status || error.code || '';
            log.warn(() => `[SCS] Search failed (${statusCode}): ${error.message}`);
            return [];
        }
    }

    /**
     * Download subtitle content
     * @param {string} fileId - The download identifier (legacy comm_* or live token)
     */
    async downloadSubtitle(fileId, options = {}) {
        // Use user's configured timeout directly - respect their choice
        const timeout = options?.timeout || SCS_DEFAULT_TIMEOUT_MS;

        // Check circuit breaker first
        const circuitCheck = isRequestAllowed();
        if (!circuitCheck.allowed) {
            throw new Error(`SCS service temporarily unavailable: ${circuitCheck.reason}`);
        }

        try {
            const identifier = normalizeDownloadIdentifier(fileId);

            // Construct download URL: /{token}/download/{identifier}.vtt
            // SCS expects .vtt or .ass extension in the download URL
            const url = `/${this.manifestToken}/download/${encodeURIComponent(identifier)}.vtt`;

            log.debug(() => `[SCS] Downloading from: ${url} (timeout: ${timeout}ms)`);

            // Track download timing
            const downloadStartTime = Date.now();

            // Use retry wrapper for SSL error resilience
            const response = await makeRequestWithRetry(
                () => this.client.get(url, {
                    responseType: 'arraybuffer',
                    timeout: timeout,
                    maxContentLength: MAX_REMOTE_SUBTITLE_BYTES
                }),
                'download'
            );

            // Log download timing
            const downloadDuration = Date.now() - downloadStartTime;
            log.debug(() => `[SCS] Download completed in ${(downloadDuration / 1000).toFixed(1)}s`);


            const buffer = Buffer.from(response.data);
            // Use centralized encoding detector for proper Arabic/Hebrew/RTL support
            const text = detectAndConvertEncoding(buffer, 'SCS', options.languageHint || null);

            // Basic validation
            if (text.trim().length === 0) {
                throw new Error('Empty subtitle file');
            }

            // Format detection and logging
            const trimmed = text.trimStart();
            if (trimmed.startsWith('WEBVTT')) {
                log.debug(() => '[SCS] Received VTT format subtitle');
            } else if (trimmed.startsWith('[Script Info]') || trimmed.startsWith('[V4+ Styles]') || /\[events\]/i.test(trimmed)) {
                log.debug(() => '[SCS] Received ASS/SSA format subtitle, converting to VTT');
                // Convert ASS/SSA to VTT using centralized converter
                const converted = await convertSubtitleToVtt(text, 'subtitle.ass', 'SCS', { skipAssConversion: options.skipAssConversion });
                const convertedLen = typeof converted === 'string' ? converted.length : converted.content?.length || 0;
                log.debug(() => `[SCS] Downloaded and converted subtitle: ${convertedLen} chars`);
                return converted;
            } else if (/^\d+\s*\r?\n\d{2}:\d{2}:\d{2}/.test(trimmed)) {
                log.debug(() => '[SCS] Received SRT format subtitle');
            }

            log.debug(() => `[SCS] Downloaded subtitle: ${text.length} bytes`);
            return text;

        } catch (error) {
            // Chain errors properly to preserve stack trace
            const statusCode = error.response?.status || error.code || '';
            const enhancedError = new Error(`SCS download failed (${statusCode}): ${error.message}`);
            enhancedError.cause = error;
            enhancedError.statusCode = error.response?.status;
            throw enhancedError;
        }
    }
}

module.exports = StremioCommunitySubtitlesService;
