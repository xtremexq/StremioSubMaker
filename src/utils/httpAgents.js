/**
 * Shared HTTP/HTTPS Connection Pooling Configuration
 *
 * This module provides reusable HTTP agents with connection pooling enabled
 * to significantly reduce latency overhead for external API calls.
 *
 * Benefits:
 * - Reuses TCP connections instead of creating new ones for every request
 * - Reduces latency by 150-500ms per API call (TCP + TLS handshake savings)
 * - Prevents socket exhaustion under high load
 * - Improves scalability for 100+ concurrent users
 * - Pre-warms connections at startup for instant first requests
 * - Periodic keep-alive pings maintain warm connections during idle periods
 * - Circuit breaker tracks provider health to skip failing endpoints
 *
 * Usage:
 *   const { httpAgent, httpsAgent, warmUpConnections, startKeepAlivePings } = require('./utils/httpAgents');
 *
 *   // At server startup:
 *   warmUpConnections();           // Prime TLS connections
 *   startKeepAlivePings();         // Keep them warm periodically
 *
 *   // In service classes:
 *   axios.create({
 *     httpAgent,
 *     httpsAgent,
 *     // ... other config
 *   });
 */

const http = require('http');
const https = require('https');
const axios = require('axios');
// Handle ESM (v7+) and CJS (v6) exports of cacheable-lookup
let CacheableLookup = require('cacheable-lookup');
CacheableLookup = (CacheableLookup && (CacheableLookup.default || CacheableLookup.CacheableLookup)) || CacheableLookup;
const log = require('./logger');
const { scsHttpsAgent } = require('./scsHttpAgent');

/**
 * HTTP Agent with connection pooling
 * Reuses connections for http:// URLs
 */
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 100,       // Max 100 concurrent connections per host
  maxFreeSockets: 20,    // Keep 20 idle connections ready for reuse
  timeout: 60000,        // 60 second socket timeout
  keepAliveMsecs: 30000  // Send keepalive probes every 30s (TCP keep-alive interval)
});

/**
 * HTTPS Agent with connection pooling
 * Reuses connections for https:// URLs
 */
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 100,       // Max 100 concurrent connections per host
  maxFreeSockets: 20,    // Keep 20 idle connections ready for reuse
  timeout: 60000,        // 60 second socket timeout
  keepAliveMsecs: 30000, // Send keepalive probes every 30s (TLS over TCP)
  // TLS settings for compatibility with servers that have strict requirements
  minVersion: 'TLSv1.2', // Minimum TLS 1.2 (widely supported, fixes some handshake issues)
  rejectUnauthorized: true // Verify server certificates (security)
});

// DNS cache to reduce lookup latency and flakiness
const dnsCache = new CacheableLookup({
  maxTtl: 60,      // seconds to keep successful lookups
  errorTtl: 0,     // don't cache failed lookups
  cache: new Map() // in-memory cache
});
const dnsLookup = dnsCache.lookup.bind(dnsCache);

log.debug(() => '[HTTP Agents] Connection pooling initialized: maxSockets=100, maxFreeSockets=20, keepAlive=true');

// ============================================================================
// PROVIDER ENDPOINTS - URLs to warm up and keep alive
// ============================================================================
const PROVIDER_ENDPOINTS = {
  opensubtitlesAuth: {
    url: 'https://api.opensubtitles.com/',
    name: 'OpenSubtitles Auth',
    warmUpPath: 'api/v1', // Warm the authenticated REST API host without hitting /login
    pingPath: 'api/v1',
    warmUpEnabled: true,
    keepAliveEnabled: true
  },
  // Subtitle providers - warm these up at startup for instant first requests
  opensubtitlesV3: {
    url: 'https://opensubtitles-v3.strem.io/',
    name: 'OpenSubtitles V3',
    warmUpPath: 'subtitles/series/tt0944947:1:1.json', // GoT S1E1 - always exists
    pingPath: null, // HEAD to base URL
    warmUpEnabled: true,
    keepAliveEnabled: true
  },
  subdl: {
    url: 'https://api.subdl.com/',
    name: 'SubDL',
    warmUpPath: null, // API requires key, just warm TLS
    pingPath: null, // HEAD to base URL
    warmUpEnabled: true,
    keepAliveEnabled: true
  },
  subsource: {
    url: 'https://api.subsource.net/',
    name: 'SubSource',
    warmUpPath: null, // API requires key, just warm TLS
    pingPath: null, // HEAD to base URL
    warmUpEnabled: true,
    keepAliveEnabled: true
  },
  wyzie: {
    url: 'https://sub.wyzie.ru/',
    name: 'Wyzie Subs',
    warmUpPath: 'status', // Free status endpoint
    pingPath: 'status',
    keepAliveFailureOpensCircuit: false, // Status probe failures should not suppress real searches
    warmUpEnabled: true,
    keepAliveEnabled: true
  },
  scs: {
    url: 'https://stremio-community-subtitles.top/',
    name: 'Stremio Community Subtitles',
    warmUpPath: null, // Just warm TLS
    pingPath: null, // HEAD to base URL
    httpsAgent: scsHttpsAgent,
    keepAliveFailureOpensCircuit: false, // Slow/flaky probes should not block real SCS attempts
    warmUpEnabled: true,
    keepAliveEnabled: true
  },
  subsro: {
    url: 'https://api.subs.ro/',
    name: 'Subs.ro',
    warmUpPath: null, // API requires key
    pingPath: null, // HEAD to base URL
    warmUpEnabled: true,
    keepAliveEnabled: true
  },
  // Download domains - also warm these up
  subdlDownload: {
    url: 'https://dl.subdl.com/',
    name: 'SubDL Download',
    warmUpPath: null,
    pingPath: null,
    warmUpEnabled: true,
    keepAliveEnabled: true
  }
};

