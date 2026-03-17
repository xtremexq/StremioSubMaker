const { LRUCache } = require('lru-cache');
const crypto = require('crypto');
const log = require('./logger');

// Tracks the most recent stream per config hash (in-memory only)
const latestByConfig = new LRUCache({
  max: parseInt(process.env.STREAM_ACTIVITY_MAX || '5000', 10),
  // Default: keep recent items for 6h to avoid unbounded growth for many unique configs
  ttl: parseInt(process.env.STREAM_ACTIVITY_TTL_MS || `${6 * 60 * 60 * 1000}`, 10),
  // NOTE: updateAgeOnGet intentionally NOT set (defaults to false).
  // Previously this was true, which meant every SSE connect / heartbeat / page refresh
  // reset the 6h TTL — old entries essentially *never* expired as long as a toolbox tab
  // was open, causing phantom "New stream detected" toasts for titles streamed days ago.
});

// Keeps recent activity per config + videoId so a stream can be rediscovered
// after the user switches away and later returns with weaker metadata.
const recentByConfigVideoId = new LRUCache({
  max: parseInt(process.env.STREAM_ACTIVITY_RECENT_MAX || '20000', 10),
  ttl: parseInt(process.env.STREAM_ACTIVITY_TTL_MS || `${6 * 60 * 60 * 1000}`, 10)
});

// Maximum age (ms) of a cached entry to serve on a fresh SSE subscribe.
// Entries older than this are considered stale and omitted from the initial snapshot,
// so newly opened toolbox/SMDB pages don't instantly fire a toast for an old stream.
const SUBSCRIBE_SNAPSHOT_MAX_AGE_MS = parseInt(process.env.STREAM_ACTIVITY_SNAPSHOT_MAX_AGE_MS || `${30 * 60 * 1000}`, 10);

// Heartbeat cadence (default 40s to keep SSE warm)
const HEARTBEAT_MS = parseInt(process.env.STREAM_ACTIVITY_HEARTBEAT_MS || `${40 * 1000}`, 10);
// Allow long-lived connections to avoid churn/reconnect storms
const MAX_CONNECTION_AGE_MS = parseInt(process.env.STREAM_ACTIVITY_MAX_CONN_AGE_MS || `${60 * 60 * 1000}`, 10);
// Allow a few concurrent listeners per config so multiple tool tabs don't thrash retries
const MAX_LISTENERS_PER_CONFIG = parseInt(process.env.STREAM_ACTIVITY_MAX_LISTENERS_PER_CONFIG || '4', 10);
// Log a single heartbeat summary every 5 minutes regardless of cadence
const HEARTBEAT_LOG_INTERVAL_MS = parseInt(process.env.STREAM_ACTIVITY_HEARTBEAT_LOG_INTERVAL_MS || `${5 * 60 * 1000}`, 10);

// Active SSE listeners keyed by config hash -> Set<{res, createdAt, lastEventAt}>
const listeners = new Map();
let heartbeatLogWindowStart = Date.now();
let heartbeatPingEvents = 0;
let heartbeatListenerSamples = 0;
let heartbeatSampleCount = 0;

function buildRecentKey(configHash, videoId) {
  const cfg = (configHash || '').toString().trim();
  const id = (videoId || '').toString().trim();
  if (!cfg || !id) return '';
  return `${cfg}::${id}`;
}

// ── Redis Pub/Sub (multi-instance support) ──────────────────────────────────
const INSTANCE_ID = crypto.randomBytes(8).toString('hex');
const PUBSUB_CHANNEL_BASE = 'stream-activity';
let pubsubChannel = PUBSUB_CHANNEL_BASE; // Resolved at init with Redis key prefix
let pubClient = null;   // Regular ioredis client for PUBLISH (shared)
let subClient = null;   // Dedicated ioredis client for SUBSCRIBE (read-only after subscribe)
let pubsubReady = false;

function cleanupListener(configHash, listener, reason = 'unknown') {
  const set = listeners.get(configHash);
  if (!set || !listener) return;
  if (!set.has(listener)) return;

  set.delete(listener);
  try { listener.res.end(); } catch (_) { }

  if (set.size === 0) listeners.delete(configHash);
  const shortHash = (configHash || '').slice(0, 8);
  log.debug(() => `[StreamActivity] SSE disconnected for ${shortHash} (remaining=${listeners.get(configHash)?.size || 0}, reason=${reason})`);
}

