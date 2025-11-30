const { getDefaultProviderParameters, mergeProviderParameters } = require('./config');
const { getLanguageName, buildLanguageLookupMaps } = require('./languages');
const { quickNavStyles, quickNavScript, renderQuickNav, renderRefreshBadge } = require('./quickNav');
const { version: appVersion } = require('../../package.json');

function safeLanguageMaps() {
    try {
        return buildLanguageLookupMaps();
    } catch (_) {
        return { byCode: {}, byNameKey: {} };
    }
}

// Security: Enhanced HTML escaping to prevent XSS attacks
function escapeHtml(text) {
    if (text == null) return '';

    // Convert to string
    text = String(text);

    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#x27;',
        '/': '&#x2F;',
        '`': '&#x60;',
        '=': '&#x3D;'
    };

    // Escape basic HTML entities
    text = text.replace(/[&<>"'`=\/]/g, m => map[m]);

    // Additional protection: Escape unicode control characters
    text = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, ch => {
        return '&#' + ch.charCodeAt(0) + ';';
    });

    return text;
}

// Sanitize config for client-side usage on the file translation page
function buildFileTranslationClientConfig(config) {
    const defaults = getDefaultProviderParameters();
    const mergedParams = mergeProviderParameters(defaults, config?.providerParameters || {});

    const safeProviders = {};
    if (config?.providers && typeof config.providers === 'object') {
        Object.keys(config.providers).forEach(key => {
            const cfg = config.providers[key] || {};
            const clone = { ...cfg };
            delete clone.apiKey;
            safeProviders[key] = clone;
        });
    }

    return {
        sourceLanguages: Array.isArray(config?.sourceLanguages) ? config.sourceLanguages : [],
        targetLanguages: Array.isArray(config?.targetLanguages) ? config.targetLanguages : [],
        languageMaps: safeLanguageMaps(),
        advancedSettings: config?.advancedSettings || {},
        translationPrompt: config?.translationPrompt || '',
        multiProviderEnabled: config?.multiProviderEnabled === true,
        mainProvider: config?.mainProvider || '',
        secondaryProviderEnabled: config?.secondaryProviderEnabled === true,
        secondaryProvider: config?.secondaryProvider || '',
        geminiModel: config?.geminiModel || '',
        providers: safeProviders,
        providerParameters: mergedParams,
        fileTranslationEnabled: config?.fileTranslationEnabled !== false,
        singleBatchMode: config?.singleBatchMode === true
    };
}

// Build provider summary (main/fallback + merged parameters) for UI display
function buildProviderSummary(config) {
    const defaults = getDefaultProviderParameters();
    const mergedParams = mergeProviderParameters(defaults, config?.providerParameters || {});
    const multiEnabled = config?.multiProviderEnabled === true;
    const normalizeProvider = (key) => String(key || '').toLowerCase();
    const mainProvider = normalizeProvider(multiEnabled ? config?.mainProvider || 'gemini' : 'gemini');
    const secondaryEnabled = multiEnabled && config?.secondaryProviderEnabled === true;
    const secondaryProvider = secondaryEnabled ? normalizeProvider(config?.secondaryProvider) : '';

    const getModel = (key) => {
        if (!key) return '';
        const providers = config?.providers || {};
        if (key === 'gemini') return config?.geminiModel || '';
        const matchKey = Object.keys(providers).find(k => String(k).toLowerCase() === key);
        return matchKey ? providers[matchKey]?.model || '' : '';
    };

    return {
        mainProvider,
        mainModel: getModel(mainProvider),
        secondaryProvider: secondaryProvider || null,
        secondaryModel: getModel(secondaryProvider),
        providerParameters: mergedParams
    };
}

