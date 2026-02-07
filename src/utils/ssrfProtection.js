/**
 * SSRF (Server-Side Request Forgery) protection utilities
 * 
 * Prevents custom provider baseUrls from targeting internal/private networks
 * unless explicitly allowed via ALLOW_INTERNAL_CUSTOM_ENDPOINTS=true.
 *
 * Includes DNS rebinding protection: after hostname validation, the resolved
 * IP address is checked against internal ranges to prevent attackers from
 * using public domains that resolve to private/loopback addresses.
 */

const dns = require('dns');
const log = require('./logger');

// Environment variable to allow internal endpoints (for self-hosters)
const ALLOW_INTERNAL = process.env.ALLOW_INTERNAL_CUSTOM_ENDPOINTS === 'true';

/**
 * Private/internal IP ranges that should be blocked by default
 * Covers: localhost, private networks (RFC 1918), link-local, loopback
 */
const INTERNAL_PATTERNS = [
    // IPv4 loopback
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
    // IPv4 private networks (RFC 1918)
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,          // 10.0.0.0/8
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,  // 172.16.0.0/12
    /^192\.168\.\d{1,3}\.\d{1,3}$/,              // 192.168.0.0/16
    // IPv4 link-local
    /^169\.254\.\d{1,3}\.\d{1,3}$/,             // 169.254.0.0/16
    // IPv4 shared address space (carrier-grade NAT)
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/,  // 100.64.0.0/10
];

// Hostnames that should be blocked by default
const INTERNAL_HOSTNAMES = new Set([
    'localhost',
    'localhost.localdomain',
    'local',
    '127.0.0.1',
    '::1',
    '0.0.0.0'
]);

/**
 * Check if a hostname or IP is internal/private
 * @param {string} host - Hostname or IP address
 * @returns {boolean} - True if internal/private
 */
function isInternalHost(host) {
    if (!host) return true;  // Empty host is suspicious

    const lowercaseHost = host.toLowerCase();

    // Check against known internal hostnames
    if (INTERNAL_HOSTNAMES.has(lowercaseHost)) {
        return true;
    }

    // Check against private IP patterns
    for (const pattern of INTERNAL_PATTERNS) {
        if (pattern.test(host)) {
            return true;
        }
    }

    // Check for IPv6 localhost variations
    if (lowercaseHost.startsWith('[::1]') || lowercaseHost === '::1') {
        return true;
    }

    // Check for .local, .internal, .localhost TLDs
    if (lowercaseHost.endsWith('.local') ||
        lowercaseHost.endsWith('.internal') ||
        lowercaseHost.endsWith('.localhost')) {
        return true;
    }

    return false;
}

/**
 * Check if an IP address string is internal/private
 * Works on resolved IP addresses (not hostnames)
 * @param {string} ip - IP address string
 * @returns {boolean} - True if internal/private
 */
function isInternalIp(ip) {
    if (!ip) return true;

    // Check against private IPv4 patterns
    for (const pattern of INTERNAL_PATTERNS) {
        if (pattern.test(ip)) {
            return true;
        }
    }

    // IPv6 loopback
    if (ip === '::1' || ip === '::ffff:127.0.0.1') {
        return true;
    }

    // IPv4-mapped IPv6 addresses (::ffff:x.x.x.x) — extract the IPv4 part and re-check
    const v4Mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (v4Mapped) {
        return isInternalIp(v4Mapped[1]);
    }

    // IPv6 link-local (fe80::/10)
    if (/^fe[89ab]/i.test(ip)) {
        return true;
    }

    // IPv6 unique local (fc00::/7)
    if (/^f[cd]/i.test(ip)) {
        return true;
    }

    // 0.0.0.0
    if (ip === '0.0.0.0') {
        return true;
    }

    return false;
}

/**
 * Resolve a hostname to IP addresses and check if any resolve to internal/private IPs.
 * This is the DNS rebinding defense: even if the hostname looks external, the resolved
 * IP must also be external.
 *
 * @param {string} hostname - Hostname to resolve
 * @returns {Promise<{ safe: boolean, resolvedIps?: string[], error?: string }>}
 */
function resolveAndValidateHost(hostname) {
    return new Promise((resolve) => {
        // If the hostname is already an IP literal, just check it directly
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) || hostname.includes(':')) {
            const internal = isInternalIp(hostname);
            return resolve({
                safe: !internal,
                resolvedIps: [hostname],
                error: internal ? `Resolved IP ${hostname} is internal/private` : undefined
            });
        }

        // Resolve all A and AAAA records
        dns.resolve(hostname, (errA, addressesA) => {
            dns.resolve6(hostname, (err6, addresses6) => {
                const allAddresses = [
                    ...(Array.isArray(addressesA) ? addressesA : []),
                    ...(Array.isArray(addresses6) ? addresses6 : [])
                ];

                // If DNS resolution fails entirely, block the request (fail-closed)
                if (allAddresses.length === 0) {
                    const dnsError = errA?.message || err6?.message || 'unknown';
                    log.warn(() => `[SSRF] DNS resolution failed for ${hostname}: ${dnsError}`);
                    return resolve({
                        safe: false,
                        resolvedIps: [],
                        error: `DNS resolution failed for ${hostname}: ${dnsError}`
                    });
                }

                // Check every resolved IP — if ANY resolve to internal, block
                for (const ip of allAddresses) {
                    if (isInternalIp(ip)) {
                        log.warn(() => `[SSRF] DNS rebinding detected: ${hostname} resolved to internal IP ${ip}`);
                        return resolve({
                            safe: false,
                            resolvedIps: allAddresses,
                            error: `Hostname ${hostname} resolves to internal/private IP ${ip}`
                        });
                    }
                }

                return resolve({ safe: true, resolvedIps: allAddresses });
            });
        });
    });
}

