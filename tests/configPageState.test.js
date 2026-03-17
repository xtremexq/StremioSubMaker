const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildConfigInstructionsPreferenceWrite,
  buildFreshDraftConfig,
  buildCurrentTokenExportEntry,
  buildTokenVaultImportEntries,
  configHasSubToolboxEnabled,
  getInitialConfigLoadPlan,
  resolveConfigInstructionsPreference,
  resolveSessionLoadFailurePlan,
  resolveSaveTargetToken,
  resolveVisibleInstallToken,
  resolveTokenVaultSwitchPlan,
  resolveToolboxLauncherState,
  shouldRefreshTokenVaultBriefs,
  shouldUseCachedTokenVaultBrief
} = require('../public/js/config-page-state');

const ACTIVE_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_TOKEN = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test('configHasSubToolboxEnabled respects unified and legacy toolbox flags', () => {
  assert.equal(configHasSubToolboxEnabled({ subToolboxEnabled: true }), true);
  assert.equal(configHasSubToolboxEnabled({ fileTranslationEnabled: true }), true);
  assert.equal(configHasSubToolboxEnabled({ syncSubtitlesEnabled: true }), true);
  assert.equal(configHasSubToolboxEnabled({ subToolboxEnabled: false, fileTranslationEnabled: false, syncSubtitlesEnabled: false }), false);
  assert.equal(configHasSubToolboxEnabled(null), false);
});

test('buildFreshDraftConfig returns a clean clone with subtitle providers disabled', () => {
  const defaults = {
    sourceLanguages: ['eng'],
    subtitleProviders: {
      opensubtitles: { enabled: true, implementationType: 'v3' },
      subdl: { enabled: true, apiKey: 'key' },
      wyzie: { enabled: false }
    }
  };

  const result = buildFreshDraftConfig({
    defaultConfig: defaults,
    disableSubtitleProviders: true
  });

  assert.notStrictEqual(result, defaults);
  assert.notStrictEqual(result.subtitleProviders, defaults.subtitleProviders);
  assert.deepEqual(result, {
    sourceLanguages: ['eng'],
    subtitleProviders: {
      opensubtitles: { enabled: false, implementationType: 'v3' },
      subdl: { enabled: false, apiKey: 'key' },
      wyzie: { enabled: false }
    }
  });
  assert.equal(defaults.subtitleProviders.opensubtitles.enabled, true);
});

test('resolveToolboxLauncherState uses the active loaded config when cache is empty', () => {
  const result = resolveToolboxLauncherState({
    tokenToCheck: ACTIVE_TOKEN,
    activeToken: ACTIVE_TOKEN,
    currentConfig: { subToolboxEnabled: true },
    cachedConfig: null,
    cachedToken: '',
    tokenDisabled: false
  });

  assert.deepEqual(result, {
    visible: true,
    configRef: ACTIVE_TOKEN
  });
});

test('resolveToolboxLauncherState hides the launcher for disabled active tokens', () => {
  const result = resolveToolboxLauncherState({
    tokenToCheck: ACTIVE_TOKEN,
    activeToken: ACTIVE_TOKEN,
    currentConfig: { subToolboxEnabled: true },
    cachedConfig: null,
    cachedToken: '',
    tokenDisabled: true
  });

  assert.deepEqual(result, {
    visible: false,
    configRef: ''
  });
});

test('resolveToolboxLauncherState ignores cached configs that belong to another token', () => {
  const result = resolveToolboxLauncherState({
    tokenToCheck: ACTIVE_TOKEN,
    activeToken: OTHER_TOKEN,
    currentConfig: { subToolboxEnabled: false },
    cachedConfig: { subToolboxEnabled: true },
    cachedToken: OTHER_TOKEN,
    tokenDisabled: false
  });

  assert.deepEqual(result, {
    visible: false,
    configRef: ''
  });
});

