// Configuration page JavaScript - Modern Edition
(function () {
    'use strict';

    const DEFAULT_LOCALE = { lang: 'en', messages: {} };
    const RTL_LANGS = new Set(['ar', 'he', 'fa', 'ur']);
    const UI_LANGUAGE_STORAGE_KEY = 'submaker_ui_language';
    const FLOATING_BOTTOM_SAFE_ZONE_SELECTOR = '#configHelp, #subToolboxLauncher, #tokenVaultLauncher, #tokenVaultRail.show';
    let locale = DEFAULT_LOCALE;
    let localeReadyPromise = null; // Track when locale is ready

    function bootstrapTranslator(payload) {
        try {
            locale = payload || DEFAULT_LOCALE;
            window.__LOCALE__ = locale;
            window.t = function (key, vars, fallback) {
                vars = vars || {};
                if (!key) return fallback || key;
                const parts = String(key).split('.');
                let current = (locale && locale.messages) || {};
                for (let i = 0; i < parts.length; i++) {
                    if (current && Object.prototype.hasOwnProperty.call(current, parts[i])) {
                        current = current[parts[i]];
                    } else {
                        current = null;
                        break;
                    }
                }
                const template = (typeof current === 'string' && current) || fallback || key;
                return String(template).replace(/\{(\w+)\}/g, (match, k) => Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : match);
            };
            if (document && document.documentElement) {
                document.documentElement.lang = locale.lang || 'en';
                const langBase = (locale.lang || '').split('-')[0];
                const isRtl = RTL_LANGS.has(langBase);
                document.documentElement.dir = isRtl ? 'rtl' : 'ltr';
                document.documentElement.classList.toggle('rtl', isRtl);
            }
        } catch (_) {
            locale = DEFAULT_LOCALE;
        }
    }

    async function initLocale(langOverride) {
        try {
            const url = new URL(window.location.href);
            const configParam = url.searchParams.get('config');
            let langParam = langOverride || url.searchParams.get('lang');
            if (!langParam) {
                try {
                    const stored = localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
                    if (stored) langParam = stored;
                } catch (_) { }
            }
            const query = [];
            if (configParam) query.push('config=' + encodeURIComponent(configParam));
            if (langParam) query.push('lang=' + encodeURIComponent(langParam));
            const resp = await fetch('/api/locale' + (query.length ? ('?' + query.join('&')) : ''), { cache: 'no-store' });
            const data = await resp.json();
            bootstrapTranslator(data || DEFAULT_LOCALE);
            applyUiLanguageCopy();
            applyStaticCopy();
            notifyLocaleUpdated();
        } catch (err) {
            console.warn('[i18n] Failed to load locale, falling back to English', err);
            bootstrapTranslator(DEFAULT_LOCALE);
            applyUiLanguageCopy();
            applyStaticCopy();
            notifyLocaleUpdated();
        }
    }
    localeReadyPromise = initLocale();

    function notifyLocaleUpdated() {
        try {
            window.dispatchEvent(new CustomEvent('submaker:locale-updated'));
        } catch (_) { }
    }

    function tConfig(key, vars = {}, fallback = '') {
        try {
            if (typeof window.t === 'function') return window.t(key, vars, fallback || key);
        } catch (_) { }
        return fallback || key;
    }

    function setText(id, key, fallback) {
        const el = typeof id === 'string' ? document.getElementById(id) : id;
        if (!el) return;
        const value = tConfig(key, {}, fallback || el.textContent || '');
        // Skip update if translation returned the raw key (prevents showing i18n keys)
        if (value === key) return;
        el.textContent = value;
    }

    function setAttr(id, attr, key, fallback) {
        const el = typeof id === 'string' ? document.getElementById(id) : id;
        if (!el) return;
        const current = el.getAttribute(attr) || '';
        const value = tConfig(key, {}, fallback || current || '');
        // Skip update if translation returned the raw key (prevents showing i18n keys)
        if (value === key) return;
        el.setAttribute(attr, value);
    }

    function applyDataI18n() {
        try {
            const nodes = document.querySelectorAll('[data-i18n]');
            nodes.forEach(node => {
                const key = node.getAttribute('data-i18n');
                if (!key) return;
                const attr = node.getAttribute('data-i18n-attr');
                const fallbackAttr = node.getAttribute('data-i18n-fallback');
                // Accept comma or whitespace separated attribute lists and drop anything invalid to avoid DOM errors
                const rawAttrList = (attr || '')
                    .split(',')
                    .map(part => part.split(/\s+/))
                    .flat()
                    .map(a => a.trim())
                    .filter(Boolean);
                const attrList = rawAttrList.filter(name => /^[A-Za-z_][\w.\-:]*$/.test(name));
                const fallback = fallbackAttr || (attrList.length ? node.getAttribute(attrList[0]) : node.textContent);
                const varsAttr = node.getAttribute('data-i18n-vars');
                let vars = {};
                if (varsAttr) {
                    try {
                        vars = JSON.parse(varsAttr);
                    } catch (_) {
                        vars = {};
                    }
                }
                const value = tConfig(key, vars, fallback || '');
                // IMPORTANT: If translation returned the raw key (translation not loaded yet or missing),
                // skip the update to prevent showing i18n keys to the user
                if (value === key) {
                    return;
                }
                if (attrList.includes('innerHTML')) {
                    node.innerHTML = value;
                } else if (attrList.length > 0) {
                    attrList.forEach(name => {
                        try {
                            node.setAttribute(name, value);
                        } catch (attrErr) {
                            console.warn('[i18n] Skipping invalid data-i18n-attr', name, attrErr);
                        }
                    });
                } else {
                    node.textContent = value;
                }
            });
        } catch (err) {
            console.warn('[i18n] Failed to apply data-i18n copy', err);
        }
    }

    function refreshComboboxTranslations() {
        try {
            const selects = document.querySelectorAll('select.combo-hidden-select');
            selects.forEach(select => {
                const wrapper = select.parentElement;
                const state = wrapper && wrapper.__comboState;
                if (state && typeof state.rebuild === 'function') {
                    state.rebuild();
                }
                if (state && typeof state.sync === 'function') {
                    state.sync();
                }
            });
        } catch (err) {
            console.warn('[i18n] Failed to refresh combo translations', err);
        }
    }

    function setDescriptionWithLink(id, textKey, linkKey, fallbackText) {
        const wrapper = document.getElementById(id);
        if (!wrapper) return;
        const link = wrapper.querySelector('a');
        const linkHref = link ? link.getAttribute('href') : '';
        const linkColor = link ? link.style.color : '';
        const linkTarget = link ? link.getAttribute('target') : '';
        const linkText = link ? link.textContent : '';
        const translatedLink = tConfig(linkKey, {}, linkText || '');
        const translatedText = tConfig(textKey, {}, fallbackText || wrapper.textContent || '');
        wrapper.textContent = translatedText + (translatedText ? ' ' : '');
        if (link) {
            link.textContent = translatedLink;
            if (linkHref) link.href = linkHref;
            if (linkTarget) link.target = linkTarget;
            if (linkColor) link.style.color = linkColor;
            wrapper.appendChild(link);
        }
    }

    function setLanguagesSectionDescriptionKey(key, fallback) {
        const el = document.getElementById('languagesSectionDescription');
        if (!el) return;
        el.textContent = tConfig(key, {}, fallback || el.textContent || '');
    }

    function applyStaticCopy() {
        try {
            document.title = tConfig('config.documentTitle', {}, document.title || 'SubMaker - Configure');
        } catch (_) { }
        setAttr('uiLanguageDock', 'aria-label', 'config.uiLanguageAria', 'UI language');
        setAttr('uiLanguageDock', 'title', 'config.uiLanguageAria', 'UI language');
        setText('heroTitle', 'config.heroTitle', 'SubMaker');
        setText('heroSubtitle', 'config.heroSubtitle', 'AI-Powered Subtitle Translation');
        setAttr('subToolboxLauncher', 'title', 'config.actions.openToolbox', 'Open Sub Toolbox');
        setAttr('subToolboxLauncher', 'aria-label', 'config.actions.openToolbox', 'Open Sub Toolbox');
        setAttr('configHelp', 'title', 'config.quickActionHelp', 'Help');
        setText('apiKeysSectionTitle', 'config.sections.apiKeysTitle', 'API Keys');
        setText('apiKeysSectionDescription', 'config.sections.apiKeysDescription', 'Add and validate your keys for subtitle providers and translation services.');
        setText('languagesSectionTitle', 'config.sections.languagesTitle', 'Languages');
        setText('languagesSectionDescription', 'config.sections.languagesDescription', 'Choose your source and target languages for fetching and translations.');
        setText('settingsSectionTitle', 'config.sections.settingsTitle', 'Settings');
        setText('settingsSectionDescription', 'config.sections.settingsDescription', 'Adjust translation behavior and other preferences.');
        setText('noTranslationTitle', 'config.noTranslation.title', 'Just Fetch Subtitles (No Translation)');
        setText('noTranslationDescription', 'config.noTranslation.description', 'Skip AI translation and just fetch subtitles in your chosen languages');
        setText('subtitleApiTitle', 'config.sections.subtitleApiTitle', 'Subtitles API Keys');
        setText('opensubsImplDescription', 'config.opensubs.implDescription', 'Choose your preferred OpenSubtitles implementation.');
        setText('opensubsImplTypeLabel', 'config.opensubs.implementationType', 'Implementation Type');
        setText('opensubsV3Title', 'config.opensubs.v3Title', 'V3 (Default)');
        setText('opensubsV3Tooltip', 'config.opensubs.v3Tooltip', "V3 doesn't show all OpenSubtitles results and rate-limiting may apply.");
        setText('opensubsV3Description', 'config.opensubs.v3Description', 'Uses the official Stremio OpenSubtitles V3 addon. No authentication required, simple setup.');
        setText('opensubsAuthTitle', 'config.opensubs.authTitle', 'Auth (Recommended)');
        setDescriptionWithLink(
            'opensubsAuthDescription',
            'config.opensubs.authDescription',
            'config.opensubs.authLink',
            'Uses your OpenSubtitles.com account. Requires username/password.',
        );
        setText('opensubsUsernameLabel', 'config.opensubs.usernameLabel', 'Username');
        setText('opensubsPasswordLabel', 'config.opensubs.passwordLabel', 'Password');

        setAttr('toggleOpenSubsPassword', 'title', 'config.opensubs.showHidePassword', 'Show/hide password');
        setAttr('validateOpenSubtitles', 'title', 'config.opensubs.validateTitle', 'Validate OpenSubtitles credentials');
        const validateBtn = document.getElementById('validateOpenSubtitles');
        if (validateBtn) {
            const textEl = validateBtn.querySelector('.validate-text');
            if (textEl) setText(textEl, 'config.opensubs.validateCta', 'Run Test');
        }
        setText('subsourceTitle', 'config.providers.subsource.title', 'SubSource');
        setDescriptionWithLink('subsourceDescription', 'config.providers.subsource.description', 'config.providers.subsource.linkLabel', 'Get your free API key from');
        setText('subdlTitle', 'config.providers.subdl.title', 'SubDL');
        setDescriptionWithLink('subdlDescription', 'config.providers.subdl.description', 'config.providers.subdl.linkLabel', 'Get your free API key from');
        setDescriptionWithLink('geminiApiHelper', 'config.gemini.apiKey.helper', 'config.gemini.apiKey.linkLabel', 'Get your free API key from');
        setText('sourceLanguagesError', 'config.validation.sourceRequired', 'Please select at least one source language');
        setText('targetLanguagesError', 'config.validation.targetRequired', 'Please select at least one target language');
        setText('learnLanguagesError', 'config.validation.learnRequired', 'Please select at least one learn language');
        applyDataI18n();
        refreshComboboxTranslations();
        // Reapply any dynamic copy that depends on runtime values (e.g., language limits)
        try { updateLanguageLimitCopy(); } catch (_) { }
    }

    // If partials finished loading after config.js executed (e.g., slow fetch/timeout path),
    // re-apply translations once they are ready so late-inserted nodes get translated too.
    // IMPORTANT: We must also wait for the locale to be ready to prevent showing raw i18n keys.
    let partialCopyApplied = false;
    function applyCopyAfterPartials() {
        if (partialCopyApplied) return;
        const partialsReady = (typeof window !== 'undefined' && (window.partialsReady || window.mainPartialReady));
        // Build an array of promises to wait for
        const waitFor = [];
        if (partialsReady && typeof partialsReady.then === 'function') {
            waitFor.push(partialsReady);
        }
        if (localeReadyPromise && typeof localeReadyPromise.then === 'function') {
            waitFor.push(localeReadyPromise);
        }
        if (waitFor.length === 0) return;
        // Wait for BOTH partials and locale to be ready before applying translations
        Promise.all(waitFor).then(() => {
            if (partialCopyApplied) return;
            partialCopyApplied = true;
            try {
                applyUiLanguageCopy();
                applyStaticCopy();
            } catch (err) {
                console.warn('[i18n] Failed to reapply copy after partials', err);
            }
        }).catch(() => { });
    }
    applyCopyAfterPartials();

    /**
     * Default API Keys Configuration
     *
     * This is the centralized location for all default API keys in the frontend.
     * To remove or update API keys, simply modify this object.
     *
     * IMPORTANT: These are default fallback keys. Users should provide their own keys.
     *
     * NOTE: OpenSubtitles uses username/password authentication only (no API keys)
     */
    const DEFAULT_API_KEYS = {
        // Do not ship real keys in the client bundle
        SUBDL: '',
        SUBSOURCE: '',
        GEMINI: '',
        ASSEMBLYAI: '',
        CF_WORKERS_AUTOSUBS: ''
    };

    // Popular languages for quick selection
    const POPULAR_LANGUAGES = ['eng', 'spa', 'fre', 'ger', 'por', 'pob', 'ita', 'rus', 'jpn', 'kor', 'chi', 'ara'];
    let translationModeBackup = null;
    let noTranslationBackup = null;

    // Language selection limits (defaults, can be overridden by server-provided env values)
    const DEFAULT_LIMITS = {
        maxSourceLanguages: 3,
        maxTargetLanguages: 6,
        maxNoTranslationLanguages: 9
    };
    let uiLanguageExpanded = false;
    const SUPPORTED_UI_LANGUAGES = [
        {
            value: 'en',
            labelKey: 'config.uiLanguages.en.label',
            flagKey: 'config.uiLanguages.en.flag',
            fallbackLabel: 'English',
            fallbackFlag: 'US'
        },
        {
            value: 'es',
            labelKey: 'config.uiLanguages.es.label',
            flagKey: 'config.uiLanguages.es.flag',
            fallbackLabel: 'Spanish',
            fallbackFlag: 'ES'
        },
        {
            value: 'pt-br',
            labelKey: 'config.uiLanguages.pt-br.label',
            flagKey: 'config.uiLanguages.pt-br.flag',
            fallbackLabel: 'Portuguese (Brazil)',
            fallbackFlag: 'BR'
        },
        {
            value: 'pt-pt',
            labelKey: 'config.uiLanguages.pt-pt.label',
            flagKey: 'config.uiLanguages.pt-pt.flag',
            fallbackLabel: 'Portuguese (Portugal)',
            fallbackFlag: 'PT'
        },
        {
            value: 'ar',
            labelKey: 'config.uiLanguages.ar.label',
            flagKey: 'config.uiLanguages.ar.flag',
            fallbackLabel: 'Arabic',
            fallbackFlag: 'SA'
        }
    ];
    const KEY_OPTIONAL_PROVIDERS = new Set(['googletranslate', 'custom']);
    const configPageState = (typeof window !== 'undefined' && window.SubMakerConfigPageState)
        ? window.SubMakerConfigPageState
        : null;

    function configHasSubToolboxEnabled(config) {
        if (configPageState && typeof configPageState.configHasSubToolboxEnabled === 'function') {
            return configPageState.configHasSubToolboxEnabled(config);
        }
        return !!(config && (
            config.subToolboxEnabled === true
            || config.fileTranslationEnabled === true
            || config.syncSubtitlesEnabled === true
        ));
    }

    function getInitialConfigLoadPlan(options = {}) {
        if (configPageState && typeof configPageState.getInitialConfigLoadPlan === 'function') {
            return configPageState.getInitialConfigLoadPlan(options);
        }
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
        if (configPageState && typeof configPageState.resolveSaveTargetToken === 'function') {
            return configPageState.resolveSaveTargetToken(options);
        }
        const activeSessionToken = options.activeSessionToken || '';
        const activeProvenance = String(options.activeProvenance || '').toLowerCase();
        const urlSessionToken = options.urlSessionToken || '';
        const persistentSessionToken = options.persistentSessionToken || '';

        if (isValidSessionToken(activeSessionToken)) {
            return activeSessionToken;
        }
        if (activeProvenance === 'draft' || activeProvenance === 'recovered') {
            return '';
        }
        if (isValidSessionToken(urlSessionToken)) {
            return urlSessionToken;
        }
        return isValidSessionToken(persistentSessionToken) ? persistentSessionToken : '';
    }

    function resolveVisibleInstallToken(options = {}) {
        if (configPageState && typeof configPageState.resolveVisibleInstallToken === 'function') {
            return configPageState.resolveVisibleInstallToken(options);
        }
        const activeToken = String(options.activeToken || '').trim().toLowerCase();
        const revealedToken = String(options.revealedToken || '').trim().toLowerCase();
        const configDirty = options.configDirty === true;

        if (configDirty) {
            return '';
        }
        if (!isValidSessionToken(activeToken)) {
            return '';
        }
        return activeToken === revealedToken ? activeToken : '';
    }

    function resolveSessionLoadFailurePlan(options = {}) {
        if (configPageState && typeof configPageState.resolveSessionLoadFailurePlan === 'function') {
            return configPageState.resolveSessionLoadFailurePlan(options);
        }
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
        if (configPageState && typeof configPageState.buildCurrentTokenExportEntry === 'function') {
            return configPageState.buildCurrentTokenExportEntry(options);
        }
        const targetToken = String(options.targetToken || '').trim().toLowerCase();
        if (!isValidSessionToken(targetToken)) {
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

    function buildFreshDraftConfig(options = {}) {
        if (configPageState && typeof configPageState.buildFreshDraftConfig === 'function') {
            return configPageState.buildFreshDraftConfig(options);
        }
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
        if (configPageState && typeof configPageState.resolveTokenVaultSwitchPlan === 'function') {
            return configPageState.resolveTokenVaultSwitchPlan(options);
        }
        const targetToken = String(options.targetToken || '').trim().toLowerCase();
        const activeToken = String(options.activeToken || '').trim().toLowerCase();
        const isDirty = options.isDirty === true;

        if (!isValidSessionToken(targetToken)) {
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
        if (configPageState && typeof configPageState.resolveToolboxLauncherState === 'function') {
            return configPageState.resolveToolboxLauncherState(options);
        }
        const tokenToCheck = options.tokenToCheck || '';
        if (!tokenToCheck) {
            return { visible: false, configRef: '' };
        }
        const isActiveToken = tokenToCheck === (options.activeToken || '');
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
        if (configPageState && typeof configPageState.shouldRefreshTokenVaultBriefs === 'function') {
            return configPageState.shouldRefreshTokenVaultBriefs(options);
        }
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

        if (!tokensKey) return false;
        if (!loaded) return true;
        if (tokensKey !== lastTokensKey) return true;
        return (now - lastRefreshAt) > maxAgeMs;
    }

    function shouldUseCachedTokenVaultBrief(options = {}) {
        if (configPageState && typeof configPageState.shouldUseCachedTokenVaultBrief === 'function') {
            return configPageState.shouldUseCachedTokenVaultBrief(options);
        }
        const fetchedAt = Number(options.fetchedAt) || 0;
        const maxAgeMs = Number.isFinite(options.maxAgeMs) && options.maxAgeMs >= 0
            ? options.maxAgeMs
            : 30 * 1000;
        const now = Number(options.now) || Date.now();

        if (fetchedAt <= 0) return false;
        return (now - fetchedAt) <= maxAgeMs;
    }

    function resolveConfigInstructionsPreference(options = {}) {
        if (configPageState && typeof configPageState.resolveConfigInstructionsPreference === 'function') {
            return configPageState.resolveConfigInstructionsPreference(options);
        }
        const normalize = (value) => {
            const normalized = String(value || '').trim().toLowerCase();
            if (!normalized) return '';
            if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return 'true';
            if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return 'false';
            return '';
        };
        const canonicalRaw = String(options.canonicalValue || '').trim();
        const legacyRaw = String(options.legacyValue || '').trim();
        const canonicalState = normalize(canonicalRaw);
        const legacyState = normalize(legacyRaw);
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
        if (configPageState && typeof configPageState.buildConfigInstructionsPreferenceWrite === 'function') {
            return configPageState.buildConfigInstructionsPreferenceWrite(options);
        }
        const suppressed = options.suppressed === true;
        return {
            suppressed,
            canonicalValue: suppressed ? 'true' : '',
            shouldWriteCanonical: suppressed,
            shouldRemoveCanonical: !suppressed,
            shouldRemoveLegacy: true
        };
    }

    function parseLimit(value, fallback, min = 1, max = 50) {
        const parsed = parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed >= min) {
            return Math.min(parsed, max);
        }
        return fallback;
    }

    function getPreferredUiLanguage() {
        try {
            const stored = localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
            if (stored) return stored.toLowerCase();
        } catch (_) { }
        return (navigator.language || 'en').toLowerCase();
    }

    function toFlagEmoji(raw) {
        const candidate = (raw || '').toString().trim();
        if (/^[a-z]{2}$/i.test(candidate)) {
            const base = 127397;
            return String.fromCodePoint(candidate[0].toUpperCase().charCodeAt(0) + base, candidate[1].toUpperCase().charCodeAt(0) + base);
        }
        return '';
    }

    function resolveUiLanguageMeta(entry) {
        if (!entry) return null;
        const codeLabelMap = {
            'en': 'EN',
            'es': 'ES',
            'pt-br': 'BR',
            'pt-pt': 'PT',
            'ar': 'AR'
        };
        const label = codeLabelMap[entry.value] || entry.value.toUpperCase();
        const translatedFlag = tConfig(entry.flagKey, {}, entry.fallbackFlag || entry.value.toUpperCase());
        const emojiFlag = toFlagEmoji(translatedFlag) || toFlagEmoji(entry.fallbackFlag) || translatedFlag || entry.fallbackFlag || entry.value.toUpperCase();
        return {
            ...entry,
            label,
            flag: emojiFlag
        };
    }

    function getUiLanguageMeta(lang) {
        const normalized = (lang || '').toString().toLowerCase();
        const exact = SUPPORTED_UI_LANGUAGES.find(l => l.value === normalized);
        if (exact) return resolveUiLanguageMeta(exact);
        const base = normalized.split('-')[0];
        const fallback = SUPPORTED_UI_LANGUAGES.find(l => l.value === base) || SUPPORTED_UI_LANGUAGES[0];
        return resolveUiLanguageMeta(fallback);
    }

    function updateUiLanguageBadge(lang) {
        const meta = getUiLanguageMeta(lang);
        const valueEl = document.getElementById('uiLanguageValue');
        if (valueEl) {
            valueEl.textContent = meta.label || meta.value.toUpperCase();
        }
        const flagEl = document.getElementById('uiLanguageFlag');
        if (flagEl) {
            flagEl.textContent = meta.flag || '🏳️';
        }
        const dock = document.getElementById('uiLanguageDock');
        if (dock) {
            dock.setAttribute('data-lang', meta.value);
            const label = tConfig('config.uiLanguageLabel', {}, 'Interface language');
            const dockLabel = label ? `${label}: ${meta.label || meta.value.toUpperCase()}` : (meta.label || meta.value.toUpperCase());
            dock.setAttribute('aria-label', dockLabel);
            dock.setAttribute('title', dockLabel);
        }
        const buttons = document.querySelectorAll('.ui-lang-flag');
        buttons.forEach(btn => {
            const isActive = btn.dataset.lang === meta.value;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
    }

    const SERVER_LIMITS = (typeof window !== 'undefined' && window.__CONFIG_LIMITS__) ? window.__CONFIG_LIMITS__ : {};
    const MAX_SOURCE_LANGUAGES = parseLimit(SERVER_LIMITS.maxSourceLanguages, DEFAULT_LIMITS.maxSourceLanguages);
    const MAX_TARGET_LANGUAGES = parseLimit(SERVER_LIMITS.maxTargetLanguages, DEFAULT_LIMITS.maxTargetLanguages);
    const MAX_NO_TRANSLATION_LANGUAGES = parseLimit(SERVER_LIMITS.maxNoTranslationLanguages, DEFAULT_LIMITS.maxNoTranslationLanguages);

    const PROVIDERS = {
        openai: { label: 'OpenAI' },
        anthropic: { label: 'Anthropic' },
        xai: { label: 'XAI (Grok)' },
        deepseek: { label: 'DeepSeek' },
        deepl: { label: 'DeepL' },
        mistral: { label: 'Mistral' },
        cfworkers: { label: 'Cloudflare Workers AI' },
        openrouter: { label: 'OpenRouter' },
        googletranslate: { label: 'Google Translate (unofficial)' },
        gemini: { label: 'Gemini' },
        custom: { label: 'Custom Provider' }
    };

    const PROVIDER_PARAMETER_DEFAULTS = {
        openai: {
            temperature: 0.4,
            topP: 0.95,
            maxOutputTokens: 32768,
            translationTimeout: 60,
            maxRetries: 2,
            reasoningEffort: undefined // undefined = omit from API request (default behavior)
        },
        anthropic: {
            temperature: 0.4,
            topP: 0.95,
            maxOutputTokens: 32768,
            translationTimeout: 60,
            maxRetries: 2,
            thinkingBudget: 0
        },
        xai: {
            temperature: 0.4,
            topP: 0.95,
            maxOutputTokens: 32768,
            translationTimeout: 60,
            maxRetries: 2
        },
        deepseek: {
            temperature: 0.4,
            topP: 0.95,
            maxOutputTokens: 32768,
            translationTimeout: 60,
            maxRetries: 2
        },
        deepl: {
            temperature: 0,
            topP: 1,
            maxOutputTokens: 32768,
            translationTimeout: 60,
            maxRetries: 2,
            modelType: 'quality_optimized',
            formality: 'default',
            preserveFormatting: true
        },
        mistral: {
            temperature: 0.4,
            topP: 0.95,
            maxOutputTokens: 32768,
            translationTimeout: 60,
            maxRetries: 2
        },
        cfworkers: {
            temperature: 0.4,
            topP: 0.9,
            maxOutputTokens: 32768,
            translationTimeout: 60,
            maxRetries: 2
        },
        openrouter: {
            temperature: 0.4,
            topP: 0.95,
            maxOutputTokens: 32768,
            translationTimeout: 60,
            maxRetries: 2
        },
        googletranslate: {
            temperature: 0,
            topP: 1,
            maxOutputTokens: 32768,
            translationTimeout: 60,
            maxRetries: 2
        },
        custom: {
            temperature: 0.4,
            topP: 0.95,
            maxOutputTokens: 32768,
            translationTimeout: 120,  // Higher for local models
            maxRetries: 2
        }
    };

    // Translation prompt presets
    const STRICT_TRANSLATION_PROMPT = `You are a professional subtitles translator. Translate the following subtitles while:
1. Preserving entry boundaries and ordering exactly as given
2. Preserving line breaks within each entry unless a break is clearly invalid
3. Preserving formatting tags and special characters
4. Preserving meaning, tone, and speaker intent with high fidelity
5. Keeping terminology, names, and style consistent across entries

CRITICAL:
- Follow the output format contract specified by the current workflow instructions (numbered list, XML tags, JSON array, or timestamped SRT when explicitly requested).
- Do NOT add explanations, notes, acknowledgements, or alternative translations.
- Return ONLY the translated output in the required format. NEVER output markdown.

Translate to {target_language}.`;

    const NATURAL_TRANSLATION_PROMPT = `You are a professional subtitle translator. Translate the following subtitles while:
1. Preserving entry boundaries and ordering
2. Preserving line breaks where possible, but adapt phrasing for natural subtitle flow when needed
3. Maintaining natural dialogue and colloquialisms appropriate to the target language
4. Preserving formatting tags and special characters
5. Keeping character voice and context accurate for film/TV dialogue

CRITICAL:
- Follow the output format contract specified by the current workflow instructions (numbered list, XML tags, JSON array, or timestamped SRT when explicitly requested).
- Do NOT add explanations, notes, acknowledgements, or alternative translations.
- Return ONLY the translated output in the required format. NEVER output markdown.

Translate to {target_language}.`;

    /**
     * Model-specific default configurations
     * Each model has its own optimal settings for thinking and temperature
     */
    const MODEL_SPECIFIC_DEFAULTS = {

        'gemini-2.5-flash-lite': {
            thinkingBudget: 0,
            temperature: 0.7
        },
        'gemini-2.5-flash-lite-preview-09-2025': {
            thinkingBudget: 0,
            temperature: 0.7
        },
        'gemini-2.5-flash': {
            thinkingBudget: -1,
            temperature: 0.5
        },
        'gemini-3-flash-preview': {
            thinkingBudget: -1,
            temperature: 0.5
        },
        'gemini-3-flash-preview': {
            thinkingBudget: -1,
            temperature: 0.5
        },
        'gemini-3.1-flash-lite-preview': {
            thinkingBudget: 0,
            temperature: 0.8
        },
        'gemini-flash-lite-latest': {
            thinkingBudget: 0,
            temperature: 0.8
        },
        'gemini-flash-latest': {
            thinkingBudget: -1,
            temperature: 0.5
        },
        'gemini-2.5-pro': {
            thinkingBudget: 1000,
            temperature: 0.5
        },
        'gemini-3-pro-preview': {
            thinkingBudget: 1000,
            temperature: 0.5
        }
    };

    /**
     * Get model-specific defaults for thinking and temperature
     * @param {string} modelName - The Gemini model name
     * @returns {Object} - Model-specific settings { thinkingBudget, temperature }
     */
    function getModelSpecificDefaults(modelName) {
        return MODEL_SPECIFIC_DEFAULTS[modelName] || {
            thinkingBudget: 0,
            temperature: 0.8
        };
    }

    function getVisibleGeminiModelOptions() {
        const select = document.getElementById('geminiModel');
        if (!select || !select.options) {
            return [];
        }
        return Array.from(select.options)
            .filter(option => {
                const value = String(option.value || '').trim();
                return !!value && option.disabled !== true && option.hidden !== true;
            });
    }

    function getGeminiModelSelectOptionValues() {
        return getVisibleGeminiModelOptions()
            .map(option => String(option.value || '').trim())
            .filter(Boolean);
    }

    function getDefaultGeminiModelOption() {
        const options = getVisibleGeminiModelOptions();
        const explicitlySelectedDefault = options.find(option => option.defaultSelected === true);
        return explicitlySelectedDefault || options[0] || null;
    }

    function getGeminiModelOptionLabel(option) {
        if (!option) {
            return '';
        }
        const fallback = String(option.textContent || '').trim();
        const translationKey = option.getAttribute('data-i18n');
        if (!translationKey) {
            return fallback;
        }
        const translated = tConfig(translationKey, {}, fallback);
        return translated && translated !== translationKey ? translated.trim() : fallback;
    }

    function getDefaultGeminiModelOptionValue() {
        const option = getDefaultGeminiModelOption();
        const value = option ? String(option.value || '').trim() : '';
        return value || 'gemini-flash-latest';
    }

    function getDefaultGeminiModelOptionLabel() {
        const label = getGeminiModelOptionLabel(getDefaultGeminiModelOption());
        return label || 'Gemini Flash Latest';
    }

    function getFirstGeminiModelOptionValue() {
        return getDefaultGeminiModelOptionValue();
    }

    function normalizeGeminiModelForBaseSelect(modelName) {
        let normalized = typeof modelName === 'string' ? modelName.trim() : '';
        if (normalized === 'gemini-2.5-pro-preview-05-06') {
            normalized = 'gemini-2.5-pro';
        }
        if (normalized === 'gemini-2.5-flash-preview-09-2025') {
            normalized = 'gemini-2.5-flash';
        }
        if (normalized === 'gemini-flash-lite-latest') {
            normalized = 'gemini-2.5-flash-lite';
        }

        const optionValues = getGeminiModelSelectOptionValues();
        const defaultOption = getDefaultGeminiModelOptionValue();
        if (normalized === 'gemini-flash-latest') {
            return defaultOption;
        }
        if (normalized && optionValues.includes(normalized)) {
            return normalized;
        }
        return defaultOption;
    }

    if (typeof window !== 'undefined') {
        window.SubMakerGeminiModelUi = {
            getDefaultModelValue: getDefaultGeminiModelOptionValue,
            getDefaultModelLabel: getDefaultGeminiModelOptionLabel,
            getModelSpecificDefaults,
            normalizeBaseModel: normalizeGeminiModelForBaseSelect
        };
    }

    function getDefaultProviderParameters() {
        // Defensive clone to avoid accidental mutation
        return JSON.parse(JSON.stringify(PROVIDER_PARAMETER_DEFAULTS));
    }

    function sanitizeNumber(value, fallback, min, max) {
        const num = typeof value === 'number' ? value : parseFloat(value);
        if (!Number.isFinite(num)) return fallback;
        if (min !== undefined && num < min) return min;
        if (max !== undefined && num > max) return max;
        return num;
    }

    function mergeProviderParameters(defaultParams, incomingParams) {
        const merged = {};
        const incoming = incomingParams || {};
        const sanitizeReasoningEffort = (value, fallback) => {
            // Allow empty string to explicitly disable reasoning effort
            if (value === '' || value === null || value === undefined) {
                return undefined;
            }
            const allowed = ['low', 'medium', 'high'];
            const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
            return allowed.includes(normalized) ? normalized : fallback;
        };
        Object.keys(defaultParams || {}).forEach(key => {
            const matchKey = Object.keys(incoming).find(k => String(k).toLowerCase() === String(key).toLowerCase());
            const raw = matchKey ? incoming[matchKey] : {};
            const defaults = defaultParams[key] || {};
            merged[key] = {
                temperature: sanitizeNumber(raw?.temperature, defaults.temperature, 0, 2),
                topP: sanitizeNumber(raw?.topP, defaults.topP, 0, 1),
                maxOutputTokens: sanitizeNumber(raw?.maxOutputTokens, defaults.maxOutputTokens, 1, 200000),
                translationTimeout: sanitizeNumber(raw?.translationTimeout, defaults.translationTimeout, 5, 720),
                maxRetries: Math.max(0, Math.min(5, parseInt(raw?.maxRetries) || defaults.maxRetries || 0)),
                reasoningEffort: sanitizeReasoningEffort(raw?.reasoningEffort, defaults.reasoningEffort),
                thinkingBudget: (() => {
                    const requested = Number.isFinite(parseInt(raw?.thinkingBudget, 10))
                        ? parseInt(raw.thinkingBudget, 10)
                        : NaN;
                    const fallback = Number.isFinite(parseInt(defaults.thinkingBudget, 10))
                        ? parseInt(defaults.thinkingBudget, 10)
                        : 0;
                    const chosen = Number.isFinite(requested) ? requested : fallback;
                    return Math.max(-1, Math.min(200000, chosen));
                })(),
                formality: typeof raw?.formality === 'string'
                    ? raw.formality
                    : (typeof defaults.formality === 'string' ? defaults.formality : 'default'),
                modelType: typeof raw?.modelType === 'string'
                    ? raw.modelType
                    : (typeof defaults.modelType === 'string' ? defaults.modelType : ''),
                preserveFormatting: raw?.preserveFormatting !== undefined
                    ? raw.preserveFormatting === true
                    : defaults.preserveFormatting === true
            };
        });
        return merged;
    }

    function getDefaultConfig(modelName = 'gemini-flash-latest') {
        const modelDefaults = getModelSpecificDefaults(modelName);

        return {
            noTranslationMode: false, // If true, skip translation and just fetch subtitles
            noTranslationLanguages: [], // Languages to fetch when in no-translation mode
            uiLanguage: getPreferredUiLanguage(),
            sourceLanguages: ['eng'], // Limited by MAX_SOURCE_LANGUAGES
            targetLanguages: [],
            // Learn mode (dual-language VTT output)
            learnMode: false,
            learnTargetLanguages: [],
            learnOrder: 'source-top', // 'source-top' | 'target-top'
            learnPlacement: 'top',
            learnItalic: true, // italicize the second language line
            learnItalicTarget: 'target', // 'target' | 'source' — which language to italicize
            geminiApiKey: DEFAULT_API_KEYS.GEMINI,
            geminiKeyRotationEnabled: false,
            geminiApiKeys: [],
            geminiKeyRotationMode: 'per-batch', // 'per-batch' or 'per-request'
            // --- Advanced Parallel Translation Engine ---
            parallelBatchesEnabled: false,
            parallelBatchesCount: 3,
            // --------------------------------------------
            assemblyAiApiKey: DEFAULT_API_KEYS.ASSEMBLYAI,
            cloudflareWorkersApiKey: DEFAULT_API_KEYS.CF_WORKERS_AUTOSUBS,
            otherApiKeysEnabled: true,
            autoSubs: {
                defaultMode: 'cloudflare',
                sendFullVideoToAssembly: false,
                assemblySpeechModel: 'universal-3-pro'
            },
            geminiModel: modelName,
            betaModeEnabled: false,
            devMode: false,
            multiProviderEnabled: false,
            mainProvider: 'gemini',
            secondaryProviderEnabled: false,
            secondaryProvider: '',
            providers: {
                openai: { enabled: false, apiKey: '', model: '' },
                anthropic: { enabled: false, apiKey: '', model: '' },
                xai: { enabled: false, apiKey: '', model: '' },
                deepseek: { enabled: false, apiKey: '', model: '' },
                deepl: { enabled: false, apiKey: '', model: '' },
                mistral: { enabled: false, apiKey: '', model: '' },
                cfworkers: { enabled: false, apiKey: '', model: '' },
                openrouter: { enabled: false, apiKey: '', model: '' },
                googletranslate: { enabled: false, apiKey: '', model: 'web' },
                custom: { enabled: false, apiKey: '', model: '', baseUrl: '' }
            },
            providerParameters: getDefaultProviderParameters(),
            promptStyle: 'strict', // 'natural' or 'strict'
            translationPrompt: STRICT_TRANSLATION_PROMPT,
            subtitleProviders: {
                opensubtitles: {
                    enabled: true,
                    implementationType: 'v3', // 'auth' or 'v3'
                    username: '',
                    password: ''
                },
                subdl: {
                    enabled: true,
                    apiKey: DEFAULT_API_KEYS.SUBDL
                },
                subsource: {
                    enabled: true,
                    apiKey: DEFAULT_API_KEYS.SUBSOURCE
                },
                scs: {
                    enabled: false // Stremio Community Subtitles - no API key needed
                },
                wyzie: {
                    enabled: false // Wyzie Subs - free aggregator, no API key needed
                }
            },
            // Subtitle provider timeout in seconds (min: 8, max: 30, default: 12)
            subtitleProviderTimeout: 12,
            translationCache: {
                enabled: true,
                duration: 0, // hours, 0 = permanent
                persistent: true // save to disk
            },
            bypassCache: false,
            bypassCacheConfig: {
                enabled: true,
                duration: 12
            },
            tempCache: { // Deprecated: kept for backward compatibility, use bypassCacheConfig instead
                enabled: true,
                duration: 12
            },
            subToolboxEnabled: false, // unified toolbox entry for translate/sync/auto tools
            fileTranslationEnabled: false, // legacy flag (mirrors subToolboxEnabled)
            syncSubtitlesEnabled: false, // legacy flag (mirrors subToolboxEnabled)
            excludeHearingImpairedSubtitles: false, // If true, hide SDH/HI subtitles from results
            enableSeasonPacks: true, // If true, show season pack subtitles in results (default: enabled for backwards compatibility)
            forceSRTOutput: false, // If true, convert all subtitle outputs to SRT format
            convertAssToVtt: true, // If true, convert ASS/SSA subtitles to VTT (default: enabled for backwards compatibility)
            androidSubtitleCompatMode: 'off', // Dev mode only: 'off' | 'safe' | 'aggressive'
            mobileMode: false, // Opt-in: wait for full translation before responding (no automatic device detection)
            singleBatchMode: false, // Try translating whole file at once
            advancedSettings: {
                enabled: false, // Auto-set to true if any setting differs from defaults (forces bypass cache)
                geminiModel: '', // Override model (empty = use default)
                thinkingBudget: modelDefaults.thinkingBudget,
                temperature: modelDefaults.temperature,
                topP: 0.95,
                topK: 40,
                enableBatchContext: false, // Include original surrounding context and previous translations
                contextSize: 8, // Number of preceding original entries to include as context
                sendTimestampsToAI: false, // Let AI handle timestamps directly
                translationWorkflow: 'xml', // 'original', 'ai', 'xml', or 'json'
                mismatchRetries: 1 // Retries when AI returns wrong entry count (0-3)
            }
        };
    }

    function mergeProviders(defaultProviders, incomingProviders) {
        const merged = {};
        const incoming = incomingProviders || {};
        Object.keys(defaultProviders || {}).forEach(key => {
            const matchKey = Object.keys(incoming).find(k => String(k).toLowerCase() === String(key).toLowerCase());
            merged[key] = {
                ...defaultProviders[key],
                ...(matchKey ? incoming[matchKey] : {})
            };
        });
        return merged;
    }

    // State management
    let currentConfig = null;
    let providerLanguages = [];    // Languages for source/no-translation (Stremio/provider-compatible)
    let translationLanguages = []; // Languages for target/learn (AI translation targets with regional variants)
    let allLanguages = [];         // Combined lookup (both sets merged for chip display)
    let isFirstRun = false;
    let modelsFetchTimeout = null;
    let lastFetchedApiKey = null;
    const providerModelCache = {
        deepl: [
            { name: 'quality_optimized', displayName: 'Quality optimized (default)' },
            { name: 'latency_optimized', displayName: 'Latency optimized' }
        ]
    };
    let instructionsAutoMinimizeTimer = null;
    let instructionsInteracted = false;
    let betaModeLastState = null;
    const VALID_URL_EXTENSION_TEST_VALUES = ['srt', 'sub', 'none', 'resolve'];
    let lastUrlExtensionTestChoice = 'srt';
    let urlExtensionTestForcedByAssPassthrough = false;

    // localStorage cache keys
    const CACHE_KEY = 'submaker_config_cache';
    const CACHE_EXPIRY_KEY = 'submaker_config_cache_expiry';
    const CACHE_VERSION_KEY = 'submaker_config_cache_version';  // Tracks version when cache was saved
    const CACHE_TOKEN_KEY = 'submaker_config_cache_token'; // Scopes cached config to the session token it was created for
    const TOKEN_KEY = 'submaker_session_token';
    const TOKEN_VAULT_KEY = 'submaker_token_vault_v1';
    const TOKEN_VAULT_MAX_ENTRIES = 5;
    const TOKEN_VAULT_RAIL_LIMIT = 5;
    const TOKEN_VAULT_EXPORT_VERSION = 1;
    const TOKEN_VAULT_BRIEF_TTL_MS = 30 * 1000;
    const CONFIG_INSTRUCTIONS_PREFERENCE_KEY = 'submaker_dont_show_instructions';
    const LEGACY_CONFIG_INSTRUCTIONS_PREFERENCE_KEY = 'hideConfigInstructions';

    let activeSessionContext = {
        token: '',
        provenance: 'draft',
        sourceLabel: 'Fresh draft',
        message: 'No token yet. Your first save will mint one.',
        session: null,
        recoveredFromToken: '',
        regenerated: false
    };
    let tokenVaultStoreCache = null;
    let tokenVaultBriefMap = new Map();
    let tokenVaultLoaded = false;
    let tokenVaultRefreshing = false;
    let tokenVaultRefreshPromise = null;
    let tokenVaultLastRefreshAt = 0;
    let tokenVaultLastRefreshKey = '';
    let tokenVaultBriefFetchCache = new Map();
    let tokenVaultBriefFetchPromises = new Map();
    let tokenVaultReveal = false;
    let tokenVaultRailOpen = false;
    let tokenVaultRailMenuKey = '';
    let tokenVaultRailMenuFrame = 0;
    let tokenVaultFocusedToken = '';
    let tokenVaultTitleEditToken = '';
    let tokenVaultTitleEditValue = '';
    let tokenVaultPendingSwitch = '';
    let tokenVaultOverrideState = null;
    let tokenVaultCreatorInputValue = '';
    let tokenVaultCreatorPreview = null;
    let tokenVaultCreatorPreviewSeq = 0;
    let tokenVaultCreatorPreviewTimer = null;
    let tokenVaultRailRenderedMarkup = '';
    let tokenVaultManagerRenderedMarkup = '';
    let tokenVaultCreatorRenderedMarkup = '';
    let tokenVaultCreatorPreviewRenderedMarkup = '';
    let tokenVaultLauncherPointerDownAt = 0;
    let tokenVaultGlobalEventsBound = false;
    let floatingBottomSafeZoneFrame = 0;
    let floatingBottomSafeZoneValue = '';
    let bodyScrollLockState = { locked: null, viewportWidth: 0, scrollbarWidth: 0 };
    let configDirty = false;
    let revealedInstallToken = '';
    let suppressDirtyTracking = true;

    // Visual state cache keys that can be safely reset on version changes
    const VISUAL_STATE_KEYS = [
        'submaker_collapsed_sections',
        'submaker_scroll_position'
    ];

    /**
     * FIXED: Validate session token format
     * Session tokens must be 32-character hexadecimal strings
     * @param {string} token - Token to validate
     * @returns {boolean} - True if token is valid format
     */
    function isValidSessionToken(token) {
        return token && typeof token === 'string' && /^[a-f0-9]{32}$/.test(token);
    }

    /**
     * Validate any supported config token (session tokens only)
     * @param {string} token
     * @returns {boolean}
     */
    function isValidConfigToken(token) {
        return isValidSessionToken(token);
    }

    /**
     * FIXED: Clear invalid token from storage
     * @param {string} reason - Reason for clearing (for logging)
     */
    function clearInvalidToken(reason = 'unknown') {
        const token = localStorage.getItem(TOKEN_KEY);
        if (token && !isValidConfigToken(token)) {
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(CACHE_TOKEN_KEY);
            return true;
        }
        return false;
    }

    function getStoredSessionToken() {
        try {
            const token = localStorage.getItem(TOKEN_KEY);
            if (isValidSessionToken(token)) {
                return token;
            }
            if (token) {
                localStorage.removeItem(TOKEN_KEY);
            }
        } catch (_) { }
        return '';
    }

    function getUrlSessionToken() {
        try {
            const raw = new URLSearchParams(window.location.search).get('config');
            return isValidSessionToken(raw) ? raw : '';
        } catch (_) {
            return '';
        }
    }

    // Clear any invalid tokens that might exist from previous errors
    clearInvalidToken('startup');

    function escapeVaultHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function maskToken(token) {
        if (!isValidSessionToken(token)) return 'No token loaded';
        return `${token.slice(0, 8)}...${token.slice(-6)}`;
    }

    function formatVaultDate(timestamp) {
        const value = Number(timestamp);
        if (!Number.isFinite(value) || value <= 0) return '--';
        try {
            return new Date(value).toLocaleString();
        } catch (_) {
            return '--';
        }
    }

    function formatVaultRelative(timestamp) {
        const value = Number(timestamp);
        if (!Number.isFinite(value) || value <= 0) return '--';
        const delta = Date.now() - value;
        const abs = Math.abs(delta);
        const minute = 60 * 1000;
        const hour = 60 * minute;
        const day = 24 * hour;
        if (abs < minute) return 'just now';
        if (abs < hour) return `${Math.round(abs / minute)}m ago`;
        if (abs < day) return `${Math.round(abs / hour)}h ago`;
        return `${Math.round(abs / day)}d ago`;
    }

    function buildLegacyVaultLabel(token) {
        if (!isValidSessionToken(token)) return '';
        return `Token ${token.slice(0, 4).toUpperCase()}...${token.slice(-4).toUpperCase()}`;
    }

    function normalizeVaultLabel(token, explicitLabel) {
        const trimmed = String(explicitLabel || '').trim();
        if (!trimmed) return '';
        if (isValidSessionToken(token) && trimmed === buildLegacyVaultLabel(token)) {
            return '';
        }
        return trimmed;
    }

    function getDetachedActiveVaultToken(store = getTokenVaultStore(), activeToken = getActiveConfigRef()) {
        const normalizedToken = extractSessionTokenFromInput(activeToken);
        if (!normalizedToken) return '';
        return getVaultEntryForToken(normalizedToken, store) ? '' : normalizedToken;
    }

    function getTokenVaultProfileCount(store = getTokenVaultStore(), activeToken = getActiveConfigRef()) {
        const savedCount = Array.isArray(store?.entries) ? store.entries.length : 0;
        return savedCount + (getDetachedActiveVaultToken(store, activeToken) ? 1 : 0);
    }

    function getTokenVaultDisplayCount(store = getTokenVaultStore(), activeToken = getActiveConfigRef()) {
        return Math.min(getTokenVaultProfileCount(store, activeToken), TOKEN_VAULT_MAX_ENTRIES);
    }

    function buildVaultProfileOrdering(store = getTokenVaultStore()) {
        return (Array.isArray(store?.entries) ? store.entries : [])
            .filter(entry => isValidSessionToken(entry?.token))
            .map(entry => ({
                token: String(entry.token).trim().toLowerCase(),
                addedAt: Number(entry.addedAt) || Number(entry.lastSavedAt) || Number(entry.lastOpenedAt) || 0
            }))
            .sort((a, b) => {
                const addedDelta = Number(a.addedAt || 0) - Number(b.addedAt || 0);
                if (addedDelta !== 0) return addedDelta;
                return String(a.token).localeCompare(String(b.token));
            });
    }

    function getVaultProfileNumber(token, store = getTokenVaultStore()) {
        const normalizedToken = String(token || '').trim().toLowerCase();
        if (!isValidSessionToken(normalizedToken)) return 0;
        const orderedEntries = buildVaultProfileOrdering(store);
        const existingIndex = orderedEntries.findIndex(entry => entry.token === normalizedToken);
        if (existingIndex >= 0) return existingIndex + 1;
        const detachedActiveToken = getDetachedActiveVaultToken(store);
        if (normalizedToken === detachedActiveToken) {
            return orderedEntries.length + 1;
        }
        return orderedEntries.length + 1;
    }

    function getDraftProfileNumber(store = getTokenVaultStore()) {
        return getTokenVaultProfileCount(store) + 1;
    }

    function buildDefaultVaultLabel(profileNumber) {
        const resolvedNumber = Math.max(1, Number(profileNumber) || 1);
        return `Profile ${resolvedNumber}`;
    }

    function deriveVaultLabel(token, explicitLabel, options = {}) {
        const normalizedExplicit = normalizeVaultLabel(token, explicitLabel);
        if (normalizedExplicit) return normalizedExplicit;
        const store = options.store || getTokenVaultStore();
        if (!isValidSessionToken(token)) {
            return buildDefaultVaultLabel(getDraftProfileNumber(store));
        }
        return buildDefaultVaultLabel(getVaultProfileNumber(token, store));
    }

    function getEmptyTokenVaultStore() {
        return {
            version: TOKEN_VAULT_EXPORT_VERSION,
            activeToken: '',
            entries: []
        };
    }

    function cloneTokenVaultStore(store) {
        const source = store || getEmptyTokenVaultStore();
        return {
            version: TOKEN_VAULT_EXPORT_VERSION,
            activeToken: isValidSessionToken(source.activeToken) ? source.activeToken : '',
            entries: Array.isArray(source.entries)
                ? source.entries.map(entry => ({
                    token: String(entry?.token || '').trim().toLowerCase(),
                    label: normalizeVaultLabel(entry?.token || '', entry?.label || ''),
                    addedAt: Number(entry?.addedAt) || 0,
                    lastOpenedAt: Number(entry?.lastOpenedAt) || 0,
                    lastSavedAt: Number(entry?.lastSavedAt) || 0,
                    lastKnownCreatedAt: Number(entry?.lastKnownCreatedAt) || 0,
                    lastKnownUpdatedAt: Number(entry?.lastKnownUpdatedAt) || 0,
                    lastKnownLastAccessedAt: Number(entry?.lastKnownLastAccessedAt) || 0,
                    lastKnownDisabled: entry?.lastKnownDisabled === true
                }))
                : []
        };
    }

    function normalizeTokenVaultStore(storeLike) {
        const entries = Array.isArray(storeLike?.entries) ? storeLike.entries : [];
        return {
            version: TOKEN_VAULT_EXPORT_VERSION,
            activeToken: isValidSessionToken(storeLike?.activeToken) ? storeLike.activeToken : '',
            entries: entries
                .map(entry => {
                    const token = String(entry?.token || '').trim().toLowerCase();
                    return {
                        token,
                        label: normalizeVaultLabel(token, entry?.label || ''),
                        addedAt: Number(entry?.addedAt) || Date.now(),
                        lastOpenedAt: Number(entry?.lastOpenedAt) || 0,
                        lastSavedAt: Number(entry?.lastSavedAt) || 0,
                        lastKnownCreatedAt: Number(entry?.lastKnownCreatedAt) || 0,
                        lastKnownUpdatedAt: Number(entry?.lastKnownUpdatedAt) || 0,
                        lastKnownLastAccessedAt: Number(entry?.lastKnownLastAccessedAt) || 0,
                        lastKnownDisabled: entry?.lastKnownDisabled === true
                    };
                })
                .filter(entry => isValidSessionToken(entry.token))
        };
    }

    function getTokenVaultStore() {
        if (tokenVaultStoreCache) {
            return cloneTokenVaultStore(tokenVaultStoreCache);
        }
        try {
            const raw = localStorage.getItem(TOKEN_VAULT_KEY);
            const parsed = raw ? JSON.parse(raw) : null;
            tokenVaultStoreCache = normalizeTokenVaultStore(parsed);
        } catch (_) {
            tokenVaultStoreCache = getEmptyTokenVaultStore();
        }
        return cloneTokenVaultStore(tokenVaultStoreCache);
    }

    function saveTokenVaultStore(store) {
        try {
            const normalized = normalizeTokenVaultStore({
                ...store,
                entries: Array.isArray(store?.entries)
                    ? store.entries
                        .filter(entry => isValidSessionToken(entry?.token))
                        .sort((a, b) => {
                            const activityDelta = getVaultActivityTimestamp(b) - getVaultActivityTimestamp(a);
                            if (activityDelta !== 0) return activityDelta;
                            const openedDelta = Number(b.lastOpenedAt || 0) - Number(a.lastOpenedAt || 0);
                            if (openedDelta !== 0) return openedDelta;
                            return String(a.token).localeCompare(String(b.token));
                        })
                        .slice(0, TOKEN_VAULT_MAX_ENTRIES)
                    : []
            });
            tokenVaultStoreCache = normalized;
            localStorage.setItem(TOKEN_VAULT_KEY, JSON.stringify(normalized));
        } catch (_) { }
    }

    function getVaultActivityTimestamp(entry) {
        if (!entry) return 0;
        return Number(entry.lastSavedAt || entry.lastKnownUpdatedAt || entry.addedAt || 0);
    }

    function sortVaultEntries(entries) {
        return [...entries].sort((a, b) => {
            const activityDelta = getVaultActivityTimestamp(b) - getVaultActivityTimestamp(a);
            if (activityDelta !== 0) return activityDelta;
            const openedDelta = Number(b.lastOpenedAt || 0) - Number(a.lastOpenedAt || 0);
            if (openedDelta !== 0) return openedDelta;
            return String(a.token || '').localeCompare(String(b.token || ''));
        });
    }

    function buildTokenVaultEntry(token, patch = {}, existing = null) {
        const normalizedToken = token.toLowerCase();
        return {
            token: normalizedToken,
            label: normalizeVaultLabel(normalizedToken, patch.label ?? existing?.label ?? ''),
            addedAt: Number(existing?.addedAt || patch.addedAt) || Date.now(),
            lastOpenedAt: Number(patch.lastOpenedAt ?? existing?.lastOpenedAt) || 0,
            lastSavedAt: Number(patch.lastSavedAt ?? existing?.lastSavedAt) || 0,
            lastKnownCreatedAt: Number(patch.lastKnownCreatedAt ?? existing?.lastKnownCreatedAt) || 0,
            lastKnownUpdatedAt: Number(patch.lastKnownUpdatedAt ?? existing?.lastKnownUpdatedAt) || 0,
            lastKnownLastAccessedAt: Number(patch.lastKnownLastAccessedAt ?? existing?.lastKnownLastAccessedAt) || 0,
            lastKnownDisabled: patch.lastKnownDisabled === true || (patch.lastKnownDisabled !== false && existing?.lastKnownDisabled === true)
        };
    }

    function prepareTokenVaultEntryUpsert(token, patch = {}, options = {}) {
        if (!isValidSessionToken(token)) return null;
        const normalizedToken = token.toLowerCase();
        const store = options.store || getTokenVaultStore();
        const existing = store.entries.find(entry => entry.token === normalizedToken) || null;
        if (!existing && options.ifExistsOnly === true) {
            return null;
        }
        const next = buildTokenVaultEntry(normalizedToken, patch, existing);
        const nextEntries = sortVaultEntries([
            next,
            ...store.entries.filter(entry => entry.token !== normalizedToken)
        ]);
        return {
            store,
            existing,
            next,
            nextEntries,
            overflowVictims: nextEntries.slice(TOKEN_VAULT_MAX_ENTRIES)
        };
    }

    function applyTokenVaultEntryPlan(plan, options = {}) {
        if (!plan) return null;
        const allowedVictims = new Set(
            (Array.isArray(options.allowVictimTokens) ? options.allowVictimTokens : [])
                .filter(isValidSessionToken)
                .map(token => token.toLowerCase())
        );
        if (plan.overflowVictims.length > 0) {
            const allApproved = plan.overflowVictims.every(entry => allowedVictims.has(entry.token));
            if (!allApproved) {
                return null;
            }
        }
        saveTokenVaultStore({
            ...plan.store,
            activeToken: options.activeToken !== undefined
                ? (isValidSessionToken(options.activeToken) ? options.activeToken.toLowerCase() : '')
                : plan.store.activeToken,
            entries: sortVaultEntries(plan.nextEntries).slice(0, TOKEN_VAULT_MAX_ENTRIES)
        });
        return plan.next;
    }

    function upsertTokenVaultEntry(token, patch = {}, options = {}) {
        const plan = prepareTokenVaultEntryUpsert(token, patch, options);
        return applyTokenVaultEntryPlan(plan, options);
    }

    function prepareTokenVaultMergePlan(incomingEntries, options = {}) {
        const store = options.store || getTokenVaultStore();
        const mergedMap = new Map(store.entries.map(entry => [entry.token, entry]));
        const incomingTokens = [];

        (Array.isArray(incomingEntries) ? incomingEntries : []).forEach(entry => {
            const token = extractSessionTokenFromInput(entry?.token || entry);
            if (!token) return;
            const existing = mergedMap.get(token) || null;
            mergedMap.set(token, buildTokenVaultEntry(token, entry || {}, existing));
            if (!incomingTokens.includes(token)) {
                incomingTokens.push(token);
            }
        });

        const nextEntries = sortVaultEntries(Array.from(mergedMap.values()));
        return {
            store,
            incomingTokens,
            nextEntries,
            overflowVictims: nextEntries.slice(TOKEN_VAULT_MAX_ENTRIES)
        };
    }

    function applyTokenVaultMergePlan(plan, options = {}) {
        if (!plan) return 0;
        const allowedVictims = new Set(
            (Array.isArray(options.allowVictimTokens) ? options.allowVictimTokens : [])
                .filter(isValidSessionToken)
                .map(token => token.toLowerCase())
        );
        if (plan.overflowVictims.length > 0) {
            const allApproved = plan.overflowVictims.every(entry => allowedVictims.has(entry.token));
            if (!allApproved) {
                return 0;
            }
        }
        const keptEntries = sortVaultEntries(plan.nextEntries).slice(0, TOKEN_VAULT_MAX_ENTRIES);
        saveTokenVaultStore({
            ...plan.store,
            activeToken: options.activeToken !== undefined
                ? (isValidSessionToken(options.activeToken) ? options.activeToken.toLowerCase() : '')
                : plan.store.activeToken,
            entries: keptEntries
        });
        return keptEntries.filter(entry => plan.incomingTokens.includes(entry.token)).length;
    }

    function describeVaultEntry(entry) {
        if (!entry || !isValidSessionToken(entry.token)) return null;
        return {
            token: entry.token,
            label: deriveVaultLabel(entry.token, entry.label || ''),
            maskedToken: maskToken(entry.token),
            relativeSavedAt: formatVaultRelative(getVaultActivityTimestamp(entry)),
            savedAt: formatVaultDate(getVaultActivityTimestamp(entry)),
            isActive: entry.token === getActiveConfigRef()
        };
    }

    function getDraftOverflowVictims(store = getTokenVaultStore()) {
        if (!Array.isArray(store?.entries) || store.entries.length < TOKEN_VAULT_MAX_ENTRIES) {
            return [];
        }
        return sortVaultEntries(store.entries).slice(TOKEN_VAULT_MAX_ENTRIES - 1);
    }

    function renderTokenVaultOverridePrompt() {
        const content = document.getElementById('tokenVaultOverrideContent');
        if (!content) return;
        if (!tokenVaultOverrideState) {
            content.innerHTML = '';
            return;
        }

        const tone = String(tokenVaultOverrideState.tone || 'warning');
        const emblem = String(tokenVaultOverrideState.emblem || (tone === 'danger' ? '!' : '+'));
        const confirmClass = tokenVaultOverrideState.confirmClass || 'token-vault-action-primary';
        const victims = Array.isArray(tokenVaultOverrideState.victims)
            ? tokenVaultOverrideState.victims.map(describeVaultEntry).filter(Boolean)
            : [];
        const victimHtml = victims.map(victim => `<article class="token-vault-override-victim ${victim.isActive ? 'is-active' : ''}">
                <div class="token-vault-override-victim-copy">
                    <strong>${escapeVaultHtml(victim.label)}</strong>
                    <span>${escapeVaultHtml(victim.maskedToken)}</span>
                </div>
                <div class="token-vault-override-victim-meta">
                    <span>${escapeVaultHtml(victim.relativeSavedAt)}</span>
                    ${victim.isActive ? '<span class="token-vault-override-chip">Current page</span>' : ''}
                </div>
            </article>`).join('');

        content.innerHTML = `<div class="token-vault-override-copy token-vault-override-copy-${escapeVaultHtml(tone)}">
                <div class="token-vault-override-header">
                    <div class="token-vault-override-emblem" aria-hidden="true">${escapeVaultHtml(emblem)}</div>
                    <div class="token-vault-override-copy-main">
                        <div class="token-vault-override-eyebrow">${escapeVaultHtml(tokenVaultOverrideState.eyebrow || 'Vault limit')}</div>
                        <h3 id="tokenVaultOverrideTitle">${escapeVaultHtml(tokenVaultOverrideState.title || 'Token Vault is full')}</h3>
                        <p>${escapeVaultHtml(tokenVaultOverrideState.message || '')}</p>
                    </div>
                </div>
                ${tokenVaultOverrideState.detail ? `<p class="token-vault-override-detail">${escapeVaultHtml(tokenVaultOverrideState.detail)}</p>` : ''}
            </div>
            ${victimHtml ? `<div class="token-vault-override-list">${victimHtml}</div>` : ''}
            <div class="token-vault-override-actions">
                <button type="button" class="token-vault-action" data-vault-override-action="cancel">${escapeVaultHtml(tokenVaultOverrideState.cancelLabel || 'Cancel')}</button>
                <button type="button" class="token-vault-action ${escapeVaultHtml(confirmClass)}" data-vault-override-action="confirm">${escapeVaultHtml(tokenVaultOverrideState.confirmLabel || 'Continue')}</button>
            </div>`;
    }

    function openTokenVaultOverridePrompt(state) {
        tokenVaultOverrideState = {
            cancelLabel: 'Cancel',
            tone: 'warning',
            emblem: '+',
            confirmClass: 'token-vault-action-primary',
            ...state
        };
        const modal = document.getElementById('tokenVaultOverrideModal');
        renderTokenVaultOverridePrompt();
        if (modal) {
            modal.dataset.tone = tokenVaultOverrideState.tone || 'warning';
            modal.classList.add('show');
            modal.style.display = 'flex';
        }
        updateBodyScrollLock();
    }

    async function closeTokenVaultOverridePrompt(cancelled = false) {
        const state = tokenVaultOverrideState;
        tokenVaultOverrideState = null;
        const modal = document.getElementById('tokenVaultOverrideModal');
        if (modal) {
            delete modal.dataset.tone;
            modal.classList.remove('show');
            modal.style.display = 'none';
        }
        updateBodyScrollLock();
        if (cancelled && state && typeof state.onCancel === 'function') {
            await state.onCancel();
        }
    }

    async function handleTokenVaultOverrideAction(actionEl) {
        const action = actionEl?.dataset?.vaultOverrideAction;
        if (!action) return;
        if (action === 'cancel') {
            await closeTokenVaultOverridePrompt(true);
            return;
        }
        if (action === 'confirm') {
            const state = tokenVaultOverrideState;
            await closeTokenVaultOverridePrompt(false);
            if (state && typeof state.onConfirm === 'function') {
                await state.onConfirm();
            }
        }
    }

    function applyVaultEntryPlanWithOverflowPrompt(plan, promptState, applyOptions = {}, onApplied = null) {
        if (!plan) return false;
        if (plan.overflowVictims.length > 0) {
            openTokenVaultOverridePrompt({
                ...promptState,
                victims: plan.overflowVictims,
                onConfirm: async () => {
                    const applied = applyTokenVaultEntryPlan(plan, {
                        ...applyOptions,
                        allowVictimTokens: plan.overflowVictims.map(entry => entry.token)
                    });
                    if (applied && typeof onApplied === 'function') {
                        await onApplied(applied);
                    }
                }
            });
            return false;
        }
        const applied = applyTokenVaultEntryPlan(plan, applyOptions);
        if (applied && typeof onApplied === 'function') {
            void onApplied(applied);
        }
        return !!applied;
    }

    function applyVaultMergePlanWithOverflowPrompt(plan, promptState, applyOptions = {}, onApplied = null) {
        if (!plan) return false;
        if (plan.overflowVictims.length > 0) {
            openTokenVaultOverridePrompt({
                ...promptState,
                victims: plan.overflowVictims,
                onConfirm: async () => {
                    const importedCount = applyTokenVaultMergePlan(plan, {
                        ...applyOptions,
                        allowVictimTokens: plan.overflowVictims.map(entry => entry.token)
                    });
                    if (importedCount > 0 && typeof onApplied === 'function') {
                        await onApplied(importedCount);
                    }
                }
            });
            return false;
        }
        const importedCount = applyTokenVaultMergePlan(plan, applyOptions);
        if (importedCount > 0 && typeof onApplied === 'function') {
            void onApplied(importedCount);
        }
        return importedCount > 0;
    }

    function persistSavedTokenToVault(token, brief, options = {}) {
        if (!isValidSessionToken(token)) return false;
        const plan = prepareTokenVaultEntryUpsert(token, {
            lastOpenedAt: Date.now(),
            lastSavedAt: Date.now(),
            lastKnownCreatedAt: Number(brief?.createdAt) || 0,
            lastKnownUpdatedAt: Number(brief?.updatedAt) || Date.now(),
            lastKnownLastAccessedAt: Number(brief?.lastAccessedAt) || 0,
            lastKnownDisabled: brief?.disabled === true
        });
        if (!plan) return false;

        if (plan.overflowVictims.length > 0 && Array.isArray(options.approvedVictimTokens) && options.approvedVictimTokens.length > 0) {
            const applied = applyTokenVaultEntryPlan(plan, {
                activeToken: token,
                allowVictimTokens: options.approvedVictimTokens
            });
            if (applied) {
                renderTokenVault();
            }
            return !!applied;
        }
        if (plan.overflowVictims.length === 0) {
            const applied = applyTokenVaultEntryPlan(plan, { activeToken: token });
            if (applied) {
                renderTokenVault();
            }
            return !!applied;
        }

        openTokenVaultOverridePrompt({
            eyebrow: `${TOKEN_VAULT_MAX_ENTRIES} saved tokens max`,
            title: 'Saving this token needs one vault slot',
            message: `SubMaker keeps up to ${TOKEN_VAULT_MAX_ENTRIES} saved tokens in this browser. Keeping this save will purge the oldest local vault entry below.`,
            detail: 'Only the local browser vault changes. The purged token is not deleted from the server.',
            confirmLabel: 'Keep new token',
            victims: plan.overflowVictims,
            onConfirm: async () => {
                const applied = applyTokenVaultEntryPlan(plan, {
                    activeToken: token,
                    allowVictimTokens: plan.overflowVictims.map(entry => entry.token)
                });
                if (applied) {
                    renderTokenVault();
                }
                if (typeof options.afterResolve === 'function') {
                    await options.afterResolve();
                }
            },
            onCancel: async () => {
                renderTokenVault();
                showAlert('Configuration saved. The new token is live, but your local vault stayed unchanged.', 'info');
                if (typeof options.afterResolve === 'function') {
                    await options.afterResolve();
                }
            }
        });
        return false;
    }

    function prepareDetachedActiveTokenCapturePlan(options = {}) {
        const store = options.store || getTokenVaultStore();
        const activeToken = extractSessionTokenFromInput(options.activeToken || getActiveConfigRef());
        if (!activeToken || getVaultEntryForToken(activeToken, store)) {
            return null;
        }

        const session = options.session !== undefined ? options.session : activeSessionContext.session;
        const fallbackTimestamp = Date.now();
        return prepareTokenVaultEntryUpsert(activeToken, {
            addedAt: Number(session?.createdAt) || fallbackTimestamp,
            lastOpenedAt: Number(options.lastOpenedAt) || fallbackTimestamp,
            lastSavedAt: Number(session?.updatedAt) || Number(session?.createdAt) || fallbackTimestamp,
            lastKnownCreatedAt: Number(session?.createdAt) || 0,
            lastKnownUpdatedAt: Number(session?.updatedAt) || 0,
            lastKnownLastAccessedAt: Number(session?.lastAccessedAt) || 0,
            lastKnownDisabled: session?.disabled === true
        }, { store });
    }

    function captureDetachedActiveTokenInVault(options = {}) {
        const activeToken = extractSessionTokenFromInput(options.activeToken || getActiveConfigRef());
        const store = options.store || getTokenVaultStore();
        const existingEntry = activeToken ? getVaultEntryForToken(activeToken, store) : null;
        const plan = prepareDetachedActiveTokenCapturePlan({
            ...options,
            activeToken,
            store
        });

        if (!plan) {
            return {
                status: 'noop',
                activeToken,
                plan: null,
                entry: existingEntry
            };
        }

        if (plan.overflowVictims.length > 0 && options.allowOverflow !== true) {
            return {
                status: 'needs-approval',
                activeToken,
                plan,
                entry: null
            };
        }

        const appliedEntry = applyTokenVaultEntryPlan(plan, {
            activeToken,
            allowVictimTokens: options.allowOverflow === true
                ? plan.overflowVictims.map(entry => entry.token)
                : []
        });

        return {
            status: appliedEntry ? 'captured' : 'blocked',
            activeToken,
            plan,
            entry: appliedEntry || null
        };
    }

    function safelyBackfillActiveTokenIntoVault(options = {}) {
        const result = captureDetachedActiveTokenInVault(options);
        if (result.status === 'captured' && options.render !== false) {
            renderTokenVaultRail();
            renderTokenVault();
            renderTokenVaultCreator();
        }
        return result;
    }

    function removeTokenVaultEntry(token) {
        if (!isValidSessionToken(token)) return;
        const normalizedToken = token.toLowerCase();
        const store = getTokenVaultStore();
        store.entries = store.entries.filter(entry => entry.token !== normalizedToken);
        if (store.activeToken === normalizedToken) {
            store.activeToken = '';
        }
        saveTokenVaultStore(store);
    }

    function syncTokenVaultEntryWithBrief(token, brief, patch = {}, options = {}) {
        if (!isValidSessionToken(token)) return null;
        return upsertTokenVaultEntry(token, {
            ...patch,
            lastKnownCreatedAt: Number(brief?.createdAt) || patch.lastKnownCreatedAt || 0,
            lastKnownUpdatedAt: Number(brief?.updatedAt) || patch.lastKnownUpdatedAt || 0,
            lastKnownLastAccessedAt: Number(brief?.lastAccessedAt) || patch.lastKnownLastAccessedAt || 0,
            lastKnownDisabled: brief?.disabled === true
        }, options);
    }

    function setActiveSessionContext(next) {
        activeSessionContext = {
            ...activeSessionContext,
            ...next
        };
        if (isValidSessionToken(activeSessionContext.token) && activeSessionContext.session) {
            tokenVaultBriefMap.set(activeSessionContext.token, activeSessionContext.session);
            rememberTokenVaultSingleBrief(activeSessionContext.token, activeSessionContext.session);
        }
        syncTokenVaultUi();
        reconcileActiveInstallState();
    }

    function rememberTokenVaultSingleBrief(token, session, fetchedAt = Date.now()) {
        const normalizedToken = extractSessionTokenFromInput(token);
        if (!normalizedToken) return;
        tokenVaultBriefFetchCache.set(normalizedToken, {
            session: session || null,
            fetchedAt: Number(fetchedAt) || Date.now()
        });
    }

    function getTokenVaultRefreshTokens() {
        const activeToken = getActiveConfigRef();
        const store = getTokenVaultStore();
        return Array.from(new Set([
            activeToken,
            ...store.entries.map(entry => entry.token)
        ].filter(isValidSessionToken))).sort();
    }

    function normalizeTokenVaultRefreshOptions(optionsOrForce = false) {
        if (optionsOrForce && typeof optionsOrForce === 'object') {
            return {
                force: optionsOrForce.force === true,
                background: optionsOrForce.background === true
            };
        }
        return {
            force: optionsOrForce === true,
            background: false
        };
    }

    function scheduleFloatingBottomSafeZoneSync() {
        if (floatingBottomSafeZoneFrame) return;
        floatingBottomSafeZoneFrame = requestAnimationFrame(() => {
            floatingBottomSafeZoneFrame = 0;
            syncFloatingBottomSafeZone();
        });
    }

    function getActiveTokenState() {
        if (activeSessionContext.session?.disabled === true) return 'disabled';
        if (activeSessionContext.provenance === 'recovered') return 'recovered';
        if (!isValidSessionToken(activeSessionContext.token)) return 'draft';
        return 'live';
    }

    function updateTokenVaultButtonState() {
        const button = document.getElementById('tokenVaultLauncher');
        if (!button) return;
        const state = getActiveTokenState();
        button.dataset.state = state;
        button.setAttribute('title', isValidSessionToken(activeSessionContext.token)
            ? `Token Vault - ${maskToken(activeSessionContext.token)}`
            : 'Token Vault - First save creates a token');
        scheduleFloatingBottomSafeZoneSync();
    }

    function syncTokenVaultUi() {
        updateTokenVaultButtonState();
        renderTokenVault();
        renderTokenVaultCreator();
    }

    function extractSessionTokenFromInput(rawValue) {
        const raw = String(rawValue || '').trim();
        if (!raw) return '';
        const direct = raw.match(/\b[a-f0-9]{32}\b/i);
        return direct ? direct[0].toLowerCase() : '';
    }

    async function fetchWithTimeout(resource, options = {}, timeoutMs = 10000) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(resource, {
                ...options,
                signal: controller.signal
            });
        } catch (error) {
            if (error && error.name === 'AbortError') {
                throw new Error(`Request timed out after ${Math.ceil(timeoutMs / 1000)} seconds`);
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    function buildInstallUrlForToken(configToken) {
        if (!isValidSessionToken(configToken)) return '';
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const baseUrl = isLocalhost ? 'http://localhost:7001' : window.location.origin;
        return `${baseUrl}/addon/${encodeURIComponent(configToken)}/manifest.json`;
    }

    function buildConfigUrlForToken(configToken) {
        if (!isValidSessionToken(configToken)) return '';
        return `${window.location.origin}/configure?config=${encodeURIComponent(configToken)}`;
    }

    function buildHistoryUrlForToken(configToken) {
        if (!isValidSessionToken(configToken)) return '';
        return `/sub-history?config=${encodeURIComponent(configToken)}`;
    }

    function syncActiveInstallState(configOverride, options = {}) {
        const hasExplicitOverride = arguments.length > 0;
        const token = isValidSessionToken(configOverride)
            ? configOverride
            : (hasExplicitOverride ? '' : getActiveConfigRef());
        if (!isValidSessionToken(token)) {
            clearActiveInstallState();
            return;
        }

        const installUrl = buildInstallUrlForToken(token);
        const installBtn = document.getElementById('installBtn');
        const copyBtn = document.getElementById('copyBtn');
        const installUrlBox = document.getElementById('installUrlBox');
        const installUrlDisplay = document.getElementById('installUrlDisplay');

        window.installUrl = installUrl;
        if (installBtn) installBtn.disabled = false;
        if (copyBtn) copyBtn.disabled = false;
        if (installUrlDisplay) installUrlDisplay.value = installUrl;
        if (installUrlBox) installUrlBox.classList.add('show');

        if (options.selectDisplay === true && installUrlDisplay) {
            setTimeout(() => {
                try { installUrlDisplay.select(); } catch (_) { }
            }, 100);
        }
    }

    function hideActiveInstallState() {
        revealedInstallToken = '';
        clearActiveInstallState();
    }

    function revealActiveInstallState(token, options = {}) {
        const normalizedToken = extractSessionTokenFromInput(token);
        if (!isValidSessionToken(normalizedToken)) {
            hideActiveInstallState();
            return;
        }
        revealedInstallToken = normalizedToken;
        syncActiveInstallState(normalizedToken, options);
    }

    function reconcileActiveInstallState(options = {}) {
        const activeToken = getActiveConfigRef();
        const visibleToken = resolveVisibleInstallToken({
            activeToken,
            revealedToken: revealedInstallToken,
            configDirty
        });

        if (!visibleToken) {
            if (!isValidSessionToken(activeToken) || activeToken !== revealedInstallToken) {
                revealedInstallToken = '';
            }
            clearActiveInstallState();
            return;
        }

        syncActiveInstallState(visibleToken, options);
    }

    async function copyTextToClipboard(text, successMessage) {
        const value = String(text || '');
        if (!value) return false;
        try {
            await navigator.clipboard.writeText(value);
        } catch (_) {
            const input = document.createElement('input');
            input.value = value;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);
        }
        if (successMessage) {
            showAlert(successMessage, 'success');
        }
        return true;
    }

    async function fetchSessionBrief(token, options = {}) {
        if (!isValidSessionToken(token)) return null;

        const cached = tokenVaultBriefFetchCache.get(token) || null;
        if (cached && shouldUseCachedTokenVaultBrief({
            fetchedAt: cached.fetchedAt,
            maxAgeMs: options.maxAgeMs ?? TOKEN_VAULT_BRIEF_TTL_MS
        })) {
            return cached.session;
        }

        const pendingRequest = tokenVaultBriefFetchPromises.get(token);
        if (pendingRequest) {
            return pendingRequest;
        }

        const request = fetch(`/api/session-brief/${encodeURIComponent(token)}`, { cache: 'no-store' })
            .then(async (response) => {
                if (!response.ok) {
                    if (response.status === 404 || response.status === 410) {
                        rememberTokenVaultSingleBrief(token, null);
                        return null;
                    }
                    throw new Error(`Failed to fetch session brief (${response.status})`);
                }
                const data = await response.json();
                const session = data?.session || null;
                rememberTokenVaultSingleBrief(token, session);
                if (session) {
                    tokenVaultBriefMap.set(token, session);
                }
                return session;
            })
            .finally(() => {
                tokenVaultBriefFetchPromises.delete(token);
            });

        tokenVaultBriefFetchPromises.set(token, request);
        return request;
    }

    function getVaultEntryForToken(token, store = getTokenVaultStore()) {
        if (!isValidSessionToken(token)) return null;
        return store.entries.find(entry => entry.token === token) || null;
    }

    function getTokenVaultManagerToken() {
        if (isValidSessionToken(tokenVaultFocusedToken)) return tokenVaultFocusedToken;
        const activeToken = getActiveConfigRef();
        return isValidSessionToken(activeToken) ? activeToken : '';
    }

    function getTokenVaultRailMenuKeyForEntry(token = '', isDraft = false) {
        if (isDraft === true) return 'draft';
        return extractSessionTokenFromInput(token);
    }

    function ensureTokenVaultRailFloatingMenu() {
        let menu = document.getElementById('tokenVaultRailFloatingMenu');
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'tokenVaultRailFloatingMenu';
            menu.className = 'token-vault-rail-floating-menu';
            menu.setAttribute('role', 'menu');
            menu.setAttribute('aria-hidden', 'true');
            document.body.appendChild(menu);
        }
        if (!menu.__vaultBound) {
            menu.__vaultBound = true;
            menu.addEventListener('click', async (e) => {
                const actionEl = e.target && e.target.closest ? e.target.closest('[data-vault-action]') : null;
                e.stopPropagation();
                if (!actionEl) return;
                e.preventDefault();
                try {
                    await handleTokenVaultAction(actionEl);
                } catch (error) {
                    showAlert(error.message || 'Token Vault action failed.', 'error');
                }
            });
        }
        return menu;
    }

    function getTokenVaultRailMenuToggle(menuKey) {
        const normalizedKey = String(menuKey || '').trim();
        if (!normalizedKey) return null;
        const escapedKey = window.CSS && typeof window.CSS.escape === 'function'
            ? window.CSS.escape(normalizedKey)
            : normalizedKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return document.querySelector(`#tokenVaultRail [data-vault-action="toggle-rail-menu"][data-menu-key="${escapedKey}"]`);
    }

    function getTokenVaultRailEntryForMenuKey(menuKey) {
        const normalizedKey = String(menuKey || '').trim();
        if (!normalizedKey) return null;
        return getVaultRailEntries().find(entry => getTokenVaultRailMenuKeyForEntry(entry.token, entry.isDraft) === normalizedKey) || null;
    }

    function buildTokenVaultRailMenuItems(entry) {
        if (!entry) return '';
        const actionTokenAttr = entry.token
            ? ` data-token="${escapeVaultHtml(entry.token)}"`
            : (entry.isDraft ? ' data-draft="true"' : '');
        const menuItems = [
            `<button type="button" class="token-vault-rail-menu-item" data-vault-action="manage-token"${actionTokenAttr}>Open</button>`
        ];

        if (entry.token) {
            menuItems.push(`<button type="button" class="token-vault-rail-menu-item" data-vault-action="duplicate-token"${actionTokenAttr}>Duplicate</button>`);
            menuItems.push(`<button type="button" class="token-vault-rail-menu-item" data-vault-action="export-current"${actionTokenAttr}>Export</button>`);
            if (entry.entry) {
                menuItems.push(`<button type="button" class="token-vault-rail-menu-item danger" data-vault-action="forget-token"${actionTokenAttr}>Forget</button>`);
            }
        }

        return menuItems.join('');
    }

    function hideTokenVaultRailFloatingMenu() {
        const menu = document.getElementById('tokenVaultRailFloatingMenu');
        if (!menu) return;
        menu.classList.remove('show');
        menu.setAttribute('aria-hidden', 'true');
        menu.style.left = '-9999px';
        menu.style.top = '-9999px';
        if (tokenVaultRailMenuFrame) {
            cancelAnimationFrame(tokenVaultRailMenuFrame);
            tokenVaultRailMenuFrame = 0;
        }
    }

    function positionTokenVaultRailFloatingMenu(menu, anchorEl) {
        if (!menu || !anchorEl) return;

        const anchorRect = anchorEl.getBoundingClientRect();
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const menuRect = menu.getBoundingClientRect();
        const edgePadding = 8;
        const gap = 8;

        let left = anchorRect.left - menuRect.width - gap;
        if (left < edgePadding) {
            left = anchorRect.right + gap;
        }
        left = Math.min(Math.max(edgePadding, left), Math.max(edgePadding, viewportWidth - menuRect.width - edgePadding));

        let top = anchorRect.top + (anchorRect.height / 2) - (menuRect.height / 2);
        top = Math.min(Math.max(edgePadding, top), Math.max(edgePadding, viewportHeight - menuRect.height - edgePadding));

        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
    }

    function renderTokenVaultRailFloatingMenu() {
        const menu = ensureTokenVaultRailFloatingMenu();
        if (!tokenVaultRailOpen || !tokenVaultRailMenuKey) {
            hideTokenVaultRailFloatingMenu();
            return;
        }

        const entry = getTokenVaultRailEntryForMenuKey(tokenVaultRailMenuKey);
        const anchorEl = getTokenVaultRailMenuToggle(tokenVaultRailMenuKey);
        if (!entry || !anchorEl) {
            hideTokenVaultRailFloatingMenu();
            return;
        }

        const markup = buildTokenVaultRailMenuItems(entry);
        if (menu.innerHTML !== markup) {
            menu.innerHTML = markup;
        }
        menu.setAttribute('aria-label', `${entry.railLabel} actions`);
        menu.setAttribute('aria-hidden', 'false');
        menu.style.visibility = 'hidden';
        menu.classList.add('show');
        positionTokenVaultRailFloatingMenu(menu, anchorEl);
        menu.style.visibility = '';
    }

    function scheduleTokenVaultRailFloatingMenuSync() {
        if (!tokenVaultRailMenuKey) {
            hideTokenVaultRailFloatingMenu();
            return;
        }
        if (tokenVaultRailMenuFrame) return;
        tokenVaultRailMenuFrame = requestAnimationFrame(() => {
            tokenVaultRailMenuFrame = 0;
            renderTokenVaultRailFloatingMenu();
        });
    }

    function closeTokenVaultRailMenu() {
        if (!tokenVaultRailMenuKey) return;
        tokenVaultRailMenuKey = '';
        hideTokenVaultRailFloatingMenu();
        renderTokenVaultRail();
    }

    function toggleTokenVaultRailMenu(menuKey) {
        const normalizedKey = String(menuKey || '').trim();
        const nextKey = tokenVaultRailMenuKey === normalizedKey ? '' : normalizedKey;
        if (tokenVaultRailMenuKey === nextKey) return;
        tokenVaultRailMenuKey = nextKey;
        renderTokenVaultRail();
    }

    function resetTokenVaultTitleEditor() {
        tokenVaultTitleEditToken = '';
        tokenVaultTitleEditValue = '';
    }

    function openTokenVaultTitleEditor(token, initialValue = '') {
        if (!isValidSessionToken(token)) return;
        tokenVaultTitleEditToken = token;
        tokenVaultTitleEditValue = String(initialValue || '');
        renderTokenVault();
    }

    function saveTokenVaultTitle(actionToken, activeToken) {
        if (!isValidSessionToken(actionToken)) return;

        const input = document.getElementById('tokenVaultTitleInlineInput');
        const currentBrief = tokenVaultBriefMap.get(actionToken) || null;
        const currentEntry = getVaultEntryForToken(actionToken);
        const store = getTokenVaultStore();
        const currentLabel = normalizeVaultLabel(actionToken, currentEntry?.label || '');
        const derivedLabel = deriveVaultLabel(actionToken, currentEntry?.label || '', { store });
        let label = String(input?.value || '').trim();

        if (!currentLabel && label === derivedLabel) {
            label = '';
        }

        if (label === currentLabel) {
            resetTokenVaultTitleEditor();
            renderTokenVault();
            return;
        }

        const plan = prepareTokenVaultEntryUpsert(actionToken, {
            label,
            lastOpenedAt: Date.now(),
            lastSavedAt: Number(currentEntry?.lastSavedAt) || Number(currentBrief?.updatedAt) || Number(currentEntry?.lastKnownUpdatedAt) || Date.now()
        });

        applyVaultEntryPlanWithOverflowPrompt(
            plan,
            {
                eyebrow: `${TOKEN_VAULT_MAX_ENTRIES} saved tokens max`,
                title: 'Saving this title needs one vault slot',
                message: 'Keeping this token in your browser vault will purge the oldest saved entry below.',
                detail: 'Only the local browser vault changes.',
                confirmLabel: 'Save title and replace'
            },
            { activeToken: actionToken === activeToken ? actionToken : getActiveConfigRef() },
            async () => {
                resetTokenVaultTitleEditor();
                renderTokenVault();
                showAlert('Token title saved locally.', 'success');
            }
        );
    }

    function buildDuplicateVaultLabel(token, explicitLabel, options = {}) {
        const store = options.store || getTokenVaultStore();
        const sourceLabel = deriveVaultLabel(token, explicitLabel || '', { store });
        if (!sourceLabel) return '';

        const existingLabels = new Set(
            (Array.isArray(store?.entries) ? store.entries : [])
                .map(entry => deriveVaultLabel(entry?.token || '', entry?.label || '', { store }).trim().toLowerCase())
                .filter(Boolean)
        );
        const baseLabel = `${sourceLabel} Copy`;
        let nextLabel = baseLabel;
        let suffix = 2;

        while (existingLabels.has(nextLabel.toLowerCase())) {
            nextLabel = `${baseLabel} ${suffix}`;
            suffix += 1;
        }

        return nextLabel;
    }

    function buildTokenVaultViewModel(requestedToken = '') {
        const store = getTokenVaultStore();
        const activeToken = getActiveConfigRef();
        const token = isValidSessionToken(requestedToken) ? requestedToken : '';
        const entry = token ? getVaultEntryForToken(token, store) : null;
        const isActiveToken = token && token === activeToken;
        const brief = token
            ? (tokenVaultBriefMap.get(token) || (isActiveToken ? activeSessionContext.session : null) || null)
            : null;
        const disabled = brief?.disabled === true || entry?.lastKnownDisabled === true;

        let state = token ? 'live' : getActiveTokenState();
        if (token) {
            if (isActiveToken) {
                state = getActiveTokenState();
            } else if (brief?.exists === false) {
                state = 'recovered';
            } else if (disabled) {
                state = 'disabled';
            }
        }

        let provenanceLabel = activeSessionContext.sourceLabel || 'Fresh draft';
        let provenanceMessage = activeSessionContext.message || 'No token yet. Your first save will mint one.';
        if (token && !isActiveToken) {
            if (brief?.exists === false) {
                provenanceLabel = 'Saved locally';
                provenanceMessage = 'This token still exists in your browser vault, but no live session was found on the server.';
            } else if (disabled) {
                provenanceLabel = 'Saved locally';
                provenanceMessage = 'This token is disabled, so addon, toolbox, and history routes stay blocked until you re-enable it.';
            } else {
                provenanceLabel = 'Saved locally';
                provenanceMessage = 'Ready to switch, copy, export, or open linked routes.';
            }
        }

        const createdAt = Number(brief?.createdAt) || Number(entry?.lastKnownCreatedAt) || 0;
        const updatedAt = Number(brief?.updatedAt) || Number(entry?.lastKnownUpdatedAt) || createdAt || 0;
        const lastAccessedAt = Number(brief?.lastAccessedAt) || Number(entry?.lastKnownLastAccessedAt) || updatedAt || 0;

        return {
            token,
            brief,
            entry,
            state,
            disabled,
            isDraft: !token,
            isActiveToken: !!isActiveToken,
            label: deriveVaultLabel(token, entry?.label || '', { store }),
            provenanceLabel,
            provenanceMessage,
            createdAt,
            updatedAt,
            lastAccessedAt,
            canUseRoutes: isValidSessionToken(token) && disabled !== true && brief?.exists !== false,
            routeStateLabel: !token
                ? 'Awaiting first save'
                : (brief?.exists === false ? 'Missing on server' : (disabled ? 'Blocked' : 'Enabled'))
        };
    }

    function getVaultStateLabel(state, isActiveToken = false) {
        if (state === 'draft') return 'Draft';
        if (state === 'disabled') return 'Off';
        if (state === 'recovered') return 'Lost';
        return isActiveToken ? 'Current' : 'Saved';
    }

    function getVaultRailEntries() {
        const store = getTokenVaultStore();
        const activeToken = getActiveConfigRef();
        const entryLimit = isValidSessionToken(activeToken) ? TOKEN_VAULT_RAIL_LIMIT : (TOKEN_VAULT_RAIL_LIMIT + 1);
        const entries = [];
        const seen = new Set();
        const pushToken = (token) => {
            if (!isValidSessionToken(token) || seen.has(token) || entries.length >= entryLimit) return;
            const view = buildTokenVaultViewModel(token);
            entries.push({
                key: token,
                ...view,
                railLabel: view.label,
                railMeta: `${maskToken(token)} / ${view.updatedAt ? `saved ${formatVaultRelative(view.updatedAt)}` : 'saved locally'}`
            });
            seen.add(token);
        };

        if (!isValidSessionToken(activeToken)) {
            const draftView = buildTokenVaultViewModel('');
            entries.push({
                key: 'draft',
                ...draftView,
                railLabel: draftView.label,
                railMeta: activeSessionContext.message || 'First save creates a token'
            });
        } else {
            pushToken(activeToken);
        }

        sortVaultEntries(store.entries).forEach(entry => {
            pushToken(entry.token);
        });

        return entries.slice(0, entryLimit);
    }

    function renderTokenVaultRail(options = {}) {
        const rail = document.getElementById('tokenVaultRail');
        const list = document.getElementById('tokenVaultRailList');
        const launcher = document.getElementById('tokenVaultLauncher');
        if (!rail || !list || !launcher) return;

        const entries = getVaultRailEntries();
        const activeToken = getActiveConfigRef();
        const store = getTokenVaultStore();
        const draftAlreadyActive = !activeToken && activeSessionContext.provenance === 'draft';
        const savedCount = getTokenVaultDisplayCount(store, activeToken);
        const addTokenLabel = 'Add Profile';
        const addTokenMeta = draftAlreadyActive
            ? 'Draft already open. Create, import, or back up profiles from here.'
            : (savedCount >= TOKEN_VAULT_MAX_ENTRIES
                ? 'Vault full. New imports or saves will ask before replacing the oldest token.'
                : 'Create, import, or restore profiles from here.');
        const addTokenHtml = `<button type="button" class="token-vault-rail-add" data-vault-action="open-creator" style="--vault-index:0;">
            <span class="token-vault-rail-add-icon" aria-hidden="true">+</span>
            <span class="token-vault-rail-add-main">
                <span class="token-vault-rail-add-title">${escapeVaultHtml(addTokenLabel)}</span>
                <span class="token-vault-rail-add-meta">${escapeVaultHtml(addTokenMeta)}</span>
            </span>
            <span class="token-vault-rail-add-cap">${savedCount}/${TOKEN_VAULT_MAX_ENTRIES}</span>
        </button>`;
        const validMenuKeys = new Set(
            entries
                .map(entry => getTokenVaultRailMenuKeyForEntry(entry.token, entry.isDraft))
                .filter(Boolean)
        );
        if (tokenVaultRailMenuKey && !validMenuKeys.has(tokenVaultRailMenuKey)) {
            tokenVaultRailMenuKey = '';
        }
        rail.classList.toggle('show', tokenVaultRailOpen);
        rail.setAttribute('aria-hidden', tokenVaultRailOpen ? 'false' : 'true');
        launcher.setAttribute('aria-expanded', tokenVaultRailOpen ? 'true' : 'false');

        if (!tokenVaultRailOpen && options.forceContent !== true) {
            hideTokenVaultRailFloatingMenu();
            scheduleFloatingBottomSafeZoneSync();
            return;
        }

        let markup = '';
        if (entries.length === 0) {
            markup = `${addTokenHtml}<div class="token-vault-rail-empty" style="--vault-index:1;">
                <strong>Token Vault</strong>
                <span>Save or import a token to start building a switchable history.</span>
            </div>`;
        } else {
            markup = addTokenHtml + entries.map((entry, index) => {
                const stateLabel = getVaultStateLabel(entry.state, entry.isActiveToken);
                const canToggle = !entry.isDraft;
                const switchDisabled = !entry.token || entry.isActiveToken;
                const actionTokenAttr = entry.token
                    ? ` data-token="${escapeVaultHtml(entry.token)}"`
                    : (entry.isDraft ? ' data-draft="true"' : '');
                const menuKey = getTokenVaultRailMenuKeyForEntry(entry.token, entry.isDraft);
                const menuOpen = menuKey && tokenVaultRailMenuKey === menuKey;

                const openLabel = entry.isDraft
                    ? 'Open current draft'
                    : `Open ${entry.railLabel}`;

                return `<article class="token-vault-rail-item ${escapeVaultHtml(entry.state)} ${entry.isActiveToken ? 'is-active' : ''} ${menuOpen ? 'menu-open' : ''}" style="--vault-index:${index + 1};">
                    <button type="button" class="token-vault-rail-main" data-vault-action="manage-token"${actionTokenAttr} aria-label="${escapeVaultHtml(openLabel)}">
                        <span class="token-vault-rail-title-row">
                            <strong>${escapeVaultHtml(entry.railLabel)}</strong>
                            <span class="token-vault-inline-chip ${escapeVaultHtml(entry.state)}">${escapeVaultHtml(stateLabel)}</span>
                        </span>
                        <span class="token-vault-rail-meta">${escapeVaultHtml(entry.railMeta)}</span>
                    </button>
                    <div class="token-vault-rail-actions">
                        <button type="button" class="token-vault-rail-shortcut" data-vault-action="switch-token" data-token="${escapeVaultHtml(entry.token || '')}" ${switchDisabled ? 'disabled' : ''}>${entry.isActiveToken ? 'Live' : 'Use'}</button>
                        ${canToggle ? `<button type="button" class="token-vault-rail-shortcut ${entry.disabled ? '' : 'danger'}" data-vault-action="toggle-state" data-token="${escapeVaultHtml(entry.token)}">${entry.disabled ? 'Enable' : 'Disable'}</button>` : ''}
                        <div class="token-vault-rail-menu ${menuOpen ? 'is-open' : ''}">
                            <button type="button" class="token-vault-rail-menu-toggle" data-vault-action="toggle-rail-menu" data-menu-key="${escapeVaultHtml(menuKey)}"${actionTokenAttr} aria-haspopup="menu" aria-expanded="${menuOpen ? 'true' : 'false'}" aria-controls="tokenVaultRailFloatingMenu" aria-label="${escapeVaultHtml(`${entry.railLabel} actions`)}"><span class="token-vault-rail-menu-dots" aria-hidden="true"><span></span><span></span><span></span></span></button>
                        </div>
                    </div>
                </article>`;
            }).join('');
        }

        if (!list.hasChildNodes() || tokenVaultRailRenderedMarkup !== markup) {
            list.innerHTML = markup;
            tokenVaultRailRenderedMarkup = markup;
        }
        renderTokenVaultRailFloatingMenu();
        scheduleFloatingBottomSafeZoneSync();
    }

    async function refreshTokenVaultData(optionsOrForce = false) {
        const options = normalizeTokenVaultRefreshOptions(optionsOrForce);
        const modalOpen = document.getElementById('tokenVaultModal')?.classList.contains('show');
        const creatorOpen = document.getElementById('tokenVaultCreateModal')?.classList.contains('show');
        if (!options.force && !options.background && tokenVaultLoaded && !modalOpen && !creatorOpen && !tokenVaultRailOpen) {
            return;
        }

        const tokens = getTokenVaultRefreshTokens();
        const tokensKey = tokens.join(',');
        if (tokens.length === 0) {
            tokenVaultBriefMap = new Map();
            tokenVaultLoaded = true;
            tokenVaultLastRefreshAt = Date.now();
            tokenVaultLastRefreshKey = '';
            if (modalOpen) {
                renderTokenVault();
            } else if (tokenVaultRailOpen) {
                renderTokenVaultRail();
            }
            return;
        }
        if (!shouldRefreshTokenVaultBriefs({
            force: options.force,
            loaded: tokenVaultLoaded,
            tokensKey,
            lastTokensKey: tokenVaultLastRefreshKey,
            lastRefreshAt: tokenVaultLastRefreshAt,
            maxAgeMs: TOKEN_VAULT_BRIEF_TTL_MS
        })) {
            return;
        }
        if (tokenVaultRefreshPromise) {
            return tokenVaultRefreshPromise;
        }

        tokenVaultRefreshing = true;
        tokenVaultRefreshPromise = (async () => {
            const response = await fetch('/api/session-briefs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                cache: 'no-store',
                body: JSON.stringify({ tokens })
            });
            if (!response.ok) {
                throw new Error(`Failed to refresh token vault (${response.status})`);
            }

            const data = await response.json();
            const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
            const refreshedAt = Date.now();
            const nextBriefMap = new Map();
            sessions.forEach(session => {
                if (isValidSessionToken(session?.token)) {
                    nextBriefMap.set(session.token, session);
                    rememberTokenVaultSingleBrief(session.token, session.exists === false ? null : session, refreshedAt);
                    if (session.exists) {
                        syncTokenVaultEntryWithBrief(session.token, session, {}, { ifExistsOnly: true });
                    }
                }
            });
            tokenVaultBriefMap = nextBriefMap;

            const liveActiveToken = getActiveConfigRef();
            if (isValidSessionToken(liveActiveToken)) {
                const activeBrief = nextBriefMap.get(liveActiveToken)
                    || (activeSessionContext.token === liveActiveToken ? activeSessionContext.session : null);
                if (activeBrief && activeBrief.exists === false) {
                    try { localStorage.removeItem(TOKEN_KEY); } catch (_) { }
                    setActiveSessionContext({
                        token: '',
                        provenance: 'recovered',
                        sourceLabel: 'Recovered draft',
                        message: 'The saved token no longer exists on the server. Save to mint a replacement.',
                        session: null,
                        recoveredFromToken: liveActiveToken,
                        regenerated: true
                    });
                } else {
                    setActiveSessionContext({ token: liveActiveToken, session: activeBrief || null });
                    safelyBackfillActiveTokenIntoVault({
                        activeToken: liveActiveToken,
                        session: activeBrief || null,
                        render: false
                    });
                }
            }

            tokenVaultLoaded = true;
            tokenVaultLastRefreshAt = refreshedAt;
            tokenVaultLastRefreshKey = tokensKey;

            if (modalOpen) {
                renderTokenVault();
            } else if (tokenVaultRailOpen) {
                renderTokenVaultRail();
            }
        })().catch((error) => {
            console.warn('[TokenVault] Failed to refresh vault metadata', error);
            if (modalOpen || creatorOpen || tokenVaultRailOpen) {
                showAlert(`Failed to refresh token vault: ${error.message}`, 'warning');
            }
        }).finally(() => {
            tokenVaultRefreshing = false;
            tokenVaultRefreshPromise = null;
        });

        return tokenVaultRefreshPromise;
    }

    function renderTokenVault(options = {}) {
        renderTokenVaultRail();

        const modalOpen = document.getElementById('tokenVaultModal')?.classList.contains('show');
        if (!modalOpen && options.forceContent !== true) return;

        const content = document.getElementById('tokenVaultContent');
        if (!content) return;

        const selectedToken = getTokenVaultManagerToken();
        const selected = buildTokenVaultViewModel(selectedToken);
        const store = getTokenVaultStore();
        const selectedLabel = selected.label;
        const isTitleEditing = !!selected.token && tokenVaultTitleEditToken === selected.token;
        const titleEditorValue = isTitleEditing ? tokenVaultTitleEditValue : '';
        const pendingSwitch = tokenVaultPendingSwitch && isValidSessionToken(tokenVaultPendingSwitch)
            ? deriveVaultLabel(tokenVaultPendingSwitch, getVaultEntryForToken(tokenVaultPendingSwitch, store)?.label || '', { store })
            : '';
        const managerTokenAttr = selected.token ? ` data-token="${escapeVaultHtml(selected.token)}"` : '';
        const titleMarkup = !selected.token
            ? `<h3>${escapeVaultHtml(selectedLabel)}</h3>`
            : (isTitleEditing
                ? `<div class="token-vault-title-editor">
                        <input type="text" id="tokenVaultTitleInlineInput" class="token-vault-title-input" value="${escapeVaultHtml(titleEditorValue)}" placeholder="${escapeVaultHtml(selectedLabel)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
                        <button type="button" class="token-vault-mini-btn token-vault-title-save" data-vault-action="save-label"${managerTokenAttr}>Save</button>
                    </div>
                    <div class="token-vault-title-hint is-editing">Editing title. Press Enter to save.</div>`
                : `<button type="button" class="token-vault-title-trigger" data-vault-action="edit-title"${managerTokenAttr}>
                        <span class="token-vault-title-trigger-text">${escapeVaultHtml(selectedLabel)}</span>
                        <span class="token-vault-title-hint">Click to rename</span>
                    </button>`);
        const heroBadges = [
            `<span class="token-vault-status-chip ${escapeVaultHtml(selected.state)}">${escapeVaultHtml(getVaultStateLabel(selected.state, selected.isActiveToken))}</span>`,
            `<span class="token-vault-meta-chip">${escapeVaultHtml(selected.isDraft ? 'Unsaved page' : (selected.isActiveToken ? 'Active on this page' : 'Saved in vault'))}</span>`
        ].join('');

        const markup = `<div class="token-vault-manager">
            ${tokenVaultPendingSwitch ? `<section class="token-vault-confirm">
                <div>
                    <strong>Unsaved changes detected</strong>
                    <p>Switch to ${escapeVaultHtml(pendingSwitch)} without losing your current edits?</p>
                </div>
                <div class="token-vault-confirm-actions">
                    <button type="button" class="token-vault-action token-vault-action-primary" data-vault-action="switch-save">Save then switch</button>
                    <button type="button" class="token-vault-action" data-vault-action="switch-discard">Switch now</button>
                    <button type="button" class="token-vault-action" data-vault-action="switch-cancel">Stay here</button>
                </div>
            </section>` : ''}

            <section class="token-vault-hero ${escapeVaultHtml(selected.state)}">
                <div class="token-vault-hero-top">
                    <div class="token-vault-hero-copy">
                        <div class="token-vault-eyebrow">Selected profile</div>
                        ${titleMarkup}
                        <p>${escapeVaultHtml(selected.provenanceLabel)} - ${escapeVaultHtml(selected.provenanceMessage)}</p>
                    </div>
                    <div class="token-vault-badges">${heroBadges}</div>
                </div>
                <div class="token-vault-token-row">
                    <code class="token-vault-token">${escapeVaultHtml(selected.token ? (tokenVaultReveal ? selected.token : maskToken(selected.token)) : 'No token loaded')}</code>
                    <button type="button" class="token-vault-mini-btn" data-vault-action="reveal-token" ${selected.token ? '' : 'disabled'}>${tokenVaultReveal ? 'Hide' : 'Reveal'}</button>
                    <button type="button" class="token-vault-mini-btn" data-vault-action="copy-token"${managerTokenAttr} ${selected.token ? '' : 'disabled'}>Copy token</button>
                </div>
                <div class="token-vault-hero-actions">
                    <button type="button" class="token-vault-action token-vault-action-primary" data-vault-action="switch-token"${managerTokenAttr} ${selected.token && !selected.isActiveToken ? '' : 'disabled'}>${selected.isDraft ? 'Current page draft' : (selected.isActiveToken ? 'Already live' : 'Use on this page')}</button>
                    <button type="button" class="token-vault-action ${selected.disabled ? 'token-vault-action-success' : 'token-vault-action-warning'}" data-vault-action="toggle-state"${managerTokenAttr} ${selected.token ? '' : 'disabled'}>${selected.disabled ? 'Enable token' : 'Disable token'}</button>
                    <button type="button" class="token-vault-action" data-vault-action="export-current"${managerTokenAttr} ${selected.token ? '' : 'disabled'}>Export this token</button>
                    <button type="button" class="token-vault-action token-vault-action-danger" data-vault-action="forget-token"${managerTokenAttr} ${selected.token && selected.entry ? '' : 'disabled'}>Forget this token</button>
                </div>
                <div class="token-vault-stats">
                    <div><span>Created</span><strong>${escapeVaultHtml(formatVaultDate(selected.createdAt))}</strong></div>
                    <div><span>Updated</span><strong>${escapeVaultHtml(formatVaultDate(selected.updatedAt))}</strong></div>
                    <div><span>Last used</span><strong>${escapeVaultHtml(formatVaultDate(selected.lastAccessedAt))}</strong></div>
                    <div><span>Route state</span><strong>${escapeVaultHtml(selected.routeStateLabel)}</strong></div>
                </div>
                <div class="token-vault-security-warning" role="note">
                    <strong>Careful!</strong> Your token gives full access to your config (including API keys).
                </div>
            </section>

            <section class="token-vault-actions-card">
                <div class="token-vault-section-title">Launch and access</div>
                <p class="token-vault-section-copy">Everything that makes this profile callable lives here. Add/import and full-vault tools now live under the rail's Add Profile button.</p>
                <div class="token-vault-action-grid">
                    <button type="button" class="token-vault-action token-vault-action-primary" data-vault-action="copy-manifest"${managerTokenAttr} ${selected.token ? '' : 'disabled'}>Copy manifest URL</button>
                    <button type="button" class="token-vault-action" data-vault-action="copy-config-url"${managerTokenAttr} ${selected.token ? '' : 'disabled'}>Copy config URL</button>
                    <button type="button" class="token-vault-action" data-vault-action="install-addon"${managerTokenAttr} ${selected.token ? '' : 'disabled'}>Install in Stremio</button>
                    <button type="button" class="token-vault-action" data-vault-action="open-toolbox"${managerTokenAttr} ${selected.canUseRoutes ? '' : 'disabled'}>Open Sub Toolbox</button>
                    <button type="button" class="token-vault-action" data-vault-action="open-history"${managerTokenAttr} ${selected.canUseRoutes ? '' : 'disabled'}>Open history</button>
                    <button type="button" class="token-vault-action" data-vault-action="validate-token"${managerTokenAttr} ${selected.token ? '' : 'disabled'}>Validate token</button>
                </div>
            </section>
        </div>`;

        if (!content.hasChildNodes() || tokenVaultManagerRenderedMarkup !== markup) {
            content.innerHTML = markup;
            tokenVaultManagerRenderedMarkup = markup;
        }

        if (isTitleEditing) {
            requestAnimationFrame(() => {
                const input = document.getElementById('tokenVaultTitleInlineInput');
                if (!input) return;
                input.focus();
                input.select();
            });
        }
    }

    function createTokenVaultCreatorPreviewState(overrides = {}) {
        return {
            token: '',
            tone: 'idle',
            statusLabel: 'Idle',
            title: 'Token preview',
            message: 'Paste a token or URL to preview it before importing.',
            meta: '',
            canImport: false,
            ...overrides
        };
    }

    function getTokenVaultCreatorPreviewMarkup() {
        const preview = tokenVaultCreatorPreview || createTokenVaultCreatorPreviewState();
        const hasToken = isValidSessionToken(preview.token);
        return `<div class="token-vault-create-preview-head">
                <span class="token-vault-inline-chip ${escapeVaultHtml(preview.tone)}">${escapeVaultHtml(preview.statusLabel)}</span>
                ${hasToken ? `<code>${escapeVaultHtml(maskToken(preview.token))}</code>` : ''}
            </div>
            <strong>${escapeVaultHtml(preview.title)}</strong>
            <p>${escapeVaultHtml(preview.message)}</p>
            ${preview.meta ? `<div class="token-vault-create-preview-meta">${escapeVaultHtml(preview.meta)}</div>` : ''}`;
    }

    function syncTokenVaultCreatorPreviewUi() {
        const input = document.getElementById('tokenVaultCreateInput');
        const previewEl = document.getElementById('tokenVaultCreatePreview');
        const importBtn = document.getElementById('tokenVaultCreateImportBtn');
        if (input && input.value !== tokenVaultCreatorInputValue) {
            const wasFocused = document.activeElement === input;
            const selectionStart = input.selectionStart;
            const selectionEnd = input.selectionEnd;
            input.value = tokenVaultCreatorInputValue;
            if (wasFocused) {
                input.focus();
                try {
                    input.setSelectionRange(selectionStart, selectionEnd);
                } catch (_) { }
            }
        }
        if (previewEl) {
            const tone = tokenVaultCreatorPreview?.tone || 'idle';
            const markup = getTokenVaultCreatorPreviewMarkup();
            if (previewEl.dataset.tone !== tone) {
                previewEl.dataset.tone = tone;
            }
            if (!previewEl.hasChildNodes() || tokenVaultCreatorPreviewRenderedMarkup !== markup) {
                previewEl.innerHTML = markup;
                tokenVaultCreatorPreviewRenderedMarkup = markup;
            }
        }
        if (importBtn) {
            const shouldDisable = !(tokenVaultCreatorPreview?.canImport === true);
            if (importBtn.disabled !== shouldDisable) {
                importBtn.disabled = shouldDisable;
            }
        }
    }

    function buildTokenVaultCreatorPreviewFromBrief(token, brief) {
        const store = getTokenVaultStore();
        const entry = getVaultEntryForToken(token, store);
        const activeToken = getActiveConfigRef();
        const isActiveToken = token === activeToken;
        const label = deriveVaultLabel(token, entry?.label || '', { store });
        const liveBrief = brief?.exists === false ? null : brief;
        const disabled = liveBrief?.disabled === true || entry?.lastKnownDisabled === true;
        const updatedAt = Number(liveBrief?.updatedAt) || Number(entry?.lastKnownUpdatedAt) || 0;
        const metaParts = [maskToken(token)];
        if (updatedAt) metaParts.push(`Updated ${formatVaultRelative(updatedAt)}`);
        if (isActiveToken) {
            metaParts.push('Current page');
        } else if (entry) {
            metaParts.push('Saved locally');
        }

        if (isActiveToken) {
            return createTokenVaultCreatorPreviewState({
                token,
                tone: disabled ? 'disabled' : 'live',
                statusLabel: disabled ? 'Current / off' : 'Current page',
                title: label,
                message: disabled
                    ? 'Already on this page, but live routes are off.'
                    : 'Already on this page.',
                meta: metaParts.join(' · '),
                canImport: true
            });
        }

        if (!liveBrief) {
            return createTokenVaultCreatorPreviewState({
                token,
                tone: 'recovered',
                statusLabel: entry ? 'Saved locally' : 'Missing live session',
                title: label,
                message: entry
                    ? 'Saved locally. No live session found right now.'
                    : 'No live session found. You can still import it locally.',
                meta: metaParts.join(' · '),
                canImport: true
            });
        }

        if (disabled) {
            return createTokenVaultCreatorPreviewState({
                token,
                tone: 'disabled',
                statusLabel: entry ? 'Saved / off' : 'Disabled live',
                title: label,
                message: entry
                    ? 'Saved locally and currently disabled.'
                    : 'Live session found, but it is disabled.',
                meta: metaParts.join(' · '),
                canImport: true
            });
        }

        return createTokenVaultCreatorPreviewState({
            token,
            tone: 'live',
            statusLabel: entry ? 'Already saved' : 'Ready to import',
            title: label,
            message: entry
                ? 'Already saved locally.'
                : 'Ready to save in this browser.',
            meta: metaParts.join(' · '),
            canImport: true
        });
    }

    async function refreshTokenVaultCreatorPreview(token, lookupSeq) {
        const activeBrief = token === getActiveConfigRef() ? activeSessionContext.session : null;
        const cachedBrief = tokenVaultBriefMap.get(token) || activeBrief || null;
        try {
            const brief = cachedBrief !== null ? cachedBrief : await fetchSessionBrief(token);
            if (lookupSeq !== tokenVaultCreatorPreviewSeq) return;
            if (brief) {
                tokenVaultBriefMap.set(token, brief);
                rememberTokenVaultSingleBrief(token, brief);
            }
            tokenVaultCreatorPreview = buildTokenVaultCreatorPreviewFromBrief(token, brief);
        } catch (error) {
            if (lookupSeq !== tokenVaultCreatorPreviewSeq) return;
            const store = getTokenVaultStore();
            const entry = getVaultEntryForToken(token, store);
            tokenVaultCreatorPreview = createTokenVaultCreatorPreviewState({
                token,
                tone: 'error',
                statusLabel: 'Preview unavailable',
                title: deriveVaultLabel(token, entry?.label || '', { store }),
                message: `${error.message}. You can still import the token locally if you want.`,
                meta: maskToken(token),
                canImport: true
            });
        }
        syncTokenVaultCreatorPreviewUi();
    }

    function scheduleTokenVaultCreatorPreview(rawValue, options = {}) {
        tokenVaultCreatorInputValue = String(rawValue || '');
        if (tokenVaultCreatorPreviewTimer) {
            clearTimeout(tokenVaultCreatorPreviewTimer);
            tokenVaultCreatorPreviewTimer = null;
        }

        const trimmed = tokenVaultCreatorInputValue.trim();
        const token = extractSessionTokenFromInput(trimmed);
        if (!trimmed) {
            tokenVaultCreatorPreview = createTokenVaultCreatorPreviewState();
            syncTokenVaultCreatorPreviewUi();
            return;
        }

        if (!token) {
            tokenVaultCreatorPreview = createTokenVaultCreatorPreviewState({
                tone: 'idle',
                statusLabel: 'Need token',
                message: 'Paste a full token, manifest URL, or config URL.',
                canImport: false
            });
            syncTokenVaultCreatorPreviewUi();
            return;
        }

        const store = getTokenVaultStore();
        const entry = getVaultEntryForToken(token, store);
        tokenVaultCreatorPreview = createTokenVaultCreatorPreviewState({
            token,
            tone: 'checking',
            statusLabel: 'Checking',
            title: deriveVaultLabel(token, entry?.label || '', { store }),
            message: 'Checking token details.',
            meta: maskToken(token),
            canImport: true
        });
        syncTokenVaultCreatorPreviewUi();

        const lookupSeq = ++tokenVaultCreatorPreviewSeq;
        const runLookup = () => {
            tokenVaultCreatorPreviewTimer = null;
            void refreshTokenVaultCreatorPreview(token, lookupSeq);
        };
        if (options.immediate === true) {
            runLookup();
        } else {
            tokenVaultCreatorPreviewTimer = setTimeout(runLookup, 220);
        }
    }

    function resetTokenVaultCreatorState(options = {}) {
        if (tokenVaultCreatorPreviewTimer) {
            clearTimeout(tokenVaultCreatorPreviewTimer);
            tokenVaultCreatorPreviewTimer = null;
        }
        tokenVaultCreatorPreviewSeq += 1;
        if (options.preserveInput !== true) {
            tokenVaultCreatorInputValue = '';
        }
        tokenVaultCreatorPreview = createTokenVaultCreatorPreviewState();
    }

    function renderTokenVaultCreator(options = {}) {
        const modalOpen = document.getElementById('tokenVaultCreateModal')?.classList.contains('show');
        if (!modalOpen && options.forceContent !== true) return;

        const content = document.getElementById('tokenVaultCreateContent');
        if (!content) return;

        const store = getTokenVaultStore();
        const activeToken = getActiveConfigRef();
        const savedCount = getTokenVaultDisplayCount(store, activeToken);
        const vaultFill = Math.max(savedCount > 0 ? 18 : 0, Math.round((savedCount / TOKEN_VAULT_MAX_ENTRIES) * 100));
        const nextOverflowVictim = getDraftOverflowVictims(store)[0] || null;
        const draftAlreadyActive = !activeToken && activeSessionContext.provenance === 'draft';
        const toolsNote = savedCount >= TOKEN_VAULT_MAX_ENTRIES
            ? `Next replacement: ${nextOverflowVictim ? deriveVaultLabel(nextOverflowVictim.token, nextOverflowVictim.label || '', { store }) : 'oldest profile'}.`
            : `${TOKEN_VAULT_MAX_ENTRIES - savedCount} slot${TOKEN_VAULT_MAX_ENTRIES - savedCount === 1 ? '' : 's'} open.`;
        const fileToolsMeta = 'Single-profile and full-vault JSON supported.';
        const previewMarkup = getTokenVaultCreatorPreviewMarkup();

        const markup = `<div class="token-vault-create-flow">
            <section class="token-vault-create-card token-vault-create-card-primary">
                <div class="token-vault-create-card-head">
                    <div class="token-vault-create-card-copy">
                        <div class="token-vault-section-title">Add a profile or import a token</div>
                    </div>
                    <span class="token-vault-status-chip ${escapeVaultHtml(savedCount >= TOKEN_VAULT_MAX_ENTRIES ? 'disabled' : 'live')}">${savedCount}/${TOKEN_VAULT_MAX_ENTRIES} profiles</span>
                </div>
                <div class="token-vault-create-primary-stack">
                    <button type="button" class="token-vault-action token-vault-action-primary token-vault-create-draft-btn" id="tokenVaultCreateDraftBtn" data-vault-action="create-draft-fork" ${draftAlreadyActive ? 'disabled' : ''}>${draftAlreadyActive ? 'Draft already open' : 'Add new profile'}</button>
                    <span class="token-vault-create-hint">${escapeVaultHtml(draftAlreadyActive ? 'Save when you want the next token minted.' : 'Starts from a clean default config.')}</span>
                </div>
                <div class="token-vault-create-import-block">
                    <div class="token-vault-create-divider"><span>Or import a token</span></div>
                    <div class="token-vault-import-row">
                        <input type="text" id="tokenVaultCreateInput" class="token-vault-import-input" value="${escapeVaultHtml(tokenVaultCreatorInputValue)}" placeholder="Paste token, manifest URL, or config URL" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false">
                        <div class="token-vault-import-actions">
                            <button type="button" class="token-vault-action" data-vault-action="paste-clipboard">Paste</button>
                            <button type="button" class="token-vault-action token-vault-action-primary" id="tokenVaultCreateImportBtn" data-vault-action="import-paste" ${tokenVaultCreatorPreview?.canImport === true ? '' : 'disabled'}>Import token</button>
                        </div>
                    </div>
                    <div class="token-vault-create-preview" id="tokenVaultCreatePreview" data-tone="${escapeVaultHtml(tokenVaultCreatorPreview?.tone || 'idle')}">${previewMarkup}</div>
                </div>
            </section>

            <section class="token-vault-create-card">
                <div class="token-vault-create-tools-top">
                    <div class="token-vault-create-card-copy">
                        <div class="token-vault-section-title">File import and vault tools</div>
                        <div class="token-vault-create-card-meta">${escapeVaultHtml(fileToolsMeta)}</div>
                    </div>
                </div>
                <div class="token-vault-create-meter">
                    <span class="token-vault-create-meter-fill" style="width:${vaultFill}%;"></span>
                </div>
                <div class="token-vault-create-tools-note">${escapeVaultHtml(toolsNote)}</div>
                <div class="token-vault-create-actions">
                    <button type="button" class="token-vault-action" data-vault-action="import-file">Import from file</button>
                    <button type="button" class="token-vault-action" data-vault-action="export-all" ${savedCount > 0 ? '' : 'disabled'}>Export vault</button>
                </div>
            </section>
        </div>`;

        if (!content.hasChildNodes() || tokenVaultCreatorRenderedMarkup !== markup) {
            content.innerHTML = markup;
            tokenVaultCreatorRenderedMarkup = markup;
            tokenVaultCreatorPreviewRenderedMarkup = previewMarkup;
        }

        syncTokenVaultCreatorPreviewUi();
    }

    function openTokenVaultCreator() {
        closeTokenVaultRail();
        resetTokenVaultCreatorState();
        renderTokenVaultCreator({ forceContent: true });
        openModalById('tokenVaultCreateModal');
        void refreshTokenVaultData({ background: true });
        requestAnimationFrame(() => {
            const draftBtn = document.getElementById('tokenVaultCreateDraftBtn');
            if (draftBtn && !draftBtn.disabled) {
                draftBtn.focus();
                return;
            }
            document.getElementById('tokenVaultCreateInput')?.focus();
        });
    }

    function closeTokenVaultCreator() {
        const modal = document.getElementById('tokenVaultCreateModal');
        if (!modal) return;
        modal.classList.remove('show');
        modal.style.display = 'none';
        resetTokenVaultCreatorState();
        updateBodyScrollLock();
    }

    async function pasteTokenVaultCreatorFromClipboard() {
        try {
            const clipboardText = await navigator.clipboard.readText();
            if (!clipboardText || !clipboardText.trim()) {
                showAlert('Clipboard is empty.', 'warning');
                return;
            }
            scheduleTokenVaultCreatorPreview(clipboardText, { immediate: true });
        } catch (_) {
            showAlert('Clipboard access was blocked. Paste into the field instead.', 'warning');
        }
    }

    function openTokenVault(token = '') {
        tokenVaultReveal = false;
        tokenVaultFocusedToken = isValidSessionToken(token) ? token : '';
        resetTokenVaultTitleEditor();
        closeTokenVaultRail();
        renderTokenVault({ forceContent: true });
        openModalById('tokenVaultModal');
        void refreshTokenVaultData({ background: true });
    }

    function closeTokenVault() {
        const modal = document.getElementById('tokenVaultModal');
        if (!modal) return;
        modal.classList.remove('show');
        modal.style.display = 'none';
        tokenVaultReveal = false;
        resetTokenVaultTitleEditor();
        tokenVaultPendingSwitch = '';
        tokenVaultFocusedToken = '';
        updateBodyScrollLock();
    }

    function openTokenVaultRail() {
        tokenVaultRailOpen = true;
        renderTokenVaultRail();
        void refreshTokenVaultData({ background: true });
    }

    function closeTokenVaultRail() {
        if (!tokenVaultRailOpen) return;
        tokenVaultRailOpen = false;
        tokenVaultRailMenuKey = '';
        hideTokenVaultRailFloatingMenu();
        renderTokenVaultRail();
    }

    function toggleTokenVaultRail() {
        if (tokenVaultRailOpen) {
            closeTokenVaultRail();
        } else {
            openTokenVaultRail();
        }
    }

    function consumePendingTokenVaultLauncherOpenRequest() {
        try {
            if (window.__tokenVaultLauncherOpenRequested !== true) return false;
        } catch (_) {
            return false;
        }

        const launcher = document.getElementById('tokenVaultLauncher');
        const rail = document.getElementById('tokenVaultRail');
        if (!launcher || !rail) return false;

        try {
            window.__tokenVaultLauncherOpenRequested = false;
        } catch (_) { }

        if (!tokenVaultRailOpen) {
            openTokenVaultRail();
        } else {
            renderTokenVaultRail();
        }
        return true;
    }

    function clearActiveInstallState() {
        window.installUrl = '';

        const installBtn = document.getElementById('installBtn');
        const copyBtn = document.getElementById('copyBtn');
        const installUrlBox = document.getElementById('installUrlBox');
        const installUrlDisplay = document.getElementById('installUrlDisplay');

        if (installBtn) installBtn.disabled = true;
        if (copyBtn) copyBtn.disabled = true;
        if (installUrlDisplay) installUrlDisplay.value = '';
        if (installUrlBox) installUrlBox.classList.remove('show');
    }

    function setConfigDirty(nextDirty) {
        const isDirty = nextDirty === true;
        if (isDirty) {
            hideActiveInstallState();
        }
        configDirty = isDirty;
    }

    function persistCurrentDraftToCache() {
        try {
            const previousCachedAt = localStorage.getItem(CACHE_EXPIRY_KEY);
            saveConfigToCache(currentConfig, '');
            if (previousCachedAt) {
                localStorage.setItem(CACHE_EXPIRY_KEY, previousCachedAt);
            } else {
                localStorage.removeItem(CACHE_EXPIRY_KEY);
            }
        } catch (_) {
            // no-op
        }
    }

    function syncConfigUrlForToken(token = '') {
        try {
            const nextUrl = new URL(window.location.href);
            if (isValidSessionToken(token)) {
                nextUrl.searchParams.set('config', token);
            } else {
                nextUrl.searchParams.delete('config');
            }
            const search = nextUrl.searchParams.toString();
            const normalized = `${nextUrl.pathname}${search ? `?${search}` : ''}${nextUrl.hash || ''}`;
            window.history.replaceState({}, '', normalized);
        } catch (_) {
            // no-op
        }
    }

    function syncDraftConfigUrl() {
        syncConfigUrlForToken('');
    }

    function normalizeCurrentConfigForPage() {
        if (!currentConfig) {
            currentConfig = getDefaultConfig();
        }
        currentConfig.betaModeEnabled = currentConfig.betaModeEnabled === true;
        ensureProvidersInState();
        ensureProviderParametersInState();
        ensureAutoSubsDefaults();
        const multiProviderToggleRequested = currentConfig.multiProviderEnabled === true;
        currentConfig.multiProviderEnabled = multiProviderToggleRequested;
        const requestedMainProvider = currentConfig.mainProvider || 'gemini';
        const requestedSecondaryProvider = currentConfig.secondaryProvider || '';
        currentConfig.mainProvider = String(requestedMainProvider || 'gemini').toLowerCase();
        currentConfig.secondaryProvider = String(requestedSecondaryProvider || '').toLowerCase();
        currentConfig.secondaryProviderEnabled = multiProviderToggleRequested && currentConfig.secondaryProviderEnabled === true;
        if (currentConfig.secondaryProviderEnabled && (!currentConfig.secondaryProvider || currentConfig.secondaryProvider === currentConfig.mainProvider)) {
            currentConfig.secondaryProviderEnabled = false;
        }

        currentConfig.sourceLanguages = normalizeLanguageCodes(currentConfig.sourceLanguages || []);
        currentConfig.targetLanguages = normalizeLanguageCodes(currentConfig.targetLanguages || []);
        currentConfig.noTranslationLanguages = normalizeLanguageCodes(currentConfig.noTranslationLanguages || []);
        currentConfig.learnTargetLanguages = normalizeLanguageCodes(currentConfig.learnTargetLanguages || []);
        currentConfig.learnPlacement = 'top';
        currentConfig.mobileMode = currentConfig.mobileMode === true;
        currentConfig.excludeHearingImpairedSubtitles = currentConfig.excludeHearingImpairedSubtitles === true;
        enforceLanguageLimits();
        updateLanguageLimitCopy();
    }

    function applyCurrentConfigToPage(options = {}) {
        normalizeCurrentConfigForPage();
        const previousSuppressDirtyTracking = suppressDirtyTracking;
        suppressDirtyTracking = true;
        try {
            loadConfigToForm();
        } finally {
            suppressDirtyTracking = previousSuppressDirtyTracking;
        }

        if (options.syncLocale !== false) {
            initLocale(currentConfig.uiLanguage || locale.lang || 'en');
        }
        updateToolboxLauncherVisibility();
        updateQuickStats();
        updateTokenVaultButtonState();
        if (options.selectInstallUrl === true) {
            revealActiveInstallState(getActiveConfigRef(), { selectDisplay: true });
        } else {
            reconcileActiveInstallState();
        }
        requestAnimationFrame(() => {
            positionResetBar();
            syncFloatingBottomSafeZone();
        });
    }

    function finalizeFreshTokenDraft(activeToken, vaultIsFull) {
        currentConfig = buildFreshDraftConfig({
            defaultConfig: getDefaultConfig(),
            disableSubtitleProviders: true
        });

        try { localStorage.removeItem(TOKEN_KEY); } catch (_) { }

        tokenVaultPendingSwitch = '';
        tokenVaultFocusedToken = '';
        resetTokenVaultTitleEditor();
        setActiveSessionContext({
            token: '',
            provenance: 'draft',
            sourceLabel: 'Fresh draft',
            message: vaultIsFull
                ? 'This page is detached from the live token. Saving will ask before replacing the oldest saved vault token.'
                : 'This page is detached from the live token. Save to mint a new one.',
            session: null,
            recoveredFromToken: activeToken || '',
            regenerated: false
        });
        syncDraftConfigUrl();
        persistCurrentDraftToCache();
        applyCurrentConfigToPage({ syncLocale: false });
        setConfigDirty(true);
        renderTokenVault();
        showAlert(
            vaultIsFull
                ? 'Fresh draft ready. Saving will ask before replacing the oldest local vault token.'
                : 'Fresh draft ready. Save this page to create a new token.',
            'success'
        );
    }

    function createFreshTokenDraft(options = {}) {
        const activeToken = getActiveConfigRef();
        const alreadyDraft = !activeToken && activeSessionContext.provenance === 'draft';
        const store = getTokenVaultStore();
        const captureResult = captureDetachedActiveTokenInVault({
            activeToken,
            store,
            session: activeSessionContext.session,
            allowOverflow: options.allowOverflow === true
        });
        const vaultIsFull = getTokenVaultDisplayCount(store, activeToken) >= TOKEN_VAULT_MAX_ENTRIES;

        closeTokenVaultRail();
        if (alreadyDraft) {
            showAlert('This page is already a fresh draft. Save to mint a new token.', 'info');
            return;
        }

        if (captureResult.status === 'needs-approval') {
            openTokenVaultOverridePrompt({
                eyebrow: `${TOKEN_VAULT_MAX_ENTRIES} saved tokens max`,
                title: 'Keep the current profile before opening a new draft?',
                message: 'The live profile on this page is not in your local vault yet. Keeping it switchable while starting a new draft will purge the oldest local entry below.',
                detail: 'Only the local browser vault changes. The current live token is not deleted from the server.',
                confirmLabel: 'Keep profile and continue',
                victims: captureResult.plan?.overflowVictims || [],
                onCancel: async () => {
                    renderTokenVaultCreator({ forceContent: true });
                    openModalById('tokenVaultCreateModal');
                },
                onConfirm: async () => {
                    createFreshTokenDraft({ allowOverflow: true });
                }
            });
            return;
        }
        if (captureResult.status === 'blocked') {
            showAlert('The current live profile could not be preserved locally. Draft creation was cancelled.', 'error');
            openTokenVaultCreator();
            return;
        }

        finalizeFreshTokenDraft(activeToken, vaultIsFull);
    }

    async function navigateToVaultToken(token, options = {}) {
        if (!isValidSessionToken(token)) return false;

        const currentActiveToken = getActiveConfigRef();
        if (currentActiveToken && currentActiveToken !== token) {
            const captureResult = captureDetachedActiveTokenInVault({
                activeToken: currentActiveToken,
                session: activeSessionContext.session,
                allowOverflow: options.allowOverflow === true
            });
            if (captureResult.status === 'needs-approval') {
                openTokenVaultOverridePrompt({
                    eyebrow: `${TOKEN_VAULT_MAX_ENTRIES} saved tokens max`,
                    title: 'Keep the current profile before switching?',
                    message: 'The live profile on this page is not in your local vault yet. Keeping it switchable before loading another profile will purge the oldest local entry below.',
                    detail: 'Only the local browser vault changes. The current live token is not deleted from the server.',
                    confirmLabel: 'Keep profile and switch',
                    victims: captureResult.plan?.overflowVictims || [],
                    onConfirm: async () => {
                        await navigateToVaultToken(token, { allowOverflow: true });
                    }
                });
                return false;
            }
            if (captureResult.status === 'blocked') {
                showAlert('The current live profile could not be preserved locally. Profile switch was cancelled.', 'error');
                return false;
            }
        }

        closeTokenVaultRail();
        tokenVaultPendingSwitch = '';
        resetTokenVaultTitleEditor();

        const applyTokenLoadFailure = (failureType, alertMessage, options = {}) => {
            const plan = resolveSessionLoadFailurePlan({
                loadedFromUrl: true,
                hasCachedFallback: false,
                sessionToken: token,
                failureType
            });

            if (plan.clearStoredToken === true) {
                try { localStorage.removeItem(TOKEN_KEY); } catch (_) { }
            }

            currentConfig = options.defaultConfig || getDefaultConfig();
            isFirstRun = false;

            const nextContext = {
                ...plan.context,
                ...(options.contextOverrides || {}),
                session: null
            };
            if (!plan.keepActiveToken) {
                nextContext.detachedAt = Date.now();
            }

            setActiveSessionContext(nextContext);
            saveConfigToCache(currentConfig, nextContext.token || '');
            syncConfigUrlForToken(nextContext.token || '');
            closeTokenVaultCreator();
            closeTokenVault();
            applyCurrentConfigToPage();
            setConfigDirty(false);
            if (alertMessage) {
                showAlert(alertMessage, 'warning');
            }
        };

        showLoading(true);
        try {
            const cacheBuster = `_cb=${Date.now()}`;
            const response = await fetchWithTimeout(`/api/get-session/${encodeURIComponent(token)}?${cacheBuster}&autoRegenerate=true`, {
                cache: 'no-store',
                headers: {
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache'
                }
            }, 10000);

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                const reason = errorText && errorText.trim() ? ` (${errorText.trim()})` : '';
                applyTokenLoadFailure(
                    response.status === 404 || response.status === 410 ? 'missing' : 'http',
                    response.status === 404 || response.status === 410
                        ? `That token is no longer available${reason}. Save to mint a replacement token.`
                        : `Failed to load the selected token${reason}. Using a fresh draft for now.`,
                    {
                        contextOverrides: {
                            message: response.status === 404 || response.status === 410
                                ? 'The selected token no longer exists on the server. You are editing a recovered draft until you save again.'
                                : 'The selected token could not be loaded. You are editing a fresh draft until you save again.'
                        }
                    }
                );
                return false;
            }

            const data = await response.json();
            if (!data || !data.config) {
                applyTokenLoadFailure(
                    'invalid-data',
                    'The selected token returned invalid data. Using a fresh draft for now.',
                    {
                        contextOverrides: {
                            message: 'The selected token returned invalid data. You are editing a fresh draft until you save again.'
                        }
                    }
                );
                return false;
            }

            currentConfig = data.config;
            isFirstRun = false;
            if (data.regenerated && data.token && data.token !== token) {
                applyTokenLoadFailure(
                    'regenerated',
                    tConfig('config.alerts.sessionLost', {}, 'Config session was lost. Please reconfigure and save to create a new session.'),
                    {
                        defaultConfig: data.config,
                        contextOverrides: {
                            message: 'The selected token was missing or corrupted. You are editing a fresh draft until you save again.'
                        }
                    }
                );
                return false;
            }

            try { localStorage.setItem(TOKEN_KEY, token); } catch (_) { }
            saveConfigToCache(currentConfig, token);
            syncTokenVaultEntryWithBrief(token, data?.session || null, {
                lastOpenedAt: Date.now(),
                makeActive: true
            }, { ifExistsOnly: true });
            setActiveSessionContext({
                token,
                provenance: 'vault',
                sourceLabel: 'Loaded from Token Vault',
                message: 'This page is using the profile selected in Token Vault.',
                session: data?.session || null,
                recoveredFromToken: '',
                regenerated: false
            });
            syncConfigUrlForToken(token);
            closeTokenVaultCreator();
            closeTokenVault();
            applyCurrentConfigToPage({ selectInstallUrl: true });
            setConfigDirty(false);
            Promise.resolve().then(() => refreshTokenVaultData({ background: true })).catch(() => { });
            return true;
        } catch (error) {
            console.warn('[Config] Failed to switch token:', error);
            applyTokenLoadFailure(
                'network',
                'Failed to load the selected token. Using a fresh draft for now.',
                {
                    contextOverrides: {
                        message: 'The selected token could not be loaded. You are editing a fresh draft until you save again.'
                    }
                }
            );
            return false;
        } finally {
            showLoading(false);
        }
    }

    async function requestVaultTokenSwitch(targetToken) {
        const switchPlan = resolveTokenVaultSwitchPlan({
            targetToken,
            activeToken: getActiveConfigRef(),
            isDirty: configDirty
        });
        if (switchPlan.action === 'noop') return false;
        if (switchPlan.action === 'confirm-switch') {
            tokenVaultPendingSwitch = switchPlan.targetToken;
            tokenVaultFocusedToken = switchPlan.targetToken;
            openTokenVault(switchPlan.targetToken);
            return false;
        }
        return navigateToVaultToken(switchPlan.targetToken);
    }

    function buildTokenVaultExportEntry(token, store = getTokenVaultStore()) {
        const exportEntry = buildCurrentTokenExportEntry({
            targetToken: token,
            entries: store.entries,
            briefMap: Object.fromEntries(tokenVaultBriefMap.entries()),
            activeSessionToken: activeSessionContext.token,
            activeSession: activeSessionContext.session,
            now: Date.now()
        });
        if (!exportEntry) return null;
        return {
            ...exportEntry,
            label: normalizeVaultLabel(token, exportEntry.label || '')
        };
    }

    async function exportTokenVault(mode = 'all', tokenOverride = '') {
        const targetToken = extractSessionTokenFromInput(tokenOverride) || getTokenVaultManagerToken() || getActiveConfigRef();
        const store = getTokenVaultStore();
        const exportEntry = buildTokenVaultExportEntry(targetToken, store);
        const detachedActiveToken = getDetachedActiveVaultToken(store);
        const detachedActiveExportEntry = detachedActiveToken
            ? buildTokenVaultExportEntry(detachedActiveToken, store)
            : null;
        const entries = mode === 'current'
            ? (exportEntry ? [exportEntry] : [])
            : [
                ...store.entries,
                ...(detachedActiveExportEntry ? [detachedActiveExportEntry] : [])
            ];

        if (mode === 'current' && entries.length === 0) {
            showAlert('No token is loaded on this page yet.', 'warning');
            return false;
        }

        const payload = {
            version: TOKEN_VAULT_EXPORT_VERSION,
            exportedAt: Date.now(),
            activeToken: isValidSessionToken(targetToken) ? targetToken : '',
            entries
        };

        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = mode === 'current' && isValidSessionToken(targetToken)
            ? `submaker-token-${targetToken.slice(-6)}.json`
            : `submaker-token-vault-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        showAlert(mode === 'current' ? 'This token was exported.' : 'Token vault exported.', 'success');
        return true;
    }

    async function duplicateVaultToken(sourceToken, options = {}) {
        if (!isValidSessionToken(sourceToken)) return false;

        const approvedVictimTokens = Array.isArray(options.approvedVictimTokens)
            ? options.approvedVictimTokens.filter(isValidSessionToken)
            : [];
        const sourceView = buildTokenVaultViewModel(sourceToken);

        if (approvedVictimTokens.length === 0) {
            const overflowVictims = getDraftOverflowVictims();
            if (overflowVictims.length > 0) {
                const victimNoun = overflowVictims.length === 1 ? 'entry' : 'entries';
                closeTokenVaultRail();
                openTokenVaultOverridePrompt({
                    eyebrow: `${TOKEN_VAULT_MAX_ENTRIES} saved tokens max`,
                    title: 'Duplicating this profile needs one vault slot',
                    message: `Creating a copy of ${sourceView.label} will purge the oldest local vault ${victimNoun} below.`,
                    detail: 'Only the local browser vault changes. The duplicated token will be created on the server and loaded on this page.',
                    confirmLabel: 'Duplicate and replace',
                    victims: overflowVictims,
                    onConfirm: async () => {
                        await duplicateVaultToken(sourceToken, {
                            approvedVictimTokens: overflowVictims.map(entry => entry.token)
                        });
                    }
                });
                return false;
            }
        }

        closeTokenVaultRail();
        showLoading(true);

        try {
            const cacheBuster = `_cb=${Date.now()}`;
            const sourceResponse = await fetchWithTimeout(`/api/get-session/${encodeURIComponent(sourceToken)}?${cacheBuster}`, {
                cache: 'no-store',
                headers: {
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache'
                }
            }, 10000);

            if (!sourceResponse.ok) {
                const errorText = await sourceResponse.text().catch(() => '');
                const reason = errorText && errorText.trim() ? ` (${errorText.trim()})` : '';
                throw new Error(
                    sourceResponse.status === 404 || sourceResponse.status === 410
                        ? `That profile is no longer available${reason}.`
                        : `Failed to load the selected profile${reason}.`
                );
            }

            const sourceData = await sourceResponse.json();
            if (!sourceData || !sourceData.config) {
                throw new Error('The selected profile returned invalid data.');
            }

            const createResponse = await fetchWithTimeout('/api/create-session', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(sourceData.config)
            }, 10000);
            const createData = await createResponse.json().catch(() => ({}));

            if (!createResponse.ok) {
                throw new Error(createData?.error || `Failed to create the duplicated token (${createResponse.status})`);
            }

            const duplicatedToken = extractSessionTokenFromInput(createData?.token);
            if (!duplicatedToken) {
                throw new Error('The duplicated token response was invalid.');
            }

            const store = getTokenVaultStore();
            const sourceEntry = getVaultEntryForToken(sourceToken, store);
            const duplicateLabel = buildDuplicateVaultLabel(sourceToken, sourceEntry?.label || '', { store });
            const duplicatedEntry = upsertTokenVaultEntry(duplicatedToken, {
                label: duplicateLabel,
                lastOpenedAt: Date.now(),
                lastSavedAt: Date.now(),
                lastKnownCreatedAt: Number(createData?.session?.createdAt) || 0,
                lastKnownUpdatedAt: Number(createData?.session?.updatedAt) || Date.now(),
                lastKnownLastAccessedAt: Number(createData?.session?.lastAccessedAt) || 0,
                lastKnownDisabled: createData?.session?.disabled === true
            }, {
                activeToken: duplicatedToken,
                allowVictimTokens: approvedVictimTokens
            });

            if (!duplicatedEntry) {
                throw new Error('Failed to save the duplicated token into the local vault.');
            }

            renderTokenVault();

            const switched = await navigateToVaultToken(duplicatedToken);
            if (!switched) {
                showAlert(`Duplicated ${sourceView.label}, but the new token could not be loaded automatically.`, 'warning');
                return false;
            }

            showAlert(`${sourceView.label} duplicated and loaded on this page.`, 'success');
            return true;
        } catch (error) {
            showAlert(error.message || 'Failed to duplicate the selected profile.', 'error');
            return false;
        } finally {
            showLoading(false);
        }
    }

    function buildImportEntriesFromPayload(payload) {
        if (configPageState && typeof configPageState.buildTokenVaultImportEntries === 'function') {
            return configPageState.buildTokenVaultImportEntries(payload, {
                extractToken: extractSessionTokenFromInput,
                normalizeLabel: normalizeVaultLabel,
                now: Date.now()
            });
        }

        const importedEntries = Array.isArray(payload)
            ? payload
            : (Array.isArray(payload?.entries)
                ? payload.entries
                : [payload?.entry, payload?.profile, payload].filter(candidate => candidate && typeof candidate === 'object'));
        const now = Date.now();
        const prepared = [];
        const pushPreparedEntry = (entry) => {
            const token = extractSessionTokenFromInput(entry?.token || entry);
            if (!token) return;
            prepared.push({
                token,
                label: normalizeVaultLabel(token, entry?.label || ''),
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
            const activeToken = extractSessionTokenFromInput(payload?.activeToken);
            if (activeToken) {
                pushPreparedEntry({ token: activeToken });
            }
        }
        return prepared;
    }

    async function importTokenFromText(raw, options = {}) {
        const token = extractSessionTokenFromInput(raw);
        if (!token) {
            showAlert('Paste a raw token, manifest URL, or configure URL first.', 'warning');
            return false;
        }
        const onApplied = typeof options.onApplied === 'function' ? options.onApplied : null;
        const plan = prepareTokenVaultEntryUpsert(token, {
            addedAt: Date.now(),
            lastOpenedAt: Date.now(),
            lastSavedAt: Date.now()
        });
        return applyVaultEntryPlanWithOverflowPrompt(
            plan,
            {
                eyebrow: `${TOKEN_VAULT_MAX_ENTRIES} saved tokens max`,
                title: 'Importing this token needs one vault slot',
                message: 'Your browser vault is full. Importing this token will purge the oldest saved entry below.',
                detail: 'Only the local browser vault changes.',
                confirmLabel: 'Import and replace'
            },
            { activeToken: getActiveConfigRef() },
            async () => {
                await refreshTokenVaultData(true);
                scheduleTokenVaultCreatorPreview('', { immediate: true });
                showAlert(`Imported ${maskToken(token)} into your local vault.`, 'success');
                if (onApplied) {
                    await onApplied(token);
                }
            }
        );
    }

    async function handleTokenVaultBackupFile(file, options = {}) {
        if (!file) return;
        const text = await file.text();
        const parsed = JSON.parse(text);
        const preparedEntries = buildImportEntriesFromPayload(parsed);
        if (preparedEntries.length === 0) {
            showAlert('No valid profiles were found in that JSON file.', 'warning');
            return false;
        }
        const onApplied = typeof options.onApplied === 'function' ? options.onApplied : null;
        const plan = prepareTokenVaultMergePlan(preparedEntries);
        return applyVaultMergePlanWithOverflowPrompt(
            plan,
            {
                eyebrow: `${TOKEN_VAULT_MAX_ENTRIES} saved tokens max`,
                title: 'Import will replace older vault entries',
                message: `This file adds ${preparedEntries.length} profile${preparedEntries.length === 1 ? '' : 's'}. Keeping them will purge the oldest local vault entr${preparedEntries.length === 1 ? 'y' : 'ies'} below.`,
                detail: 'Only the local browser vault changes.',
                confirmLabel: 'Import and replace'
            },
            { activeToken: getActiveConfigRef() },
            async (importedCount) => {
                await refreshTokenVaultData(true);
                showAlert(`Imported ${importedCount} profile${importedCount === 1 ? '' : 's'} into your local vault.`, 'success');
                if (onApplied) {
                    await onApplied(importedCount);
                }
            }
        );
    }

    function promptForgetTokenFromBrowser(token) {
        if (!isValidSessionToken(token)) return;
        const view = buildTokenVaultViewModel(token);
        if (!view.entry) return;

        const detailParts = [
            'This only forgets the token in the local browser vault.'
        ];
        if (view.isActiveToken) {
            detailParts.push('The page stays connected until you switch away or reload.');
        }
        if (view.brief?.exists === false) {
            detailParts.push('The remote session is already gone, so this just clears the local reference.');
        } else {
            detailParts.push('The server session, manifest URL, and remote routes keep working.');
        }

        openTokenVaultOverridePrompt({
            tone: 'danger',
            emblem: '!',
            eyebrow: 'Forget this token',
            title: `Forget ${view.label}?`,
            message: 'SubMaker will forget this token in the current browser immediately.',
            detail: detailParts.join(' '),
            victims: [view.entry],
            cancelLabel: 'Keep token',
            confirmLabel: 'Forget token',
            confirmClass: 'token-vault-action-danger',
            onConfirm: async () => {
                removeTokenVaultEntry(token);
                tokenVaultBriefMap.delete(token);
                tokenVaultBriefFetchCache.delete(token);
                tokenVaultBriefFetchPromises.delete(token);
                renderTokenVaultRail();
                closeTokenVault();
                showAlert(`${view.label} forgotten from this browser.`, 'success');
            }
        });
    }

    async function validateVaultToken(token) {
        if (!isValidSessionToken(token)) return;
        const response = await fetch(`/api/validate-session/${encodeURIComponent(token)}`, { cache: 'no-store' });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data?.error || `Validation failed (${response.status})`);
        }
        const data = await response.json();
        const status = data?.session?.disabled === true ? 'disabled' : 'active';
        showAlert(`Token validated. Status: ${status}.`, 'success');
    }

    async function setActiveTokenDisabledState(token, disabled) {
        if (!isValidSessionToken(token)) return;
        const response = await fetch(`/api/session-state/${encodeURIComponent(token)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ disabled })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data?.error || `Failed to update token state (${response.status})`);
        }
        const brief = data?.session || null;
        tokenVaultBriefMap.set(token, brief);
        rememberTokenVaultSingleBrief(token, brief);
        syncTokenVaultEntryWithBrief(token, brief, { lastOpenedAt: Date.now(), makeActive: token === getActiveConfigRef() }, { ifExistsOnly: true });
        if (token === getActiveConfigRef()) {
            setActiveSessionContext({ token, session: brief });
            updateToolboxLauncherVisibility(token);
        } else {
            renderTokenVault();
        }
        showAlert(disabled ? 'Token disabled. Toolbox and addon routes are now blocked.' : 'Token enabled again.', disabled ? 'warning' : 'success');
    }

    async function handleTokenVaultAction(actionEl) {
        const action = actionEl?.dataset?.vaultAction;
        if (!action || actionEl.disabled) return;

        const activeToken = getActiveConfigRef();
        const explicitToken = extractSessionTokenFromInput(actionEl.dataset?.token);
        const draftAction = actionEl.dataset?.draft === 'true';
        const focusedToken = getTokenVaultManagerToken();
        const actionToken = explicitToken || (draftAction ? '' : focusedToken || activeToken);
        const menuKey = String(actionEl.dataset?.menuKey || '').trim();

        if (action !== 'toggle-rail-menu' && tokenVaultRailMenuKey) {
            closeTokenVaultRailMenu();
        }

        switch (action) {
            case 'open-creator':
                openTokenVaultCreator();
                return;
            case 'toggle-rail-menu':
                if (!menuKey) return;
                toggleTokenVaultRailMenu(menuKey);
                return;
            case 'create-draft':
            case 'create-draft-fork':
                closeTokenVaultCreator();
                createFreshTokenDraft();
                return;
            case 'manage-token':
                openTokenVault(explicitToken);
                return;
            case 'close-creator':
                closeTokenVaultCreator();
                return;
            case 'reveal-token':
                tokenVaultReveal = !tokenVaultReveal;
                renderTokenVault();
                return;
            case 'copy-token':
                await copyTextToClipboard(actionToken, 'Token copied to clipboard.');
                return;
            case 'copy-manifest':
                await copyTextToClipboard(buildInstallUrlForToken(actionToken), 'Manifest URL copied to clipboard.');
                return;
            case 'copy-config-url':
                await copyTextToClipboard(buildConfigUrlForToken(actionToken), 'Config URL copied to clipboard.');
                return;
            case 'install-addon': {
                const installUrl = buildInstallUrlForToken(actionToken);
                if (!installUrl) return;
                window.location.href = installUrl.replace(/^https?:\/\//i, 'stremio://');
                showAlert('Opening Stremio...', 'info');
                return;
            }
            case 'open-toolbox': {
                const url = buildToolboxUrl(actionToken);
                if (url) window.location.href = url;
                return;
            }
            case 'open-history': {
                const url = buildHistoryUrlForToken(actionToken);
                if (url) window.location.href = url;
                return;
            }
            case 'validate-active':
            case 'validate-token':
                await validateVaultToken(actionToken);
                return;
            case 'toggle-state': {
                const currentBrief = tokenVaultBriefMap.get(actionToken);
                const currentEntry = getVaultEntryForToken(actionToken);
                const disabled = currentBrief?.disabled === true || currentEntry?.lastKnownDisabled === true;
                await setActiveTokenDisabledState(actionToken, !disabled);
                return;
            }
            case 'edit-title': {
                if (!isValidSessionToken(actionToken)) return;
                const currentEntry = getVaultEntryForToken(actionToken);
                const store = getTokenVaultStore();
                const currentLabel = normalizeVaultLabel(actionToken, currentEntry?.label || '');
                const initialValue = currentLabel || deriveVaultLabel(actionToken, currentEntry?.label || '', { store });
                openTokenVaultTitleEditor(actionToken, initialValue);
                return;
            }
            case 'save-label': {
                saveTokenVaultTitle(actionToken, activeToken);
                return;
            }
            case 'switch-token': {
                await requestVaultTokenSwitch(explicitToken);
                return;
            }
            case 'switch-save': {
                const targetToken = tokenVaultPendingSwitch;
                if (!targetToken) return;
                await saveCurrentConfig({
                    afterSuccess: async () => {
                        await navigateToVaultToken(targetToken);
                    }
                });
                return;
            }
            case 'switch-discard':
                if (tokenVaultPendingSwitch) {
                    await navigateToVaultToken(tokenVaultPendingSwitch);
                }
                return;
            case 'switch-cancel':
                tokenVaultPendingSwitch = '';
                renderTokenVault();
                return;
            case 'forget-token':
                if (!isValidSessionToken(actionToken)) return;
                promptForgetTokenFromBrowser(actionToken);
                return;
            case 'duplicate-token':
                await duplicateVaultToken(actionToken);
                return;
            case 'export-current':
                await exportTokenVault('current', actionToken);
                return;
            case 'export-all':
                await exportTokenVault('all');
                return;
            case 'import-paste': {
                const input = document.getElementById('tokenVaultCreateInput');
                await importTokenFromText(input?.value || '', {
                    onApplied: async (token) => {
                        if (document.getElementById('tokenVaultCreateModal')?.classList.contains('show')) {
                            closeTokenVaultCreator();
                        }
                        await requestVaultTokenSwitch(token);
                    }
                });
                return;
            }
            case 'paste-clipboard':
                await pasteTokenVaultCreatorFromClipboard();
                return;
            case 'import-file':
                {
                    const importInput = document.getElementById('tokenVaultImportFile');
                    if (importInput) {
                        importInput.value = '';
                        importInput.click();
                    }
                }
                return;
            case 'close-vault':
                closeTokenVault();
                return;
            default:
                return;
        }
    }

    // Initialize
    if (document.readyState !== 'loading') {
        // If DOM is already loaded (dynamic script injection), run init immediately
        setTimeout(init, 0);
    } else {
        document.addEventListener('DOMContentLoaded', init);
    }

    function ensureProvidersInState() {
        if (!currentConfig) {
            currentConfig = getDefaultConfig();
        }
        const defaults = getDefaultConfig().providers;
        currentConfig.providers = mergeProviders(defaults, currentConfig.providers);
    }

    function ensureProviderParametersInState() {
        if (!currentConfig) {
            currentConfig = getDefaultConfig();
        }
        const defaults = getDefaultProviderParameters();
        currentConfig.providerParameters = mergeProviderParameters(defaults, currentConfig.providerParameters);
    }

    function ensureAutoSubsDefaults() {
        if (!currentConfig) {
            currentConfig = getDefaultConfig();
        }
        const defaults = getDefaultConfig(currentConfig.geminiModel || 'gemini-flash-latest').autoSubs;
        currentConfig.autoSubs = {
            ...defaults,
            ...(currentConfig.autoSubs || {})
        };
        currentConfig.otherApiKeysEnabled = isSubToolboxEnabled();
    }

    function isSubToolboxEnabled() {
        const toolboxToggle = document.getElementById('subToolboxEnabledNoTranslation') || document.getElementById('subToolboxEnabled');
        if (toolboxToggle) {
            return toolboxToggle.checked === true;
        }
        return currentConfig?.subToolboxEnabled === true
            || currentConfig?.fileTranslationEnabled === true
            || currentConfig?.syncSubtitlesEnabled === true;
    }

    function ensureUiLanguageDockExists() {
        let dock = document.getElementById('uiLanguageDock');
        let row = document.getElementById('uiLanguageFlags');

        // If the partial failed to load (or was stripped), create a minimal dock on the fly
        if (!dock) {
            dock = document.createElement('div');
            dock.id = 'uiLanguageDock';
            dock.className = 'ui-language-dock';
            dock.setAttribute('role', 'group');
            dock.setAttribute('data-i18n', 'config.uiLanguageAria');
            dock.setAttribute('data-i18n-attr', 'aria-label');

            const glow = document.createElement('div');
            glow.className = 'ui-language-glow';
            glow.setAttribute('aria-hidden', 'true');
            dock.appendChild(glow);

            row = document.createElement('div');
            row.id = 'uiLanguageFlags';
            row.className = 'ui-language-flag-row';
            dock.appendChild(row);

            // Insert at top of body so it matches the original layout
            (document.body || document.documentElement).appendChild(dock);
        }

        if (!row) {
            row = document.createElement('div');
            row.id = 'uiLanguageFlags';
            row.className = 'ui-language-flag-row';
            dock.appendChild(row);
        }

        return { dock, row };
    }

    function setUiLanguageExpanded(expanded) {
        uiLanguageExpanded = expanded === true;
        const { dock, row } = ensureUiLanguageDockExists();
        if (dock) {
            dock.classList.toggle('expanded', uiLanguageExpanded);
            dock.setAttribute('aria-expanded', uiLanguageExpanded ? 'true' : 'false');
        }
        if (row) {
            row.classList.toggle('collapsed', !uiLanguageExpanded);
        }
    }

    function renderUiLanguageFlags(selectedLang) {
        const { dock, row: container } = ensureUiLanguageDockExists();
        if (!container) return;

        const activeMeta = getUiLanguageMeta(selectedLang || currentConfig?.uiLanguage || getPreferredUiLanguage());
        const labelText = tConfig('config.uiLanguageLabel', {}, 'Interface language');
        const ariaPrefix = labelText ? `${labelText}: ` : '';

        container.innerHTML = '';
        const orderedEntries = [...SUPPORTED_UI_LANGUAGES].sort((a, b) => {
            const aActive = a.value === activeMeta.value;
            const bActive = b.value === activeMeta.value;
            if (aActive && !bActive) return -1;
            if (!aActive && bActive) return 1;
            return 0;
        });
        orderedEntries.forEach((entry) => {
            const meta = resolveUiLanguageMeta(entry);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `ui-lang-flag${meta.value === activeMeta.value ? ' active' : ''}`;
            btn.dataset.lang = meta.value;
            btn.setAttribute('aria-pressed', meta.value === activeMeta.value ? 'true' : 'false');
            btn.setAttribute('aria-label', ariaPrefix + (meta.label || meta.value.toUpperCase()));
            btn.title = meta.label || meta.value.toUpperCase();
            btn.textContent = meta.flag || meta.value.toUpperCase();
            btn.addEventListener('click', () => {
                const current = (currentConfig && currentConfig.uiLanguage) || '';
                if (meta.value === current) return;
                setUiLanguage(meta.value);
                setUiLanguageExpanded(false);
            });
            container.appendChild(btn);
        });

        if (dock) {
            dock.setAttribute('title', ariaPrefix + (activeMeta.label || activeMeta.value.toUpperCase()));
            dock.setAttribute('aria-label', ariaPrefix + (activeMeta.label || activeMeta.value.toUpperCase()));
        }
        updateUiLanguageBadge(activeMeta.value);
        setUiLanguageExpanded(uiLanguageExpanded);
    }

    function setUiLanguage(lang) {
        const normalized = (lang || '').toString().trim().toLowerCase() || 'en';
        if (!currentConfig) {
            currentConfig = getDefaultConfig();
        }
        currentConfig.uiLanguage = normalized;
        updateUiLanguageBadge(normalized);
        setUiLanguageExpanded(false);
        try { localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, normalized); } catch (_) { }
        initLocale(normalized);
    }

    function applyUiLanguageCopy() {
        const translate = (key, fallback) => {
            try {
                if (typeof window.t === 'function') return window.t(key, {}, fallback);
            } catch (_) { }
            return fallback;
        };
        // Preserve whether the flag dock is currently expanded so we don't auto-close it
        // when translations finish loading after the user clicks it open.
        const wasExpanded = uiLanguageExpanded;
        const activeLang = (currentConfig && currentConfig.uiLanguage) || (locale && locale.lang) || 'en';
        renderUiLanguageFlags(activeLang);
        updateUiLanguageBadge(activeLang);
        setUiLanguageExpanded(wasExpanded);
        const heroTitle = document.getElementById('heroTitle');
        if (heroTitle) {
            heroTitle.textContent = translate('config.heroTitle', 'SubMaker');
        }
        const heroSubtitle = document.getElementById('heroSubtitle');
        if (heroSubtitle) {
            heroSubtitle.textContent = translate('config.heroSubtitle', 'AI-Powered Subtitle Translation');
        }
    }

    function isBetaModeEnabled() {
        // Prefer the state stored in currentConfig (set during initial load) so we
        // don't accidentally read an unchecked toggle before the UI is populated.
        if (currentConfig && currentConfig.betaModeEnabled !== undefined) {
            return currentConfig.betaModeEnabled === true;
        }
        const betaToggle = document.getElementById('betaMode');
        return betaToggle ? betaToggle.checked === true : false;
    }

    function isDevModeEnabled() {
        if (currentConfig && typeof currentConfig.devMode === 'boolean') {
            return currentConfig.devMode === true;
        }
        const devToggle = document.getElementById('devMode');
        return devToggle ? devToggle.checked === true : false;
    }

    function normalizeUrlExtensionTestValue(value, fallback = 'srt') {
        const normalized = String(value || '').toLowerCase();
        return VALID_URL_EXTENSION_TEST_VALUES.includes(normalized) ? normalized : fallback;
    }

    function isAssPassthroughEnabledInForm() {
        const convertAssEl = document.getElementById('convertAssToVtt');
        return convertAssEl ? convertAssEl.checked === true : false;
    }

    function normalizeTranslationWorkflowValue(value, fallback = 'xml') {
        const normalized = String(value || '').toLowerCase();
        return ['xml', 'json', 'original', 'ai'].includes(normalized) ? normalized : fallback;
    }

    function getTranslationWorkflowInputs() {
        const legacySelect = document.getElementById('sendTimestampsToAI');
        if (legacySelect) return [legacySelect];
        return Array.from(document.querySelectorAll('input[name="translationWorkflow"]'));
    }

    function getSelectedTranslationWorkflow(fallback = 'xml') {
        const legacySelect = document.getElementById('sendTimestampsToAI');
        if (legacySelect) {
            return normalizeTranslationWorkflowValue(legacySelect.value, fallback);
        }

        const selectedRadio = document.querySelector('input[name="translationWorkflow"]:checked');
        return normalizeTranslationWorkflowValue(selectedRadio ? selectedRadio.value : '', fallback);
    }

    function setSelectedTranslationWorkflow(workflow) {
        const normalized = normalizeTranslationWorkflowValue(workflow, 'xml');
        const legacySelect = document.getElementById('sendTimestampsToAI');
        if (legacySelect) {
            legacySelect.value = normalized;
        }

        const radioInputs = Array.from(document.querySelectorAll('input[name="translationWorkflow"]'));
        if (radioInputs.length > 0) {
            let matched = false;
            radioInputs.forEach((input) => {
                const isMatch = normalizeTranslationWorkflowValue(input.value, '') === normalized;
                input.checked = isMatch;
                if (isMatch) matched = true;
            });
            if (!matched) {
                const xmlRadio = radioInputs.find((input) => normalizeTranslationWorkflowValue(input.value, '') === 'xml');
                if (xmlRadio) xmlRadio.checked = true;
            }
        }

        return normalized;
    }

    function getTranslationWorkflowContainer() {
        const legacySelect = document.getElementById('sendTimestampsToAI');
        if (legacySelect) {
            return legacySelect.closest('.form-group');
        }
        const radioGroup = document.getElementById('translationWorkflow');
        if (radioGroup) {
            return radioGroup.closest('.v2-card, .v2-form-group, .form-group');
        }
        return null;
    }

    function syncUrlExtensionTestModeUi(options = {}) {
        const { rememberCheckedSelection = false } = options;
        const radios = Array.from(document.querySelectorAll('input[name="urlExtensionTest"]'));
        if (!radios.length) return;

        if (rememberCheckedSelection) {
            const checkedRadio = radios.find((radio) => radio.checked);
            if (checkedRadio && (checkedRadio.value !== 'none' || !urlExtensionTestForcedByAssPassthrough)) {
                lastUrlExtensionTestChoice = normalizeUrlExtensionTestValue(checkedRadio.value, lastUrlExtensionTestChoice);
            }
        }

        const assPassthroughEnabled = isAssPassthroughEnabledInForm();
        let nextValue;
        if (assPassthroughEnabled) {
            nextValue = 'none';
        } else if (urlExtensionTestForcedByAssPassthrough) {
            nextValue = normalizeUrlExtensionTestValue(lastUrlExtensionTestChoice, 'srt');
        } else {
            nextValue = normalizeUrlExtensionTestValue(currentConfig?.urlExtensionTest, lastUrlExtensionTestChoice);
        }

        const targetValue = normalizeUrlExtensionTestValue(nextValue, 'srt');
        const targetRadio = radios.find((radio) => radio.value === targetValue)
            || radios.find((radio) => radio.value === 'srt');

        radios.forEach((radio) => {
            radio.disabled = assPassthroughEnabled && radio.value !== 'none';
            radio.checked = targetRadio ? radio.value === targetRadio.value : radio.value === 'srt';
        });

        if (!assPassthroughEnabled) {
            lastUrlExtensionTestChoice = targetRadio ? targetRadio.value : 'srt';
        }
        urlExtensionTestForcedByAssPassthrough = assPassthroughEnabled;

        if (currentConfig) {
            currentConfig.urlExtensionTest = targetRadio ? targetRadio.value : 'srt';
        }
    }

    function hasActiveMultiProviderState(config) {
        if (!config || config.multiProviderEnabled !== true) return false;
        const main = String(config.mainProvider || 'gemini').toLowerCase();
        const secondaryEnabled = config.secondaryProviderEnabled === true;
        return main !== 'gemini' || secondaryEnabled;
    }

    function isMultiProviderActiveInForm() {
        const multiToggle = document.getElementById('enableMultiProviders');
        const mainSelect = document.getElementById('mainProviderSelect');
        const secondaryToggle = document.getElementById('enableSecondaryProvider');
        const multiEnabled = multiToggle ? multiToggle.checked : false;
        const main = mainSelect ? String(mainSelect.value || 'gemini').toLowerCase() : 'gemini';
        const secondaryEnabled = secondaryToggle ? secondaryToggle.checked : false;
        return multiEnabled && (main !== 'gemini' || secondaryEnabled);
    }

    async function init() {
        // Ensure browser constraint validation doesn't block the custom save flow on hidden/advanced inputs
        const configForm = document.getElementById('configForm');
        if (configForm) {
            configForm.setAttribute('novalidate', 'novalidate');
        }
        setActiveSessionContext({
            token: '',
            provenance: 'draft',
            sourceLabel: 'Fresh draft',
            message: 'No token yet. Your first save will mint one.',
            session: null,
            recoveredFromToken: '',
            regenerated: false
        });

        const urlSessionToken = getUrlSessionToken() || null;
        const urlConfig = parseConfigFromUrl();

        // Identify which session token should scope any cached config usage
        const persistentSessionToken = getStoredSessionToken() || null;
        const intendedToken = urlSessionToken || persistentSessionToken || null;

        // Priority: cached config (for this token) > live session fetch (URL token or stored token) > default config.
        const cachedConfig = await loadConfigFromCache(intendedToken);
        const loadPlan = getInitialConfigLoadPlan({
            urlSessionToken: urlSessionToken || '',
            persistentSessionToken: persistentSessionToken || '',
            hasCachedConfig: !!cachedConfig
        });
        isFirstRun = loadPlan.isFirstRun === true;

        if (loadPlan.shouldUseCachedConfig) {
            // Use cached config - this is the most common case
            currentConfig = cachedConfig;
            if (isValidSessionToken(loadPlan.intendedToken)) {
                setActiveSessionContext({
                    token: loadPlan.intendedToken,
                    provenance: 'local',
                    sourceLabel: 'Loaded from this browser',
                    message: 'Using the token stored locally on this device.',
                    session: null,
                    recoveredFromToken: '',
                    regenerated: false
                });
                safelyBackfillActiveTokenIntoVault({
                    activeToken: loadPlan.intendedToken,
                    session: null,
                    render: false
                });
            }
        } else if (loadPlan.shouldFetchSession) {
            const sessionToken = loadPlan.fetchToken;
            const loadedFromUrl = loadPlan.hasExplicitUrlConfig === true;
            const hasCachedFallback = !!cachedConfig;
            const fallbackConfig = cachedConfig || urlConfig;
            const fallbackCopy = hasCachedFallback ? 'Using the last local copy for now.' : 'Using a fresh draft for now.';
            currentConfig = fallbackConfig;
            syncTokenVaultEntryWithBrief(sessionToken, null, { lastOpenedAt: Date.now(), makeActive: true }, { ifExistsOnly: true });

            const applySessionLoadFailurePlan = (failureType, alertMessage, options = {}) => {
                const plan = resolveSessionLoadFailurePlan({
                    loadedFromUrl,
                    hasCachedFallback,
                    sessionToken,
                    failureType
                });

                if (plan.clearStoredToken === true) {
                    try { localStorage.removeItem(TOKEN_KEY); } catch (_) { }
                }

                if (plan.configSource === 'cache' && hasCachedFallback) {
                    currentConfig = cachedConfig;
                } else {
                    currentConfig = options.defaultConfig || getDefaultConfig();
                }

                const nextContext = {
                    ...plan.context,
                    ...(options.contextOverrides || {}),
                    session: null
                };
                if (!plan.keepActiveToken) {
                    nextContext.detachedAt = Date.now();
                }
                setActiveSessionContext(nextContext);

                if (alertMessage) {
                    showAlert(alertMessage, 'warning');
                }
            };

            try {
                const cacheBuster = `_cb=${Date.now()}`;
                const resp = await fetchWithTimeout(`/api/get-session/${sessionToken}?${cacheBuster}&autoRegenerate=true`, {
                    cache: 'no-store',
                    headers: {
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                        'Pragma': 'no-cache'
                    }
                }, 10000);
                if (!resp.ok) {
                    const errorText = await resp.text().catch(() => '');
                    const reason = errorText && errorText.trim() ? ` (${errorText.trim()})` : '';
                    if (resp.status === 404 || resp.status === 410) {
                        applySessionLoadFailurePlan(
                            'missing',
                            loadedFromUrl
                                ? `That shared token is no longer available${reason}. Save to mint a replacement token.`
                                : `Your saved token is no longer available${reason}. Save to mint a replacement token.`,
                            {
                                contextOverrides: {
                                    message: loadedFromUrl
                                        ? 'The requested token no longer exists on the server. You are editing a recovered draft until you save again.'
                                        : 'The saved token no longer exists on the server. You are editing a recovered draft until you save again.'
                                }
                            }
                        );
                    } else {
                        applySessionLoadFailurePlan(
                            'http',
                            loadedFromUrl
                                ? `Failed to load the shared token${reason}. ${fallbackCopy}`
                                : `Failed to refresh the saved token${reason}. ${fallbackCopy}`,
                            {
                                contextOverrides: {
                                    message: loadedFromUrl
                                        ? 'This page is using the last local copy for the shared token until the server becomes reachable again.'
                                        : 'This page is using the last local copy for your saved token until the server becomes reachable again.'
                                }
                            }
                        );
                    }
                    return;
                }
                if (resp.ok) {
                    const data = await resp.json();
                    if (!data || !data.config) {
                        applySessionLoadFailurePlan(
                            'invalid-data',
                            loadedFromUrl
                                ? `The shared token returned invalid data. ${fallbackCopy}`
                                : `The saved token returned invalid data. ${fallbackCopy}`,
                            {
                                contextOverrides: {
                                    message: loadedFromUrl
                                        ? 'This page is using the last local copy for the shared token because the server returned invalid data.'
                                        : 'This page is using the last local copy for your saved token because the server returned invalid data.'
                                }
                            }
                        );
                        return;
                    }

                    currentConfig = data.config;

                    if (data.regenerated && data.token && data.token !== sessionToken) {
                        console.warn('[Config] Server regenerated config:', data.reason);
                        console.log('[Config] Regenerated token available:', data.token);

                        applySessionLoadFailurePlan(
                            'regenerated',
                            tConfig('config.alerts.sessionLost', {}, 'Config session was lost. Please reconfigure and save to create a new session.'),
                            {
                                defaultConfig: data.config,
                                contextOverrides: {
                                    message: hasCachedFallback
                                        ? 'The requested token was missing or corrupted. You are editing the last local copy until you save again.'
                                        : 'The requested token was missing or corrupted. You are editing a fresh draft until you save again.'
                                }
                            }
                        );
                    } else {
                        try { localStorage.setItem(TOKEN_KEY, sessionToken); } catch (_) { }
                        setActiveSessionContext({
                            token: sessionToken,
                            provenance: loadedFromUrl ? 'url' : 'local',
                            sourceLabel: loadedFromUrl ? 'Loaded from shared URL' : 'Loaded from this browser',
                            message: loadedFromUrl
                                ? 'This page is using the token that arrived in the URL.'
                                : 'Using the token stored locally on this device.',
                            session: data?.session || null,
                            recoveredFromToken: '',
                            regenerated: false
                        });
                        safelyBackfillActiveTokenIntoVault({
                            activeToken: sessionToken,
                            session: data?.session || null,
                            render: false
                        });
                        syncTokenVaultEntryWithBrief(sessionToken, data?.session, {
                            lastOpenedAt: Date.now(),
                            makeActive: true
                        }, { ifExistsOnly: true });
                    }
                }
            } catch (e) {
                console.warn('[Config] Failed to fetch session:', e);
                applySessionLoadFailurePlan(
                    'network',
                    loadedFromUrl
                        ? `Failed to load the shared token. ${fallbackCopy}`
                        : `Failed to refresh the saved token. ${fallbackCopy}`,
                    {
                        contextOverrides: {
                            message: loadedFromUrl
                                ? 'This page is using the last local copy for the shared token until live metadata can be refreshed again.'
                                : 'This page is using the last local copy for your saved token until live metadata can be refreshed again.'
                        }
                    }
                );
            }
        }
        // else: currentConfig stays as a fresh template until the first save

        // On first run, start all subtitle providers disabled by default
        if (isFirstRun) {
            const defaults = getDefaultConfig();
            currentConfig = { ...defaults };
            currentConfig.subtitleProviders = {
                opensubtitles: { ...(defaults.subtitleProviders?.opensubtitles || {}), enabled: false },
                subdl: { ...(defaults.subtitleProviders?.subdl || {}), enabled: false },
                subsource: { ...(defaults.subtitleProviders?.subsource || {}), enabled: false },
                scs: { ...(defaults.subtitleProviders?.scs || {}), enabled: false },
                wyzie: { ...(defaults.subtitleProviders?.wyzie || {}), enabled: false }
            };
            setActiveSessionContext({
                token: '',
                provenance: 'draft',
                sourceLabel: 'Fresh draft',
                message: 'No token exists yet. The first save will create one.',
                session: null,
                recoveredFromToken: '',
                regenerated: false
            });
        }

        currentConfig.betaModeEnabled = currentConfig.betaModeEnabled === true;
        ensureProvidersInState();
        ensureProviderParametersInState();
        ensureAutoSubsDefaults();
        const multiProviderToggleRequested = currentConfig.multiProviderEnabled === true;
        currentConfig.multiProviderEnabled = multiProviderToggleRequested;
        const requestedMainProvider = currentConfig.mainProvider || 'gemini';
        const requestedSecondaryProvider = currentConfig.secondaryProvider || '';
        currentConfig.mainProvider = String(requestedMainProvider || 'gemini').toLowerCase();
        currentConfig.secondaryProvider = String(requestedSecondaryProvider || '').toLowerCase();
        currentConfig.secondaryProviderEnabled = multiProviderToggleRequested && currentConfig.secondaryProviderEnabled === true;
        if (currentConfig.secondaryProviderEnabled && (!currentConfig.secondaryProvider || currentConfig.secondaryProvider === currentConfig.mainProvider)) {
            currentConfig.secondaryProviderEnabled = false;
        }

        // Normalize any legacy PT-BR codes in saved config to canonical 'pob'
        currentConfig.sourceLanguages = normalizeLanguageCodes(currentConfig.sourceLanguages || []);
        currentConfig.targetLanguages = normalizeLanguageCodes(currentConfig.targetLanguages || []);
        currentConfig.noTranslationLanguages = normalizeLanguageCodes(currentConfig.noTranslationLanguages || []);
        currentConfig.learnTargetLanguages = normalizeLanguageCodes(currentConfig.learnTargetLanguages || []);
        currentConfig.learnPlacement = 'top';
        currentConfig.mobileMode = currentConfig.mobileMode === true;
        currentConfig.excludeHearingImpairedSubtitles = currentConfig.excludeHearingImpairedSubtitles === true;
        enforceLanguageLimits();
        updateLanguageLimitCopy();

        // Show instructions ASAP (do not block on network/UI work)
        showInstructionsModalIfNeeded();

        // Populate UI language selector before wiring events
        const activeUiLang = currentConfig.uiLanguage || locale.lang || 'en';
        renderUiLanguageFlags(activeUiLang);
        try { localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, activeUiLang); } catch (_) { }

        // Kick off language loading without blocking UI/modals
        loadLanguages().catch(err => {
            try { showAlert(tConfig('config.alerts.loadLanguagesFailed', { reason: err.message }, 'Failed to load languages: ' + err.message), 'error', 'config.alerts.loadLanguagesFailed', { reason: err.message }); } catch (_) { }
        });

        setupEventListeners();
        // Keep provider-level advanced controls grouped under Advanced Settings in the UI
        const advancedCardContent = document.querySelector('#advancedSettingsCard .card-content');
        const geminiAdvancedCard = document.getElementById('geminiAdvancedCard');
        const providerAdvancedCard = document.getElementById('providerAdvancedCard');
        if (advancedCardContent && geminiAdvancedCard && geminiAdvancedCard.parentElement !== advancedCardContent) {
            advancedCardContent.appendChild(geminiAdvancedCard);
            geminiAdvancedCard.style.marginTop = '1.25rem';
        }
        if (advancedCardContent && providerAdvancedCard && providerAdvancedCard.parentElement !== advancedCardContent) {
            advancedCardContent.appendChild(providerAdvancedCard);
            providerAdvancedCard.style.marginTop = '1.25rem';
        }
        loadConfigToForm();
        initLocale(currentConfig.uiLanguage || locale.lang || 'en');
        updateToolboxLauncherVisibility();
        updateQuickStats();
        updateTokenVaultButtonState();
        const mainPartialReady = (typeof window !== 'undefined' && window.mainPartialReady);
        if (mainPartialReady && typeof mainPartialReady.then === 'function') {
            mainPartialReady.then(() => {
                bindTokenVaultUiEventListeners();
                updateTokenVaultButtonState();
                renderTokenVaultRail({ forceContent: true });
                consumePendingTokenVaultLauncherOpenRequest();
            }).catch(() => { });
        }
        const partialsReady = (typeof window !== 'undefined' && window.partialsReady);
        if (partialsReady && typeof partialsReady.then === 'function') {
            partialsReady.then(() => {
                bindTokenVaultUiEventListeners();
            }).catch(() => { });
        }
        if (isValidSessionToken(activeSessionContext.token)) {
            Promise.resolve().then(() => refreshTokenVaultData({ background: true })).catch(() => { });
        }
        setupKeyboardShortcuts();
        showKeyboardHint();

        // Auto-fetch models if API key exists (do not block UI/modals)
        const apiKey = document.getElementById('geminiApiKey').value.trim();
        if (apiKey) {
            Promise.resolve().then(() => autoFetchModels(apiKey)).catch(() => { });
        }

        // Position reset bar after layout is ready
        const syncFloatingBottomSafeZoneDebounced = debounce(syncFloatingBottomSafeZone, 80);
        requestAnimationFrame(() => {
            positionResetBar();
            syncFloatingBottomSafeZone();
        });
        window.addEventListener('resize', debounce(positionResetBar, 120));
        window.addEventListener('resize', syncFloatingBottomSafeZoneDebounced);
        window.addEventListener('resize', debounce(scheduleTokenVaultRailFloatingMenuSync, 40));
        window.addEventListener('resize', debounce(() => updateBodyScrollLock(true), 80));
        suppressDirtyTracking = false;
    }

    function normalizeLanguageCodes(codes) {
        if (!Array.isArray(codes)) return [];
        const normalized = codes.map(c => {
            const lc = String(c || '').toLowerCase();
            if (lc === 'ptbr' || lc === 'pt-br') return 'pob';
            return lc;
        }).filter(lc => {
            // Block UI-only fake entries from ever persisting into config
            if (!lc) return false;
            if (lc === 'translate srt' || lc === '__') return false;
            if (lc.startsWith('___')) return false; // frontend/internal placeholders
            return true;
        });
        // Deduplicate exact duplicate codes
        return [...new Set(normalized)];
    }

    function getCombinedTargetSet() {
        const targets = Array.isArray(currentConfig?.targetLanguages) ? currentConfig.targetLanguages : [];
        const learns = Array.isArray(currentConfig?.learnTargetLanguages) ? currentConfig.learnTargetLanguages : [];
        return new Set([...targets, ...learns]);
    }

    function getCombinedTargetCount() {
        return getCombinedTargetSet().size;
    }

    function canAddTargetLanguage(code) {
        const combined = getCombinedTargetSet();
        if (combined.has(code)) {
            return true; // Already counted, does not consume extra slot
        }
        return combined.size < MAX_TARGET_LANGUAGES;
    }

    function enforceLanguageLimits() {
        if (!currentConfig) return;

        if (Array.isArray(currentConfig.sourceLanguages) && currentConfig.sourceLanguages.length > MAX_SOURCE_LANGUAGES) {
            currentConfig.sourceLanguages = currentConfig.sourceLanguages.slice(0, MAX_SOURCE_LANGUAGES);
        }

        const targets = Array.isArray(currentConfig.targetLanguages) ? currentConfig.targetLanguages : [];
        const learns = Array.isArray(currentConfig.learnTargetLanguages) ? currentConfig.learnTargetLanguages : [];
        const combined = new Set();
        const trimmedTargets = [];
        const trimmedLearns = [];

        const pushWithLimit = (code, dest) => {
            if (!code) return;
            if (combined.has(code)) {
                dest.push(code);
                return;
            }
            if (combined.size >= MAX_TARGET_LANGUAGES) return;
            combined.add(code);
            dest.push(code);
        };

        targets.forEach(code => pushWithLimit(code, trimmedTargets));
        learns.forEach(code => pushWithLimit(code, trimmedLearns));

        currentConfig.targetLanguages = trimmedTargets;
        currentConfig.learnTargetLanguages = trimmedLearns;

        if (Array.isArray(currentConfig.noTranslationLanguages) && currentConfig.noTranslationLanguages.length > MAX_NO_TRANSLATION_LANGUAGES) {
            currentConfig.noTranslationLanguages = currentConfig.noTranslationLanguages.slice(0, MAX_NO_TRANSLATION_LANGUAGES);
        }
    }

    function updateLanguageLimitCopy() {
        const sourceDesc = document.getElementById('sourceLanguagesDescription');
        if (sourceDesc) {
            try { sourceDesc.setAttribute('data-i18n-vars', JSON.stringify({ max: MAX_SOURCE_LANGUAGES })); } catch (_) { }
            sourceDesc.innerHTML = tConfig('config.limits.sourceDescription', { max: MAX_SOURCE_LANGUAGES }, `You can select up to ${MAX_SOURCE_LANGUAGES} source language${MAX_SOURCE_LANGUAGES === 1 ? '' : 's'}, but only 1 is recommended. This way you have the exact same &quot;Make (language)&quot; subtitles list order as the Source language and can verify the original subtitles for sync issues before translating.<br><br>All subtitles found in the selected Source language will show up in their original language AND will be used as sources for the &quot;Make (target language)&quot; translation lists.`);
        }

        const targetDesc = document.getElementById('targetLanguagesDescription');
        if (targetDesc) {
            try { targetDesc.setAttribute('data-i18n-vars', JSON.stringify({ max: MAX_TARGET_LANGUAGES })); } catch (_) { }
            targetDesc.innerHTML = tConfig('config.limits.targetDescription', { max: MAX_TARGET_LANGUAGES }, `Subtitles in target languages will be fetched (found subtitles will show up) AND translation buttons (&quot;Make&quot; lists) will appear for translating FROM the Source language subtitles TO the target languages.<br><br>You can select up to ${MAX_TARGET_LANGUAGES} total target languages (including Learn Mode).`);
        }

        const sourceError = document.getElementById('sourceLanguagesError');
        if (sourceError) {
            sourceError.textContent = tConfig('config.validation.sourceRequired', {}, 'Please select at least one source language');
        }

        const noTranslationDesc = document.getElementById('noTranslationLanguagesDescription');
        if (noTranslationDesc) {
            try { noTranslationDesc.setAttribute('data-i18n-vars', JSON.stringify({ max: MAX_NO_TRANSLATION_LANGUAGES })); } catch (_) { }
            noTranslationDesc.textContent = tConfig('config.limits.noTranslationDescription', { max: MAX_NO_TRANSLATION_LANGUAGES }, `Select which languages you want to fetch subtitles in (up to ${MAX_NO_TRANSLATION_LANGUAGES}).`);
        }
    }

    function buildLimitedTargetSelection(candidates, type) {
        const otherList = type === 'target'
            ? (currentConfig.learnTargetLanguages || [])
            : (currentConfig.targetLanguages || []);
        const combined = new Set(otherList);
        const selection = [];
        let truncated = false;

        candidates.forEach(code => {
            if (selection.includes(code)) return;
            if (combined.has(code)) {
                selection.push(code);
                return;
            }
            if (combined.size >= MAX_TARGET_LANGUAGES) {
                truncated = true;
                return;
            }
            combined.add(code);
            selection.push(code);
        });

        return { selection, truncated };
    }

    function buildLimitedNoTranslationSelection(candidates) {
        const selection = [];
        let truncated = false;

        candidates.forEach(code => {
            if (selection.includes(code)) return;
            if (selection.length >= MAX_NO_TRANSLATION_LANGUAGES) {
                truncated = true;
                return;
            }
            selection.push(code);
        });

        return { selection, truncated };
    }

    // Modal management functions
    function updateBodyScrollLock(force = false) {
        try {
            const instr = document.getElementById('instructionsModal');
            const reset = document.getElementById('resetConfirmModal');
            const vault = document.getElementById('tokenVaultModal');
            const vaultCreator = document.getElementById('tokenVaultCreateModal');
            const vaultOverride = document.getElementById('tokenVaultOverrideModal');
            const shouldLock = (instr && instr.classList.contains('show'))
                || (reset && reset.classList.contains('show'))
                || (vault && vault.classList.contains('show'))
                || (vaultCreator && vaultCreator.classList.contains('show'))
                || (vaultOverride && vaultOverride.classList.contains('show'));
            const viewportWidth = window.innerWidth || 0;

            if (!force && bodyScrollLockState.locked === shouldLock && (!shouldLock || bodyScrollLockState.viewportWidth === viewportWidth)) {
                return;
            }

            let scrollbarWidth = bodyScrollLockState.scrollbarWidth || 0;
            if (shouldLock && (force || bodyScrollLockState.locked !== true || bodyScrollLockState.viewportWidth !== viewportWidth)) {
                scrollbarWidth = Math.max(0, viewportWidth - (document.documentElement ? document.documentElement.clientWidth : 0));
            }

            // Toggle scroll lock class
            document.body.classList.toggle('modal-open', !!shouldLock);

            // Prevent layout shift by compensating for scrollbar width when locking
            if (shouldLock) {
                if (document.body.dataset.prOriginal === undefined) {
                    document.body.dataset.prOriginal = document.body.style.paddingRight || '';
                }
                document.body.style.paddingRight = scrollbarWidth > 0
                    ? (scrollbarWidth + 'px')
                    : document.body.dataset.prOriginal;
            } else {
                if (document.body.dataset.prOriginal !== undefined) {
                    document.body.style.paddingRight = document.body.dataset.prOriginal;
                    delete document.body.dataset.prOriginal;
                } else {
                    document.body.style.paddingRight = '';
                }
            }
            bodyScrollLockState = {
                locked: shouldLock,
                viewportWidth,
                scrollbarWidth: shouldLock ? scrollbarWidth : 0
            };
        } catch (_) { }
    }

    function openModalById(id, opts) {
        const el = document.getElementById(id);
        if (!el) return false;
        const peek = !!(opts && opts.peek);

        el.classList.remove('peek');
        el.style.inset = '';
        el.style.width = '';
        el.style.maxHeight = '';
        el.style.alignItems = '';
        el.style.justifyContent = '';
        el.style.background = '';
        el.style.bottom = '';
        el.style.left = '';
        el.style.right = '';
        el.style.top = '';

        if (peek) {
            el.classList.add('peek');
            el.style.inset = 'auto';
            el.style.bottom = '1rem';
            el.style.left = '1rem';
            el.style.width = 'min(520px, 96vw)';
            el.style.maxHeight = '72vh';
            el.style.alignItems = 'flex-end';
            el.style.justifyContent = 'flex-start';
            el.style.background = 'transparent';
            el.style.zIndex = '9000';
        } else {
            el.style.zIndex = '10000';
        }

        // Force visible regardless of stylesheet order
        el.classList.add('show');
        el.style.display = 'flex';
        // Lock body scroll for full-screen instructions/reset modals
        if (!peek && (id === 'instructionsModal' || id === 'resetConfirmModal' || id === 'tokenVaultModal' || id === 'tokenVaultCreateModal')) {
            updateBodyScrollLock();
        }
        return true;
    }

    function applyConfigInstructionsPreferenceState(preference) {
        const resolved = preference && typeof preference === 'object'
            ? preference
            : resolveConfigInstructionsPreference();
        try {
            if (resolved.shouldWriteCanonical) {
                localStorage.setItem(CONFIG_INSTRUCTIONS_PREFERENCE_KEY, resolved.canonicalValue || 'true');
            } else if (resolved.shouldRemoveCanonical) {
                localStorage.removeItem(CONFIG_INSTRUCTIONS_PREFERENCE_KEY);
            }
            if (resolved.shouldRemoveLegacy) {
                localStorage.removeItem(LEGACY_CONFIG_INSTRUCTIONS_PREFERENCE_KEY);
            }
        } catch (_) { }
        return resolved;
    }

    function getConfigInstructionsPreferenceState() {
        let canonicalValue = '';
        let legacyValue = '';
        try { canonicalValue = localStorage.getItem(CONFIG_INSTRUCTIONS_PREFERENCE_KEY) || ''; } catch (_) { }
        try { legacyValue = localStorage.getItem(LEGACY_CONFIG_INSTRUCTIONS_PREFERENCE_KEY) || ''; } catch (_) { }
        return applyConfigInstructionsPreferenceState(resolveConfigInstructionsPreference({
            canonicalValue,
            legacyValue
        }));
    }

    function syncConfigInstructionsPreferenceUi(preference) {
        const dontShowEl = document.getElementById('dontShowInstructions');
        if (!dontShowEl) return;
        const resolved = preference && typeof preference === 'object'
            ? preference
            : getConfigInstructionsPreferenceState();
        dontShowEl.checked = resolved.suppressed === true;
    }

    function persistConfigInstructionsPreference(suppressed) {
        const nextState = buildConfigInstructionsPreferenceWrite({ suppressed: suppressed === true });
        applyConfigInstructionsPreferenceState(nextState);
        syncConfigInstructionsPreferenceUi(nextState);
        return nextState;
    }

    function showInstructionsModalIfNeeded() {
        const preference = getConfigInstructionsPreferenceState();
        syncConfigInstructionsPreferenceUi(preference);
        if (preference.suppressed === true) {
            showInstructionsFab();
            return;
        }

        const openFull = () => {
            syncConfigInstructionsPreferenceUi(preference);
            if (openModalById('instructionsModal')) {
                instructionsInteracted = true;
                if (instructionsAutoMinimizeTimer) {
                    clearTimeout(instructionsAutoMinimizeTimer);
                    instructionsAutoMinimizeTimer = null;
                }
                hideInstructionsFab();
            }
        };

        // Prefer to wait for main partial so the modal doesn't pop after footer-only render
        const gate = (window.mainPartialReady || Promise.resolve());
        gate.then(() => requestAnimationFrame(openFull)).catch(openFull);
    }

    window.closeInstructionsModal = function () {
        const dontShowEl = document.getElementById('dontShowInstructions');
        const dontShow = dontShowEl ? dontShowEl.checked : false;
        persistConfigInstructionsPreference(dontShow);
        const modal = document.getElementById('instructionsModal');
        if (modal) {
            modal.classList.remove('show');
            modal.classList.remove('peek');
            modal.style.display = 'none';
            modal.style.inset = '';
            modal.style.width = '';
            modal.style.maxHeight = '';
            modal.style.alignItems = '';
            modal.style.justifyContent = '';
            modal.style.background = '';
            modal.style.bottom = '';
            modal.style.left = '';
            modal.style.right = '';
            modal.style.top = '';
        }
        // Update scroll lock after closing
        updateBodyScrollLock();
        // If user opted to not show again, hide FAB as well
        if (dontShow) {
            hideInstructionsFab();
        } else {
            showInstructionsFab();
        }
    };

    // Animate modal to bottom-left and reveal mini FAB
    function minimizeInstructionsModal(opts) {
        const overlay = document.getElementById('instructionsModal');
        if (!overlay || !overlay.classList.contains('show')) return;
        const isPeek = overlay.classList.contains('peek');
        if (instructionsAutoMinimizeTimer) {
            clearTimeout(instructionsAutoMinimizeTimer);
            instructionsAutoMinimizeTimer = null;
        }

        // If we're in peek mode, just tuck it away without blocking anything
        if (isPeek) {
            overlay.classList.remove('show');
            overlay.classList.remove('peek');
            overlay.style.display = 'none';
            overlay.style.inset = '';
            overlay.style.width = '';
            overlay.style.maxHeight = '';
            overlay.style.alignItems = '';
            overlay.style.justifyContent = '';
            overlay.style.background = '';
            overlay.style.bottom = '';
            overlay.style.left = '';
            overlay.style.right = '';
            overlay.style.top = '';
            requestAnimationFrame(() => {
                showInstructionsFab();
            });
            return false;
        }

        // Apply fly-out animation; then hide overlay and show FAB
        overlay.classList.add('fly-out');
        // Finish after animation duration (~450ms)
        setTimeout(() => {
            overlay.classList.remove('show');
            overlay.classList.remove('fly-out');
            overlay.style.display = 'none';
            // Unlock scroll BEFORE showing the FAB to avoid visible shift moving the icon
            updateBodyScrollLock();
            // Defer showing FAB to next frame so layout is stable post-scrollbar
            requestAnimationFrame(() => {
                showInstructionsFab();
            });
        }, 480);
    }

    function setupInstructionsInteractionGuards() {
        const overlay = document.getElementById('instructionsModal');
        if (!overlay) return;
        const modal = overlay.querySelector('.modal');
        const content = overlay.querySelector('.modal-content');

        const mark = () => {
            instructionsInteracted = true;
            if (instructionsAutoMinimizeTimer) {
                clearTimeout(instructionsAutoMinimizeTimer);
                instructionsAutoMinimizeTimer = null;
            }
        };

        ['click', 'wheel', 'touchstart', 'keydown'].forEach(type => {
            overlay.addEventListener(type, mark, { passive: true, capture: true });
            if (modal) modal.addEventListener(type, mark, { passive: true, capture: true });
            if (content) content.addEventListener(type, mark, { passive: true, capture: true });
        });
        if (content) {
            content.addEventListener('scroll', mark, { passive: true, capture: true });
        }
    }

    function showInstructionsFab() {
        const fab = document.getElementById('configHelp') || document.getElementById('instructionsFab');
        if (!fab) return;
        fab.classList.add('show');
    }

    function hideInstructionsFab() {
        const fab = document.getElementById('configHelp') || document.getElementById('instructionsFab');
        if (!fab) return;
        fab.classList.remove('show');
    }

    function getActiveConfigRef() {
        if (isValidConfigToken(activeSessionContext.token)) {
            return activeSessionContext.token;
        }
        if (!activeSessionContext.token && (activeSessionContext.provenance === 'recovered' || activeSessionContext.provenance === 'draft')) {
            return '';
        }
        const stored = getStoredSessionToken();
        if (stored && isValidConfigToken(stored)) return stored;
        const urlToken = getUrlSessionToken();
        if (urlToken && isValidConfigToken(urlToken)) return urlToken;
        return '';
    }

    function updateQuickStats() {
        const statStatus = document.getElementById('quickStatStatus');
        const statConfigure = document.getElementById('quickStatConfigure');
        const statToolbox = document.getElementById('quickStatToolbox');
        const statLastSave = document.getElementById('quickStatLastSave');

        const hasToken = !!getActiveConfigRef();
        const cachedAt = (() => {
            try { return parseInt(localStorage.getItem(CACHE_EXPIRY_KEY) || '0', 10); } catch (_) { return 0; }
        })();

        const readyLabel = tConfig('toolbox.status.ready', {}, 'Ready');
        const missingLabel = tConfig('server.errors.missingConfig', {}, 'Missing config');
        const toolboxMissing = tConfig('toolbox.autoSubs.extension.notDetected', {}, 'Extension not detected');
        const disabledLabel = 'Disabled';

        if (statStatus) statStatus.textContent = hasToken ? (activeSessionContext.session?.disabled === true ? disabledLabel : readyLabel) : missingLabel;
        if (statConfigure) statConfigure.textContent = hasToken ? tConfig('config.actions.install', {}, 'Install') : missingLabel;
        if (statToolbox) statToolbox.textContent = hasToken ? (activeSessionContext.session?.disabled === true ? disabledLabel : readyLabel) : toolboxMissing;
        if (statLastSave) {
            if (cachedAt) {
                const dt = new Date(cachedAt);
                statLastSave.textContent = dt.toLocaleString();
            } else {
                statLastSave.textContent = '—';
            }
        }
    }

    function isMobileViewport() {
        try {
            if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) return true;
            const ua = navigator.userAgent || '';
            return /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
        } catch (_) {
            return false;
        }
    }

    function buildToolboxUrl(configRef) {
        const cfg = configRef && isValidConfigToken(configRef) ? configRef : getActiveConfigRef();
        if (!cfg) return '';
        const fallbackVideoId = 'Stream and Refresh';
        const fallbackFilename = 'Stream and Refresh';
        return `/sub-toolbox?config=${encodeURIComponent(cfg)}&videoId=${encodeURIComponent(fallbackVideoId)}&filename=${encodeURIComponent(fallbackFilename)}`;
    }

    function getCachedConfigForToken(tokenToCheck) {
        if (!tokenToCheck) return null;
        try {
            const cachedToken = localStorage.getItem(CACHE_TOKEN_KEY);
            if (cachedToken && cachedToken !== tokenToCheck) return null;
            const raw = localStorage.getItem(CACHE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (_) {
            return null;
        }
    }

    function updateToolboxLauncherVisibility(configOverride) {
        const btn = document.getElementById('subToolboxLauncher');
        if (!btn) return;
        // Visibility is based solely on whether toolbox is enabled, not viewport size
        const cfgRef = configOverride || getActiveConfigRef();
        const tokenDisabled = !!(cfgRef && activeSessionContext.token === cfgRef && activeSessionContext.session?.disabled === true);
        let cachedToken = '';
        try {
            cachedToken = localStorage.getItem(CACHE_TOKEN_KEY) || '';
        } catch (_) { }
        const launcherState = resolveToolboxLauncherState({
            tokenToCheck: cfgRef,
            activeToken: getActiveConfigRef(),
            currentConfig,
            cachedConfig: getCachedConfigForToken(cfgRef),
            cachedToken,
            tokenDisabled
        });
        if (launcherState.visible) {
            btn.style.display = 'flex';
            btn.dataset.configRef = launcherState.configRef;
            btn.classList.add('show');
        } else {
            btn.style.display = 'none';
            btn.dataset.configRef = '';
            btn.classList.remove('show');
        }

        updateQuickStats();
        scheduleFloatingBottomSafeZoneSync();
    }

    window.closeSubToolboxModal = function () {
        const modal = document.getElementById('subToolboxModal');
        if (modal) {
            modal.classList.remove('show');
            modal.style.display = 'none';
        }
    };

    function showSubToolboxModal() {
        // Always show the instructions now; clear any legacy suppression flags
        try {
            localStorage.removeItem('submaker_dont_show_sub_toolbox');
            localStorage.removeItem('submaker_dont_show_file_translation');
        } catch (_) { }
        openModalById('subToolboxModal');
    }

    function updateSubToolboxInstructionsLink() {
        const wrappers = [
            document.getElementById('subToolboxInstructionsWrapper'),
            document.getElementById('subToolboxInstructionsWrapperNoTranslation'),
        ];
        wrappers.forEach(wrapper => {
            if (wrapper) {
                wrapper.style.display = 'inline';
            }
        });
        const links = [
            document.getElementById('subToolboxInstructionsLink'),
            document.getElementById('subToolboxInstructionsLinkNoTranslation'),
        ];
        links.forEach(link => {
            if (link) {
                link.tabIndex = 0;
            }
        });
    }

    function setSubToolboxEnabledUI(isEnabled) {
        const toolboxToggle = document.getElementById('subToolboxEnabled');
        if (toolboxToggle) {
            toolboxToggle.checked = isEnabled;
        }
        const toolboxToggleNoTranslation = document.getElementById('subToolboxEnabledNoTranslation');
        if (toolboxToggleNoTranslation) {
            toolboxToggleNoTranslation.checked = isEnabled;
        }
        updateSubToolboxInstructionsLink();
        toggleOtherApiKeysSection();
    }

    // (Removed extra window load fallback to reduce complexity)

    // Unified delegated click handler (capture) for modals/FAB
    document.addEventListener('click', function (e) {
        const target = e.target;
        if ((Date.now() - tokenVaultLauncherPointerDownAt) < 500) {
            const clickedLauncher = target && target.closest ? target.closest('#tokenVaultLauncher') : null;
            if (!clickedLauncher) {
                return;
            }
        }
        const overlay = target && target.closest ? target.closest('.modal-overlay') : null;
        const clickedInsideModal = target && target.closest ? target.closest('.modal, .token-vault-panel, .token-vault-override-panel') : null;
        const clickedInsideVaultRail = target && target.closest ? target.closest('#tokenVaultRail, #tokenVaultLauncher, #tokenVaultRailFloatingMenu') : null;

        if (overlay && !clickedInsideModal) {
            if (overlay.id === 'instructionsModal') {
                closeInstructionsModal();
                return;
            } else if (overlay.id === 'subToolboxModal') {
                closeSubToolboxModal();
                return;
            } else if (overlay.id === 'tokenVaultModal') {
                closeTokenVault();
                return;
            } else if (overlay.id === 'tokenVaultCreateModal') {
                closeTokenVaultCreator();
                return;
            } else if (overlay.id === 'tokenVaultOverrideModal') {
                void closeTokenVaultOverridePrompt(true);
                return;
            } else if (overlay.id === 'resetConfirmModal') {
                const modal = document.getElementById('resetConfirmModal');
                if (modal) { modal.classList.remove('show'); modal.style.display = 'none'; updateBodyScrollLock(); }
                return;
            }
        }

        if (tokenVaultRailOpen && !clickedInsideVaultRail && !clickedInsideModal) {
            closeTokenVaultRail();
        }

        const actionEl = target && target.closest
            ? target.closest('#closeInstructionsBtn, #gotItInstructionsBtn, #closeSubToolboxBtn, #gotItSubToolboxBtn, .modal-close')
            : null;
        if (actionEl) {
            if (actionEl.id === 'closeInstructionsBtn' || actionEl.id === 'gotItInstructionsBtn' || (actionEl.classList.contains('modal-close') && actionEl.closest('#instructionsModal'))) {
                window.closeInstructionsModal();
                return;
            }
            if (actionEl.id === 'closeSubToolboxBtn' || actionEl.id === 'gotItSubToolboxBtn' || (actionEl.classList.contains('modal-close') && actionEl.closest('#subToolboxModal'))) {
                window.closeSubToolboxModal();
                return;
            }
        }

        const fab = target && target.closest ? target.closest('#configHelp, #instructionsFab') : null;
        if (fab) {
            hideInstructionsFab();
            if (instructionsAutoMinimizeTimer) {
                clearTimeout(instructionsAutoMinimizeTimer);
                instructionsAutoMinimizeTimer = null;
            }
            syncConfigInstructionsPreferenceUi();
            openModalById('instructionsModal');
            return;
        }
    }, true);

    // Close modals with Escape key (priority handler)
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            const instructionsModal = document.getElementById('instructionsModal');
            const subToolboxModal = document.getElementById('subToolboxModal');
            const tokenVaultModal = document.getElementById('tokenVaultModal');
            const tokenVaultCreateModal = document.getElementById('tokenVaultCreateModal');
            const tokenVaultOverrideModal = document.getElementById('tokenVaultOverrideModal');
            const resetConfirmModal = document.getElementById('resetConfirmModal');

            if (tokenVaultOverrideModal && tokenVaultOverrideModal.classList.contains('show')) {
                e.preventDefault();
                e.stopPropagation();
                void closeTokenVaultOverridePrompt(true);
            } else if (tokenVaultCreateModal && tokenVaultCreateModal.classList.contains('show')) {
                e.preventDefault();
                e.stopPropagation();
                closeTokenVaultCreator();
            } else if (instructionsModal && instructionsModal.classList.contains('show')) {
                e.preventDefault();
                e.stopPropagation();
                closeInstructionsModal();
            } else if (subToolboxModal && subToolboxModal.classList.contains('show')) {
                e.preventDefault();
                e.stopPropagation();
                closeSubToolboxModal();
            } else if (tokenVaultModal && tokenVaultModal.classList.contains('show')) {
                e.preventDefault();
                e.stopPropagation();
                closeTokenVault();
            } else if (tokenVaultRailOpen) {
                e.preventDefault();
                e.stopPropagation();
                if (tokenVaultRailMenuKey) {
                    closeTokenVaultRailMenu();
                } else {
                    closeTokenVaultRail();
                }
            } else if (resetConfirmModal && resetConfirmModal.classList.contains('show')) {
                e.preventDefault();
                e.stopPropagation();
                resetConfirmModal.classList.remove('show');
                resetConfirmModal.style.display = 'none';
                updateBodyScrollLock();
            }
        }
    }, true); // Use capture phase to handle before other listeners

    function parseConfigFromUrl() {
        // Legacy base64 configs are no longer supported; default to a fresh config
        return getDefaultConfig();
    }

    /**
     * Check if advanced settings differ from defaults
     * @returns {boolean} - True if any advanced setting is modified
     */
    function areAdvancedSettingsModified() {
        if (!isBetaModeEnabled()) return false;
        // Get the currently selected base model to determine model-specific defaults
        const geminiModelEl = document.getElementById('geminiModel');
        const currentBaseModel = geminiModelEl ? geminiModelEl.value : 'gemini-flash-latest';
        const defaults = getDefaultConfig(currentBaseModel).advancedSettings;

        const advModelEl = document.getElementById('advancedModel');
        const advThinkingEl = document.getElementById('advancedThinkingBudget');
        const advTempEl = document.getElementById('advancedTemperature');
        const advTopPEl = document.getElementById('advancedTopP');
        const batchCtxEl = document.getElementById('enableBatchContext');
        const ctxSizeEl = document.getElementById('contextSize');

        if (!advModelEl || !advThinkingEl || !advTempEl || !advTopPEl) {
            return false; // Elements not loaded yet
        }

        // Check if any value differs from model-specific defaults
        const modelChanged = advModelEl.value !== (defaults.geminiModel || '');
        const thinkingChanged = parseInt(advThinkingEl.value) !== defaults.thinkingBudget;
        const tempChanged = parseFloat(advTempEl.value) !== defaults.temperature;
        const topPChanged = parseFloat(advTopPEl.value) !== defaults.topP;
        // Batch context changes are also considered advanced modifications
        const batchCtxChanged = batchCtxEl ? (batchCtxEl.checked !== (defaults.enableBatchContext === true)) : false;
        const ctxSizeChanged = ctxSizeEl ? (parseInt(ctxSizeEl.value) !== (defaults.contextSize || 8)) : false;
        // Mismatch retries change
        const mismatchRetriesEl = document.getElementById('mismatchRetries');
        const mismatchRetriesChanged = mismatchRetriesEl ? (parseInt(mismatchRetriesEl.value) !== (defaults.mismatchRetries ?? 1)) : false;
        // Workflow change (default is 'xml')
        const workflowChanged = getSelectedTranslationWorkflow('xml') !== 'xml';

        return modelChanged || thinkingChanged || tempChanged || topPChanged || batchCtxChanged || ctxSizeChanged || mismatchRetriesChanged || workflowChanged;
    }

    /**
     * Update database mode dropdown state based on advanced settings or multi-provider mode
     */
    function updateBypassCacheForAdvancedSettings() {
        const databaseModeEl = document.getElementById('databaseMode');
        const noteEl = document.getElementById('databaseModeNote');
        const reasonEl = document.getElementById('databaseModeReason');

        if (!databaseModeEl) return;

        const isModified = areAdvancedSettingsModified();
        const multiProvidersActive = isMultiProviderActiveInForm();

        const reasons = [];
        if (isModified) reasons.push('Advanced Settings are modified');
        if (multiProvidersActive) reasons.push('Multiple Providers mode is active');

        const forceBypass = reasons.length > 0;

        if (forceBypass) {
            // Lock dropdown to bypass mode and show explanation
            databaseModeEl.value = 'bypass';
            databaseModeEl.disabled = true;
            if (noteEl) {
                noteEl.style.display = 'block';
                if (reasonEl) {
                    reasonEl.textContent = reasons.join(', ') + '. These settings require bypass mode to avoid polluting the shared database with experimental translations.';
                }
            }
        } else {
            // Unlock dropdown and hide explanation
            databaseModeEl.disabled = false;
            if (noteEl) noteEl.style.display = 'none';
        }
    }

    async function loadLanguages() {
        const maxRetries = 3;
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

                // Fetch both endpoints in parallel
                const [providerResponse, translationResponse] = await Promise.all([
                    fetch('/api/languages', {
                        signal: controller.signal,
                        method: 'GET',
                        headers: { 'Accept': 'application/json' }
                    }),
                    fetch('/api/languages/translation', {
                        signal: controller.signal,
                        method: 'GET',
                        headers: { 'Accept': 'application/json' }
                    })
                ]);

                clearTimeout(timeoutId);

                if (!providerResponse.ok) {
                    throw new Error(`HTTP ${providerResponse.status}: ${providerResponse.statusText}`);
                }
                if (!translationResponse.ok) {
                    throw new Error(`HTTP ${translationResponse.status}: ${translationResponse.statusText}`);
                }

                const providerLangs = await providerResponse.json();
                const translationLangs = await translationResponse.json();

                // Filter out special fake languages (like ___upload for File Translation) and dedupe variants
                providerLanguages = dedupeLanguagesForUI(providerLangs.filter(lang => !lang.code.startsWith('___')));
                translationLanguages = dedupeLanguagesForUI(translationLangs.filter(lang => !lang.code.startsWith('___')));

                // Build combined lookup for chip display (translation languages include all provider languages)
                // Use a Map to dedupe by code, preferring translationLanguages entries (they have more info)
                const combinedMap = new Map();
                providerLanguages.forEach(lang => combinedMap.set(lang.code, lang));
                translationLanguages.forEach(lang => combinedMap.set(lang.code, lang));
                allLanguages = Array.from(combinedMap.values());

                // For target/learn grids: filter by extended flag
                const baseTranslationLanguages = translationLanguages.filter(l => !l.extended);

                // Restore extended toggle state from localStorage
                const extToggleSaved = localStorage.getItem('submaker_extended_languages') === 'true';
                const extToggleTarget = document.getElementById('extendedLanguagesToggle');
                const extToggleLearn = document.getElementById('extendedLanguagesToggleLearn');
                if (extToggleTarget) extToggleTarget.checked = extToggleSaved;
                if (extToggleLearn) extToggleLearn.checked = extToggleSaved;

                const targetList = extToggleSaved ? translationLanguages : baseTranslationLanguages;

                // Source and no-translation use provider languages (Stremio/subtitle provider compatible)
                // Target and learn use translation languages (AI can handle regional variants)
                renderLanguageGrid('sourceLanguages', 'selectedSourceLanguages', providerLanguages);
                renderLanguageGrid('targetLanguages', 'selectedTargetLanguages', targetList);
                renderLanguageGrid('noTranslationLanguages', 'selectedNoTranslationLanguages', providerLanguages);
                renderLanguageGrid('learnLanguages', 'selectedLearnLanguages', targetList);

                // Update selected chips
                updateSelectedChips('source', currentConfig.sourceLanguages);
                updateSelectedChips('target', currentConfig.targetLanguages);
                updateSelectedChips('notranslation', currentConfig.noTranslationLanguages);
                updateSelectedChips('learn', currentConfig.learnTargetLanguages);

                return; // Success - exit function
            } catch (error) {
                lastError = error;

                if (attempt < maxRetries) {
                    const delayMs = 1000 * attempt; // Exponential backoff: 1s, 2s, 3s
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
        }

        // All retries failed
        showAlert(tConfig('config.alerts.loadLanguagesExhausted', { retries: maxRetries, reason: lastError.message }, `Failed to load languages after ${maxRetries} attempts: ${lastError.message}. Please refresh the page.`), 'error', 'config.alerts.loadLanguagesExhausted', { retries: maxRetries, reason: lastError.message });
    }

    // Normalize/dedupe languages for UI (e.g., merge ptbr/pt-br/pob into one 'pob')
    function dedupeLanguagesForUI(languages) {
        const byName = new Map();
        const preferCode = (name) => {
            if (name === 'Portuguese (Brazil)') return 'pob';
            return null;
        };

        languages.forEach((lang) => {
            let { code, name } = lang;
            const normalizedName = (name || '').toLowerCase();
            const normalizedCode = (code || '').toLowerCase();

            // Normalize PT-BR variants by name or code
            if (normalizedName.includes('portuguese') && normalizedName.includes('brazil')) {
                name = 'Portuguese (Brazil)';
                code = 'pob';
            } else if (normalizedCode === 'ptbr' || normalizedCode === 'pt-br') {
                name = 'Portuguese (Brazil)';
                code = 'pob';
            }

            if (!byName.has(name)) {
                byName.set(name, { ...lang, code, name });
            } else {
                const preferred = preferCode(name);
                const existing = byName.get(name);
                if (preferred && existing.code !== preferred) {
                    byName.set(name, { ...existing, code: preferred, name });
                }
            }
        });

        return Array.from(byName.values());
    }

    /**
     * Re-render target and learn language grids based on the extended toggle state.
     * Called when the checkbox is toggled.
     */
    function rerenderExtendedGrids(isExtended) {
        localStorage.setItem('submaker_extended_languages', isExtended ? 'true' : 'false');
        // Sync both checkboxes
        const extToggleTarget = document.getElementById('extendedLanguagesToggle');
        const extToggleLearn = document.getElementById('extendedLanguagesToggleLearn');
        if (extToggleTarget) extToggleTarget.checked = isExtended;
        if (extToggleLearn) extToggleLearn.checked = isExtended;

        const baseTranslationLanguages = translationLanguages.filter(l => !l.extended);
        const targetList = isExtended ? translationLanguages : baseTranslationLanguages;
        renderLanguageGrid('targetLanguages', 'selectedTargetLanguages', targetList);
        renderLanguageGrid('learnLanguages', 'selectedLearnLanguages', targetList);
        // Re-apply current selections
        updateSelectedChips('target', currentConfig.targetLanguages);
        updateSelectedChips('learn', currentConfig.learnTargetLanguages);
    }

    function renderLanguageGrid(gridId, selectedId, languages) {
        const grid = document.getElementById(gridId);
        grid.innerHTML = '';

        let configKey, type;
        if (gridId === 'sourceLanguages') {
            configKey = 'sourceLanguages';
            type = 'source';
        } else if (gridId === 'noTranslationLanguages') {
            configKey = 'noTranslationLanguages';
            type = 'notranslation';
        } else if (gridId === 'learnLanguages') {
            configKey = 'learnTargetLanguages';
            type = 'learn';
        } else {
            configKey = 'targetLanguages';
            type = 'target';
        }

        languages.forEach(lang => {
            const isSelected = currentConfig[configKey].includes(lang.code);
            const item = document.createElement('div');
            item.className = `language-item ${isSelected ? 'selected' : ''}`;
            item.dataset.code = lang.code;
            item.dataset.name = lang.name.toLowerCase();
            item.textContent = `${lang.name} (${lang.code.toUpperCase()})`;
            grid.appendChild(item);
        });
    }

    function toggleLanguage(type, code, element) {
        let configKey;
        if (type === 'source') {
            configKey = 'sourceLanguages';
        } else if (type === 'notranslation') {
            configKey = 'noTranslationLanguages';
        } else if (type === 'learn') {
            configKey = 'learnTargetLanguages';
        } else {
            configKey = 'targetLanguages';
        }

        const index = currentConfig[configKey].indexOf(code);

        if (index > -1) {
            // Remove language
            currentConfig[configKey].splice(index, 1);
            element.classList.remove('selected');
        } else {
            // Add language
            if (type === 'source') {
                if (currentConfig[configKey].length >= MAX_SOURCE_LANGUAGES) {
                    showAlert(tConfig('config.alerts.sourceLimit', { limit: MAX_SOURCE_LANGUAGES }, `You can only select up to ${MAX_SOURCE_LANGUAGES} source languages`), 'warning', 'config.alerts.sourceLimit', { limit: MAX_SOURCE_LANGUAGES });
                    return;
                }
                currentConfig[configKey].push(code);
            } else if (type === 'target' || type === 'learn') {
                if (!canAddTargetLanguage(code)) {
                    showAlert(tConfig('config.alerts.targetLimit', { limit: MAX_TARGET_LANGUAGES }, `You can only select up to ${MAX_TARGET_LANGUAGES} total target languages (including Learn Mode)`), 'warning', 'config.alerts.targetLimit', { limit: MAX_TARGET_LANGUAGES });
                    return;
                }
                currentConfig[configKey].push(code);
            } else if (type === 'notranslation') {
                if (currentConfig[configKey].length >= MAX_NO_TRANSLATION_LANGUAGES) {
                    showAlert(tConfig('config.alerts.noTranslationLimit', { limit: MAX_NO_TRANSLATION_LANGUAGES }, `You can only select up to ${MAX_NO_TRANSLATION_LANGUAGES} languages in Just Fetch mode`), 'warning', 'config.alerts.noTranslationLimit', { limit: MAX_NO_TRANSLATION_LANGUAGES });
                    return;
                }
                currentConfig[configKey].push(code);
            } else {
                // Fallback: allow multiple selections for any other types
                currentConfig[configKey].push(code);
            }
            element.classList.add('selected');
        }

        updateSelectedChips(type, currentConfig[configKey]);
    }

    function updateSelectedChips(type, languageCodes) {
        let containerId, badgeId, configKey;
        if (type === 'source') {
            containerId = 'selectedSourceLanguages';
            badgeId = 'sourceBadge';
            configKey = 'sourceLanguages';
        } else if (type === 'notranslation') {
            containerId = 'selectedNoTranslationLanguages';
            badgeId = null; // No badge for no-translation
            configKey = 'noTranslationLanguages';
        } else if (type === 'learn') {
            containerId = 'selectedLearnLanguages';
            badgeId = 'learnBadge';
            configKey = 'learnTargetLanguages';
        } else {
            containerId = 'selectedTargetLanguages';
            badgeId = 'targetBadge';
            configKey = 'targetLanguages';
        }

        const container = document.getElementById(containerId);
        const badge = badgeId ? document.getElementById(badgeId) : null;

        container.innerHTML = '';

        // Prune stale codes that no longer exist in allLanguages (e.g. after normalization)
        if (allLanguages && allLanguages.length > 0) {
            const validCodes = new Set(allLanguages.map(l => l.code));
            const pruned = languageCodes.filter(code => validCodes.has(code));
            if (pruned.length !== languageCodes.length) {
                languageCodes.length = 0;
                pruned.forEach(c => languageCodes.push(c));
                // Sync back to currentConfig so saved config won't contain stale codes
                if (currentConfig[configKey]) {
                    currentConfig[configKey].length = 0;
                    pruned.forEach(c => currentConfig[configKey].push(c));
                }
            }
        }

        // Render chips
        languageCodes.forEach(code => {
            const lang = allLanguages.find(l => l.code === code);
            if (!lang) return;
            const chip = document.createElement('div');
            chip.className = 'language-chip';
            chip.dataset.code = code;
            chip.innerHTML = `
                <span>${lang.name} (${lang.code.toUpperCase()})</span>
                <span class="remove">×</span>
            `;
            container.appendChild(chip);
        });

        const chipCount = container.children.length;

        // Update badge count based on actual rendered chips
        if (badge) {
            badge.textContent = chipCount;
            badge.style.display = chipCount > 0 ? 'inline-flex' : 'none';
        }

        // Live validation
        if (type === 'source' || type === 'target' || type === 'learn') {
            validateLanguageSelection(type);
        } else if (type === 'notranslation') {
            validateNoTranslationSelection();
        }

        // Toggle empty class based on actual rendered chips,
        // so the container hides properly when no valid chips exist
        container.classList.toggle('empty', chipCount === 0);
    }

    function syncGridSelection(gridId, selectedList) {
        const grid = document.getElementById(gridId);
        if (!grid) return;
        const selected = new Set(selectedList || []);
        grid.querySelectorAll('.language-item').forEach(item => {
            if (selected.has(item.dataset.code)) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
        });
    }

    function removeLanguage(type, code) {
        let configKey, gridId;
        if (type === 'source') {
            configKey = 'sourceLanguages';
            gridId = 'sourceLanguages';
        } else if (type === 'notranslation') {
            configKey = 'noTranslationLanguages';
            gridId = 'noTranslationLanguages';
        } else if (type === 'learn') {
            configKey = 'learnTargetLanguages';
            gridId = 'learnLanguages';
        } else {
            configKey = 'targetLanguages';
            gridId = 'targetLanguages';
        }

        const index = currentConfig[configKey].indexOf(code);
        if (index > -1) {
            currentConfig[configKey].splice(index, 1);
        }

        // Update grid item
        const grid = document.getElementById(gridId);
        const item = grid.querySelector(`[data-code="${code}"]`);
        if (item) {
            item.classList.remove('selected');
        }

        updateSelectedChips(type, currentConfig[configKey]);
    }

    function bindTokenVaultUiEventListeners() {
        if (!tokenVaultGlobalEventsBound) {
            tokenVaultGlobalEventsBound = true;
            try {
                window.__tokenVaultUiReady = true;
            } catch (_) { }

            document.addEventListener('pointerdown', function (e) {
                const launcher = e.target && e.target.closest ? e.target.closest('#tokenVaultLauncher') : null;
                if (!launcher) return;
                if (e.pointerType === 'touch') return;
                if (typeof e.button === 'number' && e.button !== 0) return;

                tokenVaultLauncherPointerDownAt = Date.now();
                e.preventDefault();
                e.stopPropagation();
                try {
                    launcher.focus({ preventScroll: true });
                } catch (_) {
                    launcher.focus();
                }
                toggleTokenVaultRail();
            }, true);

            document.addEventListener('click', function (e) {
                const launcher = e.target && e.target.closest ? e.target.closest('#tokenVaultLauncher') : null;
                if (!launcher) return;

                e.preventDefault();
                e.stopPropagation();
                if ((Date.now() - tokenVaultLauncherPointerDownAt) < 500) {
                    return;
                }
                toggleTokenVaultRail();
            }, true);
        }

        const tokenVaultRail = document.getElementById('tokenVaultRail');
        if (tokenVaultRail && !tokenVaultRail.__vaultBound) {
            tokenVaultRail.__vaultBound = true;
            tokenVaultRail.addEventListener('scroll', () => {
                scheduleTokenVaultRailFloatingMenuSync();
            }, { passive: true });
            tokenVaultRail.addEventListener('click', async (e) => {
                const actionEl = e.target && e.target.closest ? e.target.closest('[data-vault-action]') : null;
                if (!actionEl) {
                    const clickedRailMenu = e.target && e.target.closest ? e.target.closest('.token-vault-rail-menu') : null;
                    if (tokenVaultRailMenuKey && !clickedRailMenu) {
                        closeTokenVaultRailMenu();
                    }
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                try {
                    await handleTokenVaultAction(actionEl);
                } catch (error) {
                    showAlert(error.message || 'Token Vault action failed.', 'error');
                }
            });
        }
        const tokenVaultModal = document.getElementById('tokenVaultModal');
        if (tokenVaultModal && !tokenVaultModal.__vaultBound) {
            tokenVaultModal.__vaultBound = true;
            tokenVaultModal.addEventListener('click', async (e) => {
                const actionEl = e.target && e.target.closest ? e.target.closest('[data-vault-action]') : null;
                if (!actionEl) return;
                e.preventDefault();
                try {
                    await handleTokenVaultAction(actionEl);
                } catch (error) {
                    showAlert(error.message || 'Token Vault action failed.', 'error');
                }
            });
            tokenVaultModal.addEventListener('input', (e) => {
                if (e.target?.id === 'tokenVaultTitleInlineInput') {
                    tokenVaultTitleEditValue = e.target.value;
                }
            });
            tokenVaultModal.addEventListener('keydown', async (e) => {
                if (e.target?.id !== 'tokenVaultTitleInlineInput') return;
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    resetTokenVaultTitleEditor();
                    renderTokenVault();
                    return;
                }
                if (e.key !== 'Enter' || e.shiftKey) return;
                const actionEl = tokenVaultModal.querySelector('[data-vault-action="save-label"]');
                if (!actionEl || actionEl.disabled) return;
                e.preventDefault();
                e.stopPropagation();
                try {
                    await handleTokenVaultAction(actionEl);
                } catch (error) {
                    showAlert(error.message || 'Token Vault action failed.', 'error');
                }
            });
        }
        const tokenVaultCreateModal = document.getElementById('tokenVaultCreateModal');
        if (tokenVaultCreateModal && !tokenVaultCreateModal.__vaultBound) {
            tokenVaultCreateModal.__vaultBound = true;
            tokenVaultCreateModal.addEventListener('click', async (e) => {
                const actionEl = e.target && e.target.closest ? e.target.closest('[data-vault-action]') : null;
                if (!actionEl) return;
                e.preventDefault();
                try {
                    await handleTokenVaultAction(actionEl);
                } catch (error) {
                    showAlert(error.message || 'Token Vault action failed.', 'error');
                }
            });
            tokenVaultCreateModal.addEventListener('input', (e) => {
                if (e.target?.id === 'tokenVaultCreateInput') {
                    scheduleTokenVaultCreatorPreview(e.target.value);
                }
            });
            tokenVaultCreateModal.addEventListener('keydown', async (e) => {
                if (e.target?.id !== 'tokenVaultCreateInput') return;
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    closeTokenVaultCreator();
                    return;
                }
                if (e.key !== 'Enter' || e.shiftKey) return;
                const actionEl = document.getElementById('tokenVaultCreateImportBtn');
                if (!actionEl || actionEl.disabled) return;
                e.preventDefault();
                e.stopPropagation();
                try {
                    await handleTokenVaultAction(actionEl);
                } catch (error) {
                    showAlert(error.message || 'Token Vault action failed.', 'error');
                }
            });
        }
        const tokenVaultOverrideModal = document.getElementById('tokenVaultOverrideModal');
        if (tokenVaultOverrideModal && !tokenVaultOverrideModal.__vaultBound) {
            tokenVaultOverrideModal.__vaultBound = true;
            tokenVaultOverrideModal.addEventListener('click', async (e) => {
                const actionEl = e.target && e.target.closest ? e.target.closest('[data-vault-override-action]') : null;
                if (!actionEl) return;
                e.preventDefault();
                e.stopPropagation();
                try {
                    await handleTokenVaultOverrideAction(actionEl);
                } catch (error) {
                    showAlert(error.message || 'Token Vault confirmation failed.', 'error');
                }
            });
        }
        const tokenVaultImportFile = document.getElementById('tokenVaultImportFile');
        if (tokenVaultImportFile && !tokenVaultImportFile.__vaultBound) {
            tokenVaultImportFile.__vaultBound = true;
            tokenVaultImportFile.addEventListener('change', async (e) => {
                const file = e.target?.files?.[0];
                if (!file) return;
                try {
                    await handleTokenVaultBackupFile(file, {
                        onApplied: async () => {
                            if (document.getElementById('tokenVaultCreateModal')?.classList.contains('show')) {
                                renderTokenVaultCreator();
                            }
                        }
                    });
                } catch (error) {
                    showAlert(error.message || 'Failed to import JSON file.', 'error');
                } finally {
                    e.target.value = '';
                }
            });
        }

        consumePendingTokenVaultLauncherOpenRequest();
    }

    function setupEventListeners() {
        // Form submission
        document.getElementById('configForm').addEventListener('submit', handleSubmit);
        document.getElementById('configForm').addEventListener('input', () => {
            if (!suppressDirtyTracking) setConfigDirty(true);
        }, true);
        document.getElementById('configForm').addEventListener('change', () => {
            if (!suppressDirtyTracking) setConfigDirty(true);
        }, true);

        bindTokenVaultUiEventListeners();
        syncConfigInstructionsPreferenceUi();
        const dontShowInstructions = document.getElementById('dontShowInstructions');
        if (dontShowInstructions && !dontShowInstructions.__submakerBound) {
            dontShowInstructions.addEventListener('change', (event) => {
                persistConfigInstructionsPreference(event.target?.checked === true);
            });
            dontShowInstructions.__submakerBound = true;
        }

        // Quick Setup → Advanced Settings bridge
        // When the Quick Setup wizard's "Open Advanced" button is clicked, it dispatches
        // a 'quickSetupApply' event with the wizard's config. We merge it into currentConfig
        // and reload the form so the user can fine-tune before saving.
        window.addEventListener('quickSetupApply', (e) => {
            if (e.detail && typeof e.detail === 'object') {
                const seedModel = (typeof e.detail.geminiModel === 'string' && e.detail.geminiModel.trim())
                    ? e.detail.geminiModel.trim()
                    : getDefaultGeminiModelOptionValue();
                const defaults = getDefaultConfig(seedModel);
                currentConfig = { ...defaults, ...e.detail };
                ensureProvidersInState();
                ensureProviderParametersInState();
                loadConfigToForm();
                setConfigDirty(true);
                // Reload languages to reflect new selections
                if (typeof loadLanguages === 'function') {
                    loadLanguages().catch(() => { /* ignore */ });
                }
            }
        });

        // More Providers (beta) collapsible section toggle
        const moreProvidersToggle = document.getElementById('moreProvidersToggle');
        const moreProvidersContent = document.getElementById('moreProvidersContent');
        const moreProvidersChevron = document.getElementById('moreProvidersChevron');
        if (moreProvidersToggle && moreProvidersContent && moreProvidersChevron) {
            moreProvidersToggle.addEventListener('click', () => {
                const isExpanded = moreProvidersContent.style.display !== 'none';
                moreProvidersContent.style.display = isExpanded ? 'none' : 'block';
                moreProvidersChevron.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(180deg)';
                moreProvidersToggle.setAttribute('aria-expanded', (!isExpanded).toString());
            });
        }

        // Delegate language grid item clicks to containers (reduces per-item listeners)
        const gridMap = [
            ['sourceLanguages', 'source'],
            ['targetLanguages', 'target'],
            ['learnLanguages', 'learn'],
            ['noTranslationLanguages', 'notranslation']
        ];
        gridMap.forEach(([id, type]) => {
            const grid = document.getElementById(id);
            if (grid && !grid.__delegated) {
                grid.addEventListener('click', (e) => {
                    const item = e.target && e.target.closest ? e.target.closest('.language-item') : null;
                    if (!item || !grid.contains(item)) return;
                    const code = item.dataset.code;
                    if (!code) return;
                    toggleLanguage(type, code, item);
                });
                grid.__delegated = true;
            }
        });

        // Delegate chip removal clicks to selected containers
        const selectedMap = [
            ['selectedSourceLanguages', 'source'],
            ['selectedTargetLanguages', 'target'],
            ['selectedLearnLanguages', 'learn'],
            ['selectedNoTranslationLanguages', 'notranslation']
        ];
        selectedMap.forEach(([id, type]) => {
            const box = document.getElementById(id);
            if (box && !box.__delegated) {
                box.addEventListener('click', (e) => {
                    const chip = e.target && e.target.closest ? e.target.closest('.language-chip') : null;
                    if (!chip || !box.contains(chip)) return;
                    const code = chip.dataset.code;
                    if (code) removeLanguage(type, code);
                });
                box.__delegated = true;
            }
        });

        const dock = document.getElementById('uiLanguageDock');
        if (dock) {
            dock.addEventListener('click', (e) => {
                e.stopPropagation();
                const clickedFlag = e.target && e.target.closest ? e.target.closest('.ui-lang-flag') : null;
                // Allow clicking the active flag to expand/collapse the menu.
                // Non-active flags have their own click handler to switch languages.
                if (clickedFlag && !clickedFlag.classList.contains('active')) return;
                setUiLanguageExpanded(!uiLanguageExpanded);
            });
        }
        document.addEventListener('click', () => {
            if (uiLanguageExpanded) setUiLanguageExpanded(false);
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && uiLanguageExpanded) {
                setUiLanguageExpanded(false);
            }
        });

        // Gemini API key auto-fetch - triggers when API key is typed/pasted
        const apiKeyInput = document.getElementById('geminiApiKey');
        if (apiKeyInput) {
            apiKeyInput.addEventListener('input', (e) => {
                const apiKey = e.target.value.trim();

                // Clear any existing timeout
                if (modelsFetchTimeout) {
                    clearTimeout(modelsFetchTimeout);
                    modelsFetchTimeout = null;
                }

                // Schedule model fetch if API key is valid length
                if (apiKey && apiKey.length >= 10 && apiKey !== lastFetchedApiKey) {
                    modelsFetchTimeout = setTimeout(() => {
                        autoFetchModels(apiKey);
                        modelsFetchTimeout = null;
                    }, 1500);
                }
            });
        }

        // Full reset button
        const resetBtn = document.getElementById('resetSettingsBtn');
        if (resetBtn) {
            resetBtn.addEventListener('click', openResetConfirm);
        }
        // Reset confirm modal buttons
        document.getElementById('confirmResetBtn')?.addEventListener('click', performFullReset);
        document.getElementById('cancelResetBtn')?.addEventListener('click', closeResetConfirmModal);
        document.getElementById('closeResetConfirmBtn')?.addEventListener('click', closeResetConfirmModal);

        // Search functionality
        document.getElementById('sourceSearch').addEventListener('input', (e) => {
            filterLanguages('sourceLanguages', e.target.value);
        });

        document.getElementById('targetSearch').addEventListener('input', (e) => {
            filterLanguages('targetLanguages', e.target.value);
        });

        // Extended languages toggle (Target + Learn)
        const extToggleTarget = document.getElementById('extendedLanguagesToggle');
        const extToggleLearn = document.getElementById('extendedLanguagesToggleLearn');
        if (extToggleTarget) {
            extToggleTarget.addEventListener('change', (e) => {
                rerenderExtendedGrids(e.target.checked);
            });
        }
        if (extToggleLearn) {
            extToggleLearn.addEventListener('change', (e) => {
                rerenderExtendedGrids(e.target.checked);
            });
        }

        // No-translation mode toggle
        const noTranslationToggle = document.getElementById('noTranslationMode');
        if (noTranslationToggle) {
            noTranslationToggle.addEventListener('change', (e) => {
                toggleNoTranslationMode(e.target.checked);
            });
        }

        const assemblyKeyInput = document.getElementById('assemblyAiApiKey');
        if (assemblyKeyInput) {
            assemblyKeyInput.addEventListener('input', () => {
                if (assemblyKeyInput.value.trim()) {
                    toggleOtherApiKeysSection();
                }
            });
        }

        const cloudflareKeyInput = document.getElementById('cloudflareWorkersApiKey');
        if (cloudflareKeyInput) {
            cloudflareKeyInput.addEventListener('input', () => {
                if (cloudflareKeyInput.value.trim()) {
                    toggleOtherApiKeysSection();
                }
            });
        }

        const validateCloudflareBtn = document.getElementById('validateCloudflareWorkers');
        if (validateCloudflareBtn) {
            validateCloudflareBtn.addEventListener('click', () => validateCloudflareWorkersKey(true));
        }

        const validateAssemblyAiBtn = document.getElementById('validateAssemblyAi');
        if (validateAssemblyAiBtn) {
            validateAssemblyAiBtn.addEventListener('click', validateAssemblyAiKey);
        }

        // No-translation language search
        const noTranslationSearch = document.getElementById('noTranslationSearch');
        if (noTranslationSearch) {
            noTranslationSearch.addEventListener('input', (e) => {
                filterLanguages('noTranslationLanguages', e.target.value);
            });
        }

        // Learn language search
        const learnSearch = document.getElementById('learnSearch');
        if (learnSearch) {
            learnSearch.addEventListener('input', (e) => {
                filterLanguages('learnLanguages', e.target.value);
            });
        }

        // Quick action buttons
        document.querySelectorAll('.quick-btn').forEach(btn => {
            btn.addEventListener('click', handleQuickAction);
        });

        // Provider toggles
        document.getElementById('enableOpenSubtitles').addEventListener('change', (e) => {
            toggleProviderConfig('opensubtitlesConfig', e.target.checked);
        });

        // OpenSubtitles implementation type - attach listeners directly to radio buttons
        const implRadios = document.querySelectorAll('input[name="opensubtitlesImplementation"]');
        implRadios.forEach(radio => {
            radio.addEventListener('change', handleOpenSubtitlesImplChange);
        });

        // Password visibility toggle
        const togglePasswordBtn = document.getElementById('toggleOpenSubsPassword');
        if (togglePasswordBtn) {
            togglePasswordBtn.addEventListener('click', () => {
                const passwordInput = document.getElementById('opensubtitlesPassword');
                if (!passwordInput) return;

                // Toggle masked state without using password inputs to avoid browser save prompts
                const isMasked = passwordInput.classList.toggle('masked');
                togglePasswordBtn.textContent = isMasked ? '🔒👁' : '👁';
                togglePasswordBtn.title = isMasked ? 'Show password' : 'Hide password';
            });
        }

        // Gemini API key visibility toggle
        const toggleGeminiKeyBtn = document.getElementById('toggleGeminiApiKey');
        if (toggleGeminiKeyBtn) {
            toggleGeminiKeyBtn.addEventListener('click', () => {
                const keyInput = document.getElementById('geminiApiKey');
                if (!keyInput) return;

                const isMasked = keyInput.classList.toggle('masked');
                toggleGeminiKeyBtn.textContent = isMasked ? '🔒👁' : '👁';
                toggleGeminiKeyBtn.title = isMasked
                    ? tConfig('config.gemini.apiKey.showKey', {}, 'Show API key')
                    : tConfig('config.gemini.apiKey.hideKey', {}, 'Hide API key');
            });
        }

        // Database mode dropdown - handles cache/bypass selection
        const databaseModeEl = document.getElementById('databaseMode');
        if (databaseModeEl) {
            databaseModeEl.addEventListener('change', handleDatabaseModeChange);
        }

        document.getElementById('enableSubDL').addEventListener('change', (e) => {
            toggleProviderConfig('subdlConfig', e.target.checked);
        });

        document.getElementById('enableSubSource').addEventListener('change', (e) => {
            toggleProviderConfig('subsourceConfig', e.target.checked);
        });

        // Subs.ro toggle and config visibility
        const subsroToggle = document.getElementById('enableSubsRo');
        if (subsroToggle) {
            subsroToggle.addEventListener('change', (e) => {
                toggleProviderConfig('subsroConfig', e.target.checked);
            });
        }

        // Install and copy buttons
        document.getElementById('installBtn').addEventListener('click', installAddon);
        document.getElementById('copyBtn').addEventListener('click', copyInstallUrl);
        const toolboxLauncher = document.getElementById('subToolboxLauncher');
        if (toolboxLauncher) {
            toolboxLauncher.addEventListener('click', () => {
                const configRef = toolboxLauncher.dataset.configRef || getActiveConfigRef();
                const url = buildToolboxUrl(configRef);
                if (!url) {
                    showAlert(tConfig('config.alerts.saveConfigFirst', {}, 'Save your config first to open Sub Toolbox.'), 'warning', 'config.alerts.saveConfigFirst', {});
                    return;
                }
                window.open(url, '_blank', 'noopener,noreferrer');
            });
        }
        window.addEventListener('resize', debounce(() => updateToolboxLauncherVisibility(), 150));

        // Section collapse helpers (API keys, Languages, Settings)
        const sectionCollapseConfigs = [
            { id: 'apiKeysSection', toggleAttr: 'api-keys' },
            { id: 'languagesSection', toggleAttr: 'languages' },
            { id: 'settingsSection', toggleAttr: 'settings' },
        ];
        const SECTION_SCROLL_OFFSET = 18;
        // Collapse all cards with headers inside a section (skip headerless cards used as inline content)
        const collapseSectionCards = (section) => {
            if (!section) return;
            section.querySelectorAll('.card').forEach(card => {
                if (!card.querySelector('.card-header')) return;
                card.classList.add('collapsed');
                const btn = card.querySelector('.collapse-btn');
                if (btn) btn.classList.add('collapsed');
            });
        };
        // Keep always-on cards (like just-fetch languages) visible when a section is opened
        const expandHeaderlessCards = (section) => {
            if (!section) return;
            section.querySelectorAll('.card').forEach(card => {
                if (card.querySelector('.card-header')) return;
                card.classList.remove('collapsed');
            });
        };
        const scrollSectionHeaderIntoView = (section) => {
            if (!section) return;
            const header = section.querySelector('.section-header');
            if (!header) return;
            const rect = header.getBoundingClientRect();
            const isHeaderVisible = rect.bottom > 0 && rect.top < window.innerHeight;
            if (isHeaderVisible) return;
            const targetY = Math.max(0, header.getBoundingClientRect().top + window.scrollY - SECTION_SCROLL_OFFSET);
            const delta = Math.abs(window.scrollY - targetY);
            if (delta < 4) return;
            window.scrollTo({ top: targetY, behavior: 'smooth' });
        };
        sectionCollapseConfigs.forEach(({ id, toggleAttr }) => {
            const section = document.getElementById(id);
            const sectionBody = section ? section.querySelector('.section-grid') : null;
            const sectionFooter = section ? section.querySelector('.section-footer') : null;
            const sectionHeader = section ? section.querySelector('.section-header') : null;
            const toggles = Array.from(document.querySelectorAll(
                `[data-collapse-section="${toggleAttr}"], [data-section-close="${toggleAttr}"]`
            ));
            const toggleSection = () => {
                if (!section) return;
                const wasCollapsed = section.classList.contains('collapsed');
                section.classList.toggle('collapsed');
                toggles.forEach(btn => btn.classList.toggle('collapsed'));
                const nowCollapsed = section.classList.contains('collapsed');
                if (!wasCollapsed && nowCollapsed) {
                    collapseSectionCards(section);
                }
                if (wasCollapsed && !nowCollapsed) {
                    expandHeaderlessCards(section);
                    // Uniform reveal animation for the whole section grid
                    if (sectionBody) {
                        sectionBody.classList.remove('section-reveal');
                        void sectionBody.offsetWidth; // force reflow to restart animation
                        sectionBody.classList.add('section-reveal');
                    }
                }
                if (!wasCollapsed && nowCollapsed) {
                    requestAnimationFrame(() => scrollSectionHeaderIntoView(section));
                }
            };
            if (toggles.length) {
                toggles.forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        toggleSection();
                    });
                });
            }
            if (section && sectionHeader) {
                sectionHeader.addEventListener('click', (e) => {
                    if (e.target.closest('.collapse-btn')) return;
                    // Header should toggle the section without bubbling to the section-level handler (avoids double toggles)
                    e.stopPropagation();
                    toggleSection();
                });
            }
            if (section) {
                section.addEventListener('click', (e) => {
                    // When expanded, only the header should toggle; ignore clicks elsewhere
                    const isCollapsed = section.classList.contains('collapsed');
                    if (!isCollapsed) return;
                    // Ignore dedicated toggle buttons
                    if (e.target.closest('.collapse-btn')) return;
                    if (e.target.closest('[data-section-close]')) return;
                    toggleSection();
                });
            }
        });

        // Card collapse behavior
        // 1) Header click toggles (and stops propagation)
        document.querySelectorAll('.card-header').forEach(header => {
            header.addEventListener('click', (e) => {
                const card = e.currentTarget.closest('.card');
                const collapseBtn = card.querySelector('.collapse-btn');
                card.classList.toggle('collapsed');
                if (collapseBtn) collapseBtn.classList.toggle('collapsed');
                e.stopPropagation();
            });
        });
        // 2) Make entire collapsed card clickable to expand; when expanded, clicks in content do nothing
        document.querySelectorAll('.card').forEach(card => {
            card.addEventListener('click', (e) => {
                const collapseBtn = card.querySelector('.collapse-btn');
                const isCollapsed = card.classList.contains('collapsed');

                // Only handle clicks on collapsed cards; expanded cards should only collapse via the header
                if (!isCollapsed) return;

                card.classList.remove('collapsed');
                if (collapseBtn) collapseBtn.classList.remove('collapsed');
            });
        });

        // Learn Mode toggle and order
        const learnToggle = document.getElementById('learnModeEnabled');
        const learnOrderGroup = document.getElementById('learnOrderGroup');
        const learnPlacementGroup = document.getElementById('learnPlacementGroup');
        const learnTargetsCard = document.getElementById('learnTargetsCard');
        if (learnToggle) {
            learnToggle.addEventListener('change', (e) => {
                const enabled = !!e.target.checked;
                currentConfig.learnMode = enabled;
                if (learnOrderGroup) learnOrderGroup.style.display = enabled ? '' : 'none';
                if (learnPlacementGroup) learnPlacementGroup.style.display = enabled ? '' : 'none';
                if (learnTargetsCard) learnTargetsCard.style.display = enabled ? '' : 'none';
                const learnItalicGroup = document.getElementById('learnItalicGroup');
                if (learnItalicGroup) learnItalicGroup.style.display = enabled ? '' : 'none';
                validateLanguageSelection('learn');
            });
        }
        document.querySelectorAll('input[name="learnOrder"]').forEach(r => {
            r.addEventListener('change', (e) => {
                if (e.target.checked) {
                    currentConfig.learnOrder = e.target.value;
                }
            });
        });
        const learnItalicToggle = document.getElementById('learnItalicEnabled');
        if (learnItalicToggle) {
            learnItalicToggle.addEventListener('change', (e) => {
                currentConfig.learnItalic = !!e.target.checked;
                const targetGroup = document.getElementById('learnItalicTargetGroup');
                if (targetGroup) targetGroup.style.display = e.target.checked ? 'flex' : 'none';
            });
        }
        document.querySelectorAll('input[name="learnItalicTarget"]').forEach(r => {
            r.addEventListener('change', (e) => {
                if (e.target.checked) {
                    currentConfig.learnItalicTarget = e.target.value;
                }
            });
        });
        currentConfig.learnPlacement = 'top';

        // Advanced settings toggle (element may not exist in current UI)
        const showAdv = document.getElementById('showAdvancedSettings');
        if (showAdv) {
            showAdv.addEventListener('change', handleAdvancedSettingsToggle);
        }

        // Live validation
        document.getElementById('geminiApiKey').addEventListener('input', validateGeminiApiKey);
        document.getElementById('geminiModel').addEventListener('change', validateGeminiModel);

        // Gemini API Key Rotation toggle
        const keyRotationToggle = document.getElementById('geminiKeyRotationEnabled');
        if (keyRotationToggle) {
            keyRotationToggle.addEventListener('change', (e) => {
                const enabled = !!e.target.checked;
                currentConfig.geminiKeyRotationEnabled = enabled;
                toggleGeminiKeyRotationUI(enabled);
            });
        }

        // Add Gemini Key button
        const addKeyBtn = document.getElementById('addGeminiKeyBtn');
        if (addKeyBtn) {
            addKeyBtn.addEventListener('click', () => {
                addGeminiKeyInput();
            });
        }

        const betaToggle = document.getElementById('betaMode');
        if (betaToggle) {
            betaToggle.addEventListener('change', (e) => {
                toggleBetaModeUI(!!e.target.checked);
            });
        }

        const devModeToggle = document.getElementById('devMode');
        if (devModeToggle) {
            devModeToggle.addEventListener('change', (e) => {
                currentConfig.devMode = !!e.target.checked;
                toggleOtherApiKeysSection();
                toggleConvertAssToVttGroup();
                toggleUrlExtensionTestGroup();
                syncUrlExtensionTestModeUi();
                toggleAndroidSubtitleCompatModeGroup();
                toggleParallelBatchesGroup();
            });
        }

        // Function to show/hide ASS/SSA passthrough option (user-facing since Phase 1)
        function toggleConvertAssToVttGroup() {
            const convertAssGroup = document.getElementById('convertAssToVttGroup');
            if (!convertAssGroup) return;
            // Always visible - no longer gated by devMode
            convertAssGroup.style.display = 'block';
        }

        // Function to show/hide URL extension test group (requires devMode AND passthrough enabled)
        function toggleUrlExtensionTestGroup() {
            const urlExtTestGroup = document.getElementById('urlExtensionTestGroup');
            if (!urlExtTestGroup) return;
            const devModeEl = document.getElementById('devMode');
            const convertAssEl = document.getElementById('convertAssToVtt');
            const devEnabled = devModeEl && devModeEl.checked;
            // checked = passthrough (ASS conversion OFF)
            const assConversionDisabled = convertAssEl && convertAssEl.checked;
            // Show only when devMode is ON and ASS conversion is OFF (raw ASS mode)
            urlExtTestGroup.style.display = (devEnabled && assConversionDisabled) ? 'block' : 'none';
        }

        // Function to show/hide Android subtitle compatibility mode group (dev mode only)
        function toggleAndroidSubtitleCompatModeGroup() {
            const group = document.getElementById('androidSubtitleCompatModeGroup');
            if (!group) return;
            const devModeEl = document.getElementById('devMode');
            const devEnabled = devModeEl && devModeEl.checked;
            group.style.display = devEnabled ? 'block' : 'none';
        }

        // Function to show/hide Parallel Batches group (dev mode only)
        function toggleParallelBatchesGroup() {
            const group = document.getElementById('parallelBatchesGroup');
            if (!group) return;
            const devModeEl = document.getElementById('devMode');
            const devEnabled = devModeEl && devModeEl.checked;
            group.style.display = devEnabled ? 'block' : 'none';
        }

        // Wire convertAssToVtt to also toggle the test group
        const convertAssEl = document.getElementById('convertAssToVtt');
        if (convertAssEl) {
            convertAssEl.addEventListener('change', () => {
                syncUrlExtensionTestModeUi({ rememberCheckedSelection: true });
                toggleUrlExtensionTestGroup();
            });
        }

        document.querySelectorAll('input[name="urlExtensionTest"]').forEach((radio) => {
            if (radio.__urlExtensionTestListenerBound) return;
            radio.addEventListener('change', (e) => {
                const value = normalizeUrlExtensionTestValue(e.target.value, 'srt');
                currentConfig.urlExtensionTest = value;
                lastUrlExtensionTestChoice = value;
                syncUrlExtensionTestModeUi();
            });
            radio.__urlExtensionTestListenerBound = true;
        });

        // Initial visibility check on load
        toggleConvertAssToVttGroup();
        toggleUrlExtensionTestGroup();
        toggleAndroidSubtitleCompatModeGroup();
        toggleParallelBatchesGroup();

        const parallelBatchesEl = document.getElementById('parallelBatchesEnabled');
        if (parallelBatchesEl) {
            parallelBatchesEl.addEventListener('change', (e) => {
                const checked = !!e.target.checked;
                const countGroup = document.getElementById('parallelBatchesCountGroup');
                if (countGroup) {
                    countGroup.style.display = checked ? 'block' : 'none';
                }
            });
        }

        const multiToggle = document.getElementById('enableMultiProviders');
        if (multiToggle) {
            multiToggle.addEventListener('change', (e) => {
                const enabled = !!e.target.checked;
                currentConfig.multiProviderEnabled = enabled;
                toggleMultiProviderUI(enabled);
                updateMainProviderOptions(currentConfig.mainProvider || 'gemini');
                updateSecondaryProviderOptions(currentConfig.secondaryProvider || '');
                toggleProviderAdvancedCard();
                updateBypassCacheForAdvancedSettings();
            });
        }

        const secondaryToggle = document.getElementById('enableSecondaryProvider');
        if (secondaryToggle) {
            secondaryToggle.addEventListener('change', (e) => {
                const enabled = !!e.target.checked;
                currentConfig.secondaryProviderEnabled = enabled;
                toggleSecondaryProviderUI(enabled);
                updateSecondaryProviderOptions(currentConfig.secondaryProvider || '');
                updateBypassCacheForAdvancedSettings();
            });
        }

        getProviderKeys().forEach(key => {
            const toggle = document.getElementById(`provider-${key}-enabled`);
            if (toggle) {
                toggle.addEventListener('change', (e) => {
                    ensureProvidersInState();
                    ensureProviderParametersInState();
                    currentConfig.providers[key].enabled = e.target.checked;
                    if (e.target.checked && key === 'deepl') {
                        const modelSelect = document.getElementById('provider-deepl-model');
                        if (modelSelect && !modelSelect.value && modelSelect.options.length > 1) {
                            modelSelect.value = modelSelect.options[1].value;
                            currentConfig.providers[key].model = modelSelect.value;
                        }
                    }
                    toggleProviderFields(key, e.target.checked);
                    updateMainProviderOptions(currentConfig.mainProvider || 'gemini');
                    updateSecondaryProviderOptions(currentConfig.secondaryProvider || '');
                    updateProviderAdvancedVisibility();
                });
            }
            const apiKeyInput = document.getElementById(`provider-${key}-key`);
            if (apiKeyInput) {
                apiKeyInput.addEventListener('blur', debounce(() => {
                    if (document.getElementById(`provider-${key}-enabled`)?.checked) {
                        fetchProviderModels(key, { silent: true });
                    }
                }, 400));
            }
            const loadBtn = document.querySelector(`.provider-block[data-provider="${key}"] .validate-api-btn`);
            if (loadBtn) {
                loadBtn.addEventListener('click', () => fetchProviderModels(key));
            }
            const modelSelect = document.getElementById(`provider-${key}-model`);
            if (modelSelect) {
                modelSelect.addEventListener('change', (e) => {
                    ensureProvidersInState();
                    currentConfig.providers[key].model = e.target.value;
                });
            }
        });

        const mainProviderSelect = document.getElementById('mainProviderSelect');
        if (mainProviderSelect) {
            mainProviderSelect.addEventListener('change', (e) => {
                currentConfig.mainProvider = e.target.value || 'gemini';
                updateSecondaryProviderOptions(currentConfig.secondaryProvider || '');
                updateBypassCacheForAdvancedSettings();
            });
        }

        const secondaryProviderSelect = document.getElementById('secondaryProviderSelect');
        if (secondaryProviderSelect) {
            secondaryProviderSelect.addEventListener('change', (e) => {
                currentConfig.secondaryProvider = e.target.value || '';
            });
        }

        // Update advanced settings when model changes (apply model-specific defaults)
        // When user selects a new model, always reset advanced settings to that model's defaults
        // This overrides any cached values from previous model selections
        // Manual changes made AFTER model selection will persist until next model change
        document.getElementById('geminiModel').addEventListener('change', function (e) {
            const selectedModel = e.target.value;
            const modelDefaults = getModelSpecificDefaults(selectedModel);
            const fullDefaults = getDefaultConfig(selectedModel).advancedSettings;

            // Reset ALL advanced settings fields to the new model's defaults
            const advModelEl = document.getElementById('advancedModel');
            const advThinkingEl = document.getElementById('advancedThinkingBudget');
            const advTempEl = document.getElementById('advancedTemperature');
            const advTopPEl = document.getElementById('advancedTopP');

            if (advModelEl) advModelEl.value = ''; // Reset to "Use Default Model"
            if (advThinkingEl) advThinkingEl.value = modelDefaults.thinkingBudget;
            if (advTempEl) advTempEl.value = modelDefaults.temperature;
            if (advTopPEl) advTopPEl.value = fullDefaults.topP;

            // Update bypass cache state based on new defaults
            updateBypassCacheForAdvancedSettings();
        });

        // API Key Validation Buttons
        const validateOpenSubsBtn = document.getElementById('validateOpenSubtitles');
        if (validateOpenSubsBtn) {
            validateOpenSubsBtn.addEventListener('click', () => validateApiKey('opensubtitles'));
        }
        document.getElementById('validateSubSource').addEventListener('click', () => validateApiKey('subsource'));
        document.getElementById('validateSubDL').addEventListener('click', () => validateApiKey('subdl'));
        document.getElementById('validateGemini').addEventListener('click', () => validateApiKey('gemini'));

        // Subs.ro validation button
        const validateSubsRoBtn = document.getElementById('validateSubsRo');
        if (validateSubsRoBtn) {
            validateSubsRoBtn.addEventListener('click', () => validateApiKey('subsro'));
        }

        // File translation toggle - show modal when enabled
        const toolboxToggle = document.getElementById('subToolboxEnabled');
        if (toolboxToggle) {
            toolboxToggle.addEventListener('change', (e) => {
                const enabled = !!e.target.checked;
                setSubToolboxEnabledUI(enabled);
                if (enabled) {
                    showSubToolboxModal();
                }
            });
        }
        const toolboxToggleNoTranslation = document.getElementById('subToolboxEnabledNoTranslation');
        if (toolboxToggleNoTranslation) {
            toolboxToggleNoTranslation.addEventListener('change', (e) => {
                const enabled = !!e.target.checked;
                setSubToolboxEnabledUI(enabled);
                if (enabled) {
                    showSubToolboxModal();
                }
            });
        }
        const toolboxInstructionsLink = document.getElementById('subToolboxInstructionsLink');
        if (toolboxInstructionsLink) {
            toolboxInstructionsLink.addEventListener('click', (e) => {
                e.preventDefault();
                showSubToolboxModal();
            });
        }
        const toolboxInstructionsLinkNoTranslation = document.getElementById('subToolboxInstructionsLinkNoTranslation');
        if (toolboxInstructionsLinkNoTranslation) {
            toolboxInstructionsLinkNoTranslation.addEventListener('click', (e) => {
                e.preventDefault();
                showSubToolboxModal();
            });
        }

        // Advanced Settings - Auto-enable bypass cache when any setting is modified
        const advModelEl = document.getElementById('advancedModel');
        const advThinkingEl = document.getElementById('advancedThinkingBudget');
        const advTempEl = document.getElementById('advancedTemperature');
        const advTopPEl = document.getElementById('advancedTopP');
        const workflowInputs = getTranslationWorkflowInputs();

        // Fetch models when dropdown is clicked (on-demand fallback)
        if (advModelEl) {
            advModelEl.addEventListener('focus', async () => {
                const apiKey = document.getElementById('geminiApiKey').value.trim();
                // Only fetch if we have an API key and haven't fetched yet
                if (apiKey && apiKey.length >= 10 && apiKey !== lastFetchedApiKey) {
                    await autoFetchModels(apiKey);
                }
            });
        }

        const tryFetchAdvancedModels = async () => {
            const apiKey = document.getElementById('geminiApiKey')?.value?.trim();
            if (apiKey && apiKey.length >= 10 && apiKey !== lastFetchedApiKey) {
                await autoFetchModels(apiKey);
            }
        };

        // ComboBox replaces the select; use delegated handlers to catch real user opens.
        document.addEventListener('click', (e) => {
            const btn = e.target && e.target.closest ? e.target.closest('.combo-button') : null;
            if (!btn) return;
            const combo = btn.closest('.combo');
            if (!combo || !combo.querySelector('#advancedModel')) return;
            tryFetchAdvancedModels();
        });

        document.addEventListener('keydown', (e) => {
            if (!['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
            const btn = e.target && e.target.closest ? e.target.closest('.combo-button') : null;
            if (!btn) return;
            const combo = btn.closest('.combo');
            if (!combo || !combo.querySelector('#advancedModel')) return;
            tryFetchAdvancedModels();
        });

        [advModelEl, advThinkingEl, advTempEl, advTopPEl, ...workflowInputs].forEach(el => {
            if (el) {
                el.addEventListener('change', updateBypassCacheForAdvancedSettings);
                el.addEventListener('input', updateBypassCacheForAdvancedSettings);
            }
        });

        // Batch context toggle - show/hide context size field
        const enableBatchContextEl = document.getElementById('enableBatchContext');
        const contextSizeGroupEl = document.getElementById('contextSizeGroup');
        const contextSizeEl = document.getElementById('contextSize');
        if (enableBatchContextEl && contextSizeGroupEl) {
            enableBatchContextEl.addEventListener('change', (e) => {
                contextSizeGroupEl.style.display = e.target.checked ? 'block' : 'none';
                // Changing batch context setting should force bypass cache logic
                updateBypassCacheForAdvancedSettings();
            });
        }
        if (contextSizeEl) {
            contextSizeEl.addEventListener('change', updateBypassCacheForAdvancedSettings);
            contextSizeEl.addEventListener('input', updateBypassCacheForAdvancedSettings);
        }
        const mismatchRetriesEl = document.getElementById('mismatchRetries');
        if (mismatchRetriesEl) {
            mismatchRetriesEl.addEventListener('change', updateBypassCacheForAdvancedSettings);
            mismatchRetriesEl.addEventListener('input', updateBypassCacheForAdvancedSettings);
        }
        if (contextSizeEl) {
            contextSizeEl.addEventListener('input', updateBypassCacheForAdvancedSettings);
            contextSizeEl.addEventListener('change', updateBypassCacheForAdvancedSettings);
        }

        // Note: Modal close buttons are handled by delegated event listeners (lines 188-206)
        // No need to attach individual listeners here
    }

    function handleOpenSubtitlesImplChange(e) {
        const authConfig = document.getElementById('opensubtitlesAuthConfig');
        if (!authConfig) return;

        // Get implementation type from event or checked radio button
        let implementationType;
        if (e && e.target && e.target.value) {
            implementationType = e.target.value;
        } else {
            const checkedRadio = document.querySelector('input[name="opensubtitlesImplementation"]:checked');
            implementationType = checkedRadio ? checkedRadio.value : 'v3';
        }

        // Show/hide auth fields
        authConfig.style.display = implementationType === 'auth' ? 'block' : 'none';

        // Update visual selection state for all radio buttons
        document.querySelectorAll('input[name="opensubtitlesImplementation"]').forEach(radio => {
            const label = radio.closest('label');
            if (label) {
                if (radio.checked) {
                    label.style.borderColor = 'var(--primary)';
                    label.style.background = 'var(--surface-light)';
                } else {
                    label.style.borderColor = 'var(--border)';
                    label.style.background = 'white';
                }
            }
        });
    }

    /**
     * Handle database mode dropdown changes
     * Maps dropdown values to cache flags:
     * - "use" → cacheEnabled=true, bypassCache=false (permanent database)
     * - "bypass" → cacheEnabled=false, bypassCache=true (temporary 12h cache)
     */
    function handleDatabaseModeChange(e) {
        updateBypassCacheForAdvancedSettings();
    }

    function handleAdvancedSettingsToggle(e) {
        const advancedSettingsGroup = document.getElementById('advancedSettingsGroup');
        advancedSettingsGroup.style.display = e.target.checked ? 'block' : 'none';
    }

    function validateLanguageSelection(type) {
        const configKey = type === 'source'
            ? 'sourceLanguages'
            : type === 'target'
                ? 'targetLanguages'
                : 'learnTargetLanguages';
        const errorId = type === 'source'
            ? 'sourceLanguagesError'
            : type === 'target'
                ? 'targetLanguagesError'
                : 'learnLanguagesError';
        const errorDiv = document.getElementById(errorId);

        if (type === 'source') {
            // Source languages must have 1..MAX_SOURCE_LANGUAGES selections
            if (currentConfig[configKey].length < 1 || currentConfig[configKey].length > MAX_SOURCE_LANGUAGES) {
                if (errorDiv) {
                    errorDiv.textContent = tConfig('config.validation.sourceRange', { min: 1, max: MAX_SOURCE_LANGUAGES }, `Please select 1-${MAX_SOURCE_LANGUAGES} source languages`);
                    errorDiv.classList.add('show');
                }
                return false;
            }
            if (errorDiv) errorDiv.classList.remove('show');
            return true;
        } else {
            // Target and learn languages must have at least one when applicable
            const requiresSelection = type === 'target' ? true : !!currentConfig.learnMode;
            const combinedCount = getCombinedTargetCount();
            const learnCount = Array.isArray(currentConfig.learnTargetLanguages) ? currentConfig.learnTargetLanguages.length : 0;

            if (type === 'target') {
                if (requiresSelection && combinedCount === 0) {
                    if (errorDiv) {
                        errorDiv.textContent = tConfig('config.validation.targetMissing', {}, 'At least one target language is required');
                        errorDiv.classList.add('show');
                    }
                    return false;
                }
            } else {
                if (requiresSelection && learnCount === 0) {
                    if (errorDiv) {
                        errorDiv.textContent = tConfig('config.validation.learnRequired', {}, 'Learn Mode requires at least one target language');
                        errorDiv.classList.add('show');
                    }
                    return false;
                }
            }
            if (combinedCount > MAX_TARGET_LANGUAGES) {
                if (errorDiv) {
                    errorDiv.textContent = tConfig('config.validation.targetLimitShort', { limit: MAX_TARGET_LANGUAGES }, `Please select up to ${MAX_TARGET_LANGUAGES} target languages (including Learn Mode)`);
                    errorDiv.classList.add('show');
                }
                return false;
            }
            if (errorDiv) errorDiv.classList.remove('show');
            return true;
        }
    }

    function validateNoTranslationSelection() {
        const errorDiv = document.getElementById('noTranslationLanguagesError');

        if (!currentConfig.noTranslationMode) {
            if (errorDiv) {
                errorDiv.textContent = '';
                errorDiv.classList.remove('show');
            }
            return true;
        }

        const count = Array.isArray(currentConfig.noTranslationLanguages) ? currentConfig.noTranslationLanguages.length : 0;

        if (count === 0) {
            if (errorDiv) {
                errorDiv.textContent = tConfig('config.validation.noTranslationRequired', {}, 'Please select at least one language for Just Fetch mode');
                errorDiv.classList.add('show');
            }
            return false;
        }

        if (count > MAX_NO_TRANSLATION_LANGUAGES) {
            if (errorDiv) {
                errorDiv.textContent = tConfig('config.validation.noTranslationLimitShort', { limit: MAX_NO_TRANSLATION_LANGUAGES }, `Please select up to ${MAX_NO_TRANSLATION_LANGUAGES} languages for Just Fetch mode`);
                errorDiv.classList.add('show');
            }
            return false;
        }

        if (errorDiv) {
            errorDiv.textContent = '';
            errorDiv.classList.remove('show');
        }
        return true;
    }

    function getProviderKeys() {
        return Object.keys(PROVIDERS).filter(k => k !== 'gemini');
    }

    function isProviderEnabled(key) {
        const toggleEl = document.getElementById(`provider-${key}-enabled`);
        const uiEnabled = toggleEl ? toggleEl.checked === true : false;
        const stateEnabled = currentConfig?.providers?.[key]?.enabled;
        return uiEnabled || stateEnabled === true || stateEnabled === 'true';
    }

    function toggleBetaModeUI(enabled, options = {}) {
        const betaEnabled = enabled === true;
        const prev = currentConfig.betaModeEnabled === true;
        currentConfig.betaModeEnabled = betaEnabled;

        const betaToggle = document.getElementById('betaMode');
        if (betaToggle && betaToggle.checked !== betaEnabled) {
            betaToggle.checked = betaEnabled;
        }

        const advancedCard = document.getElementById('advancedSettingsCard');
        const geminiAdvancedCard = document.getElementById('geminiAdvancedCard');
        if (advancedCard) advancedCard.style.display = betaEnabled ? '' : 'none';
        if (geminiAdvancedCard) geminiAdvancedCard.style.display = betaEnabled ? '' : 'none';

        toggleProviderAdvancedCard();

        if (!options.silent && prev !== betaEnabled) {
            try {
                showAlert(betaEnabled ? tConfig('config.alerts.betaOn', {}, '🔬 Experimental Mode ON') : tConfig('config.alerts.betaOff', {}, '🔬 Experimental Mode OFF'), betaEnabled ? 'success' : 'info', betaEnabled ? 'config.alerts.betaOn' : 'config.alerts.betaOff', {});
            } catch (_) { }
        }

        updateBypassCacheForAdvancedSettings();
    }

    function toggleMultiProviderUI(enabled) {
        const container = document.getElementById('multiProvidersContainer');
        const mainGroup = document.getElementById('mainProviderGroup');
        const secondaryGroup = document.getElementById('secondaryProviderGroup');
        const mainSelect = document.getElementById('mainProviderSelect');
        const secondaryToggle = document.getElementById('enableSecondaryProvider');
        const secondarySelect = document.getElementById('secondaryProviderSelect');
        const shouldEnable = enabled === true;

        currentConfig.multiProviderEnabled = shouldEnable;
        if (container) container.style.display = shouldEnable ? 'flex' : 'none';
        if (mainGroup) mainGroup.style.display = ''; // always visible
        if (secondaryGroup) secondaryGroup.style.display = ''; // always visible

        if (!shouldEnable) {
            updateMainProviderOptions(currentConfig.mainProvider || 'gemini');
            if (mainSelect) mainSelect.disabled = true;
            if (secondaryToggle) {
                secondaryToggle.checked = false;
                secondaryToggle.disabled = true;
            }
            if (secondarySelect) {
                secondarySelect.value = '';
                secondarySelect.disabled = true;
            }
            currentConfig.secondaryProviderEnabled = false;
            toggleSecondaryProviderUI(false);
            toggleProviderAdvancedCard();
            return;
        }

        if (mainSelect) mainSelect.disabled = false;
        if (secondaryToggle) {
            secondaryToggle.disabled = false;
            // Keep the fallback toggle in sync with saved state before rebuilding options
            secondaryToggle.checked = currentConfig.secondaryProviderEnabled === true;
        }
        updateMainProviderOptions(currentConfig.mainProvider || 'gemini');
        toggleSecondaryProviderUI(currentConfig.secondaryProviderEnabled === true);
        updateSecondaryProviderOptions(currentConfig.secondaryProvider || '');
        toggleProviderAdvancedCard();
    }

    function toggleSecondaryProviderUI(enabled) {
        const toggle = document.getElementById('enableSecondaryProvider');
        const selectRow = document.getElementById('secondaryProviderSelectRow');
        const select = document.getElementById('secondaryProviderSelect');
        if (selectRow) selectRow.style.display = enabled ? '' : 'none';
        if (select) select.disabled = !enabled;
        if (!enabled) {
            if (toggle) toggle.checked = false;
            currentConfig.secondaryProviderEnabled = false;
            currentConfig.secondaryProvider = '';
        } else {
            currentConfig.secondaryProviderEnabled = true;
        }
    }

    function toggleProviderFields(providerKey, enabled) {
        const fields = document.getElementById(`provider-${providerKey}-fields`);
        if (fields) {
            fields.style.display = enabled ? 'grid' : 'none';
        }
        const loadBtn = document.querySelector(`.provider-block[data-provider="${providerKey}"] .validate-api-btn`);
        if (loadBtn) {
            loadBtn.style.display = enabled ? 'flex' : 'none';
        }
    }

    function syncSelectOptions(select, desiredOptions) {
        if (!select) return;
        for (let i = 0; i < desiredOptions.length; i++) {
            const desired = desiredOptions[i];
            const existing = select.options[i];
            if (existing) {
                if (existing.value !== desired.value) existing.value = desired.value;
                if (existing.textContent !== desired.text) existing.textContent = desired.text;
            } else {
                const option = document.createElement('option');
                option.value = desired.value;
                option.textContent = desired.text;
                select.appendChild(option);
            }
        }
        while (select.options.length > desiredOptions.length) {
            select.remove(select.options.length - 1);
        }
    }

    function updateMainProviderOptions(selectedKey = 'gemini') {
        const select = document.getElementById('mainProviderSelect');
        if (!select) return;
        ensureProvidersInState();
        const opts = ['gemini'];
        getProviderKeys().forEach(key => {
            if (isProviderEnabled(key)) opts.push(key);
        });
        const prevValue = select.value;
        const desiredOptions = opts.map(key => ({
            value: key,
            text: PROVIDERS[key]?.label || key
        }));
        syncSelectOptions(select, desiredOptions);
        if (opts.includes(selectedKey)) {
            select.value = selectedKey;
        } else if (prevValue && opts.includes(prevValue)) {
            select.value = prevValue;
        } else {
            select.value = opts[0] || 'gemini';
        }
        currentConfig.mainProvider = select.value;
    }

    function updateSecondaryProviderOptions(selectedKey = '') {
        const select = document.getElementById('secondaryProviderSelect');
        const toggle = document.getElementById('enableSecondaryProvider');
        const mainSelect = document.getElementById('mainProviderSelect');
        if (!select || !toggle) return;
        ensureProvidersInState();
        // Prefer the live UI value for main to avoid stale state during load
        const mainKey = (mainSelect?.value || currentConfig.mainProvider || 'gemini').toLowerCase();
        const opts = ['gemini'];
        getProviderKeys().forEach(key => {
            if (isProviderEnabled(key) && key.toLowerCase() !== mainKey) {
                opts.push(key);
            }
        });
        const filtered = opts.filter(key => key.toLowerCase() !== mainKey);

        if (filtered.length === 0) {
            toggle.disabled = true;
            syncSelectOptions(select, [{ value: '', text: tConfig('config.providersUi.noFallbackProviders', {}, 'No fallback providers available') }]);
            select.disabled = true;
            toggle.checked = false;
            currentConfig.secondaryProviderEnabled = false;
            currentConfig.secondaryProvider = '';
            toggleSecondaryProviderUI(false);
            return;
        }

        toggle.disabled = false;
        const placeholderText = tConfig('config.providersUi.selectProvider', {}, 'Select provider');
        const desiredOptions = [{ value: '', text: placeholderText }].concat(filtered.map(key => ({
            value: key,
            text: PROVIDERS[key]?.label || key
        })));
        syncSelectOptions(select, desiredOptions);

        // Prefer the caller's requested key (case-insensitive), otherwise preserve current selection when valid
        const lowerFiltered = new Set(filtered.map(f => f.toLowerCase()));
        const matchKey = (key) => {
            const lower = String(key || '').toLowerCase();
            return filtered.find(f => f.toLowerCase() === lower);
        };
        const chosen =
            matchKey(selectedKey) ||
            matchKey(select.value) ||
            filtered[0];
        select.value = chosen;

        // If fallback is enabled but no value was saved (e.g., previous UI bug), default to first available
        if (toggle.checked && (!select.value || !lowerFiltered.has(select.value.toLowerCase()))) {
            select.value = filtered[0];
        }

        currentConfig.secondaryProvider = select.value;
        select.disabled = !toggle.checked;
        toggleSecondaryProviderUI(toggle.checked);
    }

    function toggleProviderAdvancedCard() {
        const card = document.getElementById('providerAdvancedCard');
        if (!card) return;
        const enabled = currentConfig.multiProviderEnabled === true;
        card.style.display = enabled ? '' : 'none';
        if (enabled) {
            updateProviderAdvancedVisibility();
        }
    }

    function updateProviderAdvancedVisibility() {
        const blocks = document.querySelectorAll('.provider-advanced-block');
        const emptyState = document.getElementById('providerAdvancedEmpty');
        let visibleCount = 0;

        blocks.forEach(block => {
            const key = block.dataset.provider;
            const enabled = document.getElementById(`provider-${key}-enabled`)?.checked;
            const isVisible = enabled === true;
            block.style.display = isVisible ? 'grid' : 'none';
            if (isVisible) visibleCount++;
        });

        if (emptyState) {
            emptyState.style.display = visibleCount === 0 ? 'block' : 'none';
        }
    }

    function applyProviderParametersToForm(params) {
        const defaults = getDefaultProviderParameters();
        const merged = mergeProviderParameters(defaults, params || {});
        currentConfig.providerParameters = merged;

        Object.keys(merged).forEach(key => {
            const cfg = merged[key] || {};
            const tempEl = document.getElementById(`provider-${key}-temperature`);
            const topPEl = document.getElementById(`provider-${key}-topP`);
            const tokensEl = document.getElementById(`provider-${key}-maxTokens`);
            const timeoutEl = document.getElementById(`provider-${key}-timeout`);
            const retriesEl = document.getElementById(`provider-${key}-retries`);
            const thinkingEl = document.getElementById(`provider-${key}-thinking`);
            const reasoningEl = document.getElementById(`provider-${key}-reasoning`);
            const formalityEl = document.getElementById(`provider-${key}-formality`);
            const modelTypeEl = document.getElementById(`provider-${key}-modelType`);
            const preserveEl = document.getElementById(`provider-${key}-preserveFormatting`);

            if (tempEl) tempEl.value = cfg.temperature ?? defaults[key]?.temperature ?? '';
            if (topPEl) topPEl.value = cfg.topP ?? defaults[key]?.topP ?? '';
            if (tokensEl) tokensEl.value = cfg.maxOutputTokens ?? defaults[key]?.maxOutputTokens ?? '';
            if (timeoutEl) timeoutEl.value = cfg.translationTimeout ?? defaults[key]?.translationTimeout ?? '';
            if (retriesEl) retriesEl.value = cfg.maxRetries ?? defaults[key]?.maxRetries ?? '';
            if (thinkingEl) thinkingEl.value = cfg.thinkingBudget ?? defaults[key]?.thinkingBudget ?? '';
            if (reasoningEl) reasoningEl.value = cfg.reasoningEffort ?? defaults[key]?.reasoningEffort ?? '';
            if (formalityEl) formalityEl.value = cfg.formality ?? defaults[key]?.formality ?? 'default';
            if (modelTypeEl) modelTypeEl.value = cfg.modelType ?? defaults[key]?.modelType ?? '';
            if (preserveEl) preserveEl.checked = cfg.preserveFormatting ?? defaults[key]?.preserveFormatting ?? false;
        });
    }

    function getProviderParametersFromForm() {
        const defaults = getDefaultProviderParameters();
        const params = {};
        Object.keys(defaults).forEach(key => {
            const tempEl = document.getElementById(`provider-${key}-temperature`);
            const topPEl = document.getElementById(`provider-${key}-topP`);
            const tokensEl = document.getElementById(`provider-${key}-maxTokens`);
            const timeoutEl = document.getElementById(`provider-${key}-timeout`);
            const retriesEl = document.getElementById(`provider-${key}-retries`);
            const thinkingEl = document.getElementById(`provider-${key}-thinking`);
            const reasoningEl = document.getElementById(`provider-${key}-reasoning`);
            const formalityEl = document.getElementById(`provider-${key}-formality`);
            const modelTypeEl = document.getElementById(`provider-${key}-modelType`);
            const preserveEl = document.getElementById(`provider-${key}-preserveFormatting`);
            const baseDefaults = defaults[key] || {};
            params[key] = {
                temperature: sanitizeNumber(tempEl ? tempEl.value : undefined, defaults[key].temperature, 0, 2),
                topP: sanitizeNumber(topPEl ? topPEl.value : undefined, defaults[key].topP, 0, 1),
                maxOutputTokens: Math.max(1, Math.min(200000, parseInt(tokensEl ? tokensEl.value : defaults[key].maxOutputTokens) || defaults[key].maxOutputTokens)),
                translationTimeout: Math.max(5, Math.min(720, parseInt(timeoutEl ? timeoutEl.value : defaults[key].translationTimeout) || defaults[key].translationTimeout)),
                maxRetries: Math.max(0, Math.min(5, parseInt(retriesEl ? retriesEl.value : defaults[key].maxRetries) || defaults[key].maxRetries)),
                reasoningEffort: (() => {
                    const val = reasoningEl ? reasoningEl.value : baseDefaults.reasoningEffort;
                    // Allow empty string to explicitly disable reasoning effort
                    if (val === '' || val === null || val === undefined) {
                        return undefined;
                    }
                    const allowed = ['low', 'medium', 'high'];
                    const normalized = typeof val === 'string' ? val.trim().toLowerCase() : '';
                    return allowed.includes(normalized) ? normalized : baseDefaults.reasoningEffort;
                })(),
                thinkingBudget: (() => {
                    const rawVal = thinkingEl ? parseInt(thinkingEl.value, 10) : NaN;
                    const baseVal = Number.isFinite(parseInt(defaults[key].thinkingBudget, 10))
                        ? parseInt(defaults[key].thinkingBudget, 10)
                        : 0;
                    const chosen = Number.isFinite(rawVal) ? rawVal : baseVal;
                    return Math.max(-1, Math.min(200000, chosen));
                })()
            };
            if (formalityEl || baseDefaults.formality !== undefined) {
                params[key].formality = formalityEl ? formalityEl.value : (baseDefaults.formality ?? 'default');
            }
            if (modelTypeEl || baseDefaults.modelType !== undefined) {
                params[key].modelType = modelTypeEl ? modelTypeEl.value : (baseDefaults.modelType ?? '');
            }
            if (preserveEl || baseDefaults.preserveFormatting !== undefined) {
                params[key].preserveFormatting = preserveEl ? preserveEl.checked : baseDefaults.preserveFormatting === true;
            }
        });
        return params;
    }

    function populateProviderModels(providerKey, models, selectedModel = '') {
        const select = document.getElementById(`provider-${providerKey}-model`);
        if (!select) return;
        select.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = tConfig('config.providersUi.selectModel', {}, 'Select model');
        select.appendChild(placeholder);

        (models || []).forEach(model => {
            if (!model || !model.name) return;
            const opt = document.createElement('option');
            opt.value = model.name;
            opt.textContent = model.displayName || model.name;
            select.appendChild(opt);
        });

        if (selectedModel) {
            const exists = Array.from(select.options).some(o => o.value === selectedModel);
            if (!exists) {
                const extraOpt = document.createElement('option');
                extraOpt.value = selectedModel;
                extraOpt.textContent = `${selectedModel} (saved)`;
                select.appendChild(extraOpt);
            }
            select.value = selectedModel;
        }
    }

    function applyProvidersToForm(providers) {
        ensureProvidersInState();
        ensureProviderParametersInState();
        getProviderKeys().forEach(key => {
            const cfg = providers && (providers[key] || providers[Object.keys(providers).find(k => k.toLowerCase() === key)]);
            const enabled = cfg?.enabled === true;
            const toggle = document.getElementById(`provider-${key}-enabled`);
            const apiKeyInput = document.getElementById(`provider-${key}-key`);
            if (toggle) toggle.checked = enabled;
            if (apiKeyInput) apiKeyInput.value = cfg?.apiKey || '';
            // Populate baseUrl for custom provider
            if (key === 'custom') {
                const baseUrlInput = document.getElementById('provider-custom-baseUrl');
                if (baseUrlInput) baseUrlInput.value = cfg?.baseUrl || '';
                // Custom provider uses a text input for model, not a select dropdown
                const modelInput = document.getElementById('provider-custom-model');
                if (modelInput) modelInput.value = cfg?.model || '';
            } else {
                const cachedModels = providerModelCache[key] || [];
                populateProviderModels(key, cachedModels, cfg?.model || '');
            }
            toggleProviderFields(key, enabled);
            currentConfig.providers[key] = {
                ...currentConfig.providers[key],
                ...(cfg || {})
            };
        });
        updateMainProviderOptions(currentConfig.mainProvider || 'gemini');
        if (currentConfig.multiProviderEnabled) {
            const secondaryEnabled = currentConfig.secondaryProviderEnabled === true;
            if (secondaryEnabled) {
                const toggle = document.getElementById('enableSecondaryProvider');
                if (toggle) toggle.checked = true;
            }
            toggleSecondaryProviderUI(secondaryEnabled);
            updateSecondaryProviderOptions(currentConfig.secondaryProvider || '');
        } else {
            toggleSecondaryProviderUI(false);
        }
        updateProviderAdvancedVisibility();
    }

    function getProvidersFromForm() {
        ensureProvidersInState();
        const providers = {};
        getProviderKeys().forEach(key => {
            const toggle = document.getElementById(`provider-${key}-enabled`);
            const apiKeyInput = document.getElementById(`provider-${key}-key`);
            const modelSelect = document.getElementById(`provider-${key}-model`);
            providers[key] = {
                enabled: toggle ? toggle.checked : false,
                apiKey: apiKeyInput ? apiKeyInput.value.trim() : '',
                model: modelSelect ? modelSelect.value : ''
            };
            // Include baseUrl for custom provider
            if (key === 'custom') {
                const baseUrlInput = document.getElementById('provider-custom-baseUrl');
                providers[key].baseUrl = baseUrlInput ? baseUrlInput.value.trim() : '';
            }
        });
        return providers;
    }

    function parseCfWorkersKey(rawKey) {
        const cleaned = typeof rawKey === 'string' ? rawKey.trim() : '';
        let accountId = '';
        let token = '';

        if (cleaned) {
            const delimiter = cleaned.includes('|') ? '|' : (cleaned.includes(':') ? ':' : null);
            if (delimiter) {
                const [account, ...rest] = cleaned.split(delimiter);
                accountId = (account || '').trim();
                token = rest.join(delimiter).trim();
            } else {
                token = cleaned;
            }
        }

        return { accountId, token };
    }

    async function fetchProviderModels(providerKey, options = {}) {
        const apiKeyInput = document.getElementById(`provider-${providerKey}-key`);
        if (!apiKeyInput) return;
        const apiKey = apiKeyInput.value.trim();
        // For custom provider, API key is optional (local LLMs don't require it)
        // For other providers, API key is required unless in KEY_OPTIONAL_PROVIDERS
        if (!apiKey && !KEY_OPTIONAL_PROVIDERS.has(providerKey)) {
            if (!options.silent) {
                showAlert(tConfig('config.alerts.missingProviderKey', { provider: PROVIDERS[providerKey]?.label || providerKey }, `Add an API key for ${PROVIDERS[providerKey]?.label || providerKey} to load models`), 'warning', 'config.alerts.missingProviderKey', { provider: PROVIDERS[providerKey]?.label || providerKey });
            }
            return;
        }
        // For custom provider, require a baseUrl
        if (providerKey === 'custom') {
            const baseUrlInput = document.getElementById('provider-custom-baseUrl');
            if (!baseUrlInput || !baseUrlInput.value.trim()) {
                if (!options.silent) {
                    showAlert(tConfig('config.alerts.missingCustomBaseUrl', {}, 'Enter a base URL for the custom provider'), 'warning', 'config.alerts.missingCustomBaseUrl', {});
                }
                return;
            }
        }
        const modelSelect = document.getElementById(`provider-${providerKey}-model`);
        if (modelSelect) {
            modelSelect.innerHTML = `<option value="">${tConfig('config.providersUi.loadingModels', {}, 'Loading models...')}</option>`;
        }

        if (providerKey === 'cfworkers') {
            const creds = parseCfWorkersKey(apiKey);
            if (!creds.accountId || !creds.token) {
                if (modelSelect) {
                    modelSelect.innerHTML = `<option value="">${tConfig('config.providersUi.cfworkersLoadModels', {}, 'Add ACCOUNT_ID|TOKEN to load models')}</option>`;
                }
                if (!options.silent) {
                    showAlert(tConfig('config.alerts.missingCfWorkers', {}, 'Cloudflare Workers AI key must be in ACCOUNT_ID|TOKEN format'), 'error', 'config.alerts.missingCfWorkers', {});
                }
                return;
            }
        }
        try {
            const requestBody = { apiKey };
            // For custom provider, include the baseUrl for model fetching
            if (providerKey === 'custom') {
                const baseUrlInput = document.getElementById('provider-custom-baseUrl');
                requestBody.baseUrl = baseUrlInput ? baseUrlInput.value.trim() : '';
            }
            const response = await fetch(`/api/models/${providerKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });
            if (!response.ok) {
                let errorMessage = response.statusText || 'Failed to fetch models';
                try {
                    const cloned = response.clone();
                    const data = await cloned.json();
                    errorMessage = data?.error || data?.message || errorMessage;
                } catch (_) {
                    try {
                        const text = await response.text();
                        if (text) errorMessage = text;
                    } catch (_) { }
                }
                throw new Error(errorMessage);
            }
            const data = await response.json();
            const models = Array.isArray(data) ? data : [];
            providerModelCache[providerKey] = models;
            populateProviderModels(providerKey, models, currentConfig.providers?.[providerKey]?.model || '');
            if (!options.silent) {
                showAlert(tConfig('config.alerts.loadModelsSuccess', { count: models.length, provider: PROVIDERS[providerKey]?.label || providerKey }, `Loaded ${models.length} models for ${PROVIDERS[providerKey]?.label || providerKey}`), 'success', 'config.alerts.loadModelsSuccess', { count: models.length, provider: PROVIDERS[providerKey]?.label || providerKey });
            }
        } catch (err) {
            populateProviderModels(providerKey, [], '');
            if (!options.silent) {
                showAlert(tConfig('config.alerts.loadModelsFailed', { provider: PROVIDERS[providerKey]?.label || providerKey, reason: err.message }, `Failed to load models for ${PROVIDERS[providerKey]?.label || providerKey}: ${err.message}`), 'error', 'config.alerts.loadModelsFailed', { provider: PROVIDERS[providerKey]?.label || providerKey, reason: err.message });
            }
        }
    }

    function validateGeminiApiKey(showNotification = false) {
        const input = document.getElementById('geminiApiKey');
        const error = document.getElementById('geminiApiKeyError');
        const rotationEnabled = document.getElementById('geminiKeyRotationEnabled')?.checked === true;

        // If rotation is enabled, check the keys list instead
        if (rotationEnabled) {
            const keys = getGeminiApiKeys();
            const keysError = document.getElementById('geminiApiKeysError');

            // Check for empty fields in the rotation list (Key 1 is the single key input)
            const singleKeyValue = input?.value?.trim() || '';
            const keysList = document.getElementById('geminiApiKeysList');
            let hasEmptyFields = !singleKeyValue; // Key 1 empty?

            if (keysList) {
                const inputs = keysList.querySelectorAll('.gemini-api-key-input');
                inputs.forEach(inp => {
                    if (!inp.value?.trim()) {
                        hasEmptyFields = true;
                        inp.classList.add('invalid');
                    }
                });
            }

            if (hasEmptyFields) {
                const message = tConfig('config.validation.geminiKeysFillEmpty', {}, '⚠️ Please fill in all API key fields or remove empty ones');
                if (keysError) {
                    keysError.textContent = message;
                    keysError.style.display = 'block';
                }
                if (showNotification) {
                    showAlert(message, 'error');
                }
                return false;
            }

            if (keys.length === 0) {
                const message = tConfig('config.validation.geminiKeysRequired', {}, '⚠️ At least one API key is required for rotation');
                if (keysError) {
                    keysError.textContent = message;
                    keysError.style.display = 'block';
                }
                if (showNotification) {
                    showAlert(message, 'error');
                }
                return false;
            } else {
                if (keysError) {
                    keysError.style.display = 'none';
                }
                // Sync first key to single input for backend compatibility
                if (input && keys.length > 0) {
                    input.value = keys[0];
                }
                return true;
            }
        }

        // Single key mode validation
        const value = input?.value?.trim() || '';

        if (!value) {
            const message = tConfig('config.validation.geminiKeyRequired', {}, '⚠️ Gemini API key is required');
            if (input) {
                input.classList.add('invalid');
                input.classList.remove('valid');
            }
            if (error) {
                error.classList.add('show');
                error.textContent = message;
            }
            if (showNotification) {
                showAlert(message, 'error');
            }
            return false;
        } else {
            if (input) {
                input.classList.remove('invalid');
            }
            // Don't add 'valid' class here - only backend validation should do that
            if (error) {
                error.classList.remove('show');
            }
            return true;
        }
    }

    // Maximum number of Gemini API keys allowed (fetched from server via /api/session-stats)
    let MAX_GEMINI_API_KEYS = 5; // default matches backend, can be updated from server

    /**
     * Toggle the Gemini API key rotation UI visibility
     * When enabled, shows the keys list for additional keys (Key 2+)
     * The single key field always remains visible as Key 1
     */
    function toggleGeminiKeyRotationUI(enabled) {
        const container = document.getElementById('geminiApiKeysContainer');

        if (!container) return;

        if (enabled) {
            container.style.display = 'block';
            // Add one empty input for Key 2 if the list is empty
            const keysList = document.getElementById('geminiApiKeysList');
            if (keysList && keysList.children.length === 0) {
                addGeminiKeyInput(); // Add one empty input for Key 2
            }
        } else {
            container.style.display = 'none';
        }
        updateGeminiKeysCount();
    }

    /**
     * Validate a single Gemini API key from the rotation list
     * @param {HTMLInputElement} input - The key input element
     * @param {HTMLButtonElement} btn - The validate button
     */
    async function validateGeminiKeyRow(input, btn) {
        const apiKey = input.value.trim();
        if (!apiKey) {
            input.classList.add('invalid');
            input.classList.remove('valid');
            showAlert(tConfig('config.validation.apiKeyRequired', {}, 'Please enter an API key'), 'error');
            return;
        }

        // Update button state - validating
        btn.classList.add('validating');
        btn.classList.remove('success', 'error');
        btn.disabled = true;
        const iconEl = btn.querySelector('.validate-icon');
        const originalIcon = iconEl?.textContent || '✓';
        if (iconEl) iconEl.textContent = '⟳';

        try {
            const response = await fetch('/api/validate-gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey })
            });
            const result = await response.json();

            btn.classList.remove('validating');
            btn.disabled = false;

            if (result.valid) {
                btn.classList.add('success');
                if (iconEl) iconEl.textContent = '✓';
                input.classList.add('valid');
                input.classList.remove('invalid');
                showAlert(tConfig('config.validation.apiKeyValid', {}, 'API key is valid'), 'success');

                // Sync first key to single input for model fetching
                syncFirstKeyToSingleInput();
            } else {
                btn.classList.add('error');
                if (iconEl) iconEl.textContent = '✗';
                input.classList.add('invalid');
                input.classList.remove('valid');
                showAlert(result.error || tConfig('config.validation.apiKeyInvalid', {}, 'Invalid API key'), 'error');
            }

            // Reset button after 3 seconds
            setTimeout(() => {
                btn.classList.remove('success', 'error');
                if (iconEl) iconEl.textContent = originalIcon;
            }, 3000);
        } catch (err) {
            btn.classList.remove('validating');
            btn.disabled = false;
            btn.classList.add('error');
            if (iconEl) iconEl.textContent = '✗';
            input.classList.add('invalid');
            showAlert(tConfig('config.validation.apiError', { reason: err.message }, `API error: ${err.message}`), 'error');
        }
    }

    /**
     * Sync first key from rotation list to single key input for model fetching
     */
    function syncFirstKeyToSingleInput() {
        const keys = getGeminiApiKeys();
        const singleKeyInput = document.getElementById('geminiApiKey');
        if (keys.length > 0 && singleKeyInput) {
            singleKeyInput.value = keys[0];
        }
    }

    /**
     * Add a new Gemini API key input row
     * @param {string} value - Optional initial value for the input
     */
    function addGeminiKeyInput(value = '') {
        const keysList = document.getElementById('geminiApiKeysList');
        if (!keysList) return;

        const currentCount = keysList.children.length;
        if (currentCount >= MAX_GEMINI_API_KEYS) {
            showAlert(tConfig('config.alerts.maxKeysReached', { max: MAX_GEMINI_API_KEYS }, `Maximum of ${MAX_GEMINI_API_KEYS} API keys allowed`), 'warning');
            return;
        }

        // Check if any existing fields are empty before adding a new one
        // This includes Key 1 (single key input) and additional keys (Key 2+)
        if (!value) { // Only check when adding empty field (not when loading saved keys)
            const singleKeyInput = document.getElementById('geminiApiKey');
            const singleKeyValue = singleKeyInput?.value?.trim() || '';

            // Check Key 1 (single key field)
            if (!singleKeyValue) {
                showAlert(tConfig('config.validation.geminiKeysFillEmpty', {}, 'Please fill in all API key fields before adding a new one'), 'warning');
                singleKeyInput?.focus();
                singleKeyInput?.classList.add('invalid');
                return;
            }

            // Check additional keys (Key 2+)
            const existingInputs = keysList.querySelectorAll('.gemini-api-key-input');
            for (const inp of existingInputs) {
                if (!inp.value?.trim()) {
                    showAlert(tConfig('config.validation.geminiKeysFillEmpty', {}, 'Please fill in all API key fields before adding a new one'), 'warning');
                    inp.focus();
                    inp.classList.add('invalid');
                    return;
                }
            }
        }

        const row = document.createElement('div');
        row.className = 'gemini-key-row';
        // Styles are applied via CSS for responsive behavior

        // Create wrapper for input and toggle (similar to password-field-wrapper)
        const inputWrapper = document.createElement('div');
        inputWrapper.className = 'password-field-wrapper';
        // Styles are applied via CSS for responsive behavior

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'sensitive-input masked gemini-api-key-input';
        input.placeholder = tConfig('config.gemini.keyRotation.keyPlaceholder', {}, 'Enter API key');
        input.value = value;
        input.autocomplete = 'off';
        input.spellcheck = false;

        // Toggle icon for show/hide
        const toggleIcon = document.createElement('span');
        toggleIcon.className = 'password-toggle-icon';
        toggleIcon.textContent = '🔒👁';
        toggleIcon.title = tConfig('config.gemini.apiKey.showHideKey', {}, 'Show/hide API key');
        toggleIcon.addEventListener('click', () => {
            const isMasked = input.classList.toggle('masked');
            toggleIcon.textContent = isMasked ? '🔒👁' : '👁';
            toggleIcon.title = isMasked
                ? tConfig('config.gemini.apiKey.showKey', {}, 'Show API key')
                : tConfig('config.gemini.apiKey.hideKey', {}, 'Hide API key');
        });

        inputWrapper.appendChild(input);
        inputWrapper.appendChild(toggleIcon);

        // Sync first key to single input when keys change
        input.addEventListener('input', (e) => {
            syncFirstKeyToSingleInput();
            updateGeminiKeysCount();
            // Remove invalid class when user starts typing
            if (e.target.value?.trim()) {
                e.target.classList.remove('invalid');
            }
        });

        // Test button for per-key validation
        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'validate-api-btn btn-sm';
        testBtn.innerHTML = '<span class="validate-icon">✓</span>';
        testBtn.title = tConfig('config.gemini.keyRotation.testKey', {}, 'Test this key');
        testBtn.addEventListener('click', () => validateGeminiKeyRow(input, testBtn));

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn btn-danger btn-sm';
        removeBtn.innerHTML = '−';
        removeBtn.title = tConfig('config.gemini.keyRotation.removeKey', {}, 'Remove this key');
        removeBtn.addEventListener('click', () => removeGeminiKeyInput(row));

        row.appendChild(inputWrapper);
        row.appendChild(testBtn);
        row.appendChild(removeBtn);
        keysList.appendChild(row);

        updateGeminiKeysCount();
        input.focus();
    }


    /**
     * Remove a Gemini API key input row
     * Note: Key 1 is always present in the single key field, so rotation list can be empty
     */
    function removeGeminiKeyInput(row) {
        const keysList = document.getElementById('geminiApiKeysList');
        if (!keysList) return;

        row.remove();
        updateGeminiKeysCount();
    }

    /**
     * Update the Gemini keys count label
     */
    function updateGeminiKeysCount() {
        const label = document.getElementById('geminiKeysCountLabel');
        const keysList = document.getElementById('geminiApiKeysList');
        const addBtn = document.getElementById('addGeminiKeyBtn');

        if (!label || !keysList) return;

        const additionalCount = keysList.children.length;
        const totalCount = additionalCount + 1; // +1 for the single key field (Key 1)
        label.textContent = `(+${additionalCount} ${tConfig('config.gemini.keyRotation.additionalKeys', {}, 'additional')})`;

        // Disable add button if at max (total keys including Key 1)
        if (addBtn) {
            addBtn.disabled = totalCount >= MAX_GEMINI_API_KEYS;
        }
    }

    /**
     * Get all Gemini API keys from the UI
     * @returns {string[]} Array of non-empty API keys (single key + rotation keys)
     */
    function getGeminiApiKeys() {
        const keys = [];

        // Key 1: The single key field
        const singleKey = document.getElementById('geminiApiKey')?.value?.trim();
        if (singleKey) {
            keys.push(singleKey);
        }

        // Key 2+: Additional rotation keys
        const keysList = document.getElementById('geminiApiKeysList');
        if (keysList) {
            const inputs = keysList.querySelectorAll('.gemini-api-key-input');
            inputs.forEach(input => {
                const value = input.value?.trim();
                if (value) {
                    keys.push(value);
                }
            });
        }

        return keys;
    }

    async function validateAssemblyAiKey(showNotification = true) {
        const input = document.getElementById('assemblyAiApiKey');
        const feedback = document.getElementById('assemblyAiValidationFeedback');
        const error = document.getElementById('assemblyAiApiKeyError');
        if (!input) return false;

        const value = input.value.trim();
        const requiredMsg = tConfig('config.validation.assemblyAiKeyRequired', {}, '⚠️ AssemblyAI API key is required for AssemblyAI mode');

        if (!value) {
            input.classList.add('invalid');
            if (error) {
                error.textContent = requiredMsg;
                error.classList.add('show');
            }
            if (feedback) {
                feedback.textContent = '';
            }
            if (showNotification) {
                showAlert(requiredMsg, 'error');
            }
            return false;
        }

        input.classList.remove('invalid');
        if (error) {
            error.classList.remove('show');
        }
        if (feedback) {
            feedback.textContent = tConfig('config.validation.validating', {}, 'Validating...');
            feedback.classList.remove('error', 'success');
        }

        try {
            const resp = await fetch('/api/validate-assemblyai', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey: value })
            });
            const data = await resp.json().catch(() => ({}));
            const valid = data?.valid === true;
            const message = data?.message || (valid
                ? tConfig('config.validation.apiKeyValid', {}, 'API key is valid')
                : (data?.error || tConfig('config.validation.assemblyAiKeyInvalid', {}, 'AssemblyAI API key is invalid')));
            if (valid) {
                input.classList.add('valid');
                if (feedback) {
                    feedback.textContent = message;
                    feedback.classList.remove('error');
                    feedback.classList.add('success');
                }
                if (showNotification) {
                    showAlert(message, 'success');
                }
                return true;
            }
            input.classList.add('invalid');
            if (feedback) {
                feedback.textContent = message;
                feedback.classList.remove('success');
                feedback.classList.add('error');
            }
            if (showNotification) {
                showAlert(message, 'error');
            }
            return false;
        } catch (err) {
            const failMsg = err?.message || tConfig('config.validation.apiError', {}, 'API error');
            input.classList.add('invalid');
            if (feedback) {
                feedback.textContent = failMsg;
                feedback.classList.remove('success');
                feedback.classList.add('error');
            }
            if (showNotification) {
                showAlert(failMsg, 'error');
            }
            return false;
        }
    }

    function validateCloudflareWorkersKey(showNotification = true) {
        const input = document.getElementById('cloudflareWorkersApiKey');
        const feedback = document.getElementById('cloudflareWorkersValidationFeedback');
        const error = document.getElementById('cloudflareWorkersApiKeyError');
        if (!input) return false;

        const value = input.value.trim();
        const requiredMsg = tConfig('config.validation.cloudflareWorkersKeyRequired', {}, '⚠️ Cloudflare Workers AI key is required for auto-subs (xSync)');
        const formatMsg = tConfig('config.validation.cloudflareWorkersKeyFormat', {}, '⚠️ Add Cloudflare Workers AI key as ACCOUNT_ID|TOKEN');

        if (!value) {
            input.classList.add('invalid');
            if (error) {
                error.textContent = requiredMsg;
                error.classList.add('show');
            }
            if (feedback) {
                feedback.textContent = '';
                feedback.classList.remove('success', 'error');
            }
            if (showNotification) {
                showAlert(requiredMsg, 'error');
            }
            return false;
        }

        const creds = parseCfWorkersKey(value);
        const valid = !!(creds.accountId && creds.token);

        if (!valid) {
            input.classList.add('invalid');
            if (error) {
                error.textContent = formatMsg;
                error.classList.add('show');
            }
            if (feedback) {
                feedback.textContent = formatMsg;
                feedback.classList.add('error');
                feedback.classList.remove('success');
            }
            if (showNotification) {
                showAlert(formatMsg, 'error');
            }
            return false;
        }

        input.classList.remove('invalid');
        input.classList.add('valid');
        if (error) {
            error.classList.remove('show');
        }
        if (feedback) {
            const okMsg = tConfig('config.validation.apiKeyAppearsValid', {}, 'API key appears valid');
            feedback.textContent = okMsg;
            feedback.classList.remove('error');
            feedback.classList.add('success');
        }
        if (showNotification) {
            const okMsg = tConfig('config.validation.apiKeyAppearsValid', {}, 'API key appears valid');
            showAlert(okMsg, 'success');
        }
        return true;
    }

    function validateGeminiModel() {
        const select = document.getElementById('geminiModel');
        const error = document.getElementById('geminiModelError');
        const value = select.value;

        if (!value) {
            const message = tConfig('config.validation.geminiModelRequired', {}, '⚠️ Please select a Gemini model');
            select.classList.add('invalid');
            select.classList.remove('valid');
            error.classList.add('show');
            if (error) {
                error.textContent = message;
            }
            return false;
        } else {
            select.classList.remove('invalid');
            select.classList.add('valid');
            error.classList.remove('show');
            return true;
        }
    }

    /**
     * Validate API key by calling backend validation endpoint
     * @param {string} provider - Provider name: 'subsource', 'subdl', 'opensubtitles', or 'gemini'
     */
    async function validateApiKey(provider) {
        // Get elements based on provider
        let btn, feedback, apiKey, username, password, endpoint;

        if (provider === 'subsource') {
            btn = document.getElementById('validateSubSource');
            feedback = document.getElementById('subsourceValidationFeedback');
            apiKey = document.getElementById('subsourceApiKey').value.trim();
            endpoint = '/api/validate-subsource';
        } else if (provider === 'subdl') {
            btn = document.getElementById('validateSubDL');
            feedback = document.getElementById('subdlValidationFeedback');
            apiKey = document.getElementById('subdlApiKey').value.trim();
            endpoint = '/api/validate-subdl';
        } else if (provider === 'opensubtitles') {
            btn = document.getElementById('validateOpenSubtitles');
            feedback = document.getElementById('opensubtitlesValidationFeedback');
            username = document.getElementById('opensubtitlesUsername').value.trim();
            password = document.getElementById('opensubtitlesPassword').value.trim();
            const opensubsEnabled = document.getElementById('enableOpenSubtitles')?.checked;
            const impl = document.querySelector('input[name="opensubtitlesImplementation"]:checked')?.value;
            endpoint = '/api/validate-opensubtitles';

            // Surface a user-facing message if Auth mode isn't active
            if (!opensubsEnabled) {
                showValidationFeedback(feedback, 'error', tConfig('config.validation.opensubsEnable', {}, 'Enable OpenSubtitles before testing credentials.'));
                return;
            }
            if (impl !== 'auth') {
                showValidationFeedback(feedback, 'error', tConfig('config.validation.opensubsAuthMode', {}, 'Switch to Auth mode to test your credentials.'));
                return;
            }
        } else if (provider === 'gemini') {
            btn = document.getElementById('validateGemini');
            feedback = document.getElementById('geminiValidationFeedback');
            apiKey = document.getElementById('geminiApiKey').value.trim();
            endpoint = '/api/validate-gemini';
        } else if (provider === 'subsro') {
            btn = document.getElementById('validateSubsRo');
            feedback = document.getElementById('subsroValidationFeedback');
            apiKey = document.getElementById('subsroApiKey').value.trim();
            endpoint = '/api/validate-subsro';
        }

        // Validate input
        if (provider === 'opensubtitles') {
            if (!username || !password) {
                showValidationFeedback(feedback, 'error', tConfig('config.validation.credentialsRequired', {}, 'Please enter both username and password'));
                return;
            }
        } else {
            if (!apiKey) {
                showValidationFeedback(feedback, 'error', tConfig('config.validation.apiKeyRequired', {}, 'Please enter an API key'));
                return;
            }
        }

        // Update button state - validating
        btn.classList.add('validating');
        btn.classList.remove('success', 'error');
        btn.disabled = true;
        const iconEl = btn.querySelector('.validate-icon');
        const textEl = btn.querySelector('.validate-text');
        const originalIcon = iconEl.textContent;
        iconEl.textContent = '⟳';
        textEl.textContent = tConfig('config.validation.testing', {}, 'Testing...');

        // Clear previous feedback
        feedback.classList.remove('show', 'success', 'error');

        // For Gemini: Clear any pending model fetch to avoid duplicate messages
        if (provider === 'gemini' && modelsFetchTimeout) {
            clearTimeout(modelsFetchTimeout);
            modelsFetchTimeout = null;
        }

        try {
            // Call validation endpoint
            const body = provider === 'opensubtitles'
                ? { username, password }
                : { apiKey };

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });

            const result = await response.json();

            // Update button and feedback based on result
            btn.classList.remove('validating');
            btn.disabled = false;

            if (result.valid) {
                // Success
                btn.classList.add('success');
                iconEl.textContent = '✓';
                textEl.textContent = tConfig('config.validation.valid', {}, 'Valid');

                let message = result.message || tConfig('config.validation.apiKeyValid', {}, 'API key is valid');
                if (result.resultsCount !== undefined) {
                    message += ' ' + tConfig('config.validation.testResults', { count: result.resultsCount }, `(${result.resultsCount} test results)`);
                }

                showValidationFeedback(feedback, 'success', message);

                // For Gemini: Mark input as valid (green border)
                if (provider === 'gemini') {
                    const apiKeyInput = document.getElementById('geminiApiKey');
                    if (apiKeyInput) {
                        apiKeyInput.classList.add('valid');
                        apiKeyInput.classList.remove('invalid');
                    }
                }

                // Reset button after 3 seconds
                setTimeout(() => {
                    btn.classList.remove('success');
                    iconEl.textContent = originalIcon;
                    textEl.textContent = provider === 'opensubtitles'
                        ? tConfig('config.validation.testCredentials', {}, 'Test Credentials')
                        : tConfig('config.validation.test', {}, 'Test');
                }, 3000);
            } else {
                // Error
                btn.classList.add('error');
                iconEl.textContent = '✗';
                textEl.textContent = tConfig('config.validation.invalid', {}, 'Invalid');
                showValidationFeedback(feedback, 'error', result.error || tConfig('config.validation.validationFailed', {}, 'Validation failed'));

                // For Gemini: Mark input as invalid (red border)
                if (provider === 'gemini') {
                    const apiKeyInput = document.getElementById('geminiApiKey');
                    if (apiKeyInput) {
                        apiKeyInput.classList.add('invalid');
                        apiKeyInput.classList.remove('valid');
                    }
                }

                // Reset button after 4 seconds
                setTimeout(() => {
                    btn.classList.remove('error');
                    iconEl.textContent = originalIcon;
                    textEl.textContent = provider === 'opensubtitles'
                        ? tConfig('config.validation.testCredentials', {}, 'Test Credentials')
                        : tConfig('config.validation.test', {}, 'Test');
                }, 4000);
            }

        } catch (error) {
            btn.classList.remove('validating');
            btn.classList.add('error');
            btn.disabled = false;
            iconEl.textContent = '✗';
            textEl.textContent = tConfig('config.validation.error', {}, 'Error');
            showValidationFeedback(feedback, 'error', tConfig('config.validation.connectionError', {}, 'Connection error. Please try again.'));

            // For Gemini: Mark input as invalid on connection error
            if (provider === 'gemini') {
                const apiKeyInput = document.getElementById('geminiApiKey');
                if (apiKeyInput) {
                    apiKeyInput.classList.add('invalid');
                    apiKeyInput.classList.remove('valid');
                }
            }

            // Reset button after 4 seconds
            setTimeout(() => {
                btn.classList.remove('error');
                iconEl.textContent = originalIcon;
                textEl.textContent = provider === 'opensubtitles' ? 'Test Credentials' : 'Test';
            }, 4000);
        }
    }

    /**
     * Show validation feedback message
     * @param {HTMLElement} element - Feedback element
     * @param {string} type - 'success', 'error', or 'info'
     * @param {string|object} message - Message to display
     */
    function showValidationFeedback(element, type, message) {
        // Safely convert message to string, handling objects
        let displayMessage = message;
        if (typeof message === 'object' && message !== null) {
            // If it's an object, try to extract a meaningful error message
            if (message.message) {
                displayMessage = message.message;
            } else if (message.error) {
                displayMessage = message.error;
            } else {
                displayMessage = JSON.stringify(message);
            }
        } else if (!message) {
            displayMessage = 'Validation failed';
        }

        element.textContent = displayMessage;
        element.classList.remove('success', 'error', 'info');
        element.classList.add(type, 'show');

        // Auto-hide after 8 seconds
        setTimeout(() => {
            element.classList.remove('show');
        }, 8000);
    }

    function setupKeyboardShortcuts() {
        let devModeRevealed = false;

        document.addEventListener('keydown', (e) => {
            // Ctrl/Cmd + S to save
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                document.getElementById('configForm').dispatchEvent(new Event('submit'));
            }

            // Ctrl/Cmd + K to focus search
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                document.getElementById('sourceSearch').focus();
            }

            // Escape to clear search
            if (e.key === 'Escape') {
                const activeElement = document.activeElement;
                if (activeElement.id === 'sourceSearch' || activeElement.id === 'targetSearch') {
                    activeElement.value = '';
                    filterLanguages(activeElement.id === 'sourceSearch' ? 'sourceLanguages' : 'targetLanguages', '');
                    activeElement.blur();
                }
            }

            // ? to show keyboard shortcuts
            if (e.key === '?' && !e.target.matches('input, textarea')) {
                e.preventDefault();
                showKeyboardShortcuts();
            }

            // Ctrl/Cmd + / to toggle all sections
            if ((e.ctrlKey || e.metaKey) && e.key === '/') {
                e.preventDefault();
                toggleAllSections();
            }

            // Ctrl + Alt + D to reveal Dev Mode checkbox
            const isDevKey = e.code === 'KeyD' || (typeof e.key === 'string' && e.key.toLowerCase() === 'd');
            const devComboPressed = e.altKey && (e.ctrlKey || e.metaKey) && isDevKey;
            if (devComboPressed && !devModeRevealed) {
                e.preventDefault();
                devModeRevealed = true;
                const devModeGroup = document.getElementById('devModeGroup');
                if (devModeGroup && devModeGroup.style.display === 'none') {
                    devModeGroup.style.display = 'block';
                }
            }
        });
    }

    function showKeyboardHint() {
        const hint = document.getElementById('keyboardHint');
        hint.classList.add('show');
        setTimeout(() => {
            hint.classList.remove('show');
        }, 5000);
    }

    function showKeyboardShortcuts() {
        const shortcuts = [
            { key: 'Ctrl/Cmd + S', action: 'Save configuration' },
            { key: 'Ctrl/Cmd + K', action: 'Focus source language search' },
            { key: 'Alt + S', action: 'Focus source language search' },
            { key: 'Alt + T', action: 'Focus target language search' },
            { key: 'Escape', action: 'Clear search / Close' },
            { key: 'Ctrl/Cmd + /', action: 'Toggle all sections' },
            { key: '?', action: 'Show this help' }
        ];

        const message = shortcuts.map(s => `<span class="kbd">${s.key}</span> ${s.action}`).join('<br>');

        const alert = document.createElement('div');
        alert.className = 'alert alert-info';
        alert.innerHTML = `
            <span style="font-size: 1.25rem;">⌨️</span>
            <div>
                <strong>Keyboard Shortcuts</strong><br>
                ${message}
            </div>
        `;

        const container = getAlertContainer();
        container.innerHTML = '';
        container.appendChild(alert);

        setTimeout(() => {
            alert.style.animation = 'slideInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1) reverse';
            setTimeout(() => alert.remove(), 300);
        }, 10000);
    }

    function toggleAllSections() {
        const cards = Array.from(document.querySelectorAll('.card'));
        const collapsibleCards = cards.filter(card => card.querySelector('.card-header'));
        const allCollapsed = collapsibleCards.length > 0 && collapsibleCards.every(card => card.classList.contains('collapsed'));

        cards.forEach(card => {
            const hasHeader = !!card.querySelector('.card-header');
            if (!hasHeader) {
                card.classList.remove('collapsed');
                return;
            }
            if (allCollapsed) {
                card.classList.remove('collapsed');
            } else {
                card.classList.add('collapsed');
            }
        });

        document.querySelectorAll('.collapse-btn').forEach(btn => {
            if (allCollapsed) {
                btn.classList.remove('collapsed');
            } else {
                btn.classList.add('collapsed');
            }
        });
    }

    function toggleOtherSettingsVisibilityForNoTranslation(enabled) {
        const groupsToHide = [
            document.getElementById('mainProviderGroup'),
            document.getElementById('secondaryProviderGroup'),
            document.getElementById('learnOrderGroup'),
            document.getElementById('learnPlacementGroup'),
            document.getElementById('learnItalicGroup')
        ];
        const otherSettingsCard = document.getElementById('otherSettingsCard');
        const subToolboxNoTranslationGroup = document.getElementById('subToolboxNoTranslationGroup');
        const excludeHearingImpairedNoTranslationGroup = document.getElementById('excludeHearingImpairedNoTranslationGroup');
        const enableSeasonPacksNoTranslationGroup = document.getElementById('enableSeasonPacksNoTranslationGroup');
        const forceSRTOutputNoTranslationGroup = document.getElementById('forceSRTOutputNoTranslationGroup');
        const workflowGroup = getTranslationWorkflowContainer();
        if (workflowGroup) groupsToHide.push(workflowGroup);

        ['databaseMode', 'learnModeEnabled', 'mobileMode', 'singleBatchMode', 'betaMode'].forEach(id => {
            const group = document.getElementById(id)?.closest('.form-group');
            if (group) groupsToHide.push(group);
        });

        if (enabled) {
            groupsToHide.forEach(group => {
                if (!group) return;
                group.dataset.originalDisplay = group.style.display || '';
                group.style.display = 'none';
            });
            if (otherSettingsCard) {
                otherSettingsCard.dataset.originalDisplay = otherSettingsCard.style.display || '';
                otherSettingsCard.style.display = 'none';
            }
            if (subToolboxNoTranslationGroup) {
                subToolboxNoTranslationGroup.style.display = '';
            }
            if (excludeHearingImpairedNoTranslationGroup) {
                excludeHearingImpairedNoTranslationGroup.style.display = '';
            }
            if (enableSeasonPacksNoTranslationGroup) {
                enableSeasonPacksNoTranslationGroup.style.display = '';
            }
            if (forceSRTOutputNoTranslationGroup) {
                forceSRTOutputNoTranslationGroup.style.display = '';
            }
            return;
        }

        const hasStoredState = groupsToHide.some(group => group && group.dataset.originalDisplay !== undefined) || (otherSettingsCard && otherSettingsCard.dataset.originalDisplay !== undefined);
        if (!hasStoredState) {
            if (subToolboxNoTranslationGroup) {
                subToolboxNoTranslationGroup.style.display = 'none';
            }
            if (excludeHearingImpairedNoTranslationGroup) {
                excludeHearingImpairedNoTranslationGroup.style.display = 'none';
            }
            if (enableSeasonPacksNoTranslationGroup) {
                enableSeasonPacksNoTranslationGroup.style.display = 'none';
            }
            if (forceSRTOutputNoTranslationGroup) {
                forceSRTOutputNoTranslationGroup.style.display = 'none';
            }
            return;
        }

        groupsToHide.forEach(group => {
            if (!group) return;
            const restoreValue = group.dataset.originalDisplay !== undefined ? group.dataset.originalDisplay : '';
            group.style.display = restoreValue;
        });
        if (otherSettingsCard) {
            const restoreValue = otherSettingsCard.dataset.originalDisplay !== undefined ? otherSettingsCard.dataset.originalDisplay : '';
            otherSettingsCard.style.display = restoreValue;
        }
        if (subToolboxNoTranslationGroup) {
            subToolboxNoTranslationGroup.style.display = 'none';
        }
        if (excludeHearingImpairedNoTranslationGroup) {
            excludeHearingImpairedNoTranslationGroup.style.display = 'none';
        }
        if (enableSeasonPacksNoTranslationGroup) {
            enableSeasonPacksNoTranslationGroup.style.display = 'none';
        }
        if (forceSRTOutputNoTranslationGroup) {
            forceSRTOutputNoTranslationGroup.style.display = 'none';
        }
    }

    function toggleNoTranslationMode(enabled) {
        currentConfig.noTranslationMode = enabled;
        const noTranslationCard = document.getElementById('noTranslationCard');
        const sourceCard = document.getElementById('sourceCard');
        const targetCard = document.getElementById('targetCard');
        const geminiCard = document.getElementById('geminiCard');
        const translationSettingsCard = document.getElementById('translationSettingsCard');
        const betaToggle = document.getElementById('betaMode');
        const learnTargetsCard = document.getElementById('learnTargetsCard');
        const learnModeCheckbox = document.getElementById('learnModeEnabled');
        const learnOrderGroup = document.getElementById('learnOrderGroup');
        const learnPlacementGroup = document.getElementById('learnPlacementGroup');
        const learnGrid = document.getElementById('learnLanguages');
        setLanguagesSectionDescriptionKey(
            enabled ? 'config.sections.languagesDescriptionNoTranslation' : 'config.sections.languagesDescription',
            enabled
                ? 'Choose which subtitle languages you want to fetch without translation.'
                : 'Choose your source and target languages for fetching and translations.'
        );
        toggleOtherSettingsVisibilityForNoTranslation(enabled);

        if (enabled) {
            translationModeBackup = {
                sourceLanguages: Array.isArray(currentConfig.sourceLanguages) ? [...currentConfig.sourceLanguages] : [],
                targetLanguages: Array.isArray(currentConfig.targetLanguages) ? [...currentConfig.targetLanguages] : [],
                learnTargetLanguages: Array.isArray(currentConfig.learnTargetLanguages) ? [...currentConfig.learnTargetLanguages] : [],
                learnMode: currentConfig.learnMode === true,
                learnOrder: currentConfig.learnOrder || 'source-top',
                learnItalic: currentConfig.learnItalic !== false,
                learnItalicTarget: currentConfig.learnItalicTarget || 'target'
            };
            if ((!currentConfig.noTranslationLanguages || currentConfig.noTranslationLanguages.length === 0) && Array.isArray(noTranslationBackup) && noTranslationBackup.length > 0) {
                currentConfig.noTranslationLanguages = [...noTranslationBackup];
            }
            betaModeLastState = {
                betaEnabled: isBetaModeEnabled(),
                multiEnabled: currentConfig.multiProviderEnabled === true,
                secondaryEnabled: currentConfig.secondaryProviderEnabled === true
            };
            toggleBetaModeUI(false, { silent: true });
            if (betaToggle) {
                betaToggle.checked = false;
                betaToggle.disabled = true;
            }
            // Show no-translation card, hide source, target, gemini, and translation settings cards
            if (noTranslationCard) {
                noTranslationCard.style.display = 'block';
                noTranslationCard.classList.remove('collapsed');
            }
            if (sourceCard) sourceCard.style.display = 'none';
            if (targetCard) targetCard.style.display = 'none';
            if (geminiCard) geminiCard.style.display = 'none';
            if (translationSettingsCard) translationSettingsCard.style.display = 'none';

            // Hide learn mode UI elements in just-fetch mode
            if (learnTargetsCard) learnTargetsCard.style.display = 'none';
            if (learnModeCheckbox) {
                learnModeCheckbox.parentElement.style.display = 'none';
            }
            if (learnOrderGroup) learnOrderGroup.style.display = 'none';
            if (learnPlacementGroup) learnPlacementGroup.style.display = 'none';
            const learnItalicGroupNoTrans = document.getElementById('learnItalicGroup');
            if (learnItalicGroupNoTrans) learnItalicGroupNoTrans.style.display = 'none';

            // Clear validation errors for fields that aren't required in no-translation mode
            const geminiApiKeyInput = document.getElementById('geminiApiKey');
            const geminiApiKeyError = document.getElementById('geminiApiKeyError');
            const geminiModelSelect = document.getElementById('geminiModel');
            const geminiModelError = document.getElementById('geminiModelError');
            const assemblyAiInput = document.getElementById('assemblyAiApiKey');
            const assemblyAiError = document.getElementById('assemblyAiApiKeyError');
            const assemblyAiFeedback = document.getElementById('assemblyAiValidationFeedback');
            const sourceLanguagesError = document.getElementById('sourceLanguagesError');
            const targetLanguagesError = document.getElementById('targetLanguagesError');
            const learnLanguagesError = document.getElementById('learnLanguagesError');

            if (geminiApiKeyInput) {
                geminiApiKeyInput.classList.remove('invalid', 'valid');
            }
            if (geminiApiKeyError) {
                geminiApiKeyError.classList.remove('show');
            }
            if (geminiModelSelect) {
                geminiModelSelect.classList.remove('invalid', 'valid');
            }
            if (geminiModelError) {
                geminiModelError.classList.remove('show');
            }
            if (assemblyAiInput) {
                assemblyAiInput.classList.remove('invalid', 'valid');
            }
            if (assemblyAiError) {
                assemblyAiError.classList.remove('show');
            }
            if (assemblyAiFeedback) {
                assemblyAiFeedback.textContent = '';
                assemblyAiFeedback.classList.remove('error', 'success');
            }
            if (sourceLanguagesError) {
                sourceLanguagesError.classList.remove('show');
            }
            if (targetLanguagesError) {
                targetLanguagesError.classList.remove('show');
            }
            if (learnLanguagesError) {
                learnLanguagesError.classList.remove('show');
            }

            // Clear source and target languages when switching to no-translation mode
            // This prevents translation-mode languages from being saved in no-translation config
            currentConfig.sourceLanguages = [];
            currentConfig.targetLanguages = [];
            currentConfig.learnTargetLanguages = [];
            currentConfig.learnMode = false;

            // Update UI to reflect cleared languages
            const sourceGrid = document.getElementById('sourceLanguages');
            const targetGrid = document.getElementById('targetLanguages');

            if (sourceGrid) {
                sourceGrid.querySelectorAll('.language-item.selected').forEach(item => {
                    item.classList.remove('selected');
                });
            }
            if (targetGrid) {
                targetGrid.querySelectorAll('.language-item.selected').forEach(item => {
                    item.classList.remove('selected');
                });
            }
            if (learnGrid) {
                learnGrid.querySelectorAll('.language-item.selected').forEach(item => {
                    item.classList.remove('selected');
                });
            }
            if (learnModeCheckbox) {
                learnModeCheckbox.checked = false;
            }

            updateSelectedChips('source', []);
            updateSelectedChips('target', []);
            updateSelectedChips('learn', []);
            updateSelectedChips('notranslation', currentConfig.noTranslationLanguages || []);
            syncGridSelection('noTranslationLanguages', currentConfig.noTranslationLanguages || []);
        } else {
            if (Array.isArray(currentConfig.noTranslationLanguages) && currentConfig.noTranslationLanguages.length > 0) {
                noTranslationBackup = [...currentConfig.noTranslationLanguages];
            }
            if (betaToggle) {
                betaToggle.disabled = false;
            }
            const shouldRestoreBeta = betaModeLastState?.betaEnabled === true;
            if (shouldRestoreBeta) {
                toggleBetaModeUI(true, { silent: true });
                const multiToggle = document.getElementById('enableMultiProviders');
                if (multiToggle && betaModeLastState?.multiEnabled) {
                    multiToggle.checked = true;
                    currentConfig.multiProviderEnabled = true;
                    toggleMultiProviderUI(true);
                    if (betaModeLastState?.secondaryEnabled) {
                        const secondaryToggle = document.getElementById('enableSecondaryProvider');
                        if (secondaryToggle) secondaryToggle.checked = true;
                        toggleSecondaryProviderUI(true);
                        updateSecondaryProviderOptions(currentConfig.secondaryProvider || '');
                    }
                }
            } else {
                toggleBetaModeUI(isBetaModeEnabled());
            }
            betaModeLastState = null;
            // Hide no-translation card, show source, target, gemini, and translation settings cards
            if (noTranslationCard) noTranslationCard.style.display = 'none';
            if (sourceCard) sourceCard.style.display = 'block';
            if (targetCard) targetCard.style.display = 'block';
            if (geminiCard) geminiCard.style.display = 'block';
            if (translationSettingsCard) translationSettingsCard.style.display = 'block';

            // Show learn mode checkbox in translation mode
            if (learnModeCheckbox) {
                learnModeCheckbox.parentElement.style.display = '';
                // Show learn targets card only if learn mode is enabled
                const isLearnModeEnabled = learnModeCheckbox.checked;
                if (learnTargetsCard) {
                    learnTargetsCard.style.display = isLearnModeEnabled ? '' : 'none';
                }
                if (learnOrderGroup) {
                    learnOrderGroup.style.display = isLearnModeEnabled ? '' : 'none';
                }
                if (learnPlacementGroup) {
                    learnPlacementGroup.style.display = isLearnModeEnabled ? '' : 'none';
                }
                const learnItalicGroupRestore = document.getElementById('learnItalicGroup');
                if (learnItalicGroupRestore) learnItalicGroupRestore.style.display = isLearnModeEnabled ? '' : 'none';
            }

            // Clear no-translation languages when switching to translation mode
            // This prevents no-translation-mode languages from being saved in translation config
            currentConfig.noTranslationLanguages = [];

            // Update UI to reflect cleared no-translation languages
            const noTranslationGrid = document.getElementById('noTranslationLanguages');

            if (noTranslationGrid) {
                noTranslationGrid.querySelectorAll('.language-item.selected').forEach(item => {
                    item.classList.remove('selected');
                });
            }

            updateSelectedChips('notranslation', []);

            const restored = translationModeBackup || {};
            currentConfig.sourceLanguages = normalizeLanguageCodes(restored.sourceLanguages || currentConfig.sourceLanguages || []);
            currentConfig.targetLanguages = normalizeLanguageCodes(restored.targetLanguages || currentConfig.targetLanguages || []);
            currentConfig.learnTargetLanguages = normalizeLanguageCodes(restored.learnTargetLanguages || currentConfig.learnTargetLanguages || []);
            currentConfig.learnMode = restored.learnMode === true && currentConfig.learnTargetLanguages.length > 0;
            currentConfig.learnOrder = restored.learnOrder || currentConfig.learnOrder || 'source-top';
            currentConfig.learnItalic = restored.learnItalic !== false;
            currentConfig.learnItalicTarget = restored.learnItalicTarget || currentConfig.learnItalicTarget || 'target';
            enforceLanguageLimits();

            syncGridSelection('sourceLanguages', currentConfig.sourceLanguages);
            syncGridSelection('targetLanguages', currentConfig.targetLanguages);
            syncGridSelection('learnLanguages', currentConfig.learnTargetLanguages);
            updateSelectedChips('source', currentConfig.sourceLanguages);
            updateSelectedChips('target', currentConfig.targetLanguages);
            updateSelectedChips('learn', currentConfig.learnTargetLanguages);

            if (learnModeCheckbox) {
                learnModeCheckbox.checked = currentConfig.learnMode === true;
            }
            const showLearn = learnModeCheckbox ? learnModeCheckbox.checked : currentConfig.learnMode === true;
            if (learnTargetsCard) {
                learnTargetsCard.style.display = showLearn ? '' : 'none';
            }
            if (learnOrderGroup) {
                learnOrderGroup.style.display = showLearn ? '' : 'none';
            }
            if (learnPlacementGroup) {
                learnPlacementGroup.style.display = showLearn ? '' : 'none';
            }
            const learnItalicGroupFinal = document.getElementById('learnItalicGroup');
            if (learnItalicGroupFinal) learnItalicGroupFinal.style.display = showLearn ? '' : 'none';
        }

        validateNoTranslationSelection();
    }



    function filterLanguages(gridId, searchTerm) {
        const grid = document.getElementById(gridId);
        const items = grid.querySelectorAll('.language-item');
        const term = searchTerm.toLowerCase();

        items.forEach(item => {
            const name = item.dataset.name;
            const code = item.dataset.code;
            const matches = name.includes(term) || code.includes(term);
            item.classList.toggle('hidden', !matches);
        });
    }

    function toggleOtherApiKeysSection() {
        const card = document.getElementById('otherApiKeysCard');
        const toolboxEnabled = isSubToolboxEnabled();
        if (card) {
            card.style.display = toolboxEnabled ? '' : 'none';
            card.setAttribute('aria-hidden', toolboxEnabled ? 'false' : 'true');
        }
        if (currentConfig) {
            currentConfig.otherApiKeysEnabled = toolboxEnabled;
        }
    }

    async function autoFetchModels(apiKey) {
        if (!apiKey || apiKey.length < 10) return;

        const statusDiv = document.getElementById('modelStatus');
        if (statusDiv) {
            statusDiv.innerHTML = '<div class="spinner-small"></div> Fetching models...';
            statusDiv.className = 'model-status fetching';
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
            const response = await fetch('/api/gemini-models', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error('Failed to fetch models');
            }

            const models = await response.json();

            lastFetchedApiKey = apiKey;

            if (statusDiv) {
                statusDiv.innerHTML = '✓ Models loaded successfully!';
                statusDiv.className = 'model-status success';

                setTimeout(() => {
                    statusDiv.innerHTML = '';
                    statusDiv.className = 'model-status';
                }, 3000);
            }

            // Populate advanced model dropdown with ALL models (no filtering, no auto-selection)
            await populateAdvancedModels(models);

        } catch (error) {
            if (statusDiv) {
                statusDiv.innerHTML = '✗ Failed to fetch models. Check your API key.';
                statusDiv.className = 'model-status error';

                setTimeout(() => {
                    statusDiv.innerHTML = '';
                    statusDiv.className = 'model-status';
                }, 5000);
            }
        }
    }

    async function populateAdvancedModels(models) {
        const advModelSelect = document.getElementById('advancedModel');
        if (!advModelSelect) {
            return;
        }

        // Clear and populate advanced model dropdown with ALL models
        advModelSelect.innerHTML = `<option value="">${tConfig('config.providersUi.useDefaultModel', {}, 'Use Default Model')}</option>`;

        // Define hardcoded multi-model options
        const hardcodedModels = [

            { name: 'gemini-3.1-flash-lite-preview', displayName: 'Gemini 3.1 Flash Lite' },
            { name: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite' },
            { name: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
            { name: 'gemini-3-flash-preview', displayName: 'Gemini 3.0 Flash (beta)' },
            { name: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro (beta)' },
            { name: 'gemini-3-pro-preview', displayName: 'Gemini 3.0 Pro (beta)' }
        ];

        // Track added models to avoid duplicates
        const addedModels = new Set(['', ...hardcodedModels.map(m => m.name)]);

        // Add hardcoded models first
        hardcodedModels.forEach(model => {
            const option = document.createElement('option');
            option.value = model.name;
            option.textContent = model.displayName;

            // Preserve user's saved selection if it exists
            if (currentConfig.advancedSettings?.geminiModel === model.name) {
                option.selected = true;
            }

            advModelSelect.appendChild(option);
        });

        // Add API-fetched models (avoid duplicates)
        models.forEach(model => {
            if (!addedModels.has(model.name)) {
                const option = document.createElement('option');
                option.value = model.name;
                option.textContent = `${model.displayName}`;

                // Preserve user's saved selection if it exists
                if (currentConfig.advancedSettings?.geminiModel === model.name) {
                    option.selected = true;
                }

                advModelSelect.appendChild(option);
                addedModels.add(model.name);
            }
        });


    }

    function handleQuickAction(e) {
        const action = e.currentTarget?.dataset?.action || e.target?.closest?.('button')?.dataset?.action;
        if (!action) return;
        const parts = action.split('-');
        const command = parts[0]; // 'select' or 'clear'
        let type;

        // For 'clear' actions: clear-notranslation (2 parts)
        // For 'select' actions: select-popular-source (3 parts)
        if (command === 'clear') {
            type = parts[1]; // notranslation
        } else {
            type = parts[2]; // source, target, notranslation
        }

        let gridId, configKey;

        if (type === 'source') {
            gridId = 'sourceLanguages';
            configKey = 'sourceLanguages';
        } else if (type === 'notranslation') {
            gridId = 'noTranslationLanguages';
            configKey = 'noTranslationLanguages';
        } else if (type === 'learn') {
            gridId = 'learnLanguages';
            configKey = 'learnTargetLanguages';
        } else {
            gridId = 'targetLanguages';
            configKey = 'targetLanguages';
        }

        const grid = document.getElementById(gridId);
        if (!grid) {
            return;
        }

        const items = grid.querySelectorAll('.language-item:not(.hidden)');

        switch (command) {
            case 'select':
                if (type === 'source') {
                    // Source languages: respect MAX_SOURCE_LANGUAGES
                    // For "Popular" or "All", select up to the configured limit
                    const selectedCodes = [];
                    items.forEach(item => {
                        if (selectedCodes.length >= MAX_SOURCE_LANGUAGES) return; // Limit to configured value

                        const code = item.dataset.code;
                        if (action.includes('popular') && POPULAR_LANGUAGES.includes(code)) {
                            selectedCodes.push(code);
                        } else if (!action.includes('popular')) {
                            selectedCodes.push(code);
                        }
                    });

                    if (selectedCodes.length > 0) {
                        currentConfig[configKey] = selectedCodes;
                        items.forEach(item => {
                            if (selectedCodes.includes(item.dataset.code)) {
                                item.classList.add('selected');
                            } else {
                                item.classList.remove('selected');
                            }
                        });
                    }
                } else {
                    // Target, learn and no-translation languages
                    const candidates = [];
                    items.forEach(item => {
                        const code = item.dataset.code;
                        if (action.includes('popular')) {
                            if (POPULAR_LANGUAGES.includes(code)) {
                                candidates.push(code);
                            }
                        } else {
                            candidates.push(code);
                        }
                    });

                    let selection = candidates;
                    let truncated = false;
                    if (type === 'target' || type === 'learn') {
                        const result = buildLimitedTargetSelection(candidates, type);
                        selection = result.selection;
                        truncated = result.truncated;
                    } else if (type === 'notranslation') {
                        const result = buildLimitedNoTranslationSelection(candidates);
                        selection = result.selection;
                        truncated = result.truncated;
                    }

                    currentConfig[configKey] = selection;
                    const selectionSet = new Set(selection);

                    items.forEach(item => {
                        if (selectionSet.has(item.dataset.code)) {
                            item.classList.add('selected');
                        } else {
                            item.classList.remove('selected');
                        }
                    });

                    if (truncated) {
                        const msg = type === 'notranslation'
                            ? tConfig('config.alerts.noTranslationTrimmed', { limit: MAX_NO_TRANSLATION_LANGUAGES }, `Only the first ${MAX_NO_TRANSLATION_LANGUAGES} languages were kept for Just Fetch mode.`)
                            : tConfig('config.alerts.targetsTrimmed', { limit: MAX_TARGET_LANGUAGES }, `Only the first ${MAX_TARGET_LANGUAGES} target languages were kept (combined with Learn Mode).`);
                        showAlert(msg, 'warning');
                    }
                }
                break;

            case 'clear':
                currentConfig[configKey] = [];
                // Remove selected class from ALL items, not just visible ones
                const allItems = grid.querySelectorAll('.language-item');
                allItems.forEach(item => {
                    item.classList.remove('selected');
                });
                break;
        }

        updateSelectedChips(type, currentConfig[configKey]);
    }

    function toggleProviderConfig(configId, enabled) {
        const configDiv = document.getElementById(configId);
        if (!configDiv) return;

        // Remember the natural display so we can restore it after hiding
        if (!configDiv.dataset.defaultDisplay) {
            const currentDisplay = window.getComputedStyle(configDiv).display;
            configDiv.dataset.defaultDisplay = currentDisplay === 'none' ? 'block' : currentDisplay;
        }

        configDiv.style.display = enabled ? configDiv.dataset.defaultDisplay : 'none';
        configDiv.style.opacity = enabled ? '1' : '0.5';
        configDiv.style.pointerEvents = enabled ? 'auto' : 'none';
        configDiv.setAttribute('aria-hidden', enabled ? 'false' : 'true');

        // Fully disable inputs/buttons when hidden so nothing is focusable/tabbable
        const formControls = configDiv.querySelectorAll('input, select, textarea, button');
        formControls.forEach(control => {
            control.disabled = !enabled;
        });

        if (configId === 'opensubtitlesConfig') {
            // Always update auth fields visibility (whether enabled or disabled)
            // This ensures correct state in all scenarios: enabled/disabled, v3/auth, with/without credentials
            handleOpenSubtitlesImplChange();
        }
    }

    /**
     * Get current app version from the page
     * This version is fetched from /api/session-stats
     */
    async function getCurrentAppVersion() {
        try {
            const bootVersion = (typeof window !== 'undefined' && typeof window.__APP_VERSION__ === 'string')
                ? window.__APP_VERSION__.trim()
                : '';
            if (bootVersion) {
                return bootVersion;
            }
        } catch (_) { }

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 6000);
            try {
                const response = await fetch('/api/session-stats', { cache: 'no-store', signal: controller.signal });
                const data = await response.json();
                return data.version || 'unknown';
            } finally {
                clearTimeout(timeout);
            }
        } catch (error) { return 'unknown'; }
    }

    /**
     * Save configuration to localStorage with version tracking
     */
    function saveConfigToCache(config, tokenForCache) {
        try {
            // Save config and timestamp
            localStorage.setItem(CACHE_KEY, JSON.stringify(config));
            localStorage.setItem(CACHE_EXPIRY_KEY, Date.now().toString());

            // Scope cache to the session token to prevent cross-user bleed when swapping configs
            if (isValidSessionToken(tokenForCache)) {
                localStorage.setItem(CACHE_TOKEN_KEY, tokenForCache);
            } else {
                localStorage.removeItem(CACHE_TOKEN_KEY);
            }

            // Get and save current app version
            getCurrentAppVersion().then(version => {
                try { localStorage.setItem(CACHE_VERSION_KEY, version); } catch (error) { }
            }).catch(function () { });
        } catch (error) {
            // Continue anyway - caching is optional
        }
    }

    /**
     * Validate configuration structure and required fields
     * Returns null if invalid, otherwise returns the config
     */
    function validateConfig(config) {
        if (!config || typeof config !== 'object') { return null; }

        // Check for critical required fields
        if (typeof config.subtitleProviders !== 'object') { return null; }

        // Config is valid
        return config;
    }

    /**
     * Clear visual state cache but preserve form data
     * Called when version changes or config is invalid
     */
    function clearVisualStateCache() {
        try {
            VISUAL_STATE_KEYS.forEach(key => {
                try {
                    localStorage.removeItem(key);
                } catch (e) {
                    // Ignore individual removals
                }
            });
        } catch (error) { }
    }

    /**
     * Build a migrated config for a new version, preserving only whitelisted fields.
     * - Resets selected model and ALL advanced settings to defaults
     * - Preserves: Gemini API key, subtitle sources enabled/disabled, provider API keys/credentials (if provider still exists),
     *   source/target languages, Other Settings checkboxes (Sub Toolbox, cacheEnabled, bypassCache), and subtitleProviderTimeout
     */
    function migrateConfigForNewVersion(oldConfig) {
        const defaultGeminiModel = getDefaultGeminiModelOptionValue();
        const defaults = getDefaultConfig(defaultGeminiModel);

        const newConfig = { ...defaults };

        try {
            // Preserve multi-provider + fallback selections when valid
            const oldMultiEnabled = oldConfig.multiProviderEnabled === true;
            const oldSecondaryEnabled = oldMultiEnabled && oldConfig.secondaryProviderEnabled === true;
            const oldMainProvider = String(oldConfig.mainProvider || 'gemini').toLowerCase();
            const oldSecondaryProvider = oldSecondaryEnabled ? String(oldConfig.secondaryProvider || '').toLowerCase() : '';

            // Preserve Gemini API key and key rotation settings
            newConfig.geminiApiKey = (oldConfig.geminiApiKey || '').trim();
            newConfig.geminiKeyRotationEnabled = oldConfig.geminiKeyRotationEnabled === true;
            newConfig.geminiApiKeys = Array.isArray(oldConfig.geminiApiKeys)
                ? oldConfig.geminiApiKeys.filter(k => typeof k === 'string' && k.trim())
                : [];
            newConfig.geminiKeyRotationMode = oldConfig.geminiKeyRotationMode || 'per-batch';

            // Preserve subtitle sources enabled/disabled + API keys if provider still exists
            newConfig.subtitleProviders = { ...defaults.subtitleProviders };

            if (oldConfig.subtitleProviders && typeof oldConfig.subtitleProviders === 'object') {
                // OpenSubtitles: preserve enabled, implementation, and credentials
                if (defaults.subtitleProviders.opensubtitles) {
                    const oldOpen = oldConfig.subtitleProviders.opensubtitles || {};
                    newConfig.subtitleProviders.opensubtitles.enabled = oldOpen.enabled !== false;
                    // Preserve implementationType only if exists (v3/auth)
                    if (oldOpen.implementationType) {
                        newConfig.subtitleProviders.opensubtitles.implementationType = oldOpen.implementationType;
                    }
                    // Preserve credentials for Auth implementation
                    newConfig.subtitleProviders.opensubtitles.username = (oldOpen.username || '').trim();
                    newConfig.subtitleProviders.opensubtitles.password = (oldOpen.password || '').trim();
                }

                // SubDL: preserve enabled and apiKey if provider exists
                if (defaults.subtitleProviders.subdl) {
                    const oldSubdl = oldConfig.subtitleProviders.subdl || {};
                    newConfig.subtitleProviders.subdl.enabled = oldSubdl.enabled !== false;
                    newConfig.subtitleProviders.subdl.apiKey = (oldSubdl.apiKey || '').trim();
                }

                // SubSource: preserve enabled and apiKey if provider exists
                if (defaults.subtitleProviders.subsource) {
                    const oldSubsource = oldConfig.subtitleProviders.subsource || {};
                    newConfig.subtitleProviders.subsource.enabled = oldSubsource.enabled !== false;
                    newConfig.subtitleProviders.subsource.apiKey = (oldSubsource.apiKey || '').trim();
                }

                // SCS: preserve enabled state if provider exists
                if (defaults.subtitleProviders.scs) {
                    const oldScs = oldConfig.subtitleProviders.scs || {};
                    newConfig.subtitleProviders.scs.enabled = oldScs.enabled === true;
                }

                // Wyzie: preserve enabled state and sources config if provider exists
                if (defaults.subtitleProviders.wyzie) {
                    const oldWyzie = oldConfig.subtitleProviders.wyzie || {};
                    newConfig.subtitleProviders.wyzie.enabled = oldWyzie.enabled === true;
                    // Preserve sources config if it exists
                    if (oldWyzie.sources && typeof oldWyzie.sources === 'object') {
                        newConfig.subtitleProviders.wyzie.sources = { ...oldWyzie.sources };
                    } else if (oldWyzie.enabled === true) {
                        // BACKWARDS COMPAT: If user had Wyzie enabled but no sources saved,
                        // default to ALL sources enabled (preserves their previous behavior)
                        newConfig.subtitleProviders.wyzie.sources = {
                            opensubtitles: true, subf2m: true, subdl: true,
                            podnapisi: true, gestdown: true, animetosho: true,
                            kitsunekko: true, jimaku: true, yify: true
                        };
                    }
                }

                // Subs.ro: preserve enabled state and apiKey if provider exists
                if (defaults.subtitleProviders.subsro) {
                    const oldSubsro = oldConfig.subtitleProviders.subsro || {};
                    newConfig.subtitleProviders.subsro.enabled = oldSubsro.enabled === true;
                    newConfig.subtitleProviders.subsro.apiKey = (oldSubsro.apiKey || '').trim();
                }
            }

            // Preserve standalone API keys for auto-subs flows
            newConfig.assemblyAiApiKey = (oldConfig.assemblyAiApiKey || '').trim();
            newConfig.cloudflareWorkersApiKey = (oldConfig.cloudflareWorkersApiKey || '').trim();

            // Preserve alternative AI providers
            newConfig.betaModeEnabled = oldConfig.betaModeEnabled === true;
            newConfig.multiProviderEnabled = oldConfig.multiProviderEnabled === true;
            newConfig.mainProvider = oldConfig.mainProvider || 'gemini';
            newConfig.providers = mergeProviders(defaults.providers, oldConfig.providers || {});
            newConfig.providerParameters = mergeProviderParameters(defaults.providerParameters, oldConfig.providerParameters || {});
            if (
                oldSecondaryEnabled &&
                oldSecondaryProvider &&
                oldSecondaryProvider !== oldMainProvider &&
                (
                    oldSecondaryProvider === 'gemini' ||
                    (newConfig.providers?.[oldSecondaryProvider] && newConfig.providers[oldSecondaryProvider].enabled !== undefined)
                )
            ) {
                newConfig.secondaryProviderEnabled = true;
                newConfig.secondaryProvider = oldSecondaryProvider;
            }

            // Preserve languages
            newConfig.sourceLanguages = Array.isArray(oldConfig.sourceLanguages) ? [...oldConfig.sourceLanguages] : defaults.sourceLanguages;
            newConfig.targetLanguages = Array.isArray(oldConfig.targetLanguages) ? [...oldConfig.targetLanguages] : defaults.targetLanguages;

            // Preserve Other Settings checkboxes
            // - unified Sub Toolbox toggle (mirrors legacy file translation/sync flags)
            const legacyToolboxEnabled = oldConfig.subToolboxEnabled === true
                || oldConfig.fileTranslationEnabled === true
                || oldConfig.syncSubtitlesEnabled === true;
            newConfig.subToolboxEnabled = legacyToolboxEnabled;
            newConfig.fileTranslationEnabled = legacyToolboxEnabled;
            newConfig.syncSubtitlesEnabled = legacyToolboxEnabled;
            // - translation cache enabled
            if (!newConfig.translationCache) newConfig.translationCache = { enabled: true, duration: 0, persistent: true };
            const oldCacheEnabled = !!(oldConfig.translationCache ? oldConfig.translationCache.enabled !== false : true);
            newConfig.translationCache.enabled = oldCacheEnabled;
            // - bypass cache
            newConfig.bypassCache = oldConfig.bypassCache === true;
            // - mobile mode
            newConfig.mobileMode = oldConfig.mobileMode === true;
            // - single-batch mode
            newConfig.singleBatchMode = oldConfig.singleBatchMode === true;
            // - exclude HI/SDH subtitles
            newConfig.excludeHearingImpairedSubtitles = oldConfig.excludeHearingImpairedSubtitles === true;
            // - enable season pack subtitles (defaults to true for backwards compatibility)
            newConfig.enableSeasonPacks = oldConfig.enableSeasonPacks !== false;
            // - subtitle provider timeout (preserve user's setting, fallback to default 12 if not set)
            const oldTimeout = parseInt(oldConfig.subtitleProviderTimeout, 10);
            newConfig.subtitleProviderTimeout = Number.isFinite(oldTimeout) ? Math.max(8, Math.min(30, oldTimeout)) : 12;

            // Reset selected model to the dropdown's configured default option and reset advanced settings to defaults
            newConfig.geminiModel = defaultGeminiModel;
            newConfig.advancedSettings = { ...defaults.advancedSettings };
        } catch (e) { }

        return newConfig;
    }

    /**
     * Load configuration from localStorage with version validation
     * @returns {Object|null} The cached configuration or null if not found/invalid/stale
     */
    async function loadConfigFromCache(expectedToken) {
        try {
            const cachedConfig = localStorage.getItem(CACHE_KEY);
            if (!cachedConfig) {
                return null;
            }

            // Ensure cached config belongs to the same session token we're trying to use
            const cachedToken = localStorage.getItem(CACHE_TOKEN_KEY);
            if ((cachedToken || expectedToken) && (!cachedToken || !expectedToken || cachedToken !== expectedToken)) {
                clearConfigCache();
                return null;
            }

            const config = JSON.parse(cachedConfig);

            // Validate config structure
            if (!validateConfig(config)) {
                clearConfigCache();
                clearVisualStateCache();
                return null;
            }

            // Check version mismatch
            const cachedVersion = localStorage.getItem(CACHE_VERSION_KEY);
            const currentVersion = await getCurrentAppVersion();

            if (cachedVersion && cachedVersion !== currentVersion) {
                // Clear visual state like collapsed sections, hints, scroll, etc.
                clearVisualStateCache();

                // Build a migrated config that preserves only allowed fields
                const migrated = migrateConfigForNewVersion(config);

                // Persist migrated config and new version so subsequent loads are stable
                try {
                    localStorage.setItem(CACHE_KEY, JSON.stringify(migrated));
                    localStorage.setItem(CACHE_VERSION_KEY, currentVersion);
                } catch (_) { }

                // Notify user briefly that a new version was detected
                try { showAlert(tConfig('config.alerts.newVersionDetected', {}, 'New Version Detected'), 'info', 'config.alerts.newVersionDetected', {}); } catch (_) { }

                return migrated;
            }

            return config;
        } catch (error) { return null; }
    }

    /**
     * Clear cached configuration from localStorage
     */
    function clearConfigCache() {
        try {
            localStorage.removeItem(CACHE_KEY);
            localStorage.removeItem(CACHE_EXPIRY_KEY);
            localStorage.removeItem(CACHE_VERSION_KEY);
            localStorage.removeItem(CACHE_TOKEN_KEY);
        } catch (error) {
            // Failed to clear cache
        }
    }

    function loadConfigToForm() {
        // Load no-translation mode
        const noTranslationMode = currentConfig.noTranslationMode || false;
        const noTranslationToggle = document.getElementById('noTranslationMode');
        if (noTranslationToggle) {
            noTranslationToggle.checked = noTranslationMode;
            toggleNoTranslationMode(noTranslationMode);
        }

        // UI language selector
        const activeUiLang = (currentConfig.uiLanguage || locale.lang || 'en').toString().toLowerCase();
        renderUiLanguageFlags(activeUiLang);
        updateUiLanguageBadge(activeUiLang);

        // Load Gemini API key
        document.getElementById('geminiApiKey').value = currentConfig.geminiApiKey || '';

        // Load Gemini API key rotation settings
        const keyRotationEnabled = currentConfig.geminiKeyRotationEnabled === true;
        const keyRotationToggle = document.getElementById('geminiKeyRotationEnabled');
        if (keyRotationToggle) {
            keyRotationToggle.checked = keyRotationEnabled;
        }
        // Clear existing key inputs first
        const keysList = document.getElementById('geminiApiKeysList');
        if (keysList) {
            keysList.innerHTML = '';
        }
        // Populate additional keys from config (skip first key - it's already in the single key field)
        const geminiApiKeys = Array.isArray(currentConfig.geminiApiKeys) ? currentConfig.geminiApiKeys : [];
        // The first key in geminiApiKeys is Key 1, which is displayed in the single key field
        // Only add Key 2+ to the additional keys list
        const additionalKeys = geminiApiKeys.slice(1);
        if (additionalKeys.length > 0) {
            additionalKeys.forEach(key => addGeminiKeyInput(key));
        }
        // Toggle UI visibility based on state
        toggleGeminiKeyRotationUI(keyRotationEnabled);

        // Load rotation mode
        const rotationModeSelect = document.getElementById('geminiKeyRotationMode');
        if (rotationModeSelect) {
            rotationModeSelect.value = currentConfig.geminiKeyRotationMode || 'per-batch';
        }

        const assemblyKeyInput = document.getElementById('assemblyAiApiKey');
        if (assemblyKeyInput) {
            assemblyKeyInput.value = currentConfig.assemblyAiApiKey || '';
        }
        const cloudflareKeyInput = document.getElementById('cloudflareWorkersApiKey');
        if (cloudflareKeyInput) {
            cloudflareKeyInput.value = currentConfig.cloudflareWorkersApiKey || '';
        }

        // Load Gemini model
        const modelSelect = document.getElementById('geminiModel');
        const rawGeminiModel = typeof currentConfig.geminiModel === 'string' ? currentConfig.geminiModel.trim() : '';
        const modelToUse = normalizeGeminiModelForBaseSelect(rawGeminiModel);
        const baseModelWasNormalized = rawGeminiModel !== modelToUse;
        currentConfig.geminiModel = modelToUse;

        if (modelSelect) {
            modelSelect.value = modelToUse;
        }

        // Load prompt style
        const promptStyle = currentConfig.promptStyle || 'natural';
        document.getElementById('promptStyle').value = promptStyle;

        // Load translation prompt (kept for internal use, not displayed in UI)
        const translationPrompt = currentConfig.translationPrompt || NATURAL_TRANSLATION_PROMPT;

        // Load Beta Mode (controls experimental sections visibility)
        const betaToggle = document.getElementById('betaMode');
        const betaEnabled = currentConfig.betaModeEnabled === true;
        if (betaToggle) {
            betaToggle.checked = betaEnabled;
        }
        toggleBetaModeUI(betaEnabled, { silent: true });

        // Load Dev Mode (hidden checkbox revealed by Ctrl+Alt+D)
        const devModeToggle = document.getElementById('devMode');
        const devModeEnabled = currentConfig.devMode === true;
        if (devModeToggle) {
            devModeToggle.checked = devModeEnabled;
        }
        // If dev mode is enabled, ensure the group is visible
        if (devModeEnabled) {
            const devModeGroup = document.getElementById('devModeGroup');
            if (devModeGroup) {
                devModeGroup.style.display = 'block';
            }
        }
        toggleOtherApiKeysSection();

        ensureProviderParametersInState();
        const multiToggle = document.getElementById('enableMultiProviders');
        const multiEnabled = currentConfig.multiProviderEnabled === true;
        if (multiToggle) multiToggle.checked = multiEnabled;
        applyProvidersToForm(currentConfig.providers || {});
        applyProviderParametersToForm(currentConfig.providerParameters || {});
        // Re-apply multi-provider UI AFTER provider state is hydrated so we don't clear secondary selections
        toggleMultiProviderUI(multiEnabled);
        updateProviderAdvancedVisibility();

        // Load subtitle providers
        if (!currentConfig.subtitleProviders) {
            currentConfig.subtitleProviders = getDefaultConfig().subtitleProviders;
        }

        // OpenSubtitles
        const opensubtitlesEnabled = (isFirstRun ? false : (currentConfig.subtitleProviders?.opensubtitles?.enabled !== false));
        document.getElementById('enableOpenSubtitles').checked = opensubtitlesEnabled;

        // Load implementation type
        const implementationType = currentConfig.subtitleProviders?.opensubtitles?.implementationType || 'v3';
        const authRadio = document.getElementById('opensubtitlesImplAuth');
        const v3Radio = document.getElementById('opensubtitlesImplV3');
        if (implementationType === 'auth') {
            authRadio.checked = true;
        } else {
            v3Radio.checked = true;
        }

        // toggleProviderConfig will call handleOpenSubtitlesImplChange to set auth fields visibility
        // IMPORTANT: Call this BEFORE populating credentials so the auth section is visible when values are set
        toggleProviderConfig('opensubtitlesConfig', opensubtitlesEnabled);

        // Load user credentials (optional) - do this AFTER visibility is set to ensure fields are visible
        document.getElementById('opensubtitlesUsername').value =
            currentConfig.subtitleProviders?.opensubtitles?.username || '';
        document.getElementById('opensubtitlesPassword').value =
            currentConfig.subtitleProviders?.opensubtitles?.password || '';

        // SubDL
        const subdlEnabled = (isFirstRun ? false : (currentConfig.subtitleProviders?.subdl?.enabled !== false));
        document.getElementById('enableSubDL').checked = subdlEnabled;
        document.getElementById('subdlApiKey').value =
            currentConfig.subtitleProviders?.subdl?.apiKey || DEFAULT_API_KEYS.SUBDL;
        toggleProviderConfig('subdlConfig', subdlEnabled);

        // SubSource
        const subsourceEnabled = (isFirstRun ? false : (currentConfig.subtitleProviders?.subsource?.enabled !== false));
        document.getElementById('enableSubSource').checked = subsourceEnabled;
        document.getElementById('subsourceApiKey').value =
            currentConfig.subtitleProviders?.subsource?.apiKey || DEFAULT_API_KEYS.SUBSOURCE;
        toggleProviderConfig('subsourceConfig', subsourceEnabled);

        // Stremio Community Subtitles (SCS) - no API key needed
        const scsEnabled = currentConfig.subtitleProviders?.scs?.enabled === true;
        const scsToggle = document.getElementById('enableSCS');
        if (scsToggle) scsToggle.checked = scsEnabled;

        // Wyzie Subs - free aggregator, no API key needed
        const wyzieEnabled = currentConfig.subtitleProviders?.wyzie?.enabled === true;
        const wyzieToggle = document.getElementById('enableWyzie');
        if (wyzieToggle) wyzieToggle.checked = wyzieEnabled;

        // Wyzie Sources - show/hide and load saved preferences
        const wyzieSources = document.getElementById('wyzieSources');
        if (wyzieSources) {
            wyzieSources.style.display = wyzieEnabled ? 'block' : 'none';
        }
        // Default all sources to DISABLED if not specified (user must opt-in)
        const wyzieSourceConfig = currentConfig.subtitleProviders?.wyzie?.sources || {
            opensubtitles: false, subf2m: false, subdl: false, podnapisi: false, gestdown: false, animetosho: false, kitsunekko: false, jimaku: false, yify: false
        };
        const sourceIds = ['opensubtitles', 'subf2m', 'subdl', 'podnapisi', 'gestdown', 'animetosho', 'kitsunekko', 'jimaku', 'yify'];
        sourceIds.forEach(src => {
            const el = document.getElementById('wyzieSource' + src.charAt(0).toUpperCase() + src.slice(1));
            if (el) el.checked = wyzieSourceConfig[src] === true; // Default to false for new users
        });
        // Add toggle listener to show/hide sources
        if (wyzieToggle) {
            wyzieToggle.onchange = (e) => {
                if (wyzieSources) wyzieSources.style.display = e.target.checked ? 'block' : 'none';
            };
        }

        // Subs.ro - Romanian subtitle database, requires API key
        const subsroEnabled = currentConfig.subtitleProviders?.subsro?.enabled === true;
        const subsroToggle = document.getElementById('enableSubsRo');
        if (subsroToggle) subsroToggle.checked = subsroEnabled;
        const subsroApiKeyEl = document.getElementById('subsroApiKey');
        if (subsroApiKeyEl) {
            subsroApiKeyEl.value = currentConfig.subtitleProviders?.subsro?.apiKey || '';
        }
        toggleProviderConfig('subsroConfig', subsroEnabled);

        // Load subtitle provider timeout setting (min: 8, max: 30, default: 12)
        const timeoutSlider = document.getElementById('subtitleProviderTimeout');
        const timeoutValueEl = document.getElementById('subtitleProviderTimeoutValue');
        if (timeoutSlider) {
            const savedTimeout = currentConfig.subtitleProviderTimeout || 12;
            // Clamp to valid range
            const clampedTimeout = Math.max(8, Math.min(30, savedTimeout));
            timeoutSlider.value = clampedTimeout;
            if (timeoutValueEl) timeoutValueEl.textContent = clampedTimeout + 's';

            // Update display and config on change
            timeoutSlider.oninput = (e) => {
                const value = parseInt(e.target.value, 10);
                if (timeoutValueEl) timeoutValueEl.textContent = value + 's';
                currentConfig.subtitleProviderTimeout = value;
            };
        }

        // Load Sub Toolbox setting (unifies file translation and sync actions)
        const toolboxEnabled = currentConfig.subToolboxEnabled === true
            || currentConfig.fileTranslationEnabled === true
            || currentConfig.syncSubtitlesEnabled === true;
        currentConfig.subToolboxEnabled = toolboxEnabled;
        setSubToolboxEnabledUI(toolboxEnabled);

        // Load HI/SDH exclusion setting (applies to both translation + no-translation modes)
        const hiExcludeEnabled = currentConfig.excludeHearingImpairedSubtitles === true;
        const hiExcludeEl = document.getElementById('excludeHearingImpairedSubtitles');
        const hiExcludeElNoTranslation = document.getElementById('excludeHearingImpairedSubtitlesNoTranslation');
        if (hiExcludeEl) hiExcludeEl.checked = hiExcludeEnabled;
        if (hiExcludeElNoTranslation) hiExcludeElNoTranslation.checked = hiExcludeEnabled;
        const mobileModeEl = document.getElementById('mobileMode');
        if (mobileModeEl) mobileModeEl.checked = currentConfig.mobileMode === true;
        const singleBatchEl = document.getElementById('singleBatchMode');
        if (singleBatchEl) singleBatchEl.checked = currentConfig.singleBatchMode === true;
        const forceSRTEl = document.getElementById('forceSRTOutput');
        const forceSRTElNoTranslation = document.getElementById('forceSRTOutputNoTranslation');
        if (forceSRTEl) forceSRTEl.checked = currentConfig.forceSRTOutput === true;
        if (forceSRTElNoTranslation) forceSRTElNoTranslation.checked = currentConfig.forceSRTOutput === true;
        // Checkbox represents passthrough, but stored config uses convertAssToVtt.
        // checked = passthrough ON => convertAssToVtt false
        const convertAssToVttEl = document.getElementById('convertAssToVtt');
        if (convertAssToVttEl) {
            convertAssToVttEl.checked = currentConfig.convertAssToVtt === false;
            // Disable ASS/SSA toggle when Force SRT is enabled (they conflict)
            if (forceSRTEl && forceSRTEl.checked) {
                convertAssToVttEl.disabled = true;
                convertAssToVttEl.checked = false; // Force SRT implies conversion → passthrough OFF
            }
        }
        // Force SRT <-> ASS/SSA toggle sync is handled by syncForceSRT listener below
        // Re-apply dev-only option visibility after config values are loaded.
        // Without this, these groups can stay hidden after reload until the user toggles Dev Mode again.
        const devEnabledAfterLoad = currentConfig.devMode === true;
        const convertAssGroup = document.getElementById('convertAssToVttGroup');
        if (convertAssGroup) {
            // Always visible - no longer gated by devMode (Phase 1: user-facing setting)
            convertAssGroup.style.display = 'block';
        }
        const urlExtTestGroup = document.getElementById('urlExtensionTestGroup');
        if (urlExtTestGroup) {
            const assConversionDisabled = convertAssToVttEl ? convertAssToVttEl.checked : false;
            urlExtTestGroup.style.display = (devEnabledAfterLoad && assConversionDisabled) ? 'block' : 'none';
        }
        const androidCompatGroup = document.getElementById('androidSubtitleCompatModeGroup');
        if (androidCompatGroup) {
            androidCompatGroup.style.display = devEnabledAfterLoad ? 'block' : 'none';
        }
        const parallelBatchesGroupEl = document.getElementById('parallelBatchesGroup');
        if (parallelBatchesGroupEl) {
            parallelBatchesGroupEl.style.display = devEnabledAfterLoad ? 'block' : 'none';
        }
        lastUrlExtensionTestChoice = normalizeUrlExtensionTestValue(currentConfig.urlExtensionTest, 'srt');
        syncUrlExtensionTestModeUi();
        const selectedCompatMode = String(currentConfig.androidSubtitleCompatMode || 'off');
        const compatRadio = document.querySelector(`input[name="androidSubtitleCompatMode"][value="${selectedCompatMode}"]`)
            || document.querySelector('input[name="androidSubtitleCompatMode"][value="off"]');
        if (compatRadio) {
            compatRadio.checked = true;
        }
        // Season packs default to enabled (true) for backwards compatibility
        const seasonPacksEnabled = currentConfig.enableSeasonPacks !== false;
        const seasonPacksEl = document.getElementById('enableSeasonPacks');
        const seasonPacksElNoTranslation = document.getElementById('enableSeasonPacksNoTranslation');
        if (seasonPacksEl) seasonPacksEl.checked = seasonPacksEnabled;
        if (seasonPacksElNoTranslation) seasonPacksElNoTranslation.checked = seasonPacksEnabled;

        // Load translation cache settings
        if (!currentConfig.translationCache) {
            currentConfig.translationCache = getDefaultConfig().translationCache;
        }

        // Set database mode dropdown based on bypass flag
        // If bypass is true → show "bypass", otherwise → show "use"
        const databaseModeEl = document.getElementById('databaseMode');
        if (databaseModeEl) {
            const bypassEnabled = currentConfig.bypassCache === true || currentConfig.translationCache?.enabled === false;
            databaseModeEl.value = bypassEnabled ? 'bypass' : 'use';
        }

        // Load advanced settings
        if (!currentConfig.advancedSettings) {
            currentConfig.advancedSettings = getDefaultConfig(currentConfig.geminiModel || getFirstGeminiModelOptionValue()).advancedSettings;
        } else {
            const shouldRebaseAdvancedDefaults = baseModelWasNormalized
                && currentConfig.advancedSettings?.enabled !== true
                && !(typeof currentConfig.advancedSettings?.geminiModel === 'string' && currentConfig.advancedSettings.geminiModel.trim());
            if (shouldRebaseAdvancedDefaults) {
                currentConfig.advancedSettings = getDefaultConfig(currentConfig.geminiModel || getFirstGeminiModelOptionValue()).advancedSettings;
            }
            // Merge with defaults to backfill any new fields
            const advDefaults = getDefaultConfig(currentConfig.geminiModel || getFirstGeminiModelOptionValue()).advancedSettings;
            currentConfig.advancedSettings = {
                ...advDefaults,
                ...currentConfig.advancedSettings
            };
        }

        const advModelEl = document.getElementById('advancedModel');
        const advThinkingEl = document.getElementById('advancedThinkingBudget');
        const advTempEl = document.getElementById('advancedTemperature');
        const advTopPEl = document.getElementById('advancedTopP');

        if (advModelEl) {
            // Will be populated by fetchAvailableModels
            advModelEl.value = currentConfig.advancedSettings?.geminiModel || '';
        }

        if (advThinkingEl) advThinkingEl.value = currentConfig.advancedSettings?.thinkingBudget ?? 0;
        if (advTempEl) advTempEl.value = currentConfig.advancedSettings?.temperature ?? 0.8;
        if (advTopPEl) advTopPEl.value = currentConfig.advancedSettings?.topP ?? 0.95;

        // Load batch context settings
        const enableBatchContextEl = document.getElementById('enableBatchContext');
        const contextSizeEl = document.getElementById('contextSize');
        const contextSizeGroupEl = document.getElementById('contextSizeGroup');

        if (enableBatchContextEl) {
            enableBatchContextEl.checked = currentConfig.advancedSettings?.enableBatchContext === true;
            // Show/hide context size field based on checkbox
            if (contextSizeGroupEl) {
                contextSizeGroupEl.style.display = enableBatchContextEl.checked ? 'block' : 'none';
            }
        }
        if (contextSizeEl) contextSizeEl.value = currentConfig.advancedSettings?.contextSize || 8;
        {
            let workflow = currentConfig.advancedSettings?.translationWorkflow ||
                ((currentConfig.advancedSettings?.sendTimestampsToAI === true) ? 'ai' : 'xml');
            // Backward compat: migrate enableJsonOutput toggle → 'json' workflow
            if (currentConfig.advancedSettings?.enableJsonOutput === true && workflow !== 'ai') {
                workflow = 'json';
            }
            setSelectedTranslationWorkflow(workflow);
        }

        // Load mismatch retries setting
        const mismatchRetriesEl = document.getElementById('mismatchRetries');
        if (mismatchRetriesEl) {
            const val = parseInt(currentConfig.advancedSettings?.mismatchRetries);
            mismatchRetriesEl.value = Number.isFinite(val) ? Math.max(0, Math.min(3, val)) : 1;
        }

        // Check if advanced settings are modified and update bypass cache accordingly
        updateBypassCacheForAdvancedSettings();

        // Learn Mode UI state
        try {
            const learnToggle = document.getElementById('learnModeEnabled');
            const learnOrderGroup = document.getElementById('learnOrderGroup');
            const learnPlacementGroup = document.getElementById('learnPlacementGroup');
            const learnTargetsCard = document.getElementById('learnTargetsCard');
            if (learnToggle) learnToggle.checked = !!currentConfig.learnMode;
            if (learnOrderGroup) learnOrderGroup.style.display = currentConfig.learnMode ? '' : 'none';
            if (learnPlacementGroup) learnPlacementGroup.style.display = currentConfig.learnMode ? '' : 'none';
            if (learnTargetsCard) learnTargetsCard.style.display = currentConfig.learnMode ? '' : 'none';
            const learnItalicGroup = document.getElementById('learnItalicGroup');
            if (learnItalicGroup) learnItalicGroup.style.display = currentConfig.learnMode ? '' : 'none';
            const learnItalicToggle = document.getElementById('learnItalicEnabled');
            if (learnItalicToggle) {
                learnItalicToggle.checked = currentConfig.learnItalic !== false;
                const italicTargetGroup = document.getElementById('learnItalicTargetGroup');
                if (italicTargetGroup) italicTargetGroup.style.display = learnItalicToggle.checked ? 'flex' : 'none';
            }
            const italicTarget = currentConfig.learnItalicTarget || 'target';
            const italicTargetInput = document.querySelector(`input[name="learnItalicTarget"][value="${italicTarget}"]`);
            if (italicTargetInput) italicTargetInput.checked = true;
            const order = currentConfig.learnOrder || 'source-top';
            const orderInput = document.querySelector(`input[name=\"learnOrder\"][value=\"${order}\"]`);
            if (orderInput) orderInput.checked = true;
            const placement = currentConfig.learnPlacement || 'stacked';
            const placementInput = document.querySelector(`input[name=\"learnPlacement\"][value=\"${placement}\"]`);
            if (placementInput) placementInput.checked = true;
        } catch (_) { }

        // Track mobile mode toggle in state
        const mobileToggle = document.getElementById('mobileMode');
        if (mobileToggle) {
            mobileToggle.checked = currentConfig.mobileMode === true;
            mobileToggle.onchange = (e) => {
                currentConfig.mobileMode = e.target.checked;
            };
        } else {
            // If the toggle isn't present, preserve existing value in state
            currentConfig.mobileMode = currentConfig.mobileMode === true;
        }

        // Track HI/SDH exclusion toggles (keep both in sync)
        const hiExcludeToggle = document.getElementById('excludeHearingImpairedSubtitles');
        const hiExcludeToggleNoTranslation = document.getElementById('excludeHearingImpairedSubtitlesNoTranslation');
        const syncHiExclude = (value) => {
            currentConfig.excludeHearingImpairedSubtitles = value === true;
            if (hiExcludeToggle && hiExcludeToggle.checked !== currentConfig.excludeHearingImpairedSubtitles) {
                hiExcludeToggle.checked = currentConfig.excludeHearingImpairedSubtitles;
            }
            if (hiExcludeToggleNoTranslation && hiExcludeToggleNoTranslation.checked !== currentConfig.excludeHearingImpairedSubtitles) {
                hiExcludeToggleNoTranslation.checked = currentConfig.excludeHearingImpairedSubtitles;
            }
        };
        if (hiExcludeToggle) {
            hiExcludeToggle.onchange = (e) => syncHiExclude(e.target.checked === true);
        }
        if (hiExcludeToggleNoTranslation) {
            hiExcludeToggleNoTranslation.onchange = (e) => syncHiExclude(e.target.checked === true);
        }
        if (!hiExcludeToggle && !hiExcludeToggleNoTranslation) {
            currentConfig.excludeHearingImpairedSubtitles = currentConfig.excludeHearingImpairedSubtitles === true;
        }

        // Track Season Pack toggles (keep both in sync)
        const seasonPackToggle = document.getElementById('enableSeasonPacks');
        const seasonPackToggleNoTranslation = document.getElementById('enableSeasonPacksNoTranslation');
        const syncSeasonPack = (value) => {
            currentConfig.enableSeasonPacks = value !== false; // Default to true
            if (seasonPackToggle && seasonPackToggle.checked !== currentConfig.enableSeasonPacks) {
                seasonPackToggle.checked = currentConfig.enableSeasonPacks;
            }
            if (seasonPackToggleNoTranslation && seasonPackToggleNoTranslation.checked !== currentConfig.enableSeasonPacks) {
                seasonPackToggleNoTranslation.checked = currentConfig.enableSeasonPacks;
            }
        };
        if (seasonPackToggle) {
            seasonPackToggle.onchange = (e) => syncSeasonPack(e.target.checked);
        }
        if (seasonPackToggleNoTranslation) {
            seasonPackToggleNoTranslation.onchange = (e) => syncSeasonPack(e.target.checked);
        }
        if (!seasonPackToggle && !seasonPackToggleNoTranslation) {
            currentConfig.enableSeasonPacks = currentConfig.enableSeasonPacks !== false;
        }

        // Track Force SRT toggles (keep both in sync)
        const forceSRTToggle = document.getElementById('forceSRTOutput');
        const forceSRTToggleNoTranslation = document.getElementById('forceSRTOutputNoTranslation');
        const syncForceSRT = (value) => {
            currentConfig.forceSRTOutput = value === true;
            if (forceSRTToggle && forceSRTToggle.checked !== currentConfig.forceSRTOutput) {
                forceSRTToggle.checked = currentConfig.forceSRTOutput;
            }
            if (forceSRTToggleNoTranslation && forceSRTToggleNoTranslation.checked !== currentConfig.forceSRTOutput) {
                forceSRTToggleNoTranslation.checked = currentConfig.forceSRTOutput;
            }
            // Force SRT implies ASS/SSA conversion → passthrough OFF
            const convertAssEl = document.getElementById('convertAssToVtt');
            if (convertAssEl) {
                if (currentConfig.forceSRTOutput) {
                    convertAssEl.disabled = true;
                    convertAssEl.checked = false; // Force SRT → passthrough OFF
                } else {
                    convertAssEl.disabled = false;
                }
            }
            syncUrlExtensionTestModeUi({ rememberCheckedSelection: true });
            toggleUrlExtensionTestGroup();
        };
        if (forceSRTToggle) {
            forceSRTToggle.onchange = (e) => syncForceSRT(e.target.checked);
        }
        if (forceSRTToggleNoTranslation) {
            forceSRTToggleNoTranslation.onchange = (e) => syncForceSRT(e.target.checked);
        }
        const singleBatchToggle = document.getElementById('singleBatchMode');
        if (singleBatchToggle) {
            singleBatchToggle.onchange = (e) => {
                currentConfig.singleBatchMode = e.target.checked === true;
                updateBypassCacheForAdvancedSettings();
            };
        }

        const parallelBatchesEl = document.getElementById('parallelBatchesEnabled');
        if (parallelBatchesEl) {
            parallelBatchesEl.checked = currentConfig.parallelBatchesEnabled === true;
            const countGroup = document.getElementById('parallelBatchesCountGroup');
            if (countGroup) countGroup.style.display = parallelBatchesEl.checked ? 'block' : 'none';
        }
        const parallelBatchesCountEl = document.getElementById('parallelBatchesCount');
        if (parallelBatchesCountEl) {
            parallelBatchesCountEl.value = currentConfig.parallelBatchesCount || 3;
        }
    }

    async function handleSubmit(e) {
        if (e && typeof e.preventDefault === 'function') {
            e.preventDefault();
        }
        return await saveCurrentConfig();
    }

    async function saveCurrentConfig(options = {}) {
        ensureProvidersInState();
        ensureAutoSubsDefaults();

        // Sync mobile mode state into currentConfig before building payload
        try {
            const mobileToggle = document.getElementById('mobileMode');
            if (mobileToggle) {
                currentConfig.mobileMode = mobileToggle.checked;
            }
        } catch (_) { }

        const promptStyle = document.getElementById('promptStyle').value;
        let translationPrompt = '';
        const singleBatchEnabled = (function () {
            const el = document.getElementById('singleBatchMode');
            if (el) return el.checked === true;
            return currentConfig?.singleBatchMode === true;
        })();
        const hasActiveMultiProvider = isMultiProviderActiveInForm();
        const multiProviderToggleChecked = document.getElementById('enableMultiProviders')?.checked === true;

        const isBypassRequested = () => {
            const advSettingsModified = areAdvancedSettingsModified();
            const databaseModeEl = document.getElementById('databaseMode');
            const userSelectedBypass = databaseModeEl ? databaseModeEl.value === 'bypass' : false;
            return advSettingsModified || userSelectedBypass || hasActiveMultiProvider;
        };

        // Determine the translation prompt based on style
        if (promptStyle === 'strict') {
            translationPrompt = STRICT_TRANSLATION_PROMPT;
        } else if (promptStyle === 'natural') {
            translationPrompt = NATURAL_TRANSLATION_PROMPT;
        }


        const config = {
            noTranslationMode: currentConfig.noTranslationMode,
            noTranslationLanguages: currentConfig.noTranslationLanguages,
            uiLanguage: (currentConfig.uiLanguage || (navigator.language || 'en')).toString().toLowerCase(),
            geminiApiKey: document.getElementById('geminiApiKey').value.trim(),
            geminiKeyRotationEnabled: document.getElementById('geminiKeyRotationEnabled')?.checked === true,
            geminiApiKeys: getGeminiApiKeys(),
            geminiKeyRotationMode: document.getElementById('geminiKeyRotationMode')?.value || 'per-batch',
            assemblyAiApiKey: (function () { const el = document.getElementById('assemblyAiApiKey'); return el ? el.value.trim() : ''; })(),
            cloudflareWorkersApiKey: (function () { const el = document.getElementById('cloudflareWorkersApiKey'); return el ? el.value.trim() : ''; })(),
            otherApiKeysEnabled: isSubToolboxEnabled(),
            autoSubs: {
                ...currentConfig.autoSubs,
                defaultMode: currentConfig.autoSubs?.defaultMode || 'cloudflare',
                sendFullVideoToAssembly: currentConfig.autoSubs?.sendFullVideoToAssembly === true,
                assemblySpeechModel: currentConfig.autoSubs?.assemblySpeechModel || 'universal-3-pro'
            },
            // Save the selected model from the dropdown
            // Advanced settings can override this if enabled
            geminiModel: (function () {
                const el = document.getElementById('geminiModel');
                return normalizeGeminiModelForBaseSelect(el ? el.value : '');
            })(),
            promptStyle: promptStyle,
            translationPrompt: translationPrompt,
            betaModeEnabled: isBetaModeEnabled(),
            devMode: (function () { const el = document.getElementById('devMode'); return el ? el.checked : false; })(),
            urlExtensionTest: (function () {
                // When ASS passthrough is enabled, force 'none' to avoid extension/payload mismatch
                const convertAssEl = document.getElementById('convertAssToVtt');
                const assPassthroughEnabled = convertAssEl && convertAssEl.checked;
                if (assPassthroughEnabled) {
                    return 'none'; // ASS content can't use .srt extension
                }
                // Only include dev extension test if devMode is enabled.
                // Supported values: srt (default), sub (A), none (B), resolve (C).
                const devEl = document.getElementById('devMode');
                if (devEl && devEl.checked) {
                    const selected = document.querySelector('input[name="urlExtensionTest"]:checked');
                    return selected ? selected.value : 'srt';
                }
                return 'srt'; // Default behavior
            })(),
            androidSubtitleCompatMode: (function () {
                // Dev-mode-only debug mode for Android subtitle compatibility tests.
                const devEl = document.getElementById('devMode');
                if (devEl && devEl.checked) {
                    const selected = document.querySelector('input[name="androidSubtitleCompatMode"]:checked');
                    const value = selected ? String(selected.value || '').toLowerCase() : 'off';
                    if (value === 'safe' || value === 'aggressive') return value;
                }
                return 'off';
            })(),
            sourceLanguages: currentConfig.sourceLanguages,
            targetLanguages: currentConfig.targetLanguages,
            learnMode: currentConfig.learnMode === true,
            learnTargetLanguages: currentConfig.learnTargetLanguages || [],
            learnOrder: currentConfig.learnOrder || 'source-top',
            learnPlacement: 'top', // Force top-of-screen placement
            learnItalic: currentConfig.learnItalic !== false,
            learnItalicTarget: currentConfig.learnItalicTarget || 'target',
            multiProviderEnabled: multiProviderToggleChecked,
            mainProvider: (document.getElementById('mainProviderSelect')?.value || 'gemini'),
            secondaryProviderEnabled: document.getElementById('enableSecondaryProvider')?.checked || false,
            secondaryProvider: (document.getElementById('secondaryProviderSelect')?.value || ''),
            providers: getProvidersFromForm(),
            providerParameters: getProviderParametersFromForm(),
            subtitleProviders: {
                opensubtitles: {
                    enabled: document.getElementById('enableOpenSubtitles').checked,
                    implementationType: document.querySelector('input[name="opensubtitlesImplementation"]:checked')?.value || 'v3',
                    username: document.getElementById('opensubtitlesUsername').value.trim(),
                    password: document.getElementById('opensubtitlesPassword').value.trim()
                },
                subdl: {
                    enabled: document.getElementById('enableSubDL').checked,
                    apiKey: document.getElementById('subdlApiKey').value.trim()
                },
                subsource: {
                    enabled: document.getElementById('enableSubSource').checked,
                    apiKey: document.getElementById('subsourceApiKey').value.trim()
                },
                scs: {
                    enabled: document.getElementById('enableSCS')?.checked || false
                },
                wyzie: {
                    enabled: document.getElementById('enableWyzie')?.checked || false,
                    sources: {
                        opensubtitles: document.getElementById('wyzieSourceOpensubtitles')?.checked === true,
                        subf2m: document.getElementById('wyzieSourceSubf2m')?.checked === true,
                        subdl: document.getElementById('wyzieSourceSubdl')?.checked === true,
                        podnapisi: document.getElementById('wyzieSourcePodnapisi')?.checked === true,
                        gestdown: document.getElementById('wyzieSourceGestdown')?.checked === true,
                        animetosho: document.getElementById('wyzieSourceAnimetosho')?.checked === true,
                        kitsunekko: document.getElementById('wyzieSourceKitsunekko')?.checked === true,
                        jimaku: document.getElementById('wyzieSourceJimaku')?.checked === true,
                        yify: document.getElementById('wyzieSourceYify')?.checked === true
                    }
                },
                subsro: {
                    enabled: document.getElementById('enableSubsRo')?.checked || false,
                    apiKey: document.getElementById('subsroApiKey')?.value?.trim() || ''
                }
            },
            // Subtitle provider timeout (clamp to 8-30 range)
            subtitleProviderTimeout: Math.max(8, Math.min(30, parseInt(document.getElementById('subtitleProviderTimeout')?.value, 10) || 12)),
            translationCache: {
                enabled: !isBypassRequested(), // Enabled when NOT in bypass mode
                duration: 0,
                persistent: true
            },
            bypassCache: isBypassRequested(),
            bypassCacheConfig: {
                enabled: isBypassRequested(),
                duration: 12
            },
            tempCache: { // Deprecated: kept for backward compatibility
                enabled: isBypassRequested(),
                duration: 12
            },
            excludeHearingImpairedSubtitles: (function () {
                const el = document.getElementById('excludeHearingImpairedSubtitlesNoTranslation') || document.getElementById('excludeHearingImpairedSubtitles');
                return el ? el.checked === true : (currentConfig?.excludeHearingImpairedSubtitles === true);
            })(),
            enableSeasonPacks: (function () {
                const el = document.getElementById('enableSeasonPacksNoTranslation') || document.getElementById('enableSeasonPacks');
                // Default to true if element not found (backwards compatible)
                return el ? el.checked : (currentConfig?.enableSeasonPacks !== false);
            })(),
            forceSRTOutput: (function () {
                const el = document.getElementById('forceSRTOutputNoTranslation') || document.getElementById('forceSRTOutput');
                return el ? el.checked === true : (currentConfig?.forceSRTOutput === true);
            })(),
            convertAssToVtt: (function () {
                const el = document.getElementById('convertAssToVtt');
                // Checkbox represents passthrough; stored config keeps convertAssToVtt.
                // Default to true if element not found (backwards compatible)
                return el ? !el.checked : (currentConfig?.convertAssToVtt !== false);
            })(),
            subToolboxEnabled: (function () {
                const el = document.getElementById('subToolboxEnabledNoTranslation') || document.getElementById('subToolboxEnabled');
                return el ? el.checked : (currentConfig?.subToolboxEnabled === true);
            })(),
            fileTranslationEnabled: (function () {
                const el = document.getElementById('subToolboxEnabledNoTranslation') || document.getElementById('subToolboxEnabled');
                return el ? el.checked : (currentConfig?.fileTranslationEnabled === true);
            })(),
            syncSubtitlesEnabled: (function () {
                const el = document.getElementById('subToolboxEnabledNoTranslation') || document.getElementById('subToolboxEnabled');
                return el ? el.checked : (currentConfig?.syncSubtitlesEnabled === true);
            })(),
            mobileMode: (function () {
                const el = document.getElementById('mobileMode');
                if (el) return el.checked;
                return currentConfig?.mobileMode === true;
            })(),
            singleBatchMode: singleBatchEnabled,
            parallelBatchesEnabled: (function () { const el = document.getElementById('parallelBatchesEnabled'); return el ? el.checked === true : false; })(),
            parallelBatchesCount: (function () { const el = document.getElementById('parallelBatchesCount'); return el ? parseInt(el.value, 10) : 3; })(),
            advancedSettings: {
                enabled: areAdvancedSettingsModified(), // Auto-detect if any setting differs from defaults
                geminiModel: (function () { const el = document.getElementById('advancedModel'); return el ? el.value : ''; })(),
                thinkingBudget: (function () { const el = document.getElementById('advancedThinkingBudget'); return el ? parseInt(el.value) : 0; })(),
                temperature: (function () { const el = document.getElementById('advancedTemperature'); return el ? parseFloat(el.value) : 0.8; })(),
                topP: (function () { const el = document.getElementById('advancedTopP'); return el ? parseFloat(el.value) : 0.95; })(),
                topK: 40, // Keep default topK
                enableBatchContext: (function () { const el = document.getElementById('enableBatchContext'); return el ? el.checked : false; })(),
                contextSize: (function () { const el = document.getElementById('contextSize'); return el ? parseInt(el.value) : 8; })(),
                translationWorkflow: getSelectedTranslationWorkflow('xml'),
                mismatchRetries: (function () { const el = document.getElementById('mismatchRetries'); return el ? Math.max(0, Math.min(3, parseInt(el.value) || 1)) : 1; })()
            }
        };
        config.multiProviderEnabled = multiProviderToggleChecked;
        if (!config.multiProviderEnabled) {
            config.mainProvider = 'gemini';
            config.secondaryProviderEnabled = false;
            config.secondaryProvider = '';
        } else if (!config.secondaryProviderEnabled) {
            config.secondaryProvider = '';
        }
        config.mainProvider = String(config.mainProvider || 'gemini').toLowerCase();
        config.secondaryProvider = config.secondaryProviderEnabled ? String(config.secondaryProvider || '').toLowerCase() : '';

        // Validation with visual feedback - collect all errors
        const errors = [];


        const anyProviderEnabled = Object.values(config.subtitleProviders).some(p => p.enabled);
        if (!anyProviderEnabled) {
            errors.push(tConfig('config.validation.subtitleProviderRequired', {}, '⚠️ Please enable at least one subtitle provider'));
        }


        // Database mode dropdown validation (always valid - dropdown must have a value)
        // No need to validate since dropdown always has a selected value

        // Validate enabled subtitle sources have API keys (where required)
        if (config.subtitleProviders.subdl?.enabled && !config.subtitleProviders.subdl.apiKey?.trim()) {
            errors.push(tConfig('config.validation.subdlKeyRequired', {}, '⚠️ SubDL is enabled but API key is missing'));
        }
        if (config.subtitleProviders.subsource?.enabled && !config.subtitleProviders.subsource.apiKey?.trim()) {
            errors.push(tConfig('config.validation.subsourceKeyRequired', {}, '⚠️ SubSource is enabled but API key is missing'));
        }
        if (config.subtitleProviders.subsro?.enabled && !config.subtitleProviders.subsro.apiKey?.trim()) {
            errors.push(tConfig('config.validation.subsroKeyRequired', {}, '⚠️ Subs.ro is enabled but API key is missing'));
        }

        // Validate that every enabled AI provider has an API key
        Object.entries(config.providers || {}).forEach(([providerKey, providerCfg]) => {
            const optionalKey = KEY_OPTIONAL_PROVIDERS.has(String(providerKey).toLowerCase());
            if (providerCfg?.enabled && !optionalKey && !providerCfg.apiKey?.trim()) {
                const label = PROVIDERS[providerKey]?.label || providerKey;
                errors.push(tConfig('config.validation.providerKeyMissing', { provider: label }, `⚠️ ${label} is enabled but API key is missing`));
            }
        });

        // OpenSubtitles Auth requires credentials; block save if missing
        const openSubCfg = config.subtitleProviders.opensubtitles;
        const usingOpenSubsAuth = openSubCfg?.enabled && openSubCfg.implementationType === 'auth';
        if (usingOpenSubsAuth && (!openSubCfg.username || !openSubCfg.password)) {
            errors.push(tConfig('config.validation.opensubsAuthCredentials', {}, '⚠️ OpenSubtitles Auth requires both username and password. Enter credentials or switch to V3 (no login needed).'));
        }

        // If not in no-translation mode, validate AI provider and languages
        if (!config.noTranslationMode) {
            const multiEnabled = config.multiProviderEnabled === true;
            const mainProvider = config.mainProvider || 'gemini';
            const providerIsConfigured = (key) => {
                const cfg = config.providers?.[key];
                if (!cfg || cfg.enabled !== true) return false;
                const keyOptional = KEY_OPTIONAL_PROVIDERS.has(String(key).toLowerCase());
                if (keyOptional) {
                    return !!cfg.model;
                }
                return !!(cfg.apiKey && cfg.apiKey.trim() !== '' && cfg.model);
            };
            const geminiConfigured = (() => {
                const hasModel = !!(config.geminiModel && config.geminiModel.trim() !== '');
                if (!hasModel) return false;
                // When rotation is enabled, check the keys array
                if (config.geminiKeyRotationEnabled === true) {
                    const keys = Array.isArray(config.geminiApiKeys)
                        ? config.geminiApiKeys.filter(k => typeof k === 'string' && k.trim() !== '')
                        : [];
                    return keys.length > 0;
                }
                // Single key mode
                return !!(config.geminiApiKey && config.geminiApiKey.trim() !== '');
            })();
            const configuredProviders = new Set();
            if (geminiConfigured) configuredProviders.add('gemini');
            Object.keys(config.providers || {}).forEach(key => {
                if (providerIsConfigured(key)) {
                    configuredProviders.add(String(key).toLowerCase());
                }
            });

            if (!mainProvider) {
                errors.push(tConfig('config.validation.mainProviderRequired', {}, '⚠️ Select a Main Provider'));
            } else if (mainProvider === 'gemini') {
                if (!validateGeminiApiKey(true)) {
                    errors.push(tConfig('config.validation.geminiKeyRequired', {}, '⚠️ Gemini API key is required'));
                }

                if (!validateGeminiModel()) {
                    errors.push(tConfig('config.validation.geminiModelRequired', {}, '⚠️ Please select a Gemini model'));
                }
            } else {
                const providerCfg = config.providers?.[mainProvider];
                if (!providerCfg || !providerCfg.enabled) {
                    errors.push(tConfig('config.validation.mainProviderEnable', { provider: PROVIDERS[mainProvider]?.label || mainProvider }, `⚠️ Enable ${PROVIDERS[mainProvider]?.label || mainProvider} to use it as Main Provider`));
                }
                const keyOptional = KEY_OPTIONAL_PROVIDERS.has(String(mainProvider).toLowerCase());
                if (!keyOptional && (!providerCfg || !providerCfg.apiKey?.trim())) {
                    errors.push(tConfig('config.validation.mainProviderKeyRequired', { provider: PROVIDERS[mainProvider]?.label || mainProvider }, `⚠️ API key required for ${PROVIDERS[mainProvider]?.label || mainProvider}`));
                }
                if (!providerCfg || !providerCfg.model) {
                    errors.push(tConfig('config.validation.mainProviderModelRequired', { provider: PROVIDERS[mainProvider]?.label || mainProvider }, `⚠️ Select a model for ${PROVIDERS[mainProvider]?.label || mainProvider}`));
                }
            }

            if (multiEnabled && config.secondaryProviderEnabled) {
                const secondaryKey = config.secondaryProvider;
                if (!secondaryKey) {
                    errors.push(tConfig('config.validation.secondaryProviderRequired', {}, '⚠️ Select a Secondary Provider or disable the fallback toggle'));
                } else if (secondaryKey === mainProvider) {
                    errors.push(tConfig('config.validation.secondaryProviderDifferent', {}, '⚠️ Secondary Provider must be different from Main Provider'));
                } else if (secondaryKey === 'gemini') {
                    if (!validateGeminiApiKey(true)) {
                        errors.push(tConfig('config.validation.secondaryGeminiKey', {}, '⚠️ Gemini API key is required when Gemini is the Secondary Provider'));
                    }
                    if (!validateGeminiModel()) {
                        errors.push(tConfig('config.validation.secondaryGeminiModel', {}, '⚠️ Please select a Gemini model for the Secondary Provider'));
                    }
                    if (!geminiConfigured) {
                        errors.push(tConfig('config.validation.secondaryGeminiConfigured', {}, '⚠️ Gemini must have a valid API key and model when selected as Secondary Provider'));
                    }
                } else {
                    const secondaryCfg = config.providers?.[secondaryKey];
                    if (!secondaryCfg || !secondaryCfg.enabled) {
                        errors.push(tConfig('config.validation.secondaryProviderEnable', { provider: PROVIDERS[secondaryKey]?.label || secondaryKey }, `⚠️ Enable ${PROVIDERS[secondaryKey]?.label || secondaryKey} to use it as Secondary Provider`));
                    }
                    const keyOptional = KEY_OPTIONAL_PROVIDERS.has(String(secondaryKey).toLowerCase());
                    if (!keyOptional && (!secondaryCfg || !secondaryCfg.apiKey)) {
                        errors.push(tConfig('config.validation.secondaryProviderKey', { provider: PROVIDERS[secondaryKey]?.label || secondaryKey }, `⚠️ API key required for ${PROVIDERS[secondaryKey]?.label || secondaryKey} (Secondary Provider)`));
                    }
                    if (!secondaryCfg || !secondaryCfg.model) {
                        errors.push(tConfig('config.validation.secondaryProviderModel', { provider: PROVIDERS[secondaryKey]?.label || secondaryKey }, `⚠️ Select a model for ${PROVIDERS[secondaryKey]?.label || secondaryKey} (Secondary Provider)`));
                    }
                }
            }

            if (configuredProviders.size === 0) {
                errors.push(tConfig('config.validation.providersMinimum', {}, '⚠️ Add at least one AI provider and enable it (API key required unless provider is keyless)'));
            }

            if (config.secondaryProviderEnabled && configuredProviders.size < 2) {
                errors.push(tConfig('config.validation.secondaryProvidersCount', {}, '⚠️ Secondary Provider requires two configured AI providers (main and fallback)'));
            }

            if (!validateLanguageSelection('source')) {
                errors.push(`⚠️ ${tConfig('config.validation.sourceRange', { min: 1, max: MAX_SOURCE_LANGUAGES }, `Please select 1-${MAX_SOURCE_LANGUAGES} source languages`)}`);
            }

            if (!validateLanguageSelection('target')) {
                errors.push(`⚠️ ${tConfig('config.validation.targetLimitShort', { limit: MAX_TARGET_LANGUAGES }, `Please select between 1 and ${MAX_TARGET_LANGUAGES} target languages (including Learn Mode)`)}`);
            }

            if (config.learnMode && !validateLanguageSelection('learn')) {
                errors.push(`⚠️ ${tConfig('config.validation.learnRequired', {}, 'Learn Mode requires at least one target language')}`);
            }
        } else {
            // In no-translation mode, validate language count bounds
            const noTranslationError = document.getElementById('noTranslationLanguagesError');

            if (!config.noTranslationLanguages || config.noTranslationLanguages.length === 0) {
                errors.push(`⚠️ ${tConfig('config.validation.noTranslationRequired', {}, 'Please select at least one language for Just Fetch mode')}`);
                if (noTranslationError) {
                    noTranslationError.textContent = tConfig('config.validation.noTranslationRequired', {}, 'Please select at least one language for Just Fetch mode');
                    noTranslationError.classList.add('show');
                }
            } else if (config.noTranslationLanguages.length > MAX_NO_TRANSLATION_LANGUAGES) {
                errors.push(`⚠️ ${tConfig('config.validation.noTranslationLimitShort', { limit: MAX_NO_TRANSLATION_LANGUAGES }, `Please select up to ${MAX_NO_TRANSLATION_LANGUAGES} languages in no-translation mode`)}`);
                if (noTranslationError) {
                    noTranslationError.textContent = tConfig('config.validation.noTranslationLimitShort', { limit: MAX_NO_TRANSLATION_LANGUAGES }, `Please select up to ${MAX_NO_TRANSLATION_LANGUAGES} languages for Just Fetch mode`);
                    noTranslationError.classList.add('show');
                }
            } else if (noTranslationError) {
                noTranslationError.textContent = '';
                noTranslationError.classList.remove('show');
            }
        }


        if (errors.length > 0) {
            // Show all errors as a single alert
            const errorMessage = errors.join('<br>');

            showAlert(errorMessage, 'error');

            // Focus on first invalid field
            if (!config.noTranslationMode) {
                const mainProvider = config.mainProvider || 'gemini';
                if (mainProvider === 'gemini') {
                    if (!validateGeminiApiKey()) {
                        document.getElementById('geminiApiKey')?.focus();
                    } else if (!validateGeminiModel()) {
                        document.getElementById('geminiModel')?.focus();
                    }
                } else {
                    const keyInput = document.getElementById(`provider-${mainProvider}-key`);
                    const modelSelect = document.getElementById(`provider-${mainProvider}-model`);
                    if (keyInput && (!config.providers?.[mainProvider]?.apiKey)) {
                        keyInput.focus();
                    } else if (modelSelect) {
                        modelSelect.focus();
                    }
                }
            }
            return false;
        }

        const approvedVictimTokens = Array.isArray(options.approvedVictimTokens)
            ? options.approvedVictimTokens.filter(isValidSessionToken)
            : [];
        const afterSuccess = typeof options.afterSuccess === 'function' ? options.afterSuccess : null;

        // Save against the token the page is actually editing, not stale browser storage.
        let existingToken = resolveSaveTargetToken({
            activeSessionToken: activeSessionContext.token,
            activeProvenance: activeSessionContext.provenance,
            urlSessionToken: getUrlSessionToken(),
            persistentSessionToken: getStoredSessionToken()
        }) || null;
        if (!existingToken && approvedVictimTokens.length === 0) {
            const overflowVictims = getDraftOverflowVictims();
            if (overflowVictims.length > 0) {
                const victimNoun = overflowVictims.length === 1 ? 'entry' : 'entries';
                openTokenVaultOverridePrompt({
                    eyebrow: `${TOKEN_VAULT_MAX_ENTRIES} saved tokens max`,
                    title: 'Saving this draft needs one vault slot',
                    message: `SubMaker keeps up to ${TOKEN_VAULT_MAX_ENTRIES} saved tokens in this browser. Saving this draft will purge the oldest local vault ${victimNoun} below.`,
                    detail: 'Only the local browser vault changes. The purged token is not deleted from the server.',
                    confirmLabel: 'Save and replace',
                    victims: overflowVictims,
                    onConfirm: async () => {
                        await saveCurrentConfig({
                            ...options,
                            approvedVictimTokens: overflowVictims.map(entry => entry.token)
                        });
                    }
                });
                return false;
            }
        }
        let configToken;
        let isUpdate = false;
        let responseSession = null;


        try {
            if (existingToken) {
                // Validate token format before attempting update (session tokens only)
                const isValidTokenFormat = isValidSessionToken(existingToken);

                if (!isValidTokenFormat) {
                    localStorage.removeItem(TOKEN_KEY);
                    existingToken = null;
                } else {
                    // Try to update existing session first
                    try {
                        const encodedToken = encodeURIComponent(existingToken);
                        const updateResponse = await fetchWithTimeout(`/api/update-session/${encodedToken}`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify(config)
                        }, 10000);

                        // FIXED: Better error handling for different response codes
                        if (updateResponse.status === 404 || updateResponse.status === 410) {
                            // Token not found or expired - create new session
                            showAlert(tConfig('config.alerts.sessionExpiredCreating', {}, 'Session expired. Creating new session...'), 'info', 'config.alerts.sessionExpiredCreating', {});
                            localStorage.removeItem(TOKEN_KEY);
                            existingToken = null;
                        } else if (updateResponse.status === 503) {
                            showAlert(tConfig('config.alerts.sessionStorageUnavailable', {}, 'Session storage is temporarily unavailable. Please retry in a moment.'), 'warning', 'config.alerts.sessionStorageUnavailable', {});
                            return false;
                        } else if (!updateResponse.ok) {
                            const errorText = await updateResponse.text();
                            const reason = errorText && errorText.trim() ? errorText.trim() : `HTTP ${updateResponse.status}`;
                            showAlert(tConfig('config.alerts.sessionUpdateRetry', { reason }, 'Failed to update the current session. Please retry instead of creating a new one. Reason: ' + reason), 'error', 'config.alerts.sessionUpdateRetry', { reason });
                            return false;
                        } else {
                            // Success
                            const sessionData = await updateResponse.json();
                            configToken = sessionData.token;
                            isUpdate = sessionData.updated;
                            responseSession = sessionData.session || null;

                            if (sessionData.updated) {
                                showAlert(tConfig('config.alerts.configurationUpdated', {}, 'Configuration updated! Changes will take effect immediately in Stremio.'), 'success', 'config.alerts.configurationUpdated', {});
                            } else if (sessionData.created) {
                                // Token was expired, new one created
                                showAlert(tConfig('config.alerts.sessionExpiredCreated', {}, 'Session expired. Created new session - please reinstall addon in Stremio.'), 'warning', 'config.alerts.sessionExpiredCreated', {});
                                localStorage.setItem(TOKEN_KEY, configToken);
                            }
                        }
                    } catch (updateError) {
                        showAlert(tConfig('config.alerts.sessionNetworkRetry', {}, 'Network error updating session. Please retry; your current session token was kept.'), 'warning', 'config.alerts.sessionNetworkRetry', {});
                        return false;
                    }
                }
            }

            // If we don't have a valid token, create new session
            if (!existingToken) {

                try {
                    const createResponse = await fetchWithTimeout('/api/create-session', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(config)
                    }, 10000);


                    if (!createResponse.ok) {
                        const errorText = await createResponse.text();
                        throw new Error(`Failed to create session (${createResponse.status}): ${errorText}`);
                    }

                    const sessionData = await createResponse.json();

                    // FIXED: Validate response token format
                    if (!sessionData.token || !/^[a-f0-9]{32}$/.test(sessionData.token)) {
                        throw new Error('Server returned invalid session token format');
                    }

                    configToken = sessionData.token;
                    isUpdate = false;
                    responseSession = sessionData.session || null;
                } catch (createError) {
                    showAlert(tConfig('config.alerts.saveFailed', { reason: createError.message }, 'Failed to save configuration: ' + createError.message), 'error', 'config.alerts.saveFailed', { reason: createError.message });
                    return false;
                }
            }

            // FIXED: Validate token before storing
            if (!configToken || !/^[a-f0-9]{32}$/.test(configToken)) {
                throw new Error('Invalid token received from server');
            }

            // Store token for future updates (only if valid)
            localStorage.setItem(TOKEN_KEY, configToken);
        } catch (error) {
            showAlert(tConfig('config.alerts.saveFailed', { reason: error.message }, 'Failed to save configuration: ' + error.message), 'error', 'config.alerts.saveFailed', { reason: error.message });
            return false;
        }

        // Save to current config
        currentConfig = config;
        isFirstRun = false;

        // Cache the configuration to localStorage
        saveConfigToCache(config, configToken);
        setActiveSessionContext({
            token: configToken,
            provenance: isUpdate ? 'saved' : 'created',
            sourceLabel: isUpdate ? 'Updated live token' : 'Created on save',
            message: isUpdate
                ? 'This page is using your updated token.'
                : 'A fresh token was created and is now active.',
            session: responseSession,
            recoveredFromToken: '',
            regenerated: false
        });
        syncConfigUrlForToken(configToken);
        if (document.getElementById('tokenVaultModal')?.classList.contains('show')) {
            renderTokenVault();
        }
        updateToolboxLauncherVisibility(configToken);
        updateQuickStats();
        setConfigDirty(false);
        revealActiveInstallState(configToken, { selectDisplay: true });

        // Show appropriate message based on update vs new install
        if (!isUpdate) {
            showAlert(tConfig('config.alerts.configurationSaved', {}, 'Configuration saved! You can now install the addon in Stremio.'), 'success', 'config.alerts.configurationSaved', {});
        }
        const persistedToVault = persistSavedTokenToVault(configToken, responseSession, {
            approvedVictimTokens,
            afterResolve: afterSuccess
        });
        if (persistedToVault) {
            renderTokenVault();
            if (afterSuccess) {
                await afterSuccess();
            }
        }
        return true;
    }

    function installAddon() {
        if (window.installUrl) {
            // installUrl is in format: http(s)://host/addon/{config}/manifest.json
            // Preserve any percent-encoding so Stremio receives a URL-safe config token
            const stremioUrl = window.installUrl.replace(/^https?:\/\//i, 'stremio://');
            window.location.href = stremioUrl;
            showAlert(tConfig('config.alerts.openingStremio', {}, 'Opening Stremio...'), 'info', 'config.alerts.openingStremio', {});
        }
    }

    async function copyInstallUrl() {
        if (window.installUrl) {
            try {
                await navigator.clipboard.writeText(window.installUrl);
                showAlert(tConfig('config.alerts.installUrlCopied', {}, 'Install URL copied to clipboard!'), 'success', 'config.alerts.installUrlCopied', {});
            } catch (error) {
                // Fallback
                const input = document.createElement('input');
                input.value = window.installUrl;
                document.body.appendChild(input);
                input.select();
                document.execCommand('copy');
                document.body.removeChild(input);
                showAlert(tConfig('config.alerts.installUrlCopied', {}, 'Install URL copied to clipboard!'), 'success', 'config.alerts.installUrlCopied', {});
            }
        }
    }

    function getAlertContainer() {
        let container = document.getElementById('alertContainer');
        if (!container) {
            container = document.createElement('div');
            container.id = 'alertContainer';
        }
        // Keep alerts at the document root so modal stacking contexts cannot cover them.
        if (document.body && container.parentElement !== document.body) {
            document.body.appendChild(container);
        }
        return container;
    }

    function showAlert(message, type = 'success', i18nKey = '', i18nVars = {}) {
        const container = getAlertContainer();

        // Remove existing alerts
        container.innerHTML = '';

        const alert = document.createElement('div');
        alert.className = `alert alert-${type}`;

        const icon = {
            success: '✓',
            error: '✗',
            warning: '⚠',
            info: 'ℹ'
        }[type] || 'ℹ';

        alert.setAttribute('data-i18n', i18nKey || '');
        if (i18nKey) {
            alert.setAttribute('data-i18n-vars', JSON.stringify(i18nVars || {}));
            alert.setAttribute('data-i18n-fallback', message || '');
        }

        const iconSpan = document.createElement('span');
        iconSpan.style.fontSize = '1.25rem';
        iconSpan.textContent = icon;

        const messageDiv = document.createElement('div');
        messageDiv.style.flex = '1';
        messageDiv.textContent = typeof message === 'string' ? message : String(message || '');

        alert.appendChild(iconSpan);
        alert.appendChild(messageDiv);

        container.appendChild(alert);
        const displayTime = 5000;

        setTimeout(() => {
            alert.style.animation = 'slideInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1) reverse';
            setTimeout(() => alert.remove(), 300);
        }, displayTime);
    }

    function showLoading(show) {
        const loading = document.getElementById('loadingOverlay');
        loading.classList.toggle('show', show);
    }

    // Compute vertical position of reset bar so it sits centered
    function positionResetBar() {
        try {
            const bar = document.getElementById('resetBarWrapper');
            const btns = document.querySelector('.btn-group');
            const footer = document.querySelector('.footer');
            if (!bar || !btns || !footer) return;

            // Temporarily remove margin to measure natural gap
            bar.style.marginTop = '0px';

            const btnRect = btns.getBoundingClientRect();
            const footerRect = footer.getBoundingClientRect();
            const barRect = bar.getBoundingClientRect();

            let gap = footerRect.top - btnRect.bottom; // space between buttons and footer
            // Fallback if negative/too small (small screens): just set small margin
            if (!isFinite(gap) || gap < 40) {
                bar.style.marginTop = '16px';
                return;
            }

            const desired = Math.max(12, (gap - barRect.height) / 2);
            bar.style.marginTop = desired + 'px';
        } catch (_) {
            // no-op
        }
    }

    function syncFloatingBottomSafeZone() {
        try {
            const root = document.documentElement;
            if (!root) return;

            const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
            if (!viewportHeight) {
                if (floatingBottomSafeZoneValue !== '0px') {
                    root.style.setProperty('--floating-bottom-safe-zone', '0px');
                    floatingBottomSafeZoneValue = '0px';
                }
                return;
            }

            let clearance = 0;
            [
                document.getElementById('configHelp'),
                document.getElementById('subToolboxLauncher'),
                document.getElementById('tokenVaultLauncher'),
                tokenVaultRailOpen ? document.getElementById('tokenVaultRail') : null
            ].forEach(el => {
                if (!el) return;

                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return;
                if (style.position !== 'fixed') return;

                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return;
                if (rect.bottom < (viewportHeight - 220)) return;

                clearance = Math.max(clearance, viewportHeight - rect.top);
            });

            const safeZone = clearance > 0 ? Math.ceil(clearance + 16) : 0;
            const nextValue = `${safeZone}px`;
            if (floatingBottomSafeZoneValue !== nextValue) {
                root.style.setProperty('--floating-bottom-safe-zone', nextValue);
                floatingBottomSafeZoneValue = nextValue;
            }
        } catch (_) {
            // no-op
        }
    }

    function debounce(fn, wait) {
        let t = null;
        return function (...args) {
            if (t) clearTimeout(t);
            t = setTimeout(() => fn.apply(this, args), wait);
        };
    }

    function closeResetConfirmModal() {
        const modal = document.getElementById('resetConfirmModal');
        if (modal) {
            modal.classList.remove('show');
            modal.style.display = 'none';
        }
    }

    function getCookiePathVariants(pathname) {
        const normalizedPath = String(pathname || '/').split(/[?#]/)[0].trim() || '/';
        const segments = normalizedPath.split('/').filter(Boolean);
        const variants = new Set(['/']);
        let current = '';
        segments.forEach(segment => {
            current += `/${segment}`;
            variants.add(current);
            variants.add(`${current}/`);
        });
        return Array.from(variants);
    }

    function getCookieDomainVariants(hostname) {
        const normalizedHost = String(hostname || '').trim().replace(/^\.+/, '');
        const variants = new Set(['']);
        if (!normalizedHost || normalizedHost === 'localhost' || normalizedHost.includes(':') || /^[\d.]+$/.test(normalizedHost)) {
            return Array.from(variants);
        }
        const parts = normalizedHost.split('.').filter(Boolean);
        for (let index = 0; index < parts.length - 1; index += 1) {
            const domain = parts.slice(index).join('.');
            variants.add(domain);
            variants.add(`.${domain}`);
        }
        return Array.from(variants);
    }

    function clearOriginCookies() {
        try {
            const cookieNames = Array.from(new Set(
                String(document.cookie || '')
                    .split(';')
                    .map(part => part.split('=')[0]?.trim())
                    .filter(Boolean)
            ));
            const pathVariants = getCookiePathVariants(window.location.pathname);
            const domainVariants = getCookieDomainVariants(window.location.hostname);
            cookieNames.forEach((name) => {
                pathVariants.forEach((path) => {
                    domainVariants.forEach((domain) => {
                        const domainAttr = domain ? `;domain=${domain}` : '';
                        document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;max-age=0;path=${path}${domainAttr}`;
                    });
                });
            });
        } catch (_) { }
    }

    async function clearOriginIndexedDbDatabases() {
        try {
            const dbApi = window.indexedDB;
            if (!dbApi || typeof dbApi.databases !== 'function') return;
            const databases = await dbApi.databases();
            await Promise.all((databases || []).map(db => {
                if (!db || !db.name) return Promise.resolve();
                return new Promise((resolve) => {
                    const request = dbApi.deleteDatabase(db.name);
                    request.onsuccess = request.onerror = request.onblocked = () => resolve();
                });
            }));
        } catch (_) { }
    }

    // Reset settings flow
    function openResetConfirm() {
        openModalById('resetConfirmModal');
    }

    async function performFullReset() {
        closeResetConfirmModal();
        showLoading(true);
        try {
            // Reset is intentionally browser-local: it forgets local token references and
            // site data here, but does not delete the backing server-side sessions.
            try {
                if (navigator.serviceWorker && navigator.serviceWorker.controller) {
                    navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_CACHE' });
                }
            } catch (_) { }

            try {
                if (window.caches && window.caches.keys) {
                    const names = await window.caches.keys();
                    await Promise.all(names.map(n => window.caches.delete(n).catch(() => { })));
                }
            } catch (_) { }

            try {
                if ('serviceWorker' in navigator) {
                    const regs = await navigator.serviceWorker.getRegistrations();
                    await Promise.all(regs.map(r => r.unregister().catch(() => { })));
                }
            } catch (_) { }

            await clearOriginIndexedDbDatabases();

            try { localStorage.clear(); } catch (_) { }
            try { sessionStorage.clear(); } catch (_) { }

            clearOriginCookies();
        } finally {
            window.location.replace(`/configure?reset=${Date.now()}`);
        }
    }

    // ── What's New Portal ────────────────────────────────────────────────
    const LAST_SEEN_VERSION_KEY = 'submaker_whats_new_seen';

    function initWhatsNewPortal() {
        const portal = document.getElementById('whatsNewPortal');
        const header = document.getElementById('portalHeader');
        const content = document.getElementById('portalContent');
        const entriesEl = document.getElementById('portalEntries');
        const badge = document.getElementById('portalVersionBadge');
        const newDot = document.getElementById('portalNewDot');
        if (!portal || !header || !entriesEl) return;

        try {
            const bootVersion = (typeof window !== 'undefined' && typeof window.__APP_VERSION__ === 'string')
                ? window.__APP_VERSION__.trim()
                : '';
            if (badge && bootVersion) {
                badge.textContent = 'v' + bootVersion;
            }
        } catch (_) { }

        fetch('/api/changelog')
            .then(r => r.json())
            .then(data => {
                if (!data || !data.entries || !data.entries.length) return;
                const { currentVersion, entries: versions } = data;

                // Version badge
                if (badge) badge.textContent = 'v' + currentVersion;

                // "New" dot logic
                let lastSeen = '';
                try { lastSeen = localStorage.getItem(LAST_SEEN_VERSION_KEY) || ''; } catch (_) { }
                const latestVersion = versions[0]?.version || '';
                if (lastSeen !== latestVersion && newDot) {
                    newDot.style.display = '';
                }

                // Render entries
                entriesEl.innerHTML = '';
                versions.forEach((entry, idx) => {
                    const card = document.createElement('div');
                    card.className = 'portal-entry' + (idx === 0 ? ' expanded' : '');

                    const headerEl = document.createElement('div');
                    headerEl.className = 'portal-entry-header';

                    const left = document.createElement('div');
                    left.style.cssText = 'display:flex;align-items:center;gap:0.4rem;';
                    const versionEl = document.createElement('span');
                    versionEl.className = 'portal-entry-version';
                    versionEl.textContent = 'v' + entry.version;
                    left.appendChild(versionEl);
                    if (idx === 0) {
                        const badgeEl = document.createElement('span');
                        badgeEl.className = 'portal-entry-badge latest';
                        badgeEl.textContent = 'Latest';
                        left.appendChild(badgeEl);
                    }
                    headerEl.appendChild(left);

                    const chevron = document.createElement('span');
                    chevron.className = 'portal-entry-chevron';
                    chevron.textContent = '▼';
                    headerEl.appendChild(chevron);

                    const contentEl = document.createElement('div');
                    contentEl.className = 'portal-entry-content';
                    contentEl.innerHTML = renderChangelogContent(entry.content);

                    // "View on GitHub" link (sibling of content, not child — avoids max-height clipping)
                    const ghLink = document.createElement('a');
                    ghLink.className = 'portal-gh-link';
                    ghLink.href = 'https://github.com/xtremexq/StremioSubMaker/releases/tag/v' + entry.version;
                    ghLink.target = '_blank';
                    ghLink.rel = 'noopener noreferrer';
                    ghLink.textContent = 'View full release on GitHub →';

                    headerEl.addEventListener('click', () => {
                        card.classList.toggle('expanded');
                    });

                    card.appendChild(headerEl);
                    card.appendChild(contentEl);
                    card.appendChild(ghLink);
                    entriesEl.appendChild(card);
                });

                // Portal expand/collapse toggle
                header.addEventListener('click', () => {
                    const isExpanded = portal.classList.toggle('expanded');
                    if (isExpanded && newDot) {
                        newDot.style.display = 'none';
                        try { localStorage.setItem(LAST_SEEN_VERSION_KEY, latestVersion); } catch (_) { }
                    }
                });
                header.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        header.click();
                    }
                });
            })
            .catch(err => {
                console.warn('[WhatsNew] Failed to load changelog:', err);
            });
    }

    function renderChangelogContent(rawContent) {
        if (!rawContent) return '';
        const lines = rawContent.split('\n');
        let html = '';
        const categoryEmojis = {
            'improvements': '⚡',
            'bug fixes': '🐛',
            'new features': '🆕',
            'breaking changes': '⚠️',
            'performance': '🚀',
            'security': '🔒',
            'documentation': '📖',
            'internal': '🔧',
            'deprecations': '⏳'
        };

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Category headers: ### Bug Fixes or **Bug Fixes:** (both formats)
            const categoryMatch = trimmed.match(/^###\s+(.+)/) || trimmed.match(/^\*\*([^*]+?):\*\*\s*$/);
            if (categoryMatch) {
                const catName = categoryMatch[1].trim();
                const catLower = catName.toLowerCase();
                const emoji = categoryEmojis[catLower] || '📌';
                html += '<div class="portal-category">' + emoji + ' ' + portalEscapeHtml(catName) + '</div>';
                continue;
            }

            // Bullet items: - Some text or * Some text
            const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
            if (bulletMatch) {
                let text = bulletMatch[1];
                // Simple markdown: **bold**
                text = portalEscapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
                html += '<div class="portal-item">' + text + '</div>';
                continue;
            }
        }
        return html;
    }

    function portalEscapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // Initialize portal after partials are loaded
    if (window.partialsReady && typeof window.partialsReady.then === 'function') {
        window.partialsReady.then(function () { initWhatsNewPortal(); }).catch(function () { });
    } else if (document.getElementById('whatsNewPortal')) {
        initWhatsNewPortal();
    } else {
        document.addEventListener('DOMContentLoaded', function () { initWhatsNewPortal(); });
    }

})();
