const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('./logger');

// Persisted instance id so restarts keep the same namespace when no explicit
// isolation value is provided. Store it in the data volume by default so it
// survives container rebuilds/redeployments (otherwise every new container
// would write a new file at /app/.instance-id and switch the implicit Redis
// prefix, making previously saved sessions unreachable until they naturally
// expire). Existing custom paths via INSTANCE_ID_FILE are still honored.
const INSTANCE_FILE = process.env.INSTANCE_ID_FILE || path.join(process.cwd(), 'data', '.instance-id');
// Keep in sync with src/utils/encryption.js so we can derive a stable isolation
// namespace from the encryption key even when it's loaded from disk instead of
// the environment. This lets multiple pods share redis sessions/caches when
// the encryption key file is mounted into each container.
const ENCRYPTION_KEY_FILE = process.env.ENCRYPTION_KEY_FILE || path.join(process.cwd(), '.encryption-key');

function sanitizeSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 32) || 'default';
}

function loadOrCreateInstanceId() {
  try {
    const instanceDir = path.dirname(INSTANCE_FILE);
    try {
      fs.mkdirSync(instanceDir, { recursive: true });
    } catch (err) {
      // Best effort – if this fails we'll log below and fall back to a stable id
      log.warn(() => ['[Isolation] Failed to ensure instance id directory exists:', err.message]);
    }

    if (fs.existsSync(INSTANCE_FILE)) {
      const raw = fs.readFileSync(INSTANCE_FILE, 'utf8').trim();
      if (raw) {
        return sanitizeSegment(raw);
      }
    }

    const generated = sanitizeSegment(crypto.randomBytes(8).toString('hex'));
    try {
      fs.writeFileSync(INSTANCE_FILE, generated, { mode: 0o600 });
    } catch (err) {
      log.warn(() => ['[Isolation] Failed to persist instance id, using in-memory value:', err.message]);
    }
    return generated;
  } catch (err) {
    log.warn(() => ['[Isolation] Unable to read/write instance id file:', err.message]);
    return 'default';
  }
}

function hashValue(value) {
  try {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
  } catch (_) {
    return null;
  }
}

/**
 * Deterministic fallback for isolation key when all other methods fail.
 * Uses hostname (stable across restarts of the same container) so that
 * cache/data directories remain consistent and previously stored sessions
 * are still reachable after a restart — unlike the old random fallback
 * which made data unreachable every time the container restarted.
 */
function getDeterministicFallback() {
  try {
    const os = require('os');
    const hostname = os.hostname();
    if (hostname) {
      const hashed = hashValue(hostname);
      if (hashed) {
        return `host_${hashed.slice(0, 8)}`;
      }
    }
  } catch (_) {
    // ignore
  }
  // Ultimate fallback: fixed string so at least data stays in one place
  return 'default';
}

function getIsolationKey() {
  const envKey = process.env.INSTANCE_ISOLATION_KEY || process.env.INSTANCE_ID || process.env.APP_INSTANCE;
  if (envKey) {
    return sanitizeSegment(envKey);
  }

  if (process.env.ENCRYPTION_KEY) {
    const hashed = hashValue(process.env.ENCRYPTION_KEY);
    if (hashed) {
      return `enc_${hashed.slice(0, 8)}`;
    }
  }

  try {
    if (fs.existsSync(ENCRYPTION_KEY_FILE)) {
      const keyHex = fs.readFileSync(ENCRYPTION_KEY_FILE, 'utf8').trim();
      const hashed = hashValue(keyHex);
      if (hashed) {
        return `enc_${hashed.slice(0, 8)}`;
      }
    }
  } catch (err) {
    log.warn(() => ['[Isolation] Unable to hash encryption key file for isolation:', err.message]);
  }

  // Ensure Redis key prefix stays stable across restarts even when the
  // encryption key file does not exist yet on first boot. Generating or
  // loading the encryption key now gives us a consistent hash for the
  // default prefix instead of falling back to a random instance id on
  // the first run and then switching to an encryption-key-derived prefix
  // after restart (which makes previously stored sessions invisible).
  try {
    const { getEncryptionKey } = require('./encryption');
    const key = getEncryptionKey();
    const hashed = hashValue(key?.toString('hex'));
    if (hashed) {
      return `enc_${hashed.slice(0, 8)}`;
    }
  } catch (err) {
    log.warn(() => ['[Isolation] Unable to derive isolation key from encryption key:', err.message]);
  }

  // Try to load/create a persisted instance id
  const instanceId = loadOrCreateInstanceId();

  // If the instance id is a transient random value (i.e. it couldn't be
  // persisted), prefer a deterministic fallback based on hostname so that
  // cache directories stay stable across restarts.
  try {
    if (!fs.existsSync(INSTANCE_FILE)) {
      const fallback = getDeterministicFallback();
      log.warn(() => `[Isolation] Using deterministic fallback isolation key: ${fallback} (instance id could not be persisted)`);
      return fallback;
    }
  } catch (_) {
    // ignore
  }

  return instanceId;
}

module.exports = {
  getIsolationKey,
};