test('getInitialConfigLoadPlan fetches the stored token when cache is missing', () => {
  const result = getInitialConfigLoadPlan({
    urlSessionToken: '',
    persistentSessionToken: ACTIVE_TOKEN,
    hasCachedConfig: false
  });

  assert.deepEqual(result, {
    hasExplicitUrlConfig: false,
    intendedToken: ACTIVE_TOKEN,
    shouldUseCachedConfig: false,
    shouldFetchSession: true,
    fetchToken: ACTIVE_TOKEN,
    isFirstRun: false
  });
});

test('getInitialConfigLoadPlan prefers a live URL token over local cache state', () => {
  const result = getInitialConfigLoadPlan({
    urlSessionToken: ACTIVE_TOKEN,
    persistentSessionToken: OTHER_TOKEN,
    hasCachedConfig: true
  });

  assert.deepEqual(result, {
    hasExplicitUrlConfig: true,
    intendedToken: ACTIVE_TOKEN,
    shouldUseCachedConfig: false,
    shouldFetchSession: true,
    fetchToken: ACTIVE_TOKEN,
    isFirstRun: false
  });
});

test('getInitialConfigLoadPlan marks true first-run state only when no token exists anywhere', () => {
  const result = getInitialConfigLoadPlan({
    urlSessionToken: '',
    persistentSessionToken: '',
    hasCachedConfig: false
  });

  assert.deepEqual(result, {
    hasExplicitUrlConfig: false,
    intendedToken: '',
    shouldUseCachedConfig: false,
    shouldFetchSession: false,
    fetchToken: '',
    isFirstRun: true
  });
});

test('resolveSaveTargetToken prefers the active page token over stale browser storage', () => {
  const result = resolveSaveTargetToken({
    activeSessionToken: ACTIVE_TOKEN,
    activeProvenance: 'url',
    persistentSessionToken: OTHER_TOKEN
  });

  assert.equal(result, ACTIVE_TOKEN);
});

test('resolveSaveTargetToken keeps recovered drafts detached from old stored tokens', () => {
  const result = resolveSaveTargetToken({
    activeSessionToken: '',
    activeProvenance: 'recovered',
    urlSessionToken: ACTIVE_TOKEN,
    persistentSessionToken: OTHER_TOKEN
  });

  assert.equal(result, '');
});

test('resolveSaveTargetToken falls back to the explicit URL token before local storage', () => {
  const result = resolveSaveTargetToken({
    activeSessionToken: '',
    activeProvenance: 'local',
    urlSessionToken: ACTIVE_TOKEN,
    persistentSessionToken: OTHER_TOKEN
  });

  assert.equal(result, ACTIVE_TOKEN);
});

test('resolveVisibleInstallToken stays hidden until a token was explicitly revealed', () => {
  const result = resolveVisibleInstallToken({
    activeToken: ACTIVE_TOKEN,
    revealedToken: '',
    configDirty: false
  });

  assert.equal(result, '');
});

test('resolveVisibleInstallToken keeps the install UI visible for the revealed active token', () => {
  const result = resolveVisibleInstallToken({
    activeToken: ACTIVE_TOKEN,
    revealedToken: ACTIVE_TOKEN,
    configDirty: false
  });

  assert.equal(result, ACTIVE_TOKEN);
});

test('resolveVisibleInstallToken hides the install UI again once the form is dirty', () => {
  const result = resolveVisibleInstallToken({
    activeToken: ACTIVE_TOKEN,
    revealedToken: ACTIVE_TOKEN,
    configDirty: true
  });

  assert.equal(result, '');
});

test('resolveVisibleInstallToken clears visibility when the active token changes', () => {
  const result = resolveVisibleInstallToken({
    activeToken: OTHER_TOKEN,
    revealedToken: ACTIVE_TOKEN,
    configDirty: false
  });

  assert.equal(result, '');
});

test('resolveSessionLoadFailurePlan keeps the live token when cached data exists for a transient failure', () => {
  const result = resolveSessionLoadFailurePlan({
    loadedFromUrl: true,
    hasCachedFallback: true,
    sessionToken: ACTIVE_TOKEN,
    failureType: 'network'
  });

  assert.deepEqual(result, {
    keepActiveToken: true,
    clearStoredToken: false,
    configSource: 'cache',
    context: {
      token: ACTIVE_TOKEN,
      provenance: 'url',
      sourceLabel: 'Loaded from shared URL',
      message: 'This page is using the last local copy for the shared token until live metadata can be refreshed again.',
      recoveredFromToken: '',
      regenerated: false
    }
  });
});