function getConnectionTargetEntries(mode) {
  const flagName = mode === 'keepAlive' ? 'keepAliveEnabled' : 'warmUpEnabled';
  return Object.entries(PROVIDER_ENDPOINTS).filter(([, provider]) => provider[flagName] !== false);
}

function getConnectionTargetKeys(mode) {
  return getConnectionTargetEntries(mode).map(([key]) => key);
}

function shouldKeepAliveFailureOpenCircuit(providerKey) {
  return PROVIDER_ENDPOINTS[providerKey]?.keepAliveFailureOpensCircuit !== false;
}

function buildProbeRequest(provider, mode) {
  const isKeepAlive = mode === 'keepAlive';
  const path = isKeepAlive ? provider.pingPath : provider.warmUpPath;
  const method = isKeepAlive
    ? (provider.pingMethod || 'head')
    : (provider.warmUpMethod || (provider.warmUpPath ? 'get' : 'head'));

  return {
    method,
    url: path ? `${provider.url}${path}` : provider.url,
    httpAgent: provider.httpAgent || httpAgent,
    httpsAgent: provider.httpsAgent || httpsAgent
  };
}

// ============================================================================
// CIRCUIT BREAKER - Track provider health to skip failing endpoints
// ============================================================================
const circuitBreaker = {
  // Track failures per provider: { providerKey: { failures: number, lastFailure: timestamp, openUntil: timestamp } }
  providers: new Map(),

  // Configuration
  failureThreshold: 3,           // Number of failures before opening circuit
  resetTimeoutMs: 60000,         // Time to wait before trying again (1 minute)
  halfOpenSuccessThreshold: 2,   // Successes needed in half-open to close circuit

  /**
   * Check if provider circuit is open (failing, should skip)
   */
  isOpen(providerKey) {
    const state = this.providers.get(providerKey);
    if (!state) return false;

    const now = Date.now();
    if (state.openUntil && now < state.openUntil) {
      return true; // Circuit is open, skip this provider
    }

    // Circuit timeout expired, move to half-open
    if (state.openUntil && now >= state.openUntil) {
      state.halfOpen = true;
      state.halfOpenSuccesses = 0;
    }

    return false;
  },

  /**
   * Record a successful request - helps close half-open circuits
   */
  recordSuccess(providerKey) {
    const state = this.providers.get(providerKey);
    if (!state) return;

    if (state.halfOpen) {
      state.halfOpenSuccesses = (state.halfOpenSuccesses || 0) + 1;
      if (state.halfOpenSuccesses >= this.halfOpenSuccessThreshold) {
        // Circuit fully closed
        this.providers.delete(providerKey);
        log.info(() => `[CircuitBreaker] Circuit CLOSED for ${providerKey} after successful requests`);
      }
    } else {
      // Reset failure count on success
      this.providers.delete(providerKey);
    }
  },

  /**
   * Record a failed request - may open the circuit
   */
  recordFailure(providerKey, error) {
    const now = Date.now();
    let state = this.providers.get(providerKey);

    if (!state) {
      state = { failures: 0, lastFailure: 0, openUntil: null, halfOpen: false };
      this.providers.set(providerKey, state);
    }

    state.failures++;
    state.lastFailure = now;

    // If in half-open, immediately re-open
    if (state.halfOpen) {
      state.halfOpen = false;
      state.openUntil = now + this.resetTimeoutMs;
      log.warn(() => `[CircuitBreaker] Circuit RE-OPENED for ${providerKey} after half-open failure`);
      return;
    }

    // Check if threshold reached
    if (state.failures >= this.failureThreshold) {
      state.openUntil = now + this.resetTimeoutMs;
      log.warn(() => `[CircuitBreaker] Circuit OPENED for ${providerKey} after ${state.failures} failures. Will retry after ${this.resetTimeoutMs / 1000}s`);
    }
  },

  /**
   * Get status of all circuits for debugging
   */
  getStatus() {
    const status = {};
    const now = Date.now();
    for (const [key, state] of this.providers.entries()) {
      status[key] = {
        failures: state.failures,
        isOpen: state.openUntil && now < state.openUntil,
        halfOpen: state.halfOpen || false,
        reopensIn: state.openUntil ? Math.max(0, state.openUntil - now) : null
      };
    }
    return status;
  },

  /**
   * Get time remaining until circuit reopens (for user-facing messages)
   * @returns {number|null} milliseconds until circuit closes, or null if not open
   */
  getTimeUntilRetry(providerKey) {
    const state = this.providers.get(providerKey);
    if (!state || !state.openUntil) return null;
    const remaining = state.openUntil - Date.now();
    return remaining > 0 ? remaining : null;
  }
};

