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
 *
 * Usage:
 *   const { httpAgent, httpsAgent } = require('./utils/httpAgents');
 *
 *   axios.create({
 *     httpAgent,
 *     httpsAgent,
 *     // ... other config
 *   });
 */

const http = require('http');
const https = require('https');
const log = require('./logger');

/**
 * HTTP Agent with connection pooling
 * Reuses connections for http:// URLs
 */
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50,        // Max 50 concurrent connections per host
  maxFreeSockets: 10,    // Keep 10 idle connections ready for reuse
  timeout: 60000,        // 60 second socket timeout
  keepAliveMsecs: 30000  // Send keepalive probes every 30s
});

/**
 * HTTPS Agent with connection pooling
 * Reuses connections for https:// URLs
 */
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,        // Max 50 concurrent connections per host
  maxFreeSockets: 10,    // Keep 10 idle connections ready for reuse
  timeout: 60000,        // 60 second socket timeout
  keepAliveMsecs: 30000  // Send keepalive probes every 30s
});

log.debug(() => '[HTTP Agents] Connection pooling initialized: maxSockets=50, maxFreeSockets=10, keepAlive=true');

module.exports = {
  httpAgent,
  httpsAgent
};
