(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.SubMakerConfigPageState = factory();
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function configHasSubToolboxEnabled(config) {
        return !!(config && (
            config.subToolboxEnabled === true
            || config.fileTranslationEnabled === true
            || config.syncSubtitlesEnabled === true
        ));
    }

    function getInitialConfigLoadPlan(options = {}) {
        const urlSessionToken = options.urlSessionToken || '';
        const persistentSessionToken = options.persistentSessionToken || '';
        const hasCachedConfig = options.hasCachedConfig === true;
        const intendedToken = urlSessionToken || persistentSessionToken || '';
        const hasExplicitUrlConfig = !!urlSessionToken;
        const shouldFetchSession = hasExplicitUrlConfig || (!hasCachedConfig && !!intendedToken);

        return {
            hasExplicitUrlConfig,
            intendedToken,
            shouldUseCachedConfig: hasCachedConfig && !hasExplicitUrlConfig,
            shouldFetchSession,
            fetchToken: shouldFetchSession ? intendedToken : '',
            isFirstRun: !hasCachedConfig && !intendedToken
        };
    }

    function resolveSaveTargetToken(options = {}) {
        const activeSessionToken = options.activeSessionToken || '';
        const activeProvenance = String(options.activeProvenance || '').toLowerCase();
        const urlSessionToken = options.urlSessionToken || '';
        const persistentSessionToken = options.persistentSessionToken || '';
        const isSessionToken = (token) => /^[a-f0-9]{32}$/.test(String(token || ''));

        if (isSessionToken(activeSessionToken)) {
            return activeSessionToken;
        }

        if (activeProvenance === 'draft' || activeProvenance === 'recovered') {
            return '';
        }

        if (isSessionToken(urlSessionToken)) {
            return urlSessionToken;
        }

        return isSessionToken(persistentSessionToken) ? persistentSessionToken : '';
    }

    function resolveVisibleInstallToken(options = {}) {
        const activeToken = String(options.activeToken || '').trim().toLowerCase();
        const revealedToken = String(options.revealedToken || '').trim().toLowerCase();
        const configDirty = options.configDirty === true;
        const isSessionToken = (token) => /^[a-f0-9]{32}$/.test(String(token || ''));

        if (configDirty) {
            return '';
        }
        if (!isSessionToken(activeToken)) {
            return '';
        }
        return activeToken === revealedToken ? activeToken : '';
    }

    function resolveSessionLoadFailurePlan(options = {}) {
        const loadedFromUrl = options.loadedFromUrl === true;
        const hasCachedFallback = options.hasCachedFallback === true;
        const sessionToken = options.sessionToken || '';
        const failureType = String(options.failureType || 'network').toLowerCase();

        if (failureType === 'missing' || failureType === 'regenerated') {
            return {
                keepActiveToken: false,
                clearStoredToken: true,
                configSource: hasCachedFallback ? 'cache' : 'fresh-default',
                context: {
                    token: '',
                    provenance: 'recovered',
                    sourceLabel: 'Recovered draft',
                    message: hasCachedFallback
                        ? 'The missing token was replaced with the last local copy until you save again.'
                        : (loadedFromUrl
                            ? 'The shared token could not be recovered. You are editing a fresh draft until you save again.'
                            : 'The saved token could not be recovered. You are editing a fresh draft until you save again.'),
                    recoveredFromToken: sessionToken,
                    regenerated: true
                }
            };
        }

        if (hasCachedFallback) {
            return {
                keepActiveToken: true,
                clearStoredToken: false,
                configSource: 'cache',
                context: {
                    token: sessionToken,
                    provenance: loadedFromUrl ? 'url' : 'local',
                    sourceLabel: loadedFromUrl ? 'Loaded from shared URL' : 'Loaded from this browser',
                    message: loadedFromUrl
                        ? 'This page is using the last local copy for the shared token until live metadata can be refreshed again.'
                        : 'This page is using the last local copy for your saved token until live metadata can be refreshed again.',
                    recoveredFromToken: '',
                    regenerated: false
                }
            };
        }

        return {
            keepActiveToken: false,
            clearStoredToken: false,
            configSource: 'fresh-default',
            context: {
                token: '',
                provenance: 'recovered',
                sourceLabel: 'Recovered draft',
                message: loadedFromUrl
                    ? 'The shared token could not be loaded. You are editing a fresh draft until you save again.'
                    : 'The saved token could not be loaded. You are editing a fresh draft until you save again.',
                recoveredFromToken: sessionToken,
                regenerated: false
            }
        };
    }

    function buildCurrentTokenExportEntry(options = {}) {
        const targetToken = String(options.targetToken || '').trim().toLowerCase();
        const isSessionToken = (token) => /^[a-f0-9]{32}$/.test(String(token || ''));
        if (!isSessionToken(targetToken)) {
            return null;
        }

        const entries = Array.isArray(options.entries) ? options.entries : [];
        const briefMap = options.briefMap && typeof options.briefMap === 'object' ? options.briefMap : {};
        const activeSessionToken = String(options.activeSessionToken || '').trim().toLowerCase();
        const activeSession = options.activeSession || null;
        const now = Number(options.now) || Date.now();
        const matchingEntry = entries.find(entry => String(entry?.token || '').trim().toLowerCase() === targetToken) || null;
        const brief = briefMap[targetToken] || (activeSessionToken === targetToken ? activeSession : null);

        return {
            token: targetToken,
            label: String(matchingEntry?.label || '').trim(),
            addedAt: Number(matchingEntry?.addedAt) || Number(brief?.createdAt) || now,
            lastOpenedAt: Number(matchingEntry?.lastOpenedAt) || (activeSessionToken === targetToken ? now : 0),
            lastSavedAt: Number(matchingEntry?.lastSavedAt) || Number(matchingEntry?.lastKnownUpdatedAt) || Number(brief?.updatedAt) || Number(brief?.createdAt) || now,
            lastKnownCreatedAt: Number(matchingEntry?.lastKnownCreatedAt) || Number(brief?.createdAt) || 0,
            lastKnownUpdatedAt: Number(matchingEntry?.lastKnownUpdatedAt) || Number(brief?.updatedAt) || 0,
            lastKnownLastAccessedAt: Number(matchingEntry?.lastKnownLastAccessedAt) || Number(brief?.lastAccessedAt) || 0,
            lastKnownDisabled: matchingEntry?.lastKnownDisabled === true || brief?.disabled === true
        };
    }

    function buildTokenVaultImportEntries(payload, options = {}) {
        const extractToken = typeof options.extractToken === 'function'
            ? options.extractToken
            : (value) => {
                const normalized = String(value || '').trim().toLowerCase();
                return /^[a-f0-9]{32}$/.test(normalized) ? normalized : '';
            };
        const normalizeLabel = typeof options.normalizeLabel === 'function'
            ? options.normalizeLabel
            : (_token, label) => String(label || '').trim();
        const now = Number(options.now) || Date.now();
        const importedEntries = Array.isArray(payload)
            ? payload
            : (Array.isArray(payload?.entries)
                ? payload.entries
                : [payload?.entry, payload?.profile, payload].filter(candidate => candidate && typeof candidate === 'object'));
        const prepared = [];
        const pushPreparedEntry = (entry) => {
            const token = extractToken(entry?.token || entry);
            if (!token) return;
            prepared.push({
                token,
                label: normalizeLabel(token, entry?.label || ''),
                addedAt: Number(entry?.addedAt) || now,
                lastOpenedAt: Number(entry?.lastOpenedAt) || 0,
                lastSavedAt: Number(entry?.lastSavedAt) || Number(entry?.lastKnownUpdatedAt) || now,
                lastKnownCreatedAt: Number(entry?.lastKnownCreatedAt) || 0,
                lastKnownUpdatedAt: Number(entry?.lastKnownUpdatedAt) || 0,
                lastKnownLastAccessedAt: Number(entry?.lastKnownLastAccessedAt) || 0,
                lastKnownDisabled: entry?.lastKnownDisabled === true
            });
        };

        importedEntries.forEach(pushPreparedEntry);

        if (prepared.length === 0 && !Array.isArray(payload)) {
            const activeToken = extractToken(payload?.activeToken);
            if (activeToken) {
                pushPreparedEntry({ token: activeToken });
            }
        }

        return prepared;
    }

    function buildFreshDraftConfig(options = {}) {
        const defaultConfig = options.defaultConfig && typeof options.defaultConfig === 'object'
            ? options.defaultConfig
            : {};
        const disableSubtitleProviders = options.disableSubtitleProviders === true;
        let freshConfig;

        try {
            freshConfig = typeof structuredClone === 'function'
                ? structuredClone(defaultConfig)
                : JSON.parse(JSON.stringify(defaultConfig));
        } catch (_) {
            freshConfig = { ...defaultConfig };
        }

        if (disableSubtitleProviders && freshConfig?.subtitleProviders && typeof freshConfig.subtitleProviders === 'object') {
            Object.keys(freshConfig.subtitleProviders).forEach((providerKey) => {
                const providerConfig = freshConfig.subtitleProviders[providerKey];
                if (!providerConfig || typeof providerConfig !== 'object') return;
                freshConfig.subtitleProviders[providerKey] = {
                    ...providerConfig,
                    enabled: false
                };
            });
        }

        return freshConfig;
    }

    function resolveTokenVaultSwitchPlan(options = {}) {
        const targetToken = String(options.targetToken || '').trim().toLowerCase();
        const activeToken = String(options.activeToken || '').trim().toLowerCase();
        const isDirty = options.isDirty === true;
        const isSessionToken = (token) => /^[a-f0-9]{32}$/.test(String(token || ''));

        if (!isSessionToken(targetToken)) {
            return { action: 'noop', targetToken: '' };
        }

        if (targetToken === activeToken) {
            return { action: 'noop', targetToken };
        }

        return {
            action: isDirty ? 'confirm-switch' : 'navigate',
            targetToken
        };
    }

    function resolveToolboxLauncherState(options = {}) {
        const tokenToCheck = options.tokenToCheck || '';
        if (!tokenToCheck) {
            return { visible: false, configRef: '' };
        }

        const activeToken = options.activeToken || '';
        const isActiveToken = tokenToCheck === activeToken;
        const cachedConfig = (options.cachedToken && options.cachedToken !== tokenToCheck)
            ? null
            : (options.cachedConfig || null);
        const effectiveConfig = isActiveToken ? (options.currentConfig || null) : cachedConfig;
        const visible = configHasSubToolboxEnabled(effectiveConfig) && options.tokenDisabled !== true;

        return {
            visible,
            configRef: visible ? tokenToCheck : ''
        };
    }

    function shouldRefreshTokenVaultBriefs(options = {}) {
        if (options.force === true) {
            return true;
        }

        const loaded = options.loaded === true;
        const tokensKey = String(options.tokensKey || '');
        const lastTokensKey = String(options.lastTokensKey || '');
        const maxAgeMs = Number.isFinite(options.maxAgeMs) && options.maxAgeMs >= 0
            ? options.maxAgeMs
            : 30 * 1000;
        const now = Number(options.now) || Date.now();
        const lastRefreshAt = Number(options.lastRefreshAt) || 0;

        if (!tokensKey) {
            return false;
        }
        if (!loaded) {
            return true;
        }
        if (tokensKey !== lastTokensKey) {
            return true;
        }
        return (now - lastRefreshAt) > maxAgeMs;
    }

    function shouldUseCachedTokenVaultBrief(options = {}) {
        const fetchedAt = Number(options.fetchedAt) || 0;
        const maxAgeMs = Number.isFinite(options.maxAgeMs) && options.maxAgeMs >= 0
            ? options.maxAgeMs
            : 30 * 1000;
        const now = Number(options.now) || Date.now();

        if (fetchedAt <= 0) {
            return false;
        }
        return (now - fetchedAt) <= maxAgeMs;
    }

    function normalizeBooleanStoragePreference(value) {
        const normalized = String(value || '').trim().toLowerCase();
        if (!normalized) {
            return '';
        }
        if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
            return 'true';
        }
        if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
            return 'false';
        }
        return '';
    }

    function resolveConfigInstructionsPreference(options = {}) {
        const canonicalRaw = String(options.canonicalValue || '').trim();
        const legacyRaw = String(options.legacyValue || '').trim();
        const canonicalState = normalizeBooleanStoragePreference(canonicalRaw);
        const legacyState = normalizeBooleanStoragePreference(legacyRaw);
        const suppressed = canonicalState === 'true' || (canonicalState !== 'true' && legacyState === 'true');

        return {
            suppressed,
            canonicalValue: suppressed ? 'true' : '',
            shouldWriteCanonical: suppressed && canonicalRaw !== 'true',
            shouldRemoveCanonical: !suppressed && canonicalRaw.length > 0,
            shouldRemoveLegacy: legacyRaw.length > 0
        };
    }

    function buildConfigInstructionsPreferenceWrite(options = {}) {
        const suppressed = options.suppressed === true;
        return {
            suppressed,
            canonicalValue: suppressed ? 'true' : '',
            shouldWriteCanonical: suppressed,
            shouldRemoveCanonical: !suppressed,
            shouldRemoveLegacy: true
        };
    }

    return {
        configHasSubToolboxEnabled,
        buildFreshDraftConfig,
        buildConfigInstructionsPreferenceWrite,
        buildCurrentTokenExportEntry,
        buildTokenVaultImportEntries,
        getInitialConfigLoadPlan,
        resolveConfigInstructionsPreference,
        resolveSessionLoadFailurePlan,
        resolveSaveTargetToken,
        resolveVisibleInstallToken,
        resolveTokenVaultSwitchPlan,
        resolveToolboxLauncherState,
        shouldRefreshTokenVaultBriefs,
        shouldUseCachedTokenVaultBrief
    };
}));