function sendEvent(configHash, listener, event, data) {
  if (!listener?.res) return;
  if (listener.res.writableEnded || listener.res.destroyed) {
    cleanupListener(configHash, listener, 'writable_ended');
    return;
  }

  try {
    listener.res.write(`event: ${event}\n`);
    listener.res.write(`data: ${JSON.stringify(data)}\n\n`);
    listener.lastEventAt = Date.now();
  } catch (e) {
    // If the write fails, clean up the listener to prevent leaks
    log.debug(() => [`[StreamActivity] Failed to send event`, e.message]);
    cleanupListener(configHash, listener, 'write_failed');
  }
}

/**
 * Record latest stream info for a config hash and notify listeners
 * @param {Object} payload
 * @param {string} payload.configHash
 * @param {string} payload.videoId
 * @param {string} [payload.filename]
 * @param {string} [payload.videoHash]
 * @param {string} [payload.stremioHash] - Real OpenSubtitles hash from Stremio (via extra.videoHash)
 */
function recordStreamActivity(payload) {
  if (!payload || typeof payload.configHash !== 'string' || !payload.configHash.length) return;

  const previous = latestByConfig.get(payload.configHash);
  const incomingId = (payload.videoId || '').toString().trim();
  const incomingFilename = (payload.filename || '').toString().trim();
  const incomingHash = (payload.videoHash || '').toString().trim();
  const incomingStremioHash = (payload.stremioHash || '').toString().trim();

  // Treat placeholders/empties as non-authoritative so we don't blow away a good entry
  const isPlaceholderId = (val) => {
    const str = (val || '').toString().trim().toLowerCase();
    if (!str) return true;
    return str === 'stream and refresh' || str === 'stream & refresh' || str === 'unknown' || str === 'unknown title';
  };

  const keepPrevious = !!previous;
  const placeholder = isPlaceholderId(incomingId);
  const recentKey = buildRecentKey(payload.configHash, incomingId);
  const previousForVideo = recentKey ? recentByConfigVideoId.get(recentKey) : null;
  const sameVideoPrevious = previous && previous.videoId === incomingId
    ? previous
    : ((previousForVideo && previousForVideo.videoId === incomingId) ? previousForVideo : null);

  // If the first ping is a placeholder (with or without details), ignore it; wait for a real stream event
  if (!keepPrevious && placeholder) {
    return;
  }

  let effectiveId = incomingId || previous?.videoId || '';
  let effectiveFilename = incomingFilename || '';
  let effectiveHash = incomingHash || '';
  let effectiveStremioHash = incomingStremioHash || '';

  // If this ping carries no useful fields or is clearly a placeholder, treat it as a heartbeat
  if (keepPrevious && (placeholder || (!incomingFilename && !incomingHash && !incomingId))) {
    effectiveId = previous.videoId || effectiveId;
    effectiveFilename = previous.filename || effectiveFilename;
    effectiveHash = previous.videoHash || effectiveHash;
    effectiveStremioHash = previous.stremioHash || effectiveStremioHash;
  } else {
    // Fill gaps from the most authoritative entry we have for this videoId.
    if (sameVideoPrevious) {
      // Guard against hash drift for same-episode updates.
      // When the previous entry already has an authoritative filename+hash pair,
      // keep them stable unless the incoming payload is *strictly more complete*
      // (i.e. it also carries a non-empty filename). This prevents both:
      //  - "id-only" hash drift (no filename + different derived hash)
      //  - "re-encoded filename" drift (different filename string → different MD5 hash)
      if (sameVideoPrevious.filename && sameVideoPrevious.videoHash) {
        if (!incomingFilename) {
          // Incoming has no filename — always keep previous authoritative pair
          effectiveFilename = sameVideoPrevious.filename;
          effectiveHash = sameVideoPrevious.videoHash;
        } else if (incomingHash && incomingHash !== sameVideoPrevious.videoHash) {
          // Incoming has a filename AND a different hash — this is likely the same
          // stream reported with a slightly different filename string (URL-encoded,
          // different addon, etc.).  Keep the original authoritative pair.
          effectiveFilename = sameVideoPrevious.filename;
          effectiveHash = sameVideoPrevious.videoHash;
        }
      }
      if (!effectiveFilename) effectiveFilename = sameVideoPrevious.filename || '';
      if (!effectiveHash) effectiveHash = sameVideoPrevious.videoHash || '';
      if (!effectiveStremioHash) effectiveStremioHash = sameVideoPrevious.stremioHash || '';
    }
  }

  // If we have no useful data at all and nothing stored, skip recording
  const hasMeaningfulPayload = Boolean((effectiveId && !isPlaceholderId(effectiveId)) || effectiveFilename || effectiveHash);
  if (!hasMeaningfulPayload && !previous) return;

  const now = Date.now();
  const entry = {
    videoId: effectiveId,
    filename: effectiveFilename,
    videoHash: effectiveHash,
    stremioHash: effectiveStremioHash,
    // firstSeenAt: timestamp of when this stream was *first detected* for this config.
    // Preserved across heartbeat/enrichment updates so clients can distinguish
    // "stream started 3 hours ago" from "entry was refreshed 10 seconds ago".
    firstSeenAt: (previous && previous.videoId === effectiveId) ? (previous.firstSeenAt || now) : now,
    updatedAt: now
  };

  // Determine if this is a genuinely *new* stream vs. field enrichment for the same one.
  // A real change requires the videoId to differ, OR the entry to be brand new.
  // Field-enrichment for the same videoId (e.g. '' → 'hash', '' → 'filename') is stored
  // silently without firing notifications — this prevents ghost toasts when Stremio sends
  // a second subtitle request for the same episode with slightly more/different metadata.
  const isNewEntry = !previous;
  const videoIdChanged = previous && previous.videoId !== entry.videoId;
  const isFieldEnrichment = previous && previous.videoId === entry.videoId && (
    previous.filename !== entry.filename ||
    previous.videoHash !== entry.videoHash ||
    previous.stremioHash !== entry.stremioHash
  );

  latestByConfig.set(payload.configHash, entry);
  const nextRecentKey = buildRecentKey(payload.configHash, entry.videoId);
  if (nextRecentKey) {
    recentByConfigVideoId.set(nextRecentKey, entry);
  }

  if (isNewEntry || videoIdChanged) {
    const shortHash = payload.configHash.slice(0, 8);
    log.info(() => `[StreamActivity] New stream for ${shortHash} -> videoId=${entry.videoId || 'n/a'}, filename=${entry.filename || 'n/a'}, hash=${entry.videoHash || 'n/a'}`);

    _notifyLocalListeners(payload.configHash, entry);

    // Broadcast to other instances via Redis pub/sub
    _publishStreamEvent(payload.configHash, entry);
  } else if (isFieldEnrichment) {
    log.debug(() => `[StreamActivity] Enriched fields for existing stream ${payload.configHash.slice(0, 8)} (no notification)`);
  } else {
    log.debug(() => `[StreamActivity] Refreshed activity for existing stream ${payload.configHash.slice(0, 8)}`);
  }
}