/**
 * Validate a baseUrl for SSRF safety
 * Blocks internal/private IPs and hostnames unless ALLOW_INTERNAL_CUSTOM_ENDPOINTS=true.
 * Performs DNS resolution to defend against DNS rebinding attacks.
 * 
 * @param {string} baseUrl - The baseUrl to validate
 * @returns {Promise<{ valid: boolean, error?: string, sanitized?: string }>} - Validation result
 */
async function validateCustomBaseUrl(baseUrl) {
    // Empty URL is considered invalid but not an SSRF risk
    if (!baseUrl || typeof baseUrl !== 'string' || !baseUrl.trim()) {
        return { valid: false, error: 'Base URL is required for custom provider' };
    }

    const trimmed = baseUrl.trim();

    // Parse the URL
    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch (e) {
        return { valid: false, error: `Invalid URL format: ${trimmed}` };
    }

    // Only allow http and https protocols
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { valid: false, error: `Invalid protocol: ${parsed.protocol}. Only http and https are allowed.` };
    }

    const hostname = parsed.hostname;

    // Check if hostname is internal/private
    if (isInternalHost(hostname)) {
        if (ALLOW_INTERNAL) {
            log.debug(() => `[SSRF] Allowing internal endpoint ${hostname} (ALLOW_INTERNAL_CUSTOM_ENDPOINTS=true)`);
            return { valid: true, sanitized: trimmed };
        }

        log.warn(() => `[SSRF] Blocked internal endpoint: ${hostname}. Set ALLOW_INTERNAL_CUSTOM_ENDPOINTS=true in .env to allow local endpoints.`);
        return {
            valid: false,
            error: `Internal/private endpoints (${hostname}) are blocked on this server for security. This server is configured for public deployment.`
        };
    }

    log.debug(() => `[SSRF] Validated external endpoint: ${hostname}`);
    
    // DNS rebinding defense: resolve the hostname and verify the IP is also external.
    // This prevents attackers from registering domains that resolve to 127.0.0.1, 10.x.x.x, etc.
    const dnsResult = await resolveAndValidateHost(hostname);
    if (!dnsResult.safe) {
        if (ALLOW_INTERNAL) {
            log.debug(() => `[SSRF] Allowing DNS-rebinding endpoint ${hostname} -> ${dnsResult.resolvedIps?.join(', ')} (ALLOW_INTERNAL_CUSTOM_ENDPOINTS=true)`);
            return { valid: true, sanitized: trimmed };
        }

        log.warn(() => `[SSRF] Blocked DNS rebinding attempt: ${hostname} -> ${dnsResult.resolvedIps?.join(', ')}`);
        return {
            valid: false,
            error: `Hostname ${hostname} resolves to an internal/private IP address. This is blocked for security.`
        };
    }

    return { valid: true, sanitized: trimmed };
}

/**
 * Check if internal endpoints are allowed (for UI feedback)
 * @returns {boolean}
 */
function areInternalEndpointsAllowed() {
    return ALLOW_INTERNAL;
}

/**
 * Create a DNS lookup function that blocks connections to internal IPs.
 * This is used as the `lookup` option in HTTP agents/axios to enforce
 * SSRF protection at connection time (not just at validation time),
 * closing the TOCTOU gap between DNS validation and actual connection.
 *
 * @returns {Function} A Node.js-compatible lookup function
 */
function createSsrfSafeLookup() {
    return function ssrfSafeLookup(hostname, options, callback) {
        // Handle (hostname, callback) signature
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }

        const family = options?.family || 0; // 0 = both, 4 = IPv4, 6 = IPv6
        const all = options?.all || false;

        dns.lookup(hostname, { family, all: true }, (err, addresses) => {
            if (err) return callback(err);

            if (!addresses || addresses.length === 0) {
                return callback(new Error(`[SSRF] DNS lookup returned no addresses for ${hostname}`));
            }

            // Check if ALLOW_INTERNAL is set — if so, skip the IP check
            if (!ALLOW_INTERNAL) {
                for (const entry of addresses) {
                    const ip = typeof entry === 'string' ? entry : entry.address;
                    if (isInternalIp(ip)) {
                        const error = new Error(`[SSRF] Blocked connection to ${hostname}: resolved to internal IP ${ip}`);
                        error.code = 'ESSRF_INTERNAL_IP';
                        log.warn(() => `[SSRF] Connection-time block: ${hostname} -> ${ip}`);
                        return callback(error);
                    }
                }
            }

            if (all) {
                return callback(null, addresses);
            }

            // Return the first address
            const first = addresses[0];
            return callback(null, first.address, first.family);
        });
    };
}

module.exports = {
    validateCustomBaseUrl,
    isInternalHost,
    isInternalIp,
    resolveAndValidateHost,
    areInternalEndpointsAllowed,
    createSsrfSafeLookup
};
