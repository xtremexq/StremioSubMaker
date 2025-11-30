const axios = require('axios');
const { getLanguageName, languageMap } = require('./languages');
const { deriveVideoHash } = require('./videoHash');
const { parseStremioId } = require('./subtitle');
const { version: appVersion } = require('../../package.json');
const { quickNavStyles, quickNavScript, renderQuickNav, renderRefreshBadge } = require('./quickNav');

function escapeHtml(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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

function buildQuery(params) {
  const defined = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null);
  return defined.length === 0 ? '' : `?${defined.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}`;
}

function themeToggleMarkup() {
  return `
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
  if (!parsed || !parsed.imdbId) return null;
  const metaType = parsed.type === 'episode' ? 'series' : 'movie';
  const url = `https://v3-cinemeta.strem.io/meta/${metaType}/${encodeURIComponent(parsed.imdbId)}.json`;
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
      width: 48px;
      height: 48px;
      background: rgba(255, 255, 255, 0.9);
      border: 2px solid var(--border);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 9999;
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

function getLanguageSummary(config) {
  try {
    const sources = (config.sourceLanguages || []).map(getLanguageName).filter(Boolean);
    const targets = (config.targetLanguages || []).map(getLanguageName).filter(Boolean);
    return {
      sources: sources.length ? sources.join(', ') : 'Not set yet',
      targets: targets.length ? targets.join(', ') : 'Not set yet'
    };
  } catch (_) {
    return { sources: 'Not set yet', targets: 'Not set yet' };
  }
}

function getProviderSummary(config) {
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
    return names.length ? names.join(', ') : 'Not set yet';
  } catch (_) {
    return 'Not set yet';
  }
}

function generateSubToolboxPage(configStr, videoId, filename, config) {
  const links = buildToolLinks(configStr, videoId, filename);
  const languageSummary = getLanguageSummary(config || {});
  const providerSummary = getProviderSummary(config || {});
  const streamHint = filename ? escapeHtml(filename) : 'Stream filename not detected (still works)';
  const videoHash = deriveVideoHash(filename, videoId);
  const devMode = (config || {}).devMode === true;
  const devDisabledClass = devMode ? '' : ' dev-disabled';
  const languageMaps = buildLanguageLookupMaps();
  const subtitleMenuTargets = (config?.targetLanguages || []).map(code => ({
    code,
    name: getLanguageName(code) || code
  }));

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sub Toolbox - SubMaker</title>
  <link rel="icon" type="image/svg+xml" href="/favicon-toolbox.svg">
  <link rel="shortcut icon" href="/favicon-toolbox.svg">
  <link rel="apple-touch-icon" href="/favicon-toolbox.svg">
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
      .theme-toggle {
        top: 1rem;
        right: 1rem;
        width: 42px;
        height: 42px;
      }
    }
  </style>
  <script src="/js/theme-toggle.js" defer></script>