/**
 * Notify local SSE listeners for a config hash
 * @private
 */
function _notifyLocalListeners(configHash, entry) {
  const set = listeners.get(configHash);
  if (set && set.size) {
    for (const listener of set) {
      sendEvent(configHash, listener, 'episode', entry);
    }
  }
}

/**
 * Publish a stream event to Redis for cross-instance broadcast (fire-and-forget)
 * @private
 */
function _publishStreamEvent(configHash, entry) {
  if (!pubsubReady || !pubClient) return;
  try {
    const message = JSON.stringify({ instanceId: INSTANCE_ID, configHash, entry });
    pubClient.publish(pubsubChannel, message).catch(err => {
      log.debug(() => `[StreamActivity] Pub/sub publish failed: ${err.message}`);
    });
  } catch (err) {
    log.debug(() => `[StreamActivity] Pub/sub publish error: ${err.message}`);
  }
}

/**
 * Handle a stream event received from another instance via Redis pub/sub
 * @private
 */
function _handleRemoteStreamEvent(message) {
  try {
    const data = JSON.parse(message);
    // Ignore our own messages
    if (data.instanceId === INSTANCE_ID) return;
    if (!data.configHash || !data.entry) return;

    // Apply the same change-detection logic as recordStreamActivity:
    // only notify local listeners if the videoId actually changed.
    // This prevents a remote instance's field-enrichment or heartbeat
    // from triggering ghost notifications on this instance.
    const previous = latestByConfig.get(data.configHash);
    const isNewEntry = !previous;
    const videoIdChanged = previous && previous.videoId !== data.entry.videoId;

    // Preserve firstSeenAt from local entry when remote event is for the same stream
    if (previous && !isNewEntry && !videoIdChanged && previous.firstSeenAt) {
      data.entry.firstSeenAt = previous.firstSeenAt;
    }

    // Always update local LRU so polling fallback stays current
    latestByConfig.set(data.configHash, data.entry);
    const recentKey = buildRecentKey(data.configHash, data.entry.videoId);
    if (recentKey) {
      recentByConfigVideoId.set(recentKey, data.entry);
    }

    // Only notify local listeners on a genuinely new stream
    if (isNewEntry || videoIdChanged) {
      _notifyLocalListeners(data.configHash, data.entry);
    }

    log.debug(() => `[StreamActivity] Received remote stream event for ${data.configHash.slice(0, 8)} from instance ${data.instanceId.slice(0, 6)} (notify=${isNewEntry || videoIdChanged})`);
  } catch (err) {
    log.debug(() => `[StreamActivity] Failed to process remote stream event: ${err.message}`);
  }
}