test('resolveSessionLoadFailurePlan detaches to a recovered draft when the token is missing', () => {
  const result = resolveSessionLoadFailurePlan({
    loadedFromUrl: false,
    hasCachedFallback: false,
    sessionToken: ACTIVE_TOKEN,
    failureType: 'missing'
  });

  assert.deepEqual(result, {
    keepActiveToken: false,
    clearStoredToken: true,
    configSource: 'fresh-default',
    context: {
      token: '',
      provenance: 'recovered',
      sourceLabel: 'Recovered draft',
      message: 'The saved token could not be recovered. You are editing a fresh draft until you save again.',
      recoveredFromToken: ACTIVE_TOKEN,
      regenerated: true
    }
  });
});

test('buildCurrentTokenExportEntry synthesizes an export for a live token not stored in the vault', () => {
  const now = 1234567890;
  const result = buildCurrentTokenExportEntry({
    targetToken: ACTIVE_TOKEN,
    entries: [],
    briefMap: {},
    activeSessionToken: ACTIVE_TOKEN,
    activeSession: {
      createdAt: 100,
      updatedAt: 200,
      lastAccessedAt: 300,
      disabled: false
    },
    now
  });

  assert.deepEqual(result, {
    token: ACTIVE_TOKEN,
    label: '',
    addedAt: 100,
    lastOpenedAt: now,
    lastSavedAt: 200,
    lastKnownCreatedAt: 100,
    lastKnownUpdatedAt: 200,
    lastKnownLastAccessedAt: 300,
    lastKnownDisabled: false
  });
});

test('buildTokenVaultImportEntries imports wrapped vault exports', () => {
  const now = 1234567890;
  const result = buildTokenVaultImportEntries({
    entries: [
      {
        token: ACTIVE_TOKEN,
        label: ' Main profile ',
        addedAt: 100,
        lastOpenedAt: 200,
        lastSavedAt: 300
      },
      {
        token: OTHER_TOKEN,
        label: '',
        lastKnownUpdatedAt: 444,
        lastKnownDisabled: true
      }
    ]
  }, { now });

  assert.deepEqual(result, [
    {
      token: ACTIVE_TOKEN,
      label: 'Main profile',
      addedAt: 100,
      lastOpenedAt: 200,
      lastSavedAt: 300,
      lastKnownCreatedAt: 0,
      lastKnownUpdatedAt: 0,
      lastKnownLastAccessedAt: 0,
      lastKnownDisabled: false
    },
    {
      token: OTHER_TOKEN,
      label: '',
      addedAt: now,
      lastOpenedAt: 0,
      lastSavedAt: 444,
      lastKnownCreatedAt: 0,
      lastKnownUpdatedAt: 444,
      lastKnownLastAccessedAt: 0,
      lastKnownDisabled: true
    }
  ]);
});

test('buildTokenVaultImportEntries imports a direct single-profile payload', () => {
  const now = 1234567890;
  const result = buildTokenVaultImportEntries({
    token: ACTIVE_TOKEN,
    label: ' Profile One '
  }, { now });

  assert.deepEqual(result, [
    {
      token: ACTIVE_TOKEN,
      label: 'Profile One',
      addedAt: now,
      lastOpenedAt: 0,
      lastSavedAt: now,
      lastKnownCreatedAt: 0,
      lastKnownUpdatedAt: 0,
      lastKnownLastAccessedAt: 0,
      lastKnownDisabled: false
    }
  ]);
});

test('resolveTokenVaultSwitchPlan requires confirmation when switching away with unsaved changes', () => {
  const result = resolveTokenVaultSwitchPlan({
    targetToken: OTHER_TOKEN,
    activeToken: ACTIVE_TOKEN,
    isDirty: true
  });

  assert.deepEqual(result, {
    action: 'confirm-switch',
    targetToken: OTHER_TOKEN
  });
});

