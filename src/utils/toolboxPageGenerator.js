const axios = require('axios');
const { getLanguageName, languageMap } = require('./languages');
const { allLanguages } = require('./allLanguages');
const { deriveVideoHash } = require('./videoHash');
const { parseStremioId } = require('./subtitle');
const { version: appVersion } = require('../../package.json');
const { quickNavStyles, quickNavScript, renderQuickNav, renderRefreshBadge } = require('./quickNav');
const { buildClientBootstrap, loadLocale, getTranslator } = require('./i18n');

function escapeHtml(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function resolveUiLang(config) {
  const lang = (config && config.uiLanguage) ? String(config.uiLanguage).toLowerCase() : 'en';
  return escapeHtml(lang || 'en');
}

/**
 * Safely serialize JavaScript object for embedding in <script> tags
 * Prevents XSS by escaping HTML special characters that could break out of script context
 * Uses double-encoding to ensure JSON.parse() can safely reconstruct the object
 * @param {*} obj - Object to serialize
 * @returns {string} - Safe JavaScript code to parse the object
 */
function safeJsonSerialize(obj) {
  // First JSON.stringify to get JSON string
  const jsonString = JSON.stringify(obj);
  // Second JSON.stringify to escape it for embedding in JavaScript
  // This prevents </script> tag injection and other escaping issues
  const doubleEncoded = JSON.stringify(jsonString);
  return `JSON.parse(${doubleEncoded})`;
}

function buildLanguageLookupMaps() {
  const byCode = {};
  const byNameKey = {};

  Object.entries(languageMap).forEach(([code2, entry]) => {
    if (!entry || !entry.name) return;
    const normCode2 = code2.toLowerCase();
    const compactCode2 = normCode2.replace(/[_-]/g, '');
    [normCode2, compactCode2].forEach(code => {
      if (code && !byCode[code]) byCode[code] = entry.name;
    });

    if (entry.code1) {
      const normCode1 = entry.code1.toLowerCase();
      const compactCode1 = normCode1.replace(/[_-]/g, '');
      [normCode1, compactCode1].forEach(code => {
        if (code && !byCode[code]) byCode[code] = entry.name;
      });
    }

    const nameKey = entry.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (nameKey && !byNameKey[nameKey]) {
      byNameKey[nameKey] = entry.name;
    }
  });

  // Helpful aliases for common display variants from providers/Stremio
  if (byNameKey.spanishlatinamerica) {
    ['spanishla', 'latamspanish', 'spanishlatam'].forEach(key => {
      if (!byNameKey[key]) byNameKey[key] = byNameKey.spanishlatinamerica;
    });
  }
  if (byNameKey.portuguesebrazilian) {
    ['brazilianportuguese', 'portuguesebrazil'].forEach(key => {
      if (!byNameKey[key]) byNameKey[key] = byNameKey.portuguesebrazilian;
    });
  }

  return { byCode, byNameKey };
}

function formatLanguageLabel(code, fallback) {
  if (!code) return fallback || '';
  const normalized = String(code).replace('_', '-');
  const base =
    getLanguageName(normalized) ||
    getLanguageName(normalized.replace('-', '')) ||
    fallback ||
    code;
  const regionMatch = normalized.match(/^[a-z]{2}-([a-z]{2})$/i);
  if (regionMatch) {
    const region = regionMatch[1].toUpperCase();
    const trimmed = base.replace(/\s*\([^)]+\)\s*$/, '').trim();
    return `${trimmed} (${region})`;
  }
  return base;
}

function buildQuery(params) {
  const defined = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null);
  return defined.length === 0 ? '' : `?${defined.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}`;
}

function themeToggleMarkup(label) {
  const aria = escapeHtml(label || 'Toggle theme');
  return `
  <button class="theme-toggle mario" id="themeToggle" aria-label="${aria}">
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
  </button>`;
}

