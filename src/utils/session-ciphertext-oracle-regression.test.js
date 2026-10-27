'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Keep the regression independent from developer and deployment key files.
process.env.ENCRYPTION_KEY = 'cd'.repeat(32);

const {
  encrypt,
  findEncryptedSensitiveInputPaths
} = require('./encryption');
const {
  SessionManager,
  computeIntegrityHash,
  computeLegacyIntegrityHash,
  verifyIntegrityHash
} = require('./sessionManager');
const StorageFactory = require('../storage/StorageFactory');

test('all encrypted credential inputs are detected without inspecting unrelated strings', () => {
  const ciphertext = encrypt('fake-victim-secret');
  const config = {
    geminiApiKey: ciphertext,
    geminiApiKeys: ['ordinary-key', ciphertext],
    assemblyAiApiKey: ciphertext,
    cloudflareWorkersApiKey: ciphertext,
    subtitleProviders: {
      opensubtitles: { username: ciphertext, password: ciphertext },
      subdl: { apiKey: ciphertext },
      subsource: { apiKey: ciphertext },
      scs: { apiKey: ciphertext },
      wyzie: { apiKey: ciphertext },
      subsro: { apiKey: ciphertext },
      jimaku: { apiKey: ciphertext }
    },
    providers: {
      openai: { apiKey: ciphertext },
      custom: { apiKey: ciphertext }
    },
    unrelatedDisplayValue: ciphertext
  };

  assert.deepEqual(findEncryptedSensitiveInputPaths(config), [
    'geminiApiKey',
    'geminiApiKeys[1]',
    'assemblyAiApiKey',
    'cloudflareWorkersApiKey',
    'subtitleProviders.opensubtitles.username',
    'subtitleProviders.opensubtitles.password',
    'subtitleProviders.subdl.apiKey',
    'subtitleProviders.subsource.apiKey',
    'subtitleProviders.scs.apiKey',
    'subtitleProviders.wyzie.apiKey',
    'subtitleProviders.subsro.apiKey',
    'subtitleProviders.jimaku.apiKey',
    'providers.openai.apiKey',
    'providers.custom.apiKey'
  ]);
});

test('session create and update reject ciphertext instead of normalizing or decrypting it', async () => {
  const manager = Object.create(SessionManager.prototype);
  const config = { geminiApiKey: encrypt('fake-victim-secret') };

  await assert.rejects(
    manager.createSession(config),
    (error) => error?.code === 'ENCRYPTED_SENSITIVE_INPUT'
      && error?.rejectedFieldCount === 1
  );
  await assert.rejects(
    manager.updateSession('0123456789abcdef0123456789abcdef', config),
    (error) => error?.code === 'ENCRYPTED_SENSITIVE_INPUT'
      && error?.rejectedFieldCount === 1
  );
});

test('public create and update routes reject ciphertext before calling the session manager', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
  const createRoute = indexSource.slice(
    indexSource.indexOf("app.post('/api/create-session'"),
    indexSource.indexOf("app.post('/api/update-session/:token'")
  );
  const updateRoute = indexSource.slice(
    indexSource.indexOf("app.post('/api/update-session/:token'"),
    indexSource.indexOf("app.get('/api/session-stats'")
  );

  assert.ok(createRoute.indexOf('findEncryptedSensitiveInputPaths(config)') >= 0);
  assert.ok(createRoute.indexOf('findEncryptedSensitiveInputPaths(config)')
    < createRoute.indexOf('sessionManager.createSession(config)'));
  assert.ok(updateRoute.indexOf('findEncryptedSensitiveInputPaths(config)') >= 0);
  assert.ok(updateRoute.indexOf('findEncryptedSensitiveInputPaths(config)')
    < updateRoute.indexOf('sessionManager.updateSession(token, config)'));
});

test('new integrity tags authenticate token, fingerprint, field placement, and ciphertext', () => {
  const token = '0123456789abcdef0123456789abcdef';
  const fingerprint = '0123456789abcdef';
  const encryptedConfig = {
    geminiApiKey: encrypt('fake-secret'),
    _encrypted: true
  };
  const integrity = computeIntegrityHash(token, fingerprint, encryptedConfig);

  assert.match(integrity, /^h1:[a-f0-9]{64}$/);
  assert.equal(verifyIntegrityHash(integrity, token, fingerprint, encryptedConfig), true);
  assert.equal(verifyIntegrityHash(integrity, token, fingerprint, {
    _encrypted: true,
    geminiApiKey: encryptedConfig.geminiApiKey
  }), true);
  assert.equal(verifyIntegrityHash(integrity, `f${token.slice(1)}`, fingerprint, encryptedConfig), false);
  assert.equal(verifyIntegrityHash(integrity, token, `f${fingerprint.slice(1)}`, encryptedConfig), false);
  assert.equal(verifyIntegrityHash(integrity, token, fingerprint, {
    ...encryptedConfig,
    geminiApiKey: encrypt('different-secret')
  }), false);
  assert.equal(verifyIntegrityHash(integrity, token, fingerprint, {
    providers: { gemini: { apiKey: encryptedConfig.geminiApiKey } },
    _encrypted: true
  }), false);
});

