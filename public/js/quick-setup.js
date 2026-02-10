/**
 * Quick Setup Wizard — Standalone controller
 * 
 * Self-contained IIFE that manages the 7-step setup wizard overlay.
 * Does NOT depend on config.js internals — it builds its own config object
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

    // ─── Constants ───────────────────────────────────────────────────
    const TOKEN_KEY = 'submaker_session_token';
    const QS_DISMISSED_KEY = 'submaker_qs_dismissed';
    const QS_STATE_KEY = 'submaker_qs_state';
    const TOTAL_STEPS = 7;

    // No popular languages — all shown alphabetically
    const POPULAR_LANG_CODES = [];

    // ─── Wizard State ────────────────────────────────────────────────
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
        wyzieSources: { subf2m: true, podnapisi: true, gestdown: true, animetosho: true, opensubs: false, subdl: false },
        // AI (translate mode only)
        geminiApiKey: '',
        geminiKeyValid: false,
        // Languages
        selectedLanguages: [],
        // Extras
        subToolbox: true,
        seasonPacks: true,
        hideSDH: false,
        // Learn mode (translate only)
        learnMode: false,
        learnTargetLanguages: []
    };

    // Track whether the user has saved successfully (for reload-on-close)
    let hasSaved = false;

    // All languages from /api/languages (populated async)
    let allLanguages = [];
    let languagesLoaded = false;

    // ─── Utility ─────────────────────────────────────────────────────

    function $(id) { return document.getElementById(id); }

    function show(el) {
        if (typeof el === 'string') el = $(el);
        if (el) el.style.display = '';
    }
    function hide(el) {
        if (typeof el === 'string') el = $(el);
        if (el) el.style.display = 'none';
    }

    // ─── Initialization ──────────────────────────────────────────────

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

        // Wire close button
        const closeBtn = $('qsCloseBtn');
        if (closeBtn) closeBtn.addEventListener('click', closeWizard);

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

    // ─── Wizard Open / Close ─────────────────────────────────────────

    async function openWizard() {
        const overlay = $('quickSetupOverlay');
        if (!overlay) return;

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

            // API fetch failed — fall through to sessionStorage or reset
        }

        // No saved token — try to restore mid-wizard progress from sessionStorage
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
        if (overlay) overlay.classList.remove('active');
        document.body.style.overflow = '';
        if (hasSaved) {
            window.location.reload();
        }
    }

    // ─── Step Navigation ─────────────────────────────────────────────

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
            indicator.textContent = `Step ${idx + 1} of ${total}`;
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
                // Last step — hide next, we have install buttons
                hide(nextBtn);
            } else {
                show(nextBtn);
                nextBtn.disabled = !canProceed(step);
                // Update button text based on next step
                const next = getNextStep(step);
                if (next === TOTAL_STEPS) {
                    nextBtn.innerHTML = 'Review & Install →';
                } else {
                    nextBtn.innerHTML = 'Next →';
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

    // ─── Read Data from Step UI ──────────────────────────────────────

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
                if (state.wyzieEnabled) {
                    state.wyzieSources = {
                        subf2m: !!($('qsWyzieSubf2m') || {}).checked,
                        podnapisi: !!($('qsWyziePodnapisi') || {}).checked,
                        gestdown: !!($('qsWyzieGestdown') || {}).checked,
                        animetosho: !!($('qsWyzieAnimetosho') || {}).checked,
                        opensubs: !!($('qsWyzieOpensubs') || {}).checked,
                        subdl: !!($('qsWyzieSubdl') || {}).checked
                    };
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

    // ─── Step 1: Mode Selection ──────────────────────────────────────

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

    // ─── Step 2: Subtitle Sources ────────────────────────────────────

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

        // ─── Test / Validate Buttons ─────────────────────────────

        // OpenSubtitles auth test
        const osBtn = $('qsValidateOpenSubs');
        if (osBtn) {
            osBtn.addEventListener('click', async () => {
                const username = ($('qsOpenSubsUsername') || {}).value?.trim();
                const password = ($('qsOpenSubsPassword') || {}).value?.trim();
                const statusEl = $('qsOpenSubsStatus');
                if (!username || !password) {
                    showQsStatus(statusEl, 'Please enter username and password', 'error');
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
                    showQsStatus(statusEl, 'Please enter an API key', 'error');
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
                    showQsStatus(statusEl, 'Please enter an API key', 'error');
                    return;
                }
                await runQsValidation(ssBtn, statusEl, '/api/validate-subsource', { apiKey });
            });
        }
    }

    // ─── Step 3: AI Translation ──────────────────────────────────────

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
                    showKeyStatus('Please enter an API key', 'error');
                    return;
                }

                showKeyStatus('Validating...', 'validating');
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
                        showKeyStatus('✓ API key is valid!', 'success');
                    } else {
                        showKeyStatus('✗ ' + (result.error || 'Invalid API key — please double-check'), 'error');
                    }
                } catch (err) {
                    showKeyStatus('✗ Network error — try again', 'error');
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

    // ─── Generic Quick-Setup validation helpers ──────────────────────

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
        const origIcon = iconEl ? iconEl.textContent : '✓';
        const origText = textEl ? textEl.textContent : '';
        if (iconEl) iconEl.textContent = '⟳';
        if (textEl) textEl.textContent = 'Testing...';
        showQsStatus(statusEl, 'Validating...', 'validating');

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
                if (iconEl) iconEl.textContent = '✓';
                if (textEl) textEl.textContent = 'Valid';
                let msg = result.message || 'Valid!';
                if (result.resultsCount !== undefined) {
                    msg += ` (${result.resultsCount} test results)`;
                }
                showQsStatus(statusEl, '✓ ' + msg, 'success');
                setTimeout(() => {
                    btn.classList.remove('valid');
                    if (iconEl) iconEl.textContent = origIcon;
                    if (textEl) textEl.textContent = origText;
                }, 3000);
            } else {
                btn.classList.add('invalid');
                if (iconEl) iconEl.textContent = '✗';
                if (textEl) textEl.textContent = 'Failed';
                showQsStatus(statusEl, '✗ ' + (result.error || 'Validation failed'), 'error');
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
            showQsStatus(statusEl, '✗ Network error — try again', 'error');
        }
    }

    // ─── Step 4: Language Selection ──────────────────────────────────

    async function loadLanguages() {
        try {
            const resp = await fetch('/api/languages', {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const languages = await resp.json();

            // Filter out special fake languages, dedupe PT-BR
            const seen = new Map();
            languages.forEach(lang => {
                if (lang.code.startsWith('___')) return;
                let { code, name } = lang;
                const normName = (name || '').toLowerCase();
                const normCode = (code || '').toLowerCase();

                // Normalize PT-BR variants
                if ((normName.includes('portuguese') && normName.includes('brazil')) ||
                    normCode === 'ptbr' || normCode === 'pt-br') {
                    code = 'pob';
                    name = 'Portuguese (Brazil)';
                }

                if (!seen.has(code)) {
                    seen.set(code, { code, name });
                }
            });

            allLanguages = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
            languagesLoaded = true;
        } catch (err) {
            console.warn('[QuickSetup] Failed to load languages:', err);
        }
    }

    function onEnterStep4() {
        // Update title based on mode
        const title = $('qsLangTitle');
        const subtitle = $('qsLangSubtitle');
        if (state.mode === 'fetch') {
            if (title) title.textContent = 'Choose Subtitle Languages';
            if (subtitle) subtitle.textContent = 'What languages do you want to fetch subtitles in?';
        } else {
            if (title) title.textContent = 'Choose Your Target Language';
            if (subtitle) subtitle.textContent = 'What language do you want your subtitles translated to?';
        }

        // Show/hide source language info (only relevant in translate mode)
        const srcInfo = $('qsSourceLangInfo');
        if (srcInfo) srcInfo.style.display = state.mode === 'translate' ? '' : 'none';

        renderLangGrid();
    }

    function renderLangGrid() {
        const grid = $('qsLangGrid');
        if (!grid) return;

        const searchInput = $('qsLangSearch');
        const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';

        grid.innerHTML = '';

        if (!languagesLoaded) {
            grid.innerHTML = '<div class="qs-lang-loading">Loading languages...</div>';
            // Retry after a short delay
            setTimeout(renderLangGrid, 500);
            return;
        }

        // Filter by search
        let filtered = allLanguages;
        if (searchTerm) {
            filtered = allLanguages.filter(lang =>
                lang.name.toLowerCase().includes(searchTerm) ||
                lang.code.toLowerCase().includes(searchTerm)
            );
        }

        // Filter out English in translate mode source (we fix it to English)
        if (state.mode === 'translate') {
            filtered = filtered.filter(l => l.code !== 'eng');
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
        const limit = state.mode === 'fetch' ? 10 : 10; // Same limit for both

        if (idx > -1) {
            state.selectedLanguages.splice(idx, 1);
            el.classList.remove('selected');
        } else {
            if (state.selectedLanguages.length >= limit) {
                // Flash a warning
                const grid = $('qsLangGrid');
                if (grid) {
                    grid.style.animation = 'none';
                    void grid.offsetWidth;
                    grid.style.animation = '';
                }
                return;
            }
            state.selectedLanguages.push(code);
            el.classList.add('selected');
        }

        renderLangChips();
        updateNav(4);
    }

    function renderLangChips() {
        const container = $('qsSelectedLangs');
        if (!container) return;

        if (state.selectedLanguages.length === 0) {
            container.innerHTML = '<span style="color: #64748b; font-size: 0.82rem;">No languages selected yet</span>';
            return;
        }

        container.innerHTML = '';
        state.selectedLanguages.forEach(code => {
            const lang = allLanguages.find(l => l.code === code);
            const chip = document.createElement('span');
            chip.className = 'qs-lang-chip';
            chip.innerHTML = `${lang ? lang.name : code} <button type="button" class="qs-lang-chip-remove" data-code="${code}">×</button>`;
            container.appendChild(chip);
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
    }

    // ─── Step 5: Extras ──────────────────────────────────────────────

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

    // ─── Step 6: Learn Language Selection ─────────────────────────────

    function onEnterStep6Learn() {
        renderLearnLangGrid();
    }

    function renderLearnLangGrid() {
        const grid = $('qsLearnLangGrid');
        if (!grid) return;

        const searchInput = $('qsLearnLangSearch');
        const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';

        grid.innerHTML = '';

        if (!languagesLoaded) {
            grid.innerHTML = '<div class="qs-lang-loading">Loading languages...</div>';
            setTimeout(renderLearnLangGrid, 500);
            return;
        }

        // Filter by search
        let filtered = allLanguages;
        if (searchTerm) {
            filtered = allLanguages.filter(lang =>
                lang.name.toLowerCase().includes(searchTerm) ||
                lang.code.toLowerCase().includes(searchTerm)
            );
        }

        // Filter out English in translate mode
        filtered = filtered.filter(l => l.code !== 'eng');

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
        const limit = 6;

        if (idx > -1) {
            state.learnTargetLanguages.splice(idx, 1);
            el.classList.remove('selected');
        } else {
            if (state.learnTargetLanguages.length >= limit) {
                const grid = $('qsLearnLangGrid');
                if (grid) {
                    grid.style.animation = 'none';
                    void grid.offsetWidth;
                    grid.style.animation = '';
                }
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
            container.innerHTML = '<span style="color: #64748b; font-size: 0.82rem;">No learn languages selected yet</span>';
            return;
        }

        container.innerHTML = '';
        state.learnTargetLanguages.forEach(code => {
            const lang = allLanguages.find(l => l.code === code);
            const chip = document.createElement('span');
            chip.className = 'qs-lang-chip';
            chip.innerHTML = `${lang ? lang.name : code} <button type="button" class="qs-lang-chip-remove" data-code="${code}">×</button>`;
            container.appendChild(chip);
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
    }

    // ─── Step 7: Summary & Install ───────────────────────────────────

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
                icon: state.mode === 'translate' ? '🌐' : '📥',
                label: 'Mode',
                value: state.mode === 'translate' ? 'Translate Subtitles' : 'Just Fetch Subtitles',
                cls: 'qs-on'
            },
            {
                icon: '🎬',
                label: 'OpenSubtitles',
                value: state.openSubsAuth ? 'Auth (logged in)' : 'V3 (no login)',
                cls: 'qs-on'
            }
        ];

        // Source providers
        if (state.subdlEnabled) {
            items.push({ icon: '📥', label: 'SubDL', value: 'Enabled', cls: 'qs-on' });
        }
        if (state.subsourceEnabled) {
            items.push({ icon: '📡', label: 'SubSource', value: 'Enabled', cls: 'qs-on' });
        }
        if (state.scsEnabled) {
            items.push({ icon: '🌐', label: 'Stremio Community Subs', value: 'Enabled (30s timeout)', cls: 'qs-on' });
        }
        if (state.wyzieEnabled) {
            const activeSources = Object.entries(state.wyzieSources).filter(([, v]) => v).map(([k]) => k);
            items.push({ icon: '🔍', label: 'Wyzie Subs', value: `Enabled (${activeSources.length} sources)`, cls: 'qs-on' });
        }

        // AI
        if (state.mode === 'translate') {
            items.push({
                icon: '✨',
                label: 'AI Translation',
                value: state.geminiApiKey ? 'Gemini 3.0 Flash' : 'Not configured',
                cls: state.geminiApiKey ? 'qs-on' : 'qs-off'
            });
        }

        // Languages
        const langNames = state.selectedLanguages.map(code => {
            const lang = allLanguages.find(l => l.code === code);
            return lang ? lang.name : code.toUpperCase();
        });
        items.push({
            icon: '🗣️',
            label: state.mode === 'translate' ? 'Target Languages' : 'Subtitle Languages',
            value: langNames.join(', ') || 'None',
            cls: langNames.length > 0 ? 'qs-on' : 'qs-off'
        });

        // Extras
        items.push({
            icon: '🧰',
            label: 'Sub Toolbox',
            value: state.subToolbox ? 'Enabled' : 'Disabled',
            cls: state.subToolbox ? 'qs-on' : 'qs-off'
        });
        items.push({
            icon: '📦',
            label: 'Season Packs',
            value: state.seasonPacks ? 'Enabled' : 'Disabled',
            cls: state.seasonPacks ? 'qs-on' : 'qs-off'
        });
        if (state.hideSDH) {
            items.push({
                icon: '🔇',
                label: 'Hide SDH/HI',
                value: 'Enabled',
                cls: 'qs-on'
            });
        }

        // Learn mode
        if (state.learnMode && state.mode === 'translate') {
            const learnNames = state.learnTargetLanguages.map(code => {
                const lang = allLanguages.find(l => l.code === code);
                return lang ? lang.name : code.toUpperCase();
            });
            items.push({
                icon: '📖',
                label: 'Learn Languages',
                value: learnNames.join(', ') || 'None',
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
        const isTranslate = state.mode === 'translate';

        // Start from default config shape
        const config = {
            noTranslationMode: !isTranslate,
            noTranslationLanguages: !isTranslate ? [...state.selectedLanguages] : [],
            sourceLanguages: ['eng'],
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
            geminiModel: 'gemini-3-flash-preview',
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
                googletranslate: { enabled: isTranslate, apiKey: '', model: 'web' },
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
                    sources: state.wyzieEnabled ? { ...state.wyzieSources } : undefined
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
                enabled: true,
                duration: 12
            },
            tempCache: {
                enabled: true,
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
            singleBatchMode: true,
            advancedSettings: {
                enabled: false,
                geminiModel: '',
                thinkingBudget: 0,
                temperature: 1.0,
                topP: 0.95,
                topK: 40,
                enableBatchContext: false,
                contextSize: 3,
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
            statusEl.textContent = 'Saving configuration...';
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

                            // Start with old config to preserve advanced settings/providers
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

                            // 3. Handle Providers (AI/Translation)
                            // QS defaults to 'gemini' as main provider if in translation mode
                            if (!finalConfig.noTranslationMode) {
                                // If user was using something else, QS switches them to Gemini (Standard Setup)
                                // But we preserve keys for other providers in case they switch back
                                finalConfig.mainProvider = 'gemini';
                                finalConfig.multiProviderEnabled = false; // Reset to simple mode for QS
                            }

                            // Ensure googletranslate is enabled/disabled correctly based on QS (it's used as fallback)
                            finalConfig.providers = { ...(finalConfig.providers || {}) };
                            if (qsConfig.providers && qsConfig.providers.googletranslate) {
                                finalConfig.providers.googletranslate = qsConfig.providers.googletranslate;
                            }

                            // 4. Preserve Advanced Settings
                            // Only overwrite geminiModel if the old config didn't have one set,
                            // because QS defaults it to 'flash-preview' without asking.
                            if (qsConfig.geminiModel && !finalConfig.geminiModel) {
                                finalConfig.geminiModel = qsConfig.geminiModel;
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
                statusEl.textContent = '✓ Configuration saved successfully!';
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
                saveBtnEl.innerHTML = '<span class="qs-btn-icon">📥</span> Install on Stremio';
                const newInstallBtn = saveBtnEl.cloneNode(true);
                saveBtnEl.parentNode.replaceChild(newInstallBtn, saveBtnEl);
                newInstallBtn.addEventListener('click', () => handleInstallStremio());
            }

            // Keep the banner visible (permanent entry point)
            // No need to toggle — banner always stays shown

        } catch (err) {
            if (statusEl) {
                statusEl.textContent = '✗ ' + err.message;
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
                statusEl.textContent = '✓ Install URL copied to clipboard!';
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
            statusEl.textContent = 'Opening Stremio...';
            statusEl.className = 'qs-install-status saving';
        }
    }

    function handleOpenAdvanced() {
        // Keep the banner visible (permanent entry point)
        localStorage.setItem(QS_DISMISSED_KEY, 'true');

        if (hasSaved) {
            // Config was already saved to server — just reload to pick it up
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
    }

    // ─── Reset UI ────────────────────────────────────────────────────

    function resetAllStepUIs() {
        // Step 1 — deselect mode cards
        document.querySelectorAll('.qs-mode-card').forEach(c => c.classList.remove('selected'));

        // Step 2 — reset toggles and inputs
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

        // Step 3 — reset key input
        const keyInput = $('qsGeminiApiKey');
        if (keyInput) keyInput.value = '';
        const keyStatus = $('qsGeminiKeyStatus');
        if (keyStatus) { keyStatus.textContent = ''; keyStatus.className = 'qs-key-status'; }

        // Step 4 — clear language selection
        const searchInput = $('qsLangSearch');
        if (searchInput) searchInput.value = '';
        const selContainer = $('qsSelectedLangs');
        if (selContainer) selContainer.innerHTML = '<span style="color: #64748b; font-size: 0.82rem;">No languages selected yet</span>';

        // Step 5 — reset extras + learn mode
        const toolbox = $('qsSubToolbox');
        const season = $('qsSeasonPacks');
        const sdh = $('qsExcludeHI');
        const learnToggle = $('qsLearnMode');
        if (toolbox) toolbox.checked = true;
        if (season) season.checked = true;
        if (sdh) sdh.checked = false;
        if (learnToggle) learnToggle.checked = false;
        hide('qsLearnModeItem');

        // Step 6 — clear learn language selection
        const learnSearch = $('qsLearnLangSearch');
        if (learnSearch) learnSearch.value = '';
        const learnChips = $('qsSelectedLearnLangs');
        if (learnChips) learnChips.innerHTML = '<span style="color: #64748b; font-size: 0.82rem;">No learn languages selected yet</span>';

        // Step 7 — clear summary
        const summaryList = $('qsSummary');
        if (summaryList) summaryList.innerHTML = '';
        const installStatus = $('qsInstallStatus');
        if (installStatus) { installStatus.textContent = ''; installStatus.className = 'qs-install-status'; }
        hide('qsInstallUrlBox');

        // Reset progress
        const bar = $('qsProgressFill');
        if (bar) bar.style.width = '0%';
    }

    // ─── Session State Persistence ───────────────────────────────────

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
        if (wyzie.sources) {
            state.wyzieSources = { ...wyzie.sources };
        }

        // AI
        state.geminiApiKey = config.geminiApiKey || '';
        // If key exists, assume valid or let them re-validate
        state.geminiKeyValid = !!state.geminiApiKey;

        // Languages
        const langs = state.mode === 'translate' ? config.targetLanguages : config.noTranslationLanguages;
        state.selectedLanguages = Array.isArray(langs) ? [...langs] : [];

        // Extras
        state.subToolbox = config.subToolboxEnabled !== false; // Default true if undefined/null?
        state.seasonPacks = config.enableSeasonPacks !== false;
        state.hideSDH = !!config.excludeHearingImpairedSubtitles;

        // Learn Mode
        state.learnMode = !!config.learnMode;
        state.learnTargetLanguages = Array.isArray(config.learnTargetLanguages) ? [...config.learnTargetLanguages] : [];

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
        state.geminiApiKey = '';
        state.geminiKeyValid = false;
        state.selectedLanguages = [];
        state.subToolbox = true;
        state.seasonPacks = true;
        state.hideSDH = false;
        state.learnMode = false;
        state.learnTargetLanguages = [];
    }

    function restoreUIFromState() {
        // Step 1 — mode cards
        document.querySelectorAll('.qs-mode-card').forEach(c => {
            c.classList.toggle('selected', c.dataset.mode === state.mode);
        });

        // Step 2 — checkboxes and inputs
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
        if (subdlKey) subdlKey.value = state.subdlApiKey || '';
        if (ssKey) ssKey.value = state.subsourceApiKey || '';

        const un = $('qsOpenSubsUsername');
        const pw = $('qsOpenSubsPassword');
        if (un) un.value = state.openSubsUsername || '';
        if (pw) pw.value = state.openSubsPassword || '';
        if (state.openSubsAuth || state.openSubsUsername || state.openSubsPassword) {
            const authFields = $('qsOpenSubsAuthFields');
            if (authFields) authFields.style.display = '';
        }

        // Wyzie sub-sources
        if (state.wyzieEnabled && state.wyzieSources) {
            const ids = { subf2m: 'qsWyzieSubf2m', podnapisi: 'qsWyziePodnapisi', gestdown: 'qsWyzieGestdown', animetosho: 'qsWyzieAnimetosho', opensubs: 'qsWyzieOpensubs', subdl: 'qsWyzieSubdl' };
            for (const [key, id] of Object.entries(ids)) {
                const el = $(id);
                if (el) el.checked = !!state.wyzieSources[key];
            }
        }

        // Step 3 — Gemini key
        const geminiKey = $('qsGeminiApiKey');
        if (geminiKey) geminiKey.value = state.geminiApiKey || '';

        // Step 5 — extras
        const toolbox = $('qsSubToolbox');
        const season = $('qsSeasonPacks');
        const sdh = $('qsExcludeHI');
        const learnToggle = $('qsLearnMode');
        if (toolbox) toolbox.checked = state.subToolbox;
        if (season) season.checked = state.seasonPacks;
        if (sdh) sdh.checked = state.hideSDH;
        if (learnToggle) learnToggle.checked = state.learnMode;
    }

    // ─── Boot ────────────────────────────────────────────────────────

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