function cleanDisplayName(raw) {
  if (!raw) return '';
  const lastSegment = String(raw).split(/[/\\]/).pop() || '';
  const withoutExt = lastSegment.replace(/\.[^.]+$/, '');
  const spaced = withoutExt.replace(/[_\\.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced || withoutExt || lastSegment;
}

function formatEpisodeTag(parsed) {
  if (!parsed) return '';
  const s = Number.isFinite(parsed.season) ? 'S' + String(parsed.season).padStart(2, '0') : '';
  const e = Number.isFinite(parsed.episode) ? 'E' + String(parsed.episode).padStart(2, '0') : '';
  return (s || e) ? (s + e) : '';
}

async function fetchLinkedTitleServer(videoId) {
  const parsed = parseStremioId(videoId);
  if (!parsed) return null;
  const metaType = parsed.type === 'episode' ? 'series' : 'movie';
  const metaId = (() => {
    const imdbId = parsed.imdbId;
    if (imdbId && /^tt\d{3,}$/i.test(imdbId)) return imdbId.toLowerCase();
    if (parsed.tmdbId) return `tmdb:${parsed.tmdbId}`;
    return null;
  })();
  // Skip lookups for placeholders/unknown IDs to avoid noisy 404s
  if (!metaId) return null;
  const url = `https://v3-cinemeta.strem.io/meta/${metaType}/${encodeURIComponent(metaId)}.json`;
  try {
    const resp = await axios.get(url, { timeout: 3500 });
    const meta = resp.data && resp.data.meta;
    return meta?.name || meta?.english_name || (meta?.nameTranslated && meta.nameTranslated.en) || null;
  } catch (_) {
    return null;
  }
}

function themeToggleStyles() {
  return `
    /* Theme Toggle Button (configure copy) */
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

    .theme-toggle-icon.sun { display: block; }
    .theme-toggle-icon.moon { display: none; }
    .theme-toggle-icon.blackhole { display: none; }
    [data-theme="dark"] .theme-toggle-icon.sun { display: none; }
    [data-theme="dark"] .theme-toggle-icon.moon { display: block; }
    [data-theme="true-dark"] .theme-toggle-icon.sun { display: none; }
    [data-theme="true-dark"] .theme-toggle-icon.moon { display: none; }
    [data-theme="true-dark"] .theme-toggle-icon.blackhole { display: block; }

    /* Mario-style block + coin animation */
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
    .theme-toggle-icon svg {
        display: block;
        filter: drop-shadow(0 2px 0 rgba(0,0,0,0.2));
        pointer-events: none;
        user-select: none;
        -webkit-user-drag: none;
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
  `;
}

function buildToolLinks(configStr, videoId, filename) {
  const shared = { config: configStr, videoId };
  const withFile = { ...shared, filename: filename || '' };

  return {
    translateFiles: `/file-upload${buildQuery(shared)}`,
    syncSubtitles: `/subtitle-sync${buildQuery(withFile)}`,
    embeddedSubs: `/embedded-subtitles${buildQuery(withFile)}`,
    automaticSubs: `/auto-subtitles${buildQuery(withFile)}`,
    subToolbox: `/sub-toolbox${buildQuery(withFile)}`,
    configure: `/configure${buildQuery({ config: configStr })}`
  };
}

// quickNavStyles is imported from ./quickNav

// renderQuickNav is imported from ./quickNav

// quickNavScript is imported from ./quickNav

function formatProviderName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  const map = {
    gemini: 'Gemini',
    deepl: 'DeepL',
    'google-translate': 'Google Translate',
    googletranslate: 'Google Translate',
    google: 'Google',
    openai: 'OpenAI',
    'azure-openai': 'Azure OpenAI',
    azureopenai: 'Azure OpenAI',
    anthropic: 'Anthropic',
    claude: 'Claude',
    groq: 'Groq',
    mistral: 'Mistral',
    together: 'Together',
    xai: 'xAI',
    ollama: 'Ollama',
    localai: 'LocalAI'
  };
  if (map[lower]) return map[lower];
  return raw
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getLanguageSummary(config, translator) {
  try {
    const fallback = translator ? translator('toolbox.summary.notSet', {}, 'Not set yet') : 'Not set yet';
    const sources = (config.sourceLanguages || []).map(getLanguageName).filter(Boolean);
    const targets = (config.targetLanguages || []).map(getLanguageName).filter(Boolean);
    return {
      sources: sources.length ? sources.join(', ') : fallback,
      targets: targets.length ? targets.join(', ') : fallback
    };
  } catch (_) {
    const fallback = translator ? translator('toolbox.summary.notSet', {}, 'Not set yet') : 'Not set yet';
    return { sources: fallback, targets: fallback };
  }
}

function getProviderSummary(config, translator) {
  try {
    const providers = config.providers || {};
    const names = [];
    const seen = new Set();
    const add = (name, enabled) => {
      const norm = String(name || '').trim();
      if (!norm || enabled !== true) return;
      const key = norm.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      names.push(norm);
    };
    if (config.multiProviderEnabled && config.mainProvider) {
      add(formatProviderName(config.mainProvider), providers[config.mainProvider]?.enabled === true);
    }
    if (config.secondaryProviderEnabled && config.secondaryProvider) {
      add(formatProviderName(config.secondaryProvider), providers[config.secondaryProvider]?.enabled === true);
    }
    Object.keys(providers).forEach(key => {
      add(formatProviderName(key), providers[key]?.enabled);
    });
    const geminiConfigured = Boolean(config.geminiModel || config.geminiKey || config.geminiApiKey || providers.gemini);
    const geminiEnabled = providers.gemini ? providers.gemini.enabled !== false : geminiConfigured;
    if (geminiConfigured) add(formatProviderName('Gemini'), geminiEnabled);
    const fallback = translator ? translator('toolbox.summary.notSet', {}, 'Not set yet') : 'Not set yet';
    return names.length ? names.join(', ') : fallback;
  } catch (_) {
    return translator ? translator('toolbox.summary.notSet', {}, 'Not set yet') : 'Not set yet';
  }
}

function generateSubToolboxPage(configStr, videoId, filename, config) {
  const links = buildToolLinks(configStr, videoId, filename);
  const t = getTranslator(config?.uiLanguage || 'en');
  const themeToggleLabel = t('fileUpload.themeToggle', {}, 'Toggle theme');
  const languageSummary = getLanguageSummary(config || {}, t);
  const providerSummary = getProviderSummary(config || {}, t);
  const streamHint = filename ? escapeHtml(filename) : t('toolbox.streamUnknown', {}, 'Stream filename not detected (still works)');
  const videoHash = deriveVideoHash(filename, videoId);
  const devMode = (config || {}).devMode === true;
  const devDisabledClass = devMode ? '' : ' dev-disabled';
  const devOnlyLink = (href) => devMode ? href : '#';
  const languageMaps = buildLanguageLookupMaps();
  const localeBootstrap = buildClientBootstrap(loadLocale(config?.uiLanguage || 'en'));
  const subtitleMenuTargets = (config?.targetLanguages || []).map(code => ({
    code,
    name: getLanguageName(code) || code
  }));

  return `
<!DOCTYPE html>
<html lang="${resolveUiLang(config)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t('toolbox.documentTitle', {}, 'Sub Toolbox - SubMaker')}</title>
  ${localeBootstrap}
  <link rel="icon" type="image/svg+xml" href="/favicon-toolbox.svg">
  <link rel="shortcut icon" href="/favicon-toolbox.svg">
  <link rel="apple-touch-icon" href="/favicon-toolbox.svg">
  <script src="/js/sw-register.js" defer></script>
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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;600;700&family=Space+Grotesk:wght@600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; }
    html { color-scheme: light; }
    [data-theme="dark"] { color-scheme: dark; }
    [data-theme="true-dark"] { color-scheme: dark; }
    /* Removed forced color-scheme override - let theme cascade handle it naturally */
    :root {
      --primary: #08A4D5;
      --primary-2: #33B9E1;
      --secondary: #33B9E1;
      --accent: #0ea5e9;
      --surface: #ffffff;
      --surface-2: #f4f7fc;
      --surface-hover: #ffffff;
      --bg: #f5f8fd;
      --bg-strong: #e9eef7;
      --text: #0f172a;
      --muted: #475569;
      --border: #dbe3ea;
      --shadow: 0 14px 40px rgba(12, 19, 56, 0.12);
      --glow: rgba(8, 164, 213, 0.25);
      --theme-toggle-size: 48px;
    }
    [data-theme="dark"] {
      --surface: #141931;
      --surface-2: #1e2539;
      --surface-hover: #252f49;
      --bg: #0A0E27;
      --bg-strong: #141931;
      --text: #E8EAED;
      --text-primary: #E8EAED;
      --text-secondary: #9AA0A6;
      --muted: #9AA0A6;
      --border: #2A3247;
      --shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
      --glow: rgba(8, 164, 213, 0.35);
    }
    [data-theme="true-dark"] {
      --surface: #0a0a0a;
      --surface-2: #151515;
      --surface-hover: #1e1e1e;
      --bg: #000000;
      --bg-strong: #0a0a0a;
      --text: #E8EAED;
      --text-primary: #E8EAED;
      --text-secondary: #8A8A8A;
      --muted: #8A8A8A;
      --border: #1a1a1a;
      --shadow: 0 20px 56px rgba(0, 0, 0, 0.8);
      --glow: rgba(8, 164, 213, 0.45);
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: linear-gradient(135deg, var(--bg) 0%, var(--bg-strong) 55%, var(--bg) 100%);
      color: var(--text);
      font-family: 'Inter', -apple-system, 'Segoe UI', sans-serif;
      padding: 32px 20px 52px;
    }
    a { color: inherit; }
    .page {
      max-width: 1180px;
      margin: 0 auto;
      /* Don't reserve a full row for the floating theme toggle */
      padding-top: 0;
    }
    .masthead {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .brand-logo {
      width: 64px;
      height: 64px;
      border-radius: 18px;
      background: var(--surface);
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
      object-fit: contain;
      padding: 8px;
    }
    .brand h1 {
      margin: 0;
      font-size: 28px;
      letter-spacing: -0.02em;
    }
    .brand .subtitle {
      margin-top: 4px;
      color: var(--muted);
      font-size: 15px;
      font-weight: 600;
    }
    .refresh-badge {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0;
      padding: 0;
      width: 52px;
      height: 52px;
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: radial-gradient(140% 140% at 18% 18%, rgba(8, 164, 213, 0.26), transparent 46%), linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
      color: #0b2336;
      font-weight: 800;
      cursor: pointer;
      transition: transform 0.16s ease, box-shadow 0.2s ease, border-color 0.2s ease;
      box-shadow: 0 14px 30px rgba(8, 164, 213, 0.22), 0 8px 20px var(--shadow);
      overflow: hidden;
      isolation: isolate;
    }
    .refresh-badge::before {
      content: '';
      position: absolute;
      inset: -42%;
      background: conic-gradient(from 120deg, rgba(255,255,255,0.26), rgba(255,255,255,0), rgba(255,255,255,0.26), rgba(255,255,255,0));
      opacity: 0.8;
      animation: spin 10s linear infinite;
      z-index: 0;
    }
    .refresh-badge::after {
      content: '';
      position: absolute;
      inset: 7px;
      border-radius: 10px;
      background: radial-gradient(circle at 26% 22%, rgba(255,255,255,0.25), rgba(255,255,255,0.05));
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.12), inset 0 -6px 14px rgba(0, 0, 0, 0.2);
      z-index: 0;
    }
    .refresh-badge:hover {
      transform: translateY(-2px) scale(1.02);
      border-color: transparent;
      box-shadow: 0 18px 34px var(--glow);
    }
    .refresh-badge:active { transform: translateY(0); }
    .refresh-badge .refresh-icon {
      position: relative;
      z-index: 1;
      width: 26px;
      height: 26px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 11px;
      background: radial-gradient(130% 130% at 25% 22%, rgba(255,255,255,0.55), transparent 45%), linear-gradient(135deg, #ffffff 0%, #d9ecff 100%);
      color: #0b2840;
      font-size: 17px;
      font-weight: 900;
      box-shadow: inset 0 -3px 8px rgba(0, 0, 0, 0.2), 0 8px 14px rgba(0, 0, 0, 0.16);
      text-shadow: 0 1px 0 rgba(255,255,255,0.4);
      letter-spacing: -0.04em;
    }
    .refresh-badge .refresh-label {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .refresh-badge.spinning .refresh-icon { animation: spin 0.7s linear infinite; }
    .status-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: stretch;
    }
    .status-badge {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 14px;
      background: radial-gradient(140% 140% at 18% 24%, rgba(8, 164, 213, 0.16), transparent 42%), linear-gradient(135deg, rgba(255,255,255,0.06), rgba(12,18,40,0.02));
      border: 1px solid rgba(8, 164, 213, 0.28);
      box-shadow: 0 14px 34px rgba(8, 164, 213, 0.14), inset 0 0 0 1px rgba(255, 255, 255, 0.05);
      min-width: 0;
      overflow: hidden;
      isolation: isolate;
    }
    .status-badge::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: linear-gradient(120deg, rgba(8, 164, 213, 0.32), rgba(255,255,255,0.08), rgba(51, 185, 225, 0.2));
      opacity: 0;
      transition: opacity 0.25s ease;
      pointer-events: none;
      mix-blend-mode: screen;
    }
    .status-badge:hover::after { opacity: 1; }
    .status-badge.accent {
      background: linear-gradient(135deg, rgba(8, 164, 213, 0.42), rgba(51, 185, 225, 0.28));
      border-color: rgba(255, 255, 255, 0.16);
      color: #04101a;
      box-shadow: 0 16px 40px rgba(8, 164, 213, 0.28), inset 0 0 0 1px rgba(255, 255, 255, 0.08);
    }
    .status-badge .labels {
      display: flex;
      flex-direction: column;
      gap: 2px;
      line-height: 1.15;
    }
    .status-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .status-badge.accent .status-label { color: #032132; }
    .status-value {
      font-family: 'Space Grotesk', 'Inter', -apple-system, 'Segoe UI', sans-serif;
      font-weight: 700;
      font-size: 15px;
      letter-spacing: 0.02em;
      color: var(--text);
    }
    .status-badge.accent .status-value { color: #032132; }
    .status-badge .ext-link {
      font-weight: 700;
      font-size: 15px;
      color: var(--primary);
      text-decoration: underline;
    }
    .status-badge .ext-link.ready {
      color: var(--text);
      text-decoration: none;
      pointer-events: none;
      cursor: default;
      font-weight: 800;
    }
    .status-dot {
      width: 12px;
      height: 12px;
      border-radius: 5px;
      background: linear-gradient(135deg, #3df7ff, #08a4d5);
      box-shadow: 0 0 0 5px rgba(8, 164, 213, 0.16), 0 4px 14px rgba(8, 164, 213, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.28);
    }
    .status-dot.ok { background: linear-gradient(135deg, #4ade80, #22c55e); }
    .status-dot.warn { background: linear-gradient(135deg, #fbbf24, #f59e0b); }
    .status-dot.bad { background: linear-gradient(135deg, #f43f5e, #dc2626); }
    .status-dot.pulse { animation: pulse 1.15s ease-in-out infinite; }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(8, 164, 213, 0.22); }
      70% { box-shadow: 0 0 0 10px rgba(8, 164, 213, 0); }
      100% { box-shadow: 0 0 0 0 rgba(8, 164, 213, 0); }
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 18px;
      box-shadow: var(--shadow);
      padding: 20px;
    }
    .hero {
      margin-top: 22px;
      display: grid;
      grid-template-columns: 1.15fr 1fr;
      gap: 18px;
      align-items: stretch;
      background: linear-gradient(135deg, rgba(8,164,213,0.08), rgba(51,185,225,0.05)), var(--surface);
    }
    .hero-content {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      gap: 12px;
      padding: 0 18px;
      min-width: 0; /* prevent long stream names from forcing the grid column to grow */
    }
    .eyebrow {
      text-transform: uppercase;
      letter-spacing: 0.16em;
      font-size: 12px;
      color: var(--muted);
      font-weight: 700;
    }
    .hero h2 {
      margin: 6px 0 10px;
      font-size: 26px;
      letter-spacing: -0.01em;
    }
    .hero p {
      margin: 0 0 12px;
      color: var(--muted);
      line-height: 1.6;
    }
    .chip-row {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
      margin: 14px 0 10px;
      width: 100%;
      text-align: left;
    }
    .chip {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 8px;
      padding: 10px 12px;
      border-radius: 10px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      font-weight: 700;
      color: var(--text);
      width: 100%;
    }
    .chip span {
      color: var(--muted);
      font-weight: 600;
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .cta-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: center;
      margin-top: 8px;
    }
    .button {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      padding: 12px 18px;
      border-radius: 12px;
      border: 1px solid rgba(8, 164, 213, 0.4);
      background: linear-gradient(120deg, rgba(8, 164, 213, 0.16), rgba(51, 185, 225, 0.08));
      color: var(--text);
      font-family: 'Space Grotesk', 'Inter', -apple-system, 'Segoe UI', sans-serif;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-decoration: none;
      text-transform: uppercase;
      box-shadow: 0 12px 32px rgba(8, 164, 213, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.06);
      transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease, background 0.16s ease;
    }
    .button.primary {
      background: linear-gradient(120deg, #5af0ff, #33b9e1 60%, #0ea5e9);
      color: #04101a;
      border-color: rgba(255, 255, 255, 0.24);
      box-shadow: 0 14px 40px rgba(8, 164, 213, 0.32);
    }
    .button.ghost {
      background: linear-gradient(120deg, rgba(255,255,255,0.02), rgba(8, 164, 213, 0.08));
      color: var(--text);
      border-color: rgba(8, 164, 213, 0.3);
    }
    .button:hover {
      transform: translateY(-3px) scale(1.01);
      box-shadow: 0 18px 48px rgba(8, 164, 213, 0.26);
      border-color: rgba(8, 164, 213, 0.55);
    }
    .tool-stack {
      background: linear-gradient(135deg, rgba(255,255,255,0.02), rgba(8, 164, 213, 0.06)), var(--surface);
      border: 1px solid rgba(8, 164, 213, 0.24);
      border-radius: 14px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      box-shadow: 0 18px 44px rgba(8, 164, 213, 0.18);
    }
    .tool-stack header {
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
    }
    .tool-tiles {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
      gap: 12px;
      justify-items: center;
    }
    .tool-tile {
      position: relative;
      text-decoration: none;
      background: linear-gradient(135deg, rgba(255,255,255,0.02), rgba(8, 164, 213, 0.08));
      border: 1px solid rgba(8, 164, 213, 0.24);
      border-radius: 14px;
      padding: 14px;
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 12px;
      align-items: center;
      transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
      width: 100%;
      overflow: hidden;
      isolation: isolate;
    }
    .tool-tile::before {
      content: '';
      position: absolute;
      inset: -1px;
      border-radius: inherit;
      background: linear-gradient(115deg, rgba(8, 164, 213, 0.3), rgba(255,255,255,0.06), rgba(51,185,225,0.22));
      opacity: 0;
      transition: opacity 0.25s ease;
      pointer-events: none;
      mix-blend-mode: screen;
    }
    .tool-tile:hover {
      transform: translateY(-3px);
      border-color: rgba(8, 164, 213, 0.48);
      box-shadow: 0 18px 48px rgba(8, 164, 213, 0.2);
      background: linear-gradient(135deg, rgba(255,255,255,0.03), rgba(8, 164, 213, 0.12));
    }
    .tool-tile:hover::before { opacity: 1; }
    .tool-icon {
      width: 46px;
      height: 46px;
      border-radius: 12px;
      background: radial-gradient(120% 120% at 20% 24%, rgba(255,255,255,0.22), rgba(255,255,255,0)), linear-gradient(135deg, #5af0ff, #33b9e1);
      display: grid;
      place-items: center;
      font-size: 18px;
      color: #031018;
      font-weight: 800;
      box-shadow: 0 12px 30px rgba(8, 164, 213, 0.28), inset 0 1px 0 rgba(255,255,255,0.18);
      border: 1px solid rgba(255, 255, 255, 0.24);
    }
    .tool-title {
      margin: 0;
      font-weight: 700;
      color: var(--text);
      letter-spacing: -0.01em;
      font-family: 'Space Grotesk', 'Inter', -apple-system, 'Segoe UI', sans-serif;
    }
    .tool-tile p {
      margin: 6px 0 8px;
      color: var(--muted);
      line-height: 1.5;
      font-size: 13px;
    }
    .tool-link {
      color: var(--primary);
      font-weight: 700;
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .tool-tile.dev-disabled {
      opacity: 0.35;
      pointer-events: none;
      cursor: not-allowed;
      filter: grayscale(0.8);
    }
    .tool-tile.dev-disabled:hover {
      transform: none;
      border-color: rgba(8, 164, 213, 0.24);
      box-shadow: none;
      background: linear-gradient(135deg, rgba(255,255,255,0.02), rgba(8, 164, 213, 0.08));
    }
    .tool-tile.dev-disabled:hover::before {
      opacity: 0;
    }
    .info-grid {
      margin-top: 18px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
    }
    .info-card h3 {
      margin: 0 0 6px;
      font-size: 18px;
      letter-spacing: -0.01em;
    }
    .info-card p {
      margin: 0 0 10px;
      color: var(--muted);
      line-height: 1.55;
      font-size: 14px;
    }
    .inline-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .inline-actions .button {
      padding: 10px 12px;
      font-size: 14px;
      box-shadow: none;
    }
    .footnote {
      margin-top: 18px;
      text-align: center;
      color: var(--muted);
      font-size: 13px;
    }
    @media (max-width: 980px) {
      .masthead {
        justify-content: center;
        text-align: center;
      }
      .masthead .brand {
        justify-content: center;
        width: 100%;
      }
      .masthead .brand > div { text-align: center; }
      .status-badges {
        justify-content: center;
        width: 100%;
      }
      .status-badge { justify-content: center; }
    }
    @media (max-width: 900px) {
      .hero {
        grid-template-columns: 1fr;
      }
      .masthead {
        align-items: flex-start;
      }
    }

  ${themeToggleStyles()}

    .episode-toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      width: min(360px, calc(100% - 32px));
      padding: 14px 16px;
      border-radius: 12px;
      background: var(--surface);
      border: 1px solid var(--border);
      box-shadow: 0 14px 38px var(--shadow-color, rgba(0,0,0,0.18));
      display: flex;
      align-items: flex-start;
      gap: 12px;
      z-index: 12000;
      transform: translateY(16px);
      opacity: 0;
      pointer-events: none;
      transition: all 0.25s ease;
    }
    .episode-toast.show {
      transform: translateY(0);
      opacity: 1;
      pointer-events: auto;
    }
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
    .episode-toast .content {
      flex: 1;
      min-width: 0;
    }
    .episode-toast .title {
      margin: 0 0 4px;
      font-weight: 700;
      color: var(--text-primary, var(--text));
    }
    .episode-toast .meta {
      margin: 0;
      color: var(--muted);
      font-size: 0.9rem;
      word-break: break-word;
    }
    .episode-toast .close {
      background: none;
      border: none;
      color: var(--muted);
      font-weight: 800;
      cursor: pointer;
      padding: 4px;
      line-height: 1;
      border-radius: 6px;
      transition: color 0.2s ease, background 0.2s ease;
    }
    .episode-toast .close:hover {
      color: var(--text);
      background: var(--surface-2);
    }
    .episode-toast button {
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
    .episode-toast button:hover {
      transform: translateY(-1px);
      box-shadow: 0 12px 24px var(--glow);
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    @media (max-width: 768px) {
      :root { --theme-toggle-size: 42px; }
      .theme-toggle {
        top: 1rem;
        right: 1rem;
      }
    }
  </style>
  <script src="/js/theme-toggle.js" defer></script>
</head>
<body>
  <!-- Theme Toggle Button -->
  ${themeToggleMarkup(themeToggleLabel)}

  <div id="episodeToast" class="episode-toast" role="status" aria-live="polite">
    <div class="icon">!</div>
    <div class="content">
      <p class="title" id="episodeToastTitle">${t('toolbox.toast.title', {}, 'New stream detected')}</p>
      <p class="meta" id="episodeToastMeta">${t('toolbox.toast.meta', {}, 'A different episode is playing in Stremio.')}</p>
    </div>
    <button class="close" id="episodeToastDismiss" type="button" aria-label="${t('toolbox.toast.dismiss', {}, 'Dismiss notification')}">×</button>
    <button class="action" id="episodeToastUpdate" type="button">${t('toolbox.toast.update', {}, 'Update')}</button>
  </div>

  <div class="page">
    <header class="masthead">
      <div class="brand">
        <img class="brand-logo" src="/logo.png" alt="SubMaker logo">
        <div>
          <h1>${t('toolbox.header.title', {}, 'SubMaker Toolbox')}</h1>
          <div class="subtitle">${t('toolbox.header.linked', { id: escapeHtml(videoId || '') }, `Linked to ${escapeHtml(videoId)}`)}</div>
        </div>
      </div>
      <div class="status-badges">
        <button class="refresh-badge" id="refreshStreamBtn" type="button" title="${t('toolbox.refresh.title', {}, 'Jump to your latest stream')}">
          <span class="refresh-icon">⟳</span>
          <span class="refresh-label">${t('toolbox.refresh.label', {}, 'Refresh stream')}</span>
        </button>
        <div class="status-badge accent">
          <span class="status-dot ok pulse"></span>
          <div class="labels">
            <span class="status-label">${t('toolbox.status.session', {}, 'Session')}</span>
            <span class="status-value">${t('toolbox.status.ready', {}, 'Ready')}</span>
          </div>
        </div>
        <div class="status-badge">
          <span class="status-dot ok"></span>
          <div class="labels">
            <span class="status-label">${t('toolbox.status.addon', {}, 'Addon')}</span>
            <span class="status-value">v${escapeHtml(appVersion || 'n/a')}</span>
          </div>
        </div>
        <div class="status-badge" id="ext-badge">
          <span class="status-dot warn pulse" id="ext-dot"></span>
          <div class="labels">
            <span class="status-label">${t('toolbox.status.extension', {}, 'Extension')}</span>
            <a class="status-value ext-link" id="ext-value" href="https://chromewebstore.google.com/detail/submaker-xsync/lpocanpndchjkkpgchefobjionncknjn" target="_blank" rel="noopener noreferrer">${t('toolbox.status.checking', {}, 'Checking...')}</a>
          </div>
        </div>
        <div class="status-badge">
          <span class="status-dot ok"></span>
          <div class="labels">
            <span class="status-label">${t('toolbox.status.localTime', {}, 'Local time')}</span>
            <span class="status-value" id="time-value">--:--</span>
          </div>
        </div>
      </div>
    </header>

    <section class="hero card">
      <div class="hero-content">
        <div class="eyebrow">${t('toolbox.hero.eyebrow', {}, 'Sub Toolbox')}</div>
        <h2>${t('toolbox.hero.title', {}, 'Pick a tool without leaving your stream')}</h2>
        <p>${t('toolbox.hero.body', {}, `Use the Sub Toolbox button in Stremio's subtitle list. Your saved API keys, target languages, and cache come with you automatically.`)}</p>
        <div class="chip-row">
          <div class="chip">${t('toolbox.chips.sources', {}, 'Sources')} <span>${escapeHtml(languageSummary.sources)}</span></div>
          <div class="chip">${t('toolbox.chips.targets', {}, 'Targets')} <span>${escapeHtml(languageSummary.targets)}</span></div>
          <div class="chip">${t('toolbox.chips.providers', {}, 'Providers')} <span>${escapeHtml(providerSummary)}</span></div>
          <div class="chip">${t('toolbox.chips.stream', {}, 'Stream')} <span>${streamHint}</span></div>
        </div>
        <div class="cta-row">
          <a class="button primary" href="${links.translateFiles}">${t('toolbox.hero.primary', {}, 'Translate a file')}</a>
          <a class="button ghost" href="${links.configure}">${t('toolbox.hero.secondary', {}, 'Adjust configs')}</a>
        </div>
      </div>

      <div class="tool-stack">
        <header>
          <div class="eyebrow">${t('toolbox.tools.eyebrow', {}, 'Tool shelf')}</div>
        </header>
        <div class="tool-tiles">
          <a class="tool-tile" href="${links.translateFiles}">
            <div class="tool-icon">⚡</div>
            <div>
              <div class="tool-title">${t('toolbox.tools.translate.title', {}, 'Translate SRT files')}</div>
              <p>${t('toolbox.tools.translate.body', {}, 'Upload .srt/.vtt/.ass files and keep cache + language preferences intact.')}</p>
              <span class="tool-link">${t('toolbox.tools.translate.cta', {}, 'Translate a file')}</span>
            </div>
          </a>
          <a class="tool-tile" href="${links.embeddedSubs}">
            <div class="tool-icon">🧲</div>
            <div>
              <div class="tool-title">${t('toolbox.tools.embedded.title', {}, 'Extract + Translate')}</div>
              <p>${t('toolbox.tools.embedded.body', {}, 'Extract embedded subtitles from the current stream or file, then translate with your provider.')}</p>
              <span class="tool-link">${t('toolbox.tools.embedded.cta', {}, 'Open extractor')}</span>
            </div>
          </a>
          <a class="tool-tile${devDisabledClass}" href="${devOnlyLink(links.syncSubtitles)}">
            <div class="tool-icon">⏱️</div>
            <div>
              <div class="tool-title">${t('toolbox.tools.sync.title', {}, 'Sync subtitles')}</div>
              <p>${t('toolbox.tools.sync.body', {}, 'Fix timing drifts with offsets or the Chrome extension and save back to your session.')}</p>
              <span class="tool-link">${t('toolbox.tools.sync.cta', {}, 'Open sync studio')}</span>
            </div>
          </a>
          <a class="tool-tile${devDisabledClass}" href="${devOnlyLink(links.automaticSubs)}">
            <div class="tool-icon">🤖</div>
            <div>
              <div class="tool-title">${t('toolbox.tools.auto.title', {}, 'Automatic subtitles')}</div>
              <p>${t('toolbox.tools.auto.body', {}, 'Create subs when none exist. Uses your target language and provider settings.')}</p>
              <span class="tool-link">${t('toolbox.tools.auto.cta', {}, 'Generate subs')}</span>
            </div>
          </a>
        </div>
      </div>
    </section>

    <div class="footnote">
      ${t('toolbox.footnote', {}, 'Toolbox is tied to your current session and stream. Keep this tab open while streaming for the smoothest handoff.')}
    </div>

  </div>
  <script src="/js/subtitle-menu.js?v=${escapeHtml(appVersion || 'dev')}"></script>
  <script>
    const TOOLBOX = ${safeJsonSerialize({
    configStr,
    videoId,
    filename: filename || '',
    videoHash
  })};
    const SUBTITLE_MENU_TARGETS = ${JSON.stringify(subtitleMenuTargets)};
    const SUBTITLE_MENU_SOURCES = ${JSON.stringify(config.sourceLanguages || [])};
    const SUBTITLE_MENU_TARGET_CODES = ${JSON.stringify(config.targetLanguages || [])};
    const SUBTITLE_LANGUAGE_MAPS = ${safeJsonSerialize(languageMaps)};
    let subtitleMenuInstance = null;

    function initStreamRefreshButton(opts) {
      const btn = document.getElementById(opts.buttonId);
      if (!btn || !opts.configStr || typeof fetch === 'undefined') return;
      const labelEl = btn.querySelector('.refresh-label');
      const iconEl = btn.querySelector('.refresh-icon');
      const defaultLabel = labelEl ? labelEl.textContent : 'Refresh';
      const currentSig = (() => {
        const payload = opts.current || {};
        return [payload.videoHash || '', payload.videoId || '', payload.filename || ''].join('::');
      })();
      let busy = false;

      const setLabel = (text) => { if (labelEl) labelEl.textContent = text; };
      const setBusy = (state) => {
        busy = state;
        btn.disabled = state;
        btn.classList.toggle('spinning', !!state);
      };

      btn.addEventListener('click', async () => {
        if (busy) return;
        setBusy(true);
        setLabel(opts.labels?.loading || 'Refreshing...');
        try {
          const resp = await fetch('/api/stream-activity?config=' + encodeURIComponent(opts.configStr), { cache: 'no-store' });
          if (resp.status === 204) {
            setLabel(opts.labels?.empty || 'No recent stream');
            return;
          }
          if (!resp.ok) throw new Error('Bad response');
          const data = await resp.json();
          const payloadSig = [data.videoHash || '', data.videoId || '', data.filename || ''].join('::');
          if (!data || !data.videoId || !payloadSig.trim()) {
            setLabel(opts.labels?.empty || 'No recent stream');
            return;
          }
          if (payloadSig === currentSig) {
            setLabel(opts.labels?.current || 'Already current');
            setTimeout(() => setLabel(defaultLabel), 1200);
            return;
          }
          const targetUrl = opts.buildUrl ? opts.buildUrl(data) : null;
          if (targetUrl) {
            btn.classList.add('success');
            window.location.href = targetUrl;
            return;
          }
          setLabel(opts.labels?.error || 'Missing stream data');
        } catch (_) {
          setLabel(opts.labels?.error || 'Refresh failed');
        } finally {
          setTimeout(() => setLabel(defaultLabel), 1400);
          setBusy(false);
        }
      });
    }

    initStreamRefreshButton({
      buttonId: 'refreshStreamBtn',
      configStr: TOOLBOX.configStr,
      current: { videoId: TOOLBOX.videoId, filename: TOOLBOX.filename, videoHash: TOOLBOX.videoHash },
      labels: {
        loading: window.t ? window.t('toolbox.refresh.loading', {}, 'Refreshing...') : 'Refreshing...',
        empty: window.t ? window.t('toolbox.refresh.empty', {}, 'No stream yet') : 'No stream yet',
        error: window.t ? window.t('toolbox.refresh.error', {}, 'Refresh failed') : 'Refresh failed',
        current: window.t ? window.t('toolbox.refresh.current', {}, 'Already latest') : 'Already latest'
      },
      buildUrl: (payload) => {
        return '/sub-toolbox?config=' + encodeURIComponent(TOOLBOX.configStr) +
          '&videoId=' + encodeURIComponent(payload.videoId || '') +
          '&filename=' + encodeURIComponent(payload.filename || '');
      }
    });

    function mountSubtitleMenu() {
      if (!window.SubtitleMenu || typeof window.SubtitleMenu.mount !== 'function') return null;
      try {
        return window.SubtitleMenu.mount({
          configStr: TOOLBOX.configStr,
          videoId: TOOLBOX.videoId,
          filename: TOOLBOX.filename,
          videoHash: TOOLBOX.videoHash,
          targetOptions: SUBTITLE_MENU_TARGETS,
          sourceLanguages: SUBTITLE_MENU_SOURCES,
          targetLanguages: SUBTITLE_MENU_TARGET_CODES,
          languageMaps: SUBTITLE_LANGUAGE_MAPS,
          getVideoHash: () => TOOLBOX.videoHash || '',
          version: '${appVersion}'
        });
      } catch (err) {
        console.warn('Subtitle menu init failed', err);
        return null;
      }
    }
    subtitleMenuInstance = mountSubtitleMenu();
    if (subtitleMenuInstance && typeof subtitleMenuInstance.prefetch === 'function') {
      subtitleMenuInstance.prefetch();
    }

    (function initHeaderBadges() {
      const timeEl = document.getElementById('time-value');
      const extValue = document.getElementById('ext-value');
      const extDot = document.getElementById('ext-dot');
      let extReady = false;
      let pingTimer = null;
      let pingAttempts = 0;
      const MAX_PINGS = 5;
      const EXT_INSTALL_URL = 'https://chromewebstore.google.com/detail/submaker-xsync/lpocanpndchjkkpgchefobjionncknjn';
      function updateTime() {
        const now = new Date();
        timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      function setExtensionStatus(ready, text, tone) {
        extReady = !!ready;
        const toneClass = ready ? 'ok' : (tone || 'bad');
        extDot.className = 'status-dot ' + toneClass;
        if (extValue) {
          extValue.textContent = text;
          if (ready) {
            extValue.classList.add('ready');
            extValue.removeAttribute('href');
            extValue.removeAttribute('target');
            extValue.removeAttribute('rel');
          } else {
            extValue.classList.remove('ready');
            extValue.setAttribute('href', EXT_INSTALL_URL);
            extValue.setAttribute('target', '_blank');
            extValue.setAttribute('rel', 'noopener noreferrer');
          }
        }
      }
      function pingExtension() {
        const label = window.t ? window.t('toolbox.status.pinging', {}, 'Pinging extension...') : 'Pinging extension...';
        setExtensionStatus(false, label, 'warn');
        if (pingTimer) clearInterval(pingTimer);
        pingAttempts = 0;
        const sendPing = () => {
          if (extReady) return;
          pingAttempts += 1;
          window.postMessage({ type: 'SUBMAKER_PING', source: 'webpage' }, '*');
          if (pingAttempts >= MAX_PINGS && !extReady) {
            clearInterval(pingTimer);
            const notDetected = window.t ? window.t('toolbox.status.notDetected', {}, 'Not detected') : 'Not detected';
            setExtensionStatus(false, notDetected, 'bad');
          }
        };
        sendPing();
        pingTimer = setInterval(sendPing, 5000);
      }
      window.addEventListener('message', event => {
        const msg = event.data;
        if (!msg || msg.type !== 'SUBMAKER_PONG') return;
        if (msg.source && msg.source !== 'extension') return;
        const detected = window.t ? window.t('toolbox.status.detected', {}, 'Detected') : 'Detected';
        const version = msg.version ? 'v' + msg.version : detected;
        setExtensionStatus(true, version);
        if (pingTimer) clearInterval(pingTimer);
      });
      updateTime();
      setInterval(updateTime, 60000);
      setTimeout(pingExtension, 150);
    })();

    // Theme switching functionality
    // theme-toggle.js already wires the button + persists preference; avoid double-binding here
  </script>
</body>
</html>
`;
}

async function generateEmbeddedSubtitlePage(configStr, videoId, filename) {
  const links = buildToolLinks(configStr, videoId, filename);
  const videoHash = deriveVideoHash(filename, videoId);
  const parsedVideo = parseStremioId(videoId);
  const episodeTag = formatEpisodeTag(parsedVideo);
  const linkedTitle = await fetchLinkedTitleServer(videoId);
  const config = arguments[3] || {};
  const targetLanguages = (Array.isArray(config.targetLanguages) ? config.targetLanguages : [])
    .map(code => ({ code, name: getLanguageName(code) || code }));
  const sourceLanguages = Array.isArray(config.sourceLanguages) ? config.sourceLanguages : [];
  const targetLanguageCodes = Array.isArray(config.targetLanguages) ? config.targetLanguages : [];
  const languageMaps = buildLanguageLookupMaps();
  const devMode = config.devMode === true;
  const localeBootstrap = buildClientBootstrap(loadLocale(config?.uiLanguage || 'en'));
  const t = getTranslator(config?.uiLanguage || 'en');
  const themeToggleLabel = t('fileUpload.themeToggle', {}, 'Toggle theme');
  const copy = {
    meta: {
      documentTitle: t('toolbox.embedded.meta.documentTitle', {}, 'Translate Embedded Subtitles - SubMaker'),
      pageHeading: t('toolbox.embedded.meta.pageHeading', {}, 'Embedded Subtitles Studio'),
      pageSubtitle: t('toolbox.embedded.meta.pageSubtitle', {}, 'Extract embedded tracks from your current stream and translate them instantly.')
    },
    instructions: {
      title: t('toolbox.embedded.instructions.title', {}, 'Embedded Subtitles Instructions'),
      help: t('toolbox.embedded.instructions.help', {}, 'Show instructions'),
      close: t('toolbox.embedded.instructions.close', {}, 'Close instructions'),
      extractionTitle: t('toolbox.embedded.instructions.extractionTitle', {}, 'Subtitles Extraction:'),
      extractionSteps: [
        t('toolbox.embedded.instructions.extractionSteps.1', {}, 'Make sure the xSync extension is installed and detected.'),
        t('toolbox.embedded.instructions.extractionSteps.2', {}, 'Make sure the linked stream is the movie/episode you want to extract/translate.'),
        t('toolbox.embedded.instructions.extractionSteps.3', {}, 'Right-click Stremio\'s stream and click "Copy stream link".'),
        t('toolbox.embedded.instructions.extractionSteps.4', {}, 'Paste the stream URL in the corresponding box.'),
        t('toolbox.embedded.instructions.extractionSteps.5', {}, 'Use "Complete" for MKV streams (non-MKV links auto-switch to Smart).'),
        t('toolbox.embedded.instructions.extractionSteps.6', {}, 'Click "Extract Subtitles"')
      ],
      translationTitle: t('toolbox.embedded.instructions.translationTitle', {}, 'Translating Extracted Subtitles:'),
      translationSteps: [
        t('toolbox.embedded.instructions.translationSteps.1', {}, 'Verify and select the desired subtitles.'),
        t('toolbox.embedded.instructions.translationSteps.2', {}, 'Select target language.'),
        t('toolbox.embedded.instructions.translationSteps.3', {}, 'Select translation settings and translation provider.'),
        t('toolbox.embedded.instructions.translationSteps.4', {}, 'Click "Translate Subtitles".')
      ],
      download: t('toolbox.embedded.instructions.download', {}, 'You can download both extracted or translated subtitles as SRT.'),
      upload: t('toolbox.embedded.instructions.upload', {}, 'Translated subtitles are automatically uploaded to the database, matching the video hash, under the "xEmbed (Language)" entry (reload the stream on Stremio to see it).'),
      retry: t('toolbox.embedded.instructions.retry', {}, 'If translation/sync problems happen, simply retranslate the subtitle to overwrite the xEmbed database cache.'),
      originals: t('toolbox.embedded.instructions.originals', {}, 'Extracted subtitles are saved to xEmbed as originals and show up under their source language (no separate label).'),
      ocrNote: t('toolbox.embedded.instructions.ocrNote', {}, "Currently doesn't work with image-based subtitles - OCR may be implemented."),
      dontShow: t('toolbox.embedded.instructions.dontShow', {}, "Don't show this again"),
      gotIt: t('toolbox.embedded.instructions.gotIt', {}, 'Got it')
    },
    hero: {
      notice: t(
        'toolbox.embedded.hero.notice',
        {},
        'Do not use this tool at the same time you stream through an AIOStreams <strong>PROXY</strong> for Real-Debrid.'
      )
    },
    videoMeta: {
      label: t('toolbox.embedded.videoMeta.label', {}, 'Linked stream'),
      none: t('toolbox.embedded.videoMeta.none', {}, 'No stream linked'),
      unavailable: t('toolbox.embedded.videoMeta.unavailable', {}, 'Video ID unavailable'),
      waiting: t('toolbox.embedded.videoMeta.waiting', {}, 'Waiting for a linked stream...')
    },
    step1: {
      chip: t('toolbox.embedded.step1.chip', {}, 'Step 1'),
      title: t('toolbox.embedded.step1.title', {}, 'Provide Stream Information'),
      helper: t('toolbox.embedded.step1.helper', {}, ''),
      streamLabel: t('toolbox.embedded.step1.streamLabel', {}, 'Stream URL:'),
      streamPlaceholder: t('toolbox.embedded.step1.streamPlaceholder', {}, 'Paste the video/stream URL from Stremio or your browser'),
      modeLabel: t('toolbox.embedded.step1.modeLabel', {}, 'Mode'),
      modeSmart: t('toolbox.embedded.step1.modeSmart', {}, 'Smart (fast)'),
      modeComplete: t('toolbox.embedded.step1.modeComplete', {}, 'Complete (full file)'),
      modeHelper: t('toolbox.embedded.step1.modeHelper', {}, 'In Complete mode, the whole file will be fetched for extraction.\nComplete mode is needed for MKV files.'),
      extractButton: t('toolbox.embedded.step1.extractButton', {}, 'Extract Subtitles'),
      extractBlocked: t('toolbox.embedded.step1.extractBlocked', {}, ''),
      hashMismatchInline: t(
        'toolbox.embedded.step1.hashMismatchInline',
        {},
        'Hashes do not match. Extraction stays blocked until the pasted URL matches your linked stream.'
      ),
      hashMismatchLine1: t('toolbox.embedded.step1.hashMismatchLine1', {}, 'Hashes must match before extraction can start.'),
      hashMismatchLine2: t(
        'toolbox.embedded.step1.hashMismatchLine2',
        {},
        ''
      ),
      logHeader: t('toolbox.embedded.step1.logHeader', {}, 'Live log'),
      logSub: t('toolbox.embedded.step1.logSub', {}, 'Auto-filled while extraction runs.'),
      outputsEyebrow: t('toolbox.embedded.step1.outputsEyebrow', {}, 'Outputs'),
      outputsTitle: t('toolbox.embedded.step1.outputsTitle', {}, 'Extracted files'),
      outputsEmpty: t('toolbox.embedded.step1.outputsEmpty', {}, 'No tracks extracted yet. Run extraction above to see them here.')
    },
    step2: {
      chip: t('toolbox.embedded.step2.chip', {}, 'Step 2'),
      title: t('toolbox.embedded.step2.title', {}, 'Tracks & Translation'),
      helper: t('toolbox.embedded.step2.helper', {}, 'Select a track in Step 1 outputs, then choose a target language and translate.'),
      selectedLabel: t('toolbox.embedded.step2.selectedLabel', {}, 'Selected subtitle'),
      selectedPlaceholder: t('toolbox.embedded.step2.selectedPlaceholder', {}, 'Select a subtitle in Step 1 outputs to unlock this step.'),
      targetLabel: t('toolbox.embedded.step2.targetLabel', {}, 'Target language'),
      settingsTitle: t('toolbox.embedded.step2.settingsTitle', {}, 'Translation Settings'),
      settingsMeta: t('toolbox.embedded.step2.settingsMeta', {}, 'Provider, batching, timestamps'),
      providerLabel: t('toolbox.embedded.step2.providerLabel', {}, 'Provider'),
      providerHelper: t('toolbox.embedded.step2.providerHelper', {}, 'Uses your configured model for the selected provider.'),
      batchingLabel: t('toolbox.embedded.step2.batchingLabel', {}, 'Batching'),
      batchingMultiple: t('toolbox.embedded.step2.batchingMultiple', {}, 'Multiple batches (recommended)'),
      batchingSingle: t('toolbox.embedded.step2.batchingSingle', {}, 'Single batch (all at once)'),
      timestampsLabel: t('toolbox.embedded.step2.timestampsLabel', {}, 'Timestamps'),
      timestampsOriginal: t('toolbox.embedded.step2.timestampsOriginal', {}, 'Original Timestamps'),
      timestampsSend: t('toolbox.embedded.step2.timestampsSend', {}, 'Send Timestamps to AI'),
      translationContext: t('toolbox.embedded.step2.translationContext', { label: '{label}' }, "You're translating subtitles for {label}"),
      translationContextFallback: t('toolbox.embedded.step2.translationContextFallback', {}, 'your linked stream'),
      translateButton: t('toolbox.embedded.step2.translateButton', {}, 'Translate Subtitles'),
      logHeader: t('toolbox.embedded.step2.logHeader', {}, 'Live log'),
      logSub: t('toolbox.embedded.step2.logSub', {}, 'Auto-filled while translations run.'),
      outputsEyebrow: t('toolbox.embedded.step2.outputsEyebrow', {}, 'Outputs'),
      outputsTitle: t('toolbox.embedded.step2.outputsTitle', {}, 'Translated subtitles'),
      outputsEmpty: t('toolbox.embedded.step2.outputsEmpty', {}, 'No translations yet. Pick a track and translate to see them here.'),
      reloadHint: t('toolbox.embedded.step2.reloadHint', {}, 'Done! Reload the stream subtitle list in Stremio to see xEmbed (Language) entries.'),
      reloadHintManual: t('toolbox.embedded.step2.reloadHintManual', {}, 'Hash mismatch detected; translations were saved locally. Download the SRT above and drag it into Stremio manually.')
    },
    locks: {
      needExtraction: t('toolbox.embedded.locks.needExtraction', {}, 'Run Step 1 extraction to unlock translation.'),
      needTrack: t('toolbox.embedded.locks.needTrack', {}, 'Select an extracted subtitle to unlock translation.')
    },
    status: {
      queued: t('toolbox.embedded.status.queued', {}, 'queued'),
      running: t('toolbox.embedded.status.running', {}, 'running'),
      done: t('toolbox.embedded.status.done', {}, 'done'),
      failed: t('toolbox.embedded.status.failed', {}, 'failed')
    },
    buttons: {
      extracting: t('toolbox.embedded.buttons.extracting', {}, 'Extracting...')
    }
  };
  const translationContextLabel = [
    (linkedTitle || cleanDisplayName(filename) || cleanDisplayName(videoId) || copy.step2.translationContextFallback).trim(),
    episodeTag
  ].filter(Boolean).join(' ').trim() || copy.step2.translationContextFallback;
  const metaDetails = [];
  if (linkedTitle) metaDetails.push(t('toolbox.embedded.meta.title', { title: linkedTitle }, `Title: ${linkedTitle}`));
  else if (videoId) metaDetails.push(t('toolbox.embedded.meta.videoId', { id: videoId }, `Video ID: ${videoId}`));
  if (episodeTag) metaDetails.push(t('toolbox.embedded.meta.episode', { episode: episodeTag }, `Episode: ${episodeTag}`));
  if (filename) metaDetails.push(t('toolbox.embedded.meta.file', { file: cleanDisplayName(filename) }, `File: ${cleanDisplayName(filename)}`));
  const initialVideoTitle = escapeHtml(linkedTitle || cleanDisplayName(filename) || cleanDisplayName(videoId) || copy.videoMeta.none);
  const initialVideoSubtitle = escapeHtml(metaDetails.join(' - ') || copy.videoMeta.unavailable);
  const initialTranslationContext = escapeHtml(
    t(
      'toolbox.embedded.step2.translationContext',
      { label: translationContextLabel },
      (copy.step2.translationContext || "You're translating subtitles for {label}").replace('{label}', translationContextLabel)
    )
  );
  const modeHelperHtml = escapeHtml(copy.step1.modeHelper).replace(/\n/g, '<br>');
  const step1Helper = (copy.step1.helper && copy.step1.helper !== 'toolbox.embedded.step1.helper')
    ? copy.step1.helper
    : '';
  const hashAlertLines = [copy.step1.hashMismatchLine1, copy.step1.hashMismatchLine2].filter(Boolean);
  const providerOptions = (() => {
    const options = [];
    const providers = config.providers || {};
    const seen = new Set();
    const resolveProviderEntry = (key) => {
      const normalized = String(key || '').trim().toLowerCase();
      const matchKey = Object.keys(providers || {}).find(k => String(k).toLowerCase() === normalized);
      return matchKey ? { key: matchKey, config: providers[matchKey] || {} } : null;
    };
    const formatLabel = (name, model) => {
      const base = formatProviderName(name);
      const modelLabel = model ? ` (${model})` : '';
      return `${base}${modelLabel}`;
    };
    const geminiConfigured = Boolean(config.geminiModel || config.geminiKey || config.geminiApiKey || providers.gemini);
    const geminiEnabled = providers.gemini ? providers.gemini.enabled !== false : geminiConfigured;
    const addIfEnabled = (key, label, model) => {
      const norm = String(key || '').trim().toLowerCase();
      if (!norm || seen.has(norm)) return;
      let enabled = false;
      if (norm === 'gemini') {
        enabled = geminiEnabled;
      } else {
        const entry = resolveProviderEntry(norm);
        enabled = entry?.config?.enabled === true;
      }
      if (!enabled) return;
      seen.add(norm);
      options.push({ key: norm, label: label || formatLabel(key, model), model: model || '' });
    };
    if (geminiEnabled) {
      const geminiLabel = formatLabel('Gemini', config.geminiModel || providers.gemini?.model || '');
      addIfEnabled('gemini', geminiLabel, config.geminiModel || providers.gemini?.model || '');
    }
    if (config.multiProviderEnabled && config.mainProvider) {
      const entry = resolveProviderEntry(config.mainProvider);
      const model = entry?.config?.model || (config.mainProvider.toLowerCase() === 'gemini' ? config.geminiModel : '');
      addIfEnabled(config.mainProvider, `Main: ${formatLabel(config.mainProvider, model)}`, model);
    }
    if (config.secondaryProviderEnabled && config.secondaryProvider) {
      const entry = resolveProviderEntry(config.secondaryProvider);
      const model = entry?.config?.model || (config.secondaryProvider.toLowerCase() === 'gemini' ? config.geminiModel : '');
      addIfEnabled(config.secondaryProvider, `Secondary: ${formatLabel(config.secondaryProvider, model)}`, model);
    }
    Object.keys(providers || {}).forEach(key => {
      const model = providers[key]?.model || '';
      addIfEnabled(key, `Provider: ${formatLabel(key, model)}`, model);
    });
    return options;
  })();

  const bootstrap = {
    configStr,
    videoId,
    filename,
    videoHash,
    targetLanguages,
    sourceLanguages,
    targetLanguageCodes,
    languageMaps,
    providerOptions,
    defaults: {
      singleBatchMode: config.singleBatchMode === true,
      sendTimestampsToAI: config.advancedSettings?.sendTimestampsToAI === true,
      translationPrompt: config.translationPrompt || ''
    },
    links,
    linkedTitle,
    strings: {
      translationContextTemplate: copy.step2.translationContext,
      translationContextFallback: copy.step2.translationContextFallback,
      videoMeta: {
        waiting: copy.videoMeta.waiting,
        none: copy.videoMeta.none,
        unavailable: copy.videoMeta.unavailable,
        title: t('toolbox.embedded.meta.title', { title: '{title}' }, 'Title: {title}'),
        videoId: t('toolbox.embedded.meta.videoId', { id: '{id}' }, 'Video ID: {id}'),
        episode: t('toolbox.embedded.meta.episode', { episode: '{episode}' }, 'Episode: {episode}'),
        file: t('toolbox.embedded.meta.file', { file: '{file}' }, 'File: {file}')
      },
      statusLabels: copy.status,
      buttons: {
        extract: copy.step1.extractButton,
        translate: copy.step2.translateButton,
        extracting: copy.buttons.extracting
      },
      hashMismatch: {
        inline: copy.step1.hashMismatchInline,
        alertLines: hashAlertLines
      },
      locks: {
        needExtraction: copy.locks.needExtraction,
        needTrack: copy.locks.needTrack
      }
    }
  };

  return `
<!DOCTYPE html>
<html lang="${resolveUiLang(config)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(copy.meta.documentTitle)}</title>
  ${localeBootstrap}
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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; }
    html { color-scheme: light; }
    [data-theme="dark"] { color-scheme: dark; }
    [data-theme="true-dark"] { color-scheme: dark; }
    /* Removed forced color-scheme override - let theme cascade handle it naturally */
    :root {
      --primary: #08A4D5;
      --primary-2: #33B9E1;
      --secondary: #33B9E1;
      --accent: #0ea5e9;
      --surface: #ffffff;
      --surface-2: #f4f7fc;
      --surface-hover: #ffffff;
      --surface-light: #f3f7fb;
      --bg: #f5f8fd;
      --bg-strong: #e9eef7;
      --bg-primary: #f7fafc;
      --bg-mid: #ffffff;
      --text: #0f172a;
      --text-primary: #0f172a;
      --text-secondary: #475569;
      --muted: #475569;
      --border: #dbe3ea;
      --shadow: 0 14px 40px rgba(12, 19, 56, 0.12);
      --shadow-color: rgba(12, 19, 56, 0.12);
      --glow: rgba(8, 164, 213, 0.25);
      --danger: #ef4444;
      --success: #10b981;
    }
    [data-theme="dark"] {
      --surface: #141931;
      --surface-2: #1e2539;
      --surface-hover: #252f49;
      --surface-light: #1E2539;
      --bg: #0A0E27;
      --bg-strong: #141931;
      --bg-primary: #0A0E27;
      --bg-mid: #141931;
      --text: #E8EAED;
      --text-primary: #E8EAED;
      --text-secondary: #9AA0A6;
      --muted: #9AA0A6;
      --border: #2A3247;
      --shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
      --shadow-color: rgba(0, 0, 0, 0.45);
      --glow: rgba(8, 164, 213, 0.35);
      --secondary: #33B9E1;
    }
    [data-theme="true-dark"] {
      --surface: #0a0a0a;
      --surface-2: #151515;
      --surface-hover: #1e1e1e;
      --surface-light: #151515;
      --bg: #000000;
      --bg-strong: #0a0a0a;
      --bg-primary: #000000;
      --bg-mid: #0a0a0a;
      --text: #E8EAED;
      --text-primary: #E8EAED;
      --text-secondary: #8A8A8A;
      --muted: #8A8A8A;
      --border: #1a1a1a;
      --shadow: 0 20px 56px rgba(0, 0, 0, 0.8);
      --shadow-color: rgba(0, 0, 0, 0.8);
      --glow: rgba(8, 164, 213, 0.45);
      --secondary: #33B9E1;
    }
    ${quickNavStyles()}
    body {
      margin: 0;
      min-height: 100vh;
      background: linear-gradient(135deg, var(--bg-primary) 0%, var(--bg-mid) 60%, var(--bg-primary) 100%);
      color: var(--text);
      font-family: 'Inter', 'Space Grotesk', -apple-system, 'Segoe UI', sans-serif;
      padding: 0 0 46px;
      position: relative;
      overflow-x: hidden;
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
    body.modal-open { overflow: hidden; }
    .help-button {
      position: fixed;
      bottom: 1.75rem;
      right: 1.75rem;
      width: 56px;
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5rem;
      cursor: pointer;
      z-index: 12010;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      border: 2px solid #8a5a00;
      background: linear-gradient(180deg, #f7d13e 0%, #e6b526 60%, #d49c1d 100%);
      color: #3b2a00;
      border-radius: 14px;
      box-shadow:
        inset 0 2px 0 #fff3b0,
        inset 0 -3px 0 #b47a11,
        0 6px 0 #7a4d00,
        0 10px 16px rgba(0,0,0,0.35);
      text-shadow: 0 1px 0 rgba(255,255,255,0.6);
    }
    .help-button.mario::before {
      content: '';
      position: absolute;
      width: 5px;
      height: 5px;
      border-radius: 50%;
      opacity: .9;
      background: #b47a11;
      top: 6px;
      left: 6px;
      box-shadow: calc(100% - 12px) 0 0 #b47a11;
    }
    .help-button:hover { transform: translateY(-2px); }
    [data-theme="dark"] .help-button {
      border-color: #1b2a78;
      background: linear-gradient(180deg, #4c6fff 0%, #2f4ed1 60%, #1e2f8a 100%);
      color: #0f1a4a;
      box-shadow:
        inset 0 2px 0 #b3c4ff,
        inset 0 -3px 0 #213a9a,
        0 6px 0 #16246a,
        0 10px 16px rgba(20,25,49,0.6);
    }
    [data-theme="dark"] .help-button.mario::before {
      background: #213a9a;
      box-shadow: calc(100% - 12px) 0 0 #213a9a;
    }
    [data-theme="true-dark"] .help-button {
      border-color: #3b2a5d;
      background: linear-gradient(180deg, #1b1029 0%, #110b1a 60%, #0b0711 100%);
      color: #bdb4ff;
      box-shadow:
        inset 0 2px 0 #6b65ff33,
        inset 0 -3px 0 #2b2044,
        0 6px 0 #2a1e43,
        0 0 18px rgba(107,101,255,0.35);
    }
    [data-theme="true-dark"] .help-button.mario::before {
      background: #2b2044;
      box-shadow: calc(100% - 12px) 0 0 #2b2044;
    }
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(255, 255, 255, 0.85);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 12000;
      animation: fadeIn 0.3s ease;
    }
    [data-theme="dark"] .modal-overlay,
    [data-theme="true-dark"] .modal-overlay {
      background: rgba(10, 14, 39, 0.85);
    }
    .modal-overlay.show { display: flex; }
    .modal {
      background:
        linear-gradient(180deg, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0.82) 100%),
        var(--surface);
      border-radius: 20px;
      max-width: 560px;
      width: 94%;
      max-height: 88vh;
      overflow: hidden;
      border: 1px solid var(--border);
      box-shadow: 0 24px 72px var(--shadow), 0 0 0 1px rgba(8, 164, 213, 0.14);
      animation: modalSlideIn 0.42s cubic-bezier(0.22, 1, 0.36, 1);
      position: relative;
      display: flex;
      flex-direction: column;
    }
    [data-theme="dark"] .modal {
      background:
        linear-gradient(180deg, rgba(20,25,49,0.9) 0%, rgba(20,25,49,0.8) 100%),
        var(--surface);
    }
    [data-theme="true-dark"] .modal {
      background:
        linear-gradient(180deg, rgba(11,7,17,0.92) 0%, rgba(11,7,17,0.82) 100%),
        var(--surface);
    }
    .modal-header {
      padding: 1.25rem 1.5rem;
      border-bottom: 1px solid var(--border);
      background: linear-gradient(135deg, rgba(8, 164, 213, 0.08) 0%, rgba(51, 185, 225, 0.08) 100%);
      position: sticky;
      top: 0;
      z-index: 1;
      text-align: center;
    }
    .modal-header h2 {
      font-size: 1.5rem;
      font-weight: 700;
      background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.75rem;
    }
    .modal-close {
      position: absolute;
      top: 1.25rem;
      right: 1.25rem;
      width: 36px;
      height: 36px;
      background: var(--surface-light);
      border: 1px solid var(--border);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s ease;
      font-size: 1.25rem;
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
      text-align: center;
      overflow: auto;
      -webkit-overflow-scrolling: touch;
      flex: 1 1 auto;
      scrollbar-gutter: stable both-edges;
    }
    .modal-content h3 {
      color: var(--primary);
      font-size: 1.125rem;
      font-weight: 700;
      margin: 0 0 0.5rem;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }
    .modal-content ol {
      margin: 0.5rem auto 1rem;
      padding-left: 1rem;
      color: var(--text-primary);
      line-height: 1.7;
      display: inline-block;
      text-align: left;
    }
    .modal-content li { margin: 0.35rem 0; }
    .modal-content p {
      color: var(--text-secondary);
      line-height: 1.7;
      margin: 0.75rem 0;
    }
    .modal-footer {
      padding: 1rem 1.5rem;
      border-top: 1px solid var(--border);
      display: flex;
      gap: 1rem;
      justify-content: center;
      align-items: center;
      background: var(--surface);
      position: sticky;
      bottom: 0;
      flex-wrap: wrap;
    }
    .modal-checkbox {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      color: var(--text-secondary);
      font-size: 0.9rem;
      cursor: pointer;
      user-select: none;
    }
    .modal-checkbox input[type="checkbox"] {
      width: 18px;
      height: 18px;
      cursor: pointer;
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes modalSlideIn {
      from { opacity: 0; transform: translateY(-30px) scale(0.95); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    a { color: inherit; }
    .page { max-width: 1200px; margin: 0 auto; padding: 24px 18px 0; position: relative; z-index: 1; }
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
    .page-heading {
      margin: 0;
      font-size: 30px;
      letter-spacing: -0.02em;
    }
    .page-subtitle {
      margin: 0;
      color: var(--muted);
      font-weight: 600;
    }
    @keyframes floaty {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-8px); }
    }
    .badge-row { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; margin-top: 4px; }
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
    .status-labels { display: flex; flex-direction: column; line-height: 1.15; }
    .label-eyebrow { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
    .status-badge strong { font-size: 14px; }
    .status-badge .ext-link {
      font-size: 14px;
      font-weight: 700;
      color: var(--primary);
      text-decoration: underline;
    }
    .status-badge .ext-link.ready {
      color: var(--text-primary);
      text-decoration: none;
      pointer-events: none;
      cursor: default;
      font-weight: 800;
    }
    .status-badge .ext-link {
      font-size: 14px;
      font-weight: 700;
      color: var(--primary);
      text-decoration: underline;
    }
    .status-badge .ext-link.ready {
      color: var(--text-primary);
      text-decoration: none;
      pointer-events: none;
      cursor: default;
      font-weight: 800;
    }
    .hero {
      border-radius: 18px;
      background: radial-gradient(120% 120% at 0% 0%, rgba(8,164,213,0.16), transparent 42%), radial-gradient(120% 120% at 100% 0%, rgba(255,255,255,0.12), transparent 38%), linear-gradient(135deg, var(--surface), var(--surface-2));
      border: 1px solid rgba(255,255,255,0.4);
      box-shadow: var(--shadow);
      padding: 18px;
      display: grid;
      grid-template-columns: 1.25fr 0.75fr;
      gap: 16px;
      align-items: stretch;
    }
    .hero h2 { margin: 0 0 6px; font-size: 26px; letter-spacing: -0.02em; }
    .hero p { margin: 6px 0 12px; color: var(--muted); line-height: 1.6; }
    .eyebrow { letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); font-weight: 700; font-size: 12px; }
    .chip-row { display: flex; flex-wrap: wrap; gap: 10px; }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 12px;
      background: var(--surface);
      border: 1px solid var(--border);
      box-shadow: 0 6px 16px rgba(0,0,0,0.04);
      font-weight: 600;
      color: var(--text);
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      box-shadow: var(--shadow);
      padding: 16px;
      position: relative;
      overflow: hidden;
    }
    .section-grid {
      display: grid;
      grid-template-columns: 1.2fr 1fr;
      gap: 14px;
      margin-top: 14px;
    }
    .section h3 { margin: 0 0 6px; font-size: 18px; letter-spacing: -0.01em; }
    .step-chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0.35rem 0.75rem;
      border-radius: 999px;
      background: rgba(8, 164, 213, 0.12);
      color: var(--primary);
      font-weight: 700;
      font-size: 0.85rem;
    }
    .step-header { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
    .step-header h3, .step-header p { align-self: flex-start; text-align: left; }
    .step-title-row { display: inline-flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .step-helper { margin: 4px 0 0; }
    #step1Card .section-head { flex-direction: column; align-items: flex-start; justify-content: flex-start; text-align: left; }
    #step1Card .section-head > div { text-align: left; }
    #step1Card .step-header { align-items: flex-start; }
    #step1Card .step-header h3,
    #step1Card .step-header p { align-self: flex-start; text-align: left; }
    #step1Card .step-title-row { width: 100%; }
    .centered-section { text-align: center; }
    .centered-section .section-head { flex-direction: column; align-items: center; justify-content: center; text-align: center; }
    .centered-section .section-head > div { text-align: center; }
    .centered-section .flex { justify-content: center; }
    .centered-section .video-meta { text-align: center; }
    .centered-section .track { text-align: center; }
    .centered-section textarea,
    .centered-section input[type="text"],
    .centered-section select { text-align: center; }
    .centered-section .log { text-align: center; }
    .centered-section .target { flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 6px; }
    .centered-section .result-head { justify-content: center; text-align: center; }
    .centered-section .downloads { justify-items: center; }
    .card.locked { opacity: 0.55; }
    .card.locked::after {
      content: attr(data-locked-label);
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 1rem;
      background: rgba(255, 255, 255, 0.82);
      color: var(--muted);
      font-weight: 700;
      letter-spacing: -0.01em;
      pointer-events: all;
      z-index: 5;
    }
    [data-theme="dark"] .card.locked::after,
    [data-theme="true-dark"] .card.locked::after {
      background: rgba(10, 12, 22, 0.82);
      color: #d5def3;
    }
    .is-disabled { opacity: 0.45; pointer-events: none; filter: grayscale(0.08); }
    .is-disabled .step-chip { background: #e2e8f0; color: #94a3b8; }
    .muted { color: var(--muted); }
    label { display: block; font-weight: 700; margin: 10px 0 6px; }
    textarea, input[type="text"], select {
      width: 100%;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: var(--surface-2);
      padding: 10px 12px;
      font-size: 14px;
      color: var(--text);
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    textarea { resize: vertical; min-height: 90px; }
    textarea:focus, input[type="text"]:focus, select:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(8,164,213,0.2);
    }
    .form-group {
      width: min(720px, 100%);
      margin: 4px auto 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: center;
    }
    .form-group label {
      margin: 0;
      font-weight: 700;
      font-size: 0.95rem;
      color: var(--text-primary);
      text-align: center;
    }
    .form-group input[type="text"],
    .form-group input[type="url"] {
      width: 100%;
      padding: 0.875rem 1rem;
      background: var(--surface);
      border: 2px solid var(--border);
      border-radius: 12px;
      color: var(--text-primary);
      font-size: 1rem;
      font-family: inherit;
      text-align: center;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .form-group input[type="text"]:focus,
    .form-group input[type="url"]:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 4px var(--glow);
    }
    /* Removed select option styling - let browser use native colors based on color-scheme */
    /* This prevents black flash when dropdown opens */
    button, .button {
      appearance: none;
      border: 1px solid transparent;
      background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
      color: #ffffff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
      font-weight: 600;
      font-size: 0.95rem;
      padding: 0.65rem 1rem;
      border-radius: 10px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.55rem;
      box-shadow: 0 10px 24px var(--glow);
      transition: transform 0.2s ease, box-shadow 0.2s ease, filter 0.2s ease;
      text-decoration: none;
      white-space: nowrap;
      line-height: 1.1;
    }
    button.secondary, .button.secondary {
      background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
      color: #ffffff;
      opacity: 0.9;
      box-shadow: 0 10px 22px var(--glow);
    }
    button:disabled, .button:disabled { opacity: 0.6; cursor: not-allowed; box-shadow: none; }
    button:hover:not(:disabled), .button:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 12px 28px var(--glow); }
    .flex { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .mode-controls { display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 12px; margin-top: 8px; }
    .mode-controls label { margin: 0; font-weight: 700; }
    .mode-controls select { width: auto; min-width: 200px; }
    .mode-helper { margin: -2px 0 2px; color: var(--muted); font-size: 13px; text-align: center; max-width: 640px; }
    #step1Card .step-stack { display: flex; flex-direction: column; gap: 14px; align-items: center; margin-top: 6px; }
    #step1Card .step-stack .field-block { width: min(720px, 100%); display: flex; flex-direction: column; gap: 6px; }
    #step1Card .step-stack .log,
    #step1Card .step-stack .result-box,
    #step1Card .mode-controls { width: min(720px, 100%); }
    #step1Card .mode-controls { padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-2); }
    #extract-btn { margin-bottom: 6px; }
    .provider-model-row { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; align-items: center; margin-top: 10px; }
    .select-stack { display: flex; flex-direction: column; gap: 6px; min-width: 200px; }
    .select-stack label { margin: 0; }
    .provider-model-row .select-stack { align-items: center; text-align: center; }
    .select-stack.model-stack { align-items: center; text-align: center; }
    .select-stack.model-stack select { width: min(260px, 100%); }
    .target-select-stack { width: min(420px, 100%); margin: 12px auto 0; align-items: center; }
    .target-select-stack label { margin: 0; }
    select.target-select { width: min(420px, 100%); text-align: center; text-align-last: center; }
    select.target-select option { text-align: center; }
    details.translation-settings {
      width: min(720px, 100%);
      margin: 14px auto 0;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--surface-2);
      padding: 12px;
      box-shadow: 0 8px 18px rgba(0,0,0,0.04);
    }
    details.translation-settings summary {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      cursor: pointer;
      list-style: none;
      outline: none;
      font-weight: 800;
      color: var(--text-primary);
      text-align: center;
    }
    details.translation-settings summary::-webkit-details-marker { display: none; }
    .translation-settings summary > div { text-align: center; }
    .translation-settings .summary-meta {
      display: block;
      margin-top: 2px;
      font-weight: 600;
      color: var(--text-secondary);
      font-size: 13px;
    }
    .translation-settings .chevron {
      width: 0;
      height: 0;
      border-left: 6px solid transparent;
      border-right: 6px solid transparent;
      border-top: 7px solid var(--text-secondary);
      transition: transform 0.2s ease;
      flex-shrink: 0;
    }
    .translation-settings[open] .chevron { transform: rotate(180deg); }
    .translation-settings-body {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 14px;
      align-items: center;
    }
    .tracks {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 10px;
      margin-top: 10px;
    }
    .track {
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 12px;
      background: var(--surface-2);
      transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s ease;
      box-shadow: 0 8px 18px rgba(0,0,0,0.04);
    }
    .track:hover { transform: translateY(-1px); }
    .extract-card { display: flex; flex-direction: column; gap: 8px; }
    .extract-card .track-meta { display: flex; gap: 10px; flex-wrap: wrap; color: var(--muted); font-size: 13px; }
    .extract-card .track-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; justify-content: flex-start; }
    .extract-card.active {
      border-color: var(--primary);
      background: linear-gradient(135deg, rgba(8,164,213,0.12), var(--surface));
      box-shadow: 0 14px 34px rgba(8,164,213,0.18);
    }
    .pill-small { padding: 4px 8px; border-radius: 999px; border: 1px solid var(--border); font-size: 12px; background: var(--surface); }
    .log {
      position: relative;
      background: var(--surface-2);
      border: 1px dashed var(--border);
      border-radius: 12px;
      padding: 12px;
      height: 220px;
      overflow: auto;
      font-size: 13px;
      line-height: 1.5;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.3);
      background-image:
        linear-gradient(135deg, rgba(8,164,213,0.08) 25%, transparent 25%),
        linear-gradient(135deg, transparent 50%, rgba(8,164,213,0.08) 50%, rgba(8,164,213,0.08) 75%, transparent 75%),
        linear-gradient(to bottom, rgba(255,255,255,0.08), rgba(255,255,255,0));
      background-size: 18px 18px, 18px 18px, auto;
      background-position: 0 0, 9px 9px, 0 0;
    }
    .log-alert {
      margin: 8px auto 0;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid rgba(239,68,68,0.35);
      background: rgba(239,68,68,0.08);
      color: var(--danger);
      font-weight: 700;
      font-size: 14px;
      text-align: center;
      width: min(780px, 100%);
      box-shadow: 0 8px 22px rgba(239,68,68,0.12);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    }
    .log-alert .alert-head {
      color: #fff;
      background: linear-gradient(135deg, #ef4444, #b91c1c);
      padding: 6px 12px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 700;
      box-shadow: 0 10px 18px rgba(185,28,28,0.18);
    }
    .log-alert .alert-body {
      display: flex;
      flex-direction: column;
      gap: 4px;
      color: var(--danger);
      font-size: 14px;
      font-weight: 700;
      line-height: 1.4;
    }
    .hash-inline {
      display: none;
      margin: 6px 0 0;
      color: var(--danger);
      font-weight: 700;
      font-size: 13px;
    }
    #hash-mismatch-alert {
      margin: 8px auto 0;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid rgba(239,68,68,0.35);
      background: rgba(239,68,68,0.08);
      color: var(--danger);
      font-weight: 700;
      font-size: 14px;
      text-align: center;
      width: min(780px, 100%);
      box-shadow: 0 8px 22px rgba(239,68,68,0.12);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    }
    #hash-mismatch-alert .alert-head {
      color: #fff;
      background: linear-gradient(135deg, #ef4444, #b91c1c);
      padding: 6px 12px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 700;
      box-shadow: 0 10px 18px rgba(185,28,28,0.18);
    }
    #hash-mismatch-alert .alert-body {
      font-size: 13px;
      font-weight: 600;
      line-height: 1.4;
      color: var(--danger);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .log-header {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(0,0,0,0.02);
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
      margin: 4px auto;
    }
    .log-header .pulse {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--primary);
      box-shadow: 0 0 0 0 rgba(8,164,213,0.35);
      animation: pulse 1.8s ease-out infinite;
    }
    .log-header .label {
      color: var(--text);
      font-weight: 800;
    }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(8,164,213,0.35); }
      70% { box-shadow: 0 0 0 10px rgba(8,164,213,0); }
      100% { box-shadow: 0 0 0 0 rgba(8,164,213,0); }
    }
    .video-meta {
      margin-top: 10px;
      padding: 12px;
      border-radius: 12px;
      border: 1px dashed var(--border);
      background: var(--surface-2);
    }
    .linked-stream-wrapper {
      display: flex;
      justify-content: center;
      margin: 10px auto 0;
      flex-basis: 100%;
      width: 100%;
    }
    #linked-stream-card {
      width: min(780px, 100%);
      text-align: center;
    }
    .video-meta-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin: 0 0 4px;
      font-weight: 700;
    }
    .video-meta-title {
      margin: 0;
      font-weight: 800;
      font-size: 16px;
      letter-spacing: -0.01em;
    }
    .video-meta-subtitle {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 13px;
      word-break: break-word;
    }
    .downloads { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; margin-top: 10px; }
    .result-box {
      margin-top: 10px;
      padding: 12px;
      border-radius: 12px;
      border: 1px dashed var(--border);
      background: var(--surface-2);
    }
    .result-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .result-head h4 { margin: 2px 0 0; font-size: 16px; letter-spacing: -0.01em; }
    .result-empty { color: var(--muted); font-size: 13px; margin: 6px 0 0; }
    .notice {
      margin-top: 10px;
      padding: 12px;
      border-radius: 12px;
      background: rgba(8,164,213,0.12);
      border: 1px solid rgba(8,164,213,0.25);
      color: var(--text);
      font-weight: 700;
    }
    .notice.success {
      background: rgba(16,185,129,0.12);
      border-color: rgba(16,185,129,0.35);
      color: #0f5132;
    }
    #hash-status {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    #hash-status .alert-head {
      font-size: 12px;
      font-weight: 800;
      letter-spacing: -0.01em;
      color: inherit;
    }
    #hash-status .alert-body {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.45;
    }
    #hash-status.neutral {
      background: var(--surface-2);
      border-color: var(--border);
      color: var(--text-secondary);
    }
    #hash-status.success {
      background: rgba(16,185,129,0.12);
      border-color: rgba(16,185,129,0.35);
      color: #0f5132;
    }
    #hash-status.danger {
      background: rgba(239,68,68,0.12);
      border-color: rgba(239,68,68,0.35);
      color: #7f1d1d;
    }
    .notice.warn, .notice.danger {
      background: rgba(239,68,68,0.12);
      border-color: rgba(239,68,68,0.35);
      color: #7f1d1d;
    }
    .notice.success {
      background: rgba(16,185,129,0.12);
      border-color: rgba(16,185,129,0.35);
      color: #0f5132;
    }
    .notice.warn, .notice.danger {
      background: rgba(239,68,68,0.12);
      border-color: rgba(239,68,68,0.35);
      color: #7f1d1d;
    }
    .notice.aio-warning {
      background: rgba(8,164,213,0.12);
      border-color: rgba(8,164,213,0.25);
      color: var(--text);
    }
    .aio-warning {
      margin-top: 12px;
      font-size: 13px;
      line-height: 1.5;
    }
    select.compact-select { width: min(240px, 100%); text-align: center; text-align-last: center; }
    select.target-select { width: min(420px, 100%); }
    .selected-track-box {
      margin-top: 12px;
      padding: 12px;
      border: 1px dashed var(--border);
      border-radius: 12px;
      background: var(--surface-2);
      text-align: center;
    }
    .selected-track-label { font-weight: 700; margin: 0 0 6px; }
    .selected-track-value { margin: 0; color: var(--muted); }
    .selected-track-placeholder { color: var(--muted); }
    .status-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); display: inline-block; }
    .status-dot.ok { background: var(--success); }
    .status-dot.bad { background: var(--danger); }
    .status-dot.warn { background: #f59e0b; }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .episode-toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      width: min(360px, calc(100% - 32px));
      padding: 14px 16px;
      border-radius: 12px;
      background: var(--surface);
      border: 1px solid var(--border);
      box-shadow: 0 14px 38px var(--shadow-color, rgba(0,0,0,0.18));
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
    .episode-toast .meta { margin: 0; color: var(--muted); font-size: 0.9rem; word-break: break-word; }
    .episode-toast .close {
      background: none;
      border: none;
      color: var(--muted);
      font-weight: 800;
      cursor: pointer;
      padding: 4px;
      line-height: 1;
      border-radius: 6px;
      transition: color 0.2s ease, background 0.2s ease;
    }
    .episode-toast .close:hover { color: var(--text); background: var(--surface-2); }
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
    @media (max-width: 980px) {
      .hero { grid-template-columns: 1fr; }
      .section-grid { grid-template-columns: 1fr; }
    }
  ${themeToggleStyles()}
  </style>
  <script src="/js/theme-toggle.js" defer></script>
</head>
<body>
  ${themeToggleMarkup(themeToggleLabel)}
  <button class="help-button mario" id="embeddedHelp" title="${escapeHtml(copy.instructions.help)}" aria-label="${escapeHtml(copy.instructions.help)}">?</button>
  <div class="modal-overlay" id="embeddedInstructionsModal" role="dialog" aria-modal="true" aria-labelledby="embeddedInstructionsTitle">
    <div class="modal">
      <div class="modal-header">
        <h2 id="embeddedInstructionsTitle">${escapeHtml(copy.instructions.title)}</h2>
        <div class="modal-close" id="closeEmbeddedInstructions" role="button" aria-label="${escapeHtml(copy.instructions.close)}">&times;</div>
      </div>
      <div class="modal-content">
        <h3>${escapeHtml(copy.instructions.extractionTitle)}</h3>
        <ol>
          ${copy.instructions.extractionSteps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}
        </ol>

        <h3>${escapeHtml(copy.instructions.translationTitle)}</h3>
        <ol>
          ${copy.instructions.translationSteps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}
        </ol>

        <p>${escapeHtml(copy.instructions.download)}</p>
        <p>${escapeHtml(copy.instructions.upload)}</p>
        <p>${escapeHtml(copy.instructions.retry)}</p>
        <p>${escapeHtml(copy.instructions.originals)}</p>
        <p class="muted">${escapeHtml(copy.instructions.ocrNote)}</p>
      </div>
      <div class="modal-footer">
        <label class="modal-checkbox">
          <input type="checkbox" id="dontShowEmbeddedInstructions">
          ${escapeHtml(copy.instructions.dontShow)}
        </label>
        <button type="button" class="btn" id="gotItEmbeddedInstructions">${escapeHtml(copy.instructions.gotIt)}</button>
      </div>
    </div>
  </div>
  <div id="episodeToast" class="episode-toast" role="status" aria-live="polite">
    <div class="icon">!</div>
    <div class="content">
      <p class="title" id="episodeToastTitle">${t('toolbox.toast.title', {}, 'New stream detected')}</p>
      <p class="meta" id="episodeToastMeta">${t('toolbox.toast.meta', {}, 'A different episode is playing in Stremio.')}</p>
    </div>
    <button class="close" id="episodeToastDismiss" type="button" aria-label="${t('toolbox.toast.dismiss', {}, 'Dismiss notification')}">×</button>
    <button class="action" id="episodeToastUpdate" type="button">${t('toolbox.toast.update', {}, 'Update')}</button>
  </div>
  ${renderQuickNav(links, 'embeddedSubs', false, devMode, t)}
  <div class="page">
    <header class="masthead">
        <div class="page-hero">
          <div class="page-icon">🧲</div>
          <h1 class="page-heading">${escapeHtml(copy.meta.pageHeading)}</h1>
          <p class="page-subtitle">${escapeHtml(copy.meta.pageSubtitle)}</p>
          <p class="notice warn aio-warning">${copy.hero.notice}</p>
        </div>
      <div class="badge-row">
        ${renderRefreshBadge(t)}
        <div class="status-badge">
          <span class="status-dot ok"></span>
          <div class="status-labels">
            <span class="label-eyebrow">${t('toolbox.status.addon', {}, 'Addon')}</span>
            <strong>v${escapeHtml(appVersion || t('toolbox.autoSubs.badges.versionFallback', {}, 'n/a'))}</strong>
          </div>
        </div>
        <div class="status-badge" id="ext-status">
          <span class="status-dot warn" id="ext-dot"></span>
          <div class="status-labels">
            <span class="label-eyebrow">${t('toolbox.status.extension', {}, 'Extension')}</span>
            <a id="ext-label" class="ext-link" href="https://chromewebstore.google.com/detail/submaker-xsync/lpocanpndchjkkpgchefobjionncknjn" target="_blank" rel="noopener noreferrer">${t('toolbox.autoSubs.extension.waiting', {}, 'Waiting for extension...')}</a>
          </div>
        </div>
        <div class="status-badge">
          <span class="status-dot ok"></span>
          <div class="status-labels">
            <span class="label-eyebrow">${t('toolbox.autoSubs.badges.hash', {}, 'Hash')}</span>
            <strong>${escapeHtml(videoHash || t('toolbox.autoSubs.badges.pending', {}, 'pending'))}</strong>
          </div>
        </div>
      </div>
    </header>

    <section class="section-grid">
      <div class="card section centered-section" id="step1Card">
        <div class="section-head">
          <div class="step-header">
            <div class="step-title-row">
              <span class="step-chip">${escapeHtml(copy.step1.chip)}</span>
              <h3>${escapeHtml(copy.step1.title)}</h3>
            </div>
            ${step1Helper ? `<p class="muted step-helper">${escapeHtml(step1Helper)}</p>` : ''}
          </div>
        </div>
        <div class="step-stack">
          <div class="linked-stream-wrapper">
            <div class="video-meta" id="linked-stream-card">
              <p class="video-meta-label">${escapeHtml(copy.videoMeta.label)}</p>
              <p class="video-meta-title" id="video-meta-title">${initialVideoTitle}</p>
              <p class="video-meta-subtitle" id="video-meta-subtitle">${initialVideoSubtitle}</p>
            </div>
          </div>
            <div class="field-block form-group">
              <label for="stream-url">${escapeHtml(copy.step1.streamLabel)}</label>
              <input type="text" id="stream-url" placeholder="${escapeHtml(copy.step1.streamPlaceholder)}">
            </div>
            <div class="log-alert" id="hash-mismatch-alert" style="display:none;" role="status" aria-live="polite"></div>
            <div class="mode-controls">
              <label for="extract-mode">${escapeHtml(copy.step1.modeLabel)}</label>
              <select id="extract-mode" class="compact-select">
                <option value="smart">${escapeHtml(copy.step1.modeSmart)}</option>
                <option value="complete">${escapeHtml(copy.step1.modeComplete)}</option>
              </select>
              <p class="mode-helper">${modeHelperHtml}</p>
              <button id="extract-btn" type="button" class="secondary">${escapeHtml(copy.step1.extractButton)}</button>
            </div>
          <div class="log-header" aria-hidden="true">
            <span class="pulse"></span>
            <span class="label">${escapeHtml(copy.step1.logHeader)}</span>
            <span>${escapeHtml(copy.step1.logSub)}</span>
          </div>
          <div class="log" id="extract-log" aria-live="polite"></div>

          <div class="result-box">
            <div class="result-head">
              <div>
                <div class="eyebrow">${escapeHtml(copy.step1.outputsEyebrow)}</div>
                <h4>${escapeHtml(copy.step1.outputsTitle)}</h4>
              </div>
            </div>
            <div id="extracted-downloads" class="downloads"></div>
            <div class="result-empty" id="extracted-empty">${escapeHtml(copy.step1.outputsEmpty)}</div>
          </div>
        </div>
      </div>

      <div class="card section centered-section is-disabled locked" id="step2Card" data-locked-label="${escapeHtml(copy.locks.needExtraction)}">
        <div class="section-head">
          <div class="step-header">
            <div class="step-title-row">
              <span class="step-chip">${escapeHtml(copy.step2.chip)}</span>
              <h3>${escapeHtml(copy.step2.title)}</h3>
            </div>
            <p class="muted step-helper">${escapeHtml(copy.step2.helper)}</p>
          </div>
        </div>

        <div class="selected-track-box">
          <p class="selected-track-label">${escapeHtml(copy.step2.selectedLabel)}</p>
          <p id="selected-track-summary" class="selected-track-placeholder">${escapeHtml(copy.step2.selectedPlaceholder)}</p>
        </div>

        <div class="select-stack target-select-stack">
          <label for="target-select">${escapeHtml(copy.step2.targetLabel)}</label>
          <select id="target-select" class="target-select"></select>
        </div>

        <details class="translation-settings">
          <summary>
            <div>
              <span>${escapeHtml(copy.step2.settingsTitle)}</span>
              <span class="summary-meta">${escapeHtml(copy.step2.settingsMeta)}</span>
            </div>
            <span class="chevron" aria-hidden="true"></span>
          </summary>
          <div class="translation-settings-body">
            <div class="provider-model-row">
              <div class="select-stack">
                <label for="provider-select">${escapeHtml(copy.step2.providerLabel)}</label>
                <select id="provider-select" style="width:auto; min-width:200px; max-width:360px;"></select>
              </div>
            </div>
            <p class="muted" style="margin:0; text-align:center;">${escapeHtml(copy.step2.providerHelper)}</p>

            <div class="flex" style="flex-direction:column; gap:12px; align-items:center; width:100%;">
              <div style="display:flex; flex-direction:column; gap:6px; align-items:center; width:100%; max-width:300px;">
                <label for="single-batch-select" style="font-weight:600; margin:0;">${escapeHtml(copy.step2.batchingLabel)}</label>
                <select id="single-batch-select" class="compact-select" style="width:100%;">
                  <option value="multi">${escapeHtml(copy.step2.batchingMultiple)}</option>
                  <option value="single">${escapeHtml(copy.step2.batchingSingle)}</option>
                </select>
              </div>
              <div style="display:flex; flex-direction:column; gap:6px; align-items:center; width:100%; max-width:300px;">
                <label for="timestamps-select" style="font-weight:600; margin:0;">${escapeHtml(copy.step2.timestampsLabel)}</label>
                <select id="timestamps-select" class="compact-select" style="width:100%;">
                  <option value="original">${escapeHtml(copy.step2.timestampsOriginal)}</option>
                  <option value="send">${escapeHtml(copy.step2.timestampsSend)}</option>
                </select>
              </div>
            </div>
          </div>
        </details>

        <div class="flex" style="margin-top:10px; flex-direction:column; align-items:center; gap:6px;">
          <p class="muted" id="translation-context" style="margin:0; text-align:center; width:100%;">${initialTranslationContext}</p>
          <button id="translate-btn" type="button">${escapeHtml(copy.step2.translateButton)}</button>
        </div>

        <div class="log-header" aria-hidden="true">
          <span class="pulse"></span>
          <span class="label">${escapeHtml(copy.step2.logHeader)}</span>
          <span>${escapeHtml(copy.step2.logSub)}</span>
        </div>
        <div class="log" id="translate-log" style="margin-top:8px;" aria-live="polite"></div>

        <div class="result-box">
          <div class="result-head">
            <div>
              <div class="eyebrow">${escapeHtml(copy.step2.outputsEyebrow)}</div>
              <h4>${escapeHtml(copy.step2.outputsTitle)}</h4>
            </div>
          </div>
          <div id="translated-downloads" class="downloads"></div>
          <div class="result-empty" id="translated-empty">${escapeHtml(copy.step2.outputsEmpty)}</div>
          <div class="notice" id="reload-hint" style="display:none;">${escapeHtml(copy.step2.reloadHint)}</div>
        </div>
      </div>
    </section>
  </div>

  <script src="/js/subtitle-menu.js?v=${escapeHtml(appVersion || 'dev')}"></script>
  <script src="/js/combobox.js"></script>
  <script>
    ${quickNavScript()}
    if (window.ComboBox && typeof window.ComboBox.enhanceAll === 'function') {
      window.ComboBox.enhanceAll(document);
    }
    const BOOTSTRAP = ${safeJsonSerialize(bootstrap)};
    const PAGE = { configStr: BOOTSTRAP.configStr, videoId: BOOTSTRAP.videoId, filename: BOOTSTRAP.filename || '', videoHash: BOOTSTRAP.videoHash || '' };
    const tt = (key, vars = {}, fallback = '') => window.t ? window.t(key, vars, fallback || key) : (fallback || key);
    const metaCopy = BOOTSTRAP.strings?.videoMeta || {};
    const metaTemplates = {
      title: metaCopy.title || 'Title: {title}',
      videoId: metaCopy.videoId || 'Video ID: {id}',
      episode: metaCopy.episode || 'Episode: {episode}',
      file: metaCopy.file || 'File: {file}',
      none: metaCopy.none || 'No stream linked',
      waiting: metaCopy.waiting || 'Waiting for a linked stream...',
      unavailable: metaCopy.unavailable || 'Video ID unavailable'
    };
    const statusLabels = BOOTSTRAP.strings?.statusLabels || {};
    const buttonCopy = BOOTSTRAP.strings?.buttons || {};
    const translationContextTemplate = BOOTSTRAP.strings?.translationContextTemplate || "You're translating subtitles for {label}";
    const translationContextFallback = BOOTSTRAP.strings?.translationContextFallback || 'your linked stream';
    const hashMismatchStrings = BOOTSTRAP.strings?.hashMismatch || {};
    const lockCopy = BOOTSTRAP.strings?.locks || {};
    const HASH_ALERT_DEFAULTS = ${JSON.stringify(hashAlertLines)};
    const HASH_MISMATCH_LINES = Array.isArray(hashMismatchStrings.alertLines) && hashMismatchStrings.alertLines.length
      ? hashMismatchStrings.alertLines.filter(Boolean)
      : (HASH_ALERT_DEFAULTS.length
        ? HASH_ALERT_DEFAULTS
        : [tt('toolbox.embedded.step1.hashMismatchLine1', {}, 'Hashes must match before extraction can start.')]);
    const HASH_MISMATCH_INLINE = hashMismatchStrings.inline || '';
    const HASH_STATUS_COPY = {
      neutralTitle: hashMismatchStrings.neutralTitle || tt('toolbox.embedded.step1.hashStatus.neutralTitle', {}, 'Hash check ready'),
      neutralBody: hashMismatchStrings.neutralBody || tt('toolbox.embedded.step1.hashStatus.neutralBody', {}, 'Paste the stream URL to compare with your linked stream.'),
      waitingTitle: hashMismatchStrings.waitingTitle || tt('toolbox.embedded.step1.hashStatus.waitingTitle', {}, 'Paste a stream URL to compare hashes.'),
      validTitle: hashMismatchStrings.validTitle || tt('toolbox.embedded.step1.hashStatus.validTitle', {}, 'Hashes match'),
      validBody: hashMismatchStrings.validBody || tt('toolbox.embedded.step1.hashStatus.validBody', {}, 'Hashes match. You can extract subtitles now.')
    };
    const escapeHtmlClient = (value) => {
      if (value === undefined || value === null) return '';
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&#39;');
    };
    function formatMetaLabel(type, value) {
      if (!value) return '';
      const template = metaTemplates[type] || '{value}';
      const fallback = template
        .replace('{title}', value)
        .replace('{id}', value)
        .replace('{episode}', value)
        .replace('{file}', value);
      const vars = type === 'videoId'
        ? { id: value }
        : (type === 'episode' ? { episode: value } : (type === 'file' ? { file: value } : { title: value }));
      return tt('toolbox.embedded.meta.' + (type === 'videoId' ? 'videoId' : type), vars, fallback);
    }
    function statusLabel(key) {
      if (!key) return '';
      const norm = String(key).toLowerCase();
      const fallback = statusLabels[norm] || norm;
      return tt('toolbox.embedded.status.' + norm, {}, fallback);
    }
    function normalizeTargetLangCode(lang) {
      return (lang || '').toString().trim().toLowerCase();
    }
    function mergeTargetOptions(primary = [], secondary = []) {
      const merged = [];
      const seen = new Set();
      const push = (opt) => {
        if (!opt) return;
        const code = normalizeTargetLangCode(opt.code || opt.value || opt.lang || '');
        if (!code || seen.has(code)) return;
        seen.add(code);
        merged.push({
          code,
          name: opt.name || opt.label || opt.languageLabel || opt.text || code,
          source: opt.source || ''
        });
      };
      (primary || []).forEach(push);
      (secondary || []).forEach(push);
      return merged;
    }
    const baseTargetOptions = mergeTargetOptions(BOOTSTRAP.targetLanguages || [], []);
    const state = {
      extensionReady: false,
      extractionInFlight: false,
      translationInFlight: false,
      tracks: [],
      currentBatchId: null,
      selectedTrackId: null,
      selectedTargetLang: baseTargetOptions[0]?.code || null,
      extractMode: 'complete',
      targets: {},
      downloads: [],
      activeTranslations: 0,
      queue: [],
      step2Enabled: false,
      lastProgressStatus: null,  // Track last logged progress message to prevent spam
      extractMessageId: null,
      targetOptions: baseTargetOptions,
      placeholderBlocked: isPlaceholderStreamValue(PAGE.videoId) || isPlaceholderStreamValue(PAGE.filename),
      cacheBlocked: false,
      cacheBlockInfo: null,
      streamHashInfo: null,
      hashMismatchBlocked: false,
      hashMismatchInfo: null,
      hashMismatchLogged: false
    };
    const translatedHistory = new Set();
    const instructionsEls = {
      overlay: document.getElementById('embeddedInstructionsModal'),
      help: document.getElementById('embeddedHelp'),
      close: document.getElementById('closeEmbeddedInstructions'),
      gotIt: document.getElementById('gotItEmbeddedInstructions'),
      dontShow: document.getElementById('dontShowEmbeddedInstructions')
    };
    const INSTRUCTIONS_KEY = 'submaker_embedded_instructions_visited';
    const INSTRUCTIONS_ACK = 'ack';
    const INSTRUCTIONS_HIDE = 'hide';
    const EXTRACT_MODE_KEY = 'submaker_embedded_extract_mode';
    const EXTRACT_WATCHDOG_MS = 5 * 60 * 1000; // keep extraction alive while progress flows
    let subtitleMenuInstance = null;
    let extractWatchdogTimer = null;
    let lastExtensionLabel = '';
    let pendingStreamUpdate = null;

    function requestExtensionReset(reason) {
      try {
        window.postMessage({
          type: 'SUBMAKER_EMBEDDED_RESET',
          source: 'webpage',
          reason: reason || ''
        }, '*');
      } catch (_) {}
    }

    function refreshExtractionWatchdog() {
      if (extractWatchdogTimer) {
        clearTimeout(extractWatchdogTimer);
        extractWatchdogTimer = null;
      }
      if (!state.extractionInFlight) return;
      extractWatchdogTimer = setTimeout(handleExtractionTimeout, EXTRACT_WATCHDOG_MS);
    }

    function setInstructionLock(active) {
      document.body.classList.toggle('modal-open', !!active);
    }

    function openInstructions(auto = false) {
      if (!instructionsEls.overlay) return;
      instructionsEls.overlay.classList.add('show');
      instructionsEls.overlay.style.display = 'flex';
      setInstructionLock(true);
    }

    function closeInstructions(acknowledge = false) {
      if (instructionsEls.overlay) {
        instructionsEls.overlay.classList.remove('show');
        instructionsEls.overlay.style.display = 'none';
      }
      setInstructionLock(false);
      // Persist preference: honor explicit opt-out, otherwise mark as seen
      const shouldHide = !!instructionsEls.dontShow?.checked;
      if (shouldHide) {
        setInstructionPref(INSTRUCTIONS_HIDE);
      } else if (acknowledge) {
        setInstructionPref(INSTRUCTIONS_ACK);
      }
    }

    function normalizeExtractModeValue(mode) {
      const cleaned = String(mode || '')
        .trim()
        .toLowerCase()
        .replace(/[-_\s]*v2$/, '')      // strip legacy -v2/_v2 suffix
        .replace(/[-_\s]+/g, '-');      // align separators for comparisons
      if (cleaned === 'smart') return 'smart';
      if (cleaned === 'complete' || cleaned === 'full' || cleaned === 'fullfetch') return 'complete';
      return null;
    }

    function loadExtractMode() {
      try {
        const stored = localStorage.getItem(EXTRACT_MODE_KEY);
        const normalized = normalizeExtractModeValue(stored);
        if (normalized) {
          if (normalized !== stored) persistExtractMode(normalized);
          return normalized;
        }
      } catch (_) {}
      return 'complete';
    }

    function persistExtractMode(mode) {
      const normalized = normalizeExtractModeValue(mode);
      if (!normalized) return;
      try { localStorage.setItem(EXTRACT_MODE_KEY, normalized); } catch (_) {}
    }

    function computeLocalVideoHash(payload = {}) {
      const base = [normalizeStreamValue(payload.filename), normalizeStreamValue(payload.videoId)].filter(Boolean).join('::');
      if (!base) return '';
      let hash = 0;
      for (let i = 0; i < base.length; i++) {
        hash = (hash * 31 + base.charCodeAt(i)) >>> 0;
      }
      return Math.abs(hash).toString(16).padStart(8, '0');
    }

    // Lightweight MD5 implementation (client-side) to mirror deriveVideoHash on the server
    function md5hex(str) {
      function rotateLeft(lValue, iShiftBits) { return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits)); }
      function addUnsigned(lX, lY) {
        const lX4 = lX & 0x40000000;
        const lY4 = lY & 0x40000000;
        const lX8 = lX & 0x80000000;
        const lY8 = lY & 0x80000000;
        const lResult = (lX & 0x3FFFFFFF) + (lY & 0x3FFFFFFF);
        if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8;
        if (lX4 | lY4) {
          if (lResult & 0x40000000) return lResult ^ 0xC0000000 ^ lX8 ^ lY8;
          return lResult ^ 0x40000000 ^ lX8 ^ lY8;
        }
        return lResult ^ lX8 ^ lY8;
      }
      function F(x, y, z) { return (x & y) | (~x & z); }
      function G(x, y, z) { return (x & z) | (y & ~z); }
      function H(x, y, z) { return x ^ y ^ z; }
      function I(x, y, z) { return y ^ (x | ~z); }
      function FF(a, b, c, d, x, s, ac) { a = addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac)); return addUnsigned(rotateLeft(a, s), b); }
      function GG(a, b, c, d, x, s, ac) { a = addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac)); return addUnsigned(rotateLeft(a, s), b); }
      function HH(a, b, c, d, x, s, ac) { a = addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac)); return addUnsigned(rotateLeft(a, s), b); }
      function II(a, b, c, d, x, s, ac) { a = addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac)); return addUnsigned(rotateLeft(a, s), b); }
      function convertToWordArray(strVal) {
        const lWordCount = [];
        let lMessageLength = strVal.length;
        let lNumberOfWordsTempOne = lMessageLength + 8;
        const lNumberOfWordsTempTwo = (lNumberOfWordsTempOne - (lNumberOfWordsTempOne % 64)) / 64;
        const lNumberOfWords = (lNumberOfWordsTempTwo + 1) * 16;
        for (let i = 0; i < lNumberOfWords; i++) lWordCount[i] = 0;
        let lBytePosition = 0;
        let lByteCount = 0;
        while (lByteCount < lMessageLength) {
          const lWordCountIndex = (lByteCount - (lByteCount % 4)) / 4;
          lBytePosition = (lByteCount % 4) * 8;
          lWordCount[lWordCountIndex] |= strVal.charCodeAt(lByteCount) << lBytePosition;
          lByteCount++;
        }
        const lWordCountIndex = (lByteCount - (lByteCount % 4)) / 4;
        lBytePosition = (lByteCount % 4) * 8;
        lWordCount[lWordCountIndex] |= 0x80 << lBytePosition;
        lWordCount[lNumberOfWords - 2] = lMessageLength << 3;
        lWordCount[lNumberOfWords - 1] = lMessageLength >>> 29;
        return lWordCount;
      }
      function wordToHex(lValue) {
        let wordToHexValue = '';
        for (let lCount = 0; lCount <= 3; lCount++) {
          const lByte = (lValue >>> (lCount * 8)) & 255;
          const wordToHexValueTemp = '0' + lByte.toString(16);
          wordToHexValue += wordToHexValueTemp.substr(wordToHexValueTemp.length - 2, 2);
        }
        return wordToHexValue;
      }
      function utf8Encode(string) {
        // Escape CRLF so the regex remains valid in the generated inline script
        string = string.replace(/\\r\\n/g, '\\n');
        let utftext = '';
        for (let n = 0; n < string.length; n++) {
          const c = string.charCodeAt(n);
          if (c < 128) utftext += String.fromCharCode(c);
          else if (c < 2048) {
            utftext += String.fromCharCode((c >> 6) | 192);
            utftext += String.fromCharCode((c & 63) | 128);
          } else {
            utftext += String.fromCharCode((c >> 12) | 224);
            utftext += String.fromCharCode(((c >> 6) & 63) | 128);
            utftext += String.fromCharCode((c & 63) | 128);
          }
        }
        return utftext;
      }
      const x = convertToWordArray(utf8Encode(str));
      let a = 0x67452301;
      let b = 0xEFCDAB89;
      let c = 0x98BADCFE;
      let d = 0x10325476;
      for (let k = 0; k < x.length; k += 16) {
        const AA = a; const BB = b; const CC = c; const DD = d;
        a = FF(a, b, c, d, x[k + 0], 7, 0xD76AA478);
        d = FF(d, a, b, c, x[k + 1], 12, 0xE8C7B756);
        c = FF(c, d, a, b, x[k + 2], 17, 0x242070DB);
        b = FF(b, c, d, a, x[k + 3], 22, 0xC1BDCEEE);
        a = FF(a, b, c, d, x[k + 4], 7, 0xF57C0FAF);
        d = FF(d, a, b, c, x[k + 5], 12, 0x4787C62A);
        c = FF(c, d, a, b, x[k + 6], 17, 0xA8304613);
        b = FF(b, c, d, a, x[k + 7], 22, 0xFD469501);
        a = FF(a, b, c, d, x[k + 8], 7, 0x698098D8);
        d = FF(d, a, b, c, x[k + 9], 12, 0x8B44F7AF);
        c = FF(c, d, a, b, x[k + 10], 17, 0xFFFF5BB1);
        b = FF(b, c, d, a, x[k + 11], 22, 0x895CD7BE);
        a = FF(a, b, c, d, x[k + 12], 7, 0x6B901122);
        d = FF(d, a, b, c, x[k + 13], 12, 0xFD987193);
        c = FF(c, d, a, b, x[k + 14], 17, 0xA679438E);
        b = FF(b, c, d, a, x[k + 15], 22, 0x49B40821);
        a = GG(a, b, c, d, x[k + 1], 5, 0xF61E2562);
        d = GG(d, a, b, c, x[k + 6], 9, 0xC040B340);
        c = GG(c, d, a, b, x[k + 11], 14, 0x265E5A51);
        b = GG(b, c, d, a, x[k + 0], 20, 0xE9B6C7AA);
        a = GG(a, b, c, d, x[k + 5], 5, 0xD62F105D);
        d = GG(d, a, b, c, x[k + 10], 9, 0x02441453);
        c = GG(c, d, a, b, x[k + 15], 14, 0xD8A1E681);
        b = GG(b, c, d, a, x[k + 4], 20, 0xE7D3FBC8);
        a = GG(a, b, c, d, x[k + 9], 5, 0x21E1CDE6);
        d = GG(d, a, b, c, x[k + 14], 9, 0xC33707D6);
        c = GG(c, d, a, b, x[k + 3], 14, 0xF4D50D87);
        b = GG(b, c, d, a, x[k + 8], 20, 0x455A14ED);
        a = GG(a, b, c, d, x[k + 13], 5, 0xA9E3E905);
        d = GG(d, a, b, c, x[k + 2], 9, 0xFCEFA3F8);
        c = GG(c, d, a, b, x[k + 7], 14, 0x676F02D9);
        b = GG(b, c, d, a, x[k + 12], 20, 0x8D2A4C8A);
        a = HH(a, b, c, d, x[k + 5], 4, 0xFFFA3942);
        d = HH(d, a, b, c, x[k + 8], 11, 0x8771F681);
        c = HH(c, d, a, b, x[k + 11], 16, 0x6D9D6122);
        b = HH(b, c, d, a, x[k + 14], 23, 0xFDE5380C);
        a = HH(a, b, c, d, x[k + 1], 4, 0xA4BEEA44);
        d = HH(d, a, b, c, x[k + 4], 11, 0x4BDECFA9);
        c = HH(c, d, a, b, x[k + 7], 16, 0xF6BB4B60);
        b = HH(b, c, d, a, x[k + 10], 23, 0xBEBFBC70);
        a = HH(a, b, c, d, x[k + 13], 4, 0x289B7EC6);
        d = HH(d, a, b, c, x[k + 0], 11, 0xEAA127FA);
        c = HH(c, d, a, b, x[k + 3], 16, 0xD4EF3085);
        b = HH(b, c, d, a, x[k + 6], 23, 0x04881D05);
        a = HH(a, b, c, d, x[k + 9], 4, 0xD9D4D039);
        d = HH(d, a, b, c, x[k + 12], 11, 0xE6DB99E5);
        c = HH(c, d, a, b, x[k + 15], 16, 0x1FA27CF8);
        b = HH(b, c, d, a, x[k + 2], 23, 0xC4AC5665);
        a = II(a, b, c, d, x[k + 0], 6, 0xF4292244);
        d = II(d, a, b, c, x[k + 7], 10, 0x432AFF97);
        c = II(c, d, a, b, x[k + 14], 15, 0xAB9423A7);
        b = II(b, c, d, a, x[k + 5], 21, 0xFC93A039);
        a = II(a, b, c, d, x[k + 12], 6, 0x655B59C3);
        d = II(d, a, b, c, x[k + 3], 10, 0x8F0CCC92);
        c = II(c, d, a, b, x[k + 10], 15, 0xFFEFF47D);
        b = II(b, c, d, a, x[k + 1], 21, 0x85845DD1);
        a = II(a, b, c, d, x[k + 8], 6, 0x6FA87E4F);
        d = II(d, a, b, c, x[k + 15], 10, 0xFE2CE6E0);
        c = II(c, d, a, b, x[k + 6], 15, 0xA3014314);
        b = II(b, c, d, a, x[k + 13], 21, 0x4E0811A1);
        a = II(a, b, c, d, x[k + 4], 6, 0xF7537E82);
        d = II(d, a, b, c, x[k + 11], 10, 0xBD3AF235);
        c = II(c, d, a, b, x[k + 2], 15, 0x2AD7D2BB);
        b = II(b, c, d, a, x[k + 9], 21, 0xEB86D391);
        a = addUnsigned(a, AA);
        b = addUnsigned(b, BB);
        c = addUnsigned(c, CC);
        d = addUnsigned(d, DD);
      }
      return (wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)).toLowerCase();
    }

    function deriveVideoHashFromParts(filename, videoId) {
      const name = (filename && String(filename).trim()) || '';
      const fallback = (videoId && String(videoId).trim()) || '';
      const base = [name, fallback].filter(Boolean).join('::');
      if (!base) return '';
      return md5hex(base).substring(0, 16);
    }

    function extractStreamFilename(streamUrl) {
      try {
        const url = new URL(streamUrl);
        const paramKeys = ['filename', 'file', 'name', 'download', 'dn'];
        for (const key of paramKeys) {
          const val = url.searchParams.get(key);
          if (val && val.trim()) return decodeURIComponent(val.trim().split('/').pop());
        }
        const parts = (url.pathname || '').split('/').filter(Boolean);
        if (!parts.length) return '';
        return decodeURIComponent(parts[parts.length - 1]);
      } catch (_) {
        return '';
      }
    }

    function normalizeVideoIdCandidate(value) {
      if (!value) return '';
      const trimmed = String(value).trim();
      if (/^tt\d+$/i.test(trimmed)) return trimmed.toLowerCase().startsWith('tt') ? trimmed : 'tt' + trimmed;
      if (/^\d+$/.test(trimmed) && trimmed.length >= 5) return 'tt' + trimmed;
      return trimmed;
    }

    function extractStreamVideoId(streamUrl) {
      try {
        const url = new URL(streamUrl);
        const paramKeys = ['videoId', 'video', 'id', 'mediaid', 'imdb', 'tmdb', 'kitsu', 'anidb', 'mal', 'anilist'];
        for (const key of paramKeys) {
          const val = url.searchParams.get(key);
          if (val && val.trim()) return normalizeVideoIdCandidate(val);
        }
        const parts = (url.pathname || '').split('/').filter(Boolean);
        const directId = parts.find(p => /^tt\d+/i.test(p) || p.includes(':'));
        if (directId) return normalizeVideoIdCandidate(directId);
        return '';
      } catch (_) {
        return '';
      }
    }

    function deriveStreamHashFromUrl(streamUrl, fallback = {}) {
      const filename = extractStreamFilename(streamUrl) || fallback.filename || fallback.streamFilename || '';
      const streamVideoId = extractStreamVideoId(streamUrl) || fallback.videoId || '';
      const hash = deriveVideoHashFromParts(filename, streamVideoId);
      return {
        hash,
        filename,
        videoId: streamVideoId,
        source: 'stream-url'
      };
    }

    function syncVideoHash(payload = {}) {
      const next = normalizeStreamValue(payload.videoHash) || computeLocalVideoHash(payload) || BOOTSTRAP.videoHash || '';
      if (next) {
        PAGE.videoHash = next;
        BOOTSTRAP.videoHash = next;
      }
      return PAGE.videoHash || '';
    }

    function getInstructionPref() {
      try { return localStorage.getItem(INSTRUCTIONS_KEY) || ''; } catch (_) { return ''; }
    }

    function setInstructionPref(value) {
      try { localStorage.setItem(INSTRUCTIONS_KEY, value); } catch (_) {}
    }

    function initInstructions() {
      const pref = getInstructionPref();
      const hasVisited = pref === INSTRUCTIONS_ACK || pref === INSTRUCTIONS_HIDE;
      const skipAuto = pref === INSTRUCTIONS_HIDE;

      // Always show the help button
      if (instructionsEls.help) {
        instructionsEls.help.addEventListener('click', () => openInstructions(false));
        instructionsEls.help.style.display = 'flex';
      }
      if (instructionsEls.close) instructionsEls.close.addEventListener('click', () => closeInstructions(true));
      if (instructionsEls.gotIt) instructionsEls.gotIt.addEventListener('click', () => closeInstructions(true));
      if (instructionsEls.dontShow) {
        instructionsEls.dontShow.checked = pref === INSTRUCTIONS_HIDE;
        instructionsEls.dontShow.addEventListener('change', (ev) => {
          if (ev.target?.checked) setInstructionPref(INSTRUCTIONS_HIDE);
        });
      }
      if (instructionsEls.overlay) {
        instructionsEls.overlay.addEventListener('click', (ev) => {
          if (ev.target === instructionsEls.overlay) closeInstructions(true);
        });
      }
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && instructionsEls.overlay && instructionsEls.overlay.classList.contains('show')) {
          closeInstructions(true);
        }
      });

      // Only auto-show on first visit
      if (!hasVisited && !skipAuto) {
        setTimeout(() => openInstructions(true), 250);
      }
    }

    function normalizeStreamValue(val) {
      return (val || '').toString().trim();
    }

    function isPlaceholderStreamValue(val) {
      const normalized = normalizeStreamValue(val).toLowerCase();
      return normalized === 'stream and refresh';
    }

    function hasActiveStreamWork() {
      return state.extractionInFlight || state.translationInFlight || state.activeTranslations > 0 || (state.queue && state.queue.length > 0);
    }

    function hasStreamOutputs() {
      return (state.tracks && state.tracks.length > 0) ||
        (state.targets && Object.keys(state.targets).length > 0) ||
        (state.downloads && state.downloads.length > 0);
    }

    function getStreamSignature(source = {}) {
      const videoId = normalizeStreamValue(source.videoId !== undefined ? source.videoId : PAGE.videoId);
      const filename = normalizeStreamValue(source.filename !== undefined ? source.filename : PAGE.filename);
      return [videoId, filename].join('::');
    }

    function initSubtitleMenuBridge() {
      if (!window.SubtitleMenu || typeof window.SubtitleMenu.mount !== 'function') return null;
      try {
        return window.SubtitleMenu.mount({
          configStr: PAGE.configStr,
          videoId: PAGE.videoId,
          filename: PAGE.filename,
          videoHash: PAGE.videoHash,
          targetOptions: state.targetOptions,
          sourceLanguages: BOOTSTRAP.sourceLanguages || [],
          targetLanguages: BOOTSTRAP.targetLanguageCodes || [],
          languageMaps: BOOTSTRAP.languageMaps,
          getVideoHash,
          onTargetsHydrated: (merged) => setTargetOptions(mergeTargetOptions(merged || [], []), true)
        });
      } catch (err) {
        console.warn('Subtitle menu init failed', err);
        return null;
      }
    }

    function applyStreamUpdate(payload, opts = {}) {
      const nextSig = opts.signature || getStreamSignature(payload || {});
      const currentSig = getStreamSignature();
      if (!nextSig || nextSig === currentSig) return false;

      PAGE.videoId = normalizeStreamValue(payload.videoId) || PAGE.videoId;
      PAGE.filename = normalizeStreamValue(payload.filename) || PAGE.filename;
      syncVideoHash({
        videoHash: normalizeStreamValue(payload.videoHash),
        filename: PAGE.filename,
        videoId: PAGE.videoId
      });

      pendingStreamUpdate = null;
      setTargetOptions(baseTargetOptions, true);
      updateVideoMeta(PAGE);
      resetExtractionState(true);
      if (els.extractLog) {
        els.extractLog.innerHTML = '';
        const label = opts.logLabel ||
          (window.t ? window.t('toolbox.logs.linkedChanged', {}, 'Linked stream changed. Outputs cleared; run extraction again for the new stream.') : 'Linked stream changed. Outputs cleared; run extraction again for the new stream.');
        logExtract(label);
      }
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
      return true;
    }

    function applyPendingStreamUpdateIfSafe(opts = {}) {
      // Manual apply only (via toast Update/navigation); no auto-apply
      return false;
    }

    function handleStreamUpdateFromNotification(payload) {
      const nextSig = getStreamSignature(payload || {});
      const currentSig = getStreamSignature();
      if (!nextSig || nextSig === currentSig) return;

      pendingStreamUpdate = { payload, signature: nextSig };
    }

    initInstructions();
    subtitleMenuInstance = initSubtitleMenuBridge();
    function forwardMenuNotification(info) {
      if (!subtitleMenuInstance || typeof subtitleMenuInstance.notify !== 'function') return false;
      const message = (info && info.message) ? info.message : tt('toolbox.toast.title', {}, 'New stream detected');
      const title = (info && info.title) ? info.title + ': ' : '';
      subtitleMenuInstance.notify(title + message, 'muted', { persist: true });
      return false; // allow the toast to show in-page
    }
    window.addEventListener('beforeunload', () => {
      requestExtensionReset('page-unload');
    });

    initStreamRefreshButton({
      buttonId: 'quickNavRefresh',
      configStr: PAGE.configStr,
      current: { videoId: PAGE.videoId, filename: PAGE.filename, videoHash: PAGE.videoHash },
      labels: {
        loading: tt('toolbox.refresh.loading', {}, 'Refreshing...'),
        empty: tt('toolbox.refresh.empty', {}, 'No stream yet'),
        error: tt('toolbox.refresh.error', {}, 'Refresh failed'),
        current: tt('toolbox.refresh.current', {}, 'Already latest')
      },
      buildUrl: (payload) => {
        return '/embedded-subtitles?config=' + encodeURIComponent(PAGE.configStr) +
          '&videoId=' + encodeURIComponent(payload.videoId || '') +
          '&filename=' + encodeURIComponent(payload.filename || '');
      }
    });

    function getVideoHash() {
      if (PAGE.videoHash && PAGE.videoHash.length) return PAGE.videoHash;
      if (BOOTSTRAP.videoHash && BOOTSTRAP.videoHash.length) {
        PAGE.videoHash = BOOTSTRAP.videoHash;
        return PAGE.videoHash;
      }
      const fallback = computeLocalVideoHash({
        filename: PAGE.filename || BOOTSTRAP.filename,
        videoId: PAGE.videoId || BOOTSTRAP.videoId
      });
      PAGE.videoHash = fallback;
      BOOTSTRAP.videoHash = fallback;
      return PAGE.videoHash;
    }

    const els = {
      extStatus: document.getElementById('ext-status'),
      extDot: document.getElementById('ext-dot'),
      extLabel: document.getElementById('ext-label'),
      extractLog: document.getElementById('extract-log'),
      translateLog: document.getElementById('translate-log'),
      streamUrl: document.getElementById('stream-url'),
      hashStatus: document.getElementById('hash-status'),
      extractBtn: document.getElementById('extract-btn'),
      targetSelect: document.getElementById('target-select'),
      translateBtn: document.getElementById('translate-btn'),
      translationContext: document.getElementById('translation-context'),
      providerSelect: document.getElementById('provider-select'),
      singleBatch: document.getElementById('single-batch-select'),
      timestamps: document.getElementById('timestamps-select'),
      extractedDownloads: document.getElementById('extracted-downloads'),
      translatedDownloads: document.getElementById('translated-downloads'),
      extractedEmpty: document.getElementById('extracted-empty'),
      translatedEmpty: document.getElementById('translated-empty'),
      reloadHint: document.getElementById('reload-hint'),
      videoMetaTitle: document.getElementById('video-meta-title'),
      videoMetaSubtitle: document.getElementById('video-meta-subtitle'),
      step2Card: document.getElementById('step2Card'),
      selectedTrackSummary: document.getElementById('selected-track-summary'),
      modeSelect: document.getElementById('extract-mode'),
      extractError: document.getElementById('extract-blocked-msg'),
      hashMismatchAlert: document.getElementById('hash-mismatch-alert')
      , hashMismatchInline: document.getElementById('hash-mismatch-inline')
    };
    const tr = (key, vars = {}, fallback = '') => window.t ? window.t(key, vars, fallback || key) : (fallback || key);
    const buttonLabels = {
      extract: buttonCopy.extract || els.extractBtn?.textContent || 'Extract Subtitles',
      translate: buttonCopy.translate || els.translateBtn?.textContent || 'Translate Subtitles'
    };
    const lockReasons = {
      needExtraction: lockCopy?.needExtraction || tr('toolbox.embedded.locks.needExtraction', {}, 'Run Step 1 extraction to unlock translation.'),
      needTrack: lockCopy?.needTrack || tr('toolbox.embedded.locks.needTrack', {}, 'Select an extracted subtitle to unlock translation.')
    };
    let lastStep2LockReason = lockReasons.needExtraction;
    function lockCard(el, label) {
      if (!el) return;
      if (label) el.setAttribute('data-locked-label', label);
      el.classList.add('locked');
      el.classList.add('is-disabled');
      el.setAttribute('aria-disabled', 'true');
      el.inert = true;
    }
    function unlockCard(el) {
      if (!el) return;
      el.classList.remove('locked');
      el.classList.remove('is-disabled');
      el.removeAttribute('aria-disabled');
      el.inert = false;
      el.removeAttribute('inert');
    }
    const EXT_INSTALL_URL = 'https://chromewebstore.google.com/detail/submaker-xsync/lpocanpndchjkkpgchefobjionncknjn';

    if (els.extractLog) els.extractLog.innerHTML = '';
    if (els.translateLog) els.translateLog.innerHTML = '';
    renderHashStatus(getVideoHash(), state.streamHashInfo?.hash || '');

    state.extractMode = loadExtractMode();
    if (els.modeSelect) {
      if (state.extractMode !== 'smart' && state.extractMode !== 'complete') {
        state.extractMode = 'complete';
      }
      els.modeSelect.value = state.extractMode;
    }

    const linkedTitleCache = new Map();
    let linkedTitleRequestId = 0;

    function cleanVideoName(raw) {
      if (!raw) return '';
      return raw.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]/g, ' ').trim();
    }

    function normalizeImdbId(id) {
      if (!id) return '';
      const trimmed = String(id).trim();
      if (trimmed.startsWith('tt')) return trimmed;
      if (/^\\d+$/.test(trimmed)) return 'tt' + trimmed;
      return trimmed;
    }

    function parseVideoId(id) {
      if (!id) return null;
      const parts = String(id).split(':');
      if (/^(anidb|kitsu|mal|anilist)/.test(parts[0])) {
        return {
          type: 'anime',
          animeId: parts[0],
          season: parts.length === 4 ? parseInt(parts[2], 10) : undefined,
          episode: parts.length >= 3 ? parseInt(parts[parts.length - 1], 10) : undefined
        };
      }
      if (parts[0] === 'tmdb') {
        return {
          type: parts.length >= 3 ? 'episode' : 'movie',
          tmdbId: parts[1],
          season: parts.length >= 3 ? parseInt(parts[2], 10) : undefined,
          episode: parts.length >= 4 ? parseInt(parts[3], 10) : undefined
        };
      }
      const imdbId = normalizeImdbId(parts[0]);
      if (parts.length >= 3) {
        return {
          type: 'episode',
          imdbId,
          season: parseInt(parts[1], 10),
          episode: parseInt(parts[2], 10)
        };
      }
      return { type: 'movie', imdbId };
    }

    async function fetchLinkedTitle(videoId) {
      const parsed = parseVideoId(videoId);
      if (!parsed) return null;
      const metaType = parsed.type === 'episode' ? 'series' : 'movie';
      const metaId = (() => {
        if (parsed.imdbId && /^tt\d{3,}$/i.test(parsed.imdbId)) return parsed.imdbId.toLowerCase();
        if (parsed.tmdbId) return 'tmdb:' + parsed.tmdbId;
        return null;
      })();
      if (!metaId) return null;
      const key = metaId + ':' + metaType;
      if (BOOTSTRAP.videoId === videoId && BOOTSTRAP.linkedTitle) {
        linkedTitleCache.set(key, BOOTSTRAP.linkedTitle);
        return BOOTSTRAP.linkedTitle;
      }
      if (linkedTitleCache.has(key)) return linkedTitleCache.get(key);
      const metaUrl = 'https://v3-cinemeta.strem.io/meta/' + metaType + '/' + encodeURIComponent(metaId) + '.json';
      try {
        const resp = await fetch(metaUrl);
        if (!resp.ok) throw new Error('Failed to fetch metadata');
        const data = await resp.json();
        const title = data?.meta?.name || data?.meta?.english_name || data?.meta?.nameTranslated?.en || null;
        linkedTitleCache.set(key, title);
        return title;
      } catch (err) {
        linkedTitleCache.set(key, null);
        return null;
      }
    }

    function formatEpisodeTag(videoId) {
      const parts = (videoId || '').split(':');
      if (parts.length >= 3) {
        const season = parseInt(parts[1], 10);
        const episode = parseInt(parts[2], 10);
        const s = Number.isFinite(season) ? 'S' + String(season).padStart(2, '0') : '';
        const e = Number.isFinite(episode) ? 'E' + String(episode).padStart(2, '0') : '';
        if (s || e) return (s + e).trim();
      }
      return '';
    }

    function buildTranslationContextLabel(source = {}) {
      const baseTitle = source.title || cleanVideoName(source.filename) || cleanVideoName(source.videoId) || '';
      const episodeTag = formatEpisodeTag(source.videoId);
      const parts = [baseTitle || '', episodeTag || ''].filter(Boolean);
      return parts.join(' ').trim();
    }

    function updateTranslationContext(source = {}) {
      if (!els.translationContext) return;
      const label = buildTranslationContextLabel(source);
      const targetLabel = label || translationContextFallback;
      const fallback = translationContextTemplate.replace('{label}', targetLabel);
      els.translationContext.textContent = tt('toolbox.embedded.step2.translationContext', { label: targetLabel }, fallback);
    }

    function applyExtractDisabled() {
      if (!els.extractBtn) return;
      const blocked = !!state.placeholderBlocked;
      const hashBlocked = !!state.hashMismatchBlocked;
      const disabled = !!state.extractionInFlight || blocked || hashBlocked;
      els.extractBtn.disabled = disabled;
      const busyLabel = buttonCopy.extracting || tt('toolbox.embedded.buttons.extracting', {}, 'Extracting...');
      els.extractBtn.textContent = state.extractionInFlight ? busyLabel : buttonLabels.extract;
      if (els.extractBtn) {
        if (hashBlocked) {
          els.extractBtn.title = 'Hash mismatch: refresh the linked stream and paste the matching URL to unlock extraction.';
        } else {
          els.extractBtn.removeAttribute('title');
        }
      }
      renderHashMismatchAlert();
    }

    function updatePlaceholderBlock(source = {}) {
      const videoId = normalizeStreamValue(source.videoId !== undefined ? source.videoId : PAGE.videoId);
      const filename = normalizeStreamValue(source.filename !== undefined ? source.filename : PAGE.filename);
      state.placeholderBlocked = isPlaceholderStreamValue(videoId) || isPlaceholderStreamValue(filename);
      applyExtractDisabled();
    }

    async function updateVideoMeta(payload) {
      if (!els.videoMetaTitle || !els.videoMetaSubtitle) return;
      const source = payload || BOOTSTRAP;
      updatePlaceholderBlock(source);
      const title = source.title || cleanVideoName(source.filename) || cleanVideoName(source.videoId) || metaTemplates.none;
      const episodeTag = formatEpisodeTag(source.videoId);
      const fallbackDetails = [];
      if (source.title) {
        fallbackDetails.push(formatMetaLabel('title', source.title));
      } else if (source.videoId) {
        fallbackDetails.push(formatMetaLabel('videoId', source.videoId));
      }
      if (episodeTag) fallbackDetails.push(formatMetaLabel('episode', episodeTag));
      if (source.filename) fallbackDetails.push(formatMetaLabel('file', source.filename));
      els.videoMetaTitle.textContent = title || metaTemplates.none;
      els.videoMetaSubtitle.textContent = fallbackDetails.join(' - ') || metaTemplates.waiting;
      updateTranslationContext({ ...source, title, videoId: source.videoId, filename: source.filename });

      const requestId = ++linkedTitleRequestId;
      const fetchedTitle = source.title || await fetchLinkedTitle(source.videoId);
      if (requestId !== linkedTitleRequestId) return;

      const details = [];
      if (fetchedTitle) {
        details.push(formatMetaLabel('title', fetchedTitle));
      } else if (source.videoId) {
        details.push(formatMetaLabel('videoId', source.videoId));
      }
      if (episodeTag) details.push(formatMetaLabel('episode', episodeTag));
      if (source.filename) details.push(formatMetaLabel('file', source.filename));

      const resolvedTitle = fetchedTitle || title || metaTemplates.none;
      els.videoMetaTitle.textContent = resolvedTitle;
      els.videoMetaSubtitle.textContent = details.join(' - ') || metaTemplates.waiting;
      updateTranslationContext({ ...source, title: resolvedTitle, videoId: source.videoId, filename: source.filename });
      updateHashMismatchState({ log: false });
    }

    function base64ToUint8(base64) {
      try {
        const bin = atob(base64);
        const len = bin.length;
        const out = new Uint8Array(len);
        for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
        return out;
      } catch (e) {
        console.warn('base64 decode failed', e);
        return new Uint8Array();
      }
    }

    function resolveTrackData(track) {
      const isBinary = track.binary || track.codec === 'copy';
      if (isBinary) {
        if (track.contentBytes) {
          return { data: new Uint8Array(track.contentBytes), mime: track.mime || 'application/octet-stream' };
        }
        if (track.contentBase64) {
          return { data: base64ToUint8(track.contentBase64), mime: track.mime || 'application/octet-stream' };
        }
      }
      if (track.contentBase64) {
        return { data: base64ToUint8(track.contentBase64), mime: track.mime || 'text/plain' };
      }
      if (track.content instanceof Uint8Array || track.content instanceof ArrayBuffer) {
        return { data: track.content, mime: track.mime || 'text/plain' };
      }
      return { data: track.content || '', mime: track.mime || 'text/plain' };
    }

    function logExtract(msg) {
      const time = new Date().toLocaleTimeString();
      const logEntry = document.createElement('div');
      logEntry.textContent = '[' + time + '] ' + msg;
      els.extractLog.insertBefore(logEntry, els.extractLog.firstChild);
    }
    function logTranslate(msg) {
      const time = new Date().toLocaleTimeString();
      const logEntry = document.createElement('div');
      logEntry.textContent = '[' + time + '] ' + msg;
      els.translateLog.insertBefore(logEntry, els.translateLog.firstChild);
    }

    function updateReloadHint(visible) {
      if (!els.reloadHint) return;
      if (!visible) {
        els.reloadHint.style.display = 'none';
        return;
      }
      const message = state.cacheBlocked ? copy.step2.reloadHintManual : copy.step2.reloadHint;
      els.reloadHint.textContent = message;
      els.reloadHint.style.display = 'block';
    }

    function buildHashStatusContent(headText, bodyLines = []) {
      const safeHead = escapeHtmlClient(headText || '');
      const bodyHtml = (bodyLines || [])
        .filter(Boolean)
        .map(line => '<div>' + escapeHtmlClient(line) + '</div>')
        .join('');
      const body = bodyHtml ? '<div class="alert-body">' + bodyHtml + '</div>' : '';
      return '<div class="alert-head">' + safeHead + '</div>' + body;
    }

    function buildHashMismatchAlert(linkedHash, streamHash) {
      const safeLinked = escapeHtmlClient(linkedHash || 'unknown');
      const safeStream = escapeHtmlClient(streamHash || 'unknown');
      const head = 'Hash mismatch detected: linked stream (' + safeLinked + ') vs pasted URL (' + safeStream + ').';
      return buildHashStatusContent(head, HASH_MISMATCH_LINES);
    }

    function setHashMismatchAlert(message, opts = {}) {
      if (!els.hashMismatchAlert) return;
      const useHtml = opts.asHtml === true;
      if (!message) {
        els.hashMismatchAlert.style.display = 'none';
        els.hashMismatchAlert.innerHTML = '';
        return;
      }
      if (useHtml) {
        els.hashMismatchAlert.innerHTML = message;
      } else {
        els.hashMismatchAlert.textContent = message;
      }
      els.hashMismatchAlert.style.display = 'block';
    }

    function renderHashMismatchAlert() {
      if (els.hashMismatchAlert) {
        if (state.hashMismatchBlocked && state.hashMismatchInfo) {
          const alertHtml = buildHashMismatchAlert(state.hashMismatchInfo.linked, state.hashMismatchInfo.stream);
          setHashMismatchAlert(alertHtml, { asHtml: true });
        } else if (!state.cacheBlocked) {
          setHashMismatchAlert('');
        }
      }
      if (els.hashMismatchInline) {
        els.hashMismatchInline.textContent = HASH_MISMATCH_INLINE;
        els.hashMismatchInline.style.display = (state.hashMismatchBlocked || state.cacheBlocked) ? 'block' : 'none';
      }
    }

    function renderHashStatus(linkedHash, streamHash) {
      if (!els.hashStatus) return;
      const linked = linkedHash || getVideoHash() || '';
      const stream = streamHash || state.streamHashInfo?.hash || '';
      const mismatchInfo = state.cacheBlocked ? (state.cacheBlockInfo || state.hashMismatchInfo) : state.hashMismatchInfo;
      const resolvedLinked = mismatchInfo?.linked || linked;
      const resolvedStream = mismatchInfo?.stream || stream;
      const hasLinked = !!resolvedLinked;
      const hasStream = !!resolvedStream;
      const hasMismatch = (state.hashMismatchBlocked || state.cacheBlocked)
        ? (hasLinked && hasStream && resolvedLinked !== resolvedStream)
        : (hasLinked && hasStream && resolvedLinked !== resolvedStream);
      const hasMatch = hasLinked && hasStream && resolvedLinked === resolvedStream;

      let tone = 'neutral';
      let head = HASH_STATUS_COPY.neutralTitle;
      let bodyLines = [HASH_STATUS_COPY.neutralBody || HASH_MISMATCH_LINES[0], HASH_MISMATCH_LINES[1]].filter(Boolean);

      if (hasMismatch) {
        tone = 'danger';
        head = 'Hash mismatch detected: linked stream (' + (resolvedLinked || 'unknown') + ') vs pasted URL (' + (resolvedStream || 'unknown') + ').';
        bodyLines = HASH_MISMATCH_LINES;
      } else if (hasMatch) {
        tone = 'success';
        const hashLabel = resolvedLinked || resolvedStream;
        head = HASH_STATUS_COPY.validTitle || 'Hashes match';
        bodyLines = [
          HASH_STATUS_COPY.validBody || 'Linked and pasted hashes match.',
          hashLabel ? 'Hash: ' + hashLabel : null
        ].filter(Boolean);
      } else if (!hasStream) {
        head = HASH_STATUS_COPY.waitingTitle || HASH_STATUS_COPY.neutralTitle;
        bodyLines = [HASH_STATUS_COPY.neutralBody || HASH_MISMATCH_LINES[0], HASH_MISMATCH_LINES[1]].filter(Boolean);
      }

      els.hashStatus.classList.remove('warn', 'danger', 'success', 'neutral');
      els.hashStatus.classList.add(tone);
      els.hashStatus.innerHTML = buildHashStatusContent(head, bodyLines);
    }

    function updateHashMismatchState(opts = {}) {
      const streamUrl = typeof opts.streamUrl === 'string' ? opts.streamUrl : (els.streamUrl?.value || '');
      const trimmedUrl = (streamUrl || '').trim();
      const linkedHash = getVideoHash();
      const fallback = { videoId: PAGE.videoId || BOOTSTRAP.videoId, filename: PAGE.filename || BOOTSTRAP.filename };
      const streamHashInfo = trimmedUrl ? deriveStreamHashFromUrl(trimmedUrl, fallback) : { hash: '', filename: '', videoId: '', source: 'stream-url' };
      const hasStreamHash = !!streamHashInfo.hash;
      const hasLinkedHash = !!linkedHash;
      const mismatch = hasStreamHash && hasLinkedHash && streamHashInfo.hash !== linkedHash;
      state.streamHashInfo = hasStreamHash ? streamHashInfo : null;
      state.hashMismatchBlocked = mismatch;
      state.hashMismatchInfo = mismatch ? { linked: linkedHash, stream: streamHashInfo.hash } : null;

      if (!mismatch) {
        state.hashMismatchLogged = false;
        if (!opts.keepAlert) setHashMismatchAlert('');
      } else {
        const alertHtml = buildHashMismatchAlert(linkedHash, streamHashInfo.hash);
        setHashMismatchAlert(alertHtml, { asHtml: true });
        if (opts.log !== false && !state.hashMismatchLogged) {
          const mismatchMsg = 'Hash mismatch detected: linked stream (' + linkedHash + ') vs pasted URL (' + streamHashInfo.hash + '). Extraction is blocked until hashes match.';
          logExtract(mismatchMsg);
          state.hashMismatchLogged = true;
        }
      }
      renderHashMismatchAlert();
      renderHashStatus(linkedHash, streamHashInfo.hash);
      applyExtractDisabled();
      return { mismatch, linkedHash, streamHash: streamHashInfo.hash || '' };
    }

    function resetExtractionState(clearLogs = false, opts = {}) {
      const preserveMismatch = !!(opts && opts.preserveMismatch);
      state.tracks = [];
      state.currentBatchId = null;
      state.targets = {};
      state.queue = [];
      state.activeTranslations = 0;
      state.selectedTrackId = null;
      state.lastProgressStatus = null;
      if (!preserveMismatch) {
        state.cacheBlocked = false;
        state.cacheBlockInfo = null;
        state.streamHashInfo = null;
        if (state.hashMismatchBlocked && state.hashMismatchInfo) {
          const alertHtml = buildHashMismatchAlert(state.hashMismatchInfo.linked, state.hashMismatchInfo.stream);
          setHashMismatchAlert(alertHtml, { asHtml: true });
          if (els.hashMismatchInline) {
            els.hashMismatchInline.textContent = HASH_MISMATCH_INLINE;
            els.hashMismatchInline.style.display = 'block';
          }
        } else {
          setHashMismatchAlert('');
          if (els.hashMismatchInline) {
            els.hashMismatchInline.textContent = HASH_MISMATCH_INLINE;
            els.hashMismatchInline.style.display = 'none';
          }
        }
      } else if (state.cacheBlocked && state.cacheBlockInfo) {
        const alertHtml = buildHashMismatchAlert(state.cacheBlockInfo.linked, state.cacheBlockInfo.stream);
        setHashMismatchAlert(alertHtml, { asHtml: true });
        if (els.hashMismatchInline) {
          els.hashMismatchInline.textContent = HASH_MISMATCH_INLINE;
          els.hashMismatchInline.style.display = 'block';
        }
      } else if (state.hashMismatchBlocked && state.hashMismatchInfo) {
        const alertHtml = buildHashMismatchAlert(state.hashMismatchInfo.linked, state.hashMismatchInfo.stream);
        setHashMismatchAlert(alertHtml, { asHtml: true });
        if (els.hashMismatchInline) {
          els.hashMismatchInline.textContent = HASH_MISMATCH_INLINE;
          els.hashMismatchInline.style.display = 'block';
        }
      }
      updateReloadHint(false);
      renderSelectedTrackSummary();
      renderDownloads();
      renderTargets();
      setStep2Enabled(false, lockReasons.needExtraction);
      setTranslationInFlight(false);
      renderHashStatus(getVideoHash(), state.streamHashInfo?.hash || '');
      if (clearLogs) {
        if (els.translateLog) els.translateLog.innerHTML = '';
        if (els.extractLog) els.extractLog.innerHTML = '';
        if (els.extractedDownloads) els.extractedDownloads.innerHTML = '';
        if (els.translatedDownloads) els.translatedDownloads.innerHTML = '';
        if (els.extractedEmpty) els.extractedEmpty.style.display = 'block';
        if (els.translatedEmpty) els.translatedEmpty.style.display = 'block';
      }
    }

    function setExtractionInFlight(active) {
      state.extractionInFlight = !!active;
      refreshExtractionWatchdog();
      applyExtractDisabled();
      if (els.modeSelect) {
        els.modeSelect.disabled = !!active;
      }
      const readyLabel = tt('toolbox.autoSubs.extension.ready', {}, 'Ready');
      updateExtensionStatus(state.extensionReady, lastExtensionLabel || (state.extensionReady ? readyLabel : ''), state.extensionReady ? 'ok' : 'warn');
      if (!state.extractionInFlight) {
        // No auto-apply of pending stream; user must click Update
      }
    }

    function applyTranslateDisabled() {
      if (!els.translateBtn) return;
      const disabled = !state.step2Enabled;
      els.translateBtn.disabled = disabled;
    }

    function setTranslationInFlight(active) {
      state.translationInFlight = !!active;
      if (els.translateBtn) {
        const running = Math.max(0, state.activeTranslations || 0);
        const queued = Math.max(0, Array.isArray(state.queue) ? state.queue.length : 0);
        if (state.translationInFlight && (running || queued)) {
          const parts = [];
          const runningLabel = window.t ? window.t('toolbox.logs.running', { count: running }, running + ' running') : (running + ' running');
          const queuedLabel = window.t ? window.t('toolbox.logs.queued', { count: queued }, queued + ' queued') : (queued + ' queued');
          if (running) parts.push(runningLabel);
          if (queued) parts.push(queuedLabel);
          const baseLabel = window.t ? window.t('toolbox.logs.queueTranslation', {}, 'Queue translation') : 'Queue translation';
          els.translateBtn.textContent = baseLabel + ' (' + parts.join(', ') + ')';
        } else if (state.translationInFlight) {
          els.translateBtn.textContent = window.t ? window.t('toolbox.logs.queueTranslation', {}, 'Queue translation') : 'Queue translation';
        } else {
          els.translateBtn.textContent = buttonLabels.translate;
        }
      }
      applyTranslateDisabled();
      if (!state.translationInFlight) {
        // No auto-apply of pending stream; user must click Update
      }
    }

    function handleExtractionTimeout() {
      extractWatchdogTimer = null;
      if (!state.extractionInFlight) return;
      const timeoutMinutes = Math.round(EXTRACT_WATCHDOG_MS / 60000);
      const timeoutText = 'No extraction progress for ' + timeoutMinutes + ' minute(s). Resetting extraction; please retry.';
      const label = window.t ? window.t('toolbox.logs.noProgress', { minutes: timeoutMinutes }, timeoutText) : timeoutText;
      logExtract(label);
      state.extractMessageId = null;
      state.lastProgressStatus = null;
      resetExtractionState(false, { preserveMismatch: state.cacheBlocked });
      setExtractionInFlight(false);
      requestExtensionReset('extract-timeout');
      // Re-ping in case the extension went idle
      setTimeout(sendPing, 500);
    }

    function refreshTranslationInFlight() {
      const busy = state.activeTranslations > 0 || state.queue.length > 0;
      setTranslationInFlight(busy);
    }

    function setStep2Enabled(enabled, reason) {
      state.step2Enabled = !!enabled;
      if (els.step2Card) {
        const label = reason || lastStep2LockReason || lockReasons.needExtraction;
        if (state.step2Enabled) {
          unlockCard(els.step2Card);
        } else {
          lastStep2LockReason = label;
          lockCard(els.step2Card, label);
        }
      }
      applyTranslateDisabled();
    }

    function updateExtensionStatus(ready, text, tone) {
      state.extensionReady = ready;
      if (ready && text) {
        lastExtensionLabel = text;
      }
      const dotTone = ready
        ? (tone || 'ok')
        : (tone || 'bad');
      els.extDot.className = 'status-dot ' + dotTone;
      if (els.extLabel) {
        const label = ready
          ? (state.extractionInFlight
            ? tt('toolbox.logs.extracting', {}, 'Extracting via xSync…')
            : (text || lastExtensionLabel || tt('toolbox.autoSubs.extension.ready', {}, 'Ready')))
          : (text || tt('toolbox.logs.extensionMissing', {}, 'Extension not detected'));
        els.extLabel.textContent = label;
        if (ready) {
          els.extLabel.classList.add('ready');
          els.extLabel.removeAttribute('href');
          els.extLabel.removeAttribute('target');
          els.extLabel.removeAttribute('rel');
        } else {
          els.extLabel.classList.remove('ready');
          els.extLabel.setAttribute('href', EXT_INSTALL_URL);
          els.extLabel.setAttribute('target', '_blank');
          els.extLabel.setAttribute('rel', 'noopener noreferrer');
        }
      }
    }

    const normalizeProviderKey = (key) => String(key || '').trim().toLowerCase();
    function syncSelectOptions(selectEl, desiredOptions) {
      if (!selectEl) return;
      for (let i = 0; i < desiredOptions.length; i++) {
        const desired = desiredOptions[i];
        const existing = selectEl.options[i];
        if (existing) {
          if (existing.value !== desired.value) existing.value = desired.value;
          if (existing.textContent !== desired.text) existing.textContent = desired.text;
        } else {
          const opt = document.createElement('option');
          opt.value = desired.value;
          opt.textContent = desired.text;
          selectEl.appendChild(opt);
        }
      }
      while (selectEl.options.length > desiredOptions.length) {
        selectEl.remove(selectEl.options.length - 1);
      }
    }

    function renderProviders() {
      if (!els.providerSelect) return;
      const providerOpts = BOOTSTRAP.providerOptions || [];
      const desired = providerOpts.map(opt => {
        const key = normalizeProviderKey(opt.key || opt.value || opt);
        const label = opt.label || formatProviderName(opt.key || opt.value || opt);
        return { value: key, text: label };
      });
      const prevValue = els.providerSelect.value;
      syncSelectOptions(els.providerSelect, desired);

      const preferred = desired[0]?.value || '';
      const nextValue = (prevValue && desired.some(d => d.value === prevValue)) ? prevValue : preferred;
      els.providerSelect.value = nextValue;
      els.providerSelect.disabled = desired.length === 0;
      // Expand width to fit longest label while clamping to a comfortable max
      const longest = desired.reduce((len, opt) => Math.max(len, opt.text.length), 0);
      const computed = Math.min(Math.max(200, longest * 9 + 36), 360); // px
      els.providerSelect.style.width = computed + 'px';
    }

    function getTargetOptions() {
      return Array.isArray(state.targetOptions) ? state.targetOptions : [];
    }

    function setTargetOptions(options = [], keepSelection = true) {
      const merged = mergeTargetOptions(options, []);
      const previous = keepSelection ? normalizeTargetLangCode(state.selectedTargetLang) : '';
      state.targetOptions = merged;
      if (previous && merged.some(opt => normalizeTargetLangCode(opt.code) === previous)) {
        state.selectedTargetLang = merged.find(opt => normalizeTargetLangCode(opt.code) === previous)?.code || previous;
      } else {
        state.selectedTargetLang = merged[0]?.code || null;
      }
      renderTargets();
    }

    function renderTargets() {
      if (!els.targetSelect) return;
      const availableTargets = getTargetOptions();
      if (!state.selectedTargetLang && availableTargets.length) {
        state.selectedTargetLang = availableTargets[0].code;
      }
      const desired = availableTargets.map(lang => {
        const status = state.targets[lang.code]?.status;
        return {
          value: lang.code,
          text: lang.name + ' (' + lang.code + ')' + (status ? ' - ' + statusLabel(status) : '')
        };
      });
      syncSelectOptions(els.targetSelect, desired);
      els.targetSelect.value = state.selectedTargetLang || '';
      if (!els.targetSelect.value && availableTargets.length) {
        els.targetSelect.value = availableTargets[0].code;
        state.selectedTargetLang = availableTargets[0].code;
      }
    }

    function renderSelectedTrackSummary() {
      if (!els.selectedTrackSummary) return;
      const track = state.tracks.find(t => t.id === state.selectedTrackId);
      if (!track) {
        els.selectedTrackSummary.textContent = tr('toolbox.downloads.selectPrompt', {}, 'Select a subtitle in Step 1 outputs to unlock this step.');
        els.selectedTrackSummary.className = 'selected-track-placeholder';
        setStep2Enabled(false, lockReasons.needTrack);
        return;
      }
      els.selectedTrackSummary.className = 'selected-track-value';
      const parts = [
        track.label || tr('toolbox.downloads.trackLabel', { id: track.id }, 'Track ' + track.id),
        track.language ? tr('toolbox.downloads.lang', { lang: track.language }, 'Lang: ' + track.language) : '',
        track.codec ? tr('toolbox.downloads.codec', { codec: track.codec }, 'Codec: ' + track.codec) : ''
      ].filter(Boolean);
      els.selectedTrackSummary.textContent = parts.join(' - ');
    }

    function selectTrack(trackId) {
      const exists = state.tracks.some(t => t.id === trackId);
      if (!exists) return;
      state.selectedTrackId = trackId;
      renderSelectedTrackSummary();
      renderExtractedDownloads();
      setStep2Enabled(true);
    }

    function autoSelectDefaultTrack() {
      if (!state.tracks.length) {
        setStep2Enabled(false, lockReasons.needExtraction);
        return;
      }
      if (state.tracks.length === 1) {
        selectTrack(state.tracks[0].id);
        return;
      }
      setStep2Enabled(false, lockReasons.needTrack);
    }

    function renderDownloadCards(container, emptyEl, items) {
      if (!container) return;
      container.innerHTML = '';
      if (!items.length) {
        if (emptyEl) emptyEl.style.display = 'block';
        return;
      }
      if (emptyEl) emptyEl.style.display = 'none';
      items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'track';
        const title = document.createElement('div');
        title.style.fontWeight = '700';
        title.textContent = item.label;
        const link = document.createElement('a');
        link.className = 'button secondary';
        link.style.marginTop = '8px';
        link.href = item.url;
        link.download = item.filename;
        link.textContent = item.type === 'original'
          ? tr('toolbox.downloads.original', {}, 'Download original')
          : tr('toolbox.downloads.translated', {}, 'Download translated');
        card.appendChild(title);
        card.appendChild(link);
        container.appendChild(card);
      });
    }

    function formatBytes(bytes) {
      const unknown = tr('toolbox.downloads.unknownSize', {}, 'unknown size');
      if (!bytes || isNaN(bytes)) return unknown;
      const baseFormatter = new Intl.NumberFormat(document.documentElement.lang || 'en', { maximumFractionDigits: 1, minimumFractionDigits: 0 });
      if (bytes < 1024) {
        const value = baseFormatter.format(bytes);
        return value + ' ' + tr('toolbox.downloads.unitB', {}, 'B');
      }
      const units = ['KB', 'MB', 'GB'];
      let i = -1;
      do {
        bytes = bytes / 1024;
        i++;
      } while (bytes >= 1024 && i < units.length - 1);
      const value = new Intl.NumberFormat(document.documentElement.lang || 'en', { maximumFractionDigits: bytes >= 10 ? 0 : 1, minimumFractionDigits: 0 }).format(bytes);
      const unitKey = 'unit' + units[i];
      const unitLabel = tr('toolbox.downloads.' + unitKey, {}, units[i]);
      return value + ' ' + unitLabel;
    }

    function renderExtractedDownloads() {
      if (!els.extractedDownloads) return;
      els.extractedDownloads.innerHTML = '';
      const hasTracks = state.tracks.length > 0;
      if (els.extractedEmpty) {
        els.extractedEmpty.style.display = hasTracks ? 'none' : 'block';
      }
      if (!hasTracks) return;

      state.tracks.forEach(track => {
        const { mime } = resolveTrackData(track);
        const ext = track.binary ? (track.mime && track.mime.includes('matroska') ? 'mkv' : 'bin') : 'srt';
        const card = document.createElement('div');
        card.className = 'track extract-card' + (state.selectedTrackId === track.id ? ' active' : '');
        const title = document.createElement('div');
        title.style.fontWeight = '700';
        title.textContent = track.label || tr('toolbox.downloads.trackLabel', { id: track.id }, 'Track ' + track.id);
        const meta = document.createElement('div');
        meta.className = 'track-meta';
        const langLabel = track.language || 'und';
        const codecLabel = track.codec || 'subtitle';
        const sizeLabel = formatBytes(track.byteLength || (track.contentBytes ? track.contentBytes.length : 0));
        meta.textContent = tr('toolbox.downloads.meta', { lang: langLabel, codec: codecLabel, size: sizeLabel }, 'Lang: ' + langLabel + ' - Codec: ' + codecLabel + ' - Size: ' + sizeLabel);
        const actions = document.createElement('div');
        actions.className = 'track-actions';
        const download = document.createElement('a');
        download.className = 'button secondary';
        download.href = createBlobUrl(track);
        download.download = (getVideoHash() || 'video') + '_' + (track.language || 'und') + '_' + track.id + '_original.' + ext;
        download.textContent = tr('toolbox.downloads.download', {}, 'Download');
        download.addEventListener('click', (ev) => ev.stopPropagation());
        const selectBtn = document.createElement('button');
        selectBtn.type = 'button';
        selectBtn.textContent = state.selectedTrackId === track.id
          ? tr('toolbox.downloads.selected', {}, 'Selected')
          : tr('toolbox.downloads.useForStep2', {}, 'Use for Step 2');
        selectBtn.disabled = state.selectedTrackId === track.id;
        selectBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          selectTrack(track.id);
        });
        card.addEventListener('click', () => selectTrack(track.id));
        actions.appendChild(download);
        actions.appendChild(selectBtn);
        card.appendChild(title);
        card.appendChild(meta);
        card.appendChild(actions);
        els.extractedDownloads.appendChild(card);
      });
    }

    function renderTranslatedDownloads() {
      const translated = [];
      Object.entries(state.targets || {}).forEach(([lang, entry]) => {
        if (entry.status === 'done') {
          const trackRef = entry.trackId || state.selectedTrackId || 'track';
          const localOnly = entry.local === true;
          const downloadUrl = localOnly
            ? createTextBlobUrl(entry.content || '')
            : '/addon/' + encodeURIComponent(BOOTSTRAP.configStr) + '/xembedded/' + encodeURIComponent(getVideoHash()) + '/' + encodeURIComponent(lang) + '/' + encodeURIComponent(trackRef);
          const suffix = localOnly ? '_manual' : '_xembed';
          const baseLabel = tr('toolbox.downloads.translatedLabel', { lang, track: trackRef }, 'Translated ' + lang + ' (track ' + trackRef + ')');
          const label = localOnly ? baseLabel + ' - manual download only' : baseLabel;
          translated.push({
            label,
            url: downloadUrl,
            filename: (getVideoHash() || 'video') + '_' + lang + suffix + '.srt',
            type: localOnly ? 'translated-local' : 'translated'
          });
        }
      });

      renderDownloadCards(els.translatedDownloads, els.translatedEmpty, translated);
      updateReloadHint(translated.length > 0);
    }

    function renderDownloads() {
      renderExtractedDownloads();
      renderTranslatedDownloads();
    }

    function createBlobUrl(track) {
      const { data, mime } = resolveTrackData(track);
      if (!data) return '#';
      const blob = new Blob([data], { type: mime || 'application/octet-stream' });
      return URL.createObjectURL(blob);
    }

    function createTextBlobUrl(content, mime = 'text/plain') {
      const payload = content == null ? '' : content;
      const blob = new Blob([payload], { type: mime || 'text/plain' });
      return URL.createObjectURL(blob);
    }

    // Lightweight language normalizer for client-side canonicalization before save
    const TRACK_LANG_NORMALIZE_MAP = {
      spa: 'es', esl: 'es', esp: 'es', sp: 'es', spn: 'es',
      eng: 'en', enu: 'en',
      por: 'pt', pt: 'pt',
      pob: 'pob', pb: 'pob', ptb: 'pob', ptbr: 'pob', 'pt-br': 'pob', porbr: 'pob', brazpor: 'pob', brazilian: 'pob',
      fre: 'fr', fra: 'fr',
      ger: 'de', deu: 'de',
      ita: 'it',
      rus: 'ru',
      pol: 'pl',
      dut: 'nl', nld: 'nl',
      ara: 'ar',
      heb: 'he',
      tur: 'tr',
      rum: 'ro', ron: 'ro',
      alb: 'sq', sqi: 'sq',
      chi: 'zh', zho: 'zh', zhs: 'zh-cn', zht: 'zh-tw',
      jpn: 'ja',
      kor: 'ko',
      ces: 'cs', cze: 'cs',
      dan: 'da',
      fin: 'fi',
      swe: 'sv',
      hun: 'hu',
      ukr: 'uk',
      srp: 'sr',
      ron: 'ro',
      fas: 'fa', per: 'fa',
      vie: 'vi',
      ell: 'el', gre: 'el',
      bel: 'be',
      bul: 'bg',
      tam: 'ta',
      hin: 'hi',
      tha: 'th'
    };
    const LANGUAGE_NAME_ALIASES = {
      english: 'en', spanish: 'es', espanol: 'es', espanha: 'es', castellano: 'es',
      portuguese: 'pt', portugese: 'pt', portugues: 'pt', portugal: 'pt', brazillian: 'pob', brazilian: 'pob',
      french: 'fr', francais: 'fr', francese: 'fr',
      german: 'de', deutsch: 'de',
      italian: 'it', italiano: 'it', italia: 'it',
      russian: 'ru', russkiy: 'ru',
      polish: 'pl', polski: 'pl',
      dutch: 'nl', nederlands: 'nl',
      arabic: 'ar', hebrew: 'he', turkish: 'tr', romanian: 'ro', greek: 'el',
      chinese: 'zh', mandarin: 'zh', cantonese: 'zh',
      japanese: 'ja', korean: 'ko', vietnamese: 'vi', persian: 'fa',
      thai: 'th', hindi: 'hi', tamil: 'ta', bulgarian: 'bg', ukrainian: 'uk',
      serbian: 'sr', hungarian: 'hu', swedish: 'sv', finnish: 'fi', danish: 'da'
    };
    const BCP47_LANG_NORMALIZE_MAP = {
      'en-us': 'en',
      'en-gb': 'en',
      'en-au': 'en',
      'en-ca': 'en',
      'en-nz': 'en',
      'en-uk': 'en'
    };
    function normalizeTrackLanguageCode(raw) {
      if (!raw) return null;
      const rawStr = String(raw).trim().toLowerCase();
      if (/^extracte/.test(rawStr)) return null;
      if (/^extracted[_\\s-]?sub/.test(rawStr)) return null;
      if (/^remux[_\\s-]?sub/.test(rawStr)) return null;
      if (/^track\\s*\\d+/.test(rawStr)) return null;
      if (/^subtitle\\s*\\d+/.test(rawStr)) return null;
      const cleaned = rawStr.replace(/_/g, '-').replace(/[^a-z-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      if (!cleaned) return null;
      if (BCP47_LANG_NORMALIZE_MAP[cleaned]) return BCP47_LANG_NORMALIZE_MAP[cleaned];
      const parts = cleaned.split('-').filter(Boolean);
      const base = parts[0];
      if (!base) return null;
      if (TRACK_LANG_NORMALIZE_MAP[base]) return TRACK_LANG_NORMALIZE_MAP[base];
      if (LANGUAGE_NAME_ALIASES[base]) return LANGUAGE_NAME_ALIASES[base];
      if (base === 'en' || base === 'eng') return 'en';
      if (/^en[a-z]{2}$/.test(base)) return 'en';
      if (parts.length > 1 && parts[0] === 'en') return 'en';
      if (base.length === 2) return base;
      if (base.length === 3 && TRACK_LANG_NORMALIZE_MAP[base]) return TRACK_LANG_NORMALIZE_MAP[base];
      if (base.length === 3) return base;
      return base.slice(0, 8);
    }
    function hasEnglishKeyword(raw) {
      if (!raw) return false;
      const lower = String(raw).toLowerCase();
      return /\\benglish\\b/.test(lower) || /\\beng\\b/.test(lower) || /\\ben\\b/.test(lower);
    }
    function collectTrackLanguageHints(track = {}) {
      const tags = track.tags || {};
      const hints = [
        track.language,
        track.lang,
        track.languageRaw,
        track.languageCode,
        track.languageIetf,
        track.langCode,
        track.languageTag,
        track.langTag,
        tags.language,
        tags.LANGUAGE,
        tags.lang,
        tags.LANG,
        tags.languageIetf,
        tags.language_ietf,
        track.originalLanguage,
        track.sourceLanguage,
        track.title,
        tags.title,
        track.name,
        tags.name,
        track.label,
        track.originalLabel,
        track.handlerName,
        tags.handler_name,
        tags.handlerName
      ];
      return hints
        .map(v => (v === undefined || v === null ? '' : String(v)))
        .filter(v => v.trim().length > 0);
    }
    function resolveTrackLanguage(track = {}) {
      const hints = collectTrackLanguageHints(track);
      let firstKnown = null;
      for (const hint of hints) {
        const normalized = normalizeTrackLanguageCode(hint) || detectLanguageFromLabel(hint);
        if (normalized) {
          const code = normalized.toLowerCase();
          if (code === 'en') return 'en';
          if (!firstKnown) firstKnown = code;
        }
      }
      if (hints.some(hasEnglishKeyword)) return 'en';
      return firstKnown || 'und';
    }
    function detectLanguageFromLabel(label) {
      if (!label) return null;
      const lowered = String(label).toLowerCase();
      if (/^extracte/.test(lowered)) return null;
      if (/^extracted[_\\s-]?sub/.test(lowered)) return null;
      if (/^remux[_\\s-]?sub/.test(lowered)) return null;
      if (/^track\\s+\\d+/.test(lowered)) return null;
      if (/^subtitle\\s+\\d+/.test(lowered)) return null;
      if (lowered.includes('brazil')) return 'pob';
      if (lowered.includes('portuguese (br')) return 'pob';
      const codeMatch = lowered.match(/(?:^|\\[|\\(|\\s)([a-z]{2,3})(?:\\s|$|\\]|\\))/);
      if (codeMatch) {
        const byCode = normalizeTrackLanguageCode(codeMatch[1]);
        if (byCode) return byCode;
      }
      const cleaned = lowered.replace(/[^a-z\\s]/g, ' ').replace(/\\s+/g, ' ').trim();
      if (!cleaned) return null;
      if (LANGUAGE_NAME_ALIASES[cleaned]) return LANGUAGE_NAME_ALIASES[cleaned];
      const parts = cleaned.split(' ');
      for (const part of parts) {
        const byName = LANGUAGE_NAME_ALIASES[part];
        if (byName) return byName;
        const byCode = normalizeTrackLanguageCode(part);
        if (byCode) return byCode;
      }
      return null;
    }
    function canonicalTrackLanguageCode(raw) {
      if (!raw) return 'und';
      const lowered = String(raw).toLowerCase();
      if (/^extracte/.test(lowered)) return 'und';
      if (/^extracted[_\\s-]?sub/.test(lowered)) return 'und';
      if (/^remux[_\\s-]?sub/.test(lowered)) return 'und';
      if (/^track\\s*\\d+/.test(lowered)) return 'und';
      if (/^subtitle\\s*\\d+/.test(lowered)) return 'und';
      const normalized = normalizeTrackLanguageCode(raw) || detectLanguageFromLabel(raw);
      if (normalized) return normalized;
      if (hasEnglishKeyword(raw)) return 'en';
      return 'und';
    }

    async function persistOriginals(batchId) {
      if (state.cacheBlocked) {
        const diff = state.cacheBlockInfo;
        const msg = diff && diff.linked && diff.stream
          ? 'Hash mismatch detected (linked ' + diff.linked + ' vs stream ' + diff.stream + '). Originals will not be uploaded; downloads stay available.'
          : 'Hash mismatch detected. Originals will not be uploaded to xEmbed; downloads stay available.';
        logExtract(msg);
        return;
      }
      for (const track of state.tracks) {
        try {
          const { data, mime } = resolveTrackData(track);
          let contentPayload = track.content;
          let encoding = 'text';
          if (track.binary || track.codec === 'copy') {
            // Always send base64 for binary tracks
            const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
            let str = '';
            for (let i = 0; i < u8.length; i++) str += String.fromCharCode(u8[i]);
            contentPayload = btoa(str);
            encoding = 'base64';
          }
          const langCode = canonicalTrackLanguageCode(track.language || track.label || track.name || 'und');
          await fetch('/api/save-embedded-subtitle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              configStr: BOOTSTRAP.configStr,
              videoHash: getVideoHash(),
              trackId: track.id,
              languageCode: langCode,
              content: contentPayload,
              metadata: {
                label: track.label,
                codec: track.codec,
                extractedAt: Date.now(),
                source: 'extension',
                encoding,
                mime,
                batchId: batchId || Date.now()
              }
            })
          });
        } catch (e) {
          const label = window.t ? window.t('toolbox.logs.cacheSaveFailed', { id: track.id, reason: e.message }, 'Failed to save track ' + track.id + ' to cache: ' + e.message) : ('Failed to save track ' + track.id + ' to cache: ' + e.message);
          logExtract(label);
        }
      }
    }

    function scheduleTranslation(targetLang) {
      const track = state.tracks.find(t => t.id === state.selectedTrackId);
      if (!track) {
        const label = window.t ? window.t('toolbox.logs.selectSubtitle', {}, 'Select a subtitle in Step 1 outputs first.') : 'Select a subtitle in Step 1 outputs first.';
        logTranslate(label);
        return;
      }
      const status = state.targets[targetLang]?.status;
      if (status === 'running' || status === 'queued') {
        const label = window.t ? window.t('toolbox.logs.translationQueued', { lang: targetLang }, 'Translation already queued for ' + targetLang + '.') : ('Translation already queued for ' + targetLang + '.');
        logTranslate(label);
        return;
      }
      state.targets[targetLang] = { status: 'queued', trackId: track.id };
      state.queue = state.queue.filter(item => item.lang !== targetLang);
      state.queue.push({ lang: targetLang, run: () => runTranslation(track, targetLang) });
      setTranslationInFlight(true);
      renderTargets();
      processQueue();
      renderDownloads();
    }

    async function runTranslation(track, targetLang) {
      state.activeTranslations++;
      const historyKey = [getVideoHash(), track.id, targetLang].join('|');
      const prior = state.targets[targetLang];
      const isRetranslate = translatedHistory.has(historyKey) || (prior && prior.status === 'done' && String(prior.trackId) === String(track.id));
      state.targets[targetLang] = { status: 'running', trackId: track.id, retranslate: isRetranslate };
      renderTargets();
      const baseKey = isRetranslate ? 'toolbox.logs.retranslating' : 'toolbox.logs.translating';
      const translateFallback = (isRetranslate ? 'Retranslating ' : 'Translating ') + track.label + ' -> ' + targetLang + '...';
      const translateLabel = window.t ? window.t(baseKey, { label: track.label, target: targetLang }, translateFallback) : translateFallback;
      logTranslate(translateLabel);
      if (track.binary || track.codec === 'copy') {
        state.targets[targetLang] = { status: 'failed', error: 'Binary subtitle cannot be translated' };
        const binaryMsg = window.t ? window.t('toolbox.logs.binaryTrack', {}, 'Track is binary (image/bitmap); cannot translate.') : 'Track is binary (image/bitmap); cannot translate.';
        logTranslate(binaryMsg);
        state.activeTranslations--;
        renderTargets();
        renderDownloads();
        processQueue();
        refreshTranslationInFlight();
        return;
      }
      try {
        const skipCacheUploads = state.cacheBlocked === true;
        if (skipCacheUploads) {
          const diff = state.cacheBlockInfo;
          const warn = diff && diff.linked && diff.stream
            ? 'Hash mismatch (' + diff.linked + ' vs ' + diff.stream + '); translations will be download-only (not uploaded to Stremio).'
            : 'Hash mismatch detected; translations will be download-only (not uploaded to Stremio).';
          logTranslate(warn);
        }
        const resp = await fetch('/api/translate-embedded', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            configStr: BOOTSTRAP.configStr,
            videoHash: getVideoHash(),
            trackId: track.id,
            sourceLanguageCode: track.language || 'und',
            targetLanguage: targetLang,
            content: track.content,
            options: {
              singleBatchMode: (els.singleBatch?.value || 'multi') === 'single',
              sendTimestampsToAI: (els.timestamps?.value || 'original') === 'send'
            },
            overrides: {
              providerName: els.providerSelect?.value || ''
            },
            metadata: {
              label: track.label,
              codec: track.codec,
              extractedAt: track.extractedAt || Date.now(),
              batchId: track.batchId || state.currentBatchId || null
            },
            forceRetranslate: isRetranslate,
            skipCache: skipCacheUploads
          })
        });
        const data = await resp.json();
        if (!resp.ok || data.error) throw new Error(data.error || (window.t ? window.t('toolbox.logs.translationFailed', {}, 'Translation failed') : 'Translation failed'));
        translatedHistory.add(historyKey);
        state.targets[targetLang] = {
          status: 'done',
          cacheKey: skipCacheUploads ? null : data.cacheKey,
          trackId: track.id,
          retranslate: isRetranslate,
          local: skipCacheUploads,
          content: skipCacheUploads ? data.translatedContent : null
        };
        const doneKey = skipCacheUploads ? null : (data.cached ? 'toolbox.logs.finishedCached' : 'toolbox.logs.finished');
        const finishFallback = skipCacheUploads
          ? ('Finished ' + targetLang + ' (download only; not uploaded)')
          : (data.cached ? ('Finished ' + targetLang + ' (cached)') : ('Finished ' + targetLang));
        const finishMsg = doneKey && window.t ? window.t(doneKey, { lang: targetLang }, finishFallback) : finishFallback;
        logTranslate(finishMsg);
        updateReloadHint(true);
        renderTargets();
      } catch (e) {
        state.targets[targetLang] = { status: 'failed', error: e.message };
        const failFallback = 'Failed ' + targetLang + ': ' + e.message;
        const failMsg = window.t ? window.t('toolbox.logs.translationError', { lang: targetLang, reason: e.message }, failFallback) : failFallback;
        logTranslate(failMsg);
        renderTargets();
      } finally {
        state.activeTranslations--;
        renderDownloads();
        processQueue();
        refreshTranslationInFlight();
      }
    }

    function processQueue() {
      if (state.activeTranslations >= 2) return;
      const next = state.queue.shift();
      if (next && typeof next.run === 'function') next.run();
    }

    // Extension messaging
    window.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.source !== 'extension') return;
      const trackedTypes = ['SUBMAKER_EXTRACT_PROGRESS', 'SUBMAKER_EXTRACT_RESPONSE', 'SUBMAKER_DEBUG_LOG'];
      const isExtractEvent = trackedTypes.includes(msg.type);
      if (isExtractEvent) {
        if (!state.extractMessageId) return;
        if (msg.messageId && msg.messageId !== state.extractMessageId) return;
      }
      if (msg.type === 'SUBMAKER_PONG') {
        pingRetries = 0; // Reset retry counter
        if (pingTimer) {
          clearTimeout(pingTimer);
          pingTimer = null;
        }
        const readyWithVersion = tt('toolbox.autoSubs.extension.readyWithVersion', { version: msg.version || '-' }, 'Ready (v' + (msg.version || '-') + ')');
        updateExtensionStatus(true, readyWithVersion);
      } else if (msg.type === 'SUBMAKER_DEBUG_LOG') {
        const level = (msg.level || 'info').toUpperCase();
        const text = msg.text || (window.t ? window.t('toolbox.logs.event', {}, 'Log event') : 'Log event');
        logExtract('[' + level + '] ' + text);
      } else if (msg.type === 'SUBMAKER_EXTRACT_PROGRESS') {
        refreshExtractionWatchdog();
        // Deduplicate consecutive identical progress messages to prevent spam
        const currentStatus = msg.status || ('Progress ' + msg.progress + '%');
        if (currentStatus !== state.lastProgressStatus) {
          state.lastProgressStatus = currentStatus;
          logExtract(currentStatus);
        }
      } else if (msg.type === 'SUBMAKER_EXTRACT_RESPONSE') {
        setExtractionInFlight(false);
        setTranslationInFlight(false);
        state.lastProgressStatus = null; // Reset for next extraction
        state.extractMessageId = null;
        if (msg.success && Array.isArray(msg.tracks)) {
          resetExtractionState(false, { preserveMismatch: state.cacheBlocked });
          state.selectedTargetLang = getTargetOptions()[0]?.code || null;
          const rawTracks = msg.tracks || [];
          const filteredTracks = rawTracks.filter((t) => !(t && (t.binary || t.codec === 'copy' || (t.mime && String(t.mime).toLowerCase().includes('matroska')) || t.source === 'copy')));
          const dropped = rawTracks.length - filteredTracks.length;
          if (dropped > 0) {
            const dropFallback = 'Omitted ' + dropped + ' binary track(s); showing text subtitles only.';
            const dropMsg = window.t
              ? window.t('toolbox.logs.filteredBinaryTracks', { count: dropped }, dropFallback)
              : dropFallback;
            logExtract(dropMsg);
          }
          const batchId = Date.now();
          state.currentBatchId = batchId;
          const isGeneratedLabel = (label) => {
            if (!label) return true;
            const lower = String(label).toLowerCase();
            if (/^extracted[_\\s-]?sub/.test(lower)) return true;
            if (/^extracted[_\\s-]?sub[_-]?fix/.test(lower)) return true;
            if (/^remux[_\\s-]?sub/.test(lower)) return true;
            if (/^track\\s+\\d+/.test(lower)) return true;
            if (/^subtitle\\s+\\d+/.test(lower)) return true;
            return false;
          };
          const isGeneratedLangHint = (value) => {
            if (!value) return false;
            const lower = String(value).toLowerCase();
            // ignore common auto-generated placeholders/filenames
            if (/^extracte/.test(lower)) return true;
            if (/^extracted[_\\s-]?sub/.test(lower)) return true;
            if (/^remux[_\\s-]?sub/.test(lower)) return true;
            if (/^track\\s+\\d+/.test(lower)) return true;
            if (/^subtitle\\s+\\d+/.test(lower)) return true;
            if (/^extracted[_\\s-]?sub[_-]?fix/.test(lower)) return true;
            if (/(\\.srt|\\.vtt|\\.ass|\\.ssa|\\.sup)(\\b|$)/i.test(lower)) return true;
            return false;
          };
          state.tracks = filteredTracks.map((t, idx) => {
            const contentBytes = t.contentBytes || null;
            const contentBase64 = t.contentBase64 || '';
            const contentValue = (typeof t.content === 'string' || t.content instanceof Uint8Array || t.content instanceof ArrayBuffer) ? t.content : '';
            const byteLength = t.byteLength || (contentBytes ? contentBytes.length : (typeof contentValue === 'string' ? contentValue.length : 0));
            const normalizedTrack = {
              ...t,
              language: isGeneratedLangHint(t.language) ? '' : t.language,
              lang: isGeneratedLangHint(t.lang) ? '' : t.lang,
              languageRaw: isGeneratedLangHint(t.languageRaw) ? '' : t.languageRaw,
              languageCode: isGeneratedLangHint(t.languageCode) ? '' : t.languageCode,
              languageIetf: isGeneratedLangHint(t.languageIetf) ? '' : t.languageIetf,
              langCode: isGeneratedLangHint(t.langCode) ? '' : t.langCode,
              label: isGeneratedLabel(t.label) ? '' : t.label,
              originalLabel: isGeneratedLabel(t.originalLabel) ? '' : t.originalLabel,
              name: isGeneratedLabel(t.name) ? '' : t.name
            };
            const rawLang = resolveTrackLanguage(normalizedTrack);
            return {
              id: t.id || idx,
              label: t.label || tr('toolbox.downloads.trackLabel', { id: idx + 1 }, 'Track ' + (idx + 1)),
              language: rawLang ? rawLang.toLowerCase() : 'und',
              codec: t.codec || t.format || 'subtitle',
              binary: false,
              content: contentValue,
              contentBase64,
              contentBytes,
              byteLength,
              mime: t.mime || 'text/plain',
              extractedAt: Date.now(),
              batchId
            };
          });
          renderTargets();
          autoSelectDefaultTrack();
          renderDownloads();
          persistOriginals(batchId);
          const label = window.t ? window.t('toolbox.logs.extracted', { count: state.tracks.length }, 'Extracted ' + state.tracks.length + ' track(s).') : ('Extracted ' + state.tracks.length + ' track(s).');
          logExtract(label);
        } else {
          resetExtractionState(false, { preserveMismatch: state.cacheBlocked });
          const label = window.t ? window.t('toolbox.logs.failed', { error: msg.error || 'unknown error' }, 'Extraction failed: ' + (msg.error || 'unknown error')) : ('Extraction failed: ' + (msg.error || 'unknown error'));
          logExtract(label);
          setStep2Enabled(false, lockReasons.needExtraction);
        }
        requestExtensionReset('extract-finished');
      }
    });

    let pingRetries = 0;
    let pingTimer = null;
    const MAX_PING_RETRIES = 5;

    function sendPing() {
      if (pingTimer) {
        clearTimeout(pingTimer);
        pingTimer = null;
      }
      pingRetries = 0;
      const tick = () => {
        if (state.extensionReady) return;
        pingRetries += 1;
        const label = window.t ? window.t('toolbox.status.pinging', {}, 'Pinging extension...') : 'Pinging extension...';
        updateExtensionStatus(false, label, 'warn');
        window.postMessage({ type: 'SUBMAKER_PING', source: 'webpage' }, '*');
        if (pingRetries >= MAX_PING_RETRIES && !state.extensionReady) {
          const notDetected = window.t ? window.t('toolbox.logs.extensionMissing', {}, 'Extension not detected') : 'Extension not detected';
          updateExtensionStatus(false, notDetected, 'bad');
          return;
        }
        pingTimer = setTimeout(tick, 5000);
      };
      tick();
    }

    function requestExtraction() {
      if (!state.extensionReady) {
        const label = window.t ? window.t('toolbox.logs.extensionMissing', {}, 'Extension not detected yet. Install SubMaker xSync and wait for detection.') : 'Extension not detected yet. Install SubMaker xSync and wait for detection.';
        logExtract(label);
        return;
      }
      if (state.extractionInFlight) return;
      if (state.placeholderBlocked) return;
      const streamUrl = (els.streamUrl.value || '').trim();
      if (!streamUrl) {
        const label = window.t ? window.t('toolbox.logs.pasteUrl', {}, 'Paste a stream URL first.') : 'Paste a stream URL first.';
        logExtract(label);
        return;
      }
      if (!new RegExp('^https?://', 'i').test(streamUrl)) {
        const label = window.t ? window.t('toolbox.logs.invalidUrl', {}, 'Invalid stream URL. Paste a full http/https link.') : 'Invalid stream URL. Paste a full http/https link.';
        logExtract(label);
        return;
      }
      const hashStatus = updateHashMismatchState({ streamUrl, log: true });
      if (hashStatus.mismatch) {
        return;
      }
      resetExtractionState(true);
      state.cacheBlocked = false;
      state.cacheBlockInfo = null;
      state.hashMismatchBlocked = false;
      state.hashMismatchInfo = null;
      state.hashMismatchLogged = false;
      if (els.extractLog) els.extractLog.innerHTML = '';
      const linkedHash = hashStatus.linkedHash || getVideoHash();
      const streamHashInfo = deriveStreamHashFromUrl(streamUrl, { videoId: PAGE.videoId || BOOTSTRAP.videoId, filename: PAGE.filename || BOOTSTRAP.filename });
      state.streamHashInfo = streamHashInfo;
      if (streamHashInfo.hash && linkedHash && streamHashInfo.hash !== linkedHash) {
        state.cacheBlocked = true;
        state.cacheBlockInfo = { linked: linkedHash, stream: streamHashInfo.hash };
        const mismatchMsg = 'Hash mismatch detected: linked stream (' + linkedHash + ') vs pasted URL (' + streamHashInfo.hash + '). Extraction is blocked until the hashes match.';
        const alertHtml = buildHashMismatchAlert(linkedHash, streamHashInfo.hash);
        setHashMismatchAlert(alertHtml, { asHtml: true });
        logExtract(mismatchMsg);
        applyExtractDisabled();
        return;
      }
      setHashMismatchAlert('');
      const mode = state.extractMode === 'complete' ? 'complete' : 'smart';
      const messageId = 'extract_' + Date.now();
      setStep2Enabled(false, lockReasons.needExtraction);
      setExtractionInFlight(true);
      state.extractMessageId = messageId;
      state.lastProgressStatus = null; // Reset progress tracking for new extraction
      window.postMessage({
        type: 'SUBMAKER_EXTRACT_REQUEST',
        source: 'webpage',
        messageId,
        data: {
          streamUrl,
          mode,
          filename: PAGE.filename || BOOTSTRAP.filename || '',
          videoHash: getVideoHash()
        }
      }, '*');
      const label = window.t ? window.t('toolbox.logs.sentRequest', { mode }, 'Sent extract request (' + mode + ') to extension.') : ('Sent extract request (' + mode + ') to extension.');
      logExtract(label);
    }

    // Event bindings
    let lastStreamValue = (els.streamUrl?.value || '').trim();
    if (els.streamUrl) {
      const handleStreamInput = () => {
        const current = (els.streamUrl?.value || '').trim();
        const changed = current !== lastStreamValue;
        lastStreamValue = current;
        if (changed && !state.extractionInFlight) {
          resetExtractionState(true);
        }
        updateHashMismatchState({ log: false });
      };
      ['input', 'change', 'blur'].forEach(evt => {
        els.streamUrl.addEventListener(evt, handleStreamInput);
      });
    }
    els.extractBtn.onclick = requestExtraction;
    els.translateBtn.onclick = () => {
      const targetLang = state.selectedTargetLang;
      if (!targetLang) {
        const label = window.t ? window.t('toolbox.logs.selectTarget', {}, 'Select a target language.') : 'Select a target language.';
        logTranslate(label);
        return;
      }
      scheduleTranslation(targetLang);
    };
    if (els.targetSelect) {
      els.targetSelect.addEventListener('change', () => {
        state.selectedTargetLang = els.targetSelect.value || null;
      });
    }
    if (els.modeSelect) {
      els.modeSelect.addEventListener('change', () => {
        const value = (els.modeSelect.value || '').toLowerCase();
        state.extractMode = value === 'complete' ? 'complete' : 'smart';
        persistExtractMode(state.extractMode);
      });
    }

    // Initial render
    renderProviders();
    renderTargets();
    renderSelectedTrackSummary();
    renderDownloads();
    updateVideoMeta();
    setStep2Enabled(!!state.selectedTrackId, state.selectedTrackId ? null : lockReasons.needExtraction);
    if (els.singleBatch) {
      els.singleBatch.value = BOOTSTRAP.defaults.singleBatchMode ? 'single' : 'multi';
    }
    if (els.timestamps) {
      els.timestamps.value = BOOTSTRAP.defaults.sendTimestampsToAI ? 'send' : 'original';
    }

    // Prefetch subtitles once so menu + target list share the same request
    if (subtitleMenuInstance && typeof subtitleMenuInstance.prefetch === 'function') {
      subtitleMenuInstance.prefetch();
    }

    // Auto ping on load (delay to allow extension content script to initialize)
    setTimeout(sendPing, 500);

    // Episode change watcher (toast + manual update)
    initStreamWatcher({
      configStr: PAGE.configStr,
      current: { videoId: PAGE.videoId, filename: PAGE.filename, videoHash: PAGE.videoHash },
      buildUrl: (payload) => {
        return '/embedded-subtitles?config=' + encodeURIComponent(PAGE.configStr) +
          '&videoId=' + encodeURIComponent(payload.videoId || '') +
          '&filename=' + encodeURIComponent(payload.filename || '');
      },
      onEpisode: handleStreamUpdateFromNotification,
      notify: forwardMenuNotification
    });
  </script>