test('resolveTokenVaultSwitchPlan navigates immediately when the page is clean', () => {
  const result = resolveTokenVaultSwitchPlan({
    targetToken: OTHER_TOKEN,
    activeToken: ACTIVE_TOKEN,
    isDirty: false
  });

  assert.deepEqual(result, {
    action: 'navigate',
    targetToken: OTHER_TOKEN
  });
});

test('shouldRefreshTokenVaultBriefs reuses fresh cached batches for the same token set', () => {
  assert.equal(shouldRefreshTokenVaultBriefs({
    loaded: true,
    tokensKey: `${ACTIVE_TOKEN},${OTHER_TOKEN}`,
    lastTokensKey: `${ACTIVE_TOKEN},${OTHER_TOKEN}`,
    lastRefreshAt: 1000,
    now: 25_000,
    maxAgeMs: 30_000
  }), false);
});

test('shouldRefreshTokenVaultBriefs refreshes when the token set changes or the cache is stale', () => {
  assert.equal(shouldRefreshTokenVaultBriefs({
    loaded: true,
    tokensKey: `${ACTIVE_TOKEN},${OTHER_TOKEN}`,
    lastTokensKey: ACTIVE_TOKEN,
    lastRefreshAt: 1_000,
    now: 5_000,
    maxAgeMs: 30_000
  }), true);

  assert.equal(shouldRefreshTokenVaultBriefs({
    loaded: true,
    tokensKey: ACTIVE_TOKEN,
    lastTokensKey: ACTIVE_TOKEN,
    lastRefreshAt: 1_000,
    now: 40_500,
    maxAgeMs: 30_000
  }), true);
});

test('shouldUseCachedTokenVaultBrief keeps recently fetched single-token lookups hot', () => {
  assert.equal(shouldUseCachedTokenVaultBrief({
    fetchedAt: 10_000,
    now: 35_000,
    maxAgeMs: 30_000
  }), true);

  assert.equal(shouldUseCachedTokenVaultBrief({
    fetchedAt: 10_000,
    now: 45_001,
    maxAgeMs: 30_000
  }), false);
});

test('resolveConfigInstructionsPreference honors the canonical suppression key', () => {
  const result = resolveConfigInstructionsPreference({
    canonicalValue: 'true',
    legacyValue: ''
  });

  assert.deepEqual(result, {
    suppressed: true,
    canonicalValue: 'true',
    shouldWriteCanonical: false,
    shouldRemoveCanonical: false,
    shouldRemoveLegacy: false
  });
});

test('resolveConfigInstructionsPreference migrates legacy suppression to the canonical key', () => {
  const result = resolveConfigInstructionsPreference({
    canonicalValue: '',
    legacyValue: '1'
  });

  assert.deepEqual(result, {
    suppressed: true,
    canonicalValue: 'true',
    shouldWriteCanonical: true,
    shouldRemoveCanonical: false,
    shouldRemoveLegacy: true
  });
});

test('resolveConfigInstructionsPreference clears stale stored values when suppression is off', () => {
  const result = resolveConfigInstructionsPreference({
    canonicalValue: 'false',
    legacyValue: ''
  });

  assert.deepEqual(result, {
    suppressed: false,
    canonicalValue: '',
    shouldWriteCanonical: false,
    shouldRemoveCanonical: true,
    shouldRemoveLegacy: false
  });
});

test('buildConfigInstructionsPreferenceWrite supports toggling suppression off and on', () => {
  assert.deepEqual(buildConfigInstructionsPreferenceWrite({ suppressed: true }), {
    suppressed: true,
    canonicalValue: 'true',
    shouldWriteCanonical: true,
    shouldRemoveCanonical: false,
    shouldRemoveLegacy: true
  });

  assert.deepEqual(buildConfigInstructionsPreferenceWrite({ suppressed: false }), {
    suppressed: false,
    canonicalValue: '',
    shouldWriteCanonical: false,
    shouldRemoveCanonical: true,
    shouldRemoveLegacy: true
  });
});