/**
 * Initialize Redis pub/sub for cross-instance stream activity.
 * Call once after storage is initialized. Safe to call in filesystem mode (no-op).
 */
async function initPubSub() {
  try {
    const StorageFactory = require('../storage/StorageFactory');
    const redisClient = StorageFactory.getRedisClient();
    if (!redisClient) {
      log.debug(() => '[StreamActivity] No Redis client available, pub/sub disabled (filesystem mode)');
      return;
    }

    // Resolve channel name with Redis key prefix for namespace isolation
    // (ioredis keyPrefix does NOT apply to pub/sub commands)
    const keyPrefix = redisClient.options?.keyPrefix || '';
    pubsubChannel = `${keyPrefix}${PUBSUB_CHANNEL_BASE}`;

    // Use the main client for PUBLISH (it can still do normal commands)
    pubClient = redisClient;

    // Create a dedicated connection for SUBSCRIBE (ioredis requirement:
    // subscribing makes a connection read-only)
    subClient = redisClient.duplicate({ lazyConnect: true });
    await subClient.connect();

    subClient.subscribe(pubsubChannel, (err) => {
      if (err) {
        log.warn(() => `[StreamActivity] Failed to subscribe to pub/sub channel: ${err.message}`);
        return;
      }
      pubsubReady = true;
      log.info(() => `[StreamActivity] Redis pub/sub initialized (instanceId=${INSTANCE_ID.slice(0, 6)}, channel=${pubsubChannel})`);
    });

    subClient.on('message', (channel, message) => {
      if (channel === pubsubChannel) {
        _handleRemoteStreamEvent(message);
      }
    });

    // Graceful shutdown
    const cleanup = async () => {
      try {
        if (subClient) {
          await subClient.unsubscribe(pubsubChannel);
          await subClient.disconnect();
          subClient = null;
        }
        pubsubReady = false;
      } catch (_) { /* ignore */ }
    };
    process.once('SIGTERM', cleanup);
    process.once('SIGINT', cleanup);
  } catch (err) {
    log.warn(() => `[StreamActivity] Pub/sub initialization failed (non-fatal): ${err.message}`);
  }
}

/**
 * Get latest stream activity for a config hash
 * @param {string} configHash
 */
function getLatestStreamActivity(configHash) {
  if (!configHash) return null;
  return latestByConfig.get(configHash) || null;
}

/**
 * Get the most recent activity for a specific config + videoId pair.
 * This survives switching to a different stream while the TTL window is active.
 * @param {string} configHash
 * @param {string} videoId
 */
function getRecentStreamActivity(configHash, videoId) {
  const key = buildRecentKey(configHash, videoId);
  if (!key) return null;
  return recentByConfigVideoId.get(key) || null;
}

/**
 * Subscribe an Express response to SSE for a config hash
 * @param {string} configHash
 * @param {object} res Express response
 */