</body>
</html>
`;
}

async function generateAutoSubtitlePage(configStr, videoId, filename, config = {}, streamUrl = '') {
  const links = buildToolLinks(configStr, videoId, filename);
  const devMode = config.devMode === true;
  const t = getTranslator(config?.uiLanguage || 'en');
  const targetLanguages = Array.from(new Set([...(config.targetLanguages || []), ...(config.sourceLanguages || [])]));
  const targetOptions = targetLanguages.length
    ? targetLanguages.map(code => `<option value="${escapeHtml(code)}">${escapeHtml(getLanguageName(code) || code)}</option>`).join('')
    : `<option value="">${escapeHtml(t('toolbox.autoSubs.options.addTargets', {}, 'Add target languages in Configure'))}</option>`;
  const sourceLanguageOptions = allLanguages.map(lang => {
    const label = formatLanguageLabel(lang.code, lang.name);
    return `<option value="${escapeHtml(lang.code)}">${escapeHtml(label)}</option>`;
  }).join('');
  const videoHash = deriveVideoHash(filename, videoId);
  const urlSchemePattern = new RegExp('^[a-z][a-z0-9+.-]*://', 'i');
  const isLikelyUrl = (val) => urlSchemePattern.test(val || '');
  const initialStreamUrl = isLikelyUrl(streamUrl) ? streamUrl : (isLikelyUrl(filename) ? filename : '');
  const languageMaps = buildLanguageLookupMaps();
  const localeBootstrap = buildClientBootstrap(loadLocale(config?.uiLanguage || 'en'));
  const subtitleMenuTargets = targetLanguages.map(code => ({
    code,
    name: getLanguageName(code) || code
  }));
  const parsedVideo = parseStremioId(videoId);
  const episodeTag = formatEpisodeTag(parsedVideo);
  const linkedTitle = await fetchLinkedTitleServer(videoId);
  const providerOptions = (() => {
    const options = [];
    const providers = config.providers || {};
    const seen = new Set();
    const resolveProviderEntry = (key) => {
      const normalized = String(key || '').trim().toLowerCase();
      const matchKey = Object.keys(providers || {}).find(k => String(k).toLowerCase() === normalized);
      return matchKey ? { key: matchKey, config: providers[matchKey] || {} } : null;
    };
    const formatLabel = (name, model) => {
      const base = formatProviderName(name);
      const modelLabel = model ? ` (${model})` : '';
      return `${base}${modelLabel}`;
    };
    const geminiConfigured = Boolean(config.geminiModel || config.geminiKey || config.geminiApiKey || providers.gemini);
    const geminiEnabled = providers.gemini ? providers.gemini.enabled !== false : geminiConfigured;
    const addIfEnabled = (key, label, model) => {
      const norm = String(key || '').trim().toLowerCase();
      if (!norm || seen.has(norm)) return;
      let enabled = false;
      if (norm === 'gemini') {
        enabled = geminiEnabled;
      } else {
        const entry = resolveProviderEntry(norm);
        enabled = entry?.config?.enabled === true;
      }
      if (!enabled) return;
      seen.add(norm);
      options.push({ key: norm, label: label || formatLabel(key, model) });
    };
    if (geminiEnabled) {
      const geminiLabel = formatLabel('Gemini', config.geminiModel || providers.gemini?.model || '');
      addIfEnabled('gemini', geminiLabel, config.geminiModel || providers.gemini?.model || '');
    }
    if (config.multiProviderEnabled && config.mainProvider) {
      const entry = resolveProviderEntry(config.mainProvider);
      const model = entry?.config?.model || (config.mainProvider.toLowerCase() === 'gemini' ? config.geminiModel : '');
      addIfEnabled(config.mainProvider, `Main: ${formatLabel(config.mainProvider, model)}`, model);
    }
    if (config.secondaryProviderEnabled && config.secondaryProvider) {
      const entry = resolveProviderEntry(config.secondaryProvider);
      const model = entry?.config?.model || (config.secondaryProvider.toLowerCase() === 'gemini' ? config.geminiModel : '');
      addIfEnabled(config.secondaryProvider, `Secondary: ${formatLabel(config.secondaryProvider, model)}`, model);
    }
    Object.keys(providers || {}).forEach(key => {
      const model = providers[key]?.model || '';
      addIfEnabled(key, `Provider: ${formatLabel(key, model)}`, model);
    });
    return options;
  })();

  function autoSubsRuntime(copy) {
    (function() {
      const els = {
        startBtn: document.getElementById('startAutoSubs'),
        previewBtn: document.getElementById('previewSteps'),
        status: document.getElementById('statusText'),
        progress: document.getElementById('progressFill'),
        log: document.getElementById('logArea'),
        streamUrl: document.getElementById('streamUrl'),
        hashStatus: document.getElementById('hashStatus'),
        hashMismatchAlert: document.getElementById('auto-hash-mismatch'),
        modeSelect: document.getElementById('autoSubsMode'),
        modeDetails: document.getElementById('modeDetails'),
        sourceLang: document.getElementById('detectedLang'),
        targetLang: document.getElementById('targetLang'),
        model: document.getElementById('whisperModel'),
        translateToggle: document.getElementById('translateOutput'),
        batchMode: document.getElementById('singleBatchModeSelect'),
        timestampsMode: document.getElementById('timestampsMode'),
        diarization: document.getElementById('enableDiarization'),
        provider: document.getElementById('translationProvider'),
        providerModel: document.getElementById('translationModel'),
        translationStep: document.getElementById('translationStep'),
        translationSettings: document.getElementById('translationSettings'),
        translationSettingsToggle: document.getElementById('translationSettingsToggle'),
        translationSettingsContent: document.getElementById('translationSettingsContent'),
        srtPreview: document.getElementById('srtPreview'),
        dlSrt: document.getElementById('downloadSrt'),
        dlVtt: document.getElementById('downloadVtt'),
        translations: document.getElementById('translationDownloads'),
        videoMetaTitle: document.getElementById('video-meta-title'),
        videoMetaSubtitle: document.getElementById('video-meta-subtitle'),
        extDot: document.getElementById('ext-dot'),
        extLabel: document.getElementById('ext-label'),
        extStatus: document.getElementById('ext-status'),
        hashBadge: document.getElementById('hashBadge'),
        hashBadgeDot: document.getElementById('hashBadgeDot'),
        hashBadgeValue: document.getElementById('hashBadgeValue'),
        continueBtn: document.getElementById('autoContinue'),
        step2Card: document.getElementById('autoStep2Card'),
        translationCard: document.getElementById('autoTranslationCard'),
        step3Card: document.getElementById('autoStep3Card'),
        step4Card: document.getElementById('autoStep4Card')
      };
      const stepPills = {
        fetch: document.getElementById('stepFetch'),
        transcribe: document.getElementById('stepTranscribe'),
        align: document.getElementById('stepAlign'),
        translate: document.getElementById('stepTranslate'),
        deliver: document.getElementById('stepDeliver')
      };
      const startBtnLabel = els.startBtn
        ? els.startBtn.textContent
        : tt('toolbox.autoSubs.actions.start', {}, copy.steps.start || 'Start');
      const state = {
        extensionReady: false,
        cacheBlocked: false,
        autoSubsInFlight: false,
        step1Confirmed: false
      };
      const escapeHtmlClient = (value) => {
        if (value === undefined || value === null) return '';
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\"/g, '&quot;')
          .replace(/'/g, '&#39;');
      };
      const HASH_MISMATCH_LINES = [
        tt('toolbox.embedded.step1.hashMismatchLine1', {}, 'Hashes must match before extraction can start.')
      ];
      function buildHashMismatchAlert(linkedHash, streamHash) {
        const safeLinked = escapeHtmlClient(linkedHash || 'unknown');
        const safeStream = escapeHtmlClient(streamHash || 'unknown');
        const head = 'Hash mismatch detected: linked stream (' + safeLinked + ') vs pasted URL (' + safeStream + ').';
        const body = HASH_MISMATCH_LINES
          .filter(Boolean)
          .map(line => '<div>' + escapeHtmlClient(line) + '</div>')
          .join('');
        return '<div class="alert-head">' + head + '</div>' + (body ? '<div class="alert-body">' + body + '</div>' : '');
      }
      function setHashMismatchAlert(message) {
        if (!els.hashMismatchAlert) return;
        if (!message) {
          els.hashMismatchAlert.style.display = 'none';
          els.hashMismatchAlert.innerHTML = '';
          return;
        }
        els.hashMismatchAlert.innerHTML = message;
        els.hashMismatchAlert.style.display = 'block';
      }
      const lockReasons = {
        needContinue: (copy?.locks && copy.locks.needContinue) || tt('toolbox.autoSubs.locks.needContinue', {}, 'Click Continue to unlock the next steps.'),
        needTarget: (copy?.locks && copy.locks.needTarget) || tt('toolbox.autoSubs.locks.needTarget', {}, 'Select a target or disable translation to unlock Run.')
      };
      function lockSection(el, label) {
        if (!el) return;
        if (label) el.setAttribute('data-locked-label', label);
        el.classList.add('locked');
        el.setAttribute('aria-disabled', 'true');
        el.inert = true;
      }
      function unlockSection(el) {
        if (!el) return;
        el.classList.remove('locked');
        el.removeAttribute('aria-disabled');
        el.inert = false;
        el.removeAttribute('inert');
      }
      function isTranslationReady() {
        const translateEnabled = els.translateToggle?.checked === true;
        const hasTarget = !!(els.targetLang && (els.targetLang.value || '').trim());
        return !translateEnabled || hasTarget;
      }
      function isStep3Ready() {
        return state.step1Confirmed && isTranslationReady();
      }
      function applyStartDisabled(ready) {
        if (!els.startBtn) return;
        const allow = ready && !state.autoSubsInFlight;
        els.startBtn.disabled = !allow;
      }
      function refreshStepLocks(reason) {
        const needContinueLabel = reason || lockReasons.needContinue;
        if (!state.step1Confirmed) {
          lockSection(els.step2Card, needContinueLabel);
          lockSection(els.translationCard, needContinueLabel);
          lockSection(els.step3Card, needContinueLabel);
          lockSection(els.step4Card, needContinueLabel);
          applyStartDisabled(false);
          return;
        }
        unlockSection(els.step2Card);
        unlockSection(els.translationCard);
        const step3Ready = isStep3Ready();
        if (step3Ready) {
          unlockSection(els.step3Card);
          unlockSection(els.step4Card);
        } else {
          lockSection(els.step3Card, lockReasons.needTarget);
          lockSection(els.step4Card, lockReasons.needTarget);
        }
        applyStartDisabled(step3Ready);
      }
      function resetStepFlow(reason) {
        state.step1Confirmed = false;
        refreshStepLocks(reason || lockReasons.needContinue);
      }
      let videoMetaRequestId = 0;
      const urlSchemePattern = new RegExp('^[a-z][a-z0-9+.-]*://', 'i');
      const isLikelyStreamUrl = (val) => urlSchemePattern.test(val || '');
      const bootstrapStreamUrl = BOOTSTRAP.streamUrl || '';
      const fallbackStreamUrl = !bootstrapStreamUrl && isLikelyStreamUrl(BOOTSTRAP.filename) ? BOOTSTRAP.filename : '';
      const initialStreamUrl = bootstrapStreamUrl || fallbackStreamUrl;
      if (els.streamUrl && initialStreamUrl) {
        els.streamUrl.value = initialStreamUrl;
      }

      function md5hex(str) {
        function rotateLeft(lValue, iShiftBits) { return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits)); }
        function addUnsigned(lX, lY) {
          const lX4 = lX & 0x40000000;
          const lY4 = lY & 0x40000000;
          const lX8 = lX & 0x80000000;
          const lY8 = lY & 0x80000000;
          const lResult = (lX & 0x3FFFFFFF) + (lY & 0x3FFFFFFF);
          if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8;
          if (lX4 | lY4) {
            if (lResult & 0x40000000) return lResult ^ 0xC0000000 ^ lX8 ^ lY8;
            return lResult ^ 0x40000000 ^ lX8 ^ lY8;
          }
          return lResult ^ lX8 ^ lY8;
        }
        function F(x, y, z) { return (x & y) | (~x & z); }
        function G(x, y, z) { return (x & z) | (y & ~z); }
        function H(x, y, z) { return x ^ y ^ z; }
        function I(x, y, z) { return y ^ (x | ~z); }
        function FF(a, b, c, d, x, s, ac) { a = addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac)); return addUnsigned(rotateLeft(a, s), b); }
        function GG(a, b, c, d, x, s, ac) { a = addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac)); return addUnsigned(rotateLeft(a, s), b); }
        function HH(a, b, c, d, x, s, ac) { a = addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac)); return addUnsigned(rotateLeft(a, s), b); }
        function II(a, b, c, d, x, s, ac) { a = addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac)); return addUnsigned(rotateLeft(a, s), b); }
        function convertToWordArray(strVal) {
          const lWordCount = [];
          let lMessageLength = strVal.length;
          let lNumberOfWordsTempOne = lMessageLength + 8;
          const lNumberOfWordsTempTwo = (lNumberOfWordsTempOne - (lNumberOfWordsTempOne % 64)) / 64;
          const lNumberOfWords = (lNumberOfWordsTempTwo + 1) * 16;
          for (let i = 0; i < lNumberOfWords; i++) lWordCount[i] = 0;
          let lBytePosition = 0;
          let lByteCount = 0;
          while (lByteCount < lMessageLength) {
            const lWordCountIndex = (lByteCount - (lByteCount % 4)) / 4;
            lBytePosition = (lByteCount % 4) * 8;
            lWordCount[lWordCountIndex] |= strVal.charCodeAt(lByteCount) << lBytePosition;
            lByteCount++;
          }
          const lWordCountIndex = (lByteCount - (lByteCount % 4)) / 4;
          lBytePosition = (lByteCount % 4) * 8;
          lWordCount[lWordCountIndex] |= 0x80 << lBytePosition;
          lWordCount[lNumberOfWords - 2] = lMessageLength << 3;
          lWordCount[lNumberOfWords - 1] = lMessageLength >>> 29;
          return lWordCount;
        }
        function wordToHex(lValue) {
          let wordToHexValue = '';
          for (let lCount = 0; lCount <= 3; lCount++) {
            const lByte = (lValue >>> (lCount * 8)) & 255;
            const wordToHexValueTemp = '0' + lByte.toString(16);
            wordToHexValue += wordToHexValueTemp.substr(wordToHexValueTemp.length - 2, 2);
          }
          return wordToHexValue;
        }
        function utf8Encode(string) {
          string = string.replace(/\\r\\n/g, '\\n');
          let utftext = '';
          for (let n = 0; n < string.length; n++) {
            const c = string.charCodeAt(n);
            if (c < 128) utftext += String.fromCharCode(c);
            else if (c < 2048) {
              utftext += String.fromCharCode((c >> 6) | 192);
              utftext += String.fromCharCode((c & 63) | 128);
            } else {
              utftext += String.fromCharCode((c >> 12) | 224);
              utftext += String.fromCharCode(((c >> 6) & 63) | 128);
              utftext += String.fromCharCode((c & 63) | 128);
            }
          }
          return utftext;
        }
        let x = [];
        let k, AA, BB, CC, DD, a, b, c, d;
        const S11 = 7, S12 = 12, S13 = 17, S14 = 22;
        const S21 = 5, S22 = 9 , S23 = 14, S24 = 20;
        const S31 = 4, S32 = 11, S33 = 16, S34 = 23;
        const S41 = 6, S42 = 10, S43 = 15, S44 = 21;
        str = utf8Encode(str);
        x = convertToWordArray(str);
        a = 0x67452301; b = 0xEFCDAB89; c = 0x98BADCFE; d = 0x10325476;
        for (k = 0; k < x.length; k += 16) {
          AA = a; BB = b; CC = c; DD = d;
          a = FF(a, b, c, d, x[k + 0],  S11, 0xD76AA478);
          d = FF(d, a, b, c, x[k + 1],  S12, 0xE8C7B756);
          c = FF(c, d, a, b, x[k + 2],  S13, 0x242070DB);
          b = FF(b, c, d, a, x[k + 3],  S14, 0xC1BDCEEE);
          a = FF(a, b, c, d, x[k + 4],  S11, 0xF57C0FAF);
          d = FF(d, a, b, c, x[k + 5],  S12, 0x4787C62A);
          c = FF(c, d, a, b, x[k + 6],  S13, 0xA8304613);
          b = FF(b, c, d, a, x[k + 7],  S14, 0xFD469501);
          a = FF(a, b, c, d, x[k + 8],  S11, 0x698098D8);
          d = FF(d, a, b, c, x[k + 9],  S12, 0x8B44F7AF);
          c = FF(c, d, a, b, x[k + 10], S13, 0xFFFF5BB1);
          b = FF(b, c, d, a, x[k + 11], S14, 0x895CD7BE);
          a = FF(a, b, c, d, x[k + 12], S11, 0x6B901122);
          d = FF(d, a, b, c, x[k + 13], S12, 0xFD987193);
          c = FF(c, d, a, b, x[k + 14], S13, 0xA679438E);
          b = FF(b, c, d, a, x[k + 15], S14, 0x49B40821);
          a = GG(a, b, c, d, x[k + 1],  S21, 0xF61E2562);
          d = GG(d, a, b, c, x[k + 6],  S22, 0xC040B340);
          c = GG(c, d, a, b, x[k + 11], S23, 0x265E5A51);
          b = GG(b, c, d, a, x[k + 0],  S24, 0xE9B6C7AA);
          a = GG(a, b, c, d, x[k + 5],  S21, 0xD62F105D);
          d = GG(d, a, b, c, x[k + 10], S22, 0x02441453);
          c = GG(c, d, a, b, x[k + 15], S23, 0xD8A1E681);
          b = GG(b, c, d, a, x[k + 4],  S24, 0xE7D3FBC8);
          a = GG(a, b, c, d, x[k + 9],  S21, 0x21E1CDE6);
          d = GG(d, a, b, c, x[k + 14], S22, 0xC33707D6);
          c = GG(c, d, a, b, x[k + 3],  S23, 0xF4D50D87);
          b = GG(b, c, d, a, x[k + 8],  S24, 0x455A14ED);
          a = GG(a, b, c, d, x[k + 13], S21, 0xA9E3E905);
          d = GG(d, a, b, c, x[k + 2],  S22, 0xFCEFA3F8);
          c = GG(c, d, a, b, x[k + 7],  S23, 0x676F02D9);
          b = GG(b, c, d, a, x[k + 12], S24, 0x8D2A4C8A);
          a = HH(a, b, c, d, x[k + 5],  S31, 0xFFFA3942);
          d = HH(d, a, b, c, x[k + 8],  S32, 0x8771F681);
          c = HH(c, d, a, b, x[k + 11], S33, 0x6D9D6122);
          b = HH(b, c, d, a, x[k + 14], S34, 0xFDE5380C);
          a = HH(a, b, c, d, x[k + 1],  S31, 0xA4BEEA44);
          d = HH(d, a, b, c, x[k + 4],  S32, 0x4BDECFA9);
          c = HH(c, d, a, b, x[k + 7],  S33, 0xF6BB4B60);
          b = HH(b, c, d, a, x[k + 10], S34, 0xBEBFBC70);
          a = HH(a, b, c, d, x[k + 13], S31, 0x289B7EC6);
          d = HH(d, a, b, c, x[k + 0],  S32, 0xEAA127FA);
          c = HH(c, d, a, b, x[k + 3],  S33, 0xD4EF3085);
          b = HH(b, c, d, a, x[k + 6],  S34, 0x04881D05);
          a = HH(a, b, c, d, x[k + 9],  S31, 0xD9D4D039);
          d = HH(d, a, b, c, x[k + 12], S32, 0xE6DB99E5);
          c = HH(c, d, a, b, x[k + 15], S33, 0x1FA27CF8);
          b = HH(b, c, d, a, x[k + 2],  S34, 0xC4AC5665);
          a = II(a, b, c, d, x[k + 0],  S41, 0xF4292244);
          d = II(d, a, b, c, x[k + 7],  S42, 0x432AFF97);
          c = II(c, d, a, b, x[k + 14], S43, 0xAB9423A7);
          b = II(b, c, d, a, x[k + 5],  S44, 0xFC93A039);
          a = II(a, b, c, d, x[k + 12], S41, 0x655B59C3);
          d = II(d, a, b, c, x[k + 3],  S42, 0x8F0CCC92);
          c = II(c, d, a, b, x[k + 10], S43, 0xFFEFF47D);
          b = II(b, c, d, a, x[k + 1],  S44, 0x85845DD1);
          a = II(a, b, c, d, x[k + 8],  S41, 0x6FA87E4F);
          d = II(d, a, b, c, x[k + 15], S42, 0xFE2CE6E0);
          c = II(c, d, a, b, x[k + 6],  S43, 0xA3014314);
          b = II(b, c, d, a, x[k + 13], S44, 0x4E0811A1);
          a = II(a, b, c, d, x[k + 4],  S41, 0xF7537E82);
          d = II(d, a, b, c, x[k + 11], S42, 0xBD3AF235);
          c = II(c, d, a, b, x[k + 2],  S43, 0x2AD7D2BB);
          b = II(b, c, d, a, x[k + 9],  S44, 0xEB86D391);
          a = addUnsigned(a, AA); b = addUnsigned(b, BB); c = addUnsigned(c, CC); d = addUnsigned(d, DD);
        }
        const temp = wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d);
        return temp.toLowerCase();
      }

      function deriveVideoHashFromParts(filename, fallbackId) {
        const name = (filename && String(filename).trim()) || '';
        const fallback = (fallbackId && String(fallbackId).trim()) || '';
        const base = [name, fallback].filter(Boolean).join('::');
        if (!base) return '';
        return md5hex(base).substring(0, 16);
      }

      function extractStreamFilename(streamUrl) {
        try {
          const url = new URL(streamUrl);
          const paramKeys = ['filename', 'file', 'name', 'download', 'dn'];
          for (const key of paramKeys) {
            const val = url.searchParams.get(key);
            if (val && val.trim()) return decodeURIComponent(val.trim().split('/').pop());
          }
          const parts = (url.pathname || '').split('/').filter(Boolean);
          if (!parts.length) return '';
          return decodeURIComponent(parts[parts.length - 1]);
        } catch (_) {
          return '';
        }
      }

      function extractStreamVideoId(streamUrl) {
        try {
          const url = new URL(streamUrl);
          const paramKeys = ['videoId', 'video', 'id', 'mediaid', 'imdb', 'tmdb', 'kitsu', 'anidb', 'mal', 'anilist'];
          for (const key of paramKeys) {
            const val = url.searchParams.get(key);
            if (val && val.trim()) return val.trim();
          }
          const parts = (url.pathname || '').split('/').filter(Boolean);
          const directId = parts.find(p => /^tt\\d+/i.test(p) || p.includes(':'));
          if (directId) return directId.trim();
          return '';
        } catch (_) {
          return '';
        }
      }

      function deriveStreamHashFromUrl(streamUrl, fallback = {}) {
        const filename = extractStreamFilename(streamUrl) || fallback.filename || '';
        const streamVideoId = extractStreamVideoId(streamUrl) || fallback.videoId || '';
        const hash = deriveVideoHashFromParts(filename, streamVideoId);
        return { hash, filename, videoId: streamVideoId, source: 'stream-url' };
      }

      const LOG_LIMIT = 250;
      function appendLog(message, tone = 'muted') {
        if (!els.log || !message) return;
        const entry = document.createElement('div');
        entry.className = 'log-entry ' + (tone ? `log-${tone}` : 'log-muted');

        const time = document.createElement('span');
        time.className = 'log-time';
        time.textContent = new Date().toLocaleTimeString();

        const text = document.createElement('span');
        text.className = 'log-text';
        text.textContent = message;

        entry.appendChild(time);
        entry.appendChild(text);
        els.log.insertBefore(entry, els.log.firstChild);

        while (els.log.childNodes.length > LOG_LIMIT) {
          els.log.removeChild(els.log.lastChild);
        }
      }

      function appendServerLogs(logs) {
        if (!Array.isArray(logs)) return;
        logs.forEach((entry) => {
          if (!entry) return;
          const level = (entry.level || entry.tone || '').toString().toLowerCase();
          const tone = level === 'error' ? 'error' : (level === 'warn' ? 'warn' : (level === 'success' ? 'success' : 'info'));
          const msg = entry.message || entry.msg || '';
          if (!msg) return;
          appendLog(msg, tone);
        });
      }

      function clearLog() {
        if (!els.log) return;
        els.log.innerHTML = '';
      }

      function setStatus(text) {
        if (els.status) els.status.textContent = text;
      }

      function setProgress(pct) {
        if (els.progress) els.progress.style.width = Math.min(100, Math.max(0, pct || 0)) + '%';
      }

      function cleanDisplayNameClient(raw) {
        if (!raw) return '';
        const lastSegment = String(raw).split(/[/\\]/).pop() || '';
        const withoutExt = lastSegment.replace(/\.[^.]+$/, '');
        const spaced = withoutExt.replace(/[_\\.]+/g, ' ').replace(/\s+/g, ' ').trim();
        return spaced || withoutExt || lastSegment;
      }

      function formatEpisodeTagDisplay(videoId) {
        const parts = (videoId || '').split(':');
        if (parts.length >= 3) {
          const season = parseInt(parts[1], 10);
          const episode = parseInt(parts[2], 10);
          const s = Number.isFinite(season) ? 'S' + String(season).padStart(2, '0') : '';
          const e = Number.isFinite(episode) ? 'E' + String(episode).padStart(2, '0') : '';
          if (s || e) return (s + e).trim();
        }
        return '';
      }

      async function fetchLinkedTitle(videoId) {
        const trimmed = (videoId || '').trim();
        if (!trimmed) return '';
        const parts = trimmed.split(':');
        let metaId = '';
        if (parts[0] === 'tmdb' && parts[1]) {
          metaId = 'tmdb:' + parts[1];
        } else {
          const imdbId = (parts[0] || '').replace(/^tt/i, 'tt');
          if (/^tt\\d{3,}$/i.test(imdbId)) metaId = imdbId.toLowerCase();
        }
        if (!metaId) return '';
        const metaType = parts.length >= 3 ? 'series' : 'movie';
        const metaUrl = 'https://v3-cinemeta.strem.io/meta/' + metaType + '/' + encodeURIComponent(metaId) + '.json';
        try {
          const resp = await fetch(metaUrl);
          if (!resp.ok) throw new Error('meta fetch failed');
          const data = await resp.json();
          return data?.meta?.name || data?.meta?.english_name || data?.meta?.nameTranslated?.en || '';
        } catch (_) {
          return '';
        }
      }

      function renderVideoMeta(source = {}) {
        if (!els.videoMetaTitle || !els.videoMetaSubtitle) return;
        const episodeLabel = formatEpisodeTagDisplay(source.videoId);
        const fallbackTitle = cleanDisplayNameClient(source.filename) || cleanDisplayNameClient(source.videoId) || copy.videoMeta.none;
        const resolvedTitle = source.title || fallbackTitle || copy.videoMeta.none;
        const details = [];
        if (source.title) details.push('Title: ' + source.title);
        else if (source.videoId) details.push('Video ID: ' + source.videoId);
        if (episodeLabel) details.push('Episode: ' + episodeLabel);
        if (source.filename) details.push('File: ' + cleanDisplayNameClient(source.filename));
        els.videoMetaTitle.textContent = resolvedTitle;
        els.videoMetaSubtitle.textContent = details.join(' - ') || copy.videoMeta.waiting;
      }

      async function hydrateVideoMeta(source = {}) {
        renderVideoMeta(source);
        if (!source.videoId || source.title) return;
        const requestId = ++videoMetaRequestId;
        const fetched = await fetchLinkedTitle(source.videoId);
        if (requestId !== videoMetaRequestId || !fetched) return;
        renderVideoMeta({ ...source, title: fetched });
      }

      function resetPills() {
        Object.values(stepPills).forEach((pill) => {
          if (!pill) return;
          pill.classList.remove('check', 'warn', 'danger');
          pill.textContent = pill.textContent.replace(/^(OK|-)/, '-');
        });
      }

      function markStep(step, state = 'check') {
        const pill = stepPills[step];
        if (!pill) return;
        pill.classList.remove('check', 'warn', 'danger');
        pill.classList.add(state);
        const baseLabel = pill.textContent.replace(/^(OK|-)/, '').trim();
        const okLabel = tt('toolbox.autoSubs.status.ok', {}, 'OK');
        pill.textContent = state === 'check' ? `${okLabel} ${baseLabel}` : `- ${baseLabel}`;
      }

      function setInFlight(active) {
        state.autoSubsInFlight = !!active;
        if (els.startBtn) {
          els.startBtn.textContent = active ? tt('toolbox.autoSubs.status.running', {}, 'Running...') : startBtnLabel;
        }
        applyStartDisabled(isStep3Ready());
      }

      function getSelectedTargets() {
        if (!els.targetLang) return [];
        const val = (els.targetLang.value || '').trim();
        return val ? [val] : [];
      }

      function hydrateTargets() {
        if (!els.targetLang) return;
        const preferred = Array.isArray(BOOTSTRAP.targetLanguages) ? BOOTSTRAP.targetLanguages : [];
        const desired = preferred.find(Boolean) || '';
        const hasDesired = desired && Array.from(els.targetLang.options || []).some(opt => opt.value === desired);
        if (hasDesired) {
          els.targetLang.value = desired;
        } else if (els.targetLang.options.length) {
          els.targetLang.selectedIndex = 0;
        }
      }

      function renderProviders() {
        if (!els.provider) return;
        const options = Array.isArray(BOOTSTRAP.providerOptions) ? BOOTSTRAP.providerOptions : [];
      els.provider.innerHTML = '';
      if (!options.length) {
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = tt('toolbox.autoSubs.providers.missing', {}, 'No provider configured');
        els.provider.appendChild(empty);
        return;
      }
      options.forEach((opt) => {
        const o = document.createElement('option');
        o.value = opt.key || opt.value || opt;
        o.textContent = opt.label || formatProviderName(opt.key || opt.value || opt);
        if (opt.model) o.dataset.model = opt.model;
        els.provider.appendChild(o);
      });
      const desired = BOOTSTRAP.defaults?.provider || options[0]?.key || '';
      if (desired) els.provider.value = desired;
      renderProviderModels();
    }

      function renderProviderModels() {
        if (!els.providerModel) return;
        const selectedProvider = (els.provider?.value || '').toString().toLowerCase();
        const options = Array.isArray(BOOTSTRAP.providerOptions) ? BOOTSTRAP.providerOptions : [];
        const match = options.find(opt => (opt.key || opt.value || '').toString().toLowerCase() === selectedProvider);
        const configuredModel = match?.model || '';
        const desired = BOOTSTRAP.defaults?.translationModel || '';
        const current = els.providerModel.value || '';
        const seen = new Set();
        const addOption = (value, label) => {
          const key = String(value);
          if (seen.has(key)) return;
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = label;
          els.providerModel.appendChild(opt);
          seen.add(key);
        };
        els.providerModel.innerHTML = '';
        addOption('', copy.steps.providerModelPlaceholder || 'Use provider default');
        if (configuredModel) {
          const label = tt('toolbox.autoSubs.steps.providerModelConfigured', { model: configuredModel }, `Configured: ${configuredModel}`);
          addOption(configuredModel, label);
        }
        if (desired && desired !== configuredModel) {
          addOption(desired, desired);
        }
        if (current && !seen.has(current)) {
          addOption(current, current);
        }
        const next = desired || configuredModel || current || '';
        if (next && seen.has(next)) {
          els.providerModel.value = next;
        } else {
          els.providerModel.value = '';
        }
      }

      function toggleModeDetails() {
        const mode = (els.modeSelect?.value || '').toString().toLowerCase();
        const showDetails = mode !== 'local';
        if (els.modeDetails) {
          els.modeDetails.style.display = showDetails ? '' : 'none';
        }
      }

      function toggleTranslationStep() {
        const enabled = els.translateToggle?.checked === true;
        if (els.translationStep) {
          els.translationStep.style.display = enabled ? '' : 'none';
          els.translationStep.setAttribute('aria-hidden', enabled ? 'false' : 'true');
        }
        if (els.translationSettingsToggle) {
          els.translationSettingsToggle.disabled = !enabled;
        }
        [els.provider, els.providerModel, els.targetLang, els.batchMode, els.timestampsMode].forEach((el) => {
          if (el) el.disabled = !enabled;
        });
        if (!enabled) {
          toggleTranslationSettings(false);
        }
        refreshStepLocks();
      }

      function toggleTranslationSettings(forceOpen = null) {
        const container = els.translationSettings;
        const toggle = els.translationSettingsToggle;
        const content = els.translationSettingsContent;
        if (!container || !toggle || !content) return;
        const shouldOpen = typeof forceOpen === 'boolean'
          ? forceOpen
          : !container.classList.contains('open');
        container.classList.toggle('open', shouldOpen);
        content.style.display = shouldOpen ? 'block' : 'none';
        toggle.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
      }

      function setDownloads(original, translations) {
        if (els.dlSrt) {
          if (original?.srt) {
            const blob = new Blob([original.srt], { type: 'text/plain' });
            els.dlSrt.href = original.downloadUrl || URL.createObjectURL(blob);
            els.dlSrt.download = (PAGE.videoHash || 'video') + '_' + (original.languageCode || 'und') + '_autosub.srt';
            els.dlSrt.disabled = false;
          } else {
            els.dlSrt.disabled = true;
          }
        }
        if (els.dlVtt) {
          if (original?.vtt) {
            const blob = new Blob([original.vtt], { type: 'text/vtt' });
            els.dlVtt.href = original.downloadUrl || URL.createObjectURL(blob);
            els.dlVtt.download = (PAGE.videoHash || 'video') + '_' + (original.languageCode || 'und') + '_autosub.vtt';
            els.dlVtt.disabled = false;
          } else {
            els.dlVtt.disabled = true;
          }
        }

        if (els.translations) {
          els.translations.innerHTML = '';
          if (Array.isArray(translations) && translations.length) {
            translations.forEach((entry) => {
              const card = document.createElement('div');
              card.className = 'card';
              const title = document.createElement('div');
              title.style.fontWeight = '700';
              const langLabel = entry.languageCode || '';
              title.textContent = langLabel
                ? tt('toolbox.autoSubs.steps.translationCardTitle', { lang: langLabel }, 'Translated ' + langLabel)
                : tt('toolbox.autoSubs.steps.translationCardFallback', {}, 'Translated subtitle');
              card.appendChild(title);
              if (entry.error) {
                const err = document.createElement('div');
                err.style.color = 'var(--danger)';
                err.textContent = entry.error;
                card.appendChild(err);
              } else if (entry.srt) {
                const actions = document.createElement('div');
                actions.className = 'controls';
                const btn = document.createElement('a');
                btn.className = 'btn secondary';
                const blob = new Blob([entry.srt], { type: 'text/plain' });
                btn.href = entry.downloadUrl || URL.createObjectURL(blob);
                btn.download = (PAGE.videoHash || 'video') + '_' + (entry.languageCode || 'lang') + '_autosub.srt';
                btn.textContent = tt('toolbox.autoSubs.actions.downloadTranslation', { lang: entry.languageCode || 'subtitle' }, 'Download ' + (entry.languageCode || 'subtitle'));
                actions.appendChild(btn);
                card.appendChild(actions);
              }
              els.translations.appendChild(card);
            });
          } else {
            const empty = document.createElement('div');
            empty.style.color = 'var(--text-secondary)';
            empty.textContent = tt('toolbox.autoSubs.steps.translationsEmpty', {}, 'No translations yet.');
            els.translations.appendChild(empty);
          }
        }
      }

      function setPreview(content) {
        if (els.srtPreview) {
          els.srtPreview.textContent = content || tt('toolbox.autoSubs.status.noOutput', {}, 'No output yet.');
        }
      }

      function handleHashStatus(hashes = {}, cacheBlocked = false) {
        const hashEl = els.hashStatus;
        const linked = hashes.linked || PAGE.videoHash || '';
        const streamHash = hashes.stream || '';
        const hasMismatch = linked && streamHash && linked !== streamHash;
        const cacheFlag = cacheBlocked || hasMismatch;
        state.cacheBlocked = cacheFlag;
        if (els.hashBadgeValue) {
          const fallback = tt('toolbox.autoSubs.badges.pending', {}, 'pending');
          const badgeValue = linked || streamHash || fallback;
          els.hashBadgeValue.textContent = badgeValue;
        }
        if (els.hashBadge) {
          els.hashBadge.classList.remove('warn');
        }
        if (els.hashBadgeDot) {
          els.hashBadgeDot.className = 'status-dot ok';
        }
        if (hashEl) {
          hashEl.classList.remove('warn', 'danger', 'success');
          if (hasMismatch) {
            hashEl.textContent = 'Hash mismatch detected.';
            hashEl.classList.add('danger');
          } else if (streamHash) {
            hashEl.textContent = 'Hash 1 = Hash 2';
            hashEl.classList.add('success');
          } else {
            hashEl.textContent = tt('toolbox.autoSubs.hash.waiting', {}, 'Waiting for stream hash...');
          }
        }
        if (hasMismatch) {
          setHashMismatchAlert(buildHashMismatchAlert(linked, streamHash));
        } else {
          setHashMismatchAlert('');
        }
      }

      function updateHashStatusFromInput() {
        if (!els.streamUrl) return;
        const url = (els.streamUrl.value || '').trim();
        if (!url) {
          handleHashStatus({ linked: PAGE.videoHash, stream: '' }, false);
          return;
        }
        const derived = deriveStreamHashFromUrl(url, { filename: PAGE.filename, videoId: PAGE.videoId });
        handleHashStatus({ linked: PAGE.videoHash, stream: derived.hash }, state.cacheBlocked);
      }

      async function runAutoSubs() {
        if (state.autoSubsInFlight) return;
        if (!state.step1Confirmed) {
          const message = lockReasons.needContinue;
          appendLog(message, 'warn');
          setStatus(message);
          refreshStepLocks(message);
          return;
        }
        const stream = (els.streamUrl?.value || '').trim();
        if (!stream) {
          appendLog(tt('toolbox.autoSubs.logs.noStream', {}, 'Paste a stream URL first.'), 'warn');
          setStatus(tt('toolbox.autoSubs.status.awaiting', {}, 'Awaiting input...'));
          return;
        }
        const translateEnabled = els.translateToggle?.checked === true;
        const targets = translateEnabled ? getSelectedTargets() : [];
        if (translateEnabled && targets.length === 0) {
          const message = lockReasons.needTarget || tt('toolbox.autoSubs.logs.noTargets', {}, 'Select at least one target language or disable translation.');
          appendLog(message, 'warn');
          setStatus(message);
          refreshStepLocks(message);
          return;
        }
        clearLog();
        appendLog(tt('toolbox.autoSubs.logs.previewPlan', {}, 'Pipeline: fetch -> transcribe -> align -> translate -> deliver.'), 'info');
        setInFlight(true);
        resetPills();
        markStep('fetch', 'check');
        markStep('transcribe', 'warn');
        markStep('align', 'warn');
        markStep('translate', 'warn');
        setStatus(tt('toolbox.autoSubs.status.fetching', {}, 'Fetching stream...'));
        setProgress(10);
        const modeValue = (els.modeSelect?.value || 'cloudflare').toLowerCase();
        const modeLabel = els.modeSelect?.selectedOptions?.[0]?.textContent || 'Cloudflare Workers AI';
        appendLog(tt('toolbox.autoSubs.logs.sendingRequest', {}, 'Sending request to the selected auto-subtitles engine...') + ' [' + modeLabel + ']', 'info');

        const payload = {
          configStr: PAGE.configStr,
          streamUrl: stream,
          videoId: PAGE.videoId,
          filename: PAGE.filename,
          engine: modeValue === 'local' ? 'local' : 'remote',
          model: els.model?.value || '@cf/openai/whisper',
          sourceLanguage: els.sourceLang?.value || '',
          targetLanguages: targets,
          translate: translateEnabled,
          translationProvider: els.provider?.value || '',
          translationModel: (els.providerModel?.value || '').trim(),
          sendTimestampsToAI: (els.timestampsMode?.value || '') === 'send',
          singleBatchMode: (els.batchMode?.value || '') === 'single',
          translationPrompt: '',
          diarization: els.diarization?.checked === true
        };

        let serverLogs = [];
        try {
          const resp = await fetch('/api/auto-subtitles/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const clone = resp.clone();
          let data = {};
          try {
            data = await clone.json();
          } catch (_) {
            try {
              const text = await clone.text();
              if (text) data = { message: text.slice(0, 400) };
            } catch (_) {
              data = {};
            }
          }
          serverLogs = Array.isArray(data?.logTrail) ? data.logTrail : [];
          const upstreamHint = (data?.cfStatus && Number(data.cfStatus) >= 500)
            ? tt('toolbox.autoSubs.logs.upstream', {}, 'Cloudflare Workers AI returned a 5xx response. This is usually temporary; try again shortly or verify your account limits.')
            : '';
          if (!resp.ok || data.success !== true) {
            const cfStatusLabel = data?.cfStatus ? ` [Cloudflare ${data.cfStatus}]` : '';
            const msg = data?.error || data?.message || data?.details || `Request failed (${resp.status})`;
            const combined = [msg + cfStatusLabel, upstreamHint].filter(Boolean).join(' ');
            const err = new Error(combined);
            err.serverLogs = serverLogs;
            throw err;
          }
          appendServerLogs(serverLogs);
          handleHashStatus(data.hashes || {}, data.cacheBlocked);
          markStep('transcribe', 'check');
          setProgress(60);
          markStep('align', 'check');
          setProgress(80);
          setStatus(tt('toolbox.autoSubs.status.transcriptionDone', {}, 'Transcription complete. Preparing downloads...'));
          setPreview(data.original?.srt || '');
          setDownloads(data.original, data.translations || []);
          if (payload.translate && targets.length) {
            markStep('translate', (data.translations || []).some(t => t.error) ? 'warn' : 'check');
          } else {
            markStep('translate', 'warn');
          }
          markStep('deliver', 'check');
          setProgress(100);
          setStatus(tt('toolbox.autoSubs.status.done', {}, 'Done. Ready to download.'));
          const finishedMsg = tt('toolbox.autoSubs.logs.finished', {}, 'Finished. Downloads are ready.');
          const cacheSkipped = data.cacheBlocked ? ' ' + tt('toolbox.autoSubs.logs.cacheSkipped', {}, 'Cache uploads were skipped due to hash mismatch.') : '';
          appendLog(finishedMsg + cacheSkipped, 'success');
        } catch (error) {
          markStep('transcribe', 'danger');
          markStep('align', 'danger');
          markStep('translate', 'danger');
          setStatus(tt('toolbox.autoSubs.status.failedPrefix', {}, 'Failed: ') + error.message);
          appendServerLogs(error?.serverLogs || serverLogs);
          appendLog(tt('toolbox.autoSubs.logs.errorPrefix', {}, 'Error: ') + error.message, 'error');
        } finally {
          setInFlight(false);
        }
      }

      function previewPlan() {
        setStatus(tt('toolbox.autoSubs.status.previewPlan', {}, 'Pipeline: fetch -> transcribe -> align -> translate -> deliver.'));
      }

      function initDefaults() {
        const preferredMode = (BOOTSTRAP.defaults?.mode || 'cloudflare').toLowerCase();
        if (els.modeSelect) {
          const options = Array.from(els.modeSelect.options || []);
          const hasPreferred = options.some(opt => opt.value.toLowerCase() === preferredMode && !opt.disabled);
          if (hasPreferred) {
            els.modeSelect.value = preferredMode;
          } else if (options.length) {
            const firstEnabled = options.find(opt => !opt.disabled);
            if (firstEnabled) els.modeSelect.value = firstEnabled.value;
          }
          toggleModeDetails();
        }
        if (els.model) {
          const desiredModel = BOOTSTRAP.defaults?.whisperModel;
          const opts = Array.from(els.model.options || []);
          const hasDesired = desiredModel && opts.some(opt => opt.value === desiredModel);
          if (hasDesired) {
            els.model.value = desiredModel;
          } else if (!els.model.value && opts.length) {
            els.model.value = opts[0].value;
          }
        }
        if (els.translateToggle) {
          els.translateToggle.checked = BOOTSTRAP.defaults?.translateToTarget !== false;
        }
        if (els.batchMode) {
          els.batchMode.value = BOOTSTRAP.defaults?.singleBatchMode ? 'single' : 'multi';
        }
        if (els.timestampsMode) {
          els.timestampsMode.value = BOOTSTRAP.defaults?.sendTimestampsToAI ? 'send' : 'original';
        }
        if (els.diarization) {
          els.diarization.checked = BOOTSTRAP.defaults?.diarization === true;
        }
        hydrateVideoMeta({
          title: BOOTSTRAP.linkedTitle || '',
          videoId: PAGE.videoId,
          filename: PAGE.filename
        });
        hydrateTargets();
        renderProviders();
        if (els.providerModel && BOOTSTRAP.defaults?.translationModel) {
          els.providerModel.value = BOOTSTRAP.defaults.translationModel;
        }
        toggleTranslationStep();
        toggleTranslationSettings(false);
        updateHashStatusFromInput();
        refreshStepLocks(lockReasons.needContinue);
      }

      function bindEvents() {
        els.startBtn?.addEventListener('click', runAutoSubs);
        els.previewBtn?.addEventListener('click', previewPlan);
        if (els.streamUrl) {
          const handleEdit = () => {
            if (state.step1Confirmed) resetStepFlow(lockReasons.needContinue);
            updateHashStatusFromInput();
          };
          els.streamUrl.addEventListener('input', handleEdit);
        }
        els.streamUrl?.addEventListener('blur', updateHashStatusFromInput);
        els.streamUrl?.addEventListener('change', updateHashStatusFromInput);
        els.translateToggle?.addEventListener('change', () => {
          toggleTranslationStep();
          refreshStepLocks();
        });
        els.modeSelect?.addEventListener('change', toggleModeDetails);
        els.translationSettingsToggle?.addEventListener('click', () => toggleTranslationSettings());
        els.provider?.addEventListener('change', renderProviderModels);
        els.targetLang?.addEventListener('change', () => refreshStepLocks());
        els.continueBtn?.addEventListener('click', () => {
          const stream = (els.streamUrl?.value || '').trim();
          const linkedHash = PAGE.videoHash || '';
          const fallback = { filename: PAGE.filename, videoId: PAGE.videoId };
          const invalidMsg = tt('toolbox.logs.invalidUrl', {}, 'Invalid stream URL. Paste a full http/https link.');
          const missingMsg = tt('toolbox.autoSubs.logs.noStream', {}, 'Paste a stream URL first.');
          const mismatchMsg = HASH_MISMATCH_LINES[0] || tt('toolbox.embedded.step1.hashMismatchLine1', {}, 'Hashes must match before extraction can start.');

          const resetWithReason = (reason) => {
            resetStepFlow(reason || lockReasons.needContinue);
            if (reason) setStatus(reason);
          };

          if (!stream) {
            appendLog(missingMsg, 'warn');
            resetWithReason(missingMsg);
            updateHashStatusFromInput();
            return;
          }
          if (!isLikelyStreamUrl(stream)) {
            appendLog(invalidMsg, 'warn');
            resetWithReason(invalidMsg);
            updateHashStatusFromInput();
            return;
          }

          let derived = { hash: '', filename: '', videoId: '', source: 'stream-url' };
          try {
            derived = deriveStreamHashFromUrl(stream, fallback);
          } catch (_) {
            derived = { hash: '', filename: '', videoId: '', source: 'stream-url' };
          }
          const hasMismatch = linkedHash && derived.hash && linkedHash !== derived.hash;
          if (hasMismatch) {
            const alert = buildHashMismatchAlert(linkedHash, derived.hash);
            setHashMismatchAlert(alert);
            appendLog(mismatchMsg, 'warn');
            resetWithReason(mismatchMsg);
            updateHashStatusFromInput();
            return;
          }

          state.step1Confirmed = true;
          refreshStepLocks();
          updateHashStatusFromInput();
        });
      }

      // Extension messaging (status only)
      (function initExtensionPing() {
        let pingRetries = 0;
        let pingTimer = null;
        const MAX_PING_RETRIES = 5;
        const EXT_INSTALL_URL = (els.extLabel && els.extLabel.getAttribute('href')) || 'https://chromewebstore.google.com/detail/submaker-xsync/lpocanpndchjkkpgchefobjionncknjn';
        function updateExtensionStatus(ready, text, tone) {
          state.extensionReady = ready;
          const dotTone = ready ? 'ok' : (tone || 'bad');
          if (els.extDot) els.extDot.className = 'status-dot ' + dotTone;
          if (els.extLabel) {
            const readyText = text || tt('toolbox.status.ready', {}, 'Ready');
            const missingText = text || tt('toolbox.autoSubs.extension.notDetected', {}, 'Extension not detected');
            els.extLabel.textContent = ready ? readyText : missingText;
            if (ready) {
              els.extLabel.classList.add('ready');
              els.extLabel.removeAttribute('href');
              els.extLabel.removeAttribute('target');
              els.extLabel.removeAttribute('rel');
            } else {
              els.extLabel.classList.remove('ready');
              els.extLabel.setAttribute('href', EXT_INSTALL_URL);
              els.extLabel.setAttribute('target', '_blank');
              els.extLabel.setAttribute('rel', 'noopener noreferrer');
            }
          }
          if (els.extStatus) els.extStatus.title = text || '';
        }
        window.addEventListener('message', (event) => {
          const msg = event.data || {};
          if (msg.source !== 'extension') return;
          if (msg.type === 'SUBMAKER_PONG') {
            pingRetries = 0;
            if (pingTimer) {
              clearTimeout(pingTimer);
              pingTimer = null;
            }
            const readyLabel = msg.version
              ? tt('toolbox.autoSubs.extension.readyWithVersion', { version: msg.version || '-' }, 'Ready (v' + (msg.version || '-') + ')')
              : tt('toolbox.autoSubs.extension.ready', {}, 'Ready');
            updateExtensionStatus(true, readyLabel);
          }
        });
        function sendPing() {
          if (pingTimer) {
            clearTimeout(pingTimer);
            pingTimer = null;
          }
          pingRetries = 0;
          const tick = () => {
            if (state.extensionReady) return;
            pingRetries += 1;
            const label = tt('toolbox.status.pinging', {}, 'Pinging extension...');
            updateExtensionStatus(false, label, 'warn');
            window.postMessage({ type: 'SUBMAKER_PING', source: 'webpage' }, '*');
            if (pingRetries >= MAX_PING_RETRIES && !state.extensionReady) {
              const notDetected = tt('toolbox.autoSubs.extension.notDetected', {}, 'Extension not detected');
              updateExtensionStatus(false, notDetected, 'bad');
              return;
            }
            pingTimer = setTimeout(tick, 5000);
          };
          tick();
        }
        setTimeout(sendPing, 500);
      })();

      bindEvents();
      initDefaults();

      // Episode change watcher (toast + manual update)
      initStreamWatcher({
        configStr: PAGE.configStr,
        current: { videoId: PAGE.videoId, filename: PAGE.filename, videoHash: PAGE.videoHash },
        buildUrl: (payload) => {
          return '/auto-subtitles?config=' + encodeURIComponent(PAGE.configStr) +
            '&videoId=' + encodeURIComponent(payload.videoId || '') +
            '&filename=' + encodeURIComponent(payload.filename || '');
        },
        onEpisode: handleStreamUpdate,
        notify: forwardMenuNotification
      });
    })();
  }

  const defaults = {
    mode: 'cloudflare',
    whisperModel: config?.whisperModel || '@cf/openai/whisper',
    diarization: false,
    translateToTarget: true,
    streamFilename: filename || '',
    provider: (config?.mainProvider && String(config.mainProvider).toLowerCase()) || providerOptions[0]?.key || 'gemini',
    translationModel: config?.geminiModel || '',
    sendTimestampsToAI: config?.advancedSettings?.sendTimestampsToAI === true,
    singleBatchMode: config?.singleBatchMode === true
  };

  const themeToggleLabel = t('fileUpload.themeToggle', {}, 'Toggle theme');
  const copy = {
    meta: {
      title: t('toolbox.autoSubs.documentTitle', {}, 'Automatic Subtitles - SubMaker')
    },
    toast: {
      title: t('toolbox.toast.title', {}, 'New stream detected'),
      meta: t('toolbox.toast.meta', {}, 'A different episode is playing in Stremio.'),
      dismiss: t('toolbox.toast.dismiss', {}, 'Dismiss notification'),
      update: t('toolbox.toast.update', {}, 'Update')
    },
    hero: {
      title: t('toolbox.autoSubs.heroTitle', {}, 'Automatic Subtitles'),
      subtitle: t('toolbox.autoSubs.heroSubtitle', {}, 'Generate subtitles with Whisper then translate')
    },
    log: {
      header: t('toolbox.autoSubs.log.header', {}, 'Live log'),
      sub: t('toolbox.autoSubs.log.sub', {}, 'Watch each pipeline step, errors, and upstream responses here.')
    },
    badges: {
      addon: t('toolbox.status.addon', {}, 'Addon'),
      extension: t('toolbox.status.extension', {}, 'Extension'),
      waitingExtension: t('toolbox.autoSubs.extension.waiting', {}, 'Waiting for extension...'),
      hash: t('toolbox.autoSubs.badges.hash', {}, 'Hash'),
      versionFallback: t('toolbox.autoSubs.badges.versionFallback', {}, 'n/a'),
      pending: t('toolbox.autoSubs.badges.pending', {}, 'pending')
    },
    hash: {
      waiting: t('toolbox.autoSubs.hash.waiting', {}, 'Waiting for stream hash...'),
      cacheDisabled: t('toolbox.autoSubs.hash.cacheDisabled', {}, 'Cache disabled for this run.')
    },
    videoMeta: {
      label: t('toolbox.embedded.videoMeta.label', {}, 'Linked stream'),
      none: t('toolbox.embedded.videoMeta.none', {}, 'No stream linked'),
      unavailable: t('toolbox.embedded.videoMeta.unavailable', {}, 'Video ID unavailable'),
      waiting: t('toolbox.embedded.videoMeta.waiting', {}, 'Waiting for a linked stream...')
    },
    sections: {
      linkAndPrep: t('toolbox.autoSubs.sections.setup', {}, 'Link a stream & prep the model'),
      runAndReview: t('toolbox.autoSubs.sections.run', {}, 'Run pipeline & review output')
    },
    steps: {
      one: t('toolbox.autoSubs.steps.step1Chip', {}, 'Step 1'),
      two: t('toolbox.autoSubs.steps.step2Chip', {}, 'Step 2'),
      three: t('toolbox.autoSubs.steps.step3Chip', {}, 'Step 3'),
      four: t('toolbox.autoSubs.steps.step4Chip', {}, 'Step 4'),
      inputTitle: t('toolbox.autoSubs.steps.step1Title', {}, 'Input audio or video'),
      streamLabel: t('toolbox.autoSubs.steps.streamLabel', {}, 'Stream URL:'),
      streamPlaceholder: t('toolbox.autoSubs.steps.streamPlaceholder', {}, 'https://example.com/video.mkv'),
      langModelTitle: t('toolbox.autoSubs.steps.step2Title', {}, 'Mode & audio'),
      modeLabel: t('toolbox.autoSubs.steps.modeLabel', {}, 'Auto-subtitles mode'),
      modeHelper: t('toolbox.autoSubs.steps.modeHelper', {}, 'Cloudflare Workers AI runs remotely. Local xSync is coming soon.'),
      modeLocal: t('toolbox.autoSubs.steps.modeLocal', {}, 'Local (xSync)'),
      modeRemote: t('toolbox.autoSubs.steps.modeRemote', {}, 'Cloudflare Workers AI'),
      sourceLabel: t('toolbox.autoSubs.steps.sourceLabel', {}, 'Source audio language'),
      autoDetect: t('toolbox.autoSubs.steps.autoDetect', {}, 'Auto-detect'),
      modelLabel: t('toolbox.autoSubs.steps.modelLabel', {}, 'Whisper model'),
      model: {
        standard: t('toolbox.autoSubs.steps.modelStandard', {}, 'Whisper'),
        turbo: t('toolbox.autoSubs.steps.modelTurbo', {}, 'Whisper Large V3 Turbo')
      },
      diarization: t('toolbox.autoSubs.steps.diarization', {}, 'Speaker diarization'),
      translateOutput: t('toolbox.autoSubs.steps.translateOutput', {}, 'Translate to target languages'),
      translationStepChip: t('toolbox.autoSubs.steps.stepTwoFiveChip', {}, 'Step 2.5'),
      translationStepTitle: t('toolbox.autoSubs.steps.stepTwoFiveTitle', {}, 'Translation targets'),
      translationSettingsTitle: t('toolbox.autoSubs.steps.translationSettings', {}, 'Translation settings'),
      translationSettingsMeta: t('toolbox.autoSubs.steps.translationSettingsMeta', {}, 'Batching & timestamps'),
      targetLabel: t('toolbox.autoSubs.steps.targetLabel', {}, 'Target language'),
      providerLabel: t('toolbox.autoSubs.steps.providerLabel', {}, 'Translation provider'),
      providerModelLabel: t('toolbox.autoSubs.steps.providerModelLabel', {}, 'Translation model'),
      providerModelPlaceholder: t('toolbox.autoSubs.steps.providerModelPlaceholder', {}, 'Use provider default'),
      batchingLabel: t('toolbox.autoSubs.steps.batchingLabel', {}, 'Batching'),
      batchingMultiple: t('toolbox.autoSubs.steps.batchingMultiple', {}, 'Multiple batches (recommended)'),
      batchingSingle: t('toolbox.autoSubs.steps.batchingSingle', {}, 'Single batch (all at once)'),
      timestampsLabel: t('toolbox.autoSubs.steps.timestampsLabel', {}, 'Timestamp handling'),
      timestampsRebuild: t('toolbox.autoSubs.steps.timestampsRebuild', {}, 'Rebuild timestamps'),
      sendTimestamps: t('toolbox.autoSubs.steps.sendTimestamps', {}, 'Send timestamps to AI'),
      runPipelineTitle: t('toolbox.autoSubs.steps.step3Title', {}, 'Run pipeline'),
      pipelineDesc: t('toolbox.autoSubs.steps.pipeline', {}, 'We\'ll stitch: fetch -> segment -> transcribe -> align -> translate (optional) -> deliver SRT.'),
      start: t('toolbox.autoSubs.actions.start', {}, 'Start auto-subtitles'),
      previewPlan: t('toolbox.autoSubs.actions.preview', {}, 'Preview plan'),
      progressAria: t('toolbox.autoSubs.actions.progress', {}, 'Progress'),
      awaiting: t('toolbox.autoSubs.status.awaiting', {}, 'Awaiting input...'),
      pills: {
        fetch: t('toolbox.autoSubs.steps.fetchPill', {}, 'Fetch stream'),
        transcribe: t('toolbox.autoSubs.steps.transcribePill', {}, 'Transcribe'),
        align: t('toolbox.autoSubs.steps.alignPill', {}, 'Align + timestamps'),
        translate: t('toolbox.autoSubs.steps.translatePill', {}, 'Translate'),
        deliver: t('toolbox.autoSubs.steps.deliverPill', {}, 'Ready to deliver')
      },
      outputTitle: t('toolbox.autoSubs.steps.step4Title', {}, 'Output'),
      generated: t('toolbox.autoSubs.steps.generatedSrt', {}, 'Generated SRT'),
      noOutput: t('toolbox.autoSubs.status.noOutput', {}, 'No output yet.'),
      downloads: t('toolbox.autoSubs.steps.downloads', {}, 'Downloads'),
      downloadSrt: t('toolbox.autoSubs.actions.downloadSrt', {}, 'Download SRT'),
      downloadVtt: t('toolbox.autoSubs.actions.downloadVtt', {}, 'Download VTT'),
      translationsEmpty: t('toolbox.autoSubs.steps.translationsEmpty', {}, 'No translations yet.'),
      translationCardTitle: t('toolbox.autoSubs.steps.translationCardTitle', { lang: '{lang}' }, 'Translated {lang}'),
      translationCardFallback: t('toolbox.autoSubs.steps.translationCardFallback', {}, 'Translated subtitle'),
      enableAfter: t('toolbox.autoSubs.steps.downloadsNote', {}, 'We\'ll enable downloads after the pipeline finishes.')
    },
    locks: {
      needContinue: t('toolbox.autoSubs.locks.needContinue', {}, 'Click Continue to unlock the next steps.'),
      needTarget: t('toolbox.autoSubs.locks.needTarget', {}, 'Select a target or disable translation to unlock Run.')
    },
    actions: {
      continue: t('toolbox.autoSubs.actions.continue', {}, 'Continue')
    },
    options: {
      addTargets: t('toolbox.autoSubs.options.addTargets', {}, 'Add target languages in Configure')
    },
    simulation: {
      startLabel: t('toolbox.autoSubs.actions.start', {}, 'Start auto-subtitles'),
      running: t('toolbox.autoSubs.status.running', {}, 'Running...'),
      fetching: t('toolbox.autoSubs.status.fetching', {}, 'Fetching stream...'),
      transcribing: t('toolbox.autoSubs.status.transcribing', {}, 'Transcribing with Whisper ({model})'),
      aligning: t('toolbox.autoSubs.status.aligning', {}, 'Aligning and cleaning timestamps'),
      translating: t('toolbox.autoSubs.status.translating', {}, 'Translating to {target}'),
      skippingTranslation: t('toolbox.autoSubs.status.skipTranslate', {}, 'Skipping translation'),
      preparing: t('toolbox.autoSubs.status.preparing', {}, 'Preparing downloads'),
      done: t('toolbox.autoSubs.status.done', {}, 'Done. Ready to download.'),
      previewPlan: t('toolbox.autoSubs.status.previewPlan', {}, 'Pipeline: fetch -> transcribe -> align -> translate -> deliver.'),
      sampleSubtitle: t('toolbox.autoSubs.status.sample', {}, '[Sample subtitle generated by Whisper]'),
      translateFallbackTarget: t('toolbox.autoSubs.status.translateFallbackTarget', {}, 'targets')
    },
    refresh: {
      loading: t('toolbox.refresh.loading', {}, 'Refreshing...'),
      empty: t('toolbox.refresh.empty', {}, 'No stream yet'),
      error: t('toolbox.refresh.error', {}, 'Refresh failed'),
      current: t('toolbox.refresh.current', {}, 'Already latest')
    },
    extension: {
      ready: t('toolbox.status.ready', {}, 'Ready'),
      notDetected: t('toolbox.autoSubs.extension.notDetected', {}, 'Extension not detected'),
      readyWithVersion: t('toolbox.autoSubs.extension.readyVersion', {}, 'Ready (v{version})')
    }
  };
  const metaDetails = [];
  if (linkedTitle) metaDetails.push(t('toolbox.embedded.meta.title', { title: linkedTitle }, `Title: ${linkedTitle}`));
  else if (videoId) metaDetails.push(t('toolbox.embedded.meta.videoId', { id: videoId }, `Video ID: ${videoId}`));
  if (episodeTag) metaDetails.push(t('toolbox.embedded.meta.episode', { episode: episodeTag }, `Episode: ${episodeTag}`));
  if (filename) {
    const cleanedFile = cleanDisplayName(filename);
    metaDetails.push(t('toolbox.embedded.meta.file', { file: cleanedFile }, `File: ${cleanedFile}`));
  }
  const initialVideoTitle = escapeHtml(linkedTitle || cleanDisplayName(filename) || cleanDisplayName(videoId) || copy.videoMeta.none);
  const initialVideoSubtitle = escapeHtml(metaDetails.join(' - ') || copy.videoMeta.unavailable);

  return `