// ============================================================================
// PROVIDER HEALTH CHECK - For subtitle handler to skip dead providers
// ============================================================================

/**
 * Map from subtitle handler provider names to circuit breaker keys
 * These must match the keys used in PROVIDER_ENDPOINTS
 */
const PROVIDER_KEY_MAP = {
  'opensubtitles_v3': 'opensubtitlesV3',
  'opensubtitles_auth': 'opensubtitlesAuth',
  'subdl': 'subdl',
  'subsource': 'subsource',
  'wyzie': 'wyzie',
  'scs': 'scs',
  'subsro': 'subsro'
};

/**
 * Check if a provider is healthy enough to make a request
 * Returns false if the circuit breaker is open (provider is failing)
 * 
 * @param {string} providerName - Provider name (e.g., 'subdl', 'opensubtitles_v3', 'scs')
 * @returns {{ healthy: boolean, reason?: string, retryInMs?: number }}
 */
function isProviderHealthy(providerName) {
  const key = PROVIDER_KEY_MAP[providerName.toLowerCase()];

  // Unknown provider or no circuit tracking - allow request
  if (!key) {
    return { healthy: true };
  }

  if (circuitBreaker.isOpen(key)) {
    const retryInMs = circuitBreaker.getTimeUntilRetry(key);
    const retryInSec = retryInMs ? Math.ceil(retryInMs / 1000) : null;
    const providerInfo = PROVIDER_ENDPOINTS[key];
    const name = providerInfo?.name || providerName;

    return {
      healthy: false,
      reason: `${name} circuit breaker open (provider failing)`,
      retryInMs,
      retryInSec
    };
  }

  return { healthy: true };
}

// ============================================================================
// CONNECTION WARMING - Establish TLS connections at startup
// ============================================================================

/**
 * Warm up connections to subtitle providers
 * Makes lightweight requests to establish TLS handshakes before users need them
 * This saves 150-500ms on the first request to each provider
 */
async function warmUpConnections() {
  const warmUpTargets = getConnectionTargetEntries('warmUp');
  log.info(() => `[HTTP Agents] Warming up connections to subtitle providers (${warmUpTargets.length} targets)...`);
  log.debug(() => `[HTTP Agents] Warm-up targets: ${warmUpTargets.map(([, provider]) => provider.name).join(', ')}`);

  const warmUpStart = Date.now();
  const results = [];

  // Warm up all providers in parallel
  const warmUpPromises = warmUpTargets.map(async ([key, provider]) => {
    const startTime = Date.now();
    try {
      const probeRequest = buildProbeRequest(provider, 'warmUp');

      // IMPORTANT: Do not use dnsLookup for raw warm-up probes.
      // On some networks, fanning out many parallel hosts through cacheable-lookup
      // stalls these startup probes to the full timeout window. Provider clients
      // still use dnsLookup on real traffic; the probes only need fast handshakes.
      await axios({
        ...probeRequest,
        timeout: 8000, // 8 second timeout for warm-up
        validateStatus: () => true, // Accept any status (we just want the TLS handshake)
        maxRedirects: 3
      });

      const elapsed = Date.now() - startTime;
      results.push({ provider: provider.name, success: true, elapsed });
      log.debug(() => `[HTTP Agents] Warmed ${provider.name} in ${elapsed}ms`);

      // Record success for circuit breaker
      circuitBreaker.recordSuccess(key);

    } catch (error) {
      const elapsed = Date.now() - startTime;
      results.push({ provider: provider.name, success: false, elapsed, error: error.message });
      log.warn(() => `[HTTP Agents] Failed to warm ${provider.name}: ${error.message} (${elapsed}ms)`);

      // Record failure for circuit breaker (but don't open circuit on warm-up failures)
      // We don't call recordFailure here since warm-up failures shouldn't penalize the provider
    }
  });

  await Promise.allSettled(warmUpPromises);

  const totalElapsed = Date.now() - warmUpStart;
  const successCount = results.filter(r => r.success).length;
  const totalCount = results.length;

  log.info(() => `[HTTP Agents] Connection warm-up complete: ${successCount}/${totalCount} providers in ${totalElapsed}ms`);

  return results;
}