function subscribe(configHash, res) {
  if (!configHash || !res) return () => { };

  const existing = listeners.get(configHash);
  if (existing && existing.size >= MAX_LISTENERS_PER_CONFIG) {
    // Reject additional listeners; clients should fall back to polling/backoff
    try {
      res.setHeader('Retry-After', '5');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } catch (_) { /* ignore */ }
    res.statusCode = 204;
    res.end();
    const shortHash = (configHash || '').slice(0, 8);
    log.debug(() => `[StreamActivity] SSE rejected (too many listeners) for ${shortHash}`);
    return () => { };
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Content-Encoding', 'identity'); // Explicitly disable compression for SSE
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering for SSE
  res.flushHeaders?.();

  // Hint client-side reconnection interval to avoid tight retry loops if upstream drops the socket
  try { res.write(`retry: 5000\n\n`); } catch (_) { }

  // Immediate ack + latest snapshot so the client knows current state
  const listener = { res, createdAt: Date.now(), lastEventAt: Date.now() };
  sendEvent(configHash, listener, 'ready', { ok: true, ts: Date.now() });
  const latest = getLatestStreamActivity(configHash);
  if (latest) {
    // Only send the cached snapshot if the stream was first detected recently.
    // This prevents newly opened toolbox/SMDB pages from receiving a stale entry
    // for a stream that was watched hours/days ago, which would trigger a
    // phantom "New stream detected" toast.
    const entryAge = Date.now() - (latest.firstSeenAt || latest.updatedAt || 0);
    if (entryAge < SUBSCRIBE_SNAPSHOT_MAX_AGE_MS) {
      sendEvent(configHash, listener, 'episode', latest);
    } else {
      log.debug(() => `[StreamActivity] Suppressed stale snapshot for ${(configHash || '').slice(0, 8)} (age=${Math.round(entryAge / 1000)}s)`);
    }
  }

  let set = listeners.get(configHash);
  if (!set) {
    set = new Set();
    listeners.set(configHash, set);
  }

  set.add(listener);

  const shortHash = (configHash || '').slice(0, 8);
  log.debug(() => `[StreamActivity] SSE subscribed for ${shortHash} (listeners=${set.size})`);

  let cleaned = false;
  const cleanup = (reason = 'client_closed') => {
    if (cleaned) return;
    cleaned = true;
    cleanupListener(configHash, listener, reason);
  };

  res.on('close', () => cleanup('res_close'));
  res.on('finish', () => cleanup('res_finish'));
  res.on('error', () => cleanup('res_error'));
  res.req?.on?.('aborted', () => cleanup('req_aborted'));
  return cleanup;
}

// Shared heartbeat to keep connections alive and prune stale ones
setInterval(() => {
  const now = Date.now();
  let listenersSeenThisTick = 0;
  for (const [configHash, set] of listeners.entries()) {
    listenersSeenThisTick += set?.size || 0;
    for (const listener of [...set]) {
      if (!listener?.res) {
        cleanupListener(configHash, listener, 'missing_res');
        continue;
      }
      if (listener.res.writableEnded || listener.res.destroyed) {
        cleanupListener(configHash, listener, 'writable_ended');
        continue;
      }
      if (now - listener.createdAt > MAX_CONNECTION_AGE_MS) {
        cleanupListener(configHash, listener, 'max_age');
        continue;
      }
      sendEvent(configHash, listener, 'ping', { ts: now });
    }
  }
  heartbeatPingEvents += listenersSeenThisTick;
  heartbeatListenerSamples += listenersSeenThisTick;
  heartbeatSampleCount += 1;

  if (now - heartbeatLogWindowStart >= HEARTBEAT_LOG_INTERVAL_MS) {
    const avgListeners = heartbeatSampleCount ? Math.round(heartbeatListenerSamples / heartbeatSampleCount) : 0;
    log.debug(() => `[StreamActivity] Heartbeat summary: intervalMs=${HEARTBEAT_MS}, configs=${listeners.size}, listenersNow=${listenersSeenThisTick}, avgListeners=${avgListeners}, pingsSent=${heartbeatPingEvents}`);
    heartbeatLogWindowStart = now;
    heartbeatPingEvents = 0;
    heartbeatListenerSamples = 0;
    heartbeatSampleCount = 0;
  }
}, HEARTBEAT_MS).unref();

module.exports = {
  recordStreamActivity,
  getLatestStreamActivity,
  getRecentStreamActivity,
  subscribe,
  initPubSub
};