<!DOCTYPE html>
<html lang="${resolveUiLang(config)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(copy.meta.title)}</title>
    ${localeBootstrap}
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
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html { scroll-behavior: smooth; color-scheme: light; }
      /* Removed forced color-scheme override - let theme cascade handle it naturally */

    :root {
      --primary: #08A4D5;
      --primary-light: #33B9E1;
      --primary-dark: #068DB7;
      --secondary: #33B9E1;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --bg-primary: #f7fafc;
      --surface: #ffffff;
      --surface-light: #f3f7fb;
      --surface-muted: #eef2f7;
      --text-primary: #0f172a;
      --text-secondary: #475569;
      --muted: #475569;
      --border: #dbe3ea;
      --shadow: rgba(0, 0, 0, 0.08);
      --glow: rgba(8, 164, 213, 0.25);
    }

    [data-theme="dark"] {
      --primary: #08A4D5;
      --primary-light: #33B9E1;
      --primary-dark: #068DB7;
      --secondary: #33B9E1;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --bg-primary: #0A0E27;
      --surface: #141931;
      --surface-light: #1E2539;
      --surface-muted: #1b2236;
      --text-primary: #E8EAED;
      --text-secondary: #9AA0A6;
      --muted: #9AA0A6;
      --border: #2A3247;
      --shadow: rgba(0, 0, 0, 0.3);
      --glow: rgba(8, 164, 213, 0.35);
    }

    [data-theme="true-dark"] {
      --primary: #08A4D5;
      --primary-light: #33B9E1;
      --primary-dark: #068DB7;
      --secondary: #33B9E1;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --bg-primary: #000000;
      --surface: #0a0a0a;
      --surface-light: #151515;
      --surface-muted: #1b1b1b;
      --text-primary: #E8EAED;
      --text-secondary: #8A8A8A;
      --muted: #8A8A8A;
      --border: #1a1a1a;
      --shadow: rgba(0, 0, 0, 0.8);
      --glow: rgba(8, 164, 213, 0.45);
    }

    ${quickNavStyles()}

      .masthead {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 14px;
        flex-wrap: wrap;
        margin: 0 0 14px;
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
    .page-heading {
      margin: 0;
      font-size: 30px;
      letter-spacing: -0.02em;
      font-weight: 700;
      color: var(--text-primary);
      background: none;
      -webkit-text-fill-color: currentColor;
      -webkit-background-clip: border-box;
      background-clip: border-box;
    }
    .page-subtitle {
      margin: 0;
      color: var(--muted);
      font-weight: 600;
    }
    .notice {
      margin-top: 10px;
      padding: 12px;
      border-radius: 12px;
      background: rgba(8,164,213,0.12);
      border: 1px solid rgba(8,164,213,0.25);
      color: var(--text);
      font-weight: 700;
    }
    .aio-warning {
      margin-top: 12px;
      font-size: 13px;
      line-height: 1.5;
    }
    .badge-row { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; margin-top: 4px; }
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
    .status-labels { display: flex; flex-direction: column; line-height: 1.15; }
    .label-eyebrow { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
    .status-badge strong { font-size: 14px; }
    .status-badge .ext-link {
      font-size: 14px;
      font-weight: 700;
      color: var(--primary);
      text-decoration: underline;
    }
    .status-badge .ext-link.ready {
      color: var(--text-primary);
      text-decoration: none;
      pointer-events: none;
      cursor: default;
      font-weight: 800;
    }
    .status-badge.warn { border-color: rgba(244,63,94,0.25); box-shadow: 0 12px 30px rgba(244,63,94,0.16); }
    .status-dot {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      box-shadow: 0 0 0 0 rgba(8, 164, 213, 0.0);
    }
    .status-dot.ok { background: linear-gradient(135deg, #4ade80, #22c55e); }
    .status-dot.warn { background: linear-gradient(135deg, #fbbf24, #f59e0b); }
    .status-dot.bad { background: linear-gradient(135deg, #f43f5e, #dc2626); }
    .status-dot.pulse { animation: pulse 1.15s ease-in-out infinite; }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(8, 164, 213, 0.22); }
      70% { box-shadow: 0 0 0 10px rgba(8, 164, 213, 0); }
      100% { box-shadow: 0 0 0 0 rgba(8, 164, 213, 0); }
    }

      body {
        margin: 0;
        font-family: 'Inter', 'Space Grotesk', -apple-system, 'Segoe UI', sans-serif;
        background: linear-gradient(135deg, var(--bg-primary) 0%, #ffffff 60%, var(--bg-primary) 100%);
        color: var(--text-primary);
        min-height: 100vh;
        overflow-x: hidden;
        position: relative;
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
      inset: 0;
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

      .wrap {
        max-width: 1200px;
        margin: 0 auto;
        padding: 24px 18px 46px;
        position: relative;
        z-index: 1;
      }

    h1 {
      font-size: 2.4rem;
      font-weight: 800;
      background: linear-gradient(135deg, var(--primary-light) 0%, var(--secondary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 0.4rem;
      letter-spacing: -0.02em;
    }

    p { margin: 0; color: var(--text-secondary); line-height: 1.65; }

    .eyebrow { letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-secondary); font-weight: 700; font-size: 12px; }

    .card {
      margin-top: 16px;
      background: var(--surface);
      backdrop-filter: blur(12px);
      border-radius: 20px;
      padding: 1.75rem;
      border: 1px solid var(--border);
      box-shadow: 0 8px 24px var(--shadow);
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .card:hover {
      border-color: var(--primary);
      box-shadow: 0 12px 32px var(--glow);
      transform: translateY(-2px);
    }

    .hero {
      display: grid;
      grid-template-columns: 1.05fr 0.95fr;
      gap: 20px;
      align-items: center;
      background:
        radial-gradient(120% 120% at 0% 0%, rgba(8,164,213,0.16), transparent 42%),
        radial-gradient(120% 120% at 100% 0%, rgba(255,255,255,0.12), transparent 38%),
        linear-gradient(135deg, var(--surface), var(--surface-light));
    }

    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 12px;
      border-radius: 12px;
      background: var(--surface-muted);
      border: 1px solid var(--border);
      font-weight: 700;
      color: var(--text-primary);
    }

    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 12px; }
    .stat {
      display: grid;
      gap: 4px;
      padding: 12px;
      border-radius: 14px;
      background: var(--surface-light);
      border: 1px solid var(--border);
      box-shadow: 0 8px 18px rgba(0,0,0,0.04);
    }
    .stat strong { font-size: 18px; color: var(--text-primary); }
    .stat span { color: var(--text-secondary); font-weight: 600; }

    .section {
      margin-top: 18px;
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 18px;
      background: var(--surface);
      box-shadow: 0 6px 18px var(--shadow);
    }

    .section h2 { margin: 0 0 12px; display: flex; align-items: center; gap: 10px; font-size: 19px; justify-content: center; }
    .section-number {
      width: 32px;
      height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 10px;
      background: linear-gradient(135deg, var(--primary), var(--secondary));
      color: #fff;
      font-weight: 800;
      font-size: 15px;
      box-shadow: 0 6px 16px var(--glow);
    }

    label { font-weight: 700; color: var(--text-primary); display: block; margin-bottom: 6px; }
    small { color: var(--text-secondary); }

    input[type="text"], select {
      width: 100%;
      padding: 12px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: var(--surface-light);
      font-size: 15px;
      color: var(--text-primary);
    }

    input[type="file"] {
      border: 1px dashed var(--border);
      padding: 12px;
      border-radius: 12px;
      width: 100%;
      background: var(--surface-light);
      color: var(--text-secondary);
    }

    .row { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
    .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 10px; }
    .controls.wrap { justify-content: flex-start; }
    .inline-checkbox { display: flex; gap: 8px; align-items: center; font-weight: 600; color: var(--text-primary); }
    .mode-details { margin-top: 10px; display: grid; gap: 12px; }
    .mode-helper { margin: 6px 0 0; }
    .translation-settings { margin-top: 14px; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--surface-light); }
    .translation-settings-toggle {
      width: 100%;
      background: none;
      border: none;
      padding: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      color: var(--text-primary);
    }
    .translation-settings-toggle .caret { font-weight: 800; }
    .translation-settings-content { padding: 12px; border-top: 1px solid var(--border); display: none; }
    .translation-settings.open .translation-settings-content { display: block; }
    .hash-mismatch-alert {
      margin-top: 10px;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid rgba(239,68,68,0.35);
      background: rgba(239,68,68,0.08);
      color: var(--danger);
      font-weight: 700;
      font-size: 14px;
      box-shadow: 0 8px 22px rgba(239,68,68,0.12);
      display: none;
      width: 100%;
      box-sizing: border-box;
      text-align: center;
      align-self: stretch;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .hash-mismatch-alert .alert-head {
      color: #fff;
      background: linear-gradient(135deg, #ef4444, #b91c1c);
      padding: 6px 12px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 700;
      box-shadow: 0 10px 18px rgba(185,28,28,0.18);
      text-align: center;
      margin: 0 auto 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      flex-wrap: wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .hash-mismatch-alert .alert-body {
      font-size: 13px;
      font-weight: 600;
      line-height: 1.4;
      display: flex;
      flex-direction: column;
      gap: 4px;
      text-align: center;
      color: var(--danger);
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .section-joined .joined-grid {
      position: relative;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 14px;
      align-items: stretch;
    }
    @media (min-width: 1024px) {
      .section-joined .joined-grid::before {
        content: '';
        position: absolute;
        inset: 0;
        margin: auto;
        width: 2px;
        height: 78%;
        background: linear-gradient(180deg, transparent, rgba(8,164,213,0.18), transparent);
        pointer-events: none;
      }
    }
    .step-card {
      position: relative;
      background: linear-gradient(145deg, var(--surface), var(--surface-light));
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 14px;
      box-shadow: 0 10px 24px var(--shadow);
      transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
      display: flex;
      flex-direction: column;
    }
    .step-card:hover { border-color: var(--primary); box-shadow: 0 14px 30px var(--glow); transform: translateY(-2px); }
    .step-card.locked { opacity: 0.55; }
    .step-card.locked::after {
      content: attr(data-locked-label);
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 1rem;
      background: rgba(255, 255, 255, 0.82);
      color: var(--muted);
      font-weight: 700;
      letter-spacing: -0.01em;
      pointer-events: all;
      z-index: 5;
    }
    [data-theme="dark"] .step-card.locked::after,
    [data-theme="true-dark"] .step-card.locked::after {
      background: rgba(10, 12, 22, 0.82);
      color: #d5def3;
    }
    .step-title { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-weight: 800; color: var(--text-primary); }
    .step-chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0.35rem 0.75rem;
      border-radius: 999px;
      background: rgba(8, 164, 213, 0.12);
      color: var(--primary);
      font-weight: 700;
      font-size: 0.85rem;
    }
    .step-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      text-align: center;
    }
    .step-body > * { width: min(100%, 920px); }
    .step-body .controls { justify-content: center; }
    .step-body .row { width: 100%; }
    .step-body .progress,
    .step-body .status,
    .step-body .chips,
    .step-body .log-area { width: 100%; align-self: center; }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 0.55rem;
      padding: 0.65rem 1rem;
      border-radius: 10px;
      border: 1px solid transparent;
      text-decoration: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
      font-weight: 600;
      font-size: 0.95rem;
      cursor: pointer;
      transition: transform 0.2s ease, box-shadow 0.2s ease, filter 0.2s ease;
      background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
      color: #ffffff;
      box-shadow: 0 10px 24px var(--glow);
      white-space: nowrap;
      line-height: 1.1;
    }

    .btn.secondary {
      background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
      color: #ffffff;
      opacity: 0.9;
      box-shadow: 0 10px 22px var(--glow);
    }

    .btn.ghost {
      background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
      color: #ffffff;
      opacity: 0.82;
      border: 1px solid transparent;
      box-shadow: 0 8px 18px var(--glow);
    }

    .btn:hover { transform: translateY(-2px); box-shadow: 0 12px 26px var(--glow); }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; box-shadow: none; }

    .progress {
      margin-top: 12px;
      height: 10px;
      background: var(--surface-muted);
      border-radius: 999px;
      overflow: hidden;
      border: 1px solid var(--border);
    }

    .progress-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(135deg, var(--primary), var(--secondary));
      transition: width 0.25s ease;
    }

    .log-block { width: 100%; }
    .log-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 10px;
      color: var(--text-secondary);
      font-size: 14px;
      font-weight: 600;
    }
    .log-header .label { font-weight: 800; color: var(--text-primary); display: block; }
    .log-header .muted { font-weight: 600; color: var(--text-secondary); display: block; }
    .log-header .pulse {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--success);
      box-shadow: 0 0 0 0 rgba(16,185,129,0.5);
      animation: pulse 2s infinite;
      flex-shrink: 0;
    }
    .log {
      position: relative;
      background: var(--surface-light);
      border: 1px dashed var(--border);
      border-radius: 12px;
      padding: 12px;
      height: 240px;
      overflow-y: auto;
      font-size: 13px;
      line-height: 1.5;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.2);
      background-image:
        linear-gradient(135deg, rgba(8,164,213,0.06) 25%, transparent 25%),
        linear-gradient(135deg, transparent 50%, rgba(8,164,213,0.06) 50%, rgba(8,164,213,0.06) 75%, transparent 75%),
        linear-gradient(to bottom, rgba(255,255,255,0.08), rgba(255,255,255,0));
      background-size: 18px 18px, 18px 18px, auto;
      background-position: 0 0, 9px 9px, 0 0;
    }
    .log-entry {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 10px;
      padding: 6px 0;
      border-bottom: 1px dashed rgba(255,255,255,0.08);
      word-break: break-word;
    }
    .log-entry:last-child { border-bottom: none; }
    .log-time { font-family: 'Space Grotesk', 'SFMono-Regular', 'Roboto Mono', monospace; color: var(--muted); font-weight: 700; }
    .log-text { color: var(--text-secondary); }
    .log-entry.log-success .log-text { color: var(--success); font-weight: 700; }
    .log-entry.log-error .log-text { color: var(--danger); font-weight: 700; }
    .log-entry.log-warn .log-text { color: var(--warning); font-weight: 700; }
    .log-entry.log-info .log-text { color: var(--text-primary); font-weight: 700; }
    .log-entry.log-muted .log-text { color: var(--text-secondary); }

    .status {
      margin-top: 8px;
      font-weight: 700;
      color: var(--text-secondary);
    }

    .pill.check { color: var(--success); border-color: #b3ead6; background: #f0fdf4; }
    .pill.warn { color: var(--warning); border-color: #fde68a; background: #fffbeb; }
    .pill.danger { color: var(--danger); border-color: #fecdd3; background: #fff1f2; }

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

    /* Linked stream card (shared with embedded extractor) */
    .linked-stream-wrapper {
      display: flex;
      justify-content: center;
      margin: 10px auto 0;
      flex-basis: 100%;
      width: 100%;
    }
    .video-meta {
      margin-top: 10px;
      padding: 12px;
      border-radius: 12px;
      border: 1px dashed var(--border);
      background: var(--surface-2);
    }
    #linked-stream-card {
      width: min(780px, 100%);
      text-align: center;
    }
    .video-meta-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin: 0 0 4px;
      font-weight: 700;
    }
    .video-meta-title {
      margin: 0;
      font-weight: 800;
      font-size: 16px;
      letter-spacing: -0.01em;
    }
    .video-meta-subtitle {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 13px;
      word-break: break-word;
    }

    @media (max-width: 900px) {
      .wrap { padding: 2rem 1.25rem; }
      .hero { grid-template-columns: 1fr; }
    }
  ${themeToggleStyles()}
  </style>
  <script src="/js/theme-toggle.js" defer></script>
</head>
<body>
  ${themeToggleMarkup(themeToggleLabel)}
  <div id="episodeToast" class="episode-toast" role="status" aria-live="polite">
    <div class="icon">!</div>
    <div class="content">
      <p class="title" id="episodeToastTitle">${t('toolbox.toast.title', {}, 'New stream detected')}</p>
      <p class="meta" id="episodeToastMeta">${t('toolbox.toast.meta', {}, 'A different episode is playing in Stremio.')}</p>
    </div>
    <button class="close" id="episodeToastDismiss" type="button" aria-label="${t('toolbox.toast.dismiss', {}, 'Dismiss notification')}">×</button>
    <button class="action" id="episodeToastUpdate" type="button">${t('toolbox.toast.update', {}, 'Update')}</button>
  </div>
  ${renderQuickNav(links, 'automaticSubs', false, devMode, t)}
  <div class="wrap">
    <header class="masthead">
      <div class="page-hero">
        <div class="page-icon">🤖</div>
        <h1 class="page-heading">${escapeHtml(copy.hero.title)}</h1>
        <p class="page-subtitle">${escapeHtml(copy.hero.subtitle)}</p>
        <p class="notice warn aio-warning">Do not use this tool at the same time you stream through an AIOStreams <strong>PROXY</strong> for Real-Debrid.</p>
      </div>
      <div class="badge-row">
        ${renderRefreshBadge(t)}
        <div class="status-badge">
          <span class="status-dot ok"></span>
          <div class="status-labels">
            <span class="label-eyebrow">${escapeHtml(copy.badges.addon)}</span>
            <strong>v${escapeHtml(appVersion || copy.badges.versionFallback)}</strong>
          </div>
        </div>
        <div class="status-badge" id="ext-status">
          <span class="status-dot warn" id="ext-dot"></span>
          <div class="status-labels">
            <span class="label-eyebrow">${escapeHtml(copy.badges.extension)}</span>
            <a id="ext-label" class="ext-link" href="https://chromewebstore.google.com/detail/submaker-xsync/lpocanpndchjkkpgchefobjionncknjn" target="_blank" rel="noopener noreferrer">${escapeHtml(copy.badges.waitingExtension)}</a>
          </div>
        </div>
        <div class="status-badge" id="hashBadge">
          <span class="status-dot ok" id="hashBadgeDot"></span>
          <div class="status-labels">
            <span class="label-eyebrow">${escapeHtml(copy.badges.hash)}</span>
            <strong id="hashBadgeValue">${escapeHtml(videoHash || copy.badges.pending)}</strong>
          </div>
        </div>
      </div>
    </header>

    <div class="section section-joined">
      <h2><span class="section-number">1-2</span> ${escapeHtml(copy.sections.linkAndPrep)}</h2>
      <div class="joined-grid">
        <div class="step-card" id="autoStep1Card">
          <div class="step-title"><span class="step-chip">${escapeHtml(copy.steps.one)}</span><span>${escapeHtml(copy.steps.inputTitle)}</span></div>
          <div class="step-body">
            <div class="linked-stream-wrapper">
              <div class="video-meta" id="linked-stream-card">
                <p class="video-meta-label">${escapeHtml(copy.videoMeta.label)}</p>
                <p class="video-meta-title" id="video-meta-title">${initialVideoTitle}</p>
                <p class="video-meta-subtitle" id="video-meta-subtitle">${initialVideoSubtitle}</p>
              </div>
            </div>
            <label for="streamUrl">${escapeHtml(copy.steps.streamLabel)}</label>
            <input type="text" id="streamUrl" placeholder="${escapeHtml(copy.steps.streamPlaceholder)}">
            <div class="hash-mismatch-alert" id="auto-hash-mismatch" role="status" aria-live="polite"></div>
            <div class="controls" style="margin-top:12px;">
              <button class="btn" id="autoContinue"><span>➡️</span> ${escapeHtml(copy.actions.continue)}</button>
            </div>
          </div>
        </div>
        <div class="step-card locked" id="autoStep2Card" data-locked-label="${escapeHtml(copy.locks.needContinue)}">
          <div class="step-title"><span class="step-chip">${escapeHtml(copy.steps.two)}</span><span>${escapeHtml(copy.steps.langModelTitle)}</span></div>
          <div class="step-body">
            <label for="autoSubsMode">${escapeHtml(copy.steps.modeLabel)}</label>
            <select id="autoSubsMode">
              <option value="local" disabled>${escapeHtml(copy.steps.modeLocal)}</option>
              <option value="cloudflare" selected>${escapeHtml(copy.steps.modeRemote)}</option>
            </select>
            <p class="muted mode-helper">${escapeHtml(copy.steps.modeHelper)}</p>
            <div id="modeDetails" class="mode-details">
              <div class="row">
                <div>
                  <label for="detectedLang">${escapeHtml(copy.steps.sourceLabel)}</label>
                  <select id="detectedLang">
                    <option value="">${escapeHtml(copy.steps.autoDetect)}</option>
                    ${sourceLanguageOptions}
                  </select>
                </div>
                <div>
                  <label for="whisperModel">${escapeHtml(copy.steps.modelLabel)}</label>
                  <select id="whisperModel">
                    <option value="@cf/openai/whisper">${escapeHtml(copy.steps.model.standard)}</option>
                    <option value="@cf/openai/whisper-large-v3-turbo">${escapeHtml(copy.steps.model.turbo)}</option>
                  </select>
                </div>
              </div>
              <div class="controls wrap">
                <label class="inline-checkbox">
                  <input type="checkbox" id="enableDiarization"> ${escapeHtml(copy.steps.diarization)}
                </label>
                <label class="inline-checkbox">
                  <input type="checkbox" id="translateOutput" checked> ${escapeHtml(copy.steps.translateOutput)}
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="section" id="translationStep">
      <h2><span class="section-number">2.5</span> ${escapeHtml(copy.steps.translationStepTitle)}</h2>
      <div class="step-card locked" id="autoTranslationCard" data-locked-label="${escapeHtml(copy.locks.needContinue)}">
        <div class="step-title"><span class="step-chip">${escapeHtml(copy.steps.translationStepChip)}</span><span>${escapeHtml(copy.steps.translationStepTitle)}</span></div>
        <div class="step-body">
          <div class="row">
            <div>
              <label for="translationProvider">${escapeHtml(copy.steps.providerLabel)}</label>
              <select id="translationProvider"></select>
            </div>
            <div>
              <label for="translationModel">${escapeHtml(copy.steps.providerModelLabel)}</label>
              <select id="translationModel">
                <option value="">${escapeHtml(copy.steps.providerModelPlaceholder)}</option>
              </select>
            </div>
            <div>
              <label for="targetLang">${escapeHtml(copy.steps.targetLabel)}</label>
              <select id="targetLang">
                ${targetOptions}
              </select>
            </div>
          </div>
          <div class="translation-settings" id="translationSettings">
            <button class="translation-settings-toggle" id="translationSettingsToggle" type="button" aria-expanded="false">
              <div class="toggle-labels">
                <span class="eyebrow">${escapeHtml(copy.steps.translationSettingsTitle)}</span>
                <span class="muted">${escapeHtml(copy.steps.translationSettingsMeta)}</span>
              </div>
              <span class="caret">▼</span>
            </button>
            <div class="translation-settings-content" id="translationSettingsContent">
              <div class="row">
                <div>
                  <label for="singleBatchModeSelect">${escapeHtml(copy.steps.batchingLabel)}</label>
                  <select id="singleBatchModeSelect">
                    <option value="multi">${escapeHtml(copy.steps.batchingMultiple)}</option>
                    <option value="single">${escapeHtml(copy.steps.batchingSingle)}</option>
                  </select>
                </div>
                <div>
                  <label for="timestampsMode">${escapeHtml(copy.steps.timestampsLabel)}</label>
                  <select id="timestampsMode">
                    <option value="original">${escapeHtml(copy.steps.timestampsRebuild)}</option>
                    <option value="send">${escapeHtml(copy.steps.sendTimestamps)}</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="section section-joined">
      <h2><span class="section-number">3-4</span> ${escapeHtml(copy.sections.runAndReview)}</h2>
      <div class="joined-grid">
        <div class="step-card locked" id="autoStep3Card" data-locked-label="${escapeHtml(copy.locks.needContinue)}">
          <div class="step-title"><span class="step-chip">${escapeHtml(copy.steps.three)}</span><span>${escapeHtml(copy.steps.runPipelineTitle)}</span></div>
          <div class="step-body">
            <p style="margin:0 0 8px; color: var(--text-secondary);">${escapeHtml(copy.steps.pipelineDesc)}</p>
            <div class="controls">
              <button class="btn" id="startAutoSubs">${escapeHtml(copy.steps.start)}</button>
              <button class="btn secondary" id="previewSteps">${escapeHtml(copy.steps.previewPlan)}</button>
            </div>
            <div class="progress" aria-label="${escapeHtml(copy.steps.progressAria)}">
              <div class="progress-fill" id="progressFill"></div>
            </div>
            <div class="status" id="statusText">${escapeHtml(copy.steps.awaiting)}</div>
            <div class="chips" style="margin-top:10px;">
              <span class="pill check" id="stepFetch">- ${escapeHtml(copy.steps.pills.fetch)}</span>
              <span class="pill" id="stepTranscribe">- ${escapeHtml(copy.steps.pills.transcribe)}</span>
              <span class="pill" id="stepAlign">- ${escapeHtml(copy.steps.pills.align)}</span>
              <span class="pill" id="stepTranslate">- ${escapeHtml(copy.steps.pills.translate)}</span>
              <span class="pill" id="stepDeliver">- ${escapeHtml(copy.steps.pills.deliver)}</span>
            </div>
            <div class="log-block">
              <div class="log-header" aria-hidden="true">
                <span class="pulse"></span>
                <div class="log-header-text">
                  <span class="label">${escapeHtml(copy.log.header)}</span>
                  <span class="muted">${escapeHtml(copy.log.sub)}</span>
                </div>
              </div>
              <div id="logArea" class="log" aria-live="polite"></div>
            </div>
          </div>
        </div>
        <div class="step-card locked" id="autoStep4Card" data-locked-label="${escapeHtml(copy.locks.needContinue)}">
          <div class="step-title"><span class="step-chip">${escapeHtml(copy.steps.four)}</span><span>${escapeHtml(copy.steps.outputTitle)}</span></div>
          <div class="step-body">
            <div class="row">
              <div>
                <label>${escapeHtml(copy.steps.generated)}</label>
                <div style="padding:12px; border:1px solid var(--border); border-radius:12px; background: var(--surface-light); min-height:120px;" id="srtPreview">
                  ${escapeHtml(copy.steps.noOutput)}
                </div>
                <div class="controls" style="margin-top:8px;">
                  <button class="btn secondary" disabled id="downloadSrt">${escapeHtml(copy.steps.downloadSrt)}</button>
                  <button class="btn secondary" disabled id="downloadVtt">${escapeHtml(copy.steps.downloadVtt)}</button>
                </div>
              </div>
              <div>
                <label>${escapeHtml(copy.steps.downloads)}</label>
                <div id="translationDownloads" style="display:grid; gap:10px;"></div>
                <p style="margin-top:8px; color: var(--text-secondary);">${escapeHtml(copy.steps.enableAfter)}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script src="/js/subtitle-menu.js?v=${escapeHtml(appVersion || 'dev')}"></script>
  <script src="/js/combobox.js"></script>
  <script>
    ${quickNavScript()}
    const BOOTSTRAP = ${safeJsonSerialize({
    configStr,
    videoId,
    filename: filename || '',
    streamUrl: initialStreamUrl,
    videoHash,
    linkedTitle,
    defaults,
    providerOptions,
    targetLanguages,
    sourceLanguages: config.sourceLanguages || []
  })};
    const PAGE = { configStr: BOOTSTRAP.configStr, videoId: BOOTSTRAP.videoId, filename: BOOTSTRAP.filename || '', videoHash: BOOTSTRAP.videoHash || '' };
    const SUBTITLE_MENU_TARGETS = ${JSON.stringify(subtitleMenuTargets)};
    const SUBTITLE_MENU_SOURCES = ${JSON.stringify(config.sourceLanguages || [])};
    const SUBTITLE_MENU_TARGET_CODES = ${JSON.stringify(config.targetLanguages || [])};
    const SUBTITLE_LANGUAGE_MAPS = ${safeJsonSerialize(languageMaps)};
    let subtitleMenuInstance = null;
    let pendingStreamUpdate = null;
    const tt = (key, vars = {}, fallback = '') => window.t ? window.t(key, vars, fallback || key) : (fallback || key);
    const TOAST_TITLE_FALLBACK = ${JSON.stringify(t('toolbox.toast.title', {}, 'New stream detected'))};
    const REFRESH_LABEL_FALLBACKS = {
      loading: ${JSON.stringify(t('toolbox.refresh.loading', {}, 'Refreshing...'))},
      empty: ${JSON.stringify(t('toolbox.refresh.empty', {}, 'No stream yet'))},
      error: ${JSON.stringify(t('toolbox.refresh.error', {}, 'Refresh failed'))},
      current: ${JSON.stringify(t('toolbox.refresh.current', {}, 'Already latest'))}
    };

    const copy = ${safeJsonSerialize(copy)};
    (${autoSubsRuntime.toString()})(copy);

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
          targetOptions: SUBTITLE_MENU_TARGETS,
          sourceLanguages: SUBTITLE_MENU_SOURCES,
          targetLanguages: SUBTITLE_MENU_TARGET_CODES,
          languageMaps: SUBTITLE_LANGUAGE_MAPS,
          getVideoHash: () => PAGE.videoHash || '',
          version: '${appVersion}'
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
      // Require explicit user action; keep update pending
      pendingStreamUpdate = {
        videoId: nextVideoId || PAGE.videoId,
        filename: nextFilename || PAGE.filename,
        videoHash: nextHash || PAGE.videoHash
      };
    }

    subtitleMenuInstance = mountSubtitleMenu();
    if (subtitleMenuInstance && typeof subtitleMenuInstance.prefetch === 'function') {
      subtitleMenuInstance.prefetch();
    }
    function forwardMenuNotification(info) {
      if (!subtitleMenuInstance || typeof subtitleMenuInstance.notify !== 'function') return false;
      const message = (info && info.message) ? info.message : tt('toolbox.toast.title', {}, TOAST_TITLE_FALLBACK);
      const title = (info && info.title) ? info.title + ': ' : '';
      subtitleMenuInstance.notify(title + message, 'muted', { persist: true });
      return false; // keep in-page toast visible
    }
    initStreamWatcher({
      configStr: PAGE.configStr,
      current: { videoId: PAGE.videoId, filename: PAGE.filename, videoHash: PAGE.videoHash },
      buildUrl: (payload) => {
        return '/auto-subtitles?config=' + encodeURIComponent(PAGE.configStr) +
          '&videoId=' + encodeURIComponent(payload.videoId || '') +
          '&filename=' + encodeURIComponent(payload.filename || '');
      },
      onEpisode: handleStreamUpdate,
      notify: forwardMenuNotification
    });
    initStreamRefreshButton({
      buttonId: 'quickNavRefresh',
      configStr: PAGE.configStr,
      current: { videoId: PAGE.videoId, filename: PAGE.filename, videoHash: PAGE.videoHash },
      labels: {
        loading: tt('toolbox.refresh.loading', {}, REFRESH_LABEL_FALLBACKS.loading),
        empty: tt('toolbox.refresh.empty', {}, REFRESH_LABEL_FALLBACKS.empty),
        error: tt('toolbox.refresh.error', {}, REFRESH_LABEL_FALLBACKS.error),
        current: tt('toolbox.refresh.current', {}, REFRESH_LABEL_FALLBACKS.current)
      },
      buildUrl: (payload) => {
        return '/auto-subtitles?config=' + encodeURIComponent(PAGE.configStr) +
          '&videoId=' + encodeURIComponent(payload.videoId || '') +
          '&filename=' + encodeURIComponent(payload.filename || '');
      }
    });
  </script>
</body>
</html>
`;
}

module.exports = {
  generateSubToolboxPage,
  generateEmbeddedSubtitlePage,
  generateAutoSubtitlePage
};
