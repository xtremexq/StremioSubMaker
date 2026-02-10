/* ═══════════════════════════════════════════════════════
   Config V2 — Standalone JS
   ═══════════════════════════════════════════════════════ */
(function () {
    'use strict';

    // ── Constants ───────────────────────────────────────
    const TOKEN_KEY = 'config_session_token';
    const CACHE_KEY = 'config_cache';
    const V2_THEME_KEY = 'v2-theme';
    const MAX_SOURCE = 20;
    const MAX_TARGET = 10;
    const MAX_NO_TRANS = 30;

    // ── State ───────────────────────────────────────────
    let allLanguages = [];
    let cfg = getDefaults();

    function getDefaults() {
        return {
            noTranslationMode: false,
            noTranslationLanguages: [],
            sourceLanguages: ['eng'],
            targetLanguages: [],
            learnMode: false,
            learnTargetLanguages: [],
            learnOrder: 'source-top',
            learnPlacement: 'top',
            learnItalic: true,
            learnItalicTarget: 'target',
            geminiApiKey: '',
            geminiKeyRotationEnabled: false,
            geminiApiKeys: [],
            geminiKeyRotationMode: 'per-batch',
            geminiModel: 'gemini-3-flash-preview',
            promptStyle: 'natural',
            translationPrompt: '',
            assemblyAiApiKey: '',
            betaModeEnabled: false,
            multiProviderEnabled: false,
            mainProvider: 'gemini',
            secondaryProviderEnabled: false,
            secondaryProvider: '',
            providers: {},
            providerParameters: {},
            subtitleProviders: {
                opensubtitles: { enabled: true, implementationType: 'v3', username: '', password: '' },
                subdl: { enabled: false, apiKey: '' },
                subsource: { enabled: false, apiKey: '' },
                scs: { enabled: false },
                wyzie: { enabled: false, sources: { subf2m: true, podnapisi: true, gestdown: true, animetosho: true, opensubtitles: false, subdl: false } },
                subsro: { enabled: false, apiKey: '' }
            },
            subtitleProviderTimeout: 12,
            subToolboxEnabled: true,
            mobileMode: false,
            singleBatchMode: false,
            excludeHearingImpairedSubtitles: false,
            enableSeasonPacks: true,
            forceSRTOutput: false,
            convertAssToVtt: true,
            bypassCache: false,
            translationCache: { enabled: true, duration: 0, persistent: true },
            advancedSettings: {
                enabled: false,
                geminiModel: '',
                thinkingBudget: 0,
                temperature: 0.8,
                topP: 0.95,
                topK: 40,
                enableBatchContext: false,
                contextSize: 3,
                translationWorkflow: 'xml',
                enableJsonOutput: false,
                mismatchRetries: 1
            }
        };
    }

    // ── Helpers ─────────────────────────────────────────
    const $ = (id) => document.getElementById(id);
    const $$ = (sel) => document.querySelectorAll(sel);
    const isValidToken = (t) => /^[a-f0-9]{32}$/.test(t);

    // ── Theme ───────────────────────────────────────────
    function initTheme() {
        const saved = localStorage.getItem(V2_THEME_KEY);
        let theme = saved || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
        applyTheme(theme);
        $$('.v2-theme-btn').forEach(btn => {
            btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
        });
        // System listener
        matchMedia('(prefers-color-scheme:dark)').addEventListener('change', e => {
            if (!localStorage.getItem(V2_THEME_KEY)) applyTheme(e.matches ? 'dark' : 'light');
        });
    }

    function applyTheme(t) {
        document.documentElement.setAttribute('data-v2-theme', t);
        localStorage.setItem(V2_THEME_KEY, t);
        $$('.v2-theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === t));
    }

    // ── Sections (collapse/expand) ──────────────────────
    function initSections() {
        $$('.v2-section-header').forEach(h => {
            h.addEventListener('click', () => h.parentElement.classList.toggle('open'));
        });
        // Open first 3 sections by default
        $$('.v2-section').forEach((s, i) => { if (i < 3) s.classList.add('open'); });
    }

    // ── Toggles (show/hide sub-groups) ──────────────────
    function wire(checkboxId, bodyId) {
        const cb = $(checkboxId);
        const body = $(bodyId);
        if (!cb || !body) return;
        const update = () => body.classList.toggle('hidden', !cb.checked);
        cb.addEventListener('change', update);
        update();
    }

    function initToggles() {
        wire('v2-opensubsAuth', 'v2-opensubsFields');
        wire('v2-enableSubdl', 'v2-subdlBody');
        wire('v2-enableSubsource', 'v2-subsourceBody');
        wire('v2-enableWyzie', 'v2-wyzieBody');
        wire('v2-enableSCS', 'v2-scsBody');
        wire('v2-keyRotation', 'v2-keyRotationBody');
        wire('v2-multiProvider', 'v2-multiProviderBody');
        wire('v2-enableOpenai', 'v2-openaiBody');
        wire('v2-enableAnthropic', 'v2-anthropicBody');
        wire('v2-enableXai', 'v2-xaiBody');
        wire('v2-enableDeepseek', 'v2-deepseekBody');
        wire('v2-enableDeepl', 'v2-deeplBody');
        wire('v2-enableMistral', 'v2-mistralBody');
        wire('v2-enableCfworkers', 'v2-cfworkersBody');
        wire('v2-enableOpenrouter', 'v2-openrouterBody');
        wire('v2-enableCustom', 'v2-customBody');
        wire('v2-learnMode', 'v2-learnModeBody');
        wire('v2-learnItalic', 'v2-learnItalicTarget');
        wire('v2-batchContext', 'v2-contextSizeBody');
        wire('v2-betaMode', 'v2-advancedSection');

        // No-translation mode toggles
        const noTrans = $('v2-noTranslation');
        if (noTrans) {
            noTrans.addEventListener('change', () => {
                cfg.noTranslationMode = noTrans.checked;
                updateModeVisibility();
            });
        }

        // Learn mode shows/hides learn language grid
        const learnMode = $('v2-learnMode');
        if (learnMode) {
            learnMode.addEventListener('change', () => {
                cfg.learnMode = learnMode.checked;
                const block = $('v2-learnLangBlock');
                if (block) block.classList.toggle('v2-hidden', !learnMode.checked);
            });
        }
    }

    function updateModeVisibility() {
        const noTrans = cfg.noTranslationMode;
        const aiSection = $('v2-aiSection');
        const transSection = $('v2-translationSection');
        const advSection = $('v2-advancedSection');
        const noTransBlock = $('v2-noTransLangBlock');
        const srcBlock = $('v2-sourceLangBlock');
        const tgtBlock = $('v2-targetLangBlock');
        const learnBlock = $('v2-learnLangBlock');
        const divider = $('v2-transLangDivider');

        if (aiSection) aiSection.classList.toggle('v2-hidden', noTrans);
        if (transSection) transSection.classList.toggle('v2-hidden', noTrans);
        // Advanced section visibility: only show when betaMode enabled AND not noTrans
        if (advSection) {
            const beta = $('v2-betaMode');
            advSection.classList.toggle('v2-hidden', noTrans || !(beta && beta.checked));
        }

        if (noTransBlock) noTransBlock.classList.toggle('v2-hidden', !noTrans);
        if (srcBlock) srcBlock.classList.toggle('v2-hidden', noTrans);
        if (tgtBlock) tgtBlock.classList.toggle('v2-hidden', noTrans);
        if (learnBlock) learnBlock.classList.toggle('v2-hidden', noTrans || !cfg.learnMode);
        if (divider) divider.classList.toggle('v2-hidden', noTrans);
    }

    // ── Password toggles ───────────────────────────────
    function initPasswordToggles() {
        $$('.v2-pw-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const inp = btn.parentElement.querySelector('.v2-input');
                if (!inp) return;
                const show = inp.type === 'password';
                inp.type = show ? 'text' : 'password';
                btn.textContent = show ? '🙈' : '👁';
            });
        });
    }

    // ── Range sliders ───────────────────────────────────
    function initRanges() {
        const timeout = $('v2-providerTimeout');
        const val = $('v2-providerTimeoutVal');
        if (timeout && val) {
            timeout.addEventListener('input', () => { val.textContent = timeout.value + 's'; });
        }
    }

    // ── Additional Gemini Keys ──────────────────────────
    function initAdditionalKeys() {
        const addBtn = $('v2-addKey');
        if (addBtn) addBtn.addEventListener('click', () => addKeyRow(''));
    }

    function addKeyRow(value) {
        const list = $('v2-additionalKeys');
        if (!list) return;
        const row = document.createElement('div');
        row.className = 'v2-key-row';
        row.innerHTML = `<input type="text" class="v2-input v2-masked" value="${escapeAttr(value)}" placeholder="Additional Gemini key" autocomplete="off"><button class="v2-key-remove" type="button" title="Remove">✕</button>`;
        row.querySelector('.v2-key-remove').addEventListener('click', () => row.remove());
        list.appendChild(row);
    }

    function getAdditionalKeys() {
        const rows = $$('#v2-additionalKeys .v2-key-row .v2-input');
        return Array.from(rows).map(i => i.value.trim()).filter(Boolean);
    }

    // ── Language Grids ──────────────────────────────────
    async function loadLanguages() {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const ctrl = new AbortController();
                const tid = setTimeout(() => ctrl.abort(), 10000);
                const resp = await fetch('/api/languages', { signal: ctrl.signal });
                clearTimeout(tid);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                allLanguages = dedupeLanguages(data.filter(l => !l.code.startsWith('___')));
                renderGrid('v2-noTransGrid', 'noTranslationLanguages');
                renderGrid('v2-sourceGrid', 'sourceLanguages');
                renderGrid('v2-targetGrid', 'targetLanguages');
                renderGrid('v2-learnGrid', 'learnTargetLanguages');
                updateAllPills();
                return;
            } catch (_) {
                if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1000));
            }
        }
        showToast('Failed to load languages. Please refresh.', 'error');
    }

    function dedupeLanguages(langs) {
        const byName = new Map();
        langs.forEach(l => {
            let { code, name } = l;
            const lName = (name || '').toLowerCase();
            const lCode = (code || '').toLowerCase();
            if ((lName.includes('portuguese') && lName.includes('brazil')) || lCode === 'ptbr' || lCode === 'pt-br') {
                name = 'Portuguese (Brazil)'; code = 'pob';
            }
            if (!byName.has(name)) byName.set(name, { ...l, code, name });
            else if (name === 'Portuguese (Brazil)' && byName.get(name).code !== 'pob') {
                byName.set(name, { ...byName.get(name), code: 'pob', name });
            }
        });
        return Array.from(byName.values());
    }

    function renderGrid(gridId, cfgKey) {
        const grid = $(gridId);
        if (!grid) return;
        grid.innerHTML = '';
        const selected = cfg[cfgKey] || [];
        allLanguages.forEach(lang => {
            const item = document.createElement('div');
            item.className = 'v2-lang-item' + (selected.includes(lang.code) ? ' selected' : '');
            item.dataset.code = lang.code;
            item.dataset.name = lang.name.toLowerCase();
            item.innerHTML = `<span class="v2-lang-name">${escapeHtml(lang.name)}</span>`;
            item.addEventListener('click', () => toggleLang(gridId, cfgKey, lang.code, item));
            grid.appendChild(item);
        });
    }

    function toggleLang(gridId, cfgKey, code, el) {
        const arr = cfg[cfgKey];
        const idx = arr.indexOf(code);
        if (idx > -1) {
            arr.splice(idx, 1);
            el.classList.remove('selected');
        } else {
            const maxMap = { noTranslationLanguages: MAX_NO_TRANS, sourceLanguages: MAX_SOURCE, targetLanguages: MAX_TARGET, learnTargetLanguages: MAX_TARGET };
            const max = maxMap[cfgKey] || 50;
            if (arr.length >= max) { showToast(`Max ${max} languages`, 'warning'); return; }
            arr.push(code);
            el.classList.add('selected');
        }
        updatePills(cfgKey);
    }

    function updateAllPills() {
        updatePills('noTranslationLanguages');
        updatePills('sourceLanguages');
        updatePills('targetLanguages');
        updatePills('learnTargetLanguages');
    }

    function updatePills(cfgKey) {
        const map = {
            noTranslationLanguages: { pills: 'v2-noTransPills', grid: 'v2-noTransGrid' },
            sourceLanguages: { pills: 'v2-sourcePills', grid: 'v2-sourceGrid' },
            targetLanguages: { pills: 'v2-targetPills', grid: 'v2-targetGrid' },
            learnTargetLanguages: { pills: 'v2-learnPills', grid: 'v2-learnGrid' }
        };
        const m = map[cfgKey];
        if (!m) return;
        const container = $(m.pills);
        if (!container) return;
        container.innerHTML = '';
        (cfg[cfgKey] || []).forEach(code => {
            const lang = allLanguages.find(l => l.code === code);
            if (!lang) return;
            const pill = document.createElement('span');
            pill.className = 'v2-lang-pill';
            pill.innerHTML = `${escapeHtml(lang.name)} <span class="v2-lang-pill-x">✕</span>`;
            pill.addEventListener('click', () => {
                const idx = cfg[cfgKey].indexOf(code);
                if (idx > -1) cfg[cfgKey].splice(idx, 1);
                // Update grid item
                const gridEl = $(m.grid);
                if (gridEl) {
                    const item = gridEl.querySelector(`[data-code="${code}"]`);
                    if (item) item.classList.remove('selected');
                }
                updatePills(cfgKey);
            });
            container.appendChild(pill);
        });
    }

    // Language search
    function initLangSearch() {
        const pairs = [
            ['v2-noTransSearch', 'v2-noTransGrid'],
            ['v2-sourceSearch', 'v2-sourceGrid'],
            ['v2-targetSearch', 'v2-targetGrid'],
            ['v2-learnSearch', 'v2-learnGrid']
        ];
        pairs.forEach(([searchId, gridId]) => {
            const input = $(searchId);
            if (!input) return;
            input.addEventListener('input', () => {
                const q = input.value.toLowerCase().trim();
                const grid = $(gridId);
                if (!grid) return;
                grid.querySelectorAll('.v2-lang-item').forEach(item => {
                    item.classList.toggle('hidden', q && !item.dataset.name.includes(q) && !item.dataset.code.includes(q));
                });
            });
        });
    }

    // ── Load Config ─────────────────────────────────────
    async function loadConfig() {
        const token = localStorage.getItem(TOKEN_KEY);
        if (!token || !isValidToken(token)) return;
        try {
            const resp = await fetch(`/api/get-session/${encodeURIComponent(token)}`);
            if (!resp.ok) return;
            const data = await resp.json();
            if (data && data.config) {
                cfg = { ...getDefaults(), ...data.config };
                if (!cfg.noTranslationLanguages) cfg.noTranslationLanguages = [];
                if (!cfg.sourceLanguages) cfg.sourceLanguages = ['eng'];
                if (!cfg.targetLanguages) cfg.targetLanguages = [];
                if (!cfg.learnTargetLanguages) cfg.learnTargetLanguages = [];
                if (!cfg.advancedSettings) cfg.advancedSettings = getDefaults().advancedSettings;
            }
        } catch (_) { }
    }

    function applyConfigToForm() {
        // No-translation mode
        setCheck('v2-noTranslation', cfg.noTranslationMode);

        // Subtitle providers
        setCheck('v2-opensubsAuth', cfg.subtitleProviders?.opensubtitles?.implementationType === 'auth');
        setVal('v2-opensubsUser', cfg.subtitleProviders?.opensubtitles?.username || '');
        setVal('v2-opensubsPass', cfg.subtitleProviders?.opensubtitles?.password || '');
        setCheck('v2-enableSubdl', cfg.subtitleProviders?.subdl?.enabled);
        setVal('v2-subdlKey', cfg.subtitleProviders?.subdl?.apiKey || '');
        setCheck('v2-enableSubsource', cfg.subtitleProviders?.subsource?.enabled);
        setVal('v2-subsourceKey', cfg.subtitleProviders?.subsource?.apiKey || '');
        setCheck('v2-enableWyzie', cfg.subtitleProviders?.wyzie?.enabled);
        const ws = cfg.subtitleProviders?.wyzie?.sources || {};
        setCheck('v2-wyzieSubf2m', ws.subf2m);
        setCheck('v2-wyziePodnapisi', ws.podnapisi);
        setCheck('v2-wyzieGestdown', ws.gestdown);
        setCheck('v2-wyzieAnimetosho', ws.animetosho);
        setCheck('v2-wyzieOpensubs', ws.opensubtitles);
        setCheck('v2-wyzieSubdl', ws.subdl);
        setCheck('v2-enableSCS', cfg.subtitleProviders?.scs?.enabled);
        setCheck('v2-enableSubsro', cfg.subtitleProviders?.subsro?.enabled);

        // Provider timeout
        const timeout = $('v2-providerTimeout');
        const timeoutVal = $('v2-providerTimeoutVal');
        if (timeout) { timeout.value = Math.max(5, Math.min(60, cfg.subtitleProviderTimeout || 12)); }
        if (timeoutVal) { timeoutVal.textContent = (timeout ? timeout.value : 12) + 's'; }

        // AI Translation
        setVal('v2-geminiKey', cfg.geminiApiKey || '');
        setCheck('v2-keyRotation', cfg.geminiKeyRotationEnabled);
        // Additional keys
        const addKeys = Array.isArray(cfg.geminiApiKeys) ? cfg.geminiApiKeys.slice(1) : [];
        addKeys.forEach(k => addKeyRow(k));
        setVal('v2-rotationFreq', cfg.geminiKeyRotationMode || 'per-batch');

        // Multi-provider
        setCheck('v2-multiProvider', cfg.multiProviderEnabled);
        const prov = cfg.providers || {};
        setCheck('v2-enableOpenai', prov.openai?.enabled);
        setVal('v2-openaiKey', prov.openai?.apiKey || '');
        setVal('v2-openaiModel', prov.openai?.model || '');
        setVal('v2-openaiEndpoint', prov.openai?.endpoint || '');
        setCheck('v2-enableAnthropic', prov.anthropic?.enabled);
        setVal('v2-anthropicKey', prov.anthropic?.apiKey || '');
        setVal('v2-anthropicModel', prov.anthropic?.model || '');
        setCheck('v2-enableXai', prov.xai?.enabled);
        setVal('v2-xaiKey', prov.xai?.apiKey || '');
        setCheck('v2-enableDeepseek', prov.deepseek?.enabled);
        setVal('v2-deepseekKey', prov.deepseek?.apiKey || '');
        setCheck('v2-enableDeepl', prov.deepl?.enabled);
        setVal('v2-deeplKey', prov.deepl?.apiKey || '');
        setCheck('v2-enableMistral', prov.mistral?.enabled);
        setVal('v2-mistralKey', prov.mistral?.apiKey || '');
        setCheck('v2-enableCfworkers', prov.cloudflare_workers?.enabled);
        setVal('v2-cfworkersKey', prov.cloudflare_workers?.apiKey || '');
        setCheck('v2-enableOpenrouter', prov.openrouter?.enabled);
        setVal('v2-openrouterKey', prov.openrouter?.apiKey || '');
        setVal('v2-openrouterModel', prov.openrouter?.model || '');
        setCheck('v2-enableGoogleTranslate', prov.google_translate?.enabled !== false);
        setCheck('v2-enableCustom', prov.custom?.enabled);
        setVal('v2-customKey', prov.custom?.apiKey || '');
        setVal('v2-customEndpoint', prov.custom?.endpoint || '');
        setVal('v2-customModel', prov.custom?.model || '');

        setVal('v2-assemblyaiKey', cfg.assemblyAiApiKey || '');

        // Translation settings
        setVal('v2-promptStyle', cfg.promptStyle || 'natural');
        setVal('v2-workflowMode', cfg.singleBatchMode ? 'single' : 'chunked');
        setVal('v2-chunkSize', cfg.advancedSettings?.chunkSize || 40);
        const dbMode = cfg.bypassCache ? 'bypass' : (cfg.translationCache?.enabled === false ? 'bypass' : 'shared');
        setVal('v2-dbMode', dbMode);
        setCheck('v2-bypassCache', cfg.bypassCache);

        // Other settings
        setCheck('v2-subToolbox', cfg.subToolboxEnabled);
        setCheck('v2-learnMode', cfg.learnMode);
        const orderRadio = document.querySelector(`input[name="v2-learnOrder"][value="${cfg.learnOrder || 'source-top'}"]`);
        if (orderRadio) orderRadio.checked = true;
        setCheck('v2-learnItalic', cfg.learnItalic !== false);
        const italicTarget = document.querySelector(`input[name="v2-learnItalicTarget"][value="${cfg.learnItalicTarget || 'target'}"]`);
        if (italicTarget) italicTarget.checked = true;
        setCheck('v2-mobileMode', cfg.mobileMode);
        setCheck('v2-seasonPacks', cfg.enableSeasonPacks !== false);
        setCheck('v2-excludeHI', cfg.excludeHearingImpairedSubtitles);
        setCheck('v2-forceSRT', cfg.forceSRTOutput);
        setCheck('v2-convertAss', cfg.convertAssToVtt !== false);
        setCheck('v2-betaMode', cfg.betaModeEnabled);

        // Advanced
        const adv = cfg.advancedSettings || {};
        setCheck('v2-batchContext', adv.enableBatchContext);
        setVal('v2-contextSize', adv.contextSize || 3);
        setVal('v2-mismatchRetries', adv.mismatchRetries ?? 1);
        setCheck('v2-jsonOutput', adv.enableJsonOutput);
        setVal('v2-advThinking', adv.thinkingBudget ?? 0);
        setVal('v2-advTemp', adv.temperature ?? 0.8);
        setVal('v2-advTopP', adv.topP ?? 0.95);

        // Update visibility
        updateModeVisibility();
        // Re-trigger all wire toggles
        ['v2-opensubsAuth', 'v2-enableSubdl', 'v2-enableSubsource', 'v2-enableWyzie', 'v2-enableSCS',
            'v2-keyRotation', 'v2-multiProvider', 'v2-enableOpenai', 'v2-enableAnthropic', 'v2-enableXai',
            'v2-enableDeepseek', 'v2-enableDeepl', 'v2-enableMistral', 'v2-enableCfworkers', 'v2-enableOpenrouter',
            'v2-enableCustom', 'v2-learnMode', 'v2-learnItalic', 'v2-batchContext', 'v2-betaMode'].forEach(id => {
                const el = $(id);
                if (el) el.dispatchEvent(new Event('change'));
            });
    }

    function setCheck(id, val) { const el = $(id); if (el) el.checked = !!val; }
    function setVal(id, val) { const el = $(id); if (el) el.value = val; }

    // ── Collect form → config ───────────────────────────
    function collectConfig() {
        const noTrans = !!$('v2-noTranslation')?.checked;
        const singleBatch = $('v2-workflowMode')?.value === 'single';
        const multiEnabled = !!$('v2-multiProvider')?.checked;
        const bypass = !!$('v2-bypassCache')?.checked || singleBatch || multiEnabled;

        const mainKey = $('v2-geminiKey')?.value?.trim() || '';
        const additionalKeys = getAdditionalKeys();
        const allKeys = mainKey ? [mainKey, ...additionalKeys] : additionalKeys;

        return {
            noTranslationMode: noTrans,
            noTranslationLanguages: cfg.noTranslationLanguages || [],
            uiLanguage: navigator.language || 'en',
            geminiApiKey: mainKey,
            geminiKeyRotationEnabled: !!$('v2-keyRotation')?.checked,
            geminiApiKeys: allKeys,
            geminiKeyRotationMode: $('v2-rotationFreq')?.value || 'per-batch',
            assemblyAiApiKey: $('v2-assemblyaiKey')?.value?.trim() || '',
            cloudflareWorkersApiKey: '',
            geminiModel: 'gemini-3-flash-preview',
            promptStyle: $('v2-promptStyle')?.value || 'natural',
            translationPrompt: '',
            betaModeEnabled: !!$('v2-betaMode')?.checked,
            multiProviderEnabled: multiEnabled,
            mainProvider: multiEnabled ? ($('v2-mainProvider')?.value || 'gemini') : 'gemini',
            secondaryProviderEnabled: false,
            secondaryProvider: '',
            providers: collectProviders(),
            providerParameters: cfg.providerParameters || {},
            subtitleProviders: {
                opensubtitles: {
                    enabled: true,
                    implementationType: $('v2-opensubsAuth')?.checked ? 'auth' : 'v3',
                    username: $('v2-opensubsUser')?.value?.trim() || '',
                    password: $('v2-opensubsPass')?.value?.trim() || ''
                },
                subdl: { enabled: !!$('v2-enableSubdl')?.checked, apiKey: $('v2-subdlKey')?.value?.trim() || '' },
                subsource: { enabled: !!$('v2-enableSubsource')?.checked, apiKey: $('v2-subsourceKey')?.value?.trim() || '' },
                scs: { enabled: !!$('v2-enableSCS')?.checked },
                wyzie: {
                    enabled: !!$('v2-enableWyzie')?.checked,
                    sources: {
                        subf2m: !!$('v2-wyzieSubf2m')?.checked,
                        podnapisi: !!$('v2-wyziePodnapisi')?.checked,
                        gestdown: !!$('v2-wyzieGestdown')?.checked,
                        animetosho: !!$('v2-wyzieAnimetosho')?.checked,
                        opensubtitles: !!$('v2-wyzieOpensubs')?.checked,
                        subdl: !!$('v2-wyzieSubdl')?.checked
                    }
                },
                subsro: { enabled: !!$('v2-enableSubsro')?.checked, apiKey: '' }
            },
            subtitleProviderTimeout: Math.max(5, Math.min(60, parseInt($('v2-providerTimeout')?.value) || 12)),
            translationCache: { enabled: !bypass, duration: 0, persistent: true },
            bypassCache: bypass,
            bypassCacheConfig: { enabled: bypass, duration: 12 },
            tempCache: { enabled: bypass, duration: 12 },
            excludeHearingImpairedSubtitles: !!$('v2-excludeHI')?.checked,
            enableSeasonPacks: $('v2-seasonPacks')?.checked !== false,
            forceSRTOutput: !!$('v2-forceSRT')?.checked,
            convertAssToVtt: $('v2-convertAss')?.checked !== false,
            subToolboxEnabled: !!$('v2-subToolbox')?.checked,
            fileTranslationEnabled: !!$('v2-subToolbox')?.checked,
            syncSubtitlesEnabled: !!$('v2-subToolbox')?.checked,
            mobileMode: !!$('v2-mobileMode')?.checked,
            singleBatchMode: singleBatch,
            learnMode: !!$('v2-learnMode')?.checked,
            learnTargetLanguages: cfg.learnTargetLanguages || [],
            learnOrder: document.querySelector('input[name="v2-learnOrder"]:checked')?.value || 'source-top',
            learnPlacement: 'top',
            learnItalic: $('v2-learnItalic')?.checked !== false,
            learnItalicTarget: document.querySelector('input[name="v2-learnItalicTarget"]:checked')?.value || 'target',
            sourceLanguages: cfg.sourceLanguages,
            targetLanguages: cfg.targetLanguages,
            advancedSettings: {
                enabled: !!$('v2-betaMode')?.checked,
                geminiModel: $('v2-advModel')?.value || '',
                thinkingBudget: parseInt($('v2-advThinking')?.value) || 0,
                temperature: parseFloat($('v2-advTemp')?.value) || 0.8,
                topP: parseFloat($('v2-advTopP')?.value) || 0.95,
                topK: 40,
                enableBatchContext: !!$('v2-batchContext')?.checked,
                contextSize: parseInt($('v2-contextSize')?.value) || 3,
                translationWorkflow: 'xml',
                enableJsonOutput: !!$('v2-jsonOutput')?.checked,
                mismatchRetries: Math.max(0, Math.min(3, parseInt($('v2-mismatchRetries')?.value) || 1))
            }
        };
    }

    function collectProviders() {
        const p = {};
        const add = (key, enableId, keyId, modelId, endpointId) => {
            const enabled = !!$(enableId)?.checked;
            p[key] = {
                enabled,
                apiKey: $(keyId)?.value?.trim() || '',
                model: modelId ? ($(modelId)?.value?.trim() || '') : '',
                ...(endpointId ? { endpoint: $(endpointId)?.value?.trim() || '' } : {})
            };
        };
        add('openai', 'v2-enableOpenai', 'v2-openaiKey', 'v2-openaiModel', 'v2-openaiEndpoint');
        add('anthropic', 'v2-enableAnthropic', 'v2-anthropicKey', 'v2-anthropicModel');
        add('xai', 'v2-enableXai', 'v2-xaiKey');
        add('deepseek', 'v2-enableDeepseek', 'v2-deepseekKey');
        add('deepl', 'v2-enableDeepl', 'v2-deeplKey');
        add('mistral', 'v2-enableMistral', 'v2-mistralKey');
        add('cloudflare_workers', 'v2-enableCfworkers', 'v2-cfworkersKey');
        add('openrouter', 'v2-enableOpenrouter', 'v2-openrouterKey', 'v2-openrouterModel');
        add('google_translate', 'v2-enableGoogleTranslate', null);
        add('custom', 'v2-enableCustom', 'v2-customKey', 'v2-customModel', 'v2-customEndpoint');
        return p;
    }

    // ── Save ────────────────────────────────────────────
    async function save() {
        const config = collectConfig();
        let token = localStorage.getItem(TOKEN_KEY);
        let configToken, isUpdate = false;

        try {
            if (token && isValidToken(token)) {
                try {
                    const resp = await fetch(`/api/update-session/${encodeURIComponent(token)}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(config)
                    });
                    if (resp.status === 404 || resp.status === 410) {
                        localStorage.removeItem(TOKEN_KEY);
                        token = null;
                    } else if (resp.ok) {
                        const data = await resp.json();
                        configToken = data.token;
                        isUpdate = data.updated;
                    } else {
                        localStorage.removeItem(TOKEN_KEY);
                        token = null;
                    }
                } catch (_) {
                    localStorage.removeItem(TOKEN_KEY);
                    token = null;
                }
            }

            if (!token) {
                const resp = await fetch('/api/create-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config)
                });
                if (!resp.ok) throw new Error(`Save failed (${resp.status})`);
                const data = await resp.json();
                if (!data.token || !isValidToken(data.token)) throw new Error('Invalid token');
                configToken = data.token;
            }

            localStorage.setItem(TOKEN_KEY, configToken);
            localStorage.setItem(CACHE_KEY, JSON.stringify(config));

            const base = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
                ? 'http://localhost:7001' : location.origin;
            const installUrl = `${base}/addon/${encodeURIComponent(configToken)}/manifest.json`;
            window.installUrl = installUrl;

            $('v2-installBtn').disabled = false;
            $('v2-copyBtn').disabled = false;

            showToast(isUpdate ? 'Configuration updated!' : 'Configuration saved!', 'success');
        } catch (err) {
            showToast('Save failed: ' + err.message, 'error');
        }
    }

    // ── Install / Copy ──────────────────────────────────
    function install() {
        if (window.installUrl) {
            window.location.href = window.installUrl.replace(/^https?:\/\//i, 'stremio://');
        }
    }

    async function copyUrl() {
        if (!window.installUrl) return;
        try {
            await navigator.clipboard.writeText(window.installUrl);
            showToast('URL copied!', 'success');
        } catch (_) {
            const inp = document.createElement('input');
            inp.value = window.installUrl;
            document.body.appendChild(inp);
            inp.select();
            document.execCommand('copy');
            document.body.removeChild(inp);
            showToast('URL copied!', 'success');
        }
    }

    // ── Reset ───────────────────────────────────────────
    function resetSettings() {
        if (!confirm('Reset all settings to defaults?')) return;
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(CACHE_KEY);
        cfg = getDefaults();
        applyConfigToForm();
        renderGrid('v2-noTransGrid', 'noTranslationLanguages');
        renderGrid('v2-sourceGrid', 'sourceLanguages');
        renderGrid('v2-targetGrid', 'targetLanguages');
        renderGrid('v2-learnGrid', 'learnTargetLanguages');
        updateAllPills();
        showToast('Settings reset to defaults.', 'success');
    }

    // ── API Tests ───────────────────────────────────────
    async function testApi(url, method, body, feedbackId) {
        const fb = $(feedbackId);
        if (!fb) return;
        fb.className = 'v2-feedback loading';
        fb.textContent = 'Testing...';
        fb.style.display = 'block';
        try {
            const resp = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
            const data = await resp.json().catch(() => ({}));
            if (resp.ok) {
                fb.className = 'v2-feedback success';
                fb.textContent = data.message || '✓ Valid';
            } else {
                fb.className = 'v2-feedback error';
                fb.textContent = data.error || data.message || `Error ${resp.status}`;
            }
        } catch (err) {
            fb.className = 'v2-feedback error';
            fb.textContent = 'Network error: ' + err.message;
        }
    }

    function initApiTests() {
        const tests = [
            ['v2-testGemini', () => testApi('/api/test-gemini', 'POST', { apiKey: $('v2-geminiKey')?.value?.trim() }, 'v2-geminiFeedback')],
            ['v2-testOpensubs', () => testApi('/api/test-opensubtitles', 'POST', { username: $('v2-opensubsUser')?.value?.trim(), password: $('v2-opensubsPass')?.value?.trim() }, 'v2-opensubsFeedback')],
            ['v2-testSubdl', () => testApi('/api/test-subdl', 'POST', { apiKey: $('v2-subdlKey')?.value?.trim() }, 'v2-subdlFeedback')],
            ['v2-testSubsource', () => testApi('/api/test-subsource', 'POST', { apiKey: $('v2-subsourceKey')?.value?.trim() }, 'v2-subsourceFeedback')],
            ['v2-testAssemblyai', () => testApi('/api/test-assemblyai', 'POST', { apiKey: $('v2-assemblyaiKey')?.value?.trim() }, 'v2-assemblyaiFeedback')],
            ['v2-testOpenai', () => testApi('/api/test-openai', 'POST', { apiKey: $('v2-openaiKey')?.value?.trim() }, 'v2-openaiFeedback')],
            ['v2-testAnthropic', () => testApi('/api/test-anthropic', 'POST', { apiKey: $('v2-anthropicKey')?.value?.trim() }, 'v2-anthropicFeedback')],
            ['v2-testXai', () => testApi('/api/test-xai', 'POST', { apiKey: $('v2-xaiKey')?.value?.trim() }, 'v2-xaiFeedback')],
            ['v2-testDeepseek', () => testApi('/api/test-deepseek', 'POST', { apiKey: $('v2-deepseekKey')?.value?.trim() }, 'v2-deepseekFeedback')],
            ['v2-testDeepl', () => testApi('/api/test-deepl', 'POST', { apiKey: $('v2-deeplKey')?.value?.trim() }, 'v2-deeplFeedback')],
            ['v2-testMistral', () => testApi('/api/test-mistral', 'POST', { apiKey: $('v2-mistralKey')?.value?.trim() }, 'v2-mistralFeedback')],
            ['v2-testCfworkers', () => testApi('/api/test-cfworkers', 'POST', { apiKey: $('v2-cfworkersKey')?.value?.trim() }, 'v2-cfworkersFeedback')],
            ['v2-testOpenrouter', () => testApi('/api/test-openrouter', 'POST', { apiKey: $('v2-openrouterKey')?.value?.trim() }, 'v2-openrouterFeedback')]
        ];
        tests.forEach(([id, fn]) => {
            const btn = $(id);
            if (btn) btn.addEventListener('click', fn);
        });
    }

    // ── Toast ───────────────────────────────────────────
    function showToast(msg, type) {
        let container = $('v2-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'v2-toast-container';
            container.style.cssText = 'position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:6px;';
            document.body.appendChild(container);
        }
        const toast = document.createElement('div');
        const colors = { success: 'var(--v2-success)', error: 'var(--v2-danger)', warning: 'var(--v2-warning)', info: 'var(--v2-accent)' };
        toast.style.cssText = `padding:8px 14px;border-radius:6px;font-size:12px;font-family:Inter,sans-serif;color:#fff;background:${colors[type] || colors.info};box-shadow:0 4px 12px rgba(0,0,0,0.3);opacity:0;transform:translateX(20px);transition:all 0.2s ease;max-width:320px;`;
        toast.textContent = msg;
        container.appendChild(toast);
        requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(0)'; });
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(20px)';
            setTimeout(() => toast.remove(), 200);
        }, 3500);
    }

    // ── Utilities ───────────────────────────────────────
    function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function escapeAttr(s) { return (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

    // ── Init ────────────────────────────────────────────
    async function init() {
        initTheme();
        initSections();
        initPasswordToggles();
        initRanges();
        initAdditionalKeys();
        initLangSearch();
        initApiTests();

        // Load existing config
        await loadConfig();

        // Apply config to form
        applyConfigToForm();
        initToggles();

        // Load languages & render grids
        await loadLanguages();

        // Action buttons
        $('v2-saveBtn')?.addEventListener('click', save);
        $('v2-installBtn')?.addEventListener('click', install);
        $('v2-copyBtn')?.addEventListener('click', copyUrl);
        $('v2-resetBtn')?.addEventListener('click', resetSettings);
    }

    // ── Boot ────────────────────────────────────────────
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
