/**
 * Quick Setup Wizard - Standalone controller
 * 
 * Self-contained IIFE that manages the 7-step setup wizard overlay.
 * Does NOT depend on config.js internals - it builds its own config object
 * and POSTs directly to /api/create-session.
 * 
 * To remove Quick Setup entirely:
 *   1. Delete this file
 *   2. Remove the <script> tag from configure.html
 *   3. Remove the quick-setup.html partial include from configure.html
 *   4. Remove the quick-setup.css link from configure.html
 *   5. Remove the #quickSetupBanner div from main.html
 */
(function () {
    'use strict';
    // Constants
    const TOKEN_KEY = 'submaker_session_token';
    const QS_DISMISSED_KEY = 'submaker_qs_dismissed';
    const QS_STATE_KEY = 'submaker_qs_state';
    const TOTAL_STEPS = 7;
    const DEFAULT_LIMITS = {
        maxSourceLanguages: 3,
        maxTargetLanguages: 6,
        maxNoTranslationLanguages: 10
    };
    const SERVER_LIMITS = (typeof window !== 'undefined' && window.__CONFIG_LIMITS__) ? window.__CONFIG_LIMITS__ : {};
    const EXTENDED_LANGUAGES_STORAGE_KEY = 'submaker_extended_languages';

    function parseLimit(rawValue, fallbackValue) {
        const parsed = parseInt(rawValue, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
    }

    const MAX_SOURCE_LANGUAGES = parseLimit(SERVER_LIMITS.maxSourceLanguages, DEFAULT_LIMITS.maxSourceLanguages);
    const MAX_TARGET_LANGUAGES = parseLimit(SERVER_LIMITS.maxTargetLanguages, DEFAULT_LIMITS.maxTargetLanguages);
    const MAX_NO_TRANSLATION_LANGUAGES = parseLimit(SERVER_LIMITS.maxNoTranslationLanguages, DEFAULT_LIMITS.maxNoTranslationLanguages);
    // No popular languages - all shown alphabetically
    const POPULAR_LANG_CODES = [];

    const QUICK_SETUP_MODEL_LABEL_FALLBACKS = {
        'gemini-3.1-flash-lite-preview': 'Gemini 3.1 Flash Lite',
        'gemini-2.5-flash-lite': 'Gemini 2.5 Flash-Lite',
        'gemini-2.5-flash': 'Gemini 2.5 Flash',
        'gemini-3-flash-preview': 'Gemini 3.0 Flash (beta)',
        'gemini-2.5-pro': 'Gemini 2.5 Pro (beta)',
        'gemini-3-pro-preview': 'Gemini 3.0 Pro (beta)',
        'gemini-flash-lite-latest': 'Gemini Flash Lite Latest',
        'gemini-flash-latest': 'Gemini Flash Latest'
    };
    const DEFAULT_WYZIE_API_KEY = '';

    function getQuickSetupDefaultWyzieApiKey() {
        try {
            const candidate = window.SubMakerDefaultApiKeys && window.SubMakerDefaultApiKeys.WYZIE;
            if (typeof candidate === 'string' && candidate.trim()) {
                return candidate.trim();
            }
        } catch (_) { }
        return DEFAULT_WYZIE_API_KEY;
    }

    function getDefaultQuickSetupWyzieSources() {
        return normalizeQuickSetupWyzieSources({
            subf2m: true,
            podnapisi: true,
            gestdown: true,
            animetosho: true
        });
    }

    function normalizeQuickSetupWyzieSources(sourceConfig) {
        const raw = (sourceConfig && typeof sourceConfig === 'object') ? sourceConfig : {};
        return {
            subf2m: raw.subf2m === true,
            podnapisi: raw.podnapisi === true,
            gestdown: raw.gestdown === true,
            animetosho: raw.animetosho === true,
            opensubtitles: raw.opensubtitles === true || raw.opensubs === true,
            subdl: raw.subdl === true,
            kitsunekko: raw.kitsunekko === true,
            jimaku: raw.jimaku === true,
            yify: raw.yify === true
        };
    }

    // Wizard State
    const state = {
        currentStep: 1,
        mode: null,           // 'translate' | 'fetch'
        // Sources
        openSubsAuth: false,
        openSubsUsername: '',
        openSubsPassword: '',
        subdlEnabled: false,
        subdlApiKey: '',
        subsourceEnabled: false,
        subsourceApiKey: '',
        scsEnabled: false,
        wyzieEnabled: false,
        wyzieApiKey: getQuickSetupDefaultWyzieApiKey(),
        wyzieSources: getDefaultQuickSetupWyzieSources(),
        // AI (translate mode only)
        geminiApiKey: '',
        geminiKeyValid: false,
        // Languages
        sourceLanguages: ['eng'],
        selectedLanguages: [],
        // Extras
        subToolbox: true,
        seasonPacks: true,
        hideSDH: false,
        // Learn mode (translate only)
        learnMode: false,
        learnTargetLanguages: []
    };

    function getConfigPageGeminiUiHelper() {
        if (typeof window === 'undefined' || !window.SubMakerGeminiModelUi || typeof window.SubMakerGeminiModelUi !== 'object') {
            return null;
        }
        return window.SubMakerGeminiModelUi;
    }

    function getDefaultGeminiModelOption() {
        const select = document.getElementById('geminiModel');
        if (!select || !select.options) {
            return null;
        }
        const options = Array.from(select.options).filter(option => {
            const value = String(option.value || '').trim();
            return !!value && option.disabled !== true && option.hidden !== true;
        });
        const defaultOption = options.find(option => option.defaultSelected === true);
        return defaultOption || options[0] || null;
    }

    function getGeminiModelOptionLabel(option) {
        if (!option) {
            return '';
        }
        const fallback = String(option.textContent || '').trim();
        const translationKey = option.getAttribute('data-i18n');
        if (translationKey && typeof window.t === 'function') {
            const translated = window.t(translationKey, null, fallback);
            if (translated && translated !== translationKey) {
                return String(translated).trim();
            }
        }
        return fallback;
    }

    function getQuickSetupGeminiModelValue() {
        const helper = getConfigPageGeminiUiHelper();
        if (helper && typeof helper.getDefaultModelValue === 'function') {
            const helperValue = String(helper.getDefaultModelValue() || '').trim();
            if (helperValue) {
                return helperValue;
            }
        }
        const option = getDefaultGeminiModelOption();
        const optionValue = option ? String(option.value || '').trim() : '';
        return optionValue || 'gemini-flash-latest';
    }

    function getQuickSetupGeminiModelLabel() {
        const helper = getConfigPageGeminiUiHelper();
        if (helper && typeof helper.getDefaultModelLabel === 'function') {
            const helperLabel = String(helper.getDefaultModelLabel() || '').trim();
            if (helperLabel) {
                return helperLabel;
            }
        }
        const optionLabel = getGeminiModelOptionLabel(getDefaultGeminiModelOption());
        if (optionLabel) {
            return optionLabel;
        }
        const modelValue = getQuickSetupGeminiModelValue();
        return QUICK_SETUP_MODEL_LABEL_FALLBACKS[modelValue] || modelValue;
    }

    function getQuickSetupGeminiAdvancedDefaults(modelName) {
        const normalizedModel = String(modelName || '').trim();
        const helper = getConfigPageGeminiUiHelper();
        if (helper && typeof helper.getModelSpecificDefaults === 'function') {
            const helperDefaults = helper.getModelSpecificDefaults(normalizedModel);
            if (helperDefaults && Number.isFinite(Number(helperDefaults.thinkingBudget)) && Number.isFinite(Number(helperDefaults.temperature))) {
                return {
                    thinkingBudget: Number(helperDefaults.thinkingBudget),
                    temperature: Number(helperDefaults.temperature)
                };
            }
        }

        switch (normalizedModel) {
            case 'gemini-2.5-flash':
            case 'gemini-3-flash-preview':
            case 'gemini-flash-latest':
                return { thinkingBudget: -1, temperature: 0.5 };
            case 'gemini-2.5-pro':
            case 'gemini-3-pro-preview':
                return { thinkingBudget: 1000, temperature: 0.5 };
            case 'gemini-2.5-flash-lite':
            case 'gemini-3.1-flash-lite-preview':
            case 'gemini-flash-lite-latest':
            default:
                return { thinkingBudget: 0, temperature: 0.8 };
        }
    }

    function updateQuickSetupGeminiUi() {
        const modelLabel = getQuickSetupGeminiModelLabel();
        const poweredByDesc = $('qsQuickSetupPoweredByDesc');
        const defaultModelValue = $('qsQuickSetupDefaultModelValue');

        if (poweredByDesc) {
            poweredByDesc.textContent = tQs(
                'step3.poweredByDesc',
                { model: modelLabel },
                `SubMaker uses ${modelLabel} for fast, accurate subtitle translations. You'll need a free API key from Google AI Studio.`
            );
        }
        if (defaultModelValue) {
            defaultModelValue.textContent = tQs('step3.defaultModelValue', { model: modelLabel }, modelLabel);
        }
    }

    // Track whether the user has saved successfully (for reload-on-close)
    let hasSaved = false;
    let quickSetupInstructionsReturnFocus = null;

    // Language caches
    let providerLanguages = [];
    let translationLanguages = [];
    let allLanguages = [];
    let languagesLoaded = false;
    // Utility

    function $(id) { return document.getElementById(id); }
    /** Quick Setup translation helper - wraps window.t() for the config.quickSetup namespace */
    function tQs(key, vars, fallback) {
        const fullKey = 'config.quickSetup.' + key;
        if (typeof window.t === 'function') return window.t(fullKey, vars, fallback);
        return fallback || key;
    }

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

    function normalizeLanguageCodes(codes) {
        const seen = new Set();
        return (Array.isArray(codes) ? codes : []).reduce((acc, rawCode) => {
            const code = String(rawCode || '').trim();
            if (!code || seen.has(code)) {
                return acc;
            }
            seen.add(code);
            acc.push(code);
            return acc;
        }, []);
    }

    function trimLanguageCodes(codes, max) {
        return normalizeLanguageCodes(codes).slice(0, max);
    }

    function clampQuickSetupTargetSelections() {
        const limitedTargets = [];
        const combined = new Set();

        state.selectedLanguages.forEach(code => {
            if (combined.has(code)) {
                limitedTargets.push(code);
                return;
            }
            if (combined.size >= MAX_TARGET_LANGUAGES) {
                return;
            }
            combined.add(code);
            limitedTargets.push(code);
        });

        const limitedLearn = [];
        state.learnTargetLanguages.forEach(code => {
            if (combined.has(code)) {
                limitedLearn.push(code);
                return;
            }
            if (combined.size >= MAX_TARGET_LANGUAGES) {
                return;
            }
            combined.add(code);
            limitedLearn.push(code);
        });

        state.selectedLanguages = limitedTargets;
        state.learnTargetLanguages = limitedLearn;
    }

    function sanitizeQuickSetupLanguageState() {
        state.sourceLanguages = trimLanguageCodes(state.sourceLanguages, MAX_SOURCE_LANGUAGES);
        if (state.sourceLanguages.length === 0) {
            state.sourceLanguages = ['eng'];
        }

        state.selectedLanguages = normalizeLanguageCodes(state.selectedLanguages);
        state.learnTargetLanguages = normalizeLanguageCodes(state.learnTargetLanguages);

        if (state.mode === 'fetch') {
            state.selectedLanguages = state.selectedLanguages.slice(0, MAX_NO_TRANSLATION_LANGUAGES);
            return;
        }

        clampQuickSetupTargetSelections();
    }

    function getQuickSetupSourceLanguages() {
        const sourceLanguages = normalizeLanguageCodes(state.sourceLanguages).slice(0, MAX_SOURCE_LANGUAGES);
        return sourceLanguages.length > 0 ? sourceLanguages : ['eng'];
    }

    function getLanguageDisplayName(code) {
        const codeKey = String(code || '').trim().toLowerCase();
        const lang = allLanguages.find(entry => String(entry.code || '').trim().toLowerCase() === codeKey);
        return lang ? lang.name : String(code || '').toUpperCase();
    }

    function getExtendedLanguagesEnabled() {
        try {
            return localStorage.getItem(EXTENDED_LANGUAGES_STORAGE_KEY) === 'true';
        } catch (_) {
            return false;
        }
    }

    function syncExtendedLanguageToggles(isEnabled) {
        const targetToggle = $('qsExtendedLanguagesToggle');
        const learnToggle = $('qsExtendedLanguagesToggleLearn');
        if (targetToggle) targetToggle.checked = isEnabled;
        if (learnToggle) learnToggle.checked = isEnabled;
    }

    function setExtendedLanguagesEnabled(isEnabled) {
        try {
            localStorage.setItem(EXTENDED_LANGUAGES_STORAGE_KEY, isEnabled ? 'true' : 'false');
        } catch (_) { }
        syncExtendedLanguageToggles(isEnabled);
        renderLangGrid();
        renderLearnLangGrid();
    }

    function getQuickSetupTranslationLanguages() {
        const baseTranslationLanguages = translationLanguages.filter(lang => !lang.extended);
        return getExtendedLanguagesEnabled() ? translationLanguages : baseTranslationLanguages;
    }

    function getStep4Languages() {
        return state.mode === 'fetch' ? providerLanguages : getQuickSetupTranslationLanguages();
    }

    function getCombinedQuickSetupTargets(excludeType, excludeCode) {
        const combined = new Set();
        const normalizedExcludeType = excludeType || '';
        const normalizedExcludeCode = String(excludeCode || '');

        state.selectedLanguages.forEach(code => {
            if (normalizedExcludeType === 'target' && code === normalizedExcludeCode) return;
            combined.add(code);
        });
        state.learnTargetLanguages.forEach(code => {
            if (normalizedExcludeType === 'learn' && code === normalizedExcludeCode) return;
            combined.add(code);
        });

        return combined;
    }

    function canAddQuickSetupTargetLanguage(code, type) {
        return getCombinedQuickSetupTargets(type, code).size < MAX_TARGET_LANGUAGES;
    }

    function flashLanguageGrid(gridId) {
        const grid = $(gridId);
        if (!grid) return;
        grid.style.animation = 'none';
        void grid.offsetWidth;
        grid.style.animation = '';
    }

    function updateSourceLanguageInfo() {
        const labelEl = $('qsSourceLangLabel');
        const valueEl = $('qsSourceLangValue');
        const sourceNames = getQuickSetupSourceLanguages().map(getLanguageDisplayName);

        if (labelEl) {
            const labelKey = sourceNames.length === 1 ? 'step4.sourceLangLabel' : 'step4.sourceLangsLabel';
            const fallback = sourceNames.length === 1 ? 'Source language:' : 'Source languages:';
            labelEl.textContent = tQs(labelKey, null, fallback);
        }

        if (valueEl) {
            valueEl.textContent = sourceNames.join(', ');
        }
    }

    function openMainConfigLanguageCard(cardType, attempt = 0) {
        const navButton = document.querySelector(`[data-panel="languages"]`);
        if (navButton && attempt === 0) {
            navButton.click();
        }

        const section = $('languagesSection');
        const cardId = cardType === 'learn' ? 'learnTargetsCard' : (cardType === 'target' ? 'targetCard' : 'sourceCard');
        const card = $(cardId);
        const focusId = cardType === 'learn' ? 'learnSearch' : (cardType === 'target' ? 'targetSearch' : 'sourceSearch');
        const focusEl = $(focusId);

        if (!section || !card) {
            if (attempt < 6) {
                setTimeout(() => openMainConfigLanguageCard(cardType, attempt + 1), 80);
            }
            return;
        }

        section.classList.remove('collapsed');
        document.querySelectorAll('[data-collapse-section="languages"], [data-section-close="languages"]').forEach(btn => {
            btn.classList.remove('collapsed');
        });

        card.classList.remove('collapsed');
        const collapseBtn = card.querySelector('.collapse-btn');
        if (collapseBtn) {
            collapseBtn.classList.remove('collapsed');
        }

        card.scrollIntoView({ behavior: 'smooth', block: 'start' });

        if (focusEl) {
            setTimeout(() => {
                try {
                    focusEl.focus({ preventScroll: true });
                } catch (_) {
                    focusEl.focus();
                }
            }, 140);
        }
    }

    function isQuickSetupInstructionsOpen() {
        const modal = $('qsInstructionsModal');
        return !!(modal && modal.classList.contains('show'));
    }

    function getQuickSetupInstructionsFocusableElements() {
        const modal = $('qsInstructionsModal');
        if (!modal) return [];

        return Array.from(modal.querySelectorAll(
            'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter(el => {
            if (!el || typeof el.getBoundingClientRect !== 'function') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        });
    }

    function openQuickSetupInstructions() {
        const modal = $('qsInstructionsModal');
        if (!modal) return;

        quickSetupInstructionsReturnFocus = document.activeElement && typeof document.activeElement.focus === 'function'
            ? document.activeElement
            : null;

        modal.classList.add('show');
        modal.setAttribute('aria-hidden', 'false');

        const closeBtn = $('qsCloseInstructionsBtn');
        setTimeout(() => {
            if (!closeBtn) return;
            try {
                closeBtn.focus({ preventScroll: true });
            } catch (_) {
                closeBtn.focus();
            }
        }, 0);
    }

    function closeQuickSetupInstructions(options = {}) {
        const modal = $('qsInstructionsModal');
        if (!modal) return;

        modal.classList.remove('show');
        modal.setAttribute('aria-hidden', 'true');

        const shouldRestoreFocus = options.restoreFocus !== false;
        const focusTarget = quickSetupInstructionsReturnFocus;
        quickSetupInstructionsReturnFocus = null;

        if (!shouldRestoreFocus || !focusTarget || !document.contains(focusTarget)) {
            return;
        }

        try {
            focusTarget.focus({ preventScroll: true });
        } catch (_) {
            focusTarget.focus();
        }
    }

    function handleQuickSetupKeydown(event) {
        if (!isQuickSetupInstructionsOpen()) {
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeQuickSetupInstructions();
            return;
        }

        if (event.key !== 'Tab') {
            return;
        }

        const focusable = getQuickSetupInstructionsFocusableElements();
        if (focusable.length === 0) {
            event.preventDefault();
            return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;

        if (event.shiftKey) {
            if (active === first || !focusable.includes(active)) {
                event.preventDefault();
                last.focus();
            }
            return;
        }

        if (active === last) {
            event.preventDefault();
            first.focus();
        }
    }

    /** Re-apply data-i18n attributes inside the Quick Setup overlay (called after partials load and on language change) */
    function applyQsTranslations() {
        const container = $('quickSetupOverlay');
        if (!container || typeof window.t !== 'function') return;
        // Handle data-i18n -> textContent (or innerHTML if value contains HTML tags)
        container.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (!key) return;
            const attrMode = el.getAttribute('data-i18n-attr');
            const fallback = attrMode === 'innerHTML' ? el.innerHTML : el.textContent;
            const value = window.t(key, null, fallback);
            if (value && value !== key) {
                if (attrMode === 'innerHTML' || /<[a-z][\s\S]*>/i.test(value)) {
                    el.innerHTML = value;
                } else {
                    el.textContent = value;
                }
            }
        });
        // Handle data-i18n-placeholder -> placeholder attribute
        container.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            if (!key) return;
            const fallback = el.getAttribute('placeholder') || '';
            const value = window.t(key, null, fallback);
            if (value && value !== key) el.setAttribute('placeholder', value);
        });
        // Handle data-i18n-title -> title attribute
        container.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.getAttribute('data-i18n-title');
            if (!key) return;
            const fallback = el.getAttribute('title') || '';
            const value = window.t(key, null, fallback);
            if (value && value !== key) el.setAttribute('title', value);
        });

        container.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
            const key = el.getAttribute('data-i18n-aria-label');
            if (!key) return;
            const fallback = el.getAttribute('aria-label') || '';
            const value = window.t(key, null, fallback);
            if (value && value !== key) el.setAttribute('aria-label', value);
        });
    }

    function show(el) {
        if (typeof el === 'string') el = $(el);
        if (el) el.style.display = '';
    }
    function hide(el) {
        if (typeof el === 'string') el = $(el);
        if (el) el.style.display = 'none';
    }

    function getQuickSetupEmptySelectionMarkup(key, fallback) {
        return `<span class="qs-empty-selection">${tQs(key, null, fallback)}</span>`;
    }

    function setQuickSetupEmptySelection(container, key, fallback) {
        if (!container) return;
        container.innerHTML = getQuickSetupEmptySelectionMarkup(key, fallback);
    }
    // Initialization

    function waitForPartials() {
        // init.js sets window.partialsReady to a Promise that resolves
        // once all data-include elements have their HTML injected.
        if (window.partialsReady && typeof window.partialsReady.then === 'function') {
            return Promise.race([
                window.partialsReady,
                new Promise(resolve => setTimeout(resolve, 5000)) // safety timeout
            ]);
        }
        // If init.js hasn't run yet, poll for it
        return new Promise(resolve => {
            const check = setInterval(() => {
                if (window.partialsReady && typeof window.partialsReady.then === 'function') {
                    clearInterval(check);
                    window.partialsReady.then(resolve);
                }
            }, 50);
            setTimeout(() => { clearInterval(check); resolve(); }, 5000);
        });
    }

    async function init() {
        await waitForPartials();

        // Apply i18n to the Quick Setup overlay after partials are injected
        applyQsTranslations();
        updateQuickSetupGeminiUi();
        updateSourceLanguageInfo();
        syncExtendedLanguageToggles(getExtendedLanguagesEnabled());

        // Always show the full Quick Setup banner
        const banner = $('quickSetupBanner');
        const openBtn = $('qsOpenBtn');

        if (banner) show(banner);
        if (openBtn) hide(openBtn);

        // Wire banner click
        if (banner) {
            banner.addEventListener('click', openWizard);
            banner.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWizard(); }
            });
        }

        // Wire permanent Quick Setup button
        if (openBtn) {
            openBtn.addEventListener('click', openWizard);
        }

        // Expose globally so other code (help menu, etc.) can trigger it
        window.openQuickSetup = openWizard;
        window.addEventListener('submaker:locale-updated', () => {
            applyQsTranslations();
            updateQuickSetupGeminiUi();
            updateSourceLanguageInfo();
            syncExtendedLanguageToggles(getExtendedLanguagesEnabled());
        });

        // Wire close button
        const closeBtn = $('qsCloseBtn');
        if (closeBtn) closeBtn.addEventListener('click', closeWizard);

        const closeInstructionsBtn = $('qsCloseInstructionsBtn');
        const instructionsGotItBtn = $('qsInstructionsGotItBtn');
        const instructionsBackdrop = $('qsInstructionsBackdrop');
        if (closeInstructionsBtn) closeInstructionsBtn.addEventListener('click', () => closeQuickSetupInstructions());
        if (instructionsGotItBtn) instructionsGotItBtn.addEventListener('click', () => closeQuickSetupInstructions());
        if (instructionsBackdrop) instructionsBackdrop.addEventListener('click', () => closeQuickSetupInstructions());
        document.addEventListener('keydown', handleQuickSetupKeydown);

        // Wire overlay backdrop click
        const overlay = $('quickSetupOverlay');
        const backdrop = $('qsBackdrop');
        if (backdrop) {
            backdrop.addEventListener('click', closeWizard);
        }

        // Create progress dots dynamically
        const dotsContainer = $('qsProgressDots');
        if (dotsContainer) {
            dotsContainer.innerHTML = '';
            for (let i = 1; i <= TOTAL_STEPS; i++) {
                const dot = document.createElement('span');
                dot.className = 'qs-dot';
                dot.dataset.step = i;
                dotsContainer.appendChild(dot);
            }
        }

        // Wire navigation
        const prevBtn = $('qsBackBtn');
        const nextBtn = $('qsNextBtn');
        if (prevBtn) prevBtn.addEventListener('click', goBack);
        if (nextBtn) nextBtn.addEventListener('click', goNext);

        // Wire Mode cards (Step 1)
        wireStep1();
        wireStep2();
        wireStep3();
        wireStep4();
        wireStep5();

        wireStep6Learn();

        // Load languages asynchronously
        loadLanguages();
    }
    // Wizard Open / Close

    async function openWizard() {
        const overlay = $('quickSetupOverlay');
        if (!overlay) return;

        updateQuickSetupGeminiUi();
        closeQuickSetupInstructions({ restoreFocus: false });

        // Check for existing saved session token
        const token = localStorage.getItem(TOKEN_KEY);
        const hasValidToken = token && /^[a-f0-9]{32}$/.test(token);

        // If a valid token exists, ALWAYS fetch fresh config from the API.
        // sessionStorage may contain stale wizard state from a previous incomplete
        // wizard session, so it must not override the actual saved config.
        if (hasValidToken) {
            overlay.classList.add('active');
            document.body.style.overflow = 'hidden';

            try {
                const resp = await fetch(`/api/get-session/${token}`);
                if (resp.ok) {
                    const data = await resp.json();
                    if (data && data.config) {
                        mapConfigToState(data.config);
                        // Clear stale sessionStorage and save fresh state
                        try { sessionStorage.removeItem(QS_STATE_KEY); } catch (_) { }
                        saveStateToSession();
                        restoreUIFromState();

                        state.currentStep = 1;
                        showStep(1);
                        hasSaved = false;
                        return;
                    }
                }
            } catch (e) {
                console.warn('[QuickSetup] Failed to load existing config:', e);
            }
            // API fetch failed - fall through to sessionStorage or reset
        }
        // No saved token - try to restore mid-wizard progress from sessionStorage
        // (user was mid-setup for the first time and closed/reopened the wizard)
        if (!hasValidToken && restoreStateFromSession()) {
            hasSaved = false;
            overlay.classList.add('active');
            document.body.style.overflow = 'hidden';
            showStep(state.currentStep);
            return;
        }

        // Fallback: New Session / Reset
        resetState();
        resetAllStepUIs();

        hasSaved = false;
        if (!overlay.classList.contains('active')) {
            overlay.classList.add('active');
        }
        document.body.style.overflow = 'hidden';
        showStep(1);
    }

    function closeWizard() {
        const overlay = $('quickSetupOverlay');
        closeQuickSetupInstructions({ restoreFocus: false });
        if (overlay) overlay.classList.remove('active');
        document.body.style.overflow = '';
        if (hasSaved) {
            window.location.reload();
        }
    }
    // Step Navigation

    function getEffectiveStep(step) {
        // Skip step 3 (AI Translation) in fetch mode
        if (step === 3 && state.mode === 'fetch') {
            return null; // skip
        }
        // Skip step 6 (Learn Language Selection) if learn mode is off or in fetch mode
        if (step === 6 && (!state.learnMode || state.mode === 'fetch')) {
            return null; // skip
        }
        return step;
    }

    function getNextStep(current) {
        let next = current + 1;
        while (next <= TOTAL_STEPS) {
            if (getEffectiveStep(next) !== null) return next;
            next++;
        }
        return null;
    }

    function getPrevStep(current) {
        let prev = current - 1;
        while (prev >= 1) {
            if (getEffectiveStep(prev) !== null) return prev;
            prev--;
        }
        return null;
    }

    function showStep(step) {
        state.currentStep = step;

        // Hide all steps
        document.querySelectorAll('.qs-step').forEach(s => {
            s.classList.remove('active');
        });

        // Show current step
        const stepEl = $(`qsStep${step}`);
        if (stepEl) {
            stepEl.classList.add('active');
        }

        // Update progress bar
        updateProgress(step);

        // Update navigation buttons
        updateNav(step);

        // Step-specific enter actions
        if (step === 4) onEnterStep4();
        if (step === 5) onEnterStep5();
        if (step === 6) onEnterStep6Learn();
        if (step === 7) onEnterStep7();
    }

    function updateProgress(step) {
        // Calculate effective progress (accounting for skipped steps)
        const steps = [];
        for (let i = 1; i <= TOTAL_STEPS; i++) {
            if (getEffectiveStep(i) !== null) steps.push(i);
        }
        const idx = steps.indexOf(step);
        const total = steps.length;
        const pct = ((idx + 1) / total) * 100;

        const bar = $('qsProgressFill');
        if (bar) bar.style.width = pct + '%';

        // Update dots
        document.querySelectorAll('.qs-dot').forEach(dot => {
            const dotStep = parseInt(dot.dataset.step, 10);
            dot.classList.remove('active', 'completed', 'skipped');
            if (dotStep === step) {
                dot.classList.add('active');
            } else if (getEffectiveStep(dotStep) === null) {
                dot.classList.add('skipped');
            } else if (steps.indexOf(dotStep) < idx) {
                dot.classList.add('completed');
            }
        });

        // Update step indicator text
        const indicator = $('qsStepIndicator');
        if (indicator) {
            indicator.textContent = tQs('stepOf', { current: idx + 1, total }, `Step ${idx + 1} of ${total}`);
        }
    }

    function updateNav(step) {
        const prevBtn = $('qsBackBtn');
        const nextBtn = $('qsNextBtn');
        const prev = getPrevStep(step);

        if (prevBtn) {
            prevBtn.style.visibility = prev ? 'visible' : 'hidden';
        }

        if (nextBtn) {
            if (step === TOTAL_STEPS) {
                // Last step - hide next, we have install buttons
                hide(nextBtn);
            } else {
                show(nextBtn);
                nextBtn.disabled = !canProceed(step);
                // Update button text based on next step
                const next = getNextStep(step);
                if (next === TOTAL_STEPS) {
                    nextBtn.textContent = tQs('reviewInstall', null, 'Review & Install \u2192');
                } else {
                    nextBtn.textContent = tQs('next', null, 'Next \u2192');
                }
            }
        }
    }

    function canProceed(step) {
        switch (step) {
            case 1: return !!state.mode;
            case 2: return true; // Sources are always valid (OpenSubs V3 is auto-on)
            case 3:
                if (state.mode === 'fetch') return true; // skipped
                return state.geminiApiKey.trim().length > 0;
            case 4: return state.selectedLanguages.length > 0;
            case 5: return true;
            case 6: return state.learnTargetLanguages.length > 0;
            default: return true;
        }
    }

    function goNext() {
        if (!canProceed(state.currentStep)) return;
        readStepData(state.currentStep);
        const next = getNextStep(state.currentStep);
        if (next) {
            showStep(next);
            saveStateToSession();
        }
    }

    function goBack() {
        const prev = getPrevStep(state.currentStep);
        if (prev) {
            showStep(prev);
            saveStateToSession();
        }
    }
    // Read Data from Step UI

    function readStepData(step) {
        switch (step) {
            case 2:
                // Read auth fields
                state.openSubsUsername = ($('qsOpenSubsUsername') || {}).value || '';
                state.openSubsPassword = ($('qsOpenSubsPassword') || {}).value || '';
                state.openSubsAuth = !!(state.openSubsUsername && state.openSubsPassword);
                // SubDL
                state.subdlEnabled = !!($('qsEnableSubDL') || {}).checked;
                state.subdlApiKey = ($('qsSubdlApiKey') || {}).value || '';
                // SubSource
                state.subsourceEnabled = !!($('qsEnableSubSource') || {}).checked;
                state.subsourceApiKey = ($('qsSubsourceApiKey') || {}).value || '';
                // SCS
                state.scsEnabled = !!($('qsEnableSCS') || {}).checked;
                // Wyzie
                state.wyzieEnabled = !!($('qsEnableWyzie') || {}).checked;
                state.wyzieApiKey = (($('qsWyzieApiKey') || {}).value || '').trim() || getQuickSetupDefaultWyzieApiKey();
                if (state.wyzieEnabled) {
                    state.wyzieSources = normalizeQuickSetupWyzieSources({
                        subf2m: !!($('qsWyzieSubf2m') || {}).checked,
                        podnapisi: !!($('qsWyziePodnapisi') || {}).checked,
                        gestdown: !!($('qsWyzieGestdown') || {}).checked,
                        animetosho: !!($('qsWyzieAnimetosho') || {}).checked,
                        opensubtitles: !!($('qsWyzieOpensubs') || {}).checked,
                        subdl: !!($('qsWyzieSubdl') || {}).checked,
                        kitsunekko: !!($('qsWyzieKitsunekko') || {}).checked,
                        jimaku: !!($('qsWyzieJimaku') || {}).checked,
                        yify: !!($('qsWyzieYify') || {}).checked
                    });
                }
                break;
            case 3:
                state.geminiApiKey = ($('qsGeminiApiKey') || {}).value || '';
                break;
            case 5:
                state.learnMode = !!($('qsLearnMode') || {}).checked;
                break;
        }
    }
    // Step 1: Mode Selection

    function wireStep1() {
        const cards = document.querySelectorAll('.qs-mode-card');
        cards.forEach(card => {
            card.addEventListener('click', () => {
                // Deselect all
                cards.forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                state.mode = card.dataset.mode;
                updateNav(1);
            });
        });
    }
    // Step 2: Subtitle Sources

    function wireStep2() {
        // OpenSubtitles auth toggle
        const authToggle = $('qsOpenSubsAuthToggle');
        const authFields = $('qsOpenSubsAuthFields');
        if (authToggle && authFields) {
            authToggle.addEventListener('click', () => {
                const isHidden = authFields.style.display === 'none';
                authFields.style.display = isHidden ? '' : 'none';
            });
        }

        // SubDL toggle
        const subdlCheck = $('qsEnableSubDL');
        const subdlWrap = $('qsSubdlKeyWrap');
        if (subdlCheck && subdlWrap) {
            subdlCheck.addEventListener('change', () => {
                subdlWrap.style.display = subdlCheck.checked ? '' : 'none';
            });
            // Sync initial state (browser may restore checked state on refresh)
            if (subdlCheck.checked) subdlWrap.style.display = '';
        }

        // SubSource toggle
        const ssCheck = $('qsEnableSubSource');
        const ssWrap = $('qsSubsourceKeyWrap');
        if (ssCheck && ssWrap) {
            ssCheck.addEventListener('change', () => {
                ssWrap.style.display = ssCheck.checked ? '' : 'none';
            });
            if (ssCheck.checked) ssWrap.style.display = '';
        }

        // SCS toggle
        const scsCheck = $('qsEnableSCS');
        const scsNote = $('qsScsNote');
        if (scsCheck && scsNote) {
            scsCheck.addEventListener('change', () => {
                scsNote.style.display = scsCheck.checked ? '' : 'none';
            });
            if (scsCheck.checked) scsNote.style.display = '';
        }

        // Wyzie toggle
        const wyzieCheck = $('qsEnableWyzie');
        const wyzieSources = $('qsWyzieSources');
        if (wyzieCheck && wyzieSources) {
            wyzieCheck.addEventListener('change', () => {
                wyzieSources.style.display = wyzieCheck.checked ? '' : 'none';
            });
            if (wyzieCheck.checked) wyzieSources.style.display = '';
        }
        // Test / Validate Buttons

        // OpenSubtitles auth test
        const osBtn = $('qsValidateOpenSubs');
        if (osBtn) {
            osBtn.addEventListener('click', async () => {
                const username = ($('qsOpenSubsUsername') || {}).value?.trim();
                const password = ($('qsOpenSubsPassword') || {}).value?.trim();
                const statusEl = $('qsOpenSubsStatus');
                if (!username || !password) {
                    showQsStatus(statusEl, tQs('status.enterCredentials', null, 'Please enter username and password'), 'error');
                    return;
                }
                await runQsValidation(osBtn, statusEl, '/api/validate-opensubtitles', { username, password });
            });
        }

        // SubDL test
        const subdlBtn = $('qsValidateSubDL');
        if (subdlBtn) {
            subdlBtn.addEventListener('click', async () => {
                const apiKey = ($('qsSubdlApiKey') || {}).value?.trim();
                const statusEl = $('qsSubDLStatus');
                if (!apiKey) {
                    showQsStatus(statusEl, tQs('status.enterKey', null, 'Please enter an API key'), 'error');
                    return;
                }
                await runQsValidation(subdlBtn, statusEl, '/api/validate-subdl', { apiKey });
            });
        }

        // SubSource test
        const ssBtn = $('qsValidateSubSource');
        if (ssBtn) {
            ssBtn.addEventListener('click', async () => {
                const apiKey = ($('qsSubsourceApiKey') || {}).value?.trim();
                const statusEl = $('qsSubSourceStatus');
                if (!apiKey) {
                    showQsStatus(statusEl, tQs('status.enterKey', null, 'Please enter an API key'), 'error');
                    return;
                }
                await runQsValidation(ssBtn, statusEl, '/api/validate-subsource', { apiKey });
            });
        }

        // Wyzie test
        const wyzieBtn = $('qsValidateWyzie');
        if (wyzieBtn) {
            wyzieBtn.addEventListener('click', async () => {
                const apiKey = ($('qsWyzieApiKey') || {}).value?.trim();
                const statusEl = $('qsWyzieStatus');
                if (!apiKey) {
                    showQsStatus(statusEl, tQs('status.enterKey', null, 'Please enter an API key'), 'error');
                    return;
                }
                await runQsValidation(wyzieBtn, statusEl, '/api/validate-wyzie', { apiKey });
            });
        }
    }
    // Step 3: AI Translation

    function wireStep3() {
        const keyInput = $('qsGeminiApiKey');
        const validateBtn = $('qsValidateGemini');
        const statusEl = $('qsGeminiKeyStatus');

        if (keyInput) {
            keyInput.addEventListener('input', () => {
                state.geminiApiKey = keyInput.value;
                state.geminiKeyValid = false;
                if (statusEl) { statusEl.textContent = ''; statusEl.className = 'qs-key-status'; }
                updateNav(3);
            });
        }

        if (validateBtn) {
            validateBtn.addEventListener('click', async () => {
                const key = keyInput ? keyInput.value.trim() : '';
                if (!key) {
                    showKeyStatus(tQs('status.enterKey', null, 'Please enter an API key'), 'error');
                    return;
                }

                showKeyStatus(tQs('status.validating', null, 'Validating...'), 'validating');
                validateBtn.disabled = true;

                try {
                    const resp = await fetch('/api/validate-gemini', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ apiKey: key })
                    });
                    const result = await resp.json();

                    if (result.valid) {
                        state.geminiKeyValid = true;
                        showKeyStatus(tQs('status.keyValid', null, '\u2713 API key is valid!'), 'success');
                    } else {
                        showKeyStatus(tQs('status.keyInvalidPrefix', null, '\u2717') + ' ' + (result.error || tQs('status.keyInvalidDefault', null, 'Invalid API key \u2014 please double-check')), 'error');
                    }
                } catch (err) {
                    showKeyStatus(tQs('status.networkError', null, '\u2717 Network error \u2014 try again'), 'error');
                } finally {
                    validateBtn.disabled = false;
                }
            });
        }
    }

    function showKeyStatus(message, type) {
        const statusEl = $('qsGeminiKeyStatus');
        if (!statusEl) return;
        statusEl.textContent = message;
        statusEl.className = 'qs-key-status';
        if (type) statusEl.classList.add(type);
    }
    // Generic Quick-Setup validation helpers

    function showQsStatus(el, message, type) {
        if (!el) return;
        el.textContent = message;
        el.className = 'qs-key-status';
        if (type) el.classList.add(type);
    }

    async function runQsValidation(btn, statusEl, endpoint, body) {
        btn.disabled = true;
        btn.classList.add('validating');
        btn.classList.remove('valid', 'invalid');
        const iconEl = btn.querySelector('.qs-validate-icon');
        const textEl = btn.querySelector('.qs-validate-text');
        const origIcon = iconEl ? iconEl.textContent : '\u2713';
        const origText = textEl ? textEl.textContent : '';
        if (iconEl) iconEl.textContent = '\u27F3';
        if (textEl) textEl.textContent = tQs('status.testingBtn', null, 'Testing...');
        showQsStatus(statusEl, tQs('status.validating', null, 'Validating...'), 'validating');

        try {
            const resp = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const result = await resp.json();

            btn.classList.remove('validating');
            btn.disabled = false;

            if (result.valid) {
                btn.classList.add('valid');
                if (iconEl) iconEl.textContent = '\u2713';
                if (textEl) textEl.textContent = tQs('status.validBtn', null, 'Valid');
                let msg = result.message || 'Valid!';
                if (result.resultsCount !== undefined) {
                    msg += ` (${result.resultsCount} test results)`;
                }
                showQsStatus(statusEl, '\u2713 ' + msg, 'success');
                setTimeout(() => {
                    btn.classList.remove('valid');
                    if (iconEl) iconEl.textContent = origIcon;
                    if (textEl) textEl.textContent = origText;
                }, 3000);
            } else {
                btn.classList.add('invalid');
                if (iconEl) iconEl.textContent = '\u2717';
                if (textEl) textEl.textContent = tQs('status.failedBtn', null, 'Failed');
                showQsStatus(statusEl, tQs('status.keyInvalidPrefix', null, '\u2717') + ' ' + (result.error || tQs('status.validationFailed', null, 'Validation failed')), 'error');
                setTimeout(() => {
                    btn.classList.remove('invalid');
                    if (iconEl) iconEl.textContent = origIcon;
                    if (textEl) textEl.textContent = origText;
                }, 4000);
            }
        } catch (err) {
            btn.classList.remove('validating');
            btn.disabled = false;
            if (iconEl) iconEl.textContent = origIcon;
            if (textEl) textEl.textContent = origText;
            showQsStatus(statusEl, tQs('status.networkError', null, '\u2717 Network error \u2014 try again'), 'error');
        }
    }
    // Step 4: Language Selection

    async function loadLanguages() {
        const maxRetries = 3;
        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const [providerResponse, translationResponse] = await Promise.all([
                    fetch('/api/languages', {
                        method: 'GET',
                        headers: { 'Accept': 'application/json' }
                    }),
                    fetch('/api/languages/translation', {
                        method: 'GET',
                        headers: { 'Accept': 'application/json' }
                    })
                ]);

                if (!providerResponse.ok) throw new Error(`HTTP ${providerResponse.status}`);
                if (!translationResponse.ok) throw new Error(`HTTP ${translationResponse.status}`);

                const providerPayload = await providerResponse.json();
                const translationPayload = await translationResponse.json();

                providerLanguages = dedupeLanguagesForUI(providerPayload.filter(lang => !lang.code.startsWith('___')));
                translationLanguages = dedupeLanguagesForUI(translationPayload.filter(lang => !lang.code.startsWith('___')));

                const combinedMap = new Map();
                providerLanguages.forEach(lang => combinedMap.set(lang.code, lang));
                translationLanguages.forEach(lang => combinedMap.set(lang.code, lang));
                allLanguages = Array.from(combinedMap.values()).sort((a, b) => a.name.localeCompare(b.name));
                languagesLoaded = true;

                updateSourceLanguageInfo();
                syncExtendedLanguageToggles(getExtendedLanguagesEnabled());
                renderLangGrid();
                renderLearnLangGrid();
                return;
            } catch (err) {
                lastError = err;
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 400 * attempt));
                }
            }
        }

        console.warn('[QuickSetup] Failed to load languages:', lastError);
    }

    function onEnterStep4() {
        // Update title based on mode
        const title = $('qsLangTitle');
        const subtitle = $('qsLangSubtitle');
        const srcInfo = $('qsSourceLangInfo');
        const instructionsLinkWrap = $('qsInstructionsLinkWrap');
        const extendedWrap = $('qsExtendedLanguagesWrap');

        if (state.mode === 'fetch') {
            if (title) title.textContent = tQs('step4.titleFetch', null, 'Choose Subtitle Languages');
            if (subtitle) subtitle.textContent = tQs('step4.subtitleFetch', null, 'What languages do you want to fetch subtitles in?');
            if (srcInfo) srcInfo.style.display = 'none';
            if (instructionsLinkWrap) instructionsLinkWrap.style.display = 'none';
            if (extendedWrap) extendedWrap.style.display = 'none';
        } else {
            if (title) title.textContent = tQs('step4.titleTranslate', null, 'Choose Your Target Language');
            if (subtitle) subtitle.textContent = tQs('step4.subtitleTranslate', null, 'What language do you want your subtitles translated to?');
            if (srcInfo) srcInfo.style.display = '';
            if (instructionsLinkWrap) instructionsLinkWrap.style.display = '';
            if (extendedWrap) extendedWrap.style.display = '';
        }

        updateSourceLanguageInfo();
        syncExtendedLanguageToggles(getExtendedLanguagesEnabled());
        renderLangGrid();
    }

    function renderLangGrid() {
        const grid = $('qsLangGrid');
        if (!grid) return;

        const searchInput = $('qsLangSearch');
        const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';

        grid.innerHTML = '';

        if (!languagesLoaded) {
            grid.innerHTML = `<div class="qs-lang-loading">${tQs('step4.loading', null, 'Loading languages...')}</div>`;
            // Retry after a short delay
            setTimeout(renderLangGrid, 500);
            return;
        }

        // Filter by search
        let filtered = getStep4Languages();
        if (searchTerm) {
            filtered = filtered.filter(lang =>
                lang.name.toLowerCase().includes(searchTerm) ||
                lang.code.toLowerCase().includes(searchTerm)
            );
        }

        // Sort: popular first, then alphabetical
        const popular = [];
        const rest = [];
        filtered.forEach(lang => {
            if (POPULAR_LANG_CODES.includes(lang.code)) {
                popular.push(lang);
            } else {
                rest.push(lang);
            }
        });

        // Render popular first
        [...popular, ...rest].forEach(lang => {
            const item = document.createElement('div');
            item.className = 'qs-lang-item';
            if (POPULAR_LANG_CODES.includes(lang.code)) {
                item.classList.add('popular');
            }
            if (state.selectedLanguages.includes(lang.code)) {
                item.classList.add('selected');
            }
            item.dataset.code = lang.code;
            item.textContent = `${lang.name} (${lang.code.toUpperCase()})`;
            item.addEventListener('click', () => toggleLang(lang.code, item));
            grid.appendChild(item);
        });

        // Update chips
        renderLangChips();
    }

    function toggleLang(code, el) {
        const idx = state.selectedLanguages.indexOf(code);

        if (idx > -1) {
            state.selectedLanguages.splice(idx, 1);
            el.classList.remove('selected');
        } else {
            const isTranslate = state.mode === 'translate';
            const canAdd = isTranslate
                ? canAddQuickSetupTargetLanguage(code, 'target')
                : state.selectedLanguages.length < MAX_NO_TRANSLATION_LANGUAGES;
            if (!canAdd) {
                flashLanguageGrid('qsLangGrid');
                return;
            }
            state.selectedLanguages.push(code);
            el.classList.add('selected');
        }

        renderLangChips();
        updateNav(4);
    }

    function appendLanguageChip(container, label, code) {
        const chip = document.createElement('span');
        chip.className = 'qs-lang-chip';
        chip.appendChild(document.createTextNode(label));

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'qs-lang-chip-remove';
        removeBtn.dataset.code = code;
        removeBtn.title = `Remove ${label}`;
        removeBtn.setAttribute('aria-label', `Remove ${label}`);
        removeBtn.textContent = '\u00D7';

        chip.appendChild(removeBtn);
        container.appendChild(chip);
    }

    function renderLangChips() {
        const container = $('qsSelectedLangs');
        if (!container) return;

        if (state.selectedLanguages.length === 0) {
            setQuickSetupEmptySelection(container, 'step4.noSelection', 'No languages selected yet');
            return;
        }

        container.innerHTML = '';
        state.selectedLanguages.forEach(code => {
            const lang = allLanguages.find(l => l.code === code);
            appendLanguageChip(container, lang ? lang.name : code, code);
        });

        // Wire remove buttons
        container.querySelectorAll('.qs-lang-chip-remove').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const code = btn.dataset.code;
                const idx = state.selectedLanguages.indexOf(code);
                if (idx > -1) state.selectedLanguages.splice(idx, 1);
                // Deselect in grid
                const gridItem = document.querySelector(`.qs-lang-item[data-code="${code}"]`);
                if (gridItem) gridItem.classList.remove('selected');
                renderLangChips();
                updateNav(4);
            });
        });
    }

    function wireStep4() {
        const searchInput = $('qsLangSearch');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                renderLangGrid();
            });
        }

        const instructionsBtn = $('qsOpenInstructionsBtn');
        if (instructionsBtn) {
            instructionsBtn.addEventListener('click', (e) => {
                e.preventDefault();
                openQuickSetupInstructions();
            });
        }

        const sourceChangeBtn = $('qsSourceLangChange');
        if (sourceChangeBtn) {
            sourceChangeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                handleOpenAdvanced({ focusLanguageCard: 'source' });
            });
        }

        const extendedToggle = $('qsExtendedLanguagesToggle');
        if (extendedToggle) {
            extendedToggle.checked = getExtendedLanguagesEnabled();
            extendedToggle.addEventListener('change', () => {
                setExtendedLanguagesEnabled(extendedToggle.checked);
            });
        }
    }
    // Step 5: Extras

    function wireStep5() {
        const toolboxToggle = $('qsSubToolbox');
        const seasonToggle = $('qsSeasonPacks');
        const sdhToggle = $('qsExcludeHI');
        const learnToggle = $('qsLearnMode');

        if (toolboxToggle) {
            toolboxToggle.checked = true;
            toolboxToggle.addEventListener('change', () => { state.subToolbox = toolboxToggle.checked; });
        }
        if (seasonToggle) {
            seasonToggle.checked = true;
            seasonToggle.addEventListener('change', () => { state.seasonPacks = seasonToggle.checked; });
        }
        if (sdhToggle) {
            sdhToggle.checked = false;
            sdhToggle.addEventListener('change', () => { state.hideSDH = sdhToggle.checked; });
        }
        if (learnToggle) {
            learnToggle.checked = false;
            learnToggle.addEventListener('change', () => {
                state.learnMode = learnToggle.checked;
                updateNav(5);
            });
        }
    }

    function onEnterStep5() {
        // Show/hide learn mode toggle based on mode
        const learnItem = $('qsLearnModeItem');
        if (learnItem) {
            learnItem.style.display = state.mode === 'translate' ? '' : 'none';
        }
    }
    // Step 6: Learn Language Selection

    function onEnterStep6Learn() {
        syncExtendedLanguageToggles(getExtendedLanguagesEnabled());
        renderLearnLangGrid();
    }

    function renderLearnLangGrid() {
        const grid = $('qsLearnLangGrid');
        if (!grid) return;

        const searchInput = $('qsLearnLangSearch');
        const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';

        grid.innerHTML = '';

        if (!languagesLoaded) {
            grid.innerHTML = `<div class="qs-lang-loading">${tQs('step4.loading', null, 'Loading languages...')}</div>`;
            setTimeout(renderLearnLangGrid, 500);
            return;
        }

        // Filter by search
        let filtered = getQuickSetupTranslationLanguages();
        if (searchTerm) {
            filtered = filtered.filter(lang =>
                lang.name.toLowerCase().includes(searchTerm) ||
                lang.code.toLowerCase().includes(searchTerm)
            );
        }

        filtered.forEach(lang => {
            const item = document.createElement('div');
            item.className = 'qs-lang-item';
            if (state.learnTargetLanguages.includes(lang.code)) {
                item.classList.add('selected');
            }
            item.dataset.code = lang.code;
            item.textContent = `${lang.name} (${lang.code.toUpperCase()})`;
            item.addEventListener('click', () => toggleLearnLang(lang.code, item));
            grid.appendChild(item);
        });

        renderLearnLangChips();
    }

    function toggleLearnLang(code, el) {
        const idx = state.learnTargetLanguages.indexOf(code);

        if (idx > -1) {
            state.learnTargetLanguages.splice(idx, 1);
            el.classList.remove('selected');
        } else {
            if (!canAddQuickSetupTargetLanguage(code, 'learn')) {
                flashLanguageGrid('qsLearnLangGrid');
                return;
            }
            state.learnTargetLanguages.push(code);
            el.classList.add('selected');
        }

        renderLearnLangChips();
        updateNav(6);
    }

    function renderLearnLangChips() {
        const container = $('qsSelectedLearnLangs');
        if (!container) return;

        if (state.learnTargetLanguages.length === 0) {
            setQuickSetupEmptySelection(container, 'step6.noSelection', 'No learn languages selected yet');
            return;
        }

        container.innerHTML = '';
        state.learnTargetLanguages.forEach(code => {
            const lang = allLanguages.find(l => l.code === code);
            appendLanguageChip(container, lang ? lang.name : code, code);
        });

        // Wire remove buttons
        container.querySelectorAll('.qs-lang-chip-remove').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const code = btn.dataset.code;
                const idx = state.learnTargetLanguages.indexOf(code);
                if (idx > -1) state.learnTargetLanguages.splice(idx, 1);
                const gridItem = document.querySelector(`#qsLearnLangGrid .qs-lang-item[data-code="${code}"]`);
                if (gridItem) gridItem.classList.remove('selected');
                renderLearnLangChips();
                updateNav(6);
            });
        });
    }

    function wireStep6Learn() {
        const searchInput = $('qsLearnLangSearch');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                renderLearnLangGrid();
            });
        }

        const extendedToggle = $('qsExtendedLanguagesToggleLearn');
        if (extendedToggle) {
            extendedToggle.checked = getExtendedLanguagesEnabled();
            extendedToggle.addEventListener('change', () => {
                setExtendedLanguagesEnabled(extendedToggle.checked);
            });
        }
    }
    // Step 7: Summary & Install

    function onEnterStep7() {
        // Read any remaining unsaved data
        readStepData(2);
        readStepData(3);
        readStepData(5);

        buildSummary();
        wireInstallButtons();
    }

    function buildSummary() {
        const summaryEl = $('qsSummary');
        if (!summaryEl) return;

        summaryEl.innerHTML = '';

        const items = [
            {
                icon: state.mode === 'translate' ? '\uD83C\uDF10' : '\uD83D\uDCE5',
                label: tQs('summary.mode', null, 'Mode'),
                value: state.mode === 'translate' ? tQs('summary.modeTranslate', null, 'Translate Subtitles') : tQs('summary.modeFetch', null, 'Just Fetch Subtitles'),
                cls: 'qs-on'
            },
            {
                icon: '\uD83C\uDFAC',
                label: 'OpenSubtitles',
                value: state.openSubsAuth ? tQs('summary.opensubsAuth', null, 'Auth (logged in)') : tQs('summary.opensubsV3', null, 'V3 (no login)'),
                cls: 'qs-on'
            }
        ];

        // Source providers
        if (state.subdlEnabled) {
            items.push({ icon: '\uD83D\uDCE5', label: 'SubDL', value: tQs('summary.enabled', null, 'Enabled'), cls: 'qs-on' });
        }
        if (state.subsourceEnabled) {
            items.push({ icon: '\uD83D\uDCE1', label: 'SubSource', value: tQs('summary.enabled', null, 'Enabled'), cls: 'qs-on' });
        }
        if (state.scsEnabled) {
            items.push({ icon: '\uD83C\uDF10', label: 'Stremio Community Subs', value: tQs('summary.scsTimeout', null, 'Enabled (30s timeout)'), cls: 'qs-on' });
        }
        if (state.wyzieEnabled) {
            const activeSources = Object.entries(state.wyzieSources).filter(([, v]) => v).map(([k]) => k);
            items.push({ icon: '\uD83D\uDD0D', label: 'Wyzie Subs', value: tQs('summary.wyzieSources', { count: activeSources.length }, `Enabled (${activeSources.length} sources)`), cls: 'qs-on' });
        }

        // AI
        if (state.mode === 'translate') {
            const defaultGeminiModelLabel = getQuickSetupGeminiModelLabel();
            items.push({
                icon: '\u2728',
                label: tQs('summary.aiTranslation', null, 'AI Translation'),
                value: state.geminiApiKey
                    ? tQs('summary.aiConfigured', { model: defaultGeminiModelLabel }, defaultGeminiModelLabel)
                    : tQs('summary.aiNotConfigured', null, 'Not configured'),
                cls: state.geminiApiKey ? 'qs-on' : 'qs-off'
            });
        }

        // Languages
        if (state.mode === 'translate') {
            const sourceNames = getQuickSetupSourceLanguages().map(getLanguageDisplayName);
            items.push({
                icon: '\uD83D\uDDE3\uFE0F',
                label: tQs('summary.sourceLanguages', null, 'Source Languages'),
                value: sourceNames.join(', ') || tQs('summary.none', null, 'None'),
                cls: sourceNames.length > 0 ? 'qs-on' : 'qs-off'
            });
        }

        const langNames = state.selectedLanguages.map(getLanguageDisplayName);
        items.push({
            icon: '\uD83C\uDFAF',
            label: state.mode === 'translate' ? tQs('summary.targetLanguages', null, 'Target Languages') : tQs('summary.subtitleLanguages', null, 'Subtitle Languages'),
            value: langNames.join(', ') || tQs('summary.none', null, 'None'),
            cls: langNames.length > 0 ? 'qs-on' : 'qs-off'
        });

        // Extras
        items.push({
            icon: '\uD83E\uDDF0',
            label: 'Sub Toolbox',
            value: state.subToolbox ? tQs('summary.enabled', null, 'Enabled') : tQs('summary.disabled', null, 'Disabled'),
            cls: state.subToolbox ? 'qs-on' : 'qs-off'
        });
        items.push({
            icon: '\uD83D\uDCE6',
            label: tQs('summary.seasonPacks', null, 'Season Packs'),
            value: state.seasonPacks ? tQs('summary.enabled', null, 'Enabled') : tQs('summary.disabled', null, 'Disabled'),
            cls: state.seasonPacks ? 'qs-on' : 'qs-off'
        });
        if (state.hideSDH) {
            items.push({
                icon: '\uD83D\uDD07',
                label: tQs('summary.hideSdh', null, 'Hide SDH/HI'),
                value: tQs('summary.enabled', null, 'Enabled'),
                cls: 'qs-on'
            });
        }

        // Learn mode
        if (state.learnMode && state.mode === 'translate') {
            const learnNames = state.learnTargetLanguages.map(getLanguageDisplayName);
            items.push({
                icon: '\uD83D\uDCD6',
                label: tQs('summary.learnLanguages', null, 'Learn Languages'),
                value: learnNames.join(', ') || tQs('summary.none', null, 'None'),
                cls: learnNames.length > 0 ? 'qs-on' : 'qs-off'
            });
        }

        items.forEach(item => {
            const row = document.createElement('div');
            row.className = 'qs-summary-item';
            row.innerHTML = `
                <span class="qs-summary-label">
                    <span>${item.icon}</span>
                    <span>${item.label}</span>
                </span>
                <span class="qs-summary-value ${item.cls}">${item.value}</span>
            `;
            summaryEl.appendChild(row);
        });
    }

    function wireInstallButtons() {
        const saveBtn = $('qsSaveInstallBtn');
        const advancedBtn = $('qsGoAdvanced');
        const copyBtn = $('qsCopyBtn');
        const installBtn = null; // Install happens via saveBtn
        const statusEl = $('qsInstallStatus');

        if (saveBtn) {
            // Remove old listeners by cloning
            const newBtn = saveBtn.cloneNode(true);
            saveBtn.parentNode.replaceChild(newBtn, saveBtn);
            newBtn.addEventListener('click', () => handleSaveAndInstall());
        }

        if (advancedBtn) {
            const newBtn = advancedBtn.cloneNode(true);
            advancedBtn.parentNode.replaceChild(newBtn, advancedBtn);
            newBtn.addEventListener('click', () => handleOpenAdvanced());
        }

        if (copyBtn) {
            const newCopy = copyBtn.cloneNode(true);
            copyBtn.parentNode.replaceChild(newCopy, copyBtn);
            newCopy.addEventListener('click', () => handleCopyUrl());
        }

        // Also wire the small copy button in the URL row
        const copyUrlRowBtn = $('qsCopyUrlBtn');
        if (copyUrlRowBtn) {
            const newUrlCopy = copyUrlRowBtn.cloneNode(true);
            copyUrlRowBtn.parentNode.replaceChild(newUrlCopy, copyUrlRowBtn);
            newUrlCopy.addEventListener('click', () => handleCopyUrl());
        }

        // Reset status
        if (statusEl) { statusEl.textContent = ''; statusEl.className = 'qs-install-status'; }

        // Hide URL box initially
        const urlBox = $('qsInstallUrlBox');
        if (urlBox) hide(urlBox);
    }

    function buildConfigObject() {
        sanitizeQuickSetupLanguageState();

        const isTranslate = state.mode === 'translate';
        const geminiModel = getQuickSetupGeminiModelValue();
        const geminiAdvancedDefaults = getQuickSetupGeminiAdvancedDefaults(geminiModel);
        const sourceLanguages = isTranslate ? getQuickSetupSourceLanguages() : [];

        // Start from default config shape
        const config = {
            noTranslationMode: !isTranslate,
            noTranslationLanguages: !isTranslate ? [...state.selectedLanguages] : [],
            sourceLanguages: [...sourceLanguages],
            targetLanguages: isTranslate ? [...state.selectedLanguages] : [],
            learnMode: isTranslate ? state.learnMode : false,
            learnTargetLanguages: (isTranslate && state.learnMode) ? [...state.learnTargetLanguages] : [],
            learnOrder: 'source-top',
            learnPlacement: 'top',
            learnItalic: true,
            learnItalicTarget: 'target',
            geminiApiKey: isTranslate ? state.geminiApiKey : '',
            geminiKeyRotationEnabled: false,
            geminiApiKeys: [],
            geminiKeyRotationMode: 'per-batch',
            assemblyAiApiKey: '',
            cloudflareWorkersApiKey: '',
            otherApiKeysEnabled: true,
            autoSubs: {
                defaultMode: 'cloudflare',
                sendFullVideoToAssembly: false
            },
            geminiModel,
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
            promptStyle: 'strict',
            subtitleProviders: {
                opensubtitles: {
                    enabled: true,
                    implementationType: state.openSubsAuth ? 'auth' : 'v3',
                    username: state.openSubsAuth ? state.openSubsUsername : '',
                    password: state.openSubsAuth ? state.openSubsPassword : ''
                },
                subdl: {
                    enabled: state.subdlEnabled,
                    apiKey: state.subdlApiKey
                },
                subsource: {
                    enabled: state.subsourceEnabled,
                    apiKey: state.subsourceApiKey
                },
                scs: { enabled: state.scsEnabled },
                wyzie: {
                    enabled: state.wyzieEnabled,
                    apiKey: (state.wyzieApiKey || getQuickSetupDefaultWyzieApiKey()).trim(),
                    sources: state.wyzieEnabled ? normalizeQuickSetupWyzieSources(state.wyzieSources) : undefined
                }
            },
            subtitleProviderTimeout: state.scsEnabled ? 30 : 12,
            translationCache: {
                enabled: true,
                duration: 0,
                persistent: true
            },
            bypassCache: false,
            bypassCacheConfig: {
                enabled: false,
                duration: 12
            },
            tempCache: {
                enabled: false,
                duration: 12
            },
            subToolboxEnabled: state.subToolbox,
            fileTranslationEnabled: state.subToolbox,
            syncSubtitlesEnabled: state.subToolbox,
            excludeHearingImpairedSubtitles: state.hideSDH,
            enableSeasonPacks: state.seasonPacks,
            forceSRTOutput: false,
            convertAssToVtt: true,
            mobileMode: false,
            singleBatchMode: false,
            advancedSettings: {
                enabled: false,
                geminiModel: '',
                thinkingBudget: geminiAdvancedDefaults.thinkingBudget,
                temperature: geminiAdvancedDefaults.temperature,
                topP: 0.95,
                topK: 40,
                enableBatchContext: false,
                contextSize: 8,
                sendTimestampsToAI: false,
                translationWorkflow: 'xml',
                enableJsonOutput: false,
                mismatchRetries: 1
            }
        };

        return config;
    }

    async function handleSaveAndInstall() {
        const statusEl = $('qsInstallStatus');
        const saveBtn = $('qsSaveInstallBtn');

        if (statusEl) {
            statusEl.textContent = tQs('status.saving', null, 'Saving configuration...');
            statusEl.className = 'qs-install-status saving';
        }
        if (saveBtn) saveBtn.disabled = true;

        try {
            // Get the "ideal" config structure from the wizard's state
            const qsConfig = buildConfigObject();

            // Check for existing session
            const existingToken = localStorage.getItem(TOKEN_KEY);
            const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
            let finalConfig = qsConfig;
            let targetToken = null;
            let isUpdate = false;

            // SAFE UPDATE LOGIC:
            // If we have a token, try to fetch its config and merge changes instead of destroying it
            if (existingToken && /^[a-f0-9]{32}$/.test(existingToken)) {
                try {
                    const fetchResp = await fetch(`/api/get-session/${existingToken}`);
                    if (fetchResp.ok) {
                        const fetchResult = await fetchResp.json();
                        if (fetchResult && fetchResult.config) {
                            console.log('[Safe Update] Found existing config, merging changes...');
                            const oldConfig = fetchResult.config;

                            // Start with the saved config, then reset the standard Quick Setup-controlled
                            // translation path so previous experimental/bypass-only settings do not leak through.
                            finalConfig = { ...oldConfig };

                            // 1. Overlay top-level QS settings
                            // Only include keys that the QS Wizard EXPLICITLY exposes or logically resets
                            const fastOverlayKeys = [
                                'noTranslationMode', 'noTranslationLanguages', 'sourceLanguages', 'targetLanguages',
                                'learnMode', 'learnTargetLanguages',
                                'geminiApiKey', 'geminiKeyRotationEnabled', // Force disable rotation if setting single key
                                'subToolboxEnabled', 'fileTranslationEnabled', 'syncSubtitlesEnabled',
                                'excludeHearingImpairedSubtitles', 'enableSeasonPacks'
                                // EXCLUDED (Preserve Advanced): learnOrder, learnPlacement, learnItalic, learnItalicTarget, subtitleProviderTimeout
                            ];
                            fastOverlayKeys.forEach(key => {
                                if (qsConfig[key] !== undefined) {
                                    finalConfig[key] = qsConfig[key];
                                }
                            });

                            // 2. Overlay Subtitle Providers (deep merge specific ones managed by QS)
                            // We explicitly update only the ones QS touches, preserving others if they exist
                            finalConfig.subtitleProviders = {
                                ...(finalConfig.subtitleProviders || {}),
                                opensubtitles: qsConfig.subtitleProviders.opensubtitles,
                                subdl: qsConfig.subtitleProviders.subdl,
                                subsource: qsConfig.subtitleProviders.subsource,
                                scs: qsConfig.subtitleProviders.scs,
                                wyzie: qsConfig.subtitleProviders.wyzie
                            };

                            // 3. Reset Quick Setup-owned translation behavior to the standard Gemini + database path.
                            finalConfig.betaModeEnabled = qsConfig.betaModeEnabled === true;
                            finalConfig.devMode = qsConfig.devMode === true;
                            finalConfig.parallelBatchesEnabled = false;
                            finalConfig.mobileMode = qsConfig.mobileMode === true;
                            finalConfig.singleBatchMode = qsConfig.singleBatchMode === true;
                            finalConfig.mainProvider = qsConfig.mainProvider || 'gemini';
                            finalConfig.multiProviderEnabled = false;
                            finalConfig.secondaryProviderEnabled = false;
                            finalConfig.secondaryProvider = '';
                            finalConfig.geminiModel = qsConfig.geminiModel || finalConfig.geminiModel || 'gemini-flash-latest';
                            finalConfig.advancedSettings = { ...qsConfig.advancedSettings };
                            finalConfig.translationCache = { ...qsConfig.translationCache };
                            finalConfig.bypassCache = false;
                            finalConfig.bypassCacheConfig = { ...qsConfig.bypassCacheConfig };
                            finalConfig.tempCache = { ...qsConfig.tempCache };
                            finalConfig.providers = { ...(finalConfig.providers || {}) };
                            if (qsConfig.providers && qsConfig.providers.googletranslate) {
                                finalConfig.providers.googletranslate = { ...qsConfig.providers.googletranslate };
                            }

                            targetToken = existingToken;
                            isUpdate = true;
                        }
                    }
                } catch (e) {
                    console.warn('[Safe Update] Failed to fetch existing config, falling back to new session', e);
                }
            }

            let data;

            if (isUpdate && targetToken) {
                // Update existing session
                const resp = await fetch(`/api/update-session/${targetToken}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(finalConfig)
                });

                if (!resp.ok) {
                    const errText = await resp.text();
                    throw new Error(`Update failed (${resp.status}): ${errText}`);
                }
                data = await resp.json();

                // If update returned a new token (e.g. expired), use it
                if (data.token) targetToken = data.token;

            } else {
                // Create new session (fallback or first time)
                const resp = await fetch('/api/create-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(finalConfig) // Use qsConfig or merged check? qsConfig is safest for new
                });

                if (!resp.ok) {
                    const errText = await resp.text();
                    throw new Error(`Creation failed (${resp.status}): ${errText}`);
                }
                data = await resp.json();
                targetToken = data.token;
            }

            if (!targetToken || !/^[a-f0-9]{32}$/.test(targetToken)) {
                throw new Error('Invalid session token from server');
            }

            // Store token
            localStorage.setItem(TOKEN_KEY, targetToken);

            // Mark QS as completed
            localStorage.setItem(QS_DISMISSED_KEY, 'true');

            // Clear session state since save succeeded
            try { sessionStorage.removeItem(QS_STATE_KEY); } catch (_) { }

            // Mark as saved so close/advanced triggers page reload
            hasSaved = true;

            // Try to cache the config (same key as config.js)
            try {
                localStorage.setItem('submaker_config_cache', JSON.stringify(finalConfig));
                localStorage.setItem('submaker_config_cache_token', targetToken);
                localStorage.setItem('submaker_config_cache_expiry', String(Date.now() + 24 * 60 * 60 * 1000));
            } catch (_) { /* ignore storage quota errors */ }

            // Build install URL
            const baseUrl = isLocalhost ? 'http://localhost:7001' : window.location.origin;
            const installUrl = `${baseUrl}/addon/${encodeURIComponent(targetToken)}/manifest.json`;

            // Store for buttons
            window.__qsInstallUrl = installUrl;

            // Show success
            if (statusEl) {
                statusEl.textContent = tQs('status.savedOk', null, '\u2713 Configuration saved successfully!');
                statusEl.className = 'qs-install-status success';
            }

            // Show URL box
            const urlBox = $('qsInstallUrlBox');
            const urlInput = $('qsInstallUrlDisplay');
            if (urlBox) show(urlBox);
            if (urlInput) {
                urlInput.value = installUrl;
                setTimeout(() => urlInput.select(), 100);
            }

            // Show copy button & change save button to Install
            const copyBtnEl = $('qsCopyBtn');
            if (copyBtnEl) show(copyBtnEl);

            // Transform save button into install button
            const saveBtnEl = $('qsSaveInstallBtn');
            if (saveBtnEl) {
                saveBtnEl.innerHTML = `<span class="qs-btn-icon">\uD83D\uDCE5</span> <span>${tQs('step7.installOnStremio', null, 'Install on Stremio')}</span>`;
                const newInstallBtn = saveBtnEl.cloneNode(true);
                saveBtnEl.parentNode.replaceChild(newInstallBtn, saveBtnEl);
                newInstallBtn.addEventListener('click', () => handleInstallStremio());
            }

            // Keep the banner visible (permanent entry point)
            // No need to toggle - banner always stays shown

        } catch (err) {
            if (statusEl) {
                statusEl.textContent = '\u2717 ' + err.message;
                statusEl.className = 'qs-install-status error';
            }
        } finally {
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    function handleCopyUrl() {
        const url = window.__qsInstallUrl;
        if (!url) return;

        navigator.clipboard.writeText(url).then(() => {
            const statusEl = $('qsInstallStatus');
            if (statusEl) {
                statusEl.textContent = tQs('status.copiedOk', null, '\u2713 Install URL copied to clipboard!');
                statusEl.className = 'qs-install-status success';
            }
        }).catch(() => {
            // Fallback
            const input = document.createElement('input');
            input.value = url;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);
        });
    }

    function handleInstallStremio() {
        const url = window.__qsInstallUrl;
        if (!url) return;
        const stremioUrl = url.replace(/^https?:\/\//i, 'stremio://');
        window.location.href = stremioUrl;

        const statusEl = $('qsInstallStatus');
        if (statusEl) {
            statusEl.textContent = tQs('status.openingStremio', null, 'Opening Stremio...');
            statusEl.className = 'qs-install-status saving';
        }
    }

    function handleOpenAdvanced(options = {}) {
        // Keep the banner visible (permanent entry point)
        localStorage.setItem(QS_DISMISSED_KEY, 'true');
        readStepData(state.currentStep);
        saveStateToSession();
        closeQuickSetupInstructions({ restoreFocus: false });

        if (hasSaved) {
            // Config was already saved to server - just reload to pick it up
            const overlay = $('quickSetupOverlay');
            if (overlay) overlay.classList.remove('active');
            document.body.style.overflow = '';
            window.location.reload();
            return;
        }

        // Build config and populate config.js form
        const config = buildConfigObject();

        // Share the config with config.js via a global
        window.__quickSetupConfig = config;

        // Close the wizard
        closeWizard();

        // Dispatch an event that config.js can listen for to load the config into the form
        window.dispatchEvent(new CustomEvent('quickSetupApply', { detail: config }));

        if (options.focusLanguageCard) {
            setTimeout(() => openMainConfigLanguageCard(options.focusLanguageCard), 0);
        }
    }
    // Reset UI

    function resetAllStepUIs() {
        // Step 1 - mode cards
        document.querySelectorAll('.qs-mode-card').forEach(c => c.classList.remove('selected'));
        // Step 2 - reset toggles and inputs
        const subdlCheck = $('qsEnableSubDL');
        const ssCheck = $('qsEnableSubSource');
        if (subdlCheck) subdlCheck.checked = false;
        if (ssCheck) ssCheck.checked = false;
        hide('qsSubdlKeyWrap');
        hide('qsSubsourceKeyWrap');
        hide('qsOpenSubsAuthFields');
        const scsCheck = $('qsEnableSCS');
        const wyzieCheck = $('qsEnableWyzie');
        if (scsCheck) scsCheck.checked = false;
        if (wyzieCheck) wyzieCheck.checked = false;
        hide('qsScsNote');
        hide('qsWyzieSources');
        const un = $('qsOpenSubsUsername');
        const pw = $('qsOpenSubsPassword');
        if (un) un.value = '';
        if (pw) pw.value = '';
        // Step 3 - reset key input
        const keyInput = $('qsGeminiApiKey');
        if (keyInput) keyInput.value = '';
        const keyStatus = $('qsGeminiKeyStatus');
        if (keyStatus) { keyStatus.textContent = ''; keyStatus.className = 'qs-key-status'; }
        ['qsOpenSubsStatus', 'qsSubDLStatus', 'qsSubSourceStatus', 'qsWyzieStatus'].forEach((id) => {
            const statusEl = $(id);
            if (statusEl) {
                statusEl.textContent = '';
                statusEl.className = 'qs-key-status';
            }
        });
        // Step 4 - clear language selection
        const searchInput = $('qsLangSearch');
        if (searchInput) searchInput.value = '';
        const selContainer = $('qsSelectedLangs');
        setQuickSetupEmptySelection(selContainer, 'step4.noSelection', 'No languages selected yet');
        syncExtendedLanguageToggles(getExtendedLanguagesEnabled());
        updateSourceLanguageInfo();
        // Step 5 - reset extras + learn mode
        const toolbox = $('qsSubToolbox');
        const season = $('qsSeasonPacks');
        const sdh = $('qsExcludeHI');
        const learnToggle = $('qsLearnMode');
        if (toolbox) toolbox.checked = true;
        if (season) season.checked = true;
        if (sdh) sdh.checked = false;
        if (learnToggle) learnToggle.checked = false;
        hide('qsLearnModeItem');
        // Step 6 - clear learn language selection
        const learnSearch = $('qsLearnLangSearch');
        if (learnSearch) learnSearch.value = '';
        const learnChips = $('qsSelectedLearnLangs');
        setQuickSetupEmptySelection(learnChips, 'step6.noSelection', 'No learn languages selected yet');
        // Step 7 - clear summary
        const summaryList = $('qsSummary');
        if (summaryList) summaryList.innerHTML = '';
        const installStatus = $('qsInstallStatus');
        if (installStatus) { installStatus.textContent = ''; installStatus.className = 'qs-install-status'; }
        hide('qsInstallUrlBox');

        // Reset progress
        const bar = $('qsProgressFill');
        if (bar) bar.style.width = '0%';
    }
    // Session State Persistence

    function saveStateToSession() {
        try {
            sessionStorage.setItem(QS_STATE_KEY, JSON.stringify(state));
        } catch (_) { /* quota errors */ }
    }

    function restoreStateFromSession() {
        try {
            const raw = sessionStorage.getItem(QS_STATE_KEY);
            if (!raw) return false;
            const saved = JSON.parse(raw);

            // Restore state fields
            Object.assign(state, saved);
            sanitizeQuickSetupLanguageState();

            // Restore UI to match state
            restoreUIFromState();
            return true;
        } catch (_) {
            return false;
        }
    }

    function mapConfigToState(config) {
        if (!config) return;

        // Mode
        state.mode = config.noTranslationMode ? 'fetch' : 'translate';

        // Subtitle Providers
        const subs = config.subtitleProviders || {};

        // OpenSubtitles
        const os = subs.opensubtitles || {};
        state.openSubsAuth = os.implementationType === 'auth';
        state.openSubsUsername = os.username || '';
        state.openSubsPassword = os.password || '';

        // SubDL
        const subdl = subs.subdl || {};
        state.subdlEnabled = !!subdl.enabled;
        state.subdlApiKey = subdl.apiKey || '';

        // SubSource
        const ss = subs.subsource || {};
        state.subsourceEnabled = !!ss.enabled;
        state.subsourceApiKey = ss.apiKey || '';

        // SCS
        const scs = subs.scs || {};
        state.scsEnabled = !!scs.enabled;

        // Wyzie
        const wyzie = subs.wyzie || {};
        state.wyzieEnabled = !!wyzie.enabled;
        state.wyzieApiKey = (wyzie.apiKey || '').trim() || getQuickSetupDefaultWyzieApiKey();
        state.wyzieSources = normalizeQuickSetupWyzieSources(wyzie.sources || getDefaultQuickSetupWyzieSources());

        // AI
        state.geminiApiKey = config.geminiApiKey || '';
        // If key exists, assume valid or let them re-validate
        state.geminiKeyValid = !!state.geminiApiKey;

        // Languages
        const langs = state.mode === 'translate' ? config.targetLanguages : config.noTranslationLanguages;
        state.sourceLanguages = config.sourceLanguages;
        state.selectedLanguages = langs;

        // Extras
        state.subToolbox = config.subToolboxEnabled !== false; // Default true if undefined/null?
        state.seasonPacks = config.enableSeasonPacks !== false;
        state.hideSDH = !!config.excludeHearingImpairedSubtitles;

        // Learn Mode
        state.learnMode = !!config.learnMode;
        state.learnTargetLanguages = config.learnTargetLanguages;
        sanitizeQuickSetupLanguageState();

        // Current step will be set by caller
    }

    function resetState() {
        state.currentStep = 1;
        state.mode = null; // Forces user to pick
        state.openSubsAuth = false;
        state.openSubsUsername = '';
        state.openSubsPassword = '';
        state.subdlEnabled = false;
        state.subdlApiKey = '';
        state.subsourceEnabled = false;
        state.subsourceApiKey = '';
        state.scsEnabled = false;
        state.wyzieEnabled = false;
        state.wyzieApiKey = getQuickSetupDefaultWyzieApiKey();
        state.wyzieSources = getDefaultQuickSetupWyzieSources();
        state.geminiApiKey = '';
        state.geminiKeyValid = false;
        state.sourceLanguages = ['eng'];
        state.selectedLanguages = [];
        state.subToolbox = true;
        state.seasonPacks = true;
        state.hideSDH = false;
        state.learnMode = false;
        state.learnTargetLanguages = [];
    }

    function restoreUIFromState() {
        // Step 1 - mode cards
        document.querySelectorAll('.qs-mode-card').forEach(c => {
            c.classList.toggle('selected', c.dataset.mode === state.mode);
        });
        // Step 2 - checkboxes and inputs
        const subdlCheck = $('qsEnableSubDL');
        const ssCheck = $('qsEnableSubSource');
        const scsCheck = $('qsEnableSCS');
        const wyzieCheck = $('qsEnableWyzie');
        if (subdlCheck) subdlCheck.checked = state.subdlEnabled;
        if (ssCheck) ssCheck.checked = state.subsourceEnabled;
        if (scsCheck) scsCheck.checked = state.scsEnabled;
        if (wyzieCheck) wyzieCheck.checked = state.wyzieEnabled;

        const subdlWrap = $('qsSubdlKeyWrap');
        const ssWrap = $('qsSubsourceKeyWrap');
        const scsNote = $('qsScsNote');
        const wyzieSources = $('qsWyzieSources');
        if (subdlWrap) subdlWrap.style.display = state.subdlEnabled ? '' : 'none';
        if (ssWrap) ssWrap.style.display = state.subsourceEnabled ? '' : 'none';
        if (scsNote) scsNote.style.display = state.scsEnabled ? '' : 'none';
        if (wyzieSources) wyzieSources.style.display = state.wyzieEnabled ? '' : 'none';

        const subdlKey = $('qsSubdlApiKey');
        const ssKey = $('qsSubsourceApiKey');
        const wyzieKey = $('qsWyzieApiKey');
        if (subdlKey) subdlKey.value = state.subdlApiKey || '';
        if (ssKey) ssKey.value = state.subsourceApiKey || '';
        if (wyzieKey) wyzieKey.value = state.wyzieApiKey || getQuickSetupDefaultWyzieApiKey();

        const un = $('qsOpenSubsUsername');
        const pw = $('qsOpenSubsPassword');
        if (un) un.value = state.openSubsUsername || '';
        if (pw) pw.value = state.openSubsPassword || '';
        if (state.openSubsAuth || state.openSubsUsername || state.openSubsPassword) {
            const authFields = $('qsOpenSubsAuthFields');
            if (authFields) authFields.style.display = '';
        }

        // Wyzie sub-sources
        const wyzieSourceState = normalizeQuickSetupWyzieSources(state.wyzieSources || getDefaultQuickSetupWyzieSources());
        state.wyzieSources = wyzieSourceState;
        const ids = { subf2m: 'qsWyzieSubf2m', podnapisi: 'qsWyziePodnapisi', gestdown: 'qsWyzieGestdown', animetosho: 'qsWyzieAnimetosho', opensubtitles: 'qsWyzieOpensubs', subdl: 'qsWyzieSubdl', kitsunekko: 'qsWyzieKitsunekko', jimaku: 'qsWyzieJimaku', yify: 'qsWyzieYify' };
        for (const [key, id] of Object.entries(ids)) {
            const el = $(id);
            if (el) el.checked = !!wyzieSourceState[key];
        }
        // Step 3 - Gemini key
        const geminiKey = $('qsGeminiApiKey');
        if (geminiKey) geminiKey.value = state.geminiApiKey || '';
        // Step 5 - extras
        const toolbox = $('qsSubToolbox');
        const season = $('qsSeasonPacks');
        const sdh = $('qsExcludeHI');
        const learnToggle = $('qsLearnMode');
        if (toolbox) toolbox.checked = state.subToolbox;
        if (season) season.checked = state.seasonPacks;
        if (sdh) sdh.checked = state.hideSDH;
        if (learnToggle) learnToggle.checked = state.learnMode;
        syncExtendedLanguageToggles(getExtendedLanguagesEnabled());
        updateSourceLanguageInfo();
    }
    // Boot

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