// ============================================================================
// KEEP-ALIVE PINGS - Periodically ping providers to keep connections warm
// ============================================================================

let keepAliveInterval = null;
const KEEP_ALIVE_INTERVAL_MS = 45000; // Every 45 seconds
const KEEP_ALIVE_TIMEOUT_MS = 10000; // Give slow providers more time before probe failure

/**
 * Start periodic keep-alive pings to maintain warm connections
 * These lightweight HEAD requests prevent idle connection closure
 */
function startKeepAlivePings() {
  if (keepAliveInterval) {
    log.debug(() => '[HTTP Agents] Keep-alive pings already running');
    return;
  }

  const keepAliveTargets = getConnectionTargetEntries('keepAlive');
  log.info(() => `[HTTP Agents] Starting keep-alive pings every ${KEEP_ALIVE_INTERVAL_MS / 1000}s for ${keepAliveTargets.length} targets`);
  log.debug(() => `[HTTP Agents] Keep-alive targets: ${keepAliveTargets.map(([, provider]) => provider.name).join(', ')}`);

  keepAliveInterval = setInterval(async () => {
    const providersToPing = getConnectionTargetEntries('keepAlive')
      .filter(([key]) => !circuitBreaker.isOpen(key));

    if (providersToPing.length === 0) {
      log.debug(() => '[HTTP Agents] No providers to ping (all tracked circuits are open)');
      return;
    }

    const pingPromises = providersToPing.map(async ([key, provider]) => {
      try {
        const probeRequest = buildProbeRequest(provider, 'keepAlive');
        await axios({
          ...probeRequest,
          timeout: KEEP_ALIVE_TIMEOUT_MS,
          validateStatus: () => true
        });

        log.debug(() => `[HTTP Agents] Keep-alive ping to ${provider.name} OK`);
        circuitBreaker.recordSuccess(key);

      } catch (error) {
        if (!shouldKeepAliveFailureOpenCircuit(key)) {
          log.debug(() => `[HTTP Agents] Keep-alive ping to ${provider.name} failed (non-blocking): ${error.message}`);
          return;
        }

        log.debug(() => `[HTTP Agents] Keep-alive ping to ${provider.name} failed: ${error.message}`);
        circuitBreaker.recordFailure(key, error);
      }
    });

    await Promise.allSettled(pingPromises);

  }, KEEP_ALIVE_INTERVAL_MS);

  // Don't prevent Node from exiting
  if (keepAliveInterval.unref) {
    keepAliveInterval.unref();
  }
}

/**
 * Stop periodic keep-alive pings (for graceful shutdown)
 */
function stopKeepAlivePings() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
    log.debug(() => '[HTTP Agents] Keep-alive pings stopped');
  }
}

/**
 * Get connection pool statistics for monitoring
 */
function getPoolStats() {
  const httpStats = {
    totalSockets: Object.values(httpAgent.sockets || {}).reduce((sum, arr) => sum + arr.length, 0),
    freeSockets: Object.values(httpAgent.freeSockets || {}).reduce((sum, arr) => sum + arr.length, 0),
    pendingRequests: Object.values(httpAgent.requests || {}).reduce((sum, arr) => sum + arr.length, 0)
  };

  const httpsStats = {
    totalSockets: Object.values(httpsAgent.sockets || {}).reduce((sum, arr) => sum + arr.length, 0),
    freeSockets: Object.values(httpsAgent.freeSockets || {}).reduce((sum, arr) => sum + arr.length, 0),
    pendingRequests: Object.values(httpsAgent.requests || {}).reduce((sum, arr) => sum + arr.length, 0)
  };

  return {
    http: httpStats,
    https: httpsStats,
    circuitBreaker: circuitBreaker.getStatus()
  };
}

module.exports = {
  httpAgent,
  httpsAgent,
  // Expose lookup so callers can pass it in request options
  dnsLookup,
  // Connection warming and keep-alive
  warmUpConnections,
  startKeepAlivePings,
  stopKeepAlivePings,
  getConnectionTargetKeys,
  shouldKeepAliveFailureOpenCircuit,
  KEEP_ALIVE_TIMEOUT_MS,
  // Circuit breaker access
  circuitBreaker,
  isProviderHealthy, // Check if provider is healthy before making requests
  // Pool statistics
  getPoolStats,
  // Provider list (for external use)
  PROVIDER_ENDPOINTS
};