// Generate HTML page for file translation
function generateFileTranslationPage(videoId, configStr, config, filename = '') {
    const clientConfig = buildFileTranslationClientConfig(config);
    const providerSummary = buildProviderSummary(config);
    const devMode = (config || {}).devMode === true;
    const fileParam = filename ? `&filename=${encodeURIComponent(filename)}` : '';
    const subToolboxLink = `/sub-toolbox?config=${encodeURIComponent(configStr)}&videoId=${encodeURIComponent(videoId || '')}${fileParam}`;
    const translateFilesLink = `/file-upload?config=${encodeURIComponent(configStr)}&videoId=${encodeURIComponent(videoId || '')}${fileParam}`;
    const syncSubtitlesLink = `/subtitle-sync?config=${encodeURIComponent(configStr)}&videoId=${encodeURIComponent(videoId || '')}${fileParam}`;
    const autoSubtitlesLink = `/auto-subtitles?config=${encodeURIComponent(configStr)}&videoId=${encodeURIComponent(videoId || '')}${fileParam}`;
    const embeddedSubsLink = `/embedded-subtitles?config=${encodeURIComponent(configStr)}&videoId=${encodeURIComponent(videoId || '')}${fileParam}`;
    const configureLink = `/configure?config=${encodeURIComponent(configStr)}`;
    const navLinks = {
        subToolbox: subToolboxLink,
        translateFiles: translateFilesLink,
        syncSubtitles: syncSubtitlesLink,
        embeddedSubs: embeddedSubsLink,
        automaticSubs: autoSubtitlesLink,
        configure: configureLink
    };
    const maxBatchFiles = Math.max(1, Math.min(parseInt(process.env.FILE_UPLOAD_MAX_BATCH_FILES, 10) || 10, 50));
    const maxConcurrency = Math.max(1, Math.min(parseInt(process.env.FILE_UPLOAD_MAX_CONCURRENCY, 10) || 1, 5));
    const uploadQueueDefaults = { maxFiles: maxBatchFiles, maxConcurrent: maxConcurrency };
    const translationWorkflowDefaults = {
        singleBatchMode: config?.singleBatchMode === true,
        sendTimestampsToAI: config?.advancedSettings?.sendTimestampsToAI === true
    };
    const MAX_OUTPUT_TOKEN_LIMIT = 200000;
    const DEFAULT_MAX_OUTPUT_TOKENS = 65536;

    const targetLangs = clientConfig.targetLanguages.map(lang => {
        const langName = getLanguageName(lang) || lang;
        return { code: lang, name: langName };
    });

    const languageOptions = targetLangs.map(lang =>
        `<option value="${escapeHtml(lang.code)}">${escapeHtml(lang.name)}</option>`
    ).join('');

    // Comprehensive language list for Gemini (no mapping needed)
    const allLanguages = [
        { code: 'af', name: 'Afrikaans' },
        { code: 'sq', name: 'Albanian' },
        { code: 'am', name: 'Amharic' },
        { code: 'ar', name: 'Arabic' },
        { code: 'ar-DZ', name: 'Arabic (Algeria)' },
        { code: 'ar-BH', name: 'Arabic (Bahrain)' },
        { code: 'ar-EG', name: 'Arabic (Egypt)' },
        { code: 'ar-IQ', name: 'Arabic (Iraq)' },
        { code: 'ar-JO', name: 'Arabic (Jordan)' },
        { code: 'ar-KW', name: 'Arabic (Kuwait)' },
        { code: 'ar-LB', name: 'Arabic (Lebanon)' },
        { code: 'ar-LY', name: 'Arabic (Libya)' },
        { code: 'ar-MA', name: 'Arabic (Morocco)' },
        { code: 'ar-OM', name: 'Arabic (Oman)' },
        { code: 'ar-QA', name: 'Arabic (Qatar)' },
        { code: 'ar-SA', name: 'Arabic (Saudi Arabia)' },
        { code: 'ar-SY', name: 'Arabic (Syria)' },
        { code: 'ar-TN', name: 'Arabic (Tunisia)' },
        { code: 'ar-AE', name: 'Arabic (UAE)' },
        { code: 'ar-YE', name: 'Arabic (Yemen)' },
        { code: 'hy', name: 'Armenian' },
        { code: 'az', name: 'Azerbaijani' },
        { code: 'eu', name: 'Basque' },
        { code: 'be', name: 'Belarusian' },
        { code: 'bn', name: 'Bengali' },
        { code: 'bs', name: 'Bosnian' },
        { code: 'bg', name: 'Bulgarian' },
        { code: 'my', name: 'Burmese' },
        { code: 'ca', name: 'Catalan' },
        { code: 'ceb', name: 'Cebuano' },
        { code: 'zh', name: 'Chinese' },
        { code: 'zh-CN', name: 'Chinese (Simplified)' },
        { code: 'zh-TW', name: 'Chinese (Traditional)' },
        { code: 'zh-HK', name: 'Chinese (Hong Kong)' },
        { code: 'zh-SG', name: 'Chinese (Singapore)' },
        { code: 'co', name: 'Corsican' },
        { code: 'hr', name: 'Croatian' },
        { code: 'cs', name: 'Czech' },
        { code: 'da', name: 'Danish' },
        { code: 'nl', name: 'Dutch' },
        { code: 'nl-BE', name: 'Dutch (Belgium)' },
        { code: 'nl-NL', name: 'Dutch (Netherlands)' },
        { code: 'en', name: 'English' },
        { code: 'en-AU', name: 'English (Australia)' },
        { code: 'en-CA', name: 'English (Canada)' },
        { code: 'en-IN', name: 'English (India)' },
        { code: 'en-IE', name: 'English (Ireland)' },
        { code: 'en-NZ', name: 'English (New Zealand)' },
        { code: 'en-PH', name: 'English (Philippines)' },
        { code: 'en-SG', name: 'English (Singapore)' },
        { code: 'en-ZA', name: 'English (South Africa)' },
        { code: 'en-GB', name: 'English (UK)' },
        { code: 'en-US', name: 'English (US)' },
        { code: 'eo', name: 'Esperanto' },
        { code: 'et', name: 'Estonian' },
        { code: 'fi', name: 'Finnish' },
        { code: 'fr', name: 'French' },
        { code: 'fr-BE', name: 'French (Belgium)' },
        { code: 'fr-CA', name: 'French (Canada)' },
        { code: 'fr-FR', name: 'French (France)' },
        { code: 'fr-CH', name: 'French (Switzerland)' },
        { code: 'fy', name: 'Frisian' },
        { code: 'gl', name: 'Galician' },
        { code: 'ka', name: 'Georgian' },
        { code: 'de', name: 'German' },
        { code: 'de-AT', name: 'German (Austria)' },
        { code: 'de-DE', name: 'German (Germany)' },
        { code: 'de-CH', name: 'German (Switzerland)' },
        { code: 'el', name: 'Greek' },
        { code: 'gu', name: 'Gujarati' },
        { code: 'ht', name: 'Haitian Creole' },
        { code: 'ha', name: 'Hausa' },
        { code: 'haw', name: 'Hawaiian' },
        { code: 'he', name: 'Hebrew' },
        { code: 'hi', name: 'Hindi' },
        { code: 'hmn', name: 'Hmong' },
        { code: 'hu', name: 'Hungarian' },
        { code: 'is', name: 'Icelandic' },
        { code: 'ig', name: 'Igbo' },
        { code: 'id', name: 'Indonesian' },
        { code: 'ga', name: 'Irish' },
        { code: 'it', name: 'Italian' },
        { code: 'it-IT', name: 'Italian (Italy)' },
        { code: 'it-CH', name: 'Italian (Switzerland)' },
        { code: 'ja', name: 'Japanese' },
        { code: 'jv', name: 'Javanese' },
        { code: 'kn', name: 'Kannada' },
        { code: 'kk', name: 'Kazakh' },
        { code: 'km', name: 'Khmer' },
        { code: 'rw', name: 'Kinyarwanda' },
        { code: 'ko', name: 'Korean' },
        { code: 'ko-KR', name: 'Korean (South Korea)' },
        { code: 'ko-KP', name: 'Korean (North Korea)' },
        { code: 'ku', name: 'Kurdish' },
        { code: 'ky', name: 'Kyrgyz' },
        { code: 'lo', name: 'Lao' },
        { code: 'la', name: 'Latin' },
        { code: 'lv', name: 'Latvian' },
        { code: 'lt', name: 'Lithuanian' },
        { code: 'lb', name: 'Luxembourgish' },
        { code: 'mk', name: 'Macedonian' },
        { code: 'mg', name: 'Malagasy' },
        { code: 'ms', name: 'Malay' },
        { code: 'ml', name: 'Malayalam' },
        { code: 'mt', name: 'Maltese' },
        { code: 'mi', name: 'Maori' },
        { code: 'mr', name: 'Marathi' },
        { code: 'mn', name: 'Mongolian' },
        { code: 'ne', name: 'Nepali' },
        { code: 'no', name: 'Norwegian' },
        { code: 'nb', name: 'Norwegian (Bokmål)' },
        { code: 'nn', name: 'Norwegian (Nynorsk)' },
        { code: 'ny', name: 'Nyanja (Chichewa)' },
        { code: 'or', name: 'Odia (Oriya)' },
        { code: 'ps', name: 'Pashto' },
        { code: 'fa', name: 'Persian (Farsi)' },
        { code: 'pl', name: 'Polish' },
        { code: 'pt', name: 'Portuguese' },
        { code: 'pt-BR', name: 'Portuguese (Brazil)' },
        { code: 'pt-PT', name: 'Portuguese (Portugal)' },
        { code: 'pa', name: 'Punjabi' },
        { code: 'ro', name: 'Romanian' },
        { code: 'ru', name: 'Russian' },
        { code: 'sm', name: 'Samoan' },
        { code: 'gd', name: 'Scottish Gaelic' },
        { code: 'sr', name: 'Serbian' },
        { code: 'sr-Cyrl', name: 'Serbian (Cyrillic)' },
        { code: 'sr-Latn', name: 'Serbian (Latin)' },
        { code: 'st', name: 'Sesotho' },
        { code: 'sn', name: 'Shona' },
        { code: 'sd', name: 'Sindhi' },
        { code: 'si', name: 'Sinhala' },
        { code: 'sk', name: 'Slovak' },
        { code: 'sl', name: 'Slovenian' },
        { code: 'so', name: 'Somali' },
        { code: 'es', name: 'Spanish' },
        { code: 'es-AR', name: 'Spanish (Argentina)' },
        { code: 'es-BO', name: 'Spanish (Bolivia)' },
        { code: 'es-CL', name: 'Spanish (Chile)' },
        { code: 'es-CO', name: 'Spanish (Colombia)' },
        { code: 'es-CR', name: 'Spanish (Costa Rica)' },
        { code: 'es-CU', name: 'Spanish (Cuba)' },
        { code: 'es-DO', name: 'Spanish (Dominican Republic)' },
        { code: 'es-EC', name: 'Spanish (Ecuador)' },
        { code: 'es-SV', name: 'Spanish (El Salvador)' },
        { code: 'es-GT', name: 'Spanish (Guatemala)' },
        { code: 'es-HN', name: 'Spanish (Honduras)' },
        { code: 'es-MX', name: 'Spanish (Mexico)' },
        { code: 'es-NI', name: 'Spanish (Nicaragua)' },
        { code: 'es-PA', name: 'Spanish (Panama)' },
        { code: 'es-PY', name: 'Spanish (Paraguay)' },
        { code: 'es-PE', name: 'Spanish (Peru)' },
        { code: 'es-PR', name: 'Spanish (Puerto Rico)' },
        { code: 'es-ES', name: 'Spanish (Spain)' },
        { code: 'es-UY', name: 'Spanish (Uruguay)' },
        { code: 'es-VE', name: 'Spanish (Venezuela)' },
        { code: 'su', name: 'Sundanese' },
        { code: 'sw', name: 'Swahili' },
        { code: 'sv', name: 'Swedish' },
        { code: 'sv-FI', name: 'Swedish (Finland)' },
        { code: 'sv-SE', name: 'Swedish (Sweden)' },
        { code: 'tl', name: 'Tagalog (Filipino)' },
        { code: 'tg', name: 'Tajik' },
        { code: 'ta', name: 'Tamil' },
        { code: 'tt', name: 'Tatar' },
        { code: 'te', name: 'Telugu' },
        { code: 'th', name: 'Thai' },
        { code: 'tr', name: 'Turkish' },
        { code: 'tk', name: 'Turkmen' },
        { code: 'uk', name: 'Ukrainian' },
        { code: 'ur', name: 'Urdu' },
        { code: 'ug', name: 'Uyghur' },
        { code: 'uz', name: 'Uzbek' },
        { code: 'vi', name: 'Vietnamese' },
        { code: 'cy', name: 'Welsh' },
        { code: 'xh', name: 'Xhosa' },
        { code: 'yi', name: 'Yiddish' },
        { code: 'yo', name: 'Yoruba' },
        { code: 'zu', name: 'Zulu' }
    ];

    const allLanguageOptions = allLanguages.map(lang =>
        `<option value="${escapeHtml(lang.code)}">${escapeHtml(lang.name)}</option>`
    ).join('');

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>File Translation - SubMaker</title>
    <!-- Favicon -->
    <link rel="icon" type="image/svg+xml" href="/favicon-toolbox.svg">
    <link rel="shortcut icon" href="/favicon-toolbox.svg">
    <link rel="apple-touch-icon" href="/favicon-toolbox.svg">
    <script src="/js/sw-register.js" defer></script>
    <link rel="stylesheet" href="/css/combobox.css">
    <script>
      (function() {
        var html = document.documentElement;
        var theme = 'light';
        try {
          var saved = localStorage.getItem('theme');
          if (saved) {
            theme = saved;
          } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            theme = 'dark';
          }
        } catch (_) {}
        html.setAttribute('data-theme', theme);
      })();
    </script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        html {
            scroll-behavior: smooth;
            color-scheme: light;
        }

        :root {
            --primary: #08A4D5;
            --primary-light: #33B9E1;
            --primary-dark: #068DB7;
            --secondary: #33B9E1;
            --success: #10b981;
            --danger: #ef4444;
            --bg-primary: #f7fafc;
            --surface: #ffffff;
            --surface-light: #f3f7fb;
            --text-primary: #0f172a;
            --text-secondary: #475569;
            --muted: #475569;
            --border: #dbe3ea;
            --shadow: rgba(0, 0, 0, 0.08);
            --glow: rgba(8, 164, 213, 0.25);
            --theme-toggle-size: 48px;
        }

        [data-theme="dark"] {
            color-scheme: dark;
            --primary: #08A4D5;
            --primary-light: #33B9E1;
            --primary-dark: #068DB7;
            --secondary: #33B9E1;
            --success: #10b981;
            --danger: #ef4444;
            --bg-primary: #0A0E27;
            --surface: #141931;
            --surface-light: #1E2539;
            --text-primary: #E8EAED;
            --text-secondary: #9AA0A6;
            --muted: #9AA0A6;
            --border: #2A3247;
            --shadow: rgba(0, 0, 0, 0.3);
            --glow: rgba(8, 164, 213, 0.35);
        }

        /* True Dark mode (Blackhole) color scheme */
        [data-theme="true-dark"] {
            color-scheme: dark;
            --primary: #08A4D5;
            --primary-light: #33B9E1;
            --primary-dark: #068DB7;
            --secondary: #33B9E1;
            --success: #10b981;
            --danger: #ef4444;
            --bg-primary: #000000;
            --surface: #0a0a0a;
            --surface-light: #151515;
            --text-primary: #E8EAED;
            --text-secondary: #8A8A8A;
            --muted: #8A8A8A;
            --border: #1a1a1a;
            --shadow: rgba(0, 0, 0, 0.8);
            --glow: rgba(8, 164, 213, 0.45);
        }

        /* Removed forced color-scheme override - let theme cascade handle it naturally */

        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, var(--bg-primary) 0%, #ffffff 60%, var(--bg-primary) 100%);
            color: var(--text-primary);
            min-height: 100vh;
            overflow-x: hidden;
            position: relative;
            text-align: center;
        }

        body, input, textarea, button, label, p, h1, h2, h3, h4, h5, h6, span, li, a {
            text-align: center;
        }

        [data-theme="dark"] body {
            background: linear-gradient(135deg, var(--bg-primary) 0%, #141931 60%, var(--bg-primary) 100%);
        }

        [data-theme="true-dark"] body {
            background: linear-gradient(135deg, var(--bg-primary) 0%, #0a0a0a 60%, var(--bg-primary) 100%);
        }

        body::before {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background:
                radial-gradient(circle at 20% 50%, rgba(8, 164, 213, 0.12) 0%, transparent 50%),
                radial-gradient(circle at 80% 50%, rgba(51, 185, 225, 0.12) 0%, transparent 50%);
            pointer-events: none;
            z-index: 0;
        }

        [data-theme="dark"] body::before {
            background:
                radial-gradient(circle at 20% 50%, rgba(8, 164, 213, 0.15) 0%, transparent 50%),
                radial-gradient(circle at 80% 50%, rgba(51, 185, 225, 0.15) 0%, transparent 50%);
        }

        [data-theme="true-dark"] body::before {
            background:
                radial-gradient(circle at 20% 50%, rgba(8, 164, 213, 0.08) 0%, transparent 50%),
                radial-gradient(circle at 80% 50%, rgba(51, 185, 225, 0.08) 0%, transparent 50%);
        }

        .episode-toast {
            position: fixed;
            right: 18px;
            bottom: 18px;
            width: min(360px, calc(100% - 32px));
            padding: 14px 16px;
            border-radius: 12px;
            background: var(--surface);
            border: 1px solid var(--border);
            box-shadow: 0 14px 38px var(--glow, rgba(0,0,0,0.18));
            display: flex;
            align-items: flex-start;
            gap: 12px;
            z-index: 12000;
            transform: translateY(16px);
            opacity: 0;
            pointer-events: none;
            transition: all 0.25s ease;
        }
        .episode-toast.show { transform: translateY(0); opacity: 1; pointer-events: auto; }
        .episode-toast .icon {
            width: 32px;
            height: 32px;
            border-radius: 10px;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            display: inline-flex;
            align-items: center;
            justify-content: center;
            color: #fff;
            font-weight: 700;
            box-shadow: 0 10px 24px var(--glow);
            flex-shrink: 0;
        }
        .episode-toast .content { flex: 1; min-width: 0; }
        .episode-toast .title { margin: 0 0 4px; font-weight: 700; color: var(--text-primary, var(--text)); }
        .episode-toast .meta { margin: 0; color: var(--text-secondary); font-size: 0.9rem; word-break: break-word; }
        .episode-toast .close {
            background: none;
            border: none;
            color: var(--text-secondary);
            font-weight: 800;
            cursor: pointer;
            padding: 4px;
            line-height: 1;
            border-radius: 6px;
            transition: color 0.2s ease, background 0.2s ease;
        }
        .episode-toast .close:hover { color: var(--text-primary); background: var(--surface-light); }
        .episode-toast button.action {
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            color: #fff;
            border: none;
            border-radius: 10px;
            padding: 10px 14px;
            font-weight: 700;
            cursor: pointer;
            box-shadow: 0 8px 18px var(--glow);
            transition: transform 0.2s ease, box-shadow 0.2s ease;
            margin-left: 6px;
            flex-shrink: 0;
        }
        .episode-toast button.action:hover { transform: translateY(-1px); box-shadow: 0 12px 24px var(--glow); }

        .container {
            max-width: 800px;
            margin: 0 auto;
            padding: 24px 18px 24px;
            position: relative;
            z-index: 1;
        }

        ${quickNavStyles()}

        .masthead {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 14px;
            flex-wrap: wrap;
            margin-bottom: 14px;
            text-align: center;
        }

        .page-hero {
            width: 100%;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 10px;
            padding: 18px 14px 4px;
        }

        .page-icon {
            width: 70px;
            height: 70px;
            display: grid;
            place-items: center;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            border-radius: 18px;
            box-shadow: 0 18px 42px var(--glow);
            font-size: 32px;
            animation: floaty 3s ease-in-out infinite;
        }

        @keyframes floaty {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-8px); }
        }

        @keyframes fadeInDown {
            from {
                opacity: 0;
                transform: translateY(-20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        @keyframes fadeInUp {
            from {
                opacity: 0;
                transform: translateY(20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        h1 {
            font-size: 2.5rem;
            font-weight: 800;
            background: linear-gradient(135deg, var(--primary-light) 0%, var(--secondary) 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 0.5rem;
            letter-spacing: -0.02em;
        }

        .page-heading {
            margin: 0;
            font-size: 30px;
            letter-spacing: -0.02em;
            font-weight: 700;
            color: var(--text-primary);
            background: none;
            background-clip: border-box;
            -webkit-background-clip: border-box;
            -webkit-text-fill-color: currentColor;
        }

        .badge-row {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            justify-content: center;
            margin-top: 4px;
        }

        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 10px;
            padding: 10px 12px;
            border-radius: 12px;
            background: linear-gradient(135deg, rgba(8,164,213,0.14), rgba(255,255,255,0.08));
            border: 1px solid rgba(8,164,213,0.25);
            box-shadow: 0 12px 30px rgba(8,164,213,0.16);
        }

        .status-labels {
            display: flex;
            flex-direction: column;
            line-height: 1.15;
        }

        .label-eyebrow {
            font-size: 11px;
            letter-spacing: 0.12em;
            text-transform: uppercase;
            color: var(--muted);
            font-weight: 700;
        }

        .status-badge strong {
            font-size: 14px;
        }

        .status-dot {
            width: 12px;
            height: 12px;
            border-radius: 999px;
            box-shadow: 0 0 0 0 rgba(8, 164, 213, 0.0);
        }

        .status-dot.ok {
            background: linear-gradient(135deg, #4ade80, #22c55e);
        }

        .page-subtitle {
            margin: 0;
            color: var(--muted);
            font-weight: 600;
        }

        .card {
            background: var(--surface);
            backdrop-filter: blur(12px);
            border-radius: 20px;
            padding: 2rem;
            margin-bottom: 1.5rem;
            border: 1px solid var(--border);
            box-shadow: 0 8px 24px var(--shadow);
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            animation: fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) backwards;
        }

        .card:hover {
            border-color: var(--primary);
            box-shadow: 0 12px 48px var(--glow);
            transform: translateY(-2px);
        }

        /* Instructions Popup Modal */
        .instructions-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(8px);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 9999;
            padding: 2rem;
            animation: fadeIn 0.3s ease;
        }

        .instructions-overlay.show {
            display: flex;
        }

        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        .instructions-modal {
            background: var(--surface);
            backdrop-filter: blur(20px);
            border-radius: 24px;
            padding: 2.5rem;
            max-width: 600px;
            width: 100%;
            box-shadow: 0 24px 64px var(--shadow);
            position: relative;
            animation: slideInScale 0.4s cubic-bezier(0.16, 1, 0.3, 1);
            border: 2px solid var(--primary);
        }

        @keyframes slideInScale {
            from {
                opacity: 0;
                transform: scale(0.9) translateY(20px);
            }
            to {
                opacity: 1;
                transform: scale(1) translateY(0);
            }
        }

        .instructions-modal-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 1.5rem;
            padding-bottom: 1rem;
            border-bottom: 2px solid var(--border);
        }

        .instructions-modal-title {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            font-size: 1.75rem;
            font-weight: 700;
            color: var(--primary);
        }

        .instructions-modal-close {
            background: transparent;
            border: none;
            font-size: 2rem;
            color: var(--text-secondary);
            cursor: pointer;
            transition: all 0.2s ease;
            width: 40px;
            height: 40px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 8px;
        }

        .instructions-modal-close:hover {
            background: rgba(239, 68, 68, 0.1);
            color: var(--danger);
            transform: rotate(90deg);
        }

        .instructions-modal-content {
            color: var(--text-secondary);
            line-height: 1.8;
        }

        .instructions-modal-content strong {
            color: var(--text-primary);
            font-weight: 600;
        }

        .instructions-modal-content ol {
            margin: 1rem 0 0;
            padding: 0;
            list-style-position: inside;
        }

        .instructions-modal-content li {
            margin: 0.75rem 0;
            padding-left: 0;
            text-align: center;
        }

        .instructions-modal-footer {
            padding-top: 1.5rem;
            margin-top: 1.5rem;
            border-top: 2px solid var(--border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 1rem;
        }

        .instructions-modal-checkbox {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            cursor: pointer;
            user-select: none;
            color: var(--text-secondary);
            font-size: 0.9rem;
        }

        .instructions-modal-checkbox input[type="checkbox"] {
            cursor: pointer;
            width: 18px;
            height: 18px;
        }

        .instructions-modal-btn {
            padding: 0.75rem 1.5rem;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            color: white;
            border: none;
            border-radius: 10px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            box-shadow: 0 4px 12px var(--glow);
        }

        .instructions-modal-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 20px var(--glow);
        }

        /* Reset confirmation modal (mirrors configure page UX) */
        .modal-overlay {
            position: fixed;
            inset: 0;
            background: rgba(255, 255, 255, 0.88);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 11000;
            animation: fadeIn 0.3s ease;
        }

        .modal-overlay.show {
            display: flex;
        }

        [data-theme="dark"] .modal-overlay {
            background: rgba(10, 14, 39, 0.8);
        }

        [data-theme="true-dark"] .modal-overlay {
            background: rgba(0, 0, 0, 0.85);
        }

        .modal {
            background:
                linear-gradient(180deg, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.85) 100%),
                var(--surface);
            border-radius: 18px;
            max-width: 640px;
            width: 92%;
            border: 1px solid var(--border);
            box-shadow: 0 24px 72px var(--shadow), 0 0 0 1px rgba(8, 164, 213, 0.12);
            overflow: hidden;
            animation: slideInScale 0.32s cubic-bezier(0.16, 1, 0.3, 1);
            position: relative;
            display: flex;
            flex-direction: column;
        }

        .modal-header {
            padding: 1.25rem 1.5rem;
            border-bottom: 1px solid var(--border);
            background: linear-gradient(135deg, rgba(8, 164, 213, 0.08) 0%, rgba(51, 185, 225, 0.08) 100%);
            position: sticky;
            top: 0;
            z-index: 1;
        }

        .modal-header h2 {
            margin: 0;
            font-size: 1.4rem;
            font-weight: 700;
            background: linear-gradient(135deg, var(--primary-light) 0%, var(--secondary) 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
        }

        .modal-close {
            position: absolute;
            top: 1.25rem;
            right: 1.25rem;
            width: 34px;
            height: 34px;
            background: var(--surface-light);
            border: 1px solid var(--border);
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: all 0.2s ease;
            font-size: 1.1rem;
            color: var(--text-secondary);
        }

        .modal-close:hover {
            background: rgba(239, 68, 68, 0.1);
            border-color: var(--danger);
            color: var(--danger);
            transform: rotate(90deg);
        }

        .modal-content {
            padding: 1.5rem;
            color: var(--text-secondary);
            line-height: 1.6;
            text-align: left;
        }

        .modal-content p {
            margin: 0.75rem 0;
        }

        .modal-content strong {
            color: var(--text-primary);
            font-weight: 700;
        }

        .modal-footer {
            padding: 1rem 1.5rem;
            border-top: 1px solid var(--border);
            display: flex;
            gap: 0.75rem;
            justify-content: flex-end;
            background: var(--surface);
        }

        .btn-danger {
            background: rgba(239, 68, 68, 0.12);
            color: var(--danger);
            border: 2px solid var(--danger);
        }

        .btn-danger:hover:not(:disabled) {
            background: rgba(239, 68, 68, 0.18);
            box-shadow: 0 10px 28px rgba(239, 68, 68, 0.25);
        }

        body.modal-open {
            overflow: hidden;
        }

        .help-button {
            position: fixed;
            bottom: 2rem;
            right: 2rem;
            width: 60px;
            height: 60px;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            color: white;
            border: none;
            border-radius: 50%;
            font-size: 1.75rem;
            cursor: pointer;
            box-shadow: 0 8px 24px var(--glow);
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            z-index: 1000;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .help-button:hover { transform: translateY(-2px) scale(1.07) rotate(6deg); box-shadow: 0 12px 32px var(--glow); }

        /* Mario-styled help button: same vibe, slightly different (coin-ish, glint) */
        .help-button.mario {
            border: 2px solid #8a5a00;
            background: linear-gradient(180deg, #f7d13e 0%, #e6b526 60%, #d49c1d 100%);
            color: #3b2a00;
            border-radius: 14px; /* more rounded than toggle */
            box-shadow:
                inset 0 2px 0 #fff3b0,
                inset 0 -3px 0 #b47a11,
                0 6px 0 #7a4d00,
                0 10px 16px rgba(0,0,0,0.35);
            text-shadow: 0 1px 0 rgba(255,255,255,0.6), 0 -1px 0 rgba(0,0,0,0.1);
            position: fixed;
            overflow: hidden;
        }
        .help-button.mario::before { /* rivets, only top corners to differ from toggle */
            content: '';
            position: absolute;
            width: 5px; height: 5px; border-radius: 50%; background: #b47a11; opacity: .9; top: 6px; left: 6px;
            box-shadow: calc(100% - 12px) 0 0 #b47a11;
        }
        /* keep it very similar to toggle; remove glint for minimal difference */
        .help-button.mario::after { display: none; }

        /* Theme variants */
        [data-theme="dark"] .help-button.mario {
            border-color: #1b2a78;
            background: linear-gradient(180deg, #4c6fff 0%, #2f4ed1 60%, #1e2f8a 100%);
            color: #0f1a4a;
            box-shadow:
                inset 0 2px 0 #b3c4ff,
                inset 0 -3px 0 #213a9a,
                0 6px 0 #16246a,
                0 10px 16px rgba(20,25,49,0.6);
        }
        [data-theme="dark"] .help-button.mario::before { background: #213a9a; box-shadow: calc(100% - 12px) 0 0 #213a9a; }
        [data-theme="dark"] .help-button.mario::after { background: linear-gradient(120deg, rgba(179,196,255,0.22) 0%, rgba(179,196,255,0) 35%); }

        [data-theme="light"] .help-button.mario { /* keep gold but slightly different radius from toggle */ border-radius: 14px; }

        [data-theme="true-dark"] .help-button.mario {
            border-color: #3b2a5d;
            background: linear-gradient(180deg, #1b1029 0%, #110b1a 60%, #0b0711 100%);
            color: #bdb4ff;
            box-shadow:
                inset 0 2px 0 #6b65ff33,
                inset 0 -3px 0 #2b2044,
                0 6px 0 #2a1e43,
                0 0 18px rgba(107,101,255,0.35);
        }
        [data-theme="true-dark"] .help-button.mario::before { background: #2b2044; box-shadow: calc(100% - 12px) 0 0 #2b2044; }
        [data-theme="true-dark"] .help-button.mario::after { background: linear-gradient(120deg, rgba(107,101,255,0.25) 0%, rgba(107,101,255,0) 35%); }

        .form-group {
            margin-bottom: 1.5rem;
        }

        label {
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 600;
            font-size: 0.95rem;
            color: var(--text-primary);
        }

        .label-description {
            display: block;
            font-size: 0.875rem;
            color: var(--text-secondary);
            font-weight: 400;
            margin-top: 0.25rem;
        }

        .file-input-wrapper {
            position: relative;
            display: block;
        }

        .file-input-wrapper input[type=file] {
            display: none;
        }

        .file-input-label {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 2.5rem 2rem;
            background: var(--surface);
            color: var(--primary);
            border: 2px dashed var(--border);
            border-radius: 12px;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            text-align: center;
            gap: 0.5rem;
        }

        .file-input-label:hover {
            background: var(--surface-light);
            border-color: var(--primary);
            transform: translateY(-2px);
        }

        .file-input-label .icon {
            font-size: 3rem;
            margin-bottom: 0.5rem;
        }

        .file-input-label .main-text {
            font-weight: 600;
            font-size: 1.05rem;
        }

        .file-input-label .sub-text {
            font-size: 0.875rem;
            color: var(--text-secondary);
        }

        .file-name {
            margin-top: 0.75rem;
            padding: 0.75rem 1rem;
            background: rgba(8, 164, 213, 0.08);
            border-radius: 8px;
            font-size: 0.95rem;
            color: var(--text-primary);
            font-weight: 500;
            display: none;
        }

        .file-name.active {
            display: block;
        }

        .file-hint {
            margin-top: 0.35rem;
            font-size: 0.9rem;
            color: var(--text-secondary);
        }

        select {
            width: 100%;
            padding: 0.625rem 0.85rem;
            background: var(--surface);
            border: 2px solid var(--border);
            border-radius: 12px;
            color: var(--text-primary);
            font-size: 0.95rem;
            cursor: default;
            transition: border-color 0.2s ease, box-shadow 0.2s ease;
            font-family: inherit;
            text-align: center;
            text-align-last: center;
        }

        select:hover {
            border-color: var(--primary);
        }

        select:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 4px var(--glow);
        }

        .language-toggle {
            display: flex;
            align-items: center;
            gap: 0.625rem;
            margin-top: 0;
            padding: 0;
            cursor: pointer;
            user-select: none;
            color: var(--text-secondary);
            font-size: 0.9rem;
            transition: color 0.2s ease;
        }

        .language-toggle:hover {
            color: var(--primary);
        }

        .language-toggle input[type="checkbox"] {
            width: 18px;
            height: 18px;
            cursor: pointer;
            accent-color: var(--primary);
        }

        .language-toggle-container {
            display: flex;
            justify-content: center;
            margin: 0;
        }

        /* Translation Options Section */
        .translation-options {
            margin: 1.5rem 0;
            padding: 0;
            background: var(--surface-light);
            border: 2px solid var(--border);
            border-radius: 16px;
            overflow: visible;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .translation-options-header {
            padding: 1.25rem 1.5rem;
            cursor: pointer;
            user-select: none;
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: linear-gradient(135deg, rgba(8, 164, 213, 0.05) 0%, rgba(51, 185, 225, 0.05) 100%);
            transition: background 0.2s ease;
        }

        .translation-options-header:hover {
            background: linear-gradient(135deg, rgba(8, 164, 213, 0.1) 0%, rgba(51, 185, 225, 0.1) 100%);
        }

        .translation-options-title {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            font-size: 1.05rem;
            font-weight: 600;
            color: var(--text-primary);
        }

        .translation-options-icon {
            font-size: 1.25rem;
        }

        .translation-options-toggle {
            font-size: 1.5rem;
            color: var(--text-secondary);
            transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .translation-options.expanded .translation-options-toggle {
            transform: rotate(180deg);
        }

        .translation-options-content {
            max-height: 0;
            overflow: hidden;
            transition: max-height 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .translation-options.expanded .translation-options-content {
            max-height: 2000px;
        }

        .translation-options-inner {
            padding: 1.5rem;
            border-top: 2px solid var(--border);
        }

        .btn {
            width: 100%;
            padding: 1rem 1.5rem;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            color: white;
            border: none;
            border-radius: 12px;
            font-size: 1.05rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            box-shadow: 0 4px 12px var(--glow);
        }

        .btn:hover:not(:disabled) {
            transform: translateY(-2px);
            box-shadow: 0 8px 24px var(--glow);
        }

        .btn:active:not(:disabled) {
            transform: translateY(0);
        }

        .btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }

        /* Reset bar (matches configure page styling) */
        .reset-bar {
            margin: 0;
            padding: 1rem 1.25rem;
            border: 2px dashed var(--border);
            border-radius: 14px;
            background: var(--surface);
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 1rem;
            width: 100%;
            max-width: 450px;
            margin-left: auto;
            margin-right: auto;
        }
        .reset-bar .reset-text {
            color: var(--text-secondary);
            font-weight: 600;
        }
        .reset-btn {
            appearance: none;
            border: 2px solid var(--danger);
            background: transparent;
            color: var(--danger);
            padding: 0.625rem 1rem;
            border-radius: 10px;
            font-weight: 700;
            cursor: pointer;
            transition: transform 0.15s ease, box-shadow 0.2s ease, background 0.2s ease;
        }
        .reset-btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 10px 28px var(--shadow);
            background: rgba(239, 68, 68, 0.08);
        }
        .reset-btn:active { transform: translateY(0); }

        .progress {
            display: none;
            text-align: center;
            padding: 2rem;
        }

        .progress.active {
            display: block;
        }

        .spinner {
            border: 4px solid var(--surface-light);
            border-top: 4px solid var(--primary);
            border-radius: 50%;
            width: 50px;
            height: 50px;
            animation: spin 0.8s linear infinite;
            margin: 0 auto 1.5rem;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .progress-text {
            color: var(--text-primary);
            font-weight: 600;
            font-size: 1.05rem;
            margin-bottom: 0.5rem;
        }

        .progress-subtext {
            color: var(--text-secondary);
            font-size: 0.95rem;
        }

        .queue-panel {
            margin-top: 1.25rem;
            padding: 1rem 1.1rem;
            border: 1px solid var(--border);
            border-radius: 14px;
            background: var(--surface);
            box-shadow: 0 12px 32px var(--shadow);
        }

        .queue-header {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 1rem;
            flex-wrap: wrap;
        }

        .queue-title {
            font-weight: 700;
            font-size: 1.05rem;
            color: var(--text-primary);
        }

        .queue-subtitle,
        .queue-summary {
            color: var(--text-secondary);
            font-size: 0.9rem;
        }

        .queue-list {
            list-style: none;
            margin: 0.85rem 0 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            gap: 0.65rem;
        }

        .queue-item {
            display: flex;
            align-items: center;
            gap: 0.85rem;
            justify-content: space-between;
            padding: 0.85rem 0.95rem;
            border: 1px solid var(--border);
            border-radius: 12px;
            background: var(--surface-light);
            box-shadow: 0 4px 12px var(--shadow);
        }

        .queue-item.processing {
            border-color: var(--primary-light);
            box-shadow: 0 8px 24px var(--glow);
        }

        .queue-item-info {
            flex: 1;
            min-width: 0;
        }

        .queue-name {
            font-weight: 700;
            color: var(--text-primary);
            margin-bottom: 0.15rem;
            word-break: break-word;
        }

        .queue-meta {
            color: var(--text-secondary);
            font-size: 0.9rem;
        }

        .queue-actions {
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .queue-status {
            font-weight: 700;
            font-size: 0.9rem;
            white-space: nowrap;
        }

        .status-processing { color: var(--primary); }
        .status-pending { color: var(--text-secondary); }
        .status-completed { color: var(--success); }
        .status-failed { color: var(--danger); }

        .queue-download {
            font-size: 0.9rem;
            text-decoration: none;
            color: var(--primary);
            font-weight: 700;
            display: inline-flex;
            align-items: center;
            gap: 0.3rem;
        }

        .result {
            display: none;
            text-align: center;
        }

        .result.active {
            display: block;
        }

        .result-icon {
            width: 80px;
            height: 80px;
            margin: 0 auto 1.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, var(--success) 0%, #059669 100%);
            border-radius: 20px;
            font-size: 2.5rem;
            animation: scaleIn 0.5s cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes scaleIn {
            from {
                transform: scale(0);
                opacity: 0;
            }
            to {
                transform: scale(1);
                opacity: 1;
            }
        }

        .result h2 {
            color: var(--text-primary);
            font-size: 1.75rem;
            margin-bottom: 0.5rem;
        }

        .result p {
            color: var(--text-secondary);
            margin-bottom: 1.5rem;
        }

        .download-btn {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            padding: 1rem 2rem;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            color: white;
            text-decoration: none;
            border-radius: 12px;
            font-weight: 600;
            font-size: 1.05rem;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            box-shadow: 0 4px 12px var(--glow);
        }

        .download-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 24px var(--glow);
        }

        .error {
            display: none;
            background: rgba(239, 68, 68, 0.1);
            border: 2px solid var(--danger);
            border-radius: 12px;
            padding: 1.25rem;
            margin-top: 1rem;
            color: var(--danger);
            font-weight: 500;
        }

        .error.active {
            display: block;
            animation: fadeInUp 0.3s ease;
        }

        /* Advanced Settings Section */
        .advanced-settings {
            margin-top: 1.5rem;
            padding: 0;
            background: var(--surface-light);
            border: 2px solid var(--border);
            border-radius: 16px;
            overflow: hidden;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .advanced-settings-header {
            padding: 1.25rem 1.5rem;
            cursor: pointer;
            user-select: none;
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: linear-gradient(135deg, rgba(8, 164, 213, 0.05) 0%, rgba(51, 185, 225, 0.05) 100%);
            transition: background 0.2s ease;
        }

        .advanced-settings-header:hover {
            background: linear-gradient(135deg, rgba(8, 164, 213, 0.1) 0%, rgba(51, 185, 225, 0.1) 100%);
        }

        .advanced-settings-title {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            font-size: 1.05rem;
            font-weight: 600;
            color: var(--text-primary);
        }

        .advanced-settings-icon {
            font-size: 1.25rem;
        }

        .advanced-settings-toggle {
            font-size: 1.5rem;
            color: var(--text-secondary);
            transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .advanced-settings.expanded .advanced-settings-toggle {
            transform: rotate(180deg);
        }

        .advanced-settings-content {
            max-height: 0;
            overflow: hidden;
            transition: max-height 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .advanced-settings.expanded .advanced-settings-content {
            max-height: 2000px;
        }

        .advanced-settings-inner {
            padding: 1.5rem;
            border-top: 2px solid var(--border);
        }

        .highlight-box {
            background: rgba(255, 165, 0, 0.1);
            border: 2px solid rgba(255, 165, 0, 0.3);
            border-radius: 12px;
            padding: 1rem;
            margin-bottom: 1.5rem;
        }

        .highlight-box p {
            margin: 0;
            font-size: 0.9rem;
            color: var(--text-primary);
        }

        .highlight-box strong {
            color: var(--text-primary);
            font-weight: 600;
        }

        .highlight-box em {
            color: var(--warning);
            font-style: normal;
            font-weight: 600;
        }

        textarea {
            width: 100%;
            min-height: 120px;
            padding: 0.875rem 1rem;
            background: var(--surface);
            border: 2px solid var(--border);
            border-radius: 12px;
            color: var(--text-primary);
            font-size: 0.9rem;
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            resize: vertical;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        textarea:hover {
            border-color: var(--primary);
        }

        textarea:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 4px var(--glow);
        }

        input[type="number"] {
            width: 100%;
            padding: 0.875rem 1rem;
            background: var(--surface);
            border: 2px solid var(--border);
            border-radius: 12px;
            color: var(--text-primary);
            font-size: 1rem;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        input[type="number"]:hover {
            border-color: var(--primary);
        }

        input[type="number"]:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 4px var(--glow);
        }

        .btn-secondary {
            background: var(--surface-light);
            color: var(--text-primary);
            border: 2px solid var(--border);
            box-shadow: none;
        }

        .btn-secondary:hover:not(:disabled) {
            background: var(--surface);
            border-color: var(--primary);
        }

        .model-status {
            margin-top: 0.5rem;
            font-size: 0.875rem;
            padding: 0.5rem;
            border-radius: 8px;
        }

        .model-status.fetching {
            color: var(--primary);
            background: rgba(8, 164, 213, 0.1);
        }

        .model-status.success {
            color: #10b981;
            background: rgba(16, 185, 129, 0.1);
        }

        .model-status.error {
            color: var(--danger);
            background: rgba(239, 68, 68, 0.1);
        }

        .spinner-small {
            display: inline-block;
            width: 12px;
            height: 12px;
            border: 2px solid rgba(8, 164, 213, 0.2);
            border-top-color: var(--primary);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }

        /* Dark mode overrides */
        [data-theme="dark"] .card {
            background: rgba(20, 25, 49, 0.85);
        }

        [data-theme="dark"] .instructions-modal {
            background: rgba(20, 25, 49, 0.95);
        }

        [data-theme="dark"] .instructions-overlay {
            background: rgba(0, 0, 0, 0.7);
        }

        [data-theme="dark"] input[type="file"],
        [data-theme="dark"] select,
        [data-theme="dark"] textarea,
        [data-theme="dark"] input[type="number"] {
            background: var(--surface-light);
            color: var(--text-primary);
        }

        [data-theme="true-dark"] input[type="file"],
        [data-theme="true-dark"] select,
        [data-theme="true-dark"] textarea,
        [data-theme="true-dark"] input[type="number"] {
            background: var(--surface-light);
            color: var(--text-primary);
        }

        [data-theme="dark"] .file-input-label {
            background: var(--surface-light);
        }

        [data-theme="true-dark"] .file-input-label {
            background: var(--surface-light);
        }

        [data-theme="dark"] .btn-secondary {
            background: var(--surface);
        }

        [data-theme="true-dark"] .btn-secondary {
            background: var(--surface);
        }

        /* Theme Toggle Button */
        .theme-toggle {
            position: fixed;
            top: 2rem;
            right: 2rem;
            width: var(--theme-toggle-size, 48px);
            height: var(--theme-toggle-size, 48px);
            background: rgba(255, 255, 255, 0.9);
            border: 2px solid var(--border);
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            z-index: 12050;
            box-shadow: 0 4px 12px var(--shadow);
            user-select: none;
            -webkit-user-select: none;
            -webkit-tap-highlight-color: transparent;
            overflow: hidden;
        }

        [data-theme="dark"] .theme-toggle {
            background: rgba(20, 25, 49, 0.9);
            border-color: var(--border);
        }

        .theme-toggle:focus,
        .theme-toggle:focus-visible {
            outline: none;
            box-shadow: 0 0 0 3px rgba(8, 164, 213, 0.35), 0 8px 20px var(--shadow);
        }

        .theme-toggle:hover {
            transform: translateY(-2px) scale(1.05);
            box-shadow: 0 8px 20px var(--shadow);
            border-color: var(--primary);
        }

        .theme-toggle:active {
            transform: translateY(0) scale(0.98);
        }

        .theme-toggle-icon {
            font-size: 1.5rem;
            transition: all 0.3s ease;
            user-select: none;
            -webkit-user-drag: none;
            pointer-events: none;
        }

        .theme-toggle-icon svg {
            display: block;
            filter: drop-shadow(0 2px 0 rgba(0,0,0,0.2));
            pointer-events: none;
            user-select: none;
            -webkit-user-drag: none;
        }

        .theme-toggle-icon.sun { display: block; }
        .theme-toggle-icon.moon { display: none; }
        .theme-toggle-icon.blackhole { display: none; }
        [data-theme="dark"] .theme-toggle-icon.sun { display: none; }
        [data-theme="dark"] .theme-toggle-icon.moon { display: block; }
        [data-theme="true-dark"] .theme-toggle-icon.sun { display: none; }
        [data-theme="true-dark"] .theme-toggle-icon.moon { display: none; }
        [data-theme="true-dark"] .theme-toggle-icon.blackhole { display: block; }

        .theme-toggle.mario {
            background: linear-gradient(180deg, #f7d13e 0%, #e6b526 60%, #d49c1d 100%);
            border-color: #8a5a00;
            box-shadow:
                inset 0 2px 0 #fff3b0,
                inset 0 -3px 0 #b47a11,
                0 6px 0 #7a4d00,
                0 10px 16px rgba(0,0,0,0.35);
        }
        .theme-toggle.mario::before {
            content: '';
            position: absolute;
            width: 5px; height: 5px; border-radius: 50%;
            background: #b47a11;
            top: 6px; left: 6px;
            box-shadow:
                calc(100% - 12px) 0 0 #b47a11,
                0 calc(100% - 12px) 0 #b47a11,
                calc(100% - 12px) calc(100% - 12px) 0 #b47a11;
            opacity: .9;
        }
        .theme-toggle.mario:active { transform: translateY(2px) scale(0.98); box-shadow:
            inset 0 1px 0 #fff3b0,
            inset 0 -1px 0 #b47a11,
            0 4px 0 #7a4d00,
            0 8px 14px rgba(0,0,0,0.3);
        }
        .coin { position: fixed; left: 0; top: 0; width: 22px; height: 22px; pointer-events: none; z-index: 10000; transform: translate(-50%, -50%); will-change: transform, opacity; contain: layout paint style; }
        .coin::before { content: ''; display: block; width: 100%; height: 100%; border-radius: 50%;
            background:
                linear-gradient(90deg, rgba(0,0,0,0) 45%, rgba(0,0,0,0.2) 55%) ,
                radial-gradient(40% 40% at 35% 30%, #fff6bf 0%, rgba(255,255,255,0) 70%),
                linear-gradient(180deg, #ffd24a 0%, #ffc125 50%, #e2a415 100%);
            border: 2px solid #8a5a00; box-shadow: 0 2px 0 #7a4d00, inset 0 1px 0 #fff8c6;
        }
        @keyframes coin-pop {
            0% { opacity: 0; transform: translate(-50%, -50%) translateY(0) scale(0.9) rotateY(0deg); }
            10% { opacity: 1; }
            60% { transform: translate(-50%, -50%) translateY(-52px) scale(1.0) rotateY(360deg); }
            100% { opacity: 0; transform: translate(-50%, -50%) translateY(-70px) scale(0.95) rotateY(540deg); }
        }
        .coin.animate { animation: coin-pop 0.7s cubic-bezier(.2,.8,.2,1) forwards; }
        @media (prefers-reduced-motion: reduce) { .coin.animate { animation: none; opacity: 0; } }

        [data-theme="light"] .theme-toggle.mario {
            background: linear-gradient(180deg, #f7d13e 0%, #e6b526 60%, #d49c1d 100%);
            border-color: #8a5a00;
            box-shadow:
                inset 0 2px 0 #fff3b0,
                inset 0 -3px 0 #b47a11,
                0 6px 0 #7a4d00,
                0 10px 16px rgba(0,0,0,0.35);
        }
        [data-theme="light"] .theme-toggle.mario::before {
            background: #b47a11;
            box-shadow:
                calc(100% - 12px) 0 0 #b47a11,
                0 calc(100% - 12px) 0 #b47a11,
                calc(100% - 12px) calc(100% - 12px) 0 #b47a11;
        }

        [data-theme="dark"] .theme-toggle.mario {
            background: linear-gradient(180deg, #4c6fff 0%, #2f4ed1 60%, #1e2f8a 100%);
            border-color: #1b2a78;
            box-shadow:
                inset 0 2px 0 #b3c4ff,
                inset 0 -3px 0 #213a9a,
                0 6px 0 #16246a,
                0 10px 16px rgba(20,25,49,0.6);
        }
        [data-theme="dark"] .theme-toggle.mario::before {
            background: #213a9a;
            box-shadow:
                calc(100% - 12px) 0 0 #213a9a,
                0 calc(100% - 12px) 0 #213a9a,
                calc(100% - 12px) calc(100% - 12px) 0 #213a9a;
        }

        [data-theme="true-dark"] .theme-toggle.mario {
            background: linear-gradient(180deg, #1b1029 0%, #110b1a 60%, #0b0711 100%);
            border-color: #3b2a5d;
            box-shadow:
                inset 0 2px 0 #6b65ff33,
                inset 0 -3px 0 #2b2044,
                0 6px 0 #2a1e43,
                0 0 18px rgba(107,101,255,0.35);
        }
        [data-theme="true-dark"] .theme-toggle.mario::before {
            background: #2b2044;
            box-shadow:
                calc(100% - 12px) 0 0 #2b2044,
                0 calc(100% - 12px) 0 #2b2044,
                calc(100% - 12px) calc(100% - 12px) 0 #2b2044;
        }

        .mobile-menu-toggle {
            position: fixed;
            top: 1.25rem;
            left: 1rem;
            width: 44px;
            height: 44px;
            border-radius: 10px;
            border: 2px solid var(--border);
            background: var(--surface);
            display: none;
            align-items: center;
            justify-content: center;
            gap: 4px;
            cursor: pointer;
            z-index: 10001;
            box-shadow: 0 3px 10px var(--shadow);
            transition: all 0.3s ease;
        }

        .mobile-menu-toggle span {
            display: block;
            width: 8px;
            height: 8px;
            background: var(--text-primary);
            border-radius: 999px;
            box-shadow: 0 1px 4px rgba(0,0,0,0.15);
        }

        .mobile-menu-toggle:hover {
            transform: translateY(-2px);
            border-color: var(--primary);
            box-shadow: 0 8px 18px var(--shadow);
        }

        .mobile-nav-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.45);
            backdrop-filter: blur(4px);
            z-index: 10000;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.25s ease;
        }

        .mobile-nav-overlay.show {
            opacity: 1;
            pointer-events: auto;
        }

        @media (max-width: 1100px) {
            .mobile-menu-toggle { display: inline-flex !important; }
        }

        html.no-scroll, body.no-scroll {
            overflow: hidden;
        }

        @media (max-width: 768px) {
            .mobile-menu-toggle { display: inline-flex; }

            .quick-nav {
                position: fixed;
                top: 0;
                left: 0;
                height: 100vh;
                width: 80vw;
                max-width: 300px;
                margin: 0;
                border-radius: 0 14px 14px 0;
                box-shadow: 0 24px 64px rgba(0,0,0,0.38);
                transform: translateX(-110%);
                transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                flex-direction: column;
                align-items: flex-start;
                justify-content: flex-start;
                gap: 1.25rem;
                padding: 1.5rem 1.25rem 2rem;
                overflow-y: auto;
            }

            .quick-nav.open {
                transform: translateX(0);
            }

            .quick-nav-links {
                width: 100%;
                flex-direction: column;
                align-items: stretch;
                gap: 0.5rem;
            }

            .quick-nav-link {
                width: 100%;
                justify-content: flex-start;
            }

            .quick-nav-hero {
                width: 100%;
            }

            :root { --theme-toggle-size: 42px; }
            .theme-toggle {
                top: 1rem;
                right: 1rem;
            }

            .theme-toggle-icon {
                font-size: 1.25rem;
            }
        }
    </style>
</head>
<body>
    <!-- Theme Toggle Button -->
    <button class="theme-toggle mario" id="themeToggle" aria-label="Toggle theme">
        <span class="theme-toggle-icon sun" aria-hidden="true">
            <svg viewBox="0 0 64 64" width="28" height="28" role="img">
                <defs>
                    <radialGradient id="gSun" cx="50%" cy="50%" r="60%">
                        <stop offset="0%" stop-color="#fff4b0"/>
                        <stop offset="60%" stop-color="#f7d13e"/>
                        <stop offset="100%" stop-color="#e0a81e"/>
                    </radialGradient>
                </defs>
                <g fill="none" stroke="#8a5a00" stroke-linecap="round">
                    <circle cx="32" cy="32" r="13" fill="url(#gSun)" stroke-width="3"/>
                    <g stroke-width="3">
                        <line x1="32" y1="6" x2="32" y2="14"/>
                        <line x1="32" y1="50" x2="32" y2="58"/>
                        <line x1="6" y1="32" x2="14" y2="32"/>
                        <line x1="50" y1="32" x2="58" y2="32"/>
                        <line x1="13" y1="13" x2="19" y2="19"/>
                        <line x1="45" y1="45" x2="51" y2="51"/>
                        <line x1="13" y1="51" x2="19" y2="45"/>
                        <line x1="45" y1="19" x2="51" y2="13"/>
                    </g>
                </g>
            </svg>
        </span>
        <span class="theme-toggle-icon moon" aria-hidden="true">
            <svg viewBox="0 0 64 64" width="28" height="28" role="img">
                <defs>
                    <radialGradient id="gMoon" cx="40%" cy="35%" r="65%">
                        <stop offset="0%" stop-color="#fff7cc"/>
                        <stop offset="70%" stop-color="#f1c93b"/>
                        <stop offset="100%" stop-color="#d19b16"/>
                    </radialGradient>
                    <mask id="mMoon">
                        <rect width="100%" height="100%" fill="#ffffff"/>
                        <circle cx="44" cy="22" r="18" fill="#000000"/>
                    </mask>
                </defs>
                <g fill="none" stroke="#8a5a00">
                    <circle cx="32" cy="32" r="22" fill="url(#gMoon)" stroke-width="3" mask="url(#mMoon)"/>
                </g>
            </svg>
        </span>
        <span class="theme-toggle-icon blackhole" aria-hidden="true">
            <svg viewBox="0 0 64 64" width="28" height="28" role="img">
                <defs>
                    <radialGradient id="gRing" cx="50%" cy="50%" r="50%">
                        <stop offset="0%" stop-color="#6b65ff"/>
                        <stop offset="60%" stop-color="#4b2ed6"/>
                        <stop offset="100%" stop-color="#1a103a"/>
                    </radialGradient>
                </defs>
                <circle cx="32" cy="32" r="12" fill="#000"/>
                <circle cx="32" cy="32" r="20" fill="none" stroke="url(#gRing)" stroke-width="6"/>
            </svg>
        </span>
    </button>

    <div id="episodeToast" class="episode-toast" role="status" aria-live="polite">
        <div class="icon">!</div>
        <div class="content">
            <p class="title" id="episodeToastTitle">New stream detected</p>
            <p class="meta" id="episodeToastMeta">A different episode is playing in Stremio.</p>
        </div>
        <button class="close" id="episodeToastDismiss" type="button" aria-label="Dismiss notification">×</button>
        <button class="action" id="episodeToastUpdate" type="button">Update</button>
    </div>

    ${renderQuickNav(navLinks, 'translateFiles', false, devMode)}

    <div class="container">
        <header class="masthead">
            <div class="page-hero">
                <div class="page-icon">📄</div>
                <h1 class="page-heading">File Translation</h1>
                <p class="page-subtitle">Upload and translate your subtitle files</p>
            </div>
            <div class="badge-row">
                ${renderRefreshBadge()}
                <div class="status-badge">
                    <span class="status-dot ok"></span>
                    <div class="status-labels">
                        <span class="label-eyebrow">Addon</span>
                        <strong>v${escapeHtml(appVersion || 'n/a')}</strong>
                    </div>
                </div>
            </div>
        </header>

        <!-- Instructions Modal -->
        <div class="instructions-overlay" id="instructionsOverlay">
            <div class="instructions-modal">
                <div class="instructions-modal-header">
                    <div class="instructions-modal-title">
                        <span>📝</span>
                        <span>How It Works</span>
                    </div>
                    <button class="instructions-modal-close" id="closeInstructions">×</button>
                </div>
                <div class="instructions-modal-content">
                    <p><strong>✨ Supported formats:</strong> SRT, VTT, ASS, SSA</p>
                    <br>
                    <p><strong>📋 Steps:</strong></p>
                    <ol>
                        <li>Upload your subtitle file(s) (any supported format, up to ${maxBatchFiles} at once)</li>
                        <li>Select your target language</li>
                        <li>Click "Translate" and wait for the magic ✨</li>
                        <li>Download your translated subtitle</li>
                        <li>Drag it to Stremio 🎬</li>
                    </ol>
                    <div class="instructions-modal-footer">
                        <label class="instructions-modal-checkbox">
                            <input type="checkbox" id="dontShowInstructions">
                            Don't show this again
                        </label>
                        <button class="instructions-modal-btn" id="gotItBtn">Got it!</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- Floating Help Button -->
        <button class="help-button mario" id="showInstructions" title="Show Instructions">?</button>

        <div class="card">
            <form id="translationForm">
                <div class="form-group file-drop-group">
                    <div class="file-input-wrapper">
                        <input type="file" id="fileInput" accept=".srt,.vtt,.ass,.ssa" multiple required aria-label="Upload subtitle files">
                        <label for="fileInput" class="file-input-label">
                            <div class="icon">📁</div>
                            <div class="main-text">Click to browse files</div>
                            <div class="sub-text">Select up to ${maxBatchFiles} files or drag and drop</div>
                        </label>
                    </div>
                    <div class="file-name" id="fileName"></div>
                    <div class="file-hint">We queue uploads and run ${maxConcurrency === 1 ? 'one' : maxConcurrency} at a time to avoid rate limits.</div>
                </div>

                <div class="form-group" id="sourceLangGroup" style="display: none;">
                    <label for="sourceLang">
                        Source Language
                        <span class="label-description">Required for DeepL; pick the subtitle's original language or leave auto-detect.</span>
                    </label>
                    <select id="sourceLang">
                        <option value="">Auto-detect (recommended)</option>
                        ${allLanguageOptions}
                    </select>
                </div>

                <div class="form-group">
                    <label for="targetLang">
                        Target Language
                        <span class="label-description">Select the language to translate to</span>
                    </label>
                    <select id="targetLang" required>
                        <option value="">Choose a language...</option>
                        ${languageOptions}
                    </select>
                </div>

                <div class="language-toggle-container">
                    <label class="language-toggle">
                        <input type="checkbox" id="showAllLanguages">
                        <span>Show all languages</span>
                    </label>
                </div>

                <!-- Translation Options -->
                <div class="translation-options" id="translationOptions">
                    <div class="translation-options-header" id="translationOptionsHeader">
                        <div class="translation-options-title">
                            <span class="translation-options-icon">⚙️</span>
                            <span>Translation Options</span>
                        </div>
                        <div class="translation-options-toggle">▼</div>
                    </div>
                    <div class="translation-options-content">
                        <div class="translation-options-inner">
                            <div class="form-group">
                                <label for="providerSelect">
                                    Translation Provider
                                    <span class="label-description" id="providerDetails">Choose which configured provider to use for this translation.</span>
                                </label>
                                <select id="providerSelect"></select>
                            </div>

                            <div class="form-group">
                                <label for="workflowMode">
                                    Translation Flow
                                    <span class="label-description">Choose between multiple batches or a single batch run.</span>
                                </label>
                                <select id="workflowMode">
                                    <option value="batched">Multiple Batches (Recommended)</option>
                                    <option value="single-pass">Single-batch (all at once)</option>
                                </select>
                            </div>

                            <div class="form-group">
                                <label for="timingMode">
                                    Timestamps Strategy
                                    <span class="label-description">Decide how timestamps are handled during translation.</span>
                                </label>
                                <select id="timingMode">
                                    <option value="preserve-timing">Rebuild Timestamps</option>
                                    <option value="ai-timing">Send Timestamps to AI</option>
                                </select>
                            </div>
                        </div>
                    </div>
                </div>

                <button type="submit" class="btn" id="translateBtn">
                    🚀 Start Translation
                </button>

                <!-- Advanced Settings -->
                <div class="advanced-settings" id="advancedSettings">
                    <div class="advanced-settings-header" id="advancedSettingsHeader">
                        <div class="advanced-settings-title">
                            <span class="advanced-settings-icon">🔬</span>
                            <span>Advanced Settings</span>
                        </div>
                        <div class="advanced-settings-toggle">▼</div>
                    </div>
                    <div class="advanced-settings-content">
                        <div class="advanced-settings-inner">
                            <div class="highlight-box">
                                <p>
                                    <strong>Fine-tune AI behavior for this translation only:</strong> Override model and parameters.
                                    <em>These settings are temporary and won't be saved to your config.</em>
                                </p>
                            </div>

                            <div class="form-group">
                                <label for="advancedModel">
                                    Translation Model Override
                                    <span class="label-description">Override the default model for this translation only.</span>
                                </label>
                                <select id="advancedModel">
                                    <option value="">Use Configured Model (from your config)</option>
                                </select>
                                <div class="model-status" id="modelStatus"></div>
                            </div>

                            <div class="form-group" id="thinkingBudgetGroup">
                                <label for="advancedThinkingBudget">
                                    Thinking Budget (Extended Reasoning)
                                    <span class="label-description">0 = disabled, -1 = dynamic (auto-adjust), or fixed token count (1-32768).</span>
                                </label>
                                <input type="number" id="advancedThinkingBudget" min="-1" max="32768" step="1" value="0" placeholder="0">
                            </div>

                            <div class="form-group">
                                <label for="advancedTemperature">
                                    Temperature (Creativity)
                                    <span class="label-description">Controls randomness (0.0-2.0). Lower = deterministic, Higher = creative. Default: 0.8</span>
                                </label>
                                <input type="number" id="advancedTemperature" min="0" max="2" step="0.1" value="0.8" placeholder="0.8">
                            </div>

                            <div class="form-group" id="reasoningEffortGroup">
                                <label for="advancedReasoningEffort">
                                    Reasoning Effort
                                    <span class="label-description">Applies to reasoning-capable OpenAI-style models. Leave blank for default.</span>
                                </label>
                                <select id="advancedReasoningEffort">
                                    <option value="">None (use provider default)</option>
                                    <option value="low">Low</option>
                                    <option value="medium">Medium</option>
                                    <option value="high">High</option>
                                </select>
                            </div>

                            <div class="form-group">
                                <label for="advancedTopP">
                                    Top-P (Nucleus Sampling)
                                    <span class="label-description">Probability threshold (0.0-1.0). Lower = focused, Higher = diverse. Default: 0.95</span>
                                </label>
                                <input type="number" id="advancedTopP" min="0" max="1" step="0.05" value="0.95" placeholder="0.95">
                            </div>

                            <div class="form-group" id="topKGroup">
                                <label for="advancedTopK">
                                    Top-K (Token Selection)
                                    <span class="label-description">Number of top tokens to consider (1-100). Default: 40</span>
                                </label>
                                <input type="number" id="advancedTopK" min="1" max="100" step="1" value="40" placeholder="40">
                            </div>

                            <div class="form-group">
                                <label for="advancedMaxTokens">
                                    Max Output Tokens
                                    <span class="label-description">Maximum tokens in output (1-200000). Defaults follow your selected provider.</span>
                                </label>
                                <input type="number" id="advancedMaxTokens" min="1" max="200000" step="1" value="65536" placeholder="65536">
                            </div>

                            <div class="form-group" id="formalityGroup">
                                <label for="advancedFormality">
                                    Formality
                                    <span class="label-description">DeepL-only setting to control tone.</span>
                                </label>
                                <select id="advancedFormality">
                                    <option value="default">Default</option>
                                    <option value="more">More formal</option>
                                    <option value="less">Less formal</option>
                                </select>
                            </div>

                            <div class="form-group" id="preserveFormattingGroup">
                                <label for="advancedPreserveFormatting">
                                    Preserve Formatting
                                    <span class="label-description">Keep line breaks, casing, and tags intact (DeepL only).</span>
                                </label>
                                <label class="language-toggle" style="margin-top: 0.25rem;">
                                    <input type="checkbox" id="advancedPreserveFormatting" checked>
                                    <span>Preserve formatting</span>
                                </label>
                            </div>

                            <div class="form-group">
                                <label for="advancedTimeout">
                                    Translation Timeout (seconds)
                                    <span class="label-description">Maximum time to wait for translation (5-600). Defaults follow your selected provider.</span>
                                </label>
                                <input type="number" id="advancedTimeout" min="5" max="600" step="5" value="600" placeholder="600">
                            </div>

                            <div class="form-group">
                                <label for="advancedMaxRetries">
                                    Max Retries
                                    <span class="label-description">Number of retry attempts for this translation (0-5). Default: 2</span>
                                </label>
                                <input type="number" id="advancedMaxRetries" min="0" max="5" step="1" value="2" placeholder="2">
                            </div>

                            <button type="button" class="btn btn-secondary" id="resetDefaultsBtn">
                                🔄 Reset to Defaults
                            </button>
                        </div>
                    </div>
                </div>
            </form>

            <div class="progress" id="progress">
                <div class="spinner"></div>
                <div class="progress-text">Translating your subtitle...</div>
                <div class="progress-subtext">Queued translations run one at a time to respect rate limits.</div>
            </div>

            <div class="queue-panel" id="queuePanel" style="display: none;">
                <div class="queue-header">
                    <div>
                        <div class="queue-title">Upload queue</div>
                        <div class="queue-subtitle">Files run sequentially to avoid translation throttling.</div>
                    </div>
                    <div class="queue-summary" id="queueSummary">No files queued</div>
                </div>
                <ul class="queue-list" id="queueList"></ul>
            </div>

            <div class="result" id="result">
                <div class="result-icon">✓</div>
                <h2>Translation Complete!</h2>
                <p>Your subtitle has been successfully translated.</p>
                <a href="#" id="downloadLink" class="download-btn" download="translated.srt">
                    ⬇️ Download Translated Subtitle
                </a>
                <button type="button" class="btn btn-secondary" id="translateAnotherBtn" style="margin-top: 1rem;">
                    🔄 Translate Another One
                </button>
            </div>

            <div class="error" id="error"></div>
        </div>

        <div id="resetBarWrapper" class="reset-bar">
            <div class="reset-text">Reset File Translation page to defaults →</div>
            <button type="button" id="resetFilePageBtn" class="reset-btn">Reset</button>
        </div>
    </div>

    <!-- Reset confirmation modal (reuse configure flow) -->
    <div class="modal-overlay" id="resetConfirmModal" role="dialog" aria-modal="true" aria-labelledby="resetConfirmTitle">
        <div class="modal">
            <div class="modal-header">
                <h2 id="resetConfirmTitle">Reset File Translation</h2>
                <div class="modal-close" id="closeResetConfirmBtn" role="button" aria-label="Close reset dialog">×</div>
            </div>
            <div class="modal-content">
                <p><strong>This will reset everything for this tool:</strong></p>
                <p>- Clear queued jobs, selections, and any downloaded results</p>
                <p>- Remove saved preferences (themes, dismissed tips) for this page</p>
                <p style="margin-top: 0.75rem;">You'll be reloaded on the same file translation page afterward.</p>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn btn-secondary" id="cancelResetBtn">Cancel</button>
                <button type="button" class="btn btn-danger" id="confirmResetBtn">Reset Everything</button>
            </div>
        </div>
    </div>

        <script src="/js/subtitle-menu.js?v=${escapeHtml(appVersion || 'dev')}"></script>
        <script src="/js/combobox.js"></script>
        <script>
        const clientConfig = ${JSON.stringify(clientConfig)};
        const providerInfo = ${JSON.stringify(providerSummary)};
        const configToken = ${JSON.stringify(configStr)};
        const providerDefaults = ${JSON.stringify(getDefaultProviderParameters())};
        const PAGE = { configStr: configToken, videoId: ${JSON.stringify(videoId)}, filename: ${JSON.stringify(filename || '')}, videoHash: ${JSON.stringify(config?.videoHash || '')} };
        const subtitleMenuTargets = ${JSON.stringify(targetLangs)};
        let subtitleMenuInstance = null;
        const uploadQueueLimits = ${JSON.stringify(uploadQueueDefaults)};
        const translationDefaults = ${JSON.stringify(translationWorkflowDefaults)};
        const MAX_OUTPUT_TOKEN_LIMIT = ${MAX_OUTPUT_TOKEN_LIMIT};
        const DEFAULT_MAX_OUTPUT_TOKENS = ${DEFAULT_MAX_OUTPUT_TOKENS};
        ${quickNavScript()}

        if (window.ComboBox && typeof window.ComboBox.enhanceAll === 'function') {
            window.ComboBox.enhanceAll(document);
        }

        function mountSubtitleMenu() {
            if (!window.SubtitleMenu || typeof window.SubtitleMenu.mount !== 'function') return null;
            try {
                return window.SubtitleMenu.mount({
                    configStr: PAGE.configStr,
                    videoId: PAGE.videoId,
                    filename: PAGE.filename,
                    videoHash: PAGE.videoHash,
                    targetOptions: subtitleMenuTargets,
                    sourceLanguages: clientConfig.sourceLanguages || [],
                    targetLanguages: clientConfig.targetLanguages || [],
                    languageMaps: clientConfig.languageMaps,
                    getVideoHash: () => PAGE.videoHash || ''
                });
            } catch (err) {
                console.warn('Subtitle menu init failed', err);
                return null;
            }
        }

        function handleStreamUpdate(payload = {}) {
            const nextVideoId = (payload.videoId || '').trim();
            const nextFilename = (payload.filename || '').trim();
            const nextHash = (payload.videoHash || '').trim();
            const changed = (nextVideoId && nextVideoId !== PAGE.videoId) ||
                (nextFilename && nextFilename !== PAGE.filename) ||
                (nextHash && nextHash !== PAGE.videoHash);
            if (!changed) return;
            PAGE.videoId = nextVideoId || PAGE.videoId;
            PAGE.filename = nextFilename || PAGE.filename;
            PAGE.videoHash = nextHash || PAGE.videoHash;
            if (subtitleMenuInstance && typeof subtitleMenuInstance.updateStream === 'function') {
                subtitleMenuInstance.updateStream({
                    videoId: PAGE.videoId,
                    filename: PAGE.filename,
                    videoHash: PAGE.videoHash
                });
                if (typeof subtitleMenuInstance.prefetch === 'function') {
                    subtitleMenuInstance.prefetch();
                }
            }
        }

        subtitleMenuInstance = mountSubtitleMenu();
        if (subtitleMenuInstance && typeof subtitleMenuInstance.prefetch === 'function') {
            subtitleMenuInstance.prefetch();
        }

        function forwardMenuNotification(info) {
            if (!subtitleMenuInstance || typeof subtitleMenuInstance.notify !== 'function') return false;
            const message = (info && info.message) ? info.message : 'New stream detected';
            const title = (info && info.title) ? info.title + ': ' : '';
            subtitleMenuInstance.notify(title + message, 'muted', { persist: true });
            return true;
        }

        initStreamRefreshButton({
            buttonId: 'quickNavRefresh',
            configStr: PAGE.configStr,
            current: { videoId: PAGE.videoId, filename: PAGE.filename, videoHash: '' },
            labels: { loading: 'Refreshing...', empty: 'No stream yet', error: 'Refresh failed', current: 'Already latest' },
            buildUrl: (payload) => {
                return '/file-upload?config=' + encodeURIComponent(PAGE.configStr) +
                    '&videoId=' + encodeURIComponent(payload.videoId || '') +
                    '&filename=' + encodeURIComponent(payload.filename || '');
            }
        });

        initStreamWatcher({
            configStr: PAGE.configStr,
            current: { videoId: PAGE.videoId, filename: PAGE.filename, videoHash: PAGE.videoHash },
            buildUrl: (payload) => {
                return '/file-upload?config=' + encodeURIComponent(PAGE.configStr) +
                    '&videoId=' + encodeURIComponent(payload.videoId || '') +
                    '&filename=' + encodeURIComponent(payload.filename || '');
            },
            onEpisode: handleStreamUpdate,
            notify: forwardMenuNotification
        });

        const form = document.getElementById('translationForm');
        const quickNav = document.getElementById('quickNav');
        const mobileMenuToggle = document.getElementById('mobileMenuToggle');
        const mobileNavOverlay = document.getElementById('mobileNavOverlay');
        const fileInput = document.getElementById('fileInput');
        const fileName = document.getElementById('fileName');
        const targetLang = document.getElementById('targetLang');
        const translateBtn = document.getElementById('translateBtn');
        const progress = document.getElementById('progress');
        const result = document.getElementById('result');
        const error = document.getElementById('error');
        const downloadLink = document.getElementById('downloadLink');
        const progressText = progress ? progress.querySelector('.progress-text') : null;
        const progressSubtext = progress ? progress.querySelector('.progress-subtext') : null;
        const showAllLanguagesCheckbox = document.getElementById('showAllLanguages');
        const providerDetails = document.getElementById('providerDetails');
        const providerSelect = document.getElementById('providerSelect');
        const sourceLang = document.getElementById('sourceLang');
        const sourceLangGroup = document.getElementById('sourceLangGroup');
        const workflowMode = document.getElementById('workflowMode');
        const timingMode = document.getElementById('timingMode');
        const queuePanel = document.getElementById('queuePanel');
        const queueList = document.getElementById('queueList');
        const queueSummary = document.getElementById('queueSummary');
        const resetPageBtn = document.getElementById('resetFilePageBtn');
        const resetConfirmModal = document.getElementById('resetConfirmModal');
        const confirmResetBtn = document.getElementById('confirmResetBtn');
        const cancelResetBtn = document.getElementById('cancelResetBtn');
        const closeResetConfirmBtn = document.getElementById('closeResetConfirmBtn');

        // Language lists
        const configuredLanguages = \`<option value="">Choose a language...</option>${languageOptions}\`;
        const allLanguagesList = \`<option value="">Choose a language...</option>${allLanguageOptions}\`;
        const hasConfiguredLanguages = Array.isArray(clientConfig.targetLanguages) && clientConfig.targetLanguages.length > 0;
        const defaultSourceLanguage = Array.isArray(clientConfig.sourceLanguages) && clientConfig.sourceLanguages.length
            ? clientConfig.sourceLanguages[0]
            : '';
        const defaultTargetLanguage = hasConfiguredLanguages ? clientConfig.targetLanguages[0] : '';
        const defaultShowAllLanguages = !hasConfiguredLanguages;
        const defaultWorkflowValue = translationDefaults.singleBatchMode ? 'single-pass' : 'batched';
        const defaultTimingValue = translationDefaults.sendTimestampsToAI ? 'ai-timing' : 'preserve-timing';
        if (workflowMode) workflowMode.value = defaultWorkflowValue;
        if (timingMode) timingMode.value = defaultTimingValue;

        // Translation options elements
        const translationOptions = document.getElementById('translationOptions');
        const translationOptionsHeader = document.getElementById('translationOptionsHeader');

        // Advanced settings elements
        const advancedSettings = document.getElementById('advancedSettings');
        const advancedSettingsHeader = document.getElementById('advancedSettingsHeader');
        const advancedModel = document.getElementById('advancedModel');
        const advancedThinkingBudget = document.getElementById('advancedThinkingBudget');
        const advancedTemperature = document.getElementById('advancedTemperature');
        const advancedTopP = document.getElementById('advancedTopP');
        const advancedTopK = document.getElementById('advancedTopK');
        const advancedMaxTokens = document.getElementById('advancedMaxTokens');
        const advancedTimeout = document.getElementById('advancedTimeout');
        const advancedMaxRetries = document.getElementById('advancedMaxRetries');
        const advancedReasoningEffort = document.getElementById('advancedReasoningEffort');
        const advancedFormality = document.getElementById('advancedFormality');
        const advancedPreserveFormatting = document.getElementById('advancedPreserveFormatting');
        const topKGroup = document.getElementById('topKGroup');
        const thinkingBudgetGroup = document.getElementById('thinkingBudgetGroup');
        const reasoningEffortGroup = document.getElementById('reasoningEffortGroup');
        const formalityGroup = document.getElementById('formalityGroup');
        const preserveFormattingGroup = document.getElementById('preserveFormattingGroup');

        function resolveMaxTokensDefault(value) {
            const parsed = parseInt(value, 10);
            if (!Number.isFinite(parsed) || parsed < 1) {
                return DEFAULT_MAX_OUTPUT_TOKENS;
            }
            return Math.min(parsed, MAX_OUTPUT_TOKEN_LIMIT);
        }

        function readBoundedNumber(input, min, max, parser = parseFloat) {
            if (!input) return null;
            const parsed = parser(input.value);
            if (!Number.isFinite(parsed)) return null;
            const clamped = Math.min(Math.max(parsed, min), max);
            if (clamped !== parsed) {
                input.value = clamped;
            }
            return clamped;
        }

        const resetDefaultsBtn = document.getElementById('resetDefaultsBtn');
        const translateAnotherBtn = document.getElementById('translateAnotherBtn');
        const modelStatus = document.getElementById('modelStatus');
        const translateBtnLabel = translateBtn ? translateBtn.innerHTML : 'Start Translation';
        let translationInFlight = false;

        const defaultProviderKey = (providerInfo.mainProvider || 'gemini').toLowerCase();
        let activeProviderKey = defaultProviderKey;
        const fallbackProviderKey = providerInfo.secondaryProvider ? providerInfo.secondaryProvider.toLowerCase() : '';
        const baseAdvancedSettings = clientConfig.advancedSettings || {};
        const modelCache = new Map();
        const fetchedModels = new Set();

        function formatProviderName(key) {
            const normalized = String(key || '').toLowerCase();
            const map = {
                gemini: 'Gemini',
                openai: 'OpenAI',
                xai: 'xAI (Grok)',
                deepseek: 'DeepSeek',
                mistral: 'Mistral',
                cfworkers: 'Cloudflare Workers AI',
                openrouter: 'OpenRouter',
                anthropic: 'Anthropic',
                deepl: 'DeepL',
                googletranslate: 'Google Translate'
            };
            return map[normalized] || (normalized ? normalized.toUpperCase() : 'Unknown');
        }

        const normalizeProviderKey = (key) => String(key || '').trim().toLowerCase();

        function findProviderEntry(key) {
            const normalized = normalizeProviderKey(key);
            if (!normalized) return null;
            if (normalized === 'gemini') {
                return { key: 'gemini', enabled: true, model: clientConfig.geminiModel || providerInfo.mainModel || '' };
            }
            const providers = clientConfig.providers || {};
            const matchKey = Object.keys(providers).find(k => normalizeProviderKey(k) === normalized);
            if (!matchKey) return null;
            const cfg = providers[matchKey] || {};
            return { key: normalized, enabled: cfg.enabled === true, model: cfg.model || '' };
        }

        function getConfiguredModelForProvider(providerKey) {
            const normalized = normalizeProviderKey(providerKey);
            if (normalized === 'gemini') {
                return clientConfig.geminiModel || providerInfo.mainModel || '';
            }
            const entry = findProviderEntry(normalized);
            if (entry) return entry.model || '';
            if (fallbackProviderKey && normalizeProviderKey(fallbackProviderKey) === normalized) {
                return providerInfo.secondaryModel || '';
            }
            return '';
        }

        function buildProviderOptions() {
            const options = [];
            const seen = new Set();
            const add = (key) => {
                const entry = findProviderEntry(key);
                if (!entry || seen.has(entry.key) || entry.enabled !== true) return;
                seen.add(entry.key);
                options.push({
                    key: entry.key,
                    label: formatProviderName(entry.key),
                    model: entry.model || getConfiguredModelForProvider(entry.key)
                });
            };

            add(providerInfo.mainProvider || 'gemini');
            if (providerInfo.secondaryProvider) add(providerInfo.secondaryProvider);
            Object.keys(clientConfig.providers || {}).forEach(add);
            add('gemini'); // ensure Gemini is available as a fallback option

            return options;
        }

        function getProviderParamsFor(providerKey) {
            const normalized = normalizeProviderKey(providerKey);
            if (normalized === 'gemini') {
                return {
                    thinkingBudget: baseAdvancedSettings.thinkingBudget ?? 0,
                    temperature: baseAdvancedSettings.temperature ?? 0.8,
                    topP: baseAdvancedSettings.topP ?? 0.95,
                    topK: baseAdvancedSettings.topK ?? 40,
                    maxOutputTokens: baseAdvancedSettings.maxOutputTokens ?? 65536,
                    translationTimeout: baseAdvancedSettings.translationTimeout ?? 600,
                    maxRetries: baseAdvancedSettings.maxRetries ?? 2
                };
            }
            const params = clientConfig.providerParameters || {};
            const matchKey = Object.keys(params).find(k => normalizeProviderKey(k) === normalized);
            const providerParams = (matchKey ? params[matchKey] : params[normalized]) || {};
            const defaults = providerDefaults[normalized] || {};
            return { ...defaults, ...providerParams };
        }

        function getProviderCapabilities(providerKey) {
            const normalized = normalizeProviderKey(providerKey);
            const isDeepL = normalized === 'deepl';
            const isGoogle = normalized === 'googletranslate';
            return {
                supportsTopK: normalized === 'gemini',
                supportsThinking: normalized === 'gemini' || normalized === 'anthropic',
                supportsReasoning: normalized === 'openai',
                supportsFormality: isDeepL,
                supportsTemperature: !isDeepL && !isGoogle,
                supportsTopP: !isDeepL && !isGoogle,
                supportsMaxTokens: !isDeepL && !isGoogle,
                supportsTimeout: true,
                supportsMaxRetries: true,
                requiresSourceLanguage: isDeepL
            };
        }

        function setLanguageOptions(useAll) {
            const currentTarget = targetLang ? targetLang.value : '';
            if (targetLang) {
                targetLang.innerHTML = useAll ? allLanguagesList : configuredLanguages;
                if (currentTarget) {
                    const optionExists = Array.from(targetLang.options).some(opt => opt.value === currentTarget);
                    if (optionExists) {
                        targetLang.value = currentTarget;
                    }
                }
            }

            if (sourceLang) {
                const currentSource = sourceLang.value;
                const trimmedAllLanguages = allLanguagesList.replace('<option value="">Choose a language...</option>', '');
                sourceLang.innerHTML = '<option value="">Auto-detect (recommended)</option>' + trimmedAllLanguages;
                if (currentSource) {
                    const optionExists = Array.from(sourceLang.options).some(opt => opt.value === currentSource);
                    sourceLang.value = optionExists ? currentSource : '';
                } else {
                    const defaultExists = defaultSourceLanguage && Array.from(sourceLang.options).some(opt => opt.value === defaultSourceLanguage);
                    sourceLang.value = defaultExists ? defaultSourceLanguage : '';
                }
            }
        }

        // Apply initial language list
        setLanguageOptions(!hasConfiguredLanguages);
        if (!hasConfiguredLanguages) {
            showAllLanguagesCheckbox.checked = true;
            showAllLanguagesCheckbox.disabled = true;
        }

        // Language toggle functionality
        showAllLanguagesCheckbox.addEventListener('change', function() {
            setLanguageOptions(this.checked);
        });

        const temperatureGroup = advancedTemperature ? advancedTemperature.closest('.form-group') : null;
        const topPGroup = advancedTopP ? advancedTopP.closest('.form-group') : null;
        const maxTokensGroup = advancedMaxTokens ? advancedMaxTokens.closest('.form-group') : null;
        const timeoutGroup = advancedTimeout ? advancedTimeout.closest('.form-group') : null;
        const retriesGroup = advancedMaxRetries ? advancedMaxRetries.closest('.form-group') : null;

        function populateModelDropdown(providerKey, models = []) {
            const normalized = normalizeProviderKey(providerKey);
            const configuredModel = getConfiguredModelForProvider(normalized);
            const placeholder = configuredModel
                ? 'Use Configured Model (' + configuredModel + ')'
                : 'Use Configured Model (from your config)';
            if (advancedModel) {
                advancedModel.innerHTML = '<option value="">' + placeholder + '</option>';
                models.forEach(model => {
                    const option = document.createElement('option');
                    option.value = model.name || model.id;
                    option.textContent = model.displayName || model.name || model.id;
                    advancedModel.appendChild(option);
                });
                advancedModel.value = '';
            }
        }

        function updateProviderDetails(providerKey) {
            const normalized = normalizeProviderKey(providerKey);
            const label = formatProviderName(normalized);
            const configuredModel = getConfiguredModelForProvider(normalized);
            const isMain = normalizeProviderKey(providerInfo.mainProvider) === normalized;
            const fallbackLabel = isMain && fallbackProviderKey ? formatProviderName(fallbackProviderKey) : '';
            if (providerDetails) {
                if (fallbackLabel) {
                    providerDetails.textContent = 'Using ' + label + (configuredModel ? ' (' + configuredModel + ')' : '') +
                        ' with fallback ' + fallbackLabel + (providerInfo.secondaryModel ? ' (' + providerInfo.secondaryModel + ')' : '') + '.';
                } else {
                    providerDetails.textContent = 'Using ' + label + (configuredModel ? ' (' + configuredModel + ')' : '') + ' from your saved SubMaker config.';
                }
            }
        }

        function applyDefaults(providerKey) {
            const normalized = normalizeProviderKey(providerKey || 'gemini');
            activeProviderKey = normalized;
            const params = getProviderParamsFor(normalized);
            const caps = getProviderCapabilities(normalized);

            if (thinkingBudgetGroup) {
                thinkingBudgetGroup.style.display = caps.supportsThinking ? '' : 'none';
            }
            if (reasoningEffortGroup) {
                reasoningEffortGroup.style.display = caps.supportsReasoning ? '' : 'none';
            }
            if (topKGroup) {
                topKGroup.style.display = caps.supportsTopK ? '' : 'none';
            }
            if (formalityGroup) {
                formalityGroup.style.display = caps.supportsFormality ? '' : 'none';
            }
            if (preserveFormattingGroup) {
                preserveFormattingGroup.style.display = caps.supportsFormality ? '' : 'none';
            }
            if (sourceLangGroup) {
                sourceLangGroup.style.display = caps.requiresSourceLanguage ? '' : 'none';
                if (!caps.requiresSourceLanguage && sourceLang) {
                    sourceLang.value = '';
                } else if (caps.requiresSourceLanguage && sourceLang && !sourceLang.value && defaultSourceLanguage) {
                    const optionExists = Array.from(sourceLang.options).some(opt => opt.value === defaultSourceLanguage);
                    if (optionExists) {
                        sourceLang.value = defaultSourceLanguage;
                    }
                }
            }
            if (temperatureGroup) {
                temperatureGroup.style.display = caps.supportsTemperature ? '' : 'none';
            }
            if (topPGroup) {
                topPGroup.style.display = caps.supportsTopP ? '' : 'none';
            }
            if (maxTokensGroup) {
                maxTokensGroup.style.display = caps.supportsMaxTokens ? '' : 'none';
            }

            if (advancedThinkingBudget && caps.supportsThinking) {
                advancedThinkingBudget.value = params.thinkingBudget ?? 0;
            }
            if (advancedTemperature && caps.supportsTemperature) {
                advancedTemperature.value = params.temperature ?? 0.8;
            }
            if (advancedTopP && caps.supportsTopP) {
                advancedTopP.value = params.topP ?? 0.95;
            }
            if (advancedTopK && caps.supportsTopK) {
                advancedTopK.value = params.topK ?? 40;
            }
            if (advancedMaxTokens && caps.supportsMaxTokens) {
                advancedMaxTokens.min = '1';
                advancedMaxTokens.max = String(MAX_OUTPUT_TOKEN_LIMIT);
                advancedMaxTokens.value = resolveMaxTokensDefault(
                    params.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
                );
            }
            if (advancedTimeout && caps.supportsTimeout) {
                advancedTimeout.value = params.translationTimeout ?? baseAdvancedSettings.translationTimeout ?? 600;
            }
            if (advancedMaxRetries && caps.supportsMaxRetries) {
                advancedMaxRetries.value = params.maxRetries ?? baseAdvancedSettings.maxRetries ?? 2;
            }
            if (advancedReasoningEffort && caps.supportsReasoning) {
                advancedReasoningEffort.value = params.reasoningEffort || '';
            }
            if (advancedFormality && caps.supportsFormality) {
                advancedFormality.value = params.formality || 'default';
            }
            if (advancedPreserveFormatting && caps.supportsFormality) {
                advancedPreserveFormatting.checked = params.preserveFormatting !== false;
            }

            if (advancedModel) {
                const cachedModels = modelCache.get(normalized) || [];
                populateModelDropdown(normalized, cachedModels);
            }

            if (modelStatus) {
                modelStatus.innerHTML = '';
                modelStatus.className = 'model-status';
            }

            updateProviderDetails(normalized);
        }

        function resetPageToDefaults() {
            clearQueue(true);
            activeProviderKey = defaultProviderKey;

            if (advancedSettings) {
                advancedSettings.classList.remove('expanded');
            }

            if (providerSelect) {
                providerSelect.value = defaultProviderKey;
            }

            if (workflowMode) workflowMode.value = defaultWorkflowValue;
            if (timingMode) timingMode.value = defaultTimingValue;

            if (showAllLanguagesCheckbox) {
                showAllLanguagesCheckbox.checked = defaultShowAllLanguages;
                showAllLanguagesCheckbox.disabled = defaultShowAllLanguages;
            }

            setLanguageOptions(showAllLanguagesCheckbox ? showAllLanguagesCheckbox.checked : false);

            if (targetLang) {
                const hasDefaultTarget = defaultTargetLanguage &&
                    Array.from(targetLang.options).some(opt => opt.value === defaultTargetLanguage);
                targetLang.value = hasDefaultTarget ? defaultTargetLanguage : '';
            }

            if (sourceLang) {
                const hasDefaultSource = defaultSourceLanguage &&
                    Array.from(sourceLang.options).some(opt => opt.value === defaultSourceLanguage);
                sourceLang.value = hasDefaultSource ? defaultSourceLanguage : '';
            }

            if (advancedModel) advancedModel.value = '';

            applyDefaults(defaultProviderKey);
            updateFileNameDisplay([]);

            if (error) {
                error.textContent = '';
                error.classList.remove('active');
            }

            if (result) {
                result.classList.remove('active');
            }
        }

        function toggleBodyScrollLock(shouldLock) {
            try {
                const scrollbarWidth = Math.max(0, (window.innerWidth || 0) - (document.documentElement ? document.documentElement.clientWidth : 0));
                document.body.classList.toggle('modal-open', !!shouldLock);
                if (shouldLock && scrollbarWidth > 0) {
                    if (document.body.dataset.prOriginal === undefined) {
                        document.body.dataset.prOriginal = document.body.style.paddingRight || '';
                    }
                    document.body.style.paddingRight = scrollbarWidth + 'px';
                } else if (!shouldLock) {
                    if (document.body.dataset.prOriginal !== undefined) {
                        document.body.style.paddingRight = document.body.dataset.prOriginal;
                        delete document.body.dataset.prOriginal;
                    } else {
                        document.body.style.paddingRight = '';
                    }
                }
            } catch (_) {}
        }

        function openResetConfirm() {
            if (!resetConfirmModal) {
                resetPageToDefaults();
                return;
            }
            resetConfirmModal.classList.add('show');
            resetConfirmModal.style.display = 'flex';
            toggleBodyScrollLock(true);
        }

        function closeResetConfirm() {
            if (!resetConfirmModal) return;
            resetConfirmModal.classList.remove('show');
            resetConfirmModal.style.display = 'none';
            toggleBodyScrollLock(false);
        }

        async function performFullReset() {
            if (confirmResetBtn) {
                confirmResetBtn.disabled = true;
                confirmResetBtn.textContent = 'Resetting...';
            }
            try {
                resetPageToDefaults();

                // Clear page-level preferences (theme, dismissed tips) only
                try { localStorage.removeItem('theme'); } catch (_) {}
                try { localStorage.removeItem(INSTRUCTIONS_KEY); } catch (_) {}
            } finally {
                if (confirmResetBtn) {
                    confirmResetBtn.disabled = false;
                    confirmResetBtn.textContent = 'Reset Everything';
                }
                closeResetConfirm();

                const params = new URLSearchParams();
                const nextConfig = PAGE.configStr || '';
                if (nextConfig) params.set('config', nextConfig);
                if (PAGE.videoId) params.set('videoId', PAGE.videoId);
                if (PAGE.filename) params.set('filename', PAGE.filename);
                params.set('reset', Date.now());

                const nextUrl = '/file-upload' + (params.toString() ? '?' + params.toString() : '');
                window.location.replace(nextUrl);
            }
        }

        function populateProviderSelect() {
            if (!providerSelect) return;
            const options = buildProviderOptions();
            providerSelect.innerHTML = '';
            options.forEach(opt => {
                const option = document.createElement('option');
                option.value = opt.key;
                option.textContent = opt.label + (opt.model ? ' • ' + opt.model : '');
                providerSelect.appendChild(option);
            });
            const preferred = options.find(o => o.key === activeProviderKey) ? activeProviderKey : (options[0]?.key || 'gemini');
            providerSelect.value = preferred;
            applyDefaults(preferred);
        }

        populateProviderSelect();

        // Translation options toggle
        translationOptionsHeader.addEventListener('click', () => {
            translationOptions.classList.toggle('expanded');
        });

        // Advanced settings toggle
        advancedSettingsHeader.addEventListener('click', () => {
            advancedSettings.classList.toggle('expanded');
            if (advancedSettings.classList.contains('expanded') && !fetchedModels.has(activeProviderKey)) {
                fetchModels(activeProviderKey);
            }
        });

        if (providerSelect) {
            providerSelect.addEventListener('change', () => {
                const selected = normalizeProviderKey(providerSelect.value || activeProviderKey);
                applyDefaults(selected);
                if (advancedSettings.classList.contains('expanded') && !fetchedModels.has(selected)) {
                    fetchModels(selected);
                }
            });
        }

        // Reset to defaults
        resetDefaultsBtn.addEventListener('click', () => {
            applyDefaults(activeProviderKey);
        });

        if (resetPageBtn) {
            resetPageBtn.addEventListener('click', openResetConfirm);
        }

        if (confirmResetBtn) {
            confirmResetBtn.addEventListener('click', performFullReset);
        }

        if (cancelResetBtn) {
            cancelResetBtn.addEventListener('click', closeResetConfirm);
        }

        if (closeResetConfirmBtn) {
            closeResetConfirmBtn.addEventListener('click', closeResetConfirm);
        }

        // Translate another one button
        translateAnotherBtn.addEventListener('click', () => {
            clearQueue();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });

        // Fetch models from API using stored config
        async function fetchModels(providerKey) {
            const normalized = normalizeProviderKey(providerKey || activeProviderKey);
            if (!configToken) {
                return;
            }

            if (normalized === 'googletranslate') {
                populateModelDropdown(normalized, []);
                fetchedModels.add(normalized);
                modelStatus.innerHTML = 'Model override not available for Google Translate';
                modelStatus.className = 'model-status';
                return;
            }

            modelStatus.innerHTML = '<div class="spinner-small"></div> Fetching models...';
            modelStatus.className = 'model-status fetching';

            const endpoint = normalized === 'gemini'
                ? '/api/gemini-models'
                : '/api/models/' + normalized;

            try {
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ configStr: configToken })
                });

                if (!response.ok) {
                    throw new Error((await response.text()) || 'Failed to fetch models');
                }

                const models = await response.json();
                modelCache.set(normalized, models);
                fetchedModels.add(normalized);

                modelStatus.innerHTML = 'Models loaded!';
                modelStatus.className = 'model-status success';

                setTimeout(() => {
                    modelStatus.innerHTML = '';
                    modelStatus.className = 'model-status';
                }, 3000);

                populateModelDropdown(normalized, models);

            } catch (err) {
                console.error('Failed to fetch models:', err);
                modelStatus.innerHTML = 'Failed to fetch models';
                modelStatus.className = 'model-status error';

                setTimeout(() => {
                    modelStatus.innerHTML = '';
                    modelStatus.className = 'model-status';
                }, 5000);
            }
        }

        // Instructions modal handlers
        const instructionsOverlay = document.getElementById('instructionsOverlay');
        const showInstructionsBtn = document.getElementById('showInstructions');
        const closeInstructionsBtn = document.getElementById('closeInstructions');
        const gotItBtn = document.getElementById('gotItBtn');
        const INSTRUCTIONS_KEY = 'submaker_file_upload_instructions_visited';

        function closeInstructionsModal() {
            instructionsOverlay.classList.remove('show');
            // Mark as visited so it doesn't auto-show on subsequent visits
            try { localStorage.setItem(INSTRUCTIONS_KEY, 'true'); } catch (_) {}
        }

        const hasVisited = (() => {
            try { return localStorage.getItem(INSTRUCTIONS_KEY) === 'true'; } catch (_) { return false; }
        })();

        // Only auto-show on first visit
        if (!hasVisited) {
            setTimeout(() => {
                instructionsOverlay.classList.add('show');
            }, 500);
        }

        showInstructionsBtn.addEventListener('click', () => {
            instructionsOverlay.classList.add('show');
        });

        closeInstructionsBtn.addEventListener('click', closeInstructionsModal);
        gotItBtn.addEventListener('click', closeInstructionsModal);

        instructionsOverlay.addEventListener('click', (e) => {
            if (e.target === instructionsOverlay) {
                closeInstructionsModal();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && resetConfirmModal && resetConfirmModal.classList.contains('show')) {
                closeResetConfirm();
                return;
            }
            if (e.key === 'Escape' && instructionsOverlay.classList.contains('show')) {
                closeInstructionsModal();
            }
        });

        // Upload queue + selection handling
        const resolvedMaxFiles = parseInt(uploadQueueLimits.maxFiles || 10, 10);
        const resolvedMaxConcurrent = parseInt(uploadQueueLimits.maxConcurrent || 1, 10);
        const MAX_FILES = Math.max(1, Number.isFinite(resolvedMaxFiles) ? resolvedMaxFiles : 10);
        const MAX_CONCURRENT = Math.max(1, Number.isFinite(resolvedMaxConcurrent) ? resolvedMaxConcurrent : 1);
        const uploadQueue = [];
        let jobCounter = 0;
        let activeJobs = 0;
        const isQueueBusy = () => activeJobs > 0 || uploadQueue.some(j => j.status === 'pending' || j.status === 'processing');

        function updateTranslationButtonState() {
            const busy = translationInFlight || isQueueBusy();
            if (translateBtn) {
                translateBtn.disabled = busy;
                translateBtn.innerHTML = busy ? 'Translating...' : translateBtnLabel;
            }
        }

        function setTranslationInFlight(active) {
            translationInFlight = !!active;
            updateTranslationButtonState();
        }
        const fileLabel = document.querySelector('.file-input-label');

        const safeText = (text) => {
            if (!text) return '';
            const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
            return String(text).replace(/[&<>"']/g, (ch) => map[ch] || ch);
        };

        function updateFileNameDisplay(files) {
            if (!fileName) return;
            if (!files || files.length === 0) {
                fileName.textContent = '';
                fileName.classList.remove('active');
                return;
            }
            if (files.length === 1) {
                fileName.textContent = 'Files selected: ' + files[0].name;
            } else {
                const preview = files.slice(0, 3).map(f => f.name).join(', ');
                const extra = files.length > 3 ? ' +' + (files.length - 3) + ' more' : '';
                fileName.textContent = files.length + ' files selected: ' + preview + extra;
            }
            fileName.classList.add('active');
        }

        function clampSelection(files) {
            const currentQueueSize = uploadQueue.length;
            const availableSlots = Math.max(0, MAX_FILES - currentQueueSize);
            let selected = files.slice(0, MAX_FILES);
            if (selected.length > availableSlots) {
                showError(availableSlots === 0
                    ? 'You already have ' + MAX_FILES + ' files in the queue. Clear it to add more.'
                    : 'Only the first ' + availableSlots + ' files were added to stay within the queue limit of ' + MAX_FILES + '.');
                selected = selected.slice(0, availableSlots);
            }
            return selected;
        }

        function setSelectedFiles(files) {
            if (!fileInput) return [];
            const limited = clampSelection(files);
            try {
                const dt = new DataTransfer();
                limited.forEach(f => dt.items.add(f));
                fileInput.files = dt.files;
            } catch (_) {
                fileInput.files = limited;
            }
            updateFileNameDisplay(limited);
            return limited;
        }

        const summarizeQueueMeta = (job) => {
            const workflow = job.settings.workflowMode === 'single-pass' ? 'Single-batch' : 'Multiple batches';
            const timing = job.settings.timingMode === 'ai-timing' ? 'Send timestamps to AI' : 'Rebuild timestamps';
            return workflow + ' • ' + timing + ' • ' + (job.settings.targetLanguage || '').toUpperCase();
        };

        function buildDownloadName(job) {
            const base = (job.name || 'subtitle').replace(/\.[^.]+$/, '');
            return 'translated_' + (job.settings?.targetLanguage || 'sub') + '_' + base + '.srt';
        }

        function cloneSelection(selection) {
            return {
                ...selection,
                overrides: { ...(selection.overrides || {}) },
                advancedOverrides: { ...(selection.advancedOverrides || {}) }
            };
        }

        function renderQueue() {
            if (!queuePanel || !queueList) return;
            if (uploadQueue.length === 0) {
                queuePanel.style.display = 'none';
                queueList.innerHTML = '';
                if (queueSummary) queueSummary.textContent = 'No files queued';
                return;
            }
            queuePanel.style.display = 'block';
            const completed = uploadQueue.filter(j => j.status === 'completed').length;
            const failed = uploadQueue.filter(j => j.status === 'failed').length;
            const pending = uploadQueue.filter(j => j.status === 'pending').length;
            const processing = uploadQueue.filter(j => j.status === 'processing').length;
            if (queueSummary) {
                const parts = [];
                if (processing) parts.push(processing + ' in progress');
                if (pending) parts.push(pending + ' queued');
                if (completed) parts.push(completed + ' done');
                if (failed) parts.push(failed + ' failed');
                queueSummary.textContent = parts.length ? parts.join(' • ') : 'Queue ready';
            }
            queueList.innerHTML = '';
            uploadQueue.forEach(job => {
                const item = document.createElement('li');
                item.className = 'queue-item' + (job.status === 'processing' ? ' processing' : '');

                const info = document.createElement('div');
                info.className = 'queue-item-info';
                const name = document.createElement('div');
                name.className = 'queue-name';
                name.innerHTML = safeText(job.name || 'Untitled');
                info.appendChild(name);
                const meta = document.createElement('div');
                meta.className = 'queue-meta';
                meta.textContent = summarizeQueueMeta(job);
                info.appendChild(meta);
                if (job.status === 'failed' && job.error) {
                    const err = document.createElement('div');
                    err.className = 'queue-meta';
                    err.style.color = 'var(--danger)';
                    err.textContent = job.error;
                    info.appendChild(err);
                }

                const actions = document.createElement('div');
                actions.className = 'queue-actions';
                const status = document.createElement('div');
                status.className = 'queue-status status-' + job.status;
                const statusMap = {
                    pending: 'Queued',
                    processing: 'Processing',
                    completed: 'Done',
                    failed: 'Failed'
                };
                status.textContent = statusMap[job.status] || 'Queued';
                actions.appendChild(status);
                if (job.status === 'completed' && job.downloadUrl) {
                    const link = document.createElement('a');
                    link.href = job.downloadUrl;
                    link.download = job.downloadName || 'translated.srt';
                    link.className = 'queue-download';
                    link.textContent = 'Download';
                    actions.appendChild(link);
                }

                item.appendChild(info);
                item.appendChild(actions);
                queueList.appendChild(item);
            });

            updateTranslationButtonState();
        }

        function updateProgressUI(job, position, total) {
            if (!progress) return;
            if (!job) {
                progress.classList.remove('active');
                return;
            }
            progress.classList.add('active');
            if (progressText) {
                progressText.textContent = 'Translating ' + (job.name || 'subtitle');
            }
            if (progressSubtext) {
                progressSubtext.textContent = 'Job ' + position + ' of ' + total + '. Running ' + MAX_CONCURRENT + ' at a time.';
            }
        }

        function captureSelection() {
            if (!targetLang.value) {
                throw new Error('Please select a target language');
            }
            const providerKey = normalizeProviderKey(providerSelect ? providerSelect.value : activeProviderKey);
            const caps = getProviderCapabilities(providerKey);
            const selectedSourceLanguage = sourceLang ? sourceLang.value.trim() : '';

            if (caps.requiresSourceLanguage && !selectedSourceLanguage) {
                throw new Error('Please select a source language for DeepL translations');
            }

            const selectedModel = advancedModel && advancedModel.value ? advancedModel.value.trim() : '';
            const thinkingBudget = caps.supportsThinking
                ? readBoundedNumber(advancedThinkingBudget, -1, 32768, (v) => parseInt(v, 10))
                : null;
            const temperature = caps.supportsTemperature
                ? readBoundedNumber(advancedTemperature, 0, 2, (v) => parseFloat(v))
                : null;
            const topP = caps.supportsTopP
                ? readBoundedNumber(advancedTopP, 0, 1, (v) => parseFloat(v))
                : null;
            const topK = caps.supportsTopK
                ? readBoundedNumber(advancedTopK, 1, 100, (v) => parseInt(v, 10))
                : null;
            const maxTokens = caps.supportsMaxTokens
                ? readBoundedNumber(advancedMaxTokens, 1, MAX_OUTPUT_TOKEN_LIMIT, (v) => parseInt(v, 10))
                : null;
            const timeout = caps.supportsTimeout
                ? readBoundedNumber(advancedTimeout, 5, 600, (v) => parseInt(v, 10))
                : null;
            const maxRetries = caps.supportsMaxRetries
                ? readBoundedNumber(advancedMaxRetries, 0, 5, (v) => parseInt(v, 10))
                : null;
            const reasoningEffort = caps.supportsReasoning && advancedReasoningEffort ? advancedReasoningEffort.value : '';
            const formality = caps.supportsFormality && advancedFormality ? advancedFormality.value : '';
            const preserveFormatting = caps.supportsFormality && advancedPreserveFormatting ? advancedPreserveFormatting.checked : null;

            const providerOverrides = {};
            if (caps.supportsTemperature && Number.isFinite(temperature)) providerOverrides.temperature = temperature;
            if (caps.supportsTopP && Number.isFinite(topP)) providerOverrides.topP = topP;
            if (caps.supportsMaxTokens && Number.isFinite(maxTokens)) providerOverrides.maxOutputTokens = maxTokens;
            if (caps.supportsTimeout && Number.isFinite(timeout)) providerOverrides.translationTimeout = timeout;
            if (caps.supportsMaxRetries && Number.isFinite(maxRetries)) providerOverrides.maxRetries = maxRetries;
            if (caps.supportsThinking && Number.isFinite(thinkingBudget)) {
                providerOverrides.thinkingBudget = thinkingBudget;
            }
            if (caps.supportsReasoning && reasoningEffort) {
                providerOverrides.reasoningEffort = reasoningEffort;
            }
            if (caps.supportsFormality) {
                providerOverrides.formality = formality || 'default';
                if (preserveFormatting !== null) providerOverrides.preserveFormatting = preserveFormatting;
            }

            const advancedOverrides = providerKey === 'gemini'
                ? {
                    geminiModel: selectedModel || clientConfig.geminiModel || '',
                    thinkingBudget: Number.isFinite(thinkingBudget) ? thinkingBudget : undefined,
                    temperature: Number.isFinite(temperature) ? temperature : undefined,
                    topP: Number.isFinite(topP) ? topP : undefined,
                    topK: Number.isFinite(topK) ? topK : undefined,
                    maxOutputTokens: Number.isFinite(maxTokens) ? maxTokens : undefined,
                    translationTimeout: Number.isFinite(timeout) ? timeout : undefined,
                    maxRetries: Number.isFinite(maxRetries) ? maxRetries : undefined
                }
                : {};

            const overrides = { provider: providerKey };
            if (selectedModel) overrides.providerModel = selectedModel;
            if (Object.keys(providerOverrides).length > 0) {
                overrides.providerParameters = { [providerKey]: providerOverrides };
            }
            if (providerKey === 'gemini' && Object.keys(advancedOverrides).length > 0) {
                overrides.advancedSettings = advancedOverrides;
            }

            const workflowValue = workflowMode ? workflowMode.value : 'batched';
            const timingValue = timingMode ? timingMode.value : 'preserve-timing';

            return {
                providerKey,
                targetLanguage: targetLang.value,
                sourceLanguage: caps.requiresSourceLanguage ? selectedSourceLanguage : '',
                overrides,
                advancedOverrides,
                workflowMode: workflowValue,
                timingMode: timingValue
            };
        }

        function buildRequestPayload(job, fileContent) {
            const { settings } = job;
            const payload = {
                content: fileContent,
                targetLanguage: settings.targetLanguage,
                configStr: configToken,
                advancedSettings: settings.providerKey === 'gemini' ? settings.advancedOverrides : {},
                overrides: settings.overrides,
                options: {
                    workflow: settings.workflowMode,
                    timingMode: settings.timingMode,
                    singleBatchMode: settings.workflowMode === 'single-pass',
                    sendTimestampsToAI: settings.timingMode !== 'preserve-timing'
                }
            };
            if (settings.sourceLanguage) {
                payload.sourceLanguage = settings.sourceLanguage;
            }
            return payload;
        }

        function createJob(file, selection) {
            return {
                id: ++jobCounter,
                file,
                name: file.name,
                size: file.size,
                status: 'pending',
                error: '',
                downloadUrl: '',
                downloadName: '',
                settings: cloneSelection(selection)
            };
        }

        function pumpQueue() {
            for (let i = 0; i < MAX_CONCURRENT; i++) {
                processNextInQueue();
            }
        }

        async function processNextInQueue() {
            if (activeJobs >= MAX_CONCURRENT) {
                return;
            }
            const nextJob = uploadQueue.find(j => j.status === 'pending');
            if (!nextJob) {
                if (activeJobs === 0) {
                    updateProgressUI(null, 0, 0);
                    setTranslationInFlight(false);
                }
                return;
            }

            activeJobs += 1;
            nextJob.status = 'processing';
            renderQueue();

            const jobIndex = uploadQueue.findIndex(j => j.id === nextJob.id) + 1;
            updateProgressUI(nextJob, jobIndex, uploadQueue.length);

            try {
                const fileContent = await nextJob.file.text();
                const payload = buildRequestPayload(nextJob, fileContent);
                const response = await fetch('/api/translate-file', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    throw new Error('Translation failed: ' + await response.text());
                }

                const translatedContent = await response.text();
                const blob = new Blob([translatedContent], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);

                nextJob.downloadUrl = url;
                nextJob.downloadName = buildDownloadName(nextJob);
                nextJob.status = 'completed';

                result.classList.add('active');
                if (downloadLink) {
                    downloadLink.href = url;
                    downloadLink.download = nextJob.downloadName;
                }
                const resultTitle = result.querySelector('h2');
                const resultDesc = result.querySelector('p');
                if (resultTitle) resultTitle.textContent = 'Translation Complete';
                if (resultDesc) resultDesc.textContent = 'Finished: ' + (nextJob.name || 'subtitle');
            } catch (err) {
                console.error('Translation error:', err);
                nextJob.status = 'failed';
                nextJob.error = err.message || 'Translation failed';
                showError(nextJob.error);
            } finally {
                activeJobs = Math.max(0, activeJobs - 1);
                renderQueue();
                if (uploadQueue.every(j => j.status !== 'processing' && j.status !== 'pending')) {
                    updateProgressUI(null, 0, 0);
                    setTranslationInFlight(false);
                }
                setTimeout(() => pumpQueue(), 100);
            }
        }

        function clearQueue(resetSelection = true) {
            uploadQueue.forEach(job => {
                if (job.downloadUrl) {
                    try { URL.revokeObjectURL(job.downloadUrl); } catch (_) {}
                }
            });
            uploadQueue.length = 0;
            jobCounter = 0;
            activeJobs = 0;
            updateProgressUI(null, 0, 0);
            renderQueue();
            result.classList.remove('active');
            error.classList.remove('active');
            setTranslationInFlight(false);
            if (resetSelection && fileInput) {
                fileInput.value = '';
                updateFileNameDisplay([]);
            }
        }

        // Handle file selection
        if (fileInput) {
            fileInput.addEventListener('change', (e) => {
                const files = Array.from(e.target.files || []);
                setSelectedFiles(files);
            });
        }

        // Handle drag and drop
        if (fileLabel) {
            fileLabel.addEventListener('dragover', (e) => {
                e.preventDefault();
                fileLabel.style.borderColor = 'var(--primary)';
                fileLabel.style.background = 'var(--surface-light)';
            });

            fileLabel.addEventListener('dragleave', (e) => {
                e.preventDefault();
                fileLabel.style.borderColor = 'var(--border)';
                fileLabel.style.background = 'var(--surface)';
            });

            fileLabel.addEventListener('drop', (e) => {
                e.preventDefault();
                fileLabel.style.borderColor = 'var(--border)';
                fileLabel.style.background = 'var(--surface)';

                if (e.dataTransfer.files.length > 0) {
                    const files = Array.from(e.dataTransfer.files);
                    const normalized = setSelectedFiles(files);
                    if (normalized.length && fileInput) {
                        const event = new Event('change');
                        fileInput.dispatchEvent(event);
                    }
                }
            });
        }

        // Handle form submission (enqueue + start queue)
        form.addEventListener('submit', (e) => {
            e.preventDefault();

            if (translationInFlight || isQueueBusy()) {
                return;
            }

            if (!configToken) {
                showError('Missing configuration token. Open this page again from Stremio or the configure page.');
                return;
            }

            const selectedFiles = setSelectedFiles(Array.from(fileInput.files || []));
            if (!selectedFiles.length) {
                showError('Please select at least one subtitle file (SRT, VTT, ASS, SSA).');
                return;
            }

            let selection;
            try {
                selection = captureSelection();
            } catch (err) {
                showError(err.message || 'Please review your selections.');
                return;
            }

            activeProviderKey = selection.providerKey;
            result.classList.remove('active');
            error.classList.remove('active');

            selectedFiles.forEach(file => uploadQueue.push(createJob(file, selection)));
            setTranslationInFlight(true);
            if (fileInput) {
                fileInput.value = '';
            }
            updateFileNameDisplay([]);
            renderQueue();
            pumpQueue();
        });

        function showError(message) {
            error.textContent = 'Warning: ' + message;
            error.classList.add('active');
            error.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        // Theme switching functionality (unchanged)
        (function() {
            const html = document.documentElement;
            const themeToggle = document.getElementById('themeToggle');

            function getPreferredTheme() {
                const savedTheme = localStorage.getItem('theme');
                if (savedTheme) {
                    return savedTheme;
                }

                if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                    return 'dark';
                }

                return 'light';
            }

            function setTheme(theme) {
                html.setAttribute('data-theme', theme);
                localStorage.setItem('theme', theme);
            }

            const initialTheme = getPreferredTheme();
            setTheme(initialTheme);

            function spawnCoin(x, y) {
                try {
                    const c = document.createElement('div');
                    c.className = 'coin animate';
                    c.style.left = x + 'px';
                    c.style.top = y + 'px';
                    document.body.appendChild(c);
                    c.addEventListener('animationend', () => c.remove(), { once: true });
                    setTimeout(() => { if (c && c.parentNode) c.remove(); }, 1200);
                } catch (_) {}
            }

            if (themeToggle) {
                themeToggle.addEventListener('click', function(e) {
                    const currentTheme = html.getAttribute('data-theme');
                    let newTheme;
                    if (currentTheme === 'light') {
                        newTheme = 'dark';
                    } else if (currentTheme === 'dark') {
                        newTheme = 'true-dark';
                    } else {
                        newTheme = 'light';
                    }
                    setTheme(newTheme);
                    if (e && e.clientX != null && e.clientY != null) {
                        spawnCoin(e.clientX, e.clientY);
                    }
                });
            }

            if (window.matchMedia) {
                window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
                    if (!localStorage.getItem('theme')) {
                        setTheme(e.matches ? 'dark' : 'light');
                    }
                });
            }
        })();
    </script>
</body>
</html>
    `;
}


module.exports = {
    escapeHtml,
    buildFileTranslationClientConfig,
    buildProviderSummary,
    generateFileTranslationPage
};