test('ordinary create, reordered storage, config save, and read stay compatible', async (t) => {
  let persisted = null;
  const fakeAdapter = {
    async createSession(key, value) {
      persisted = { key, value: structuredClone(value) };
      return { ok: true };
    },
    async set(key, value) {
      persisted = { key, value: structuredClone(value) };
      return true;
    },
    async updateSession(key, value) {
      persisted = { key, value: structuredClone(value) };
      return { ok: true };
    }
  };
  const previousAdapter = StorageFactory.instance;
  StorageFactory.instance = fakeAdapter;
  t.after(() => { StorageFactory.instance = previousAdapter; });

  const manager = Object.create(SessionManager.prototype);
  manager.cache = new Map();
  manager.decryptedCache = new Map();
  manager.failedLookups = new Map();
  manager.pendingPersistence = new Set();
  manager.storageCountCache = { value: 0, ts: 0 };
  manager.maxAge = 90 * 24 * 60 * 60 * 1000;
  manager.redisTtlEnabled = true;
  manager.storageMaxSessions = 100;
  manager.storageMaxBytes = 1024 * 1024;
  manager.dirty = false;
  manager.emit = () => true;
  manager._publishInvalidation = async () => {};

  const token = await manager.createSession({
    uiLanguage: 'en',
    geminiApiKey: 'ordinary-key'
  });
  const originalWrapper = manager.cache.get(token);
  assert.match(originalWrapper.integrity, /^[a-f0-9]{24}$/);
  assert.match(originalWrapper.integrityHmac, /^h1:[a-f0-9]{64}$/);
  assert.equal(
    originalWrapper.integrity,
    computeLegacyIntegrityHash(token, originalWrapper.fingerprint)
  );

  // JSON parsers and backup tools may preserve values while changing object
  // insertion order. Canonical HMAC serialization must not reject that.
  originalWrapper.config = Object.fromEntries(Object.entries(originalWrapper.config).reverse());
  manager.decryptedCache.clear();
  const afterReorder = await manager.getSession(token);
  assert.equal(afterReorder.geminiApiKey, 'ordinary-key');
  assert.equal(afterReorder.uiLanguage, 'en');

  const previousHmac = originalWrapper.integrityHmac;
  assert.equal(await manager.updateSession(token, {
    uiLanguage: 'pt-BR',
    geminiApiKey: 'ordinary-key'
  }), true);
  const updatedWrapper = manager.cache.get(token);
  assert.notEqual(updatedWrapper.integrityHmac, previousHmac);
  assert.match(updatedWrapper.integrity, /^[a-f0-9]{24}$/);
  assert.match(updatedWrapper.integrityHmac, /^h1:[a-f0-9]{64}$/);

  manager.decryptedCache.clear();
  const afterSave = await manager.getSession(token);
  assert.equal(afterSave.uiLanguage, 'pt-BR');
  assert.equal(afterSave.geminiApiKey, 'ordinary-key');
  assert.equal(persisted.key, token);

  let deleteAttempted = false;
  manager.deleteSession = () => { deleteAttempted = true; };
  const mismatchedWrapper = structuredClone(updatedWrapper);
  mismatchedWrapper.integrityHmac = `${mismatchedWrapper.integrityHmac.slice(0, -1)}${mismatchedWrapper.integrityHmac.endsWith('0') ? '1' : '0'}`;
  manager.cache.set(token, mismatchedWrapper);
  manager.decryptedCache.clear();
  assert.equal(await manager.getSession(token), null);
  assert.equal(deleteAttempted, false);

  await manager._flushPendingPersistence();
});

test('legacy integrity hashes remain readable without migration', () => {
  const token = '0123456789abcdef0123456789abcdef';
  const fingerprint = '0123456789abcdef';
  const legacyIntegrity = computeLegacyIntegrityHash(token, fingerprint);

  assert.match(legacyIntegrity, /^[a-f0-9]{24}$/);
  assert.equal(verifyIntegrityHash(
    legacyIntegrity,
    token,
    fingerprint,
    { geminiApiKey: 'legacy-ciphertext-object' }
  ), true);
  assert.equal(verifyIntegrityHash(
    legacyIntegrity,
    `f${token.slice(1)}`,
    fingerprint,
    { geminiApiKey: 'legacy-ciphertext-object' }
  ), false);
});
