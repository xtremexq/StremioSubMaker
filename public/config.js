// Configuration page JavaScript - Modern Edition
(function () {
    'use strict';

    const DEFAULT_LOCALE = { lang: 'en', messages: {} };
    const RTL_LANGS = new Set(['ar', 'he', 'fa', 'ur']);
    const UI_LANGUAGE_STORAGE_KEY = 'submaker_ui_language';
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
        } catch (err) {
            console.warn('[i18n] Failed to load locale, falling back to English', err);
            bootstrapTranslator(DEFAULT_LOCALE);
            applyUiLanguageCopy();
            applyStaticCopy();
        }
    }
    localeReadyPromise = initLocale();

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
        const rateNote = document.getElementById('opensubsRateNote');
        if (rateNote) {
            const existingLink = rateNote.querySelector('a');
            const linkHref = existingLink ? existingLink.getAttribute('href') : 'https://www.opensubtitles.com/en/newuser';
            const linkText = existingLink ? existingLink.textContent : 'Create a free account';
            const linkColor = existingLink ? existingLink.style.color : 'var(--primary-light)';
            rateNote.textContent = tConfig('config.opensubs.rateNote', {}, '20 subtitles a day. Create a free account if you do not have one.') + ' ';
            const link = document.createElement('a');
            link.href = linkHref;
            link.target = '_blank';
            link.style.color = linkColor;
            link.textContent = linkText;
            rateNote.appendChild(link);
        }
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
    const KEY_OPTIONAL_PROVIDERS = new Set(['googletranslate']);

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
        gemini: { label: 'Gemini' }
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
        }
    };

    // Translation prompt presets
    const STRICT_TRANSLATION_PROMPT = `You are a professional subtitles translator. Translate the following subtitles while:
1. Maintaining perfect SRT format (sequence numbers, timestamps, and text)
2. Preserving the timing and structure exactly as given
3. Keeping the same number of lines and line breaks
4. Translating text naturally and contextually
5. Ensuring cultural adaptation where necessary while staying faithful to the original meaning
6. Preserving any existing formatting tags

This is an automatic system, DO NOT make any explanations or comments - simply output the translated SRT content

Return ONLY the translated SRT content, nothing else. NEVER output markdown.

Translate to {target_language}.`;

    const NATURAL_TRANSLATION_PROMPT = `You are a professional subtitle translator. Translate the following subtitles while:

1. Trying to preserve the timing and structure exactly as given, correctly adapting for natural target language subtitles flow if deemed necessary.
2. The same is true for number of lines and line breaks
3. Maintaining natural dialogue flow and colloquialisms appropriate to the target language
4. Preserving any formatting tags or special characters
5. Ensuring translations are contextually accurate for film/TV dialogue
This is an automatic system, you must return ONLY the subtitles output/file.
Translate to {target_language}.`;

    /**
     * Model-specific default configurations
     * Each model has its own optimal settings for thinking and temperature
     */
    const MODEL_SPECIFIC_DEFAULTS = {
        'gemini-flash-lite-latest': {
            thinkingBudget: 0,
            temperature: 0.7
        },
        'gemini-2.5-flash-lite-preview-09-2025': {
            thinkingBudget: 0,
            temperature: 0.7
        },
        'gemini-2.5-flash-preview-09-2025': {
            thinkingBudget: -1,
            temperature: 0.5
        },
        'gemini-3-flash-preview': {
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
                translationTimeout: sanitizeNumber(raw?.translationTimeout, defaults.translationTimeout, 5, 600),
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

    function getDefaultConfig(modelName = 'gemini-3-flash-preview') {
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
            geminiApiKey: DEFAULT_API_KEYS.GEMINI,
            geminiKeyRotationEnabled: false,
            geminiApiKeys: [],
            geminiKeyRotationMode: 'per-request', // 'per-request' or 'per-batch'
            assemblyAiApiKey: DEFAULT_API_KEYS.ASSEMBLYAI,
            cloudflareWorkersApiKey: DEFAULT_API_KEYS.CF_WORKERS_AUTOSUBS,
            otherApiKeysEnabled: true,
            autoSubs: {
                defaultMode: 'cloudflare',
                sendFullVideoToAssembly: false
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
                googletranslate: { enabled: false, apiKey: '', model: 'web' }
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
                }
            },
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
            mobileMode: false, // On Android: wait for full translation before responding
            singleBatchMode: false, // Try translating whole file at once
            advancedSettings: {
                enabled: false, // Auto-set to true if any setting differs from defaults (forces bypass cache)
                geminiModel: '', // Override model (empty = use default)
                thinkingBudget: modelDefaults.thinkingBudget,
                temperature: modelDefaults.temperature,
                topP: 0.95,
                topK: 40,
                enableBatchContext: false, // Include original surrounding context and previous translations
                contextSize: 3, // Number of surrounding entries to include as context
                sendTimestampsToAI: false // Let AI handle timestamps directly
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
    let allLanguages = [];
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

    // localStorage cache keys
    const CACHE_KEY = 'submaker_config_cache';
    const CACHE_EXPIRY_KEY = 'submaker_config_cache_expiry';
    const CACHE_VERSION_KEY = 'submaker_config_cache_version';  // Tracks version when cache was saved
    const CACHE_TOKEN_KEY = 'submaker_config_cache_token'; // Scopes cached config to the session token it was created for
    const TOKEN_KEY = 'submaker_session_token';

    // Visual state cache keys (these should be cleared on version changes)
    const VISUAL_STATE_KEYS = [
        'submaker_dont_show_instructions',
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

    // Clear any invalid tokens that might exist from previous errors
    clearInvalidToken('startup');

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
        const defaults = getDefaultConfig(currentConfig.geminiModel || 'gemini-3-flash-preview').autoSubs;
        currentConfig.autoSubs = {
            ...defaults,
            ...(currentConfig.autoSubs || {})
        };
        currentConfig.otherApiKeysEnabled = isDevModeEnabled();
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

        const params = new URLSearchParams(window.location.search);
        const rawConfigParam = params.get('config');
        const urlSessionToken = isValidSessionToken(rawConfigParam) ? rawConfigParam : null;
        const hasExplicitUrlConfig = !!urlSessionToken;
        const urlConfig = parseConfigFromUrl();

        // Identify which session token should scope any cached config usage
        const storedToken = localStorage.getItem(TOKEN_KEY);
        const persistentSessionToken = isValidSessionToken(storedToken) ? storedToken : null;
        const intendedToken = urlSessionToken || persistentSessionToken || null;

        // Priority: cached config (for this token) > URL config > default config
        // This ensures browser cache is respected unless explicitly shared via URL while
        // preventing cached configs from leaking across different session tokens.
        // NOTE: loadConfigFromCache is now async due to version validation
        const cachedConfig = await loadConfigFromCache(intendedToken);
        // Determine if this is the user's first config run
        isFirstRun = !cachedConfig && !hasExplicitUrlConfig;

        if (cachedConfig && !hasExplicitUrlConfig) {
            // Use cached config - this is the most common case
            currentConfig = cachedConfig;
        } else if (hasExplicitUrlConfig) {
            // URL has explicit config - session token provided
            currentConfig = urlConfig;

            // New: If URL param looks like a session token, fetch stored config from server
            if (isValidSessionToken(rawConfigParam)) {
                try {
                    // CRITICAL: Add cache-busting timestamp to prevent cross-user config contamination
                    // Without this, aggressive browsers/proxies might cache and serve wrong user's config
                    const cacheBuster = `_cb=${Date.now()}`;
                    // Request with autoRegenerate=true to get fresh config if session is missing/corrupted
                    const resp = await fetch(`/api/get-session/${rawConfigParam}?${cacheBuster}&autoRegenerate=true`, {
                        cache: 'no-store',
                        headers: {
                            'Cache-Control': 'no-cache, no-store, must-revalidate',
                            'Pragma': 'no-cache'
                        }
                    });
                    if (resp.ok) {
                        const data = await resp.json();
                        if (data && data.config) {
                            currentConfig = data.config;

                            // Check if the server regenerated a fresh token due to corruption/missing session
                            if (data.regenerated && data.token && data.token !== rawConfigParam) {
                                console.warn('[Config] Server regenerated config:', data.reason);
                                console.log('[Config] Regenerated token available:', data.token);

                                // DO NOT store the regenerated token in localStorage yet!
                                // The user hasn't saved, so storing it now would cause a mismatch between
                                // what's installed in Stremio (old token) and what gets saved (new token).
                                // The save operation will store the appropriate token when user clicks Save.

                                // Clear the old invalid token from localStorage to force new session on save
                                try { localStorage.removeItem(TOKEN_KEY); } catch (_) { }

                                // Show a warning to the user
                                showAlert(tConfig('config.alerts.sessionLost', {}, 'Config session was lost. Please reconfigure and save to create a new session.'), 'warning', 'config.alerts.sessionLost', {});
                            } else {
                                // Normal path - store the original token
                                try { localStorage.setItem(TOKEN_KEY, rawConfigParam); } catch (_) { }
                            }
                        }
                    }
                } catch (e) {
                    // Ignore fetch errors; fallback to urlConfig/defaults
                    console.warn('[Config] Failed to fetch session:', e);
                }
            }
        }
        // else: currentConfig already initialized from parseConfigFromUrl() at top

        // On first run, start all subtitle providers disabled by default
        if (isFirstRun) {
            const defaults = getDefaultConfig();
            currentConfig = { ...defaults };
            currentConfig.subtitleProviders = {
                opensubtitles: { ...(defaults.subtitleProviders?.opensubtitles || {}), enabled: false },
                subdl: { ...(defaults.subtitleProviders?.subdl || {}), enabled: false },
                subsource: { ...(defaults.subtitleProviders?.subsource || {}), enabled: false }
            };
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
        setupKeyboardShortcuts();
        showKeyboardHint();

        // Auto-fetch models if API key exists (do not block UI/modals)
        const apiKey = document.getElementById('geminiApiKey').value.trim();
        if (apiKey) {
            Promise.resolve().then(() => autoFetchModels(apiKey)).catch(() => { });
        }

        // Position reset bar after layout is ready
        requestAnimationFrame(positionResetBar);
        window.addEventListener('resize', debounce(positionResetBar, 120));
    }

    function normalizeLanguageCodes(codes) {
        if (!Array.isArray(codes)) return [];
        return codes.map(c => {
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
            sourceDesc.innerHTML = tConfig('config.limits.sourceDescription', { max: MAX_SOURCE_LANGUAGES }, `You can select up to ${MAX_SOURCE_LANGUAGES} source language${MAX_SOURCE_LANGUAGES === 1 ? '' : 's'}, but only 1 is recommended (so you have the same list order when translating). All subtitles from this language will be available for translation in the translation selector AND will be fetched (original subtitles will show up).`);
        }

        const targetDesc = document.getElementById('targetLanguagesDescription');
        if (targetDesc) {
            try { targetDesc.setAttribute('data-i18n-vars', JSON.stringify({ max: MAX_TARGET_LANGUAGES })); } catch (_) { }
            targetDesc.innerHTML = tConfig('config.limits.targetDescription', { max: MAX_TARGET_LANGUAGES }, `Subtitles in target languages will be fetched AND translation buttons will appear for translating FROM the source language TO these languages. You can select up to ${MAX_TARGET_LANGUAGES} total target languages (including Learn Mode).`);
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
    function updateBodyScrollLock() {
        try {
            const instr = document.getElementById('instructionsModal');
            const reset = document.getElementById('resetConfirmModal');
            const shouldLock = (instr && instr.classList.contains('show')) || (reset && reset.classList.contains('show'));

            // Measure scrollbar width BEFORE toggling lock to get the correct value
            const scrollbarWidth = Math.max(0, (window.innerWidth || 0) - (document.documentElement ? document.documentElement.clientWidth : 0));

            // Toggle scroll lock class
            document.body.classList.toggle('modal-open', !!shouldLock);

            // Prevent layout shift by compensating for scrollbar width when locking
            if (shouldLock) {
                if (scrollbarWidth > 0) {
                    if (document.body.dataset.prOriginal === undefined) {
                        document.body.dataset.prOriginal = document.body.style.paddingRight || '';
                    }
                    document.body.style.paddingRight = scrollbarWidth + 'px';
                }
            } else {
                if (document.body.dataset.prOriginal !== undefined) {
                    document.body.style.paddingRight = document.body.dataset.prOriginal;
                    delete document.body.dataset.prOriginal;
                } else {
                    document.body.style.paddingRight = '';
                }
            }
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
        if (!peek && (id === 'instructionsModal' || id === 'resetConfirmModal')) {
            updateBodyScrollLock();
        }
        return true;
    }
    function showInstructionsModalIfNeeded() {
        try {
            const raw = localStorage.getItem('submaker_dont_show_instructions');
            if (raw === 'true') {
                showInstructionsFab();
                return;
            }
        } catch (_) {
            // Fall through to show a peek anyway
        }

        const openFull = () => {
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
        if (dontShow) {
            localStorage.setItem('submaker_dont_show_instructions', 'true');
        }
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
            return;
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
        try {
            const stored = localStorage.getItem(TOKEN_KEY);
            if (stored && isValidConfigToken(stored)) return stored;
        } catch (_) { }

        try {
            const params = new URLSearchParams(window.location.search);
            const raw = params.get('config');
            if (raw && isValidConfigToken(raw)) return raw;
        } catch (_) { }
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

        if (statStatus) statStatus.textContent = hasToken ? readyLabel : missingLabel;
        if (statConfigure) statConfigure.textContent = hasToken ? tConfig('config.actions.install', {}, 'Install') : missingLabel;
        if (statToolbox) statToolbox.textContent = hasToken ? readyLabel : toolboxMissing;
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

    function isToolboxEnabledForConfig(tokenToCheck) {
        if (!tokenToCheck) return false;
        try {
            const cachedToken = localStorage.getItem(CACHE_TOKEN_KEY);
            if (cachedToken && cachedToken !== tokenToCheck) return false;
            const raw = localStorage.getItem(CACHE_KEY);
            const cached = raw ? JSON.parse(raw) : null;
            if (!cached) return false;
            return cached.subToolboxEnabled === true
                || cached.fileTranslationEnabled === true
                || cached.syncSubtitlesEnabled === true;
        } catch (_) {
            return false;
        }
    }

    function updateToolboxLauncherVisibility(configOverride) {
        const btn = document.getElementById('subToolboxLauncher');
        if (!btn) return;
        if (isMobileViewport()) {
            btn.style.display = 'none';
            btn.dataset.configRef = '';
            btn.classList.remove('show');
            return;
        }
        const cfgRef = configOverride || getActiveConfigRef();
        const shouldShow = !!cfgRef && isToolboxEnabledForConfig(cfgRef);
        if (shouldShow) {
            btn.style.display = 'flex';
            btn.dataset.configRef = cfgRef;
            btn.classList.add('show');
        } else {
            btn.style.display = 'none';
            btn.dataset.configRef = '';
            btn.classList.remove('show');
        }

        updateQuickStats();
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
    }

    // (Removed extra window load fallback to reduce complexity)

    // Unified delegated click handler (capture) for modals/FAB
    document.addEventListener('click', function (e) {
        const target = e.target;
        const overlay = target && target.closest ? target.closest('.modal-overlay') : null;
        const clickedInsideModal = target && target.closest ? target.closest('.modal') : null;

        if (overlay && !clickedInsideModal) {
            if (overlay.id === 'instructionsModal') {
                closeInstructionsModal();
                return;
            } else if (overlay.id === 'subToolboxModal') {
                closeSubToolboxModal();
                return;
            } else if (overlay.id === 'resetConfirmModal') {
                const modal = document.getElementById('resetConfirmModal');
                if (modal) { modal.classList.remove('show'); modal.style.display = 'none'; updateBodyScrollLock(); }
                return;
            }
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
            openModalById('instructionsModal');
            return;
        }
    }, true);

    // Close modals with Escape key (priority handler)
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            const instructionsModal = document.getElementById('instructionsModal');
            const subToolboxModal = document.getElementById('subToolboxModal');
            const resetConfirmModal = document.getElementById('resetConfirmModal');

            if (instructionsModal && instructionsModal.classList.contains('show')) {
                e.preventDefault();
                e.stopPropagation();
                closeInstructionsModal();
            } else if (subToolboxModal && subToolboxModal.classList.contains('show')) {
                e.preventDefault();
                e.stopPropagation();
                closeSubToolboxModal();
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
        const currentBaseModel = geminiModelEl ? geminiModelEl.value : 'gemini-3-flash-preview';
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
        const ctxSizeChanged = ctxSizeEl ? (parseInt(ctxSizeEl.value) !== (defaults.contextSize || 3)) : false;

        return modelChanged || thinkingChanged || tempChanged || topPChanged || batchCtxChanged || ctxSizeChanged;
    }

    /**
     * Update database mode dropdown state based on advanced settings, multi-provider mode, or forced modes (e.g. single-batch)
     */
    function updateBypassCacheForAdvancedSettings() {
        const databaseModeEl = document.getElementById('databaseMode');
        const noteEl = document.getElementById('databaseModeNote');
        const reasonEl = document.getElementById('databaseModeReason');
        const singleBatchEl = document.getElementById('singleBatchMode');

        if (!databaseModeEl) return;

        const isModified = areAdvancedSettingsModified();
        const singleBatchEnabled = singleBatchEl ? singleBatchEl.checked === true : currentConfig?.singleBatchMode === true;
        const multiProvidersActive = isMultiProviderActiveInForm();

        const reasons = [];
        if (isModified) reasons.push('Advanced Settings are modified');
        if (singleBatchEnabled) reasons.push('Single-Batch mode is enabled');
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

                const response = await fetch('/api/languages', {
                    signal: controller.signal,
                    method: 'GET',
                    headers: {
                        'Accept': 'application/json'
                    }
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const languages = await response.json();

                // Filter out special fake languages (like ___upload for File Translation) and dedupe variants
                const filtered = languages.filter(lang => !lang.code.startsWith('___'));
                allLanguages = dedupeLanguagesForUI(filtered);

                renderLanguageGrid('sourceLanguages', 'selectedSourceLanguages', allLanguages);
                renderLanguageGrid('targetLanguages', 'selectedTargetLanguages', allLanguages);
                renderLanguageGrid('noTranslationLanguages', 'selectedNoTranslationLanguages', allLanguages);
                renderLanguageGrid('learnLanguages', 'selectedLearnLanguages', allLanguages);

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
        let containerId, badgeId;
        if (type === 'source') {
            containerId = 'selectedSourceLanguages';
            badgeId = 'sourceBadge';
        } else if (type === 'notranslation') {
            containerId = 'selectedNoTranslationLanguages';
            badgeId = null; // No badge for no-translation
        } else if (type === 'learn') {
            containerId = 'selectedLearnLanguages';
            badgeId = 'learnBadge';
        } else {
            containerId = 'selectedTargetLanguages';
            badgeId = 'targetBadge';
        }

        const container = document.getElementById(containerId);
        const badge = badgeId ? document.getElementById(badgeId) : null;

        container.innerHTML = '';
        container.classList.toggle('empty', languageCodes.length === 0);

        // Update badge count
        if (badge) {
            badge.textContent = languageCodes.length;
            badge.style.display = languageCodes.length > 0 ? 'inline-flex' : 'none';
        }

        // Live validation
        if (type === 'source' || type === 'target' || type === 'learn') {
            validateLanguageSelection(type);
        } else if (type === 'notranslation') {
            validateNoTranslationSelection();
        }

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

    function setupEventListeners() {
        // Form submission
        document.getElementById('configForm').addEventListener('submit', handleSubmit);

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
        document.getElementById('cancelResetBtn')?.addEventListener('click', () => {
            const modal = document.getElementById('resetConfirmModal');
            if (modal) { modal.classList.remove('show'); modal.style.display = 'none'; }
        });
        document.getElementById('closeResetConfirmBtn')?.addEventListener('click', () => {
            const modal = document.getElementById('resetConfirmModal');
            if (modal) { modal.classList.remove('show'); modal.style.display = 'none'; }
        });

        // Search functionality
        document.getElementById('sourceSearch').addEventListener('input', (e) => {
            filterLanguages('sourceLanguages', e.target.value);
        });

        document.getElementById('targetSearch').addEventListener('input', (e) => {
            filterLanguages('targetLanguages', e.target.value);
        });

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
                validateLanguageSelection('learn');
                saveConfig();
            });
        }
        document.querySelectorAll('input[name="learnOrder"]').forEach(r => {
            r.addEventListener('change', (e) => {
                if (e.target.checked) {
                    currentConfig.learnOrder = e.target.value;
                    saveConfig();
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
        const sendTimestampsEl = document.getElementById('sendTimestampsToAI');

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

        [advModelEl, advThinkingEl, advTempEl, advTopPEl, sendTimestampsEl].forEach(el => {
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
        if (sendTimestampsEl) {
            sendTimestampsEl.addEventListener('change', updateBypassCacheForAdvancedSettings);
            sendTimestampsEl.addEventListener('input', updateBypassCacheForAdvancedSettings);
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
                translationTimeout: Math.max(5, Math.min(600, parseInt(timeoutEl ? timeoutEl.value : defaults[key].translationTimeout) || defaults[key].translationTimeout)),
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
            const cachedModels = providerModelCache[key] || [];
            populateProviderModels(key, cachedModels, cfg?.model || '');
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
        if (!apiKey) {
            if (!options.silent) {
                showAlert(tConfig('config.alerts.missingProviderKey', { provider: PROVIDERS[providerKey]?.label || providerKey }, `Add an API key for ${PROVIDERS[providerKey]?.label || providerKey} to load models`), 'warning', 'config.alerts.missingProviderKey', { provider: PROVIDERS[providerKey]?.label || providerKey });
            }
            return;
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
            const response = await fetch(`/api/models/${providerKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey })
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

        const container = document.getElementById('alertContainer');
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
            document.getElementById('learnPlacementGroup')
        ];
        const otherSettingsCard = document.getElementById('otherSettingsCard');
        const subToolboxNoTranslationGroup = document.getElementById('subToolboxNoTranslationGroup');
        const excludeHearingImpairedNoTranslationGroup = document.getElementById('excludeHearingImpairedNoTranslationGroup');

        ['sendTimestampsToAI', 'databaseMode', 'learnModeEnabled', 'mobileMode', 'singleBatchMode', 'betaMode'].forEach(id => {
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
                learnOrder: currentConfig.learnOrder || 'source-top'
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
        const devEnabled = isDevModeEnabled();
        if (card) {
            card.style.display = devEnabled ? '' : 'none';
            card.setAttribute('aria-hidden', devEnabled ? 'false' : 'true');
        }
        if (currentConfig) {
            currentConfig.otherApiKeysEnabled = devEnabled;
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
            { name: 'gemini-flash-lite-latest', displayName: 'Gemini 2.5 Flash-Lite' },
            { name: 'gemini-2.5-flash-preview-09-2025', displayName: 'Gemini 2.5 Flash' },
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
     *   source/target languages, and Other Settings checkboxes (Sub Toolbox, cacheEnabled, bypassCache)
     */
    function migrateConfigForNewVersion(oldConfig) {
        const defaults = getDefaultConfig();

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
            newConfig.geminiKeyRotationMode = oldConfig.geminiKeyRotationMode || 'per-request';

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

            // Reset selected model to default (do NOT preserve old) and reset advanced settings to defaults
            newConfig.geminiModel = defaults.geminiModel;
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
            rotationModeSelect.value = currentConfig.geminiKeyRotationMode || 'per-request';
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
        let modelToUse = currentConfig.geminiModel || 'gemini-3-flash-preview';

        // Migrate old Pro preview model ID to new stable ID
        if (modelToUse === 'gemini-2.5-pro-preview-05-06') {
            modelToUse = 'gemini-2.5-pro';
        }

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
            currentConfig.advancedSettings = getDefaultConfig(currentConfig.geminiModel || 'gemini-2.5-flash-preview-09-2025').advancedSettings;
        } else {
            // Merge with defaults to backfill any new fields
            const advDefaults = getDefaultConfig(currentConfig.geminiModel || 'gemini-2.5-flash-preview-09-2025').advancedSettings;
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
        if (contextSizeEl) contextSizeEl.value = currentConfig.advancedSettings?.contextSize || 3;
        const sendTimestampsEl = document.getElementById('sendTimestampsToAI');
        if (sendTimestampsEl) sendTimestampsEl.value = (currentConfig.advancedSettings?.sendTimestampsToAI === true) ? 'ai' : 'original';

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
            mobileToggle.addEventListener('change', (e) => {
                currentConfig.mobileMode = e.target.checked;
            });
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
            hiExcludeToggle.addEventListener('change', (e) => syncHiExclude(e.target.checked === true));
        }
        if (hiExcludeToggleNoTranslation) {
            hiExcludeToggleNoTranslation.addEventListener('change', (e) => syncHiExclude(e.target.checked === true));
        }
        if (!hiExcludeToggle && !hiExcludeToggleNoTranslation) {
            currentConfig.excludeHearingImpairedSubtitles = currentConfig.excludeHearingImpairedSubtitles === true;
        }
        const singleBatchToggle = document.getElementById('singleBatchMode');
        if (singleBatchToggle) {
            singleBatchToggle.addEventListener('change', (e) => {
                currentConfig.singleBatchMode = e.target.checked === true;
                updateBypassCacheForAdvancedSettings();
            });
        }
    }

    async function handleSubmit(e) {
        e.preventDefault();
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
            return advSettingsModified || userSelectedBypass || singleBatchEnabled || hasActiveMultiProvider;
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
            geminiKeyRotationMode: document.getElementById('geminiKeyRotationMode')?.value || 'per-request',
            assemblyAiApiKey: (function () { const el = document.getElementById('assemblyAiApiKey'); return el ? el.value.trim() : ''; })(),
            cloudflareWorkersApiKey: (function () { const el = document.getElementById('cloudflareWorkersApiKey'); return el ? el.value.trim() : ''; })(),
            otherApiKeysEnabled: isDevModeEnabled(),
            autoSubs: {
                ...currentConfig.autoSubs,
                defaultMode: currentConfig.autoSubs?.defaultMode || 'cloudflare',
                sendFullVideoToAssembly: currentConfig.autoSubs?.sendFullVideoToAssembly === true
            },
            // Save the selected model from the dropdown
            // Advanced settings can override this if enabled
            geminiModel: document.getElementById('geminiModel')?.value || 'gemini-3-flash-preview',
            promptStyle: promptStyle,
            translationPrompt: translationPrompt,
            betaModeEnabled: isBetaModeEnabled(),
            devMode: (function () { const el = document.getElementById('devMode'); return el ? el.checked : false; })(),
            sourceLanguages: currentConfig.sourceLanguages,
            targetLanguages: currentConfig.targetLanguages,
            learnMode: currentConfig.learnMode === true,
            learnTargetLanguages: currentConfig.learnTargetLanguages || [],
            learnOrder: currentConfig.learnOrder || 'source-top',
            learnPlacement: 'top', // Force top-of-screen placement
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
                }
            },
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
            advancedSettings: {
                enabled: areAdvancedSettingsModified(), // Auto-detect if any setting differs from defaults
                geminiModel: (function () { const el = document.getElementById('advancedModel'); return el ? el.value : ''; })(),
                thinkingBudget: (function () { const el = document.getElementById('advancedThinkingBudget'); return el ? parseInt(el.value) : 0; })(),
                temperature: (function () { const el = document.getElementById('advancedTemperature'); return el ? parseFloat(el.value) : 0.8; })(),
                topP: (function () { const el = document.getElementById('advancedTopP'); return el ? parseFloat(el.value) : 0.95; })(),
                topK: 40, // Keep default topK
                enableBatchContext: (function () { const el = document.getElementById('enableBatchContext'); return el ? el.checked : false; })(),
                contextSize: (function () { const el = document.getElementById('contextSize'); return el ? parseInt(el.value) : 3; })(),
                sendTimestampsToAI: (function () { const el = document.getElementById('sendTimestampsToAI'); return el ? el.value === 'ai' : false; })()
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
            return;
        }

        // Check if we have an existing session token
        let existingToken = localStorage.getItem(TOKEN_KEY);
        let configToken;
        let isUpdate = false;


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
                        const updateResponse = await fetch(`/api/update-session/${encodedToken}`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify(config),
                            timeout: 10000 // 10 second timeout
                        });

                        // FIXED: Better error handling for different response codes
                        if (updateResponse.status === 404 || updateResponse.status === 410) {
                            // Token not found or expired - create new session
                            showAlert(tConfig('config.alerts.sessionExpiredCreating', {}, 'Session expired. Creating new session...'), 'info', 'config.alerts.sessionExpiredCreating', {});
                            localStorage.removeItem(TOKEN_KEY);
                            existingToken = null;
                        } else if (!updateResponse.ok) {
                            // Other errors - log and try to create new session
                            const errorText = await updateResponse.text();
                            showAlert(tConfig('config.alerts.sessionUpdateFailed', {}, 'Session update failed. Creating new session...'), 'warning', 'config.alerts.sessionUpdateFailed', {});
                            localStorage.removeItem(TOKEN_KEY);
                            existingToken = null;
                        } else {
                            // Success
                            const sessionData = await updateResponse.json();
                            configToken = sessionData.token;
                            isUpdate = sessionData.updated;

                            if (sessionData.updated) {
                                showAlert(tConfig('config.alerts.configurationUpdated', {}, 'Configuration updated! Changes will take effect immediately in Stremio.'), 'success', 'config.alerts.configurationUpdated', {});
                            } else if (sessionData.created) {
                                // Token was expired, new one created
                                showAlert(tConfig('config.alerts.sessionExpiredCreated', {}, 'Session expired. Created new session - please reinstall addon in Stremio.'), 'warning', 'config.alerts.sessionExpiredCreated', {});
                                localStorage.setItem(TOKEN_KEY, configToken);
                            }
                        }
                    } catch (updateError) {
                        // Network error or timeout - fall back to create new session
                        showAlert(tConfig('config.alerts.sessionNetworkError', {}, 'Network error updating session. Creating new session...'), 'warning', 'config.alerts.sessionNetworkError', {});
                        localStorage.removeItem(TOKEN_KEY);
                        existingToken = null;
                    }
                }
            }

            // If we don't have a valid token, create new session
            if (!existingToken) {

                try {
                    const createResponse = await fetch('/api/create-session', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(config),
                        timeout: 10000 // 10 second timeout
                    });


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
                } catch (createError) {
                    showAlert(tConfig('config.alerts.saveFailed', { reason: createError.message }, 'Failed to save configuration: ' + createError.message), 'error', 'config.alerts.saveFailed', { reason: createError.message });
                    return;
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
            return;
        }

        // Use current origin if in production, otherwise use localhost
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const baseUrl = isLocalhost ? 'http://localhost:7001' : window.location.origin;
        const encodedToken = encodeURIComponent(configToken);
        const installUrl = `${baseUrl}/addon/${encodedToken}/manifest.json`;

        // Save to current config
        currentConfig = config;

        // Cache the configuration to localStorage
        saveConfigToCache(config, configToken);
        updateToolboxLauncherVisibility(configToken);
        updateQuickStats();

        // Enable install and copy buttons
        document.getElementById('installBtn').disabled = false;
        document.getElementById('copyBtn').disabled = false;

        // Store install URL
        window.installUrl = installUrl;

        // Show install URL in the text box
        const installUrlBox = document.getElementById('installUrlBox');
        const installUrlDisplay = document.getElementById('installUrlDisplay');
        installUrlDisplay.value = installUrl;
        installUrlBox.classList.add('show');

        // Auto-select the URL for easy copying
        setTimeout(() => {
            installUrlDisplay.select();
        }, 100);

        // Show appropriate message based on update vs new install
        if (!isUpdate) {
            showAlert(tConfig('config.alerts.configurationSaved', {}, 'Configuration saved! You can now install the addon in Stremio.'), 'success', 'config.alerts.configurationSaved', {});
        }
        // Update message already shown above
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

    function showAlert(message, type = 'success', i18nKey = '', i18nVars = {}) {
        const container = document.getElementById('alertContainer');

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

    function debounce(fn, wait) {
        let t = null;
        return function (...args) {
            if (t) clearTimeout(t);
            t = setTimeout(() => fn.apply(this, args), wait);
        };
    }

    // Reset settings flow
    function openResetConfirm() {
        openModalById('resetConfirmModal');
    }

    async function performFullReset() {
        showLoading(true);
        let freshToken = null;
        try {
            // 0) Request a fresh default config token from the server before clearing everything
            try {
                const response = await fetch('/api/get-session/00000000000000000000000000000000?autoRegenerate=true');
                if (response.ok) {
                    const data = await response.json();
                    if (data.regenerated && data.token) {
                        freshToken = data.token;
                        console.log('[Reset] Generated fresh default config token:', freshToken);
                    }
                }
            } catch (err) {
                console.warn('[Reset] Failed to request fresh token, will reload without one:', err);
            }

            // 1) Best-effort: ask SW to clear caches
            try {
                if (navigator.serviceWorker && navigator.serviceWorker.controller) {
                    navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_CACHE' });
                }
            } catch (_) { }

            // 2) Clear Cache Storage directly (in case SW isn't active)
            try {
                if (window.caches && caches.keys) {
                    const names = await caches.keys();
                    await Promise.all(names.map(n => caches.delete(n).catch(() => { })));
                }
            } catch (_) { }

            // 3) Unregister service workers
            try {
                if ('serviceWorker' in navigator) {
                    const regs = await navigator.serviceWorker.getRegistrations();
                    await Promise.all(regs.map(r => r.unregister().catch(() => { })));
                }
            } catch (_) { }

            // 4) Clear IndexedDB (best-effort; may not be supported everywhere)
            try {
                const hasDBList = !!(indexedDB && indexedDB.databases);
                if (hasDBList) {
                    const dbs = await indexedDB.databases();
                    await Promise.all((dbs || []).map(db => db && db.name ? new Promise(res => { const req = indexedDB.deleteDatabase(db.name); req.onsuccess = req.onerror = req.onblocked = () => res(); }) : Promise.resolve()));
                }
            } catch (_) { }

            // 5) Clear storage
            try { localStorage.clear(); } catch (_) { }
            try { sessionStorage.clear(); } catch (_) { }

            // 6) Clear cookies for this origin (best-effort)
            try {
                const parts = document.cookie.split(';');
                for (const part of parts) {
                    const name = part.split('=')[0]?.trim();
                    if (!name) continue;
                    document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
                }
            } catch (_) { }
        } finally {
            // 7) Reload with fresh token in path (if available) and cache-busting param
            const basePath = '/configure';
            const tokenSegment = freshToken ? `/${freshToken}` : '';
            const qs = `?reset=${Date.now()}`;
            window.location.replace(basePath + tokenSegment + qs);
        }
    }
})();