</head>
<body>
  <!-- Theme Toggle Button -->
  ${themeToggleMarkup()}

  <div id="episodeToast" class="episode-toast" role="status" aria-live="polite">
    <div class="icon">!</div>
    <div class="content">
      <p class="title" id="episodeToastTitle">New stream detected</p>
      <p class="meta" id="episodeToastMeta">A different episode is playing in Stremio.</p>
    </div>
    <button class="close" id="episodeToastDismiss" type="button" aria-label="Dismiss notification">×</button>
    <button class="action" id="episodeToastUpdate" type="button">Update</button>
  </div>

  <div class="page">
    <header class="masthead">
      <div class="brand">
        <img class="brand-logo" src="/logo.png" alt="SubMaker logo">
        <div>
          <h1>SubMaker Toolbox</h1>
          <div class="subtitle">Linked to ${escapeHtml(videoId)}</div>
        </div>
      </div>
      <div class="status-badges">
        <button class="refresh-badge" id="refreshStreamBtn" type="button" title="Jump to your latest stream">
          <span class="refresh-icon">⟳</span>
          <span class="refresh-label">Refresh stream</span>
        </button>
        <div class="status-badge accent">
          <span class="status-dot ok pulse"></span>
          <div class="labels">
            <span class="status-label">Session</span>
            <span class="status-value">Ready</span>
          </div>
        </div>
        <div class="status-badge">
          <span class="status-dot ok"></span>
          <div class="labels">
            <span class="status-label">Addon</span>
            <span class="status-value">v${escapeHtml(appVersion || 'n/a')}</span>
          </div>
        </div>
        <div class="status-badge" id="ext-badge">
          <span class="status-dot warn pulse" id="ext-dot"></span>
          <div class="labels">
            <span class="status-label">Extension</span>
            <span class="status-value" id="ext-value">Checking...</span>
          </div>
        </div>
        <div class="status-badge">
          <span class="status-dot ok"></span>
          <div class="labels">
            <span class="status-label">Local time</span>
            <span class="status-value" id="time-value">--:--</span>
          </div>
        </div>
      </div>
    </header>

    <section class="hero card">
      <div class="hero-content">
        <div class="eyebrow">Sub Toolbox</div>
        <h2>Pick a tool without leaving your stream</h2>
        <p>Use the Sub Toolbox button in Stremio's subtitle list. Your saved API keys, target languages, and cache come with you automatically.</p>
        <div class="chip-row">
          <div class="chip">Sources <span>${escapeHtml(languageSummary.sources)}</span></div>
          <div class="chip">Targets <span>${escapeHtml(languageSummary.targets)}</span></div>
          <div class="chip">Providers <span>${escapeHtml(providerSummary)}</span></div>
          <div class="chip">Stream <span>${streamHint}</span></div>
        </div>
        <div class="cta-row">
          <a class="button primary" href="${links.translateFiles}">Translate a file</a>
          <a class="button ghost" href="${links.configure}">Adjust configs</a>
        </div>
      </div>

      <div class="tool-stack">
        <header>
          <div class="eyebrow">Tool shelf</div>
        </header>
        <div class="tool-tiles">
          <a class="tool-tile" href="${links.translateFiles}">
            <div class="tool-icon">⚡</div>
            <div>
              <div class="tool-title">Translate SRT files</div>
              <p>Upload .srt/.vtt/.ass files and keep cache + language preferences intact.</p>
              <span class="tool-link">Translate a file</span>
            </div>
          </a>
          <a class="tool-tile${devDisabledClass}" href="${devMode ? links.embeddedSubs : '#'}">
            <div class="tool-icon">🧲</div>
            <div>
              <div class="tool-title">Extract + Translate</div>
              <p>Pull subtitles from the current stream or file, then translate with your provider.</p>
              <span class="tool-link">Open extractor</span>
            </div>
          </a>
          <a class="tool-tile${devDisabledClass}" href="${devMode ? links.syncSubtitles : '#'}">
            <div class="tool-icon">⏱️</div>
            <div>
              <div class="tool-title">Sync subtitles</div>
              <p>Fix timing drifts with offsets or the Chrome extension and save back to your session.</p>
              <span class="tool-link">Open sync studio</span>
            </div>
          </a>
          <a class="tool-tile${devDisabledClass}" href="${devMode ? links.automaticSubs : '#'}">
            <div class="tool-icon">🤖</div>
            <div>
              <div class="tool-title">Automatic subtitles</div>
              <p>Create subs when none exist. Uses your target language and provider settings.</p>
              <span class="tool-link">Generate subs</span>
            </div>
          </a>
        </div>
      </div>
    </section>

    <div class="footnote">
      Toolbox is tied to your current session and stream. Keep this tab open while streaming for the smoothest handoff.
    </div>

  </div>
  <script>
    const TOOLBOX = ${safeJsonSerialize({
    configStr,
    videoId,
    filename: filename || '',
    videoHash
  })};

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
      labels: { loading: 'Refreshing...', empty: 'No stream yet', error: 'Refresh failed', current: 'Already latest' },
      buildUrl: (payload) => {
        return '/sub-toolbox?config=' + encodeURIComponent(TOOLBOX.configStr) +
          '&videoId=' + encodeURIComponent(payload.videoId || '') +
          '&filename=' + encodeURIComponent(payload.filename || '');
      }
    });

    (function initHeaderBadges() {
      const timeEl = document.getElementById('time-value');
      const extValue = document.getElementById('ext-value');
      const extDot = document.getElementById('ext-dot');
      let extReady = false;
      let pingTimer = null;
      let pingAttempts = 0;
      const MAX_PINGS = 6;
      function updateTime() {
        const now = new Date();
        timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      function setExtensionStatus(ready, text, tone) {
        extReady = !!ready;
        const toneClass = ready ? 'ok' : (tone || 'bad');
        extDot.className = 'status-dot ' + toneClass;
        extValue.textContent = text;
      }
      function pingExtension() {
        setExtensionStatus(false, 'Pinging extension...', 'warn');
        if (pingTimer) clearInterval(pingTimer);
        pingAttempts = 0;
        const sendPing = () => {
          if (extReady) return;
          pingAttempts += 1;
          window.postMessage({ type: 'SUBMAKER_PING', source: 'webpage' }, '*');
          if (pingAttempts >= MAX_PINGS && !extReady) {
            clearInterval(pingTimer);
            setExtensionStatus(false, 'Not detected', 'bad');
          }
        };
        sendPing();
        pingTimer = setInterval(sendPing, 1200);
      }
      window.addEventListener('message', event => {
        const msg = event.data;
        if (!msg || msg.type !== 'SUBMAKER_PONG') return;
        if (msg.source && msg.source !== 'extension') return;
        const version = msg.version ? 'v' + msg.version : 'Detected';
        setExtensionStatus(true, version);
        if (pingTimer) clearInterval(pingTimer);
      });
      updateTime();
      setInterval(updateTime, 60000);
      setTimeout(pingExtension, 150);
      setInterval(() => {
        if (extReady) return;
        pingExtension();
      }, 10000);
    })();

    // Theme switching functionality
    // theme-toggle.js already wires the button + persists preference; avoid double-binding here

    // Listen for stream changes pushed from the addon so users can update without re-opening
    (function initStreamWatcher() {
      const toast = document.getElementById('episodeToast');
      const titleEl = document.getElementById('episodeToastTitle');
      const metaEl = document.getElementById('episodeToastMeta');
      const updateBtn = document.getElementById('episodeToastUpdate');
      const dismissBtn = document.getElementById('episodeToastDismiss');
      if (!toast || !updateBtn || !TOOLBOX || !TOOLBOX.configStr) return;

      const current = {
        videoId: TOOLBOX.videoId || '',
        filename: TOOLBOX.filename || '',
        videoHash: TOOLBOX.videoHash || ''
      };
      let latest = null;
      let es = null;
      let pollTimer = null;
      let sseRetryTimer = null;
      let sseRetryCount = 0;
      let currentSig = '';
      let lastSig = '';
      let hasBaseline = false;
      let lastSeenTs = 0;
      const MAX_SSE_RETRIES = 5;
      let lastMetaRequestKey = '';

      function parseVideoId(raw) {
        const id = (raw || '').toString().trim();
        if (!id) return null;
        const parts = id.split(':');
        if (parts.length >= 3) {
          const imdbId = parts[0].startsWith('tt') ? parts[0] : null;
          return { type: 'episode', imdbId, season: Number(parts[1]), episode: Number(parts[2]), id };
        }
        if (/^tt\\d+$/.test(id)) return { type: 'movie', imdbId: id, id };
        return { type: 'movie', id };
      }

      function formatEpisodeTag(parsed) {
        if (!parsed || parsed.type !== 'episode') return '';
        const s = Number.isFinite(parsed.season) ? 'S' + String(parsed.season).padStart(2, '0') : '';
        const e = Number.isFinite(parsed.episode) ? 'E' + String(parsed.episode).padStart(2, '0') : '';
        return (s || e) ? (s + e) : '';
      }

      function cleanName(raw) {
        if (!raw) return '';
        const last = raw.split(/[/\\\\]/).pop() || raw;
        return last.replace(/\\.[^.]+$/, '').replace(/[_\\.]+/g, ' ').replace(/\\s+/g, ' ').trim();
      }

      function buildSignature(payload) {
        if (!payload) return '';
        const parts = [
          payload.videoHash || '',
          payload.videoId || '',
          payload.filename || ''
        ];
        return parts.join('::');
      }

      currentSig = buildSignature(current);
      lastSig = currentSig;

      function describe(payload) {
        const parsed = parseVideoId(payload.videoId);
        const tag = formatEpisodeTag(parsed);
        const base = cleanName(payload.filename) || parsed?.imdbId || payload.videoId;
        if (tag) {
          return base ? (base + ' ' + tag) : tag;
        }
        return base || 'New stream detected';
      }

      async function enhanceMeta(payload) {
        if (!metaEl || !payload || !payload.videoId) return;
        const parsed = parseVideoId(payload.videoId);
        if (!parsed?.imdbId) return;
        const metaType = parsed.type === 'episode' ? 'series' : 'movie';
        const tag = formatEpisodeTag(parsed);
        const requestKey = (parsed.imdbId || '') + ':' + metaType + ':' + (tag || '');
        lastMetaRequestKey = requestKey;
        try {
          const resp = await fetch('https://v3-cinemeta.strem.io/meta/' + metaType + '/' + encodeURIComponent(parsed.imdbId) + '.json', { cache: 'force-cache' });
          if (!resp.ok) return;
          const data = await resp.json();
          const meta = data && data.meta;
          const name = meta?.name || meta?.english_name || (meta?.nameTranslated && meta.nameTranslated.en);
          if (!name || lastMetaRequestKey !== requestKey) return;
          const label = tag ? (name ? name + ' ' + tag : tag) : name;
          metaEl.textContent = label;
        } catch (_) { /* ignore */ }
      }

      function showToast(payload) {
        titleEl.textContent = 'New stream detected';
        metaEl.textContent = describe(payload);
        enhanceMeta(payload);
        toast.classList.add('show');
      }

      function handleEpisode(payload) {
        if (!payload || !payload.videoId) return;
        const payloadSig = buildSignature(payload) || String(payload.updatedAt || '');
        if (!payloadSig) return;
        const ts = Number(payload.updatedAt || 0);

        if (!hasBaseline) {
          hasBaseline = true;
          lastSeenTs = ts || Date.now();
          lastSig = payloadSig;
          if (payloadSig === currentSig) return;
          latest = payload;
          showToast(payload);
          return;
        }

        if (payloadSig === currentSig || payloadSig === lastSig) {
          lastSeenTs = Math.max(lastSeenTs, ts || Date.now());
          return;
        }

        lastSeenTs = ts || Date.now();
        lastSig = payloadSig;
        latest = payload;
        showToast(payload);
      }

      updateBtn.addEventListener('click', () => {
        if (!latest || !latest.videoId) return;
        const url = '/sub-toolbox?config=' + encodeURIComponent(TOOLBOX.configStr) +
          '&videoId=' + encodeURIComponent(latest.videoId) +
          '&filename=' + encodeURIComponent(latest.filename || '');
        window.location.href = url;
      });
      if (dismissBtn) {
        dismissBtn.addEventListener('click', () => {
          toast.classList.remove('show');
          latest = null;
        });
      }

      async function pollOnce() {
        try {
          const resp = await fetch('/api/stream-activity?config=' + encodeURIComponent(TOOLBOX.configStr), {
            cache: 'no-store'
          });
          if (!resp.ok || resp.status === 204) return;
          const data = await resp.json();
          handleEpisode(data);
        } catch (_) {
          // ignore
        } finally {
          pollTimer = setTimeout(pollOnce, 5000);
        }
      }

      function startSse() {
        try {
          if (sseRetryTimer) clearTimeout(sseRetryTimer);
          es = new EventSource('/api/stream-activity?config=' + encodeURIComponent(TOOLBOX.configStr));

          es.addEventListener('episode', (ev) => {
            try {
              sseRetryCount = 0; // Reset on successful message
              const data = JSON.parse(ev.data);
              handleEpisode(data);
            } catch (_) {}
          });

          es.addEventListener('open', () => {
            sseRetryCount = 0; // Connection successful
            if (pollTimer) {
              clearTimeout(pollTimer);
              pollTimer = null;
            }
          });

          es.addEventListener('error', () => {
            try { es.close(); } catch (_) {}
            es = null;

            // Retry SSE with exponential backoff
            if (sseRetryCount < MAX_SSE_RETRIES) {
              const delay = Math.min(1000 * Math.pow(2, sseRetryCount), 30000);
              sseRetryCount++;
              sseRetryTimer = setTimeout(startSse, delay);
            } else {
              // Max retries reached, fall back to polling
              pollOnce();
            }
          });
        } catch (_) {
          pollOnce();
        }
      }

      window.addEventListener('beforeunload', () => {
        try { es?.close(); } catch (_) {}
        if (pollTimer) clearTimeout(pollTimer);
        if (sseRetryTimer) clearTimeout(sseRetryTimer);
      });

      startSse();
    })();
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
  const initialVideoTitle = escapeHtml(linkedTitle || cleanDisplayName(filename) || cleanDisplayName(videoId) || 'No stream linked');
  const metaDetails = [];
  if (linkedTitle) metaDetails.push(`Title: ${linkedTitle}`);
  else if (videoId) metaDetails.push(`Video ID: ${videoId}`);
  if (episodeTag) metaDetails.push(`Episode: ${episodeTag}`);
  if (filename) metaDetails.push(`File: ${cleanDisplayName(filename)}`);
  const initialVideoSubtitle = escapeHtml(metaDetails.join(' - ') || 'Video ID unavailable');
  const config = arguments[3] || {};
  const targetLanguages = (Array.isArray(config.targetLanguages) ? config.targetLanguages : [])
    .map(code => ({ code, name: getLanguageName(code) || code }));
  const sourceLanguages = Array.isArray(config.sourceLanguages) ? config.sourceLanguages : [];
  const targetLanguageCodes = Array.isArray(config.targetLanguages) ? config.targetLanguages : [];
  const languageMaps = buildLanguageLookupMaps();
  const devMode = config.devMode === true;
  const providerOptions = (() => {
    const options = [];
    const providers = config.providers || {};
    const seen = new Set();
    const add = (key, label, model) => {
      const norm = String(key || '').toLowerCase();
      if (!norm || seen.has(norm)) return;
      seen.add(norm);
      options.push({ key: norm, label, model: model || '' });
    };
    add('gemini', `Gemini${config.geminiModel ? ` (${config.geminiModel})` : ''}`, config.geminiModel);
    if (config.multiProviderEnabled && config.mainProvider) {
      const main = String(config.mainProvider);
      const norm = main.toLowerCase();
      const model = providers[norm]?.model || '';
      add(norm, `Main: ${main}${model ? ` (${model})` : ''}`, model);
    }
    if (config.secondaryProviderEnabled && config.secondaryProvider) {
      const secondary = String(config.secondaryProvider);
      const norm = secondary.toLowerCase();
      const model = providers[norm]?.model || '';
      add(norm, `Secondary: ${secondary}${model ? ` (${model})` : ''}`, model);
    }
    Object.keys(providers || {}).forEach(key => {
      const model = providers[key]?.model || '';
      add(key, `Provider: ${key}${model ? ` (${model})` : ''}`, model);
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
      translationPrompt: config.translationPrompt || '',
      providerModel: config.geminiModel || ''
    },
    links,
    linkedTitle
  };

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Translate Embedded Subtitles - SubMaker</title>
  <link rel="icon" type="image/svg+xml" href="/favicon-toolbox.svg">
  <link rel="shortcut icon" href="/favicon-toolbox.svg">
  <link rel="apple-touch-icon" href="/favicon-toolbox.svg">
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
    .step-header h3, .step-header p { align-self: center; }
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
    #step1Card .video-meta,
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
    .model-status {
      margin-top: 4px;
      font-size: 13px;
      padding: 8px;
      border-radius: 10px;
      min-height: 20px;
    }
    .model-status.fetching {
      color: var(--primary);
      background: rgba(8, 164, 213, 0.08);
    }
    .model-status.success {
      color: #10b981;
      background: rgba(16, 185, 129, 0.12);
    }
    .model-status.error {
      color: var(--danger);
      background: rgba(239, 68, 68, 0.12);
    }
    .spinner-small {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid rgba(8, 164, 213, 0.2);
      border-top-color: var(--primary);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      vertical-align: middle;
      margin-right: 6px;
    }
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
    select.compact-select { width: min(240px, 100%); }
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
  ${themeToggleMarkup()}
  <button class="help-button mario" id="embeddedHelp" title="Show instructions">?</button>
  <div class="modal-overlay" id="embeddedInstructionsModal" role="dialog" aria-modal="true" aria-labelledby="embeddedInstructionsTitle">
    <div class="modal">
      <div class="modal-header">
        <h2 id="embeddedInstructionsTitle">Embedded Subtitles Instructions</h2>
        <div class="modal-close" id="closeEmbeddedInstructions" role="button" aria-label="Close instructions">&times;</div>
      </div>
      <div class="modal-content">
        <h3>Subtitles Extraction:</h3>
        <ol>
          <li>Make sure the xSync extension is installed and detected.</li>
          <li>Make sure the <strong>linked stream</strong> is the movie/episode you want to extract/translate.</li>
          <li>Right-click Stremio's stream and click "Copy stream link".</li>
          <li>Paste the stream URL in the corresponding box.</li>
          <li>Keep the mode at "Smart" (if subtitles look partial, switch to Complete)</li>
          <li>Click "Extract Subtitles"</li>
        </ol>

        <h3>Translating Extracted Subtitles:</h3>
        <ol>
          <li>Verify and select the desired subtitles.</li>
          <li>Select target language.</li>
          <li>Select translation settings and translation provider.</li>
          <li>Click "Translate Subtitles".</li>
        </ol>

        <p>You can download both extracted or translated subtitles as SRT.</p>
        <p>Translated subtitles are automatically uploaded to the database, matching the video hash, under the "xEmbed (Language)" entry (reload the stream on Stremio to see it).</p>
        <p>If translation/sync problems happen, simply retranslate the subtitle to overwrite the xEmbed database cache.</p>
        <p>Extracted subtitles are discarded.</p>
        <p class="muted">Currently doesn't work with image-based subtitles - OCR may be implemented.</p>
      </div>
      <div class="modal-footer">
        <label class="modal-checkbox">
          <input type="checkbox" id="dontShowEmbeddedInstructions">
          Don't show this again
        </label>
        <button type="button" class="btn" id="gotItEmbeddedInstructions">Got it</button>
      </div>
    </div>
  </div>
  <div id="episodeToast" class="episode-toast" role="status" aria-live="polite">
    <div class="icon">!</div>
    <div class="content">
      <p class="title" id="episodeToastTitle">New stream detected</p>
      <p class="meta" id="episodeToastMeta">A different episode is playing in Stremio.</p>
    </div>
    <button class="close" id="episodeToastDismiss" type="button" aria-label="Dismiss notification">×</button>
    <button class="action" id="episodeToastUpdate" type="button">Update</button>
  </div>
  ${renderQuickNav(links, 'embeddedSubs', false, devMode)}
  <div class="page">
    <header class="masthead">
      <div class="page-hero">
        <div class="page-icon">🧲</div>
        <h1 class="page-heading">Embedded Subtitle Studio</h1>
        <p class="page-subtitle">Extract embedded tracks from your current stream and translate them instantly.</p>
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
        <div class="status-badge" id="ext-status">
          <span class="status-dot warn" id="ext-dot"></span>
          <div class="status-labels">
            <span class="label-eyebrow">Extension</span>
            <strong id="ext-label">Waiting for extension...</strong>
          </div>
        </div>
        <div class="status-badge">
          <span class="status-dot ok"></span>
          <div class="status-labels">
            <span class="label-eyebrow">Hash</span>
            <strong>${escapeHtml(videoHash || 'pending')}</strong>
          </div>
        </div>
      </div>
    </header>

    <section class="section-grid">
      <div class="card section centered-section" id="step1Card">
        <div class="section-head">
          <div class="step-header">
            <span class="step-chip">Step 1</span>
            <h3>Extension & Extraction</h3>
            <p class="muted" style="margin:4px 0 0;">Ensure xSync is detected, paste a stream URL, and pull embedded subtitle tracks.</p>
          </div>
        </div>
        <div class="step-stack">
          <div class="video-meta">
            <p class="video-meta-label">Linked stream</p>
            <p class="video-meta-title" id="video-meta-title">${initialVideoTitle}</p>
            <p class="video-meta-subtitle" id="video-meta-subtitle">${initialVideoSubtitle}</p>
          </div>
          <div class="field-block">
            <label for="stream-url">Stream URL</label>
            <input type="text" id="stream-url" placeholder="Paste the video/stream URL from Stremio or your browser">
          </div>
          <div class="notice warn" style="margin-top:8px;">
            <strong>MKV caution:</strong> embedded subs can be scattered across the file. Extraction may need large fetches (hundreds of MB) and take longer; very large files or slow clients might struggle.
          </div>
          <div class="mode-controls">
            <label for="extract-mode">Mode</label>
            <select id="extract-mode" class="compact-select">
              <option value="smart">Smart (multi-strategy)</option>
              <option value="complete">Complete (full file)</option>
            </select>
            <p class="mode-helper">Smart keeps using the staged extraction flow. Complete downloads the full stream and demuxes everything for maximum coverage.</p>
            <button id="extract-btn" type="button" class="secondary">Extract Subtitles</button>
          </div>
          <div class="log-header" aria-hidden="true">
            <span class="pulse"></span>
            <span class="label">Live log</span>
            <span>Auto-filled while extraction runs.</span>
          </div>
          <div class="log" id="extract-log" aria-live="polite"></div>

          <div class="result-box">
            <div class="result-head">
              <div>
                <div class="eyebrow">Outputs</div>
                <h4>Extracted files</h4>
              </div>
            </div>
            <div id="extracted-downloads" class="downloads"></div>
            <div class="result-empty" id="extracted-empty">No tracks extracted yet. Run extraction above to see them here.</div>
          </div>
        </div>
      </div>

      <div class="card section centered-section is-disabled" id="step2Card">
        <div class="section-head">
          <div class="step-header">
            <span class="step-chip">Step 2</span>
            <h3>Tracks & Translation</h3>
            <p class="muted" style="margin:4px 0 0;">Select a track in Step 1 outputs, then choose a target language and translate.</p>
          </div>
        </div>

        <div class="selected-track-box">
          <p class="selected-track-label">Selected subtitle</p>
          <p id="selected-track-summary" class="selected-track-placeholder">Select a subtitle in Step 1 outputs to unlock this step.</p>
        </div>

        <div class="select-stack target-select-stack">
          <label for="target-select">Target language</label>
          <select id="target-select" class="target-select"></select>
        </div>

        <details class="translation-settings">
          <summary>
            <div>
              <span>Translation Settings</span>
              <span class="summary-meta">Provider, model, batching, timestamps</span>
            </div>
            <span class="chevron" aria-hidden="true"></span>
          </summary>
          <div class="translation-settings-body">
            <div class="provider-model-row">
              <div class="select-stack">
                <label for="provider-select">Provider</label>
                <select id="provider-select" style="max-width:240px;"></select>
              </div>
              <div class="select-stack model-stack">
                <label for="model-select">Model</label>
                <select id="model-select" style="max-width:260px;">
                  <option value="">Use Configured Model</option>
                </select>
              </div>
            </div>

            <div class="flex" style="flex-direction:column; gap:12px; align-items:center; width:100%;">
              <div style="display:flex; flex-direction:column; gap:6px; align-items:center; width:100%; max-width:300px;">
                <label for="single-batch-select" style="font-weight:600; margin:0;">Batching</label>
                <select id="single-batch-select" class="compact-select" style="width:100%;">
                  <option value="multi">Multiple Batches</option>
                  <option value="single">Single-Batch</option>
                </select>
              </div>
              <div style="display:flex; flex-direction:column; gap:6px; align-items:center; width:100%; max-width:300px;">
                <label for="timestamps-select" style="font-weight:600; margin:0;">Timestamps</label>
                <select id="timestamps-select" class="compact-select" style="width:100%;">
                  <option value="original">Original Timestamps</option>
                  <option value="send">Send Timestamps to AI</option>
                </select>
              </div>
            </div>
          </div>
        </details>

        <div class="flex" style="margin-top:10px;">
          <button id="translate-btn" type="button">Translate Subtitles</button>
        </div>

        <div class="log-header" aria-hidden="true">
          <span class="pulse"></span>
          <span class="label">Live log</span>
          <span>Auto-filled while translations run.</span>
        </div>
        <div class="log" id="translate-log" style="margin-top:8px;" aria-live="polite"></div>

        <div class="result-box">
          <div class="result-head">
            <div>
              <div class="eyebrow">Outputs</div>
              <h4>Translated subtitles</h4>
            </div>
          </div>
          <div id="translated-downloads" class="downloads"></div>
          <div class="result-empty" id="translated-empty">No translations yet. Pick a track and translate to see them here.</div>
          <div class="notice" id="reload-hint" style="display:none;">Done! Reload the stream subtitle list in Stremio to see xEmbed (Language) entries.</div>
        </div>
      </div>
    </section>
  </div>

  <script src="/js/subtitle-menu.js"></script>
  <script src="/js/combobox.js"></script>
  <script>
    ${quickNavScript()}
    if (window.ComboBox && typeof window.ComboBox.enhanceAll === 'function') {
      window.ComboBox.enhanceAll(document);
    }
    const BOOTSTRAP = ${safeJsonSerialize(bootstrap)};
    const PAGE = { configStr: BOOTSTRAP.configStr, videoId: BOOTSTRAP.videoId, filename: BOOTSTRAP.filename || '', videoHash: BOOTSTRAP.videoHash || '' };
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
      selectedTrackId: null,
      selectedTargetLang: baseTargetOptions[0]?.code || null,
      extractMode: 'smart',
      targets: {},
      downloads: [],
      activeTranslations: 0,
      queue: [],
      step2Enabled: false,
      lastProgressStatus: null,  // Track last logged progress message to prevent spam
      extractMessageId: null,
      targetOptions: baseTargetOptions
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
    const EXTRACT_MODE_KEY = 'submaker_embedded_extract_mode';
    let subtitleMenuInstance = null;

    function requestExtensionReset(reason) {
      try {
        window.postMessage({
          type: 'SUBMAKER_EMBEDDED_RESET',
          source: 'webpage',
          reason: reason || ''
        }, '*');
      } catch (_) {}
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

    function closeInstructions() {
      if (instructionsEls.overlay) {
        instructionsEls.overlay.classList.remove('show');
        instructionsEls.overlay.style.display = 'none';
      }
      setInstructionLock(false);
      // Mark as visited so it doesn't auto-show on subsequent visits
      try { localStorage.setItem(INSTRUCTIONS_KEY, 'true'); } catch (_) {}
    }

    function loadExtractMode() {
      try {
        const stored = localStorage.getItem(EXTRACT_MODE_KEY);
        if (stored === 'smart' || stored === 'complete') return stored;
      } catch (_) {}
      return 'smart';
    }

    function persistExtractMode(mode) {
      if (mode !== 'smart' && mode !== 'complete') return;
      try { localStorage.setItem(EXTRACT_MODE_KEY, mode); } catch (_) {}
    }

    function initInstructions() {
      const hasVisited = (() => {
        try { return localStorage.getItem(INSTRUCTIONS_KEY) === 'true'; } catch (_) { return false; }
      })();

      // Always show the help button
      if (instructionsEls.help) {
        instructionsEls.help.addEventListener('click', () => openInstructions(false));
        instructionsEls.help.style.display = 'flex';
      }
      if (instructionsEls.close) instructionsEls.close.addEventListener('click', closeInstructions);
      if (instructionsEls.gotIt) instructionsEls.gotIt.addEventListener('click', closeInstructions);
      if (instructionsEls.overlay) {
        instructionsEls.overlay.addEventListener('click', (ev) => {
          if (ev.target === instructionsEls.overlay) closeInstructions();
        });
      }
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && instructionsEls.overlay && instructionsEls.overlay.classList.contains('show')) {
          closeInstructions();
        }
      });

      // Only auto-show on first visit
      if (!hasVisited) {
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

    function handleStreamUpdateFromNotification(payload) {
      const nextSig = getStreamSignature(payload || {});
      const currentSig = getStreamSignature();
      if (!nextSig || nextSig === currentSig) return;

      PAGE.videoId = normalizeStreamValue(payload.videoId) || PAGE.videoId;
      PAGE.filename = normalizeStreamValue(payload.filename) || PAGE.filename;
      PAGE.videoHash = normalizeStreamValue(payload.videoHash) || PAGE.videoHash;

      setTargetOptions(baseTargetOptions, true);
      updateVideoMeta(PAGE);
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

    initInstructions();
    subtitleMenuInstance = initSubtitleMenuBridge();
    function forwardMenuNotification(info) {
      if (!subtitleMenuInstance || typeof subtitleMenuInstance.notify !== 'function') return false;
      const message = (info && info.message) ? info.message : 'New stream detected';
      const title = (info && info.title) ? info.title + ': ' : '';
      subtitleMenuInstance.notify(title + message, 'muted', { persist: true });
      return true;
    }
    window.addEventListener('beforeunload', () => {
      requestExtensionReset('page-unload');
    });

    initStreamRefreshButton({
      buttonId: 'quickNavRefresh',
      configStr: PAGE.configStr,
      current: { videoId: PAGE.videoId, filename: PAGE.filename, videoHash: PAGE.videoHash },
      labels: { loading: 'Refreshing...', empty: 'No stream yet', error: 'Refresh failed', current: 'Already latest' },
      buildUrl: (payload) => {
        return '/embedded-subtitles?config=' + encodeURIComponent(PAGE.configStr) +
          '&videoId=' + encodeURIComponent(payload.videoId || '') +
          '&filename=' + encodeURIComponent(payload.filename || '');
      }
    });

    function getVideoHash() {
      if (BOOTSTRAP.videoHash && BOOTSTRAP.videoHash.length) return BOOTSTRAP.videoHash;
      const base = (BOOTSTRAP.filename || BOOTSTRAP.videoId || 'unknown').toString();
      let hash = 0;
      for (let i = 0; i < base.length; i++) {
        hash = (hash * 31 + base.charCodeAt(i)) >>> 0;
      }
      BOOTSTRAP.videoHash = Math.abs(hash).toString(16).padStart(8, '0');
      return BOOTSTRAP.videoHash;
    }

    const els = {
      extStatus: document.getElementById('ext-status'),
      extDot: document.getElementById('ext-dot'),
      extLabel: document.getElementById('ext-label'),
      extractLog: document.getElementById('extract-log'),
      translateLog: document.getElementById('translate-log'),
      streamUrl: document.getElementById('stream-url'),
      extractBtn: document.getElementById('extract-btn'),
      targetSelect: document.getElementById('target-select'),
      translateBtn: document.getElementById('translate-btn'),
      providerSelect: document.getElementById('provider-select'),
      modelSelect: document.getElementById('model-select'),
      modelStatus: document.getElementById('model-status'),
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
      modeSelect: document.getElementById('extract-mode')
    };
    const buttonLabels = {
      extract: els.extractBtn?.textContent || 'Extract Subtitles',
      translate: els.translateBtn?.textContent || 'Translate Subtitles'
    };

    if (els.extractLog) els.extractLog.innerHTML = '';
    if (els.translateLog) els.translateLog.innerHTML = '';

    state.extractMode = loadExtractMode();
    if (els.modeSelect) {
      if (state.extractMode !== 'smart' && state.extractMode !== 'complete') {
        state.extractMode = 'smart';
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
      if (!parsed || !parsed.imdbId) return null;
      const key = parsed.imdbId + ':' + (parsed.type === 'episode' ? 'series' : 'movie');
      if (BOOTSTRAP.videoId === videoId && BOOTSTRAP.linkedTitle) {
        linkedTitleCache.set(key, BOOTSTRAP.linkedTitle);
        return BOOTSTRAP.linkedTitle;
      }
      if (linkedTitleCache.has(key)) return linkedTitleCache.get(key);
      const metaUrl = 'https://v3-cinemeta.strem.io/meta/' + (parsed.type === 'episode' ? 'series' : 'movie') + '/' + encodeURIComponent(parsed.imdbId) + '.json';
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

    async function updateVideoMeta(payload) {
      if (!els.videoMetaTitle || !els.videoMetaSubtitle) return;
      const source = payload || BOOTSTRAP;
      const title = source.title || cleanVideoName(source.filename) || cleanVideoName(source.videoId) || 'No stream linked';
      const episodeTag = formatEpisodeTag(source.videoId);
      const fallbackDetails = [];
      if (source.title) {
        fallbackDetails.push('Title: ' + source.title);
      } else if (source.videoId) {
        fallbackDetails.push('Video ID: ' + source.videoId);
      }
      if (episodeTag) fallbackDetails.push('Episode: ' + episodeTag);
      if (source.filename) fallbackDetails.push('File: ' + source.filename);
      els.videoMetaTitle.textContent = title;
      els.videoMetaSubtitle.textContent = fallbackDetails.join(' - ') || 'Waiting for a linked stream...';

      const requestId = ++linkedTitleRequestId;
      const fetchedTitle = source.title || await fetchLinkedTitle(source.videoId);
      if (requestId !== linkedTitleRequestId) return;

      const details = [];
      if (fetchedTitle) {
        details.push('Title: ' + fetchedTitle);
      } else if (source.videoId) {
        details.push('Video ID: ' + source.videoId);
      }
      if (episodeTag) details.push('Episode: ' + episodeTag);
      if (source.filename) details.push('File: ' + source.filename);

      els.videoMetaTitle.textContent = fetchedTitle || title;
      els.videoMetaSubtitle.textContent = details.join(' - ') || 'Waiting for a linked stream...';
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

    function setExtractionInFlight(active) {
      state.extractionInFlight = !!active;
      if (els.extractBtn) {
        els.extractBtn.disabled = !!active;
        els.extractBtn.textContent = active ? 'Extracting...' : buttonLabels.extract;
      }
      if (els.modeSelect) {
        els.modeSelect.disabled = !!active;
      }
    }

    function applyTranslateDisabled() {
      if (!els.translateBtn) return;
      const disabled = !state.step2Enabled || state.translationInFlight;
      els.translateBtn.disabled = disabled;
    }

    function setTranslationInFlight(active) {
      state.translationInFlight = !!active;
      if (els.translateBtn) {
        els.translateBtn.textContent = active ? 'Translating...' : buttonLabels.translate;
      }
      applyTranslateDisabled();
    }

    function refreshTranslationInFlight() {
      const busy = state.activeTranslations > 0 || state.queue.length > 0;
      setTranslationInFlight(busy);
    }

    function setStep2Enabled(enabled) {
      state.step2Enabled = !!enabled;
      if (els.step2Card) {
        els.step2Card.classList.toggle('is-disabled', !state.step2Enabled);
        els.step2Card.setAttribute('aria-disabled', state.step2Enabled ? 'false' : 'true');
      }
      applyTranslateDisabled();
    }

    function updateExtensionStatus(ready, text) {
      state.extensionReady = ready;
      els.extDot.className = 'status-dot ' + (ready ? 'ok' : 'bad');
      els.extLabel.textContent = ready ? (text || 'Ready') : (text || 'Extension not detected');
    }

    const modelCache = new Map();
    const fetchedModels = new Set();
    const providerModelSelection = new Map();

    const normalizeProviderKey = (key) => String(key || '').trim().toLowerCase();

    function getConfiguredModel(providerKey) {
      const normalized = normalizeProviderKey(providerKey);
      const match = (BOOTSTRAP.providerOptions || []).find(opt => normalizeProviderKey(opt.key) === normalized);
      if (match && match.model) return match.model;
      if (normalized === 'gemini') return BOOTSTRAP.defaults.providerModel || '';
      return '';
    }

    function setModelStatus(message, statusClass = '', useHtml = false) {
      if (!els.modelStatus) return;
      els.modelStatus.className = 'model-status' + (statusClass ? ' ' + statusClass : '');
      if (useHtml) els.modelStatus.innerHTML = message || '';
      else els.modelStatus.textContent = message || '';
    }

    function populateModelDropdown(providerKey, models = []) {
      if (!els.modelSelect) return;
      const normalized = normalizeProviderKey(providerKey || els.providerSelect?.value);
      const configuredModel = getConfiguredModel(normalized);
      const placeholder = configuredModel
        ? 'Use Configured Model (' + configuredModel + ')'
        : 'Use Configured Model (from your config)';

      const desiredOptions = [
        { value: '', text: placeholder },
        ...models.map(model => ({
          value: model.name || model.id,
          text: model.displayName || model.name || model.id
        }))
      ];

      const current = Array.from(els.modelSelect.options).map(o => ({
        value: o.value,
        text: o.textContent
      }));
      const needsRebuild = desiredOptions.length !== current.length ||
        desiredOptions.some((opt, idx) => {
          const existing = current[idx];
          return !existing || existing.value !== opt.value || existing.text !== opt.text;
        });

      if (needsRebuild) {
        els.modelSelect.innerHTML = '';
        desiredOptions.forEach(({ value, text }) => {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = text;
          els.modelSelect.appendChild(opt);
        });
      }

      const savedValue = providerModelSelection.get(normalized) || '';
      if (savedValue) {
        const exists = Array.from(els.modelSelect.options).some(o => o.value === savedValue);
        if (exists) els.modelSelect.value = savedValue;
      } else {
        els.modelSelect.value = '';
      }
    }

    async function fetchModels(providerKey) {
      const normalized = normalizeProviderKey(providerKey || els.providerSelect?.value);
      if (!els.modelSelect) return;
      if (!BOOTSTRAP.configStr) {
        populateModelDropdown(normalized, []);
        setModelStatus('Model list requires a saved config', 'error');
        return;
      }

      if (normalized === 'googletranslate') {
        populateModelDropdown(normalized, []);
        setModelStatus('Model selection not available for Google Translate');
        fetchedModels.add(normalized);
        return;
      }

      setModelStatus('<div class="spinner-small"></div> Fetching models...', 'fetching', true);
      const endpoint = normalized === 'gemini' ? '/api/gemini-models' : '/api/models/' + normalized;
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ configStr: BOOTSTRAP.configStr })
        });
        if (!response.ok) {
          throw new Error((await response.text()) || 'Failed to fetch models');
        }
        const models = await response.json();
        modelCache.set(normalized, models);
        fetchedModels.add(normalized);
        populateModelDropdown(normalized, models);
        setModelStatus('Models loaded!', 'success');
        setTimeout(() => setModelStatus(''), 2500);
      } catch (err) {
        console.error('Failed to fetch models', err);
        populateModelDropdown(normalized, modelCache.get(normalized) || []);
        setModelStatus('Failed to fetch models', 'error');
      }
    }

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
      if (els.providerSelect) {
        const providerOpts = BOOTSTRAP.providerOptions || [{ key: 'gemini', label: 'Gemini', model: BOOTSTRAP.defaults.providerModel }];
        const desired = providerOpts.map(opt => {
          const key = normalizeProviderKey(opt.key || opt.value || opt);
          return { value: key, text: opt.label + (opt.model ? ' - ' + opt.model : '') };
        });
        const prevValue = els.providerSelect.value;
        syncSelectOptions(els.providerSelect, desired);

        const preferred = desired[0]?.value || 'gemini';
        const nextValue = (prevValue && desired.some(d => d.value === prevValue)) ? prevValue : preferred;
        els.providerSelect.value = nextValue;
        populateModelDropdown(nextValue, modelCache.get(nextValue) || []);
        if (!fetchedModels.has(nextValue)) {
          fetchModels(nextValue);
        }
      }
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
          text: lang.name + ' (' + lang.code + ')' + (status ? ' - ' + status : '')
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
        els.selectedTrackSummary.textContent = 'Select a subtitle in Step 1 outputs to unlock this step.';
        els.selectedTrackSummary.className = 'selected-track-placeholder';
        setStep2Enabled(false);
        return;
      }
      els.selectedTrackSummary.className = 'selected-track-value';
      const parts = [
        track.label || ('Track ' + track.id),
        track.language ? ('Lang: ' + track.language) : '',
        track.codec ? ('Codec: ' + track.codec) : ''
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
        link.textContent = item.type === 'original' ? 'Download original' : 'Download translated';
        card.appendChild(title);
        card.appendChild(link);
        container.appendChild(card);
      });
    }

    function formatBytes(bytes) {
      if (!bytes || isNaN(bytes)) return 'unknown size';
      if (bytes < 1024) return bytes + ' B';
      const units = ['KB', 'MB', 'GB'];
      let i = -1;
      do {
        bytes = bytes / 1024;
        i++;
      } while (bytes >= 1024 && i < units.length - 1);
      return bytes.toFixed(bytes >= 10 ? 0 : 1) + ' ' + units[i];
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
        title.textContent = track.label || ('Track ' + track.id);
        const meta = document.createElement('div');
        meta.className = 'track-meta';
        const pieces = [
          'Lang: ' + (track.language || 'und'),
          'Codec: ' + (track.codec || 'subtitle'),
          'Size: ' + formatBytes(track.byteLength || (track.contentBytes ? track.contentBytes.length : 0))
        ];
        meta.textContent = pieces.join(' - ');
        const actions = document.createElement('div');
        actions.className = 'track-actions';
        const download = document.createElement('a');
        download.className = 'button secondary';
        download.href = createBlobUrl(track);
        download.download = (getVideoHash() || 'video') + '_' + (track.language || 'und') + '_' + track.id + '_original.' + ext;
        download.textContent = 'Download';
        download.addEventListener('click', (ev) => ev.stopPropagation());
        const selectBtn = document.createElement('button');
        selectBtn.type = 'button';
        selectBtn.textContent = state.selectedTrackId === track.id ? 'Selected' : 'Use for Step 2';
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
          translated.push({
            label: 'Translated ' + lang + ' (track ' + trackRef + ')',
            url: '/addon/' + encodeURIComponent(BOOTSTRAP.configStr) + '/xembedded/' + encodeURIComponent(getVideoHash()) + '/' + encodeURIComponent(lang) + '/' + encodeURIComponent(trackRef),
            filename: (getVideoHash() || 'video') + '_' + lang + '_xembed.srt',
            type: 'translated'
          });
        }
      });

      renderDownloadCards(els.translatedDownloads, els.translatedEmpty, translated);
      if (els.reloadHint) {
        els.reloadHint.style.display = translated.length ? 'block' : 'none';
      }
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

    async function persistOriginals() {
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
          await fetch('/api/save-embedded-subtitle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              configStr: BOOTSTRAP.configStr,
              videoHash: getVideoHash(),
              trackId: track.id,
              languageCode: track.language || 'und',
              content: contentPayload,
              metadata: {
                label: track.label,
                codec: track.codec,
                extractedAt: Date.now(),
                source: 'extension',
                encoding,
                mime
              }
            })
          });
        } catch (e) {
          logExtract('Failed to save track ' + track.id + ' to cache: ' + e.message);
        }
      }
    }

    function scheduleTranslation(targetLang) {
      if (state.translationInFlight) return;
      const track = state.tracks.find(t => t.id === state.selectedTrackId);
      if (!track) {
        logTranslate('Select a subtitle in Step 1 outputs first.');
        return;
      }
      const status = state.targets[targetLang]?.status;
      if (status === 'running' || status === 'queued') {
        logTranslate('Translation already queued for ' + targetLang + '.');
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
      logTranslate((isRetranslate ? 'Retranslating ' : 'Translating ') + track.label + ' -> ' + targetLang + '...');
      if (track.binary || track.codec === 'copy') {
        state.targets[targetLang] = { status: 'failed', error: 'Binary subtitle cannot be translated' };
        logTranslate('Track is binary (image/bitmap); cannot translate.');
        state.activeTranslations--;
        renderTargets();
        renderDownloads();
        processQueue();
        refreshTranslationInFlight();
        return;
      }
      try {
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
              providerName: els.providerSelect?.value || '',
              providerModel: els.modelSelect?.value || ''
            },
            metadata: {
              label: track.label,
              codec: track.codec,
              extractedAt: track.extractedAt || Date.now()
            },
            forceRetranslate: isRetranslate
          })
        });
        const data = await resp.json();
        if (!resp.ok || data.error) throw new Error(data.error || 'Translation failed');
        translatedHistory.add(historyKey);
        state.targets[targetLang] = { status: 'done', cacheKey: data.cacheKey, trackId: track.id, retranslate: isRetranslate };
        logTranslate('Finished ' + targetLang + (data.cached ? ' (cached)' : ''));
        els.reloadHint.style.display = 'block';
        renderTargets();
      } catch (e) {
        state.targets[targetLang] = { status: 'failed', error: e.message };
        logTranslate('Failed ' + targetLang + ': ' + e.message);
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
      const isExtractEvent = msg.type === 'SUBMAKER_EXTRACT_PROGRESS' || msg.type === 'SUBMAKER_EXTRACT_RESPONSE';
      if (isExtractEvent) {
        if (!state.extractMessageId) return;
        if (msg.messageId !== state.extractMessageId) return;
      }
      if (msg.type === 'SUBMAKER_PONG') {
        pingRetries = 0; // Reset retry counter
        updateExtensionStatus(true, 'Ready (v' + (msg.version || '-') + ')');
      } else if (msg.type === 'SUBMAKER_EXTRACT_PROGRESS') {
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
          state.targets = {};
          state.queue = [];
          state.activeTranslations = 0;
          state.selectedTargetLang = getTargetOptions()[0]?.code || null;
          state.selectedTrackId = null;
          if (els.translateLog) els.translateLog.innerHTML = '';
          state.tracks = msg.tracks.map((t, idx) => ({
            id: t.id || idx,
            label: t.label || ('Track ' + (idx + 1)),
            language: t.language || 'und',
            codec: t.codec || t.format || 'subtitle',
            binary: !!(t.binary || t.codec === 'copy' || t.encoding === 'base64'),
            content: t.content || '',
            contentBase64: t.contentBase64 || '',
            contentBytes: t.contentBytes || null,
            byteLength: t.byteLength || (t.contentBytes ? t.contentBytes.length : (typeof t.content === 'string' ? t.content.length : 0)),
            mime: t.mime || (t.binary ? 'application/octet-stream' : 'text/plain'),
            extractedAt: Date.now()
          }));
          renderSelectedTrackSummary();
          renderTargets();
          renderDownloads();
          persistOriginals();
          setStep2Enabled(false);
          logExtract('Extracted ' + state.tracks.length + ' track(s).');
        } else {
          logExtract('Extraction failed: ' + (msg.error || 'unknown error'));
          setStep2Enabled(false);
        }
        requestExtensionReset('extract-finished');
      }
    });

    let pingRetries = 0;
    const MAX_PING_RETRIES = 5;

    function sendPing() {
      updateExtensionStatus(false, 'Pinging extension...');
      window.postMessage({ type: 'SUBMAKER_PING', source: 'webpage' }, '*');

      // Auto-retry if no response received
      if (pingRetries < MAX_PING_RETRIES) {
        pingRetries++;
        setTimeout(() => {
          if (!state.extensionReady) {
            sendPing();
          }
        }, 1000); // Retry every 1 second
      } else if (!state.extensionReady) {
        updateExtensionStatus(false, 'Extension not detected');
      }
    }

    function requestExtraction() {
      if (!state.extensionReady) {
        logExtract('Extension not detected yet. Install SubMaker xSync and wait for detection.');
        return;
      }
      if (state.extractionInFlight) return;
      const streamUrl = (els.streamUrl.value || '').trim();
      if (!streamUrl) {
        logExtract('Paste a stream URL first.');
        return;
      }
      if (!new RegExp('^https?://', 'i').test(streamUrl)) {
        logExtract('Invalid stream URL. Paste a full http/https link.');
        return;
      }
      const mode = state.extractMode === 'complete' ? 'complete' : 'smart';
      const messageId = 'extract_' + Date.now();
      setStep2Enabled(false);
      setExtractionInFlight(true);
      state.extractMessageId = messageId;
      state.lastProgressStatus = null; // Reset progress tracking for new extraction
      if (els.extractLog) els.extractLog.innerHTML = '';
      window.postMessage({
        type: 'SUBMAKER_EXTRACT_REQUEST',
        source: 'webpage',
        messageId,
        data: {
          streamUrl,
          mode,
          filename: BOOTSTRAP.filename || '',
          videoHash: getVideoHash()
        }
      }, '*');
      logExtract('Sent extract request (' + mode + ') to extension.');
    }

    // Event bindings
    els.extractBtn.onclick = requestExtraction;
    els.translateBtn.onclick = () => {
      if (state.translationInFlight) return;
      const targetLang = state.selectedTargetLang;
      if (!targetLang) {
        logTranslate('Select a target language.');
        return;
      }
      scheduleTranslation(targetLang);
    };
    if (els.targetSelect) {
      els.targetSelect.addEventListener('change', () => {
        state.selectedTargetLang = els.targetSelect.value || null;
      });
    }
    if (els.providerSelect) {
      els.providerSelect.addEventListener('change', () => {
        const key = normalizeProviderKey(els.providerSelect.value);
        populateModelDropdown(key, modelCache.get(key) || []);
        providerModelSelection.set(key, providerModelSelection.get(key) || '');
        if (!fetchedModels.has(key)) {
          fetchModels(key);
        } else {
          setModelStatus('');
        }
      });
    }
    if (els.modelSelect) {
      els.modelSelect.addEventListener('change', () => {
        const key = normalizeProviderKey(els.providerSelect?.value);
        providerModelSelection.set(key, els.modelSelect.value || '');
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
    setStep2Enabled(!!state.selectedTrackId);
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

function generateAutoSubtitlePage(configStr, videoId, filename, config = {}) {
  const links = buildToolLinks(configStr, videoId, filename);
  const devMode = config.devMode === true;
  const targetLanguages = Array.from(new Set([...(config.targetLanguages || []), ...(config.sourceLanguages || [])]));
  const targetOptions = targetLanguages.length
    ? targetLanguages.map(code => `<option value="${escapeHtml(code)}">${escapeHtml(getLanguageName(code) || code)}</option>`).join('')
    : `<option value="">Add target languages in Configure</option>`;
  const videoHash = deriveVideoHash(filename, videoId);
  const languageMaps = buildLanguageLookupMaps();
  const subtitleMenuTargets = targetLanguages.map(code => ({
    code,
    name: getLanguageName(code) || code
  }));

  const defaults = {
    whisperModel: 'medium',
    diarization: false,
    translateToTarget: true,
    streamFilename: filename || ''
  };

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Automatic Subtitles - SubMaker</title>
    <link rel="icon" type="image/svg+xml" href="/favicon-toolbox.svg">
    <link rel="shortcut icon" href="/favicon-toolbox.svg">
    <link rel="apple-touch-icon" href="/favicon-toolbox.svg">
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
    }
    .step-card:hover { border-color: var(--primary); box-shadow: 0 14px 30px var(--glow); transform: translateY(-2px); }
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

    @media (max-width: 900px) {
      .wrap { padding: 2rem 1.25rem; }
      .hero { grid-template-columns: 1fr; }
    }
  ${themeToggleStyles()}
  </style>
  <script src="/js/theme-toggle.js" defer></script>
</head>
<body>
  ${themeToggleMarkup()}
  <button class="mobile-menu-toggle" id="mobileMenuToggle" aria-label="Open menu">
    <span></span><span></span><span></span>
  </button>
  <div class="mobile-nav-overlay" id="mobileNavOverlay"></div>
  <div id="episodeToast" class="episode-toast" role="status" aria-live="polite">
    <div class="icon">!</div>
    <div class="content">
      <p class="title" id="episodeToastTitle">New stream detected</p>
      <p class="meta" id="episodeToastMeta">A different episode is playing in Stremio.</p>
    </div>
    <button class="close" id="episodeToastDismiss" type="button" aria-label="Dismiss notification">×</button>
    <button class="action" id="episodeToastUpdate" type="button">Update</button>
  </div>
  ${renderQuickNav(links, 'automaticSubs', false, devMode)}
  <div class="wrap">
    <header class="masthead">
      <div class="page-hero">
        <div class="page-icon">🤖</div>
        <h1 class="page-heading">Automatic Subtitles</h1>
        <p class="page-subtitle">Generate subtitles with Whisper then translate</p>
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
        <div class="status-badge" id="ext-status">
          <span class="status-dot warn pulse" id="ext-dot"></span>
          <div class="status-labels">
            <span class="label-eyebrow">Extension</span>
            <strong id="ext-label">Waiting for extension...</strong>
          </div>
        </div>
        <div class="status-badge">
          <span class="status-dot ok"></span>
          <div class="status-labels">
            <span class="label-eyebrow">Hash</span>
            <strong>${escapeHtml(videoHash || 'pending')}</strong>
          </div>
        </div>
      </div>
    </header>

    <div class="section section-joined">
      <h2><span class="section-number">1-2</span> Link a stream & prep the model</h2>
      <div class="joined-grid">
        <div class="step-card">
          <div class="step-title"><span class="step-chip">Step 1</span><span>Input audio or video</span></div>
          <label for="streamUrl">Stream / file URL</label>
          <input type="text" id="streamUrl" placeholder="https://example.com/video.mkv">
          <small style="color: var(--text-secondary); display:block; margin-top:6px;">We'll fetch and extract audio; protected/DRM streams won't work.</small>
          <div class="controls" style="margin-top:12px;">
            <button class="btn secondary" id="prefillFromVideo">Use provided stream id</button>
            <button class="btn ghost" id="clearInputs">Clear</button>
          </div>
        </div>
        <div class="step-card">
          <div class="step-title"><span class="step-chip">Step 2</span><span>Language + model</span></div>
          <div class="row">
            <div>
              <label for="detectedLang">Source language (optional)</label>
              <select id="detectedLang">
                <option value="">Auto-detect</option>
                ${targetOptions}
              </select>
            </div>
            <div>
              <label for="targetLang">Target language</label>
              <select id="targetLang">
                ${targetOptions}
              </select>
            </div>
            <div>
              <label for="whisperModel">Whisper model</label>
              <select id="whisperModel">
                <option value="tiny">tiny (fastest)</option>
                <option value="small">small</option>
                <option value="medium" selected>medium (balanced)</option>
                <option value="turbo">turbo (GPU)</option>
              </select>
            </div>
          </div>
          <div class="controls">
            <label style="display:flex; gap:8px; align-items:center; font-weight:600; color:var(--text-primary);">
              <input type="checkbox" id="enableDiarization"> Speaker diarization
            </label>
            <label style="display:flex; gap:8px; align-items:center; font-weight:600; color:var(--text-primary);">
              <input type="checkbox" id="translateOutput" checked> Translate to target languages
            </label>
          </div>
        </div>
      </div>
    </div>

    <div class="section section-joined">
      <h2><span class="section-number">3-4</span> Run pipeline & review output</h2>
      <div class="joined-grid">
        <div class="step-card">
          <div class="step-title"><span class="step-chip">Step 3</span><span>Run pipeline</span></div>
          <p style="margin:0 0 8px; color: var(--text-secondary);">We'll stitch: fetch -> segment -> transcribe -> align -> translate (optional) -> deliver SRT.</p>
          <div class="controls">
            <button class="btn" id="startAutoSubs">Start auto-subtitles</button>
            <button class="btn secondary" id="previewSteps">Preview plan</button>
          </div>
          <div class="progress" aria-label="Progress">
            <div class="progress-fill" id="progressFill"></div>
          </div>
          <div class="status" id="statusText">Awaiting input...</div>
          <div class="chips" style="margin-top:10px;">
            <span class="pill check" id="stepFetch">- Fetch stream</span>
            <span class="pill" id="stepTranscribe">- Transcribe</span>
            <span class="pill" id="stepAlign">- Align + timestamps</span>
            <span class="pill" id="stepTranslate">- Translate</span>
            <span class="pill" id="stepDeliver">- Ready to deliver</span>
          </div>
        </div>
        <div class="step-card">
          <div class="step-title"><span class="step-chip">Step 4</span><span>Output</span></div>
          <div class="row">
            <div>
              <label>Generated SRT</label>
              <div style="padding:12px; border:1px solid var(--border); border-radius:12px; background: var(--surface-light); min-height:120px;" id="srtPreview">
                No output yet.
              </div>
            </div>
            <div>
              <label>Downloads</label>
              <div class="controls">
                <button class="btn secondary" disabled id="downloadSrt">Download SRT</button>
                <button class="btn secondary" disabled id="downloadVtt">Download VTT</button>
              </div>
              <p style="margin-top:8px; color: var(--text-secondary);">We'll enable downloads after the pipeline finishes.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script src="/js/subtitle-menu.js"></script>
  <script src="/js/combobox.js"></script>
  <script>
    const BOOTSTRAP = ${safeJsonSerialize({
    configStr,
    videoId,
    filename: filename || '',
    videoHash,
    defaults
  })};
    const PAGE = { configStr: BOOTSTRAP.configStr, videoId: BOOTSTRAP.videoId, filename: BOOTSTRAP.filename || '', videoHash: BOOTSTRAP.videoHash || '' };
    const SUBTITLE_MENU_TARGETS = ${JSON.stringify(subtitleMenuTargets)};
    const SUBTITLE_MENU_SOURCES = ${JSON.stringify(config.sourceLanguages || [])};
    const SUBTITLE_MENU_TARGET_CODES = ${JSON.stringify(config.targetLanguages || [])};
    const SUBTITLE_LANGUAGE_MAPS = ${safeJsonSerialize(languageMaps)};
    let subtitleMenuInstance = null;

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
      current: { videoId: PAGE.videoId, filename: PAGE.filename, videoHash: PAGE.videoHash },
      labels: { loading: 'Refreshing...', empty: 'No stream yet', error: 'Refresh failed', current: 'Already latest' },
      buildUrl: (payload) => {
        return '/auto-subtitles?config=' + encodeURIComponent(PAGE.configStr) +
          '&videoId=' + encodeURIComponent(payload.videoId || '') +
          '&filename=' + encodeURIComponent(payload.filename || '');
      }
    });

    (function() {
      const startBtn = document.getElementById('startAutoSubs');
      const previewBtn = document.getElementById('previewSteps');
      const statusText = document.getElementById('statusText');
      const progressFill = document.getElementById('progressFill');
      const stepPills = {
        fetch: document.getElementById('stepFetch'),
        transcribe: document.getElementById('stepTranscribe'),
        align: document.getElementById('stepAlign'),
        translate: document.getElementById('stepTranslate'),
        deliver: document.getElementById('stepDeliver')
      };
      const streamUrl = document.getElementById('streamUrl');
      const targetLang = document.getElementById('targetLang');
      const whisperModel = document.getElementById('whisperModel');
      const translateOutput = document.getElementById('translateOutput');
      const srtPreview = document.getElementById('srtPreview');
      const downloadSrt = document.getElementById('downloadSrt');
      const downloadVtt = document.getElementById('downloadVtt');
      const prefillFromVideo = document.getElementById('prefillFromVideo');
      const clearInputs = document.getElementById('clearInputs');
      const extDot = document.getElementById('ext-dot');
      const extLabel = document.getElementById('ext-label');
      const extStatus = document.getElementById('ext-status');
      const startBtnLabel = startBtn ? startBtn.textContent : 'Start auto-subtitles';

      let extensionReady = false;
      let pingRetries = 0;
      const MAX_PING_RETRIES = 5;
      let autoSubsInFlight = false;

      function updateExtensionStatus(ready, text) {
        extensionReady = ready;
        if (extDot) extDot.className = 'status-dot ' + (ready ? 'ok' : 'bad');
        if (extLabel) extLabel.textContent = ready ? (text || 'Ready') : (text || 'Extension not detected');
        if (extStatus) extStatus.title = text || '';
      }

      function setAutoSubsInFlight(active) {
        autoSubsInFlight = !!active;
        if (startBtn) {
          startBtn.disabled = autoSubsInFlight;
          startBtn.textContent = autoSubsInFlight ? 'Running...' : startBtnLabel;
        }
      }

      window.addEventListener('message', (event) => {
        const msg = event.data || {};
        if (msg.source !== 'extension') return;
        if (msg.type === 'SUBMAKER_PONG') {
          pingRetries = 0;
          updateExtensionStatus(true, 'Ready (v' + (msg.version || '-') + ')');
        }
      });

      function sendPing() {
        updateExtensionStatus(false, 'Pinging extension...');
        window.postMessage({ type: 'SUBMAKER_PING', source: 'webpage' }, '*');

        if (pingRetries < MAX_PING_RETRIES) {
          pingRetries++;
          setTimeout(() => {
            if (!extensionReady) {
              sendPing();
            }
          }, 1000);
        } else if (!extensionReady) {
          updateExtensionStatus(false, 'Extension not detected');
        }
      }

      setTimeout(sendPing, 500);

      const pills = Object.values(stepPills);
      function resetPills() {
        pills.forEach(p => {
          p.classList.remove('check', 'warn', 'danger');
          p.textContent = p.textContent.replace(/^(OK|-)\s*/, '- ');
        });
        stepPills.fetch.classList.add('check');
      }

      function markStep(step, state = 'check') {
        const pill = stepPills[step];
        if (!pill) return;
        pill.classList.remove('check', 'warn', 'danger');
        pill.classList.add(state);
        const label = pill.textContent.replace(/^(OK|-)\s*/, '');
        pill.textContent = state === 'check' ? 'OK ' + label : '- ' + label;
      }

      function simulateRun() {
        setAutoSubsInFlight(true);
        resetPills();
        statusText.textContent = 'Fetching stream...';
        progressFill.style.width = '10%';

        const steps = [
          { key: 'transcribe', label: 'Transcribing with Whisper (' + whisperModel.value + ')' },
          { key: 'align', label: 'Aligning and cleaning timestamps' },
          { key: 'translate', label: translateOutput.checked ? 'Translating to ' + (targetLang.value || 'targets') : 'Skipping translation' },
          { key: 'deliver', label: 'Preparing downloads' }
        ];

        steps.forEach((step, index) => {
          setTimeout(() => {
            markStep(step.key, 'check');
            statusText.textContent = step.label;
            progressFill.style.width = ((index + 2) * 20) + '%';

            if (step.key === 'deliver') {
              srtPreview.textContent = '1\\n00:00:00,000 --> 00:00:02,000\\n[Sample subtitle generated by Whisper]\\n';
              downloadSrt.disabled = false;
              downloadVtt.disabled = false;
              statusText.textContent = 'Done. Ready to download.';
              progressFill.style.width = '100%';
              setAutoSubsInFlight(false);
            }
          }, 600 * (index + 1));
        });
      }

      startBtn?.addEventListener('click', () => {
        if (autoSubsInFlight) return;
        simulateRun();
      });
      previewBtn?.addEventListener('click', () => {
        statusText.textContent = 'Pipeline: fetch -> transcribe -> align -> translate -> deliver.';
      });

      prefillFromVideo?.addEventListener('click', () => {
        if (BOOTSTRAP.filename) {
          streamUrl.value = BOOTSTRAP.filename;
        } else if (BOOTSTRAP.videoId) {
          streamUrl.value = 'stremio://' + BOOTSTRAP.videoId;
        } else {
          streamUrl.value = '';
        }
      });

      clearInputs?.addEventListener('click', () => {
        streamUrl.value = '';
        resetPills();
        progressFill.style.width = '0%';
        statusText.textContent = 'Awaiting input...';
        srtPreview.textContent = 'No output yet.';
        downloadSrt.disabled = true;
        downloadVtt.disabled = true;
        setAutoSubsInFlight(false);
      });

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
