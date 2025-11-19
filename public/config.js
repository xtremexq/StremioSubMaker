// Configuration page JavaScript - Modern Edition
(function() {
    'use strict';

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
        GEMINI: ''
    };

    // Popular languages for quick selection
    const POPULAR_LANGUAGES = ['eng', 'spa', 'fre', 'ger', 'por', 'pob', 'ita', 'rus', 'jpn', 'kor', 'chi', 'ara'];

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
        'gemini-2.5-flash-lite-preview-09-2025': {
            thinkingBudget: 0,
            temperature: 0.7
        },
        'gemini-2.5-flash-preview-09-2025': {
            thinkingBudget: -1,
            temperature: 0.5
        },
        'gemini-2.5-pro': {
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

    function getDefaultConfig(modelName = 'gemini-2.5-flash-preview-09-2025') {
        const modelDefaults = getModelSpecificDefaults(modelName);

        return {
            noTranslationMode: false, // If true, skip translation and just fetch subtitles
            noTranslationLanguages: [], // Languages to fetch when in no-translation mode
            sourceLanguages: ['eng'], // Up to 3 source languages allowed
            targetLanguages: [],
            geminiApiKey: DEFAULT_API_KEYS.GEMINI,
            geminiModel: modelName,
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
            fileTranslationEnabled: false, // enable file upload translation feature
            syncSubtitlesEnabled: false, // enable 'Sync Subtitles' action in subtitles list
            advancedSettings: {
                enabled: false, // Auto-set to true if any setting differs from defaults (forces bypass cache)
                geminiModel: '', // Override model (empty = use default)
                thinkingBudget: modelDefaults.thinkingBudget,
                temperature: modelDefaults.temperature,
                topP: 0.95,
                topK: 40,
                enableBatchContext: false, // Include original surrounding context and previous translations
                contextSize: 3 // Number of surrounding entries to include as context
            }
        };
    }

    // State management
    let currentConfig = parseConfigFromUrl();
    let allLanguages = [];
    let isFirstRun = false;
    let modelsFetchTimeout = null;
    let lastFetchedApiKey = null;

    // localStorage cache keys
    const CACHE_KEY = 'submaker_config_cache';
    const CACHE_EXPIRY_KEY = 'submaker_config_cache_expiry';
    const CACHE_VERSION_KEY = 'submaker_config_cache_version';  // Tracks version when cache was saved
    const TOKEN_KEY = 'submaker_session_token';

    // Visual state cache keys (these should be cleared on version changes)
    const VISUAL_STATE_KEYS = [
        'submaker_dont_show_instructions',
        'submaker_dont_show_file_translation',
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
     * FIXED: Clear invalid token from storage
     * @param {string} reason - Reason for clearing (for logging)
     */
    function clearInvalidToken(reason = 'unknown') {
        const token = localStorage.getItem(TOKEN_KEY);
        if (token && !isValidSessionToken(token)) {
            console.warn(`[Config] Clearing invalid session token (${reason}): ${token.substring(0, 8)}...`);
            localStorage.removeItem(TOKEN_KEY);
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

    async function init() {
        // Priority: cached config > URL config > default config
        // This ensures browser cache is respected unless explicitly shared via URL
        // NOTE: loadConfigFromCache is now async due to version validation
        const cachedConfig = await loadConfigFromCache();
        const params = new URLSearchParams(window.location.search);
        const rawConfigParam = params.get('config');
        const hasExplicitUrlConfig = params.has('config');
        const urlConfig = parseConfigFromUrl();
        // Determine if this is the user's first config run
        isFirstRun = !cachedConfig && !hasExplicitUrlConfig;

        if (cachedConfig && !hasExplicitUrlConfig) {
            // Use cached config - this is the most common case
            currentConfig = cachedConfig;
        } else if (hasExplicitUrlConfig) {
            // URL has explicit config - could be base64 or a session token
            currentConfig = urlConfig;

            // New: If URL param looks like a session token, fetch stored config from server
            if (isValidSessionToken(rawConfigParam)) {
                try {
                    const resp = await fetch(`/api/get-session/${rawConfigParam}`, { cache: 'no-store' });
                    if (resp.ok) {
                        const data = await resp.json();
                        if (data && data.config) {
                            currentConfig = data.config;
                        }
                        try { localStorage.setItem(TOKEN_KEY, rawConfigParam); } catch (_) {}
                    }
                } catch (e) {
                    // Ignore fetch errors; fallback to urlConfig/defaults
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

        // Normalize any legacy PT-BR codes in saved config to canonical 'pob'
        currentConfig.sourceLanguages = normalizeLanguageCodes(currentConfig.sourceLanguages || []);
        currentConfig.targetLanguages = normalizeLanguageCodes(currentConfig.targetLanguages || []);
        currentConfig.noTranslationLanguages = normalizeLanguageCodes(currentConfig.noTranslationLanguages || []);

        // Show instructions ASAP (do not block on network/UI work)
        showInstructionsModalIfNeeded();

        // Kick off language loading without blocking UI/modals
        loadLanguages().catch(err => {
            try { showAlert('Failed to load languages: ' + err.message, 'error'); } catch (_) {}
        });

        setupEventListeners();
        loadConfigToForm();
        setupKeyboardShortcuts();
        showKeyboardHint();

        // Auto-fetch models if API key exists (do not block UI/modals)
        const apiKey = document.getElementById('geminiApiKey').value.trim();
        if (apiKey) {
            Promise.resolve().then(() => autoFetchModels(apiKey)).catch(() => {});
        }
    }

    function normalizeLanguageCodes(codes) {
        if (!Array.isArray(codes)) return [];
        return codes.map(c => {
            const lc = String(c || '').toLowerCase();
            if (lc === 'ptbr' || lc === 'pt-br') return 'pob';
            return lc;
        });
    }

    // Modal management functions
    function openModalById(id) {
        const el = document.getElementById(id);
        if (!el) return false;
        // Force visible regardless of stylesheet order
        el.classList.add('show');
        el.style.display = 'flex';
        el.style.zIndex = '10000';
        return true;
    }
    function showInstructionsModalIfNeeded() {
        try {
            const raw = localStorage.getItem('submaker_dont_show_instructions');
            if (raw !== 'true') {
                // Single scheduled attempt keeps code simple and reliable
                setTimeout(() => openModalById('instructionsModal'), 200);
            }
        } catch (_) {
            setTimeout(() => openModalById('instructionsModal'), 200);
        }
    }

    window.closeInstructionsModal = function() {
        const dontShowEl = document.getElementById('dontShowInstructions');
        const dontShow = dontShowEl ? dontShowEl.checked : false;
        if (dontShow) {
            localStorage.setItem('submaker_dont_show_instructions', 'true');
        }
        const modal = document.getElementById('instructionsModal');
        if (modal) {
            modal.classList.remove('show');
            modal.style.display = 'none';
        }
    };

    window.closeFileTranslationModal = function() {
        const dontShowEl = document.getElementById('dontShowFileTranslation');
        const dontShow = dontShowEl ? dontShowEl.checked : false;
        if (dontShow) {
            localStorage.setItem('submaker_dont_show_file_translation', 'true');
        }
        const modal = document.getElementById('fileTranslationModal');
        if (modal) {
            modal.classList.remove('show');
            modal.style.display = 'none';
        }
    };

    function showFileTranslationModal() {
        try {
            const raw = localStorage.getItem('submaker_dont_show_file_translation');
            const suppressed = (raw === 'true');
            if (!suppressed) {
                openModalById('fileTranslationModal');
            }
        } catch (_) {
            openModalById('fileTranslationModal');
        }
    }

    // (Removed extra window load fallback to reduce complexity)

    // Close modals when clicking outside
    document.addEventListener('click', function(e) {
        if (e.target.classList.contains('modal-overlay')) {
            if (e.target.id === 'instructionsModal') {
                closeInstructionsModal();
            } else if (e.target.id === 'fileTranslationModal') {
                closeFileTranslationModal();
            }
        }
    });

    // Delegated handlers for modal close buttons (robust against earlier init failures)
    document.addEventListener('click', function(e) {
        const actionEl = e.target && e.target.closest
            ? e.target.closest('#closeInstructionsBtn, #gotItInstructionsBtn, #closeFileTranslationBtn, #gotItFileTranslationBtn, .modal-close')
            : null;
        if (!actionEl) return;

        // If it's any instructions close control
        if (actionEl.id === 'closeInstructionsBtn' || actionEl.id === 'gotItInstructionsBtn' || actionEl.classList.contains('modal-close') && actionEl.closest('#instructionsModal')) {
            window.closeInstructionsModal();
            return;
        }

        // If it's any file translation close control
        if (actionEl.id === 'closeFileTranslationBtn' || actionEl.id === 'gotItFileTranslationBtn' || actionEl.classList.contains('modal-close') && actionEl.closest('#fileTranslationModal')) {
            window.closeFileTranslationModal();
            return;
        }
    }, true); // capture phase to survive stopPropagation in bubble

    // Close modals with Escape key (priority handler)
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            const instructionsModal = document.getElementById('instructionsModal');
            const fileTranslationModal = document.getElementById('fileTranslationModal');

            if (instructionsModal && instructionsModal.classList.contains('show')) {
                e.preventDefault();
                e.stopPropagation();
                closeInstructionsModal();
            } else if (fileTranslationModal && fileTranslationModal.classList.contains('show')) {
                e.preventDefault();
                e.stopPropagation();
                closeFileTranslationModal();
            }
        }
    }, true); // Use capture phase to handle before other listeners

    function parseConfigFromUrl() {
        const params = new URLSearchParams(window.location.search);
        const configStr = params.get('config');

        if (configStr) {
            try {
                const decoded = atob(configStr);
                return JSON.parse(decoded);
            } catch (e) {
                // Failed to parse config
            }
        }

        return getDefaultConfig();
    }

    /**
     * Check if advanced settings differ from defaults
     * @returns {boolean} - True if any advanced setting is modified
     */
    function areAdvancedSettingsModified() {
        // Get the currently selected base model to determine model-specific defaults
        const geminiModelEl = document.getElementById('geminiModel');
        const currentBaseModel = geminiModelEl ? geminiModelEl.value : 'gemini-2.5-flash-preview-09-2025';
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
     * Update bypass cache state based on advanced settings
     */
    function updateBypassCacheForAdvancedSettings() {
        const bypassEl = document.getElementById('bypassCache');
        const cacheEl = document.getElementById('cacheEnabled');
        if (!bypassEl || !cacheEl) return;

        const isModified = areAdvancedSettingsModified();

        if (isModified) {
            // Advanced settings are modified: force and lock bypass cache
            // 1) Turn OFF main cache so mutual exclusivity logic can set bypass ON
            cacheEl.checked = false;
            // 2) Refresh mutual exclusivity UI
            updateCacheToggles();
            // 3) Explicitly check + lock bypass
            bypassEl.checked = true;
            bypassEl.disabled = true;
        } else {
            // Advanced settings at defaults: unlock bypass cache and refresh UI
            bypassEl.disabled = false;
            updateCacheToggles();
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

                // Update selected chips
                updateSelectedChips('source', currentConfig.sourceLanguages);
                updateSelectedChips('target', currentConfig.targetLanguages);
                updateSelectedChips('notranslation', currentConfig.noTranslationLanguages);

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
        showAlert(`Failed to load languages after ${maxRetries} attempts: ${lastError.message}. Please refresh the page.`, 'error');
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

            item.addEventListener('click', () => {
                toggleLanguage(type, lang.code, item);
            });

            grid.appendChild(item);
        });
    }

    function toggleLanguage(type, code, element) {
        let configKey;
        if (type === 'source') {
            configKey = 'sourceLanguages';
        } else if (type === 'notranslation') {
            configKey = 'noTranslationLanguages';
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
            // For source languages, only allow up to 3 selections
            if (type === 'source') {
                if (currentConfig[configKey].length >= 3) {
                    // Already have 3 source languages, show alert
                    showAlert('You can only select up to 3 source languages', 'warning');
                    return;
                }
                // Add this language
                currentConfig[configKey].push(code);
            } else {
                // For target and no-translation languages, allow multiple
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
        if (type === 'source' || type === 'target') {
            validateLanguageSelection(type);
        }

        languageCodes.forEach(code => {
            const lang = allLanguages.find(l => l.code === code);
            if (!lang) return;

            const chip = document.createElement('div');
            chip.className = 'language-chip';
            chip.innerHTML = `
                <span>${lang.name} (${lang.code.toUpperCase()})</span>
                <span class="remove">×</span>
            `;

            chip.addEventListener('click', () => {
                removeLanguage(type, code);
            });

            container.appendChild(chip);
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

        // No-translation language search
        const noTranslationSearch = document.getElementById('noTranslationSearch');
        if (noTranslationSearch) {
            noTranslationSearch.addEventListener('input', (e) => {
                filterLanguages('noTranslationLanguages', e.target.value);
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
                if (passwordInput.type === 'password') {
                    passwordInput.type = 'text';
                    togglePasswordBtn.textContent = '🙈';
                    togglePasswordBtn.title = 'Hide password';
                } else {
                    passwordInput.type = 'password';
                    togglePasswordBtn.textContent = '👁️';
                    togglePasswordBtn.title = 'Show password';
                }
            });
        }

        // Cache UI toggle - handles mutual exclusivity
        document.getElementById('cacheEnabled').addEventListener('change', handleCacheEnabledToggle);

        // Bypass UI toggle - handles mutual exclusivity
        const bypassToggle = document.getElementById('bypassCache');
        if (bypassToggle) {
            bypassToggle.addEventListener('change', handleBypassToggle);
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

        // Card headers - toggle collapse when clicked (including the arrow button)
        document.querySelectorAll('.card-header').forEach(header => {
            header.addEventListener('click', (e) => {
                const card = e.currentTarget.closest('.card');
                const collapseBtn = card.querySelector('.collapse-btn');

                // Toggle collapsed state
                card.classList.toggle('collapsed');
                collapseBtn.classList.toggle('collapsed');
            });
        });

        // Advanced settings toggle (element may not exist in current UI)
        const showAdv = document.getElementById('showAdvancedSettings');
        if (showAdv) {
            showAdv.addEventListener('change', handleAdvancedSettingsToggle);
        }

        // Live validation
        document.getElementById('geminiApiKey').addEventListener('input', validateGeminiApiKey);
        document.getElementById('geminiModel').addEventListener('change', validateGeminiModel);

        // Update advanced settings when model changes (apply model-specific defaults)
        // When user selects a new model, always reset advanced settings to that model's defaults
        // This overrides any cached values from previous model selections
        // Manual changes made AFTER model selection will persist until next model change
        document.getElementById('geminiModel').addEventListener('change', function(e) {
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
        document.getElementById('validateSubSource').addEventListener('click', () => validateApiKey('subsource'));
        document.getElementById('validateSubDL').addEventListener('click', () => validateApiKey('subdl'));
        document.getElementById('validateGemini').addEventListener('click', () => validateApiKey('gemini'));

        // File translation toggle - show modal when enabled
        document.getElementById('fileTranslationEnabled').addEventListener('change', (e) => {
            if (e.target.checked) {
                showFileTranslationModal();
            }
        });

        // Advanced Settings - Auto-enable bypass cache when any setting is modified
        const advModelEl = document.getElementById('advancedModel');
        const advThinkingEl = document.getElementById('advancedThinkingBudget');
        const advTempEl = document.getElementById('advancedTemperature');
        const advTopPEl = document.getElementById('advancedTopP');

        // Fetch models when dropdown is clicked (on-demand fallback)
        if (advModelEl) {
            advModelEl.addEventListener('focus', async () => {
                const apiKey = document.getElementById('geminiApiKey').value.trim();
                // Only fetch if we have an API key and haven't fetched yet
                if (apiKey && apiKey.length >= 10 && apiKey !== lastFetchedApiKey) {
                    console.log('[Advanced Settings] Fetching models on dropdown focus...');
                    await autoFetchModels(apiKey);
                }
            });
        }

        [advModelEl, advThinkingEl, advTempEl, advTopPEl].forEach(el => {
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
            contextSizeEl.addEventListener('input', updateBypassCacheForAdvancedSettings);
            contextSizeEl.addEventListener('change', updateBypassCacheForAdvancedSettings);
        }

        // Secret experimental mode: Click the heart to reveal advanced settings
        const secretHeart = document.getElementById('secretHeart');
        if (secretHeart) {
            secretHeart.addEventListener('click', () => {
                const advancedCard = document.getElementById('advancedSettingsCard');
                if (advancedCard && advancedCard.style.display === 'none') {
                    advancedCard.style.display = 'block';
                    showAlert('🔬 Experimental Mode ON', 'success');
                    // Scroll to the advanced settings card
                    setTimeout(() => {
                        advancedCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }, 300);
                }
            });
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
     * Update cache/bypass toggle UI - enforces mutual exclusivity
     * Cache and bypass are mutually exclusive:
     * - When cache is ON, bypass must be OFF and disabled
     * - When cache is OFF, bypass must be ON and enabled
     */
    function updateCacheToggles() {
        const cacheInput = document.getElementById('cacheEnabled');
        const bypassInput = document.getElementById('bypassCache');
        const bypassGroup = document.getElementById('bypassCacheGroup');

        if (!cacheInput || !bypassInput) return;

        const cacheEnabled = cacheInput.checked;

        // Enforce mutual exclusivity
        if (cacheEnabled) {
            bypassInput.checked = false;
            bypassInput.disabled = true;
            if (bypassGroup) bypassGroup.style.opacity = '0.6';
        } else {
            bypassInput.checked = true;
            bypassInput.disabled = false;
            if (bypassGroup) bypassGroup.style.opacity = '1';
        }

        // Always show bypass group
        if (bypassGroup) bypassGroup.style.display = 'block';
    }

    function handleCacheEnabledToggle(e) {
        updateCacheToggles();
    }

    function handleBypassToggle(e) {
        // Bypass toggle clicks should flip the cache toggle instead
        const cacheInput = document.getElementById('cacheEnabled');
        if (cacheInput) {
            cacheInput.checked = !e.target.checked;
        }
        updateCacheToggles();
    }

    function handleAdvancedSettingsToggle(e) {
        const advancedSettingsGroup = document.getElementById('advancedSettingsGroup');
        advancedSettingsGroup.style.display = e.target.checked ? 'block' : 'none';
    }

    function validateLanguageSelection(type) {
        const configKey = type === 'source' ? 'sourceLanguages' : 'targetLanguages';
        const errorId = type === 'source' ? 'sourceLanguagesError' : 'targetLanguagesError';
        const errorDiv = document.getElementById(errorId);

        if (type === 'source') {
            // Source languages must have 1-3 selections
            if (currentConfig[configKey].length < 1 || currentConfig[configKey].length > 3) {
                errorDiv.textContent = 'Please select 1-3 source languages';
                errorDiv.classList.add('show');
                return false;
            } else {
                errorDiv.classList.remove('show');
                return true;
            }
        } else {
            // Target languages must have at least one
            if (currentConfig[configKey].length === 0) {
                errorDiv.classList.add('show');
                return false;
            } else {
                errorDiv.classList.remove('show');
                return true;
            }
        }
    }

    function validateGeminiApiKey(showNotification = false) {
        const input = document.getElementById('geminiApiKey');
        const error = document.getElementById('geminiApiKeyError');
        const value = input.value.trim();

        if (!value) {
            input.classList.add('invalid');
            input.classList.remove('valid');
            error.classList.add('show');
            if (showNotification) {
                showAlert('⚠️ Gemini API key is required', 'error');
            }
            return false;
        } else {
            input.classList.remove('invalid');
            // Don't add 'valid' class here - only backend validation should do that
            error.classList.remove('show');
            return true;
        }
    }

    function validateGeminiModel() {
        const select = document.getElementById('geminiModel');
        const error = document.getElementById('geminiModelError');
        const value = select.value;

        if (!value) {
            select.classList.add('invalid');
            select.classList.remove('valid');
            error.classList.add('show');
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
            endpoint = '/api/validate-opensubtitles';
        } else if (provider === 'gemini') {
            btn = document.getElementById('validateGemini');
            feedback = document.getElementById('geminiValidationFeedback');
            apiKey = document.getElementById('geminiApiKey').value.trim();
            endpoint = '/api/validate-gemini';
        }

        // Validate input
        if (provider === 'opensubtitles') {
            if (!username || !password) {
                showValidationFeedback(feedback, 'error', 'Please enter both username and password');
                return;
            }
        } else {
            if (!apiKey) {
                showValidationFeedback(feedback, 'error', 'Please enter an API key');
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
        textEl.textContent = 'Testing...';

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
                textEl.textContent = 'Valid';

                let message = result.message || 'API key is valid';
                if (result.resultsCount !== undefined) {
                    message += ` (${result.resultsCount} test results)`;
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
                    textEl.textContent = provider === 'opensubtitles' ? 'Test Credentials' : 'Test';
                }, 3000);
            } else {
                // Error
                btn.classList.add('error');
                iconEl.textContent = '✗';
                textEl.textContent = 'Invalid';
                showValidationFeedback(feedback, 'error', result.error || 'Validation failed');

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
                    textEl.textContent = provider === 'opensubtitles' ? 'Test Credentials' : 'Test';
                }, 4000);
            }

        } catch (error) {
            console.error('[Validation] Error:', error);
            btn.classList.remove('validating');
            btn.classList.add('error');
            btn.disabled = false;
            iconEl.textContent = '✗';
            textEl.textContent = 'Error';
            showValidationFeedback(feedback, 'error', 'Connection error. Please try again.');

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

            // Ctrl/Cmd + Alt + D to reveal Dev panel
            if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'd' || e.key === 'D')) {
                e.preventDefault();
                const devCard = document.getElementById('devSettingsCard');
                if (devCard && devCard.style.display === 'none') {
                    devCard.style.display = 'block';
                    try { showAlert('🧪 Dev Panel Unlocked', 'success'); } catch (_) {}
                    setTimeout(() => {
                        devCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }, 300);
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
        const allCollapsed = Array.from(document.querySelectorAll('.card')).every(card => card.classList.contains('collapsed'));

        document.querySelectorAll('.card').forEach(card => {
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

    function toggleNoTranslationMode(enabled) {
        currentConfig.noTranslationMode = enabled;
        const noTranslationCard = document.getElementById('noTranslationCard');
        const sourceCard = document.getElementById('sourceCard');
        const targetCard = document.getElementById('targetCard');
        const geminiCard = document.getElementById('geminiCard');

        if (enabled) {
            // Show no-translation card, hide source, target, and gemini cards
            if (noTranslationCard) noTranslationCard.style.display = 'block';
            if (sourceCard) sourceCard.style.display = 'none';
            if (targetCard) targetCard.style.display = 'none';
            if (geminiCard) geminiCard.style.display = 'none';

            // Clear validation errors for fields that aren't required in no-translation mode
            const geminiApiKeyInput = document.getElementById('geminiApiKey');
            const geminiApiKeyError = document.getElementById('geminiApiKeyError');
            const geminiModelSelect = document.getElementById('geminiModel');
            const geminiModelError = document.getElementById('geminiModelError');
            const sourceLanguagesError = document.getElementById('sourceLanguagesError');
            const targetLanguagesError = document.getElementById('targetLanguagesError');

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
            if (sourceLanguagesError) {
                sourceLanguagesError.classList.remove('show');
            }
            if (targetLanguagesError) {
                targetLanguagesError.classList.remove('show');
            }

            // Clear source and target languages when switching to no-translation mode
            // This prevents translation-mode languages from being saved in no-translation config
            currentConfig.sourceLanguages = [];
            currentConfig.targetLanguages = [];

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

            updateSelectedChips('source', []);
            updateSelectedChips('target', []);
        } else {
            // Hide no-translation card, show source, target, and gemini cards
            if (noTranslationCard) noTranslationCard.style.display = 'none';
            if (sourceCard) sourceCard.style.display = 'block';
            if (targetCard) targetCard.style.display = 'block';
            if (geminiCard) geminiCard.style.display = 'block';

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
        }
    }

    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
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
            console.error('Failed to fetch models:', error);
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
            console.log('[Advanced Settings] Model dropdown not found in DOM');
            return;
        }

        console.log(`[Advanced Settings] Populating dropdown with ${models.length} models`);

        // Clear and populate advanced model dropdown with ALL models
        advModelSelect.innerHTML = '<option value="">Use Default Model</option>';

        // Define hardcoded multi-model options
        const hardcodedModels = [
            { name: 'gemini-2.5-flash-lite-preview-09-2025', displayName: 'Gemini 2.5 Flash-Lite' },
            { name: 'gemini-2.5-flash-preview-09-2025', displayName: 'Gemini 2.5 Flash' },
            { name: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro (Slow)' }
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

        console.log('[Advanced Settings] Dropdown populated successfully');
    }

    function handleQuickAction(e) {
        const action = e.target.dataset.action;
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
                    // Source languages: Allow up to 3 selections
                    // For "Popular" or "All", select up to 3 popular/visible languages
                    const selectedCodes = [];
                    items.forEach(item => {
                        if (selectedCodes.length >= 3) return; // Limit to 3

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
                    // Target and no-translation languages: Allow multiple selections
                    if (action.includes('popular')) {
                        // Select only popular languages
                        currentConfig[configKey] = [];
                        items.forEach(item => {
                            const code = item.dataset.code;
                            if (POPULAR_LANGUAGES.includes(code)) {
                                currentConfig[configKey].push(code);
                                item.classList.add('selected');
                            } else {
                                item.classList.remove('selected');
                            }
                        });
                    } else {
                        // Select all visible
                        currentConfig[configKey] = [];
                        items.forEach(item => {
                            const code = item.dataset.code;
                            if (!currentConfig[configKey].includes(code)) {
                                currentConfig[configKey].push(code);
                            }
                            item.classList.add('selected');
                        });
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
        
        configDiv.style.opacity = enabled ? '1' : '0.5';

        if (configId === 'opensubtitlesConfig') {
            // For OpenSubtitles, disable individual controls instead of blocking pointer events
            const inputs = configDiv.querySelectorAll('input, select, textarea');
            inputs.forEach(input => {
                input.disabled = !enabled;
            });
            
            // Always update auth fields visibility (whether enabled or disabled)
            // This ensures correct state in all scenarios: enabled/disabled, v3/auth, with/without credentials
            handleOpenSubtitlesImplChange();
        } else {
            // For other providers, use pointer-events as before
            configDiv.style.pointerEvents = enabled ? 'auto' : 'none';
        }
    }

    /**
     * Get current app version from the page
     * This version is fetched from /api/session-stats
     */
    async function getCurrentAppVersion() {
        try {
            const response = await fetch('/api/session-stats', { cache: 'no-store' });
            const data = await response.json();
            return data.version || 'unknown';
        } catch (error) {
            console.warn('[Config] Failed to fetch app version:', error.message);
            return 'unknown';
        }
    }

    /**
     * Save configuration to localStorage with version tracking
     */
    function saveConfigToCache(config) {
        try {
            // Save config and timestamp
            localStorage.setItem(CACHE_KEY, JSON.stringify(config));
            localStorage.setItem(CACHE_EXPIRY_KEY, Date.now().toString());

            // Get and save current app version
            getCurrentAppVersion().then(version => {
                try {
                    localStorage.setItem(CACHE_VERSION_KEY, version);
                    console.log('[Config] Cache saved with version:', version);
                } catch (error) {
                    console.warn('[Config] Failed to save cache version:', error.message);
                }
            }).catch(err => {
                console.warn('[Config] Error getting version for cache:', err.message);
            });
        } catch (error) {
            // Continue anyway - caching is optional
        }
    }

    /**
     * Validate configuration structure and required fields
     * Returns null if invalid, otherwise returns the config
     */
    function validateConfig(config) {
        if (!config || typeof config !== 'object') {
            console.warn('[Config] Invalid config: not an object');
            return null;
        }

        // Check for critical required fields
        if (typeof config.subtitleProviders !== 'object') {
            console.warn('[Config] Invalid config: missing subtitleProviders');
            return null;
        }

        // Config is valid
        return config;
    }

    /**
     * Clear visual state cache but preserve form data
     * Called when version changes or config is invalid
     */
    function clearVisualStateCache() {
        try {
            console.log('[Config] Clearing visual state cache');
            VISUAL_STATE_KEYS.forEach(key => {
                try {
                    localStorage.removeItem(key);
                } catch (e) {
                    // Ignore individual removals
                }
            });
        } catch (error) {
            console.warn('[Config] Failed to clear visual state:', error.message);
        }
    }

    /**
     * Load configuration from localStorage with version validation
     * @returns {Object|null} The cached configuration or null if not found/invalid/stale
     */
    async function loadConfigFromCache() {
        try {
            const cachedConfig = localStorage.getItem(CACHE_KEY);
            if (!cachedConfig) {
                return null;
            }

            const config = JSON.parse(cachedConfig);

            // Validate config structure
            if (!validateConfig(config)) {
                console.warn('[Config] Cached config is invalid, clearing cache');
                clearConfigCache();
                clearVisualStateCache();
                return null;
            }

            // Check version mismatch
            const cachedVersion = localStorage.getItem(CACHE_VERSION_KEY);
            const currentVersion = await getCurrentAppVersion();

            if (cachedVersion && cachedVersion !== currentVersion) {
                console.log(`[Config] Version mismatch: cached=${cachedVersion}, current=${currentVersion}. Clearing visual state.`);
                clearVisualStateCache();
                // Keep the config data but clear visual state
                // Update the cached version
                localStorage.setItem(CACHE_VERSION_KEY, currentVersion);
            }

            return config;
        } catch (error) {
            console.error('[Config] Error loading cached config:', error.message);
            return null;
        }
    }

    /**
     * Clear cached configuration from localStorage
     */
    function clearConfigCache() {
        try {
            localStorage.removeItem(CACHE_KEY);
            localStorage.removeItem(CACHE_EXPIRY_KEY);
            localStorage.removeItem(CACHE_VERSION_KEY);
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

        // Load Gemini API key
        document.getElementById('geminiApiKey').value = currentConfig.geminiApiKey || '';

        // Load Gemini model
        const modelSelect = document.getElementById('geminiModel');
        let modelToUse = currentConfig.geminiModel || 'gemini-2.5-flash-lite-preview-09-2025';

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

        // Load user credentials (optional)
        document.getElementById('opensubtitlesUsername').value =
            currentConfig.subtitleProviders?.opensubtitles?.username || '';
        document.getElementById('opensubtitlesPassword').value =
            currentConfig.subtitleProviders?.opensubtitles?.password || '';

        // toggleProviderConfig will call handleOpenSubtitlesImplChange to set auth fields visibility
        toggleProviderConfig('opensubtitlesConfig', opensubtitlesEnabled);

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

        // Load file translation setting
        document.getElementById('fileTranslationEnabled').checked = currentConfig.fileTranslationEnabled !== false;

        // Load Dev: Sync Subtitles setting (if panel exists)
        const syncEl = document.getElementById('syncSubtitlesEnabled');
        if (syncEl) syncEl.checked = currentConfig.syncSubtitlesEnabled === true;

        // Load translation cache settings
        if (!currentConfig.translationCache) {
            currentConfig.translationCache = getDefaultConfig().translationCache;
        }
        document.getElementById('cacheEnabled').checked = currentConfig.translationCache?.enabled !== false;
        const bypassEl = document.getElementById('bypassCache');
        if (bypassEl) bypassEl.checked = currentConfig.bypassCache === true;
        updateCacheToggles();

        // Load advanced settings
        if (!currentConfig.advancedSettings) {
            currentConfig.advancedSettings = getDefaultConfig().advancedSettings;
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

        // Check if advanced settings are modified and update bypass cache accordingly
        updateBypassCacheForAdvancedSettings();
    }

    async function handleSubmit(e) {
        e.preventDefault();
        console.log('[handleSubmit] Form submission started');
        console.log('[handleSubmit] currentConfig:', currentConfig);

        const promptStyle = document.getElementById('promptStyle').value;
        let translationPrompt = '';

        // Determine the translation prompt based on style
        if (promptStyle === 'strict') {
            translationPrompt = STRICT_TRANSLATION_PROMPT;
        } else if (promptStyle === 'natural') {
            translationPrompt = NATURAL_TRANSLATION_PROMPT;
        }

        console.log('[handleSubmit] noTranslationMode:', currentConfig.noTranslationMode);
        console.log('[handleSubmit] noTranslationLanguages:', currentConfig.noTranslationLanguages);

        const config = {
            noTranslationMode: currentConfig.noTranslationMode,
            noTranslationLanguages: currentConfig.noTranslationLanguages,
            geminiApiKey: document.getElementById('geminiApiKey').value.trim(),
            // Save the selected model from the dropdown
            // Advanced settings can override this if enabled
            geminiModel: document.getElementById('geminiModel')?.value || 'gemini-2.5-flash-lite-preview-09-2025',
            promptStyle: promptStyle,
            translationPrompt: translationPrompt,
            sourceLanguages: currentConfig.sourceLanguages,
            targetLanguages: currentConfig.targetLanguages,
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
                enabled: document.getElementById('cacheEnabled').checked,
                duration: 0,
                persistent: true
            },
            bypassCache: (function() {
                const advSettingsModified = areAdvancedSettingsModified();
                const cacheDisabled = !document.getElementById('cacheEnabled').checked;
                const bypassChecked = document.getElementById('bypassCache')?.checked || false;
                return advSettingsModified || cacheDisabled || bypassChecked;
            })(),
            bypassCacheConfig: {
                enabled: (function() {
                    const advSettingsModified = areAdvancedSettingsModified();
                    const cacheDisabled = !document.getElementById('cacheEnabled').checked;
                    const bypassChecked = document.getElementById('bypassCache')?.checked || false;
                    return advSettingsModified || cacheDisabled || bypassChecked;
                })(),
                duration: 12
            },
            tempCache: { // Deprecated: kept for backward compatibility
                enabled: (function() {
                    const advSettingsModified = areAdvancedSettingsModified();
                    const cacheDisabled = !document.getElementById('cacheEnabled').checked;
                    const bypassChecked = document.getElementById('bypassCache')?.checked || false;
                    return advSettingsModified || cacheDisabled || bypassChecked;
                })(),
                duration: 12
            },
            fileTranslationEnabled: document.getElementById('fileTranslationEnabled').checked,
            syncSubtitlesEnabled: (function(){ const el = document.getElementById('syncSubtitlesEnabled'); return el ? el.checked : false; })(),
            advancedSettings: {
                enabled: areAdvancedSettingsModified(), // Auto-detect if any setting differs from defaults
                geminiModel: (function(){ const el = document.getElementById('advancedModel'); return el ? el.value : ''; })(),
                thinkingBudget: (function(){ const el = document.getElementById('advancedThinkingBudget'); return el ? parseInt(el.value) : 0; })(),
                temperature: (function(){ const el = document.getElementById('advancedTemperature'); return el ? parseFloat(el.value) : 0.8; })(),
                topP: (function(){ const el = document.getElementById('advancedTopP'); return el ? parseFloat(el.value) : 0.95; })(),
                topK: 40, // Keep default topK
                enableBatchContext: (function(){ const el = document.getElementById('enableBatchContext'); return el ? el.checked : false; })(),
                contextSize: (function(){ const el = document.getElementById('contextSize'); return el ? parseInt(el.value) : 3; })()
            }
        };

        // Validation with visual feedback - collect all errors
        const errors = [];
        console.log('[handleSubmit] Starting validation');

        const anyProviderEnabled = Object.values(config.subtitleProviders).some(p => p.enabled);
        if (!anyProviderEnabled) {
            errors.push('⚠️ Please enable at least one subtitle provider');
        }
        console.log('[handleSubmit] anyProviderEnabled:', anyProviderEnabled);

        // Validate that at least one of cache options is enabled
        const cacheEnabled = document.getElementById('cacheEnabled').checked;
        const bypassCache = document.getElementById('bypassCache')?.checked || false;
        console.log('[handleSubmit] cacheEnabled:', cacheEnabled, 'bypassCache:', bypassCache);
        if (!cacheEnabled && !bypassCache) {
            errors.push('⚠️ At least one cache option must be enabled: either "Enable SubMaker Database" or "Bypass SubMaker Database Cache"');
        }

        // Validate enabled subtitle sources have API keys (where required)
        if (config.subtitleProviders.subdl?.enabled && !config.subtitleProviders.subdl.apiKey?.trim()) {
            errors.push('⚠️ SubDL is enabled but API key is missing');
        }
        if (config.subtitleProviders.subsource?.enabled && !config.subtitleProviders.subsource.apiKey?.trim()) {
            errors.push('⚠️ SubSource is enabled but API key is missing');
        }

        // If not in no-translation mode, validate Gemini API and model
        console.log('[handleSubmit] config.noTranslationMode:', config.noTranslationMode);
        if (!config.noTranslationMode) {
            if (!validateGeminiApiKey(true)) {
                errors.push('⚠️ Gemini API key is required');
            }

            if (!validateGeminiModel()) {
                errors.push('⚠️ Please select a Gemini model');
            }

            if (!validateLanguageSelection('source')) {
                errors.push('⚠️ Please select 1-3 source languages');
            }

            if (!validateLanguageSelection('target')) {
                errors.push('⚠️ Please select at least one target language');
            }
        } else {
            // In no-translation mode, validate that at least one language is selected
            console.log('[handleSubmit] No-translation mode: checking languages');
            if (!config.noTranslationLanguages || config.noTranslationLanguages.length === 0) {
                errors.push('⚠️ Please select at least one language in no-translation mode');
                console.log('[handleSubmit] ERROR: No languages selected in no-translation mode');
            }
        }

        console.log('[handleSubmit] Validation errors:', errors);
        if (errors.length > 0) {
            // Show all errors as a single alert
            const errorMessage = errors.join('<br>');
            console.log('[handleSubmit] Showing validation errors');
            showAlert(errorMessage, 'error');

            // Focus on first invalid field
            if (!config.noTranslationMode) {
                if (!validateGeminiApiKey()) {
                    document.getElementById('geminiApiKey')?.focus();
                } else if (!validateGeminiModel()) {
                    document.getElementById('geminiModel')?.focus();
                }
            }
            return;
        }

        // Check if we have an existing session token
        let existingToken = localStorage.getItem(TOKEN_KEY);
        let configToken;
        let isUpdate = false;
        console.log('[handleSubmit] Session handling started');
        console.log('[handleSubmit] Existing token:', existingToken ? existingToken.substring(0, 8) + '...' : 'none');

        try {
            if (existingToken) {
                // FIXED: Validate token format before attempting update
                // Session tokens should be 32-character hex strings
                const isValidTokenFormat = /^[a-f0-9]{32}$/.test(existingToken);
                console.log('[handleSubmit] Token format valid:', isValidTokenFormat);

                if (!isValidTokenFormat) {
                    console.warn('[Config] Invalid token format in localStorage, clearing and creating new session');
                    localStorage.removeItem(TOKEN_KEY);
                    existingToken = null;
                } else {
                    // Try to update existing session first
                    console.log('[handleSubmit] Attempting to update existing session');
                    try {
                        const updateResponse = await fetch(`/api/update-session/${existingToken}`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify(config),
                            timeout: 10000 // 10 second timeout
                        });

                        // FIXED: Better error handling for different response codes
                        console.log('[handleSubmit] Update response status:', updateResponse.status);
                        if (updateResponse.status === 404 || updateResponse.status === 410) {
                            // Token not found or expired - create new session
                            console.warn('[Config] Session token not found on server (404/410), creating new session');
                            showAlert('Session expired. Creating new session...', 'info');
                            localStorage.removeItem(TOKEN_KEY);
                            existingToken = null;
                        } else if (!updateResponse.ok) {
                            // Other errors - log and try to create new session
                            const errorText = await updateResponse.text();
                            console.error(`[Config] Update session failed (${updateResponse.status}):`, errorText);
                            showAlert('Session update failed. Creating new session...', 'warning');
                            localStorage.removeItem(TOKEN_KEY);
                            existingToken = null;
                        } else {
                            // Success
                            const sessionData = await updateResponse.json();
                            console.log('[handleSubmit] Update response success, got token:', sessionData.token ? sessionData.token.substring(0, 8) + '...' : 'none');
                            configToken = sessionData.token;
                            isUpdate = sessionData.updated;

                            if (sessionData.updated) {
                                showAlert('Configuration updated! Changes will take effect immediately in Stremio.', 'success');
                            } else if (sessionData.created) {
                                // Token was expired, new one created
                                showAlert('Session expired. Created new session - please reinstall addon in Stremio.', 'warning');
                                localStorage.setItem(TOKEN_KEY, configToken);
                            }
                        }
                    } catch (updateError) {
                        // Network error or timeout - log and fall back to create new session
                        console.error('[Config] Failed to update session:', updateError.message);
                        showAlert('Network error updating session. Creating new session...', 'warning');
                        localStorage.removeItem(TOKEN_KEY);
                        existingToken = null;
                    }
                }
            }

            // If we don't have a valid token, create new session
            if (!existingToken) {
                console.log('[handleSubmit] Creating new session');
                try {
                    const createResponse = await fetch('/api/create-session', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(config),
                        timeout: 10000 // 10 second timeout
                    });

                    console.log('[handleSubmit] Create response status:', createResponse.status);
                    if (!createResponse.ok) {
                        const errorText = await createResponse.text();
                        throw new Error(`Failed to create session (${createResponse.status}): ${errorText}`);
                    }

                    const sessionData = await createResponse.json();
                    console.log('[handleSubmit] Session created, token:', sessionData.token ? sessionData.token.substring(0, 8) + '...' : 'none');

                    // FIXED: Validate response token format
                    if (!sessionData.token || !/^[a-f0-9]{32}$/.test(sessionData.token)) {
                        throw new Error('Server returned invalid session token format');
                    }

                    configToken = sessionData.token;
                    isUpdate = false;
                } catch (createError) {
                    console.error('[Config] Failed to create session:', createError.message);
                    showAlert('Failed to save configuration: ' + createError.message, 'error');
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
            console.error('[Config] Unexpected error during session handling:', error);
            showAlert('Failed to save configuration: ' + error.message, 'error');
            return;
        }

        // Use current origin if in production, otherwise use localhost
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const baseUrl = isLocalhost ? 'http://localhost:7001' : window.location.origin;
        const installUrl = `${baseUrl}/addon/${configToken}/manifest.json`;
        console.log('[handleSubmit] Install URL generated:', installUrl);

        // Save to current config
        currentConfig = config;

        // Cache the configuration to localStorage
        saveConfigToCache(config);
        console.log('[handleSubmit] Config cached to localStorage');

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
            showAlert('Configuration saved! You can now install the addon in Stremio.', 'success');
            console.log('[handleSubmit] Save completed successfully (new config)');
        } else {
            console.log('[handleSubmit] Save completed successfully (updated config)');
        }
        // Update message already shown above
    }

    function installAddon() {
        if (window.installUrl) {
            // Extract the config and path from the install URL
            // The installUrl is in format: http://localhost:7001/{config}/manifest.json
            // Stremio protocol format: stremio://localhost:7001/{config}/manifest.json
            const url = new URL(window.installUrl);
            const stremioUrl = `stremio://${url.host}${url.pathname}`;
            window.location.href = stremioUrl;
            showAlert('Opening Stremio...', 'info');
        }
    }

    async function copyInstallUrl() {
        if (window.installUrl) {
            try {
                await navigator.clipboard.writeText(window.installUrl);
                showAlert('Install URL copied to clipboard!', 'success');
            } catch (error) {
                // Fallback
                const input = document.createElement('input');
                input.value = window.installUrl;
                document.body.appendChild(input);
                input.select();
                document.execCommand('copy');
                document.body.removeChild(input);
                showAlert('Install URL copied to clipboard!', 'success');
            }
        }
    }

    function showAlert(message, type = 'success') {
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

        alert.innerHTML = `<span style="font-size: 1.25rem;">${icon}</span><div style="flex: 1;">${message}</div>`;

        container.appendChild(alert);

        // Show errors longer (8s) than success messages (5s)
        const displayTime = type === 'error' ? 5000 : 5000;

        setTimeout(() => {
            alert.style.animation = 'slideInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1) reverse';
            setTimeout(() => alert.remove(), 300);
        }, displayTime);
    }

    function showLoading(show) {
        const loading = document.getElementById('loadingOverlay');
        loading.classList.toggle('show', show);
    }
})();
