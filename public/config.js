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
     */
    const DEFAULT_API_KEYS = {
        // Do not ship real keys in the client bundle
        OPENSUBTITLES: '',
        SUBDL: '',
        SUBSOURCE: '',
        PODNAPISI: '',
        GEMINI: ''
    };

    // Popular languages for quick selection
    const POPULAR_LANGUAGES = ['eng', 'spa', 'fre', 'ger', 'por', 'pob', 'ita', 'rus', 'jpn', 'kor', 'chi', 'ara'];

    // Translation prompt presets
    const STRICT_TRANSLATION_PROMPT = `You are a professional subtitle translator. Translate the following subtitles while:
1. Preserving the timing and structure exactly as given
2. Maintaining natural dialogue flow and colloquialisms appropriate to the target language
3. Keeping the same number of lines and line breaks
4. Preserving any formatting tags or special characters
5. Ensuring translations are contextually accurate for film/TV dialogue

Translate from {source_language} to {target_language}.`;

    const NATURAL_TRANSLATION_PROMPT = `You are a professional subtitle translator. Translate the following subtitles while:

1. Trying to preserve the timing and structure exactly as given, correctly adapting for natural target language subtitles flow if deemed necessary.

2. The same is true for number of lines and line breaks

3. Maintaining natural dialogue flow and colloquialisms appropriate to the target language

4. Preserving any formatting tags or special characters

5. Ensuring translations are contextually accurate for film/TV dialogue

This is an automatic system, you must return ONLY the subtitles output/file.

Translate from {source_language} to {target_language}.`;

    // State management
    let currentConfig = parseConfigFromUrl();
    let allLanguages = [];
    let modelsFetchTimeout = null;
    let lastFetchedApiKey = null;

    // localStorage cache keys
    const CACHE_KEY = 'submaker_config_cache';
    const CACHE_EXPIRY_KEY = 'submaker_config_cache_expiry';
    const TOKEN_KEY = 'submaker_session_token';

    // Initialize
    document.addEventListener('DOMContentLoaded', init);

    async function init() {
        // Priority: cached config > URL config > default config
        // This ensures browser cache is respected unless explicitly shared via URL
        const cachedConfig = loadConfigFromCache();
        const urlConfig = parseConfigFromUrl();
        const hasExplicitUrlConfig = new URLSearchParams(window.location.search).has('config');

        if (cachedConfig && !hasExplicitUrlConfig) {
            // Use cached config - this is the most common case
            currentConfig = cachedConfig;
        } else if (hasExplicitUrlConfig) {
            // URL has explicit config - use it (for sharing/linking)
            currentConfig = urlConfig;
        }
        // else: currentConfig already initialized from parseConfigFromUrl() at top

        await loadLanguages();
        setupEventListeners();
        loadConfigToForm();
        setupKeyboardShortcuts();
        showKeyboardHint();

        // Auto-fetch models if API key exists
        const apiKey = document.getElementById('geminiApiKey').value.trim();
        if (apiKey) {
            await autoFetchModels(apiKey);
        }

        // Show instructions modal on first visit
        showInstructionsModalIfNeeded();
    }

    // Modal management functions
    function showInstructionsModalIfNeeded() {
        const dontShow = localStorage.getItem('submaker_dont_show_instructions');
        if (!dontShow) {
            setTimeout(() => {
                document.getElementById('instructionsModal').classList.add('show');
            }, 500);
        }
    }

    window.closeInstructionsModal = function() {
        const dontShowEl = document.getElementById('dontShowInstructions');
        const dontShow = dontShowEl ? dontShowEl.checked : false;
        if (dontShow) {
            localStorage.setItem('submaker_dont_show_instructions', 'true');
        }
        const modal = document.getElementById('instructionsModal');
        if (modal) modal.classList.remove('show');
    };

    window.closeFileTranslationModal = function() {
        const dontShowEl = document.getElementById('dontShowFileTranslation');
        const dontShow = dontShowEl ? dontShowEl.checked : false;
        if (dontShow) {
            localStorage.setItem('submaker_dont_show_file_translation', 'true');
        }
        const modal = document.getElementById('fileTranslationModal');
        if (modal) modal.classList.remove('show');
    };

    function showFileTranslationModal() {
        const dontShow = localStorage.getItem('submaker_dont_show_file_translation');
        if (!dontShow) {
            document.getElementById('fileTranslationModal').classList.add('show');
        }
    }

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
                console.error('Failed to parse config:', e);
            }
        }

        return getDefaultConfig();
    }

    function getDefaultConfig() {
        return {
            noTranslationMode: false, // If true, skip translation and just fetch subtitles
            noTranslationLanguages: [], // Languages to fetch when in no-translation mode
            sourceLanguages: ['eng'], // Up to 3 source languages allowed
            targetLanguages: [],
            geminiApiKey: DEFAULT_API_KEYS.GEMINI,
            geminiModel: '',
            promptStyle: 'strict', // 'natural' or 'strict'
            translationPrompt: STRICT_TRANSLATION_PROMPT,
            subtitleProviders: {
                opensubtitles: {
                    enabled: true,
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
                podnapisi: {
                    enabled: false, // Disabled by default - not accessible from UI
                    apiKey: DEFAULT_API_KEYS.PODNAPISI
                }
            },
            translationCache: {
                enabled: true,
                duration: 0, // hours, 0 = permanent
                persistent: true // save to disk
            },
            bypassCache: false,
            tempCache: {
                enabled: true,
                duration: 12
            },
            fileTranslationEnabled: false, // enable file upload translation feature
            advancedSettings: {
                maxOutputTokens: 65536,
                chunkSize: 10000,
                translationTimeout: 600, // seconds
                maxRetries: 5
            }
        };
    }

    async function loadLanguages() {
        const maxRetries = 3;
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`[Languages] Attempt ${attempt}/${maxRetries} - Fetching from /api/languages...`);
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
                console.log(`[Languages] Response status: ${response.status}`);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const languages = await response.json();
                console.log(`[Languages] Successfully loaded ${languages.length} languages`);

                // Filter out special fake languages (like ___upload for File Translation)
                allLanguages = languages.filter(lang => !lang.code.startsWith('___'));
                console.log(`[Languages] After filtering: ${allLanguages.length} languages`);

                renderLanguageGrid('sourceLanguages', 'selectedSourceLanguages', allLanguages);
                renderLanguageGrid('targetLanguages', 'selectedTargetLanguages', allLanguages);
                renderLanguageGrid('noTranslationLanguages', 'selectedNoTranslationLanguages', allLanguages);

                // Update selected chips
                updateSelectedChips('source', currentConfig.sourceLanguages);
                updateSelectedChips('target', currentConfig.targetLanguages);
                updateSelectedChips('notranslation', currentConfig.noTranslationLanguages);

                console.log('[Languages] Language loading completed successfully');
                return; // Success - exit function
            } catch (error) {
                lastError = error;
                console.error(`[Languages] Attempt ${attempt} failed:`, error.message);

                if (attempt < maxRetries) {
                    const delayMs = 1000 * attempt; // Exponential backoff: 1s, 2s, 3s
                    console.log(`[Languages] Retrying in ${delayMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
        }

        // All retries failed
        console.error('[Languages] All retry attempts failed. Error:', lastError);
        console.error('[Languages] Error details:', {
            message: lastError.message,
            name: lastError.name
        });
        showAlert(`Failed to load languages after ${maxRetries} attempts: ${lastError.message}. Please refresh the page.`, 'error');
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

        // Gemini API key auto-fetch
        const apiKeyInput = document.getElementById('geminiApiKey');
        apiKeyInput.addEventListener('input', debounce((e) => {
            const apiKey = e.target.value.trim();
            if (apiKey && apiKey !== lastFetchedApiKey) {
                autoFetchModels(apiKey);
            }
        }, 1000));

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

        // Cache UI toggle
        document.getElementById('cacheEnabled').addEventListener('change', updateCacheUI);

        // Bypass UI toggle
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

        // Podnapisi removed from UI - no event listener needed
        // document.getElementById('enablePodnapisi').addEventListener('change', (e) => {
        //     toggleProviderConfig('podnapisConfig', e.target.checked);
        // });

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

        // Prompt style selector
        document.getElementById('promptStyle').addEventListener('change', handlePromptStyleChange);

        // Advanced settings toggle (element may not exist in current UI)
        const showAdv = document.getElementById('showAdvancedSettings');
        if (showAdv) {
            showAdv.addEventListener('change', handleAdvancedSettingsToggle);
        }

        // Live validation
        document.getElementById('geminiApiKey').addEventListener('input', validateGeminiApiKey);
        document.getElementById('geminiModel').addEventListener('change', validateGeminiModel);

        // File translation toggle - show modal when enabled
        document.getElementById('fileTranslationEnabled').addEventListener('change', (e) => {
            if (e.target.checked) {
                showFileTranslationModal();
            }
        });

        // Modal close buttons
        const closeInstructionsBtn = document.getElementById('closeInstructionsBtn');
        if (closeInstructionsBtn) {
            closeInstructionsBtn.addEventListener('click', window.closeInstructionsModal);
        }

        const gotItInstructionsBtn = document.getElementById('gotItInstructionsBtn');
        if (gotItInstructionsBtn) {
            gotItInstructionsBtn.addEventListener('click', window.closeInstructionsModal);
        }

        const closeFileTranslationBtn = document.getElementById('closeFileTranslationBtn');
        if (closeFileTranslationBtn) {
            closeFileTranslationBtn.addEventListener('click', window.closeFileTranslationModal);
        }

        const gotItFileTranslationBtn = document.getElementById('gotItFileTranslationBtn');
        if (gotItFileTranslationBtn) {
            gotItFileTranslationBtn.addEventListener('click', window.closeFileTranslationModal);
        }
    }

    function handlePromptStyleChange(e) {
        // Prompt style change handler - no longer needed for custom prompts
        // Keeping this function for potential future extensions
    }

    function updateCacheUI() {
        const cacheEnabledInput = document.getElementById('cacheEnabled');
        const cacheEnabled = cacheEnabledInput ? cacheEnabledInput.checked : true;
        const bypassGroup = document.getElementById('bypassCacheGroup');
        const bypassInput = document.getElementById('bypassCache');
        const bypassChecked = bypassInput ? bypassInput.checked : false;

        // Always show bypass toggle below main caching
        if (bypassGroup) {
            bypassGroup.style.display = 'block';
            bypassGroup.style.opacity = cacheEnabled ? '0.6' : '1';
        }

        // If caching is enabled, bypass is disabled & unchecked
        if (cacheEnabled) {
            if (bypassInput) {
                bypassInput.disabled = true;
                bypassInput.checked = false;
            }
            if (cacheEnabledInput) cacheEnabledInput.disabled = false;
            return;
        }

        // Caching is disabled: bypass is enabled; if bypass is checked, disable the caching toggle
        if (bypassInput) {
            bypassInput.disabled = false;
        }
        if (bypassChecked) {
            if (cacheEnabledInput) {
                cacheEnabledInput.checked = false;
                cacheEnabledInput.disabled = true;
            }
        } else {
            if (cacheEnabledInput) cacheEnabledInput.disabled = false;
        }
    }

    function handleBypassToggle(e) {
        const bypass = e.target.checked;
        const cacheEnabledInput = document.getElementById('cacheEnabled');
        if (bypass) {
            if (cacheEnabledInput) {
                cacheEnabledInput.checked = false;
                cacheEnabledInput.disabled = true;
            }
        } else {
            if (cacheEnabledInput) cacheEnabledInput.disabled = false;
        }
        updateCacheUI();
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

    function validateGeminiApiKey() {
        const input = document.getElementById('geminiApiKey');
        const error = document.getElementById('geminiApiKeyError');
        const value = input.value.trim();
        
        if (!value) {
            input.classList.add('invalid');
            input.classList.remove('valid');
            error.classList.add('show');
            return false;
        } else {
            input.classList.remove('invalid');
            input.classList.add('valid');
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
        } else {
            // Hide no-translation card, show source, target, and gemini cards
            if (noTranslationCard) noTranslationCard.style.display = 'none';
            if (sourceCard) sourceCard.style.display = 'block';
            if (targetCard) targetCard.style.display = 'block';
            if (geminiCard) geminiCard.style.display = 'block';
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
        statusDiv.innerHTML = '<div class="spinner-small"></div> Fetching models...';
        statusDiv.className = 'model-status fetching';

        try {
            const response = await fetch('/api/gemini-models', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey })
            });

            if (!response.ok) {
                throw new Error('Failed to fetch models');
            }

            const models = await response.json();
            const modelSelect = document.getElementById('geminiModel');

            // Clear and populate model dropdown
            modelSelect.innerHTML = '<option value="">Select a model...</option>';

            models.forEach(model => {
                const option = document.createElement('option');
                option.value = model.name;
                option.textContent = `${model.displayName}`;

                if (currentConfig.geminiModel === model.name) {
                    option.selected = true;
                }

                modelSelect.appendChild(option);
            });

            // Select default if none selected
            if (!modelSelect.value && models.length > 0) {
                // Priority: Gemini Flash-Lite Latest → flash-lite latest → flash-lite (any) → flash (any) → first model
                const geminiFlashLiteLatest = models.find(m => m.displayName && m.displayName.includes('Gemini Flash-Lite Latest'));
                const flashLiteLatest = models.find(m => m.name.includes('flash-lite') && !m.name.includes('preview'));
                const flashLiteAny = models.find(m => m.name.includes('flash-lite'));
                const flashModel = models.find(m => m.name.includes('flash'));

                if (geminiFlashLiteLatest) {
                    modelSelect.value = geminiFlashLiteLatest.name;
                } else if (flashLiteLatest) {
                    modelSelect.value = flashLiteLatest.name;
                } else if (flashLiteAny) {
                    modelSelect.value = flashLiteAny.name;
                } else if (flashModel) {
                    modelSelect.value = flashModel.name;
                } else {
                    modelSelect.value = models[0].name;
                }
            }

            lastFetchedApiKey = apiKey;
            statusDiv.innerHTML = '✓ Models loaded successfully!';
            statusDiv.className = 'model-status success';

            setTimeout(() => {
                statusDiv.innerHTML = '';
                statusDiv.className = 'model-status';
            }, 3000);

        } catch (error) {
            console.error('Failed to fetch models:', error);
            statusDiv.innerHTML = '✗ Failed to fetch models. Check your API key.';
            statusDiv.className = 'model-status error';

            setTimeout(() => {
                statusDiv.innerHTML = '';
                statusDiv.className = 'model-status';
            }, 5000);
        }
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
        if (configDiv) {
            configDiv.style.opacity = enabled ? '1' : '0.5';
            configDiv.style.pointerEvents = enabled ? 'auto' : 'none';
        }
    }

    /**
     * Save configuration to localStorage
     * @param {Object} config - The configuration object to save
     */
    function saveConfigToCache(config) {
        try {
            // Save config and timestamp
            localStorage.setItem(CACHE_KEY, JSON.stringify(config));
            localStorage.setItem(CACHE_EXPIRY_KEY, Date.now().toString());
        } catch (error) {
            console.error('Failed to cache configuration:', error);
            // Continue anyway - caching is optional
        }
    }

    /**
     * Load configuration from localStorage
     * @returns {Object|null} The cached configuration or null if not found/invalid
     */
    function loadConfigFromCache() {
        try {
            const cachedConfig = localStorage.getItem(CACHE_KEY);
            if (!cachedConfig) {
                return null;
            }

            const config = JSON.parse(cachedConfig);
            return config;
        } catch (error) {
            console.error('Failed to load cached configuration:', error);
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
            console.log('Configuration cache cleared');
        } catch (error) {
            console.error('Failed to clear cache:', error);
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
        if (currentConfig.geminiModel) {
            const option = document.createElement('option');
            option.value = currentConfig.geminiModel;
            option.textContent = currentConfig.geminiModel;
            option.selected = true;
            modelSelect.appendChild(option);
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
        const opensubtitlesEnabled = currentConfig.subtitleProviders?.opensubtitles?.enabled !== false;
        document.getElementById('enableOpenSubtitles').checked = opensubtitlesEnabled;

        // Load user credentials (optional)
        document.getElementById('opensubtitlesUsername').value =
            currentConfig.subtitleProviders?.opensubtitles?.username || '';
        document.getElementById('opensubtitlesPassword').value =
            currentConfig.subtitleProviders?.opensubtitles?.password || '';

        toggleProviderConfig('opensubtitlesConfig', opensubtitlesEnabled);

        // SubDL
        const subdlEnabled = currentConfig.subtitleProviders?.subdl?.enabled !== false;
        document.getElementById('enableSubDL').checked = subdlEnabled;
        document.getElementById('subdlApiKey').value = 
            currentConfig.subtitleProviders?.subdl?.apiKey || DEFAULT_API_KEYS.SUBDL;
        toggleProviderConfig('subdlConfig', subdlEnabled);

        // SubSource
        const subsourceEnabled = currentConfig.subtitleProviders?.subsource?.enabled !== false;
        document.getElementById('enableSubSource').checked = subsourceEnabled;
        document.getElementById('subsourceApiKey').value =
            currentConfig.subtitleProviders?.subsource?.apiKey || DEFAULT_API_KEYS.SUBSOURCE;
        toggleProviderConfig('subsourceConfig', subsourceEnabled);

        // Podnapisi removed from UI - no need to load config
        // const podnapisEnabled = currentConfig.subtitleProviders?.podnapisi?.enabled === true;
        // document.getElementById('enablePodnapisi').checked = podnapisEnabled;
        // document.getElementById('podnapisApiKey').value =
        //     currentConfig.subtitleProviders?.podnapisi?.apiKey || DEFAULT_API_KEYS.PODNAPISI;
        // toggleProviderConfig('podnapisConfig', podnapisEnabled);

        // Load file translation setting
        document.getElementById('fileTranslationEnabled').checked = currentConfig.fileTranslationEnabled !== false;

        // Load translation cache settings
        if (!currentConfig.translationCache) {
            currentConfig.translationCache = getDefaultConfig().translationCache;
        }
        document.getElementById('cacheEnabled').checked = currentConfig.translationCache?.enabled !== false;
        const bypassEl = document.getElementById('bypassCache');
        if (bypassEl) bypassEl.checked = currentConfig.bypassCache === true;
        updateCacheUI();

        // Load advanced settings (inputs may not exist in current UI)
        if (!currentConfig.advancedSettings) {
            currentConfig.advancedSettings = getDefaultConfig().advancedSettings;
        }
        const advMaxTokensEl = document.getElementById('maxOutputTokens');
        const advChunkSizeEl = document.getElementById('chunkSize');
        const advTimeoutEl = document.getElementById('translationTimeout');
        const advRetriesEl = document.getElementById('maxRetries');

        if (advMaxTokensEl) advMaxTokensEl.value = currentConfig.advancedSettings?.maxOutputTokens || 65536;
        if (advChunkSizeEl) advChunkSizeEl.value = currentConfig.advancedSettings?.chunkSize || 10000;
        if (advTimeoutEl) advTimeoutEl.value = currentConfig.advancedSettings?.translationTimeout || 600;
        if (advRetriesEl) advRetriesEl.value = currentConfig.advancedSettings?.maxRetries || 5;
    }

    async function handleSubmit(e) {
        e.preventDefault();

        const promptStyle = document.getElementById('promptStyle').value;
        let translationPrompt = '';

        // Determine the translation prompt based on style
        if (promptStyle === 'strict') {
            translationPrompt = STRICT_TRANSLATION_PROMPT;
        } else if (promptStyle === 'natural') {
            translationPrompt = NATURAL_TRANSLATION_PROMPT;
        }

        const config = {
            noTranslationMode: currentConfig.noTranslationMode,
            noTranslationLanguages: currentConfig.noTranslationLanguages,
            geminiApiKey: document.getElementById('geminiApiKey').value.trim(),
            geminiModel: document.getElementById('geminiModel').value,
            promptStyle: promptStyle,
            translationPrompt: translationPrompt,
            sourceLanguages: currentConfig.sourceLanguages,
            targetLanguages: currentConfig.targetLanguages,
            subtitleProviders: {
                opensubtitles: {
                    enabled: document.getElementById('enableOpenSubtitles').checked,
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
                podnapisi: {
                    enabled: false, // Podnapisi disabled - not accessible from UI
                    apiKey: DEFAULT_API_KEYS.PODNAPISI
                }
            },
            translationCache: {
                enabled: document.getElementById('cacheEnabled').checked,
                duration: 0,
                persistent: true
            },
            bypassCache: (!document.getElementById('cacheEnabled').checked) || (document.getElementById('bypassCache') && document.getElementById('bypassCache').checked) || false,
            tempCache: {
                enabled: (!document.getElementById('cacheEnabled').checked) || (document.getElementById('bypassCache') && document.getElementById('bypassCache').checked) || false,
                duration: 12
            },
            fileTranslationEnabled: document.getElementById('fileTranslationEnabled').checked,
            advancedSettings: {
                maxOutputTokens: (function(){ const el = document.getElementById('maxOutputTokens'); return parseInt(el ? el.value : '') || 65536; })(),
                chunkSize: (function(){ const el = document.getElementById('chunkSize'); return parseInt(el ? el.value : '') || 10000; })(),
                translationTimeout: (function(){ const el = document.getElementById('translationTimeout'); return parseInt(el ? el.value : '') || 600; })(),
                maxRetries: (function(){ const el = document.getElementById('maxRetries'); return parseInt(el ? el.value : '') || 5; })()
            }
        };

        // Validation with visual feedback
        let isValid = true;

        const anyProviderEnabled = Object.values(config.subtitleProviders).some(p => p.enabled);
        if (!anyProviderEnabled) {
            showAlert('Please enable at least one subtitle provider', 'error');
            isValid = false;
        }

        // If not in no-translation mode, validate Gemini API and model
        if (!config.noTranslationMode) {
            if (!validateGeminiApiKey()) {
                showAlert('Gemini API key is required', 'error');
                document.getElementById('geminiApiKey').focus();
                isValid = false;
            }

            if (!validateGeminiModel()) {
                showAlert('Please select a Gemini model', 'error');
                if (isValid) document.getElementById('geminiModel').focus();
                isValid = false;
            }

            if (!validateLanguageSelection('source')) {
                showAlert('Please select 1-3 source languages', 'error');
                isValid = false;
            }

            if (!validateLanguageSelection('target')) {
                showAlert('Please select at least one target language', 'error');
                isValid = false;
            }
        } else {
            // In no-translation mode, validate that at least one language is selected
            if (!config.noTranslationLanguages || config.noTranslationLanguages.length === 0) {
                showAlert('Please select at least one language in no-translation mode', 'error');
                isValid = false;
            }
        }

        if (!isValid) {
            return;
        }

        // Check if we have an existing session token
        const existingToken = localStorage.getItem(TOKEN_KEY);
        let configToken;
        let isUpdate = false;

        try {
            if (existingToken) {
                // Try to update existing session first
                console.log('Updating existing session...');
                const response = await fetch(`/api/update-session/${existingToken}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(config)
                });

                if (!response.ok) {
                    throw new Error('Failed to update session: ' + await response.text());
                }

                const sessionData = await response.json();
                configToken = sessionData.token;
                isUpdate = sessionData.updated;

                if (sessionData.updated) {
                    console.log('Session updated successfully');
                    showAlert('Configuration updated! Changes will take effect immediately in Stremio.', 'success');
                } else if (sessionData.created) {
                    console.log('Session expired, created new session');
                    showAlert('Session expired. Please reinstall the addon in Stremio.', 'warning');
                }
            } else {
                // No existing token, create new session
                console.log('Creating new session...');
                const response = await fetch('/api/create-session', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(config)
                });

                if (!response.ok) {
                    throw new Error('Failed to create session: ' + await response.text());
                }

                const sessionData = await response.json();
                configToken = sessionData.token;

                console.log('Session created:', sessionData.type);
                if (sessionData.type === 'session') {
                    const expiryDays = Math.floor(sessionData.expiresIn / (24 * 60 * 60 * 1000));
                    console.log(`Session will expire in ${expiryDays} days of inactivity`);
                }
            }

            // Store token for future updates
            localStorage.setItem(TOKEN_KEY, configToken);
        } catch (error) {
            console.error('Error with session:', error);
            showAlert('Failed to save configuration: ' + error.message, 'error');
            return;
        }

        // Use current origin if in production, otherwise use localhost
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const baseUrl = isLocalhost ? 'http://localhost:7001' : window.location.origin;
        const installUrl = `${baseUrl}/addon/${configToken}/manifest.json`;

        console.log('Configuration saved!');
        console.log('Install URL:', installUrl);

        // Save to current config
        currentConfig = config;

        // Cache the configuration to localStorage
        saveConfigToCache(config);

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
            console.log('Opening Stremio:', stremioUrl);
            console.log('With manifest URL:', window.installUrl);
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

        alert.innerHTML = `<span style="font-size: 1.25rem;">${icon}</span><span>${message}</span>`;

        container.appendChild(alert);

        setTimeout(() => {
            alert.style.animation = 'slideInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1) reverse';
            setTimeout(() => alert.remove(), 300);
        }, 5000);
    }

    function showLoading(show) {
        const loading = document.getElementById('loadingOverlay');
        loading.classList.toggle('show', show);
    }
})();
