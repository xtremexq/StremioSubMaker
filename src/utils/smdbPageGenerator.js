/**
 * SubMaker Database (SMDB) Page Generator
 * Generates the full HTML page for the SMDB tool – link stream, browse/upload subtitles.
 */

const { getLanguageName, getAllLanguages, buildLanguageLookupMaps } = require('./languages');
const { deriveVideoHash } = require('./videoHash');
const { parseStremioId } = require('./subtitle');
const { buildClientBootstrap, loadLocale, getTranslator } = require('./i18n');
const { quickNavStyles, quickNavScript, renderQuickNav } = require('./quickNav');
const { version: appVersion } = require('../../package.json');

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cleanDisplayName(raw) {
  if (!raw) return '';
  try { return decodeURIComponent(raw); } catch (_) { }
  return raw;
}

function resolveUiLang(config) {
  return (config?.uiLanguage || 'en').replace(/[^a-zA-Z-]/g, '').slice(0, 10) || 'en';
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

function themeToggleStyles() {
  return `
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
    }

    [data-theme="dark"] .theme-toggle {
      background: rgba(20, 25, 49, 0.9);
      border-color: var(--border);
    }

    [data-theme="true-dark"] .theme-toggle {
      background: rgba(10, 10, 10, 0.92);
      border-color: var(--border);
      box-shadow: 0 8px 20px var(--shadow);
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

/**
 * Generate the SubMaker Database page
 * @param {string} configStr - Encoded config string
 * @param {string} videoId - Stremio video ID
 * @param {string} filename - Stream filename
 * @param {Object} config - Resolved user config
 */
async function generateSmdbPage(configStr, videoId, filename, config = {}) {
  const uiLang = resolveUiLang(config);
  const t = getTranslator(uiLang);
  const localeBootstrap = buildClientBootstrap(loadLocale(uiLang));
  const videoHash = deriveVideoHash(filename, videoId);
  const parsed = parseStremioId(videoId);
  const cleanFilename = cleanDisplayName(filename);
  const devMode = (config || {}).devMode === true;
  const languageMaps = buildLanguageLookupMaps();
  const subtitleMenuTargets = (config?.targetLanguages || []).map(code => ({
    code,
    name: getLanguageName(code) || code
  }));

  // Build nav links (matching the pattern from other page generators)
  const links = {
    translateFiles: `/file-upload?config=${encodeURIComponent(configStr || '')}&videoId=${encodeURIComponent(videoId || '')}`,
    syncSubtitles: `/subtitle-sync?config=${encodeURIComponent(configStr || '')}&videoId=${encodeURIComponent(videoId || '')}&filename=${encodeURIComponent(filename || '')}`,
    embeddedSubs: `/embedded-subtitles?config=${encodeURIComponent(configStr || '')}&videoId=${encodeURIComponent(videoId || '')}&filename=${encodeURIComponent(filename || '')}`,
    automaticSubs: `/auto-subtitles?config=${encodeURIComponent(configStr || '')}&videoId=${encodeURIComponent(videoId || '')}&filename=${encodeURIComponent(filename || '')}`,
    subToolbox: `/sub-toolbox?config=${encodeURIComponent(configStr || '')}&videoId=${encodeURIComponent(videoId || '')}&filename=${encodeURIComponent(filename || '')}`,
    smdb: `/smdb?config=${encodeURIComponent(configStr || '')}&videoId=${encodeURIComponent(videoId || '')}&filename=${encodeURIComponent(filename || '')}`,
    configure: `/configure?config=${encodeURIComponent(configStr || '')}`,
    history: `/sub-history?config=${encodeURIComponent(configStr || '')}&videoId=${encodeURIComponent(videoId || '')}&filename=${encodeURIComponent(filename || '')}`
  };

  // Build user language options from config
  const userLanguages = [];
  const seenLangs = new Set();
  const addLang = (code) => {
    if (!code || seenLangs.has(code)) return;
    seenLangs.add(code);
    const name = getLanguageName(code);
    if (name) userLanguages.push({ code, name });
  };
  (config.sourceLanguages || []).forEach(addLang);
  (config.targetLanguages || []).forEach(addLang);
  (config.noTranslationLanguages || []).forEach(addLang);
  userLanguages.sort((a, b) => a.name.localeCompare(b.name));

  // All languages for "all languages" mode
  const allLanguages = getAllLanguages();

  const episodeTag = parsed && parsed.season ? `S${String(parsed.season).padStart(2, '0')}E${String(parsed.episode).padStart(2, '0')}` : '';

  const themeToggleLabel = t('fileUpload.themeToggle', {}, 'Toggle theme');

  return `<!DOCTYPE html>
<html lang="${escapeHtml(uiLang)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${localeBootstrap}
  <title>SubMaker Database - SubMaker</title>
  <link rel="icon" type="image/svg+xml" href="/favicon-toolbox.svg?_cb=${escapeHtml(appVersion)}">
  <link rel="shortcut icon" href="/favicon-toolbox.svg?_cb=${escapeHtml(appVersion)}">
  <link rel="apple-touch-icon" href="/favicon-toolbox.svg?_cb=${escapeHtml(appVersion)}">
  <script>
    (function() {
      var html = document.documentElement;
      var theme = 'light';
      try {
        var saved = localStorage.getItem('theme');
        if (saved) theme = saved;
        else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) theme = 'dark';
      } catch (_) {}
      html.setAttribute('data-theme', theme);
    })();
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    html {
      scroll-behavior: smooth;
      color-scheme: light;
    }

    :root {
      --primary: #08A4D5;
      --primary-light: #33B9E1;
      --primary-dark: #068DB7;
      --primary-2: #33B9E1;
      --secondary: #33B9E1;
      --accent: #0ea5e9;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --bg-primary: #f7fafc;
      --surface: #ffffff;
      --surface-light: #f3f7fb;
      --surface-2: #f4f7fc;
      --bg: #f5f8fd;
      --bg-strong: #e9eef7;
      --text: #0f172a;
      --text-primary: #0f172a;
      --text-secondary: #475569;
      --muted: #475569;
      --border: #dbe3ea;
      --shadow: rgba(0, 0, 0, 0.08);
      --shadow-color: rgba(12, 19, 56, 0.12);
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
      --warning: #f59e0b;
      --danger: #ef4444;
      --bg-primary: #0A0E27;
      --surface: #141931;
      --surface-light: #1E2539;
      --surface-2: #1e2539;
      --bg: #0f172a;
      --bg-strong: #1a2438;
      --text: #E8EAED;
      --text-primary: #E8EAED;
      --text-secondary: #9AA0A6;
      --muted: #9AA0A6;
      --border: #2A3247;
      --shadow: rgba(0, 0, 0, 0.3);
      --shadow-color: rgba(0, 0, 0, 0.4);
      --glow: rgba(8, 164, 213, 0.35);
    }

    [data-theme="true-dark"] {
      color-scheme: dark;
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
      --surface-2: #151515;
      --bg: #000000;
      --bg-strong: #0a0a0a;
      --text: #E8EAED;
      --text-primary: #E8EAED;
      --text-secondary: #8A8A8A;
      --muted: #8A8A8A;
      --border: #1a1a1a;
      --shadow: rgba(0, 0, 0, 0.8);
      --shadow-color: rgba(0, 0, 0, 0.6);
      --glow: rgba(8, 164, 213, 0.45);
    }

    ${quickNavStyles()}

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: linear-gradient(135deg, var(--bg-primary) 0%, #ffffff 60%, var(--bg-primary) 100%);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.6;
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
      top: 0; left: 0; right: 0; bottom: 0;
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

    /* ── Page Container ──────────────────────── */
    .page {
      position: relative;
      z-index: 1;
      max-width: 720px;
      margin: 0 auto;
      padding: 32px 20px 60px;
    }

    /* ── Header ─────────────────────────── */
    .page-header {
      text-align: center;
      margin-bottom: 28px;
      margin-top: 16px;
    }
    .page-header h1 {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 1.75rem;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 4px;
    }
    .page-header p {
      color: var(--muted);
      font-size: 0.92rem;
    }

    /* ── Cards ──────────────────────────── */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 22px 24px;
      margin-bottom: 18px;
      box-shadow: 0 14px 40px var(--shadow-color);
    }
    .card-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 14px;
    }
    .card-icon {
      font-size: 1.3rem;
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--surface-2);
      border-radius: 10px;
      flex-shrink: 0;
    }
    .card-title {
      font-family: 'Space Grotesk', sans-serif;
      font-weight: 700;
      font-size: 1.05rem;
      color: var(--text-primary);
    }
    .card-subtitle {
      font-size: 0.82rem;
      color: var(--muted);
    }

    /* ── Link Stream Card ─────────────── */
    .stream-meta {
      background: var(--surface-2);
      border-radius: 10px;
      padding: 14px 16px;
      font-size: 0.88rem;
    }
    .stream-meta-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 6px;
    }
    .stream-meta-row:last-child { margin-bottom: 0; }
    .stream-meta-label {
      color: var(--muted);
      font-weight: 600;
      min-width: 54px;
      flex-shrink: 0;
      font-size: 0.82rem;
    }
    .stream-meta-value {
      color: var(--text);
      word-break: break-all;
    }
    .hash-badge {
      display: inline-block;
      font-family: 'SF Mono', 'Cascadia Code', monospace;
      font-size: 0.78rem;
      padding: 2px 8px;
      background: var(--bg-strong);
      border-radius: 6px;
      color: var(--primary);
      letter-spacing: 0.02em;
    }
    .hash-badge.derived { color: var(--warning); }
    .reset-link-wrap {
      text-align: center;
      margin-top: 10px;
    }
    .reset-link-btn {
      display: none;
      align-items: center;
      gap: 6px;
      padding: 7px 16px;
      border-radius: 8px;
      font-size: 0.82rem;
      font-weight: 600;
      background: var(--surface-2);
      color: var(--text-secondary);
      border: 1px solid var(--border);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .reset-link-btn:hover { border-color: var(--danger); color: var(--danger); }
    .reset-link-btn.visible { display: inline-flex; }
    .stream-waiting {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--muted);
      font-size: 0.88rem;
      padding: 14px 0;
    }
    .spinner {
      width: 18px; height: 18px;
      border: 2px solid var(--border);
      border-top-color: var(--primary);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Subtitle List ─────────────────── */
    .hidden { display: none !important; }
    .sub-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      justify-content: center;
    }
    .sub-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 18px 12px;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      min-width: 130px;
    }
    .sub-item:hover {
      border-color: var(--primary);
      transform: translateY(-2px);
      box-shadow: 0 6px 20px var(--shadow-color);
    }
    .sub-lang {
      font-weight: 700;
      font-size: 0.88rem;
      color: var(--text-primary);
      text-align: center;
      line-height: 1.3;
    }
    .sub-actions {
      display: flex;
      gap: 5px;
      width: 100%;
      justify-content: center;
    }
    .sub-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 3px;
      padding: 5px 10px;
      border: 1px solid var(--border);
      border-radius: 7px;
      background: var(--surface);
      color: var(--text-secondary);
      font-size: 0.72rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
      text-decoration: none;
      white-space: nowrap;
    }
    .sub-btn:hover { border-color: var(--primary); color: var(--primary); }
    .sub-btn.primary-btn {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
    }
    .sub-btn.primary-btn:hover { background: var(--primary-light); }
    .sub-empty {
      color: var(--muted);
      font-size: 0.88rem;
      text-align: center;
      padding: 18px 0;
    }

    /* ── Translate Dropdown ────────────── */
    .sub-translate-wrap {
      position: relative;
      display: inline-flex;
    }
    .translate-dropdown {
      display: none;
      position: absolute;
      top: calc(100% + 4px);
      left: 50%;
      transform: translateX(-50%);
      min-width: 180px;
      max-height: 240px;
      overflow-y: auto;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
      z-index: 100;
      padding: 4px 0;
    }
    .translate-dropdown.open { display: block; }
    .translate-dropdown-item {
      display: block;
      width: 100%;
      padding: 8px 14px;
      border: none;
      background: none;
      color: var(--text);
      font-size: 0.82rem;
      font-weight: 500;
      text-align: left;
      cursor: pointer;
      transition: background 0.12s;
    }
    .translate-dropdown-item:hover {
      background: var(--surface-2);
      color: var(--primary);
    }
    .translate-dropdown-item.disabled {
      opacity: 0.4;
      cursor: default;
      pointer-events: none;
    }
    .sub-item.translating {
      opacity: 0.7;
      pointer-events: none;
    }
    .sub-item.translating .sub-actions::after {
      content: '⏳';
      margin-left: 6px;
      animation: pulse 1.2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    /* ── Upload Section ────────────────── */
    .upload-section { margin-top: 8px; }
    .form-group { margin-bottom: 16px; }
    .form-label {
      display: block;
      font-weight: 600;
      font-size: 0.85rem;
      color: var(--text-secondary);
      margin-bottom: 6px;
    }
    .form-select {
      width: 100%;
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: 9px;
      background: var(--surface-2);
      color: var(--text);
      font-size: 0.88rem;
      font-family: inherit;
      transition: border-color 0.15s;
    }
    .form-select:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px var(--glow);
    }
    .all-langs-toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      font-size: 0.84rem;
      color: var(--text-secondary);
      cursor: pointer;
    }
    .all-langs-toggle input { accent-color: var(--primary); }

    /* ── File Drop Zone ────────────────── */
    .file-drop-zone {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 1.5rem 1.25rem;
      background: var(--surface-2);
      border: 2px dashed var(--border);
      border-radius: 12px;
      cursor: pointer;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      text-align: center;
      gap: 0.35rem;
    }
    .file-drop-zone:hover {
      background: var(--surface-light);
      border-color: var(--primary);
      transform: translateY(-1px);
    }
    .file-drop-zone.drag-over {
      border-color: var(--primary);
      background: rgba(8, 164, 213, 0.08);
      box-shadow: 0 0 0 3px var(--glow);
      transform: scale(1.01);
    }
    .file-drop-zone .drop-icon {
      font-size: 1.8rem;
      margin-bottom: 0.15rem;
    }
    .file-drop-zone .drop-main {
      font-weight: 600;
      font-size: 0.92rem;
      color: var(--primary);
    }
    .file-drop-zone .drop-sub {
      font-size: 0.82rem;
      color: var(--text-secondary);
    }
    .file-drop-zone input[type=file] {
      display: none;
    }
    .file-drop-name {
      margin-top: 0.5rem;
      padding: 0.5rem 0.75rem;
      background: rgba(8, 164, 213, 0.08);
      border-radius: 8px;
      font-size: 0.85rem;
      color: var(--text-primary);
      font-weight: 500;
      display: none;
      word-break: break-all;
    }
    .file-drop-name.active {
      display: block;
    }
    .upload-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 12px 28px;
      border: none;
      border-radius: 10px;
      background: var(--primary);
      color: #fff;
      font-size: 0.92rem;
      font-weight: 700;
      font-family: 'Space Grotesk', sans-serif;
      cursor: pointer;
      transition: all 0.2s;
      width: 100%;
      justify-content: center;
    }
    .upload-btn:hover:not(:disabled) { background: var(--primary-light); transform: translateY(-1px); }
    .upload-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    /* ── Status/Toast ──────────────────── */
    .status-bar {
      margin-top: 14px;
      padding: 10px 14px;
      border-radius: 9px;
      font-size: 0.85rem;
      font-weight: 500;
      display: none;
    }
    .status-bar.success { display: block; background: rgba(16, 185, 129, 0.12); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.25); }
    .status-bar.error { display: block; background: rgba(239, 68, 68, 0.12); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.25); }
    .status-bar.warning { display: block; background: rgba(245, 158, 11, 0.12); color: var(--warning); border: 1px solid rgba(245, 158, 11, 0.25); }
    .status-bar.info { display: block; background: rgba(8, 164, 213, 0.10); color: var(--primary); border: 1px solid rgba(8, 164, 213, 0.25); }

    /* ── Override Modal ────────────────── */
    .modal-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.45);
      display: flex; align-items: center; justify-content: center;
      z-index: 1000;
      opacity: 0; pointer-events: none;
      transition: opacity 0.2s;
    }
    .modal-overlay.active { opacity: 1; pointer-events: auto; }
    .modal {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 28px 30px;
      max-width: 420px;
      width: 90%;
      box-shadow: 0 14px 40px var(--shadow-color);
    }
    .modal h3 {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 1.1rem;
      margin-bottom: 10px;
    }
    .modal p { font-size: 0.88rem; color: var(--muted); margin-bottom: 18px; }
    .modal-actions {
      display: flex; gap: 10px; justify-content: flex-end;
    }
    .modal-btn {
      padding: 9px 20px;
      border-radius: 9px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--surface-2);
      color: var(--text);
      transition: all 0.15s;
    }
    .modal-btn:hover { border-color: var(--primary); }
    .modal-btn.confirm {
      background: var(--danger);
      color: #fff;
      border-color: var(--danger);
    }
    .modal-btn.confirm:hover { opacity: 0.85; }

    /* ── Responsive ─────────────────────── */
    @media (max-width: 520px) {
      .page { padding: 20px 14px 40px; }
      .card { padding: 18px 16px; }
      .sub-grid { grid-template-columns: 1fr; }
    }

    ${themeToggleStyles()}
  </style>
  <script src="/js/theme-toggle.js" defer></script>
</head>
<body>
  ${themeToggleMarkup(themeToggleLabel)}
  ${renderQuickNav(links, 'smdb', false, devMode, t)}

  <div class="page">
    <!-- Header -->
    <div class="page-header">
      <h1>📦 SubMaker Database</h1>
      <p>Upload and share subtitles with the community</p>
    </div>

    <!-- Link Stream Card -->
    <div class="card" id="link-card">
      <div class="card-header">
        <div class="card-icon">🔗</div>
        <div>
          <div class="card-title">Link Stream</div>
          <div class="card-subtitle">Stream something on Stremio and the stream will auto-link</div>
        </div>
      </div>
      <div id="stream-waiting" class="stream-waiting">
        <div class="spinner"></div>
        <span>Waiting for a linked stream...</span>
      </div>
      <div id="stream-info" class="stream-meta hidden">
        <div class="stream-meta-row">
          <span class="stream-meta-label">Video</span>
          <span class="stream-meta-value" id="meta-video">—</span>
        </div>
        <div class="stream-meta-row">
          <span class="stream-meta-label">File</span>
          <span class="stream-meta-value" id="meta-file">—</span>
        </div>
        <div class="stream-meta-row">
          <span class="stream-meta-label">Hash</span>
          <span class="stream-meta-value" id="meta-hash">—</span>
        </div>
      </div>
      <div class="reset-link-wrap">
        <button class="reset-link-btn" id="reset-link-btn" title="Reset and wait for a new stream">🔄 Reset Link</button>
      </div>
    </div>

    <!-- Content area (hidden until stream linked) -->
    <div id="content-area" class="hidden">

      <!-- Existing Subtitles -->
      <div class="card" id="existing-card">
        <div class="card-header">
          <div class="card-icon">📄</div>
          <div>
            <div class="card-title">Available Subtitles</div>
            <div class="card-subtitle">Community-uploaded subtitles for this stream</div>
          </div>
        </div>
        <div id="sub-list-loading" class="stream-waiting">
          <div class="spinner"></div>
          <span>Loading subtitles...</span>
        </div>
        <div id="sub-list" class="sub-grid hidden"></div>
        <div id="sub-empty" class="sub-empty hidden">No subtitles uploaded yet. Be the first!</div>
        <div class="status-bar" id="translate-status-bar"></div>
      </div>

      <!-- Upload Section -->
      <div class="card">
        <div class="card-header">
          <div class="card-icon">⬆️</div>
          <div>
            <div class="card-title">Upload Subtitle</div>
            <div class="card-subtitle">Share a subtitle with the community for this stream</div>
          </div>
        </div>
        <div class="upload-section">
          <div class="form-group">
            <label class="form-label" for="lang-select">Language</label>
            <select class="form-select" id="lang-select">
              <option value="">Select language...</option>
              ${userLanguages.map(l => `<option value="${escapeHtml(l.code)}">${escapeHtml(l.name)}</option>`).join('\n              ')}
            </select>
            <label class="all-langs-toggle">
              <input type="checkbox" id="all-langs-check"> Show all languages
            </label>
          </div>
          <div class="form-group">
            <label class="form-label">Subtitle file (.srt, .vtt)</label>
            <div class="file-drop-zone" id="file-drop-zone">
              <input type="file" id="file-input" accept=".srt,.vtt,.ass,.ssa,.sub,.txt">
              <div class="drop-icon">📁</div>
              <div class="drop-main">Click to browse or drag & drop</div>
              <div class="drop-sub">Supports .srt, .vtt, .ass, .ssa, .sub, .txt</div>
            </div>
            <div class="file-drop-name" id="file-drop-name"></div>
          </div>
          <button class="upload-btn" id="upload-btn" disabled>
            ⬆️ Upload Subtitle
          </button>
          <div class="status-bar" id="status-bar"></div>
        </div>
      </div>

    </div><!-- /content-area -->
  </div>

  <!-- Override Confirmation Modal -->
  <div class="modal-overlay" id="override-modal">
    <div class="modal">
      <h3>⚠️ Override Existing Subtitle?</h3>
      <p id="override-msg">A subtitle for this language already exists. Do you want to replace it?</p>
      <div class="modal-actions">
        <button class="modal-btn" id="override-cancel">Cancel</button>
        <button class="modal-btn confirm" id="override-confirm">Override</button>
      </div>
    </div>
  </div>

  <script>
    // ── Bootstrap data ──────────────────────────────────────────────────────
    const CONFIG_STR = ${JSON.stringify(configStr || '')};
    const VIDEO_ID = ${JSON.stringify(videoId || '')};
    const FILENAME = ${JSON.stringify(filename || '')};
    const DERIVED_HASH = ${JSON.stringify(videoHash || '')};
    const USER_LANGUAGES = ${JSON.stringify(userLanguages)};
    const ALL_LANGUAGES = ${JSON.stringify(allLanguages)};
    const TARGET_LANGUAGES = ${JSON.stringify(subtitleMenuTargets)};

    // ── State ───────────────────────────────────────────────────────────────
    let linkedStream = null; // { videoId, filename, videoHash, stremioHash }
    let activeHashes = [];   // Hashes to search SMDB with
    let currentSubs = [];    // Currently listed subtitles
    let streamLocked = false;     // Once a stream is linked, lock it until reset
    let PAGE_LOAD_TIME = Date.now(); // Used to ignore stale cached entries on refresh

    // ── All-languages toggle ────────────────────────────────────────────────
    const allLangsCheck = document.getElementById('all-langs-check');
    const langSelect = document.getElementById('lang-select');
    allLangsCheck.addEventListener('change', () => {
      const langs = allLangsCheck.checked ? ALL_LANGUAGES : USER_LANGUAGES;
      const current = langSelect.value;
      langSelect.innerHTML = '<option value="">Select language...</option>' +
        langs.map(l => '<option value="' + l.code + '"' + (l.code === current ? ' selected' : '') + '>' + l.name + '</option>').join('');
    });

    // ── Upload button enable/disable ────────────────────────────────────────
    const fileInput = document.getElementById('file-input');
    const uploadBtn = document.getElementById('upload-btn');
    const dropZone = document.getElementById('file-drop-zone');
    const fileDropName = document.getElementById('file-drop-name');

    function updateUploadBtn() {
      uploadBtn.disabled = !langSelect.value || !fileInput.files.length;
    }
    function showFileName() {
      if (fileInput.files.length) {
        fileDropName.textContent = '📎 ' + fileInput.files[0].name;
        fileDropName.classList.add('active');
      } else {
        fileDropName.textContent = '';
        fileDropName.classList.remove('active');
      }
    }
    langSelect.addEventListener('change', updateUploadBtn);
    fileInput.addEventListener('change', () => { showFileName(); updateUploadBtn(); });

    // ── File drop zone interactions ─────────────────────────────────────────
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      if (e.dataTransfer.files.length) {
        fileInput.files = e.dataTransfer.files;
        showFileName();
        updateUploadBtn();
      }
    });

    // ── Status bar ──────────────────────────────────────────────────────────
    function showStatus(text, type = 'info') {
      const bar = document.getElementById('status-bar');
      bar.textContent = text;
      bar.className = 'status-bar ' + type;
    }
    function clearStatus() {
      const bar = document.getElementById('status-bar');
      bar.className = 'status-bar';
      bar.textContent = '';
    }

    // ── Translate status bar (inside Available Subtitles card) ──────────────
    function showTranslateStatus(text, type) {
      const bar = document.getElementById('translate-status-bar');
      bar.textContent = text;
      bar.className = 'status-bar ' + type;
    }
    function clearTranslateStatus() {
      const bar = document.getElementById('translate-status-bar');
      bar.className = 'status-bar';
      bar.textContent = '';
    }

    // ── Stream Activity SSE ─────────────────────────────────────────────────
    function connectStreamActivity() {
      const url = '/api/stream-activity?config=' + encodeURIComponent(CONFIG_STR);
      const evtSource = new EventSource(url);
      evtSource.addEventListener('episode', (e) => {
        try {
          const data = JSON.parse(e.data);
          handleStreamLinked(data);
        } catch (_) {}
      });
      evtSource.addEventListener('error', () => {
        // Fallback: poll once
        setTimeout(() => {
          fetch(url).then(r => r.ok ? r.json() : null).then(data => {
            if (data) handleStreamLinked(data);
          }).catch(() => {});
        }, 2000);
      });
    }

    // ── Resolve hash associations from persistent mapping ─────────────────
    async function resolveAssociatedHashes(hashes) {
      const expanded = new Set(hashes);
      try {
        for (const hash of hashes) {
          const res = await fetch('/api/smdb/resolve-hashes?videoHash=' + encodeURIComponent(hash) + '&config=' + encodeURIComponent(CONFIG_STR));
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.hashes)) {
              for (const h of data.hashes) { if (h) expanded.add(h); }
            }
          }
        }
      } catch (_) {}
      return [...expanded];
    }

    async function handleStreamLinked(data) {
      if (!data || !data.videoId) return;
      // If stream is already locked, ignore further updates
      if (streamLocked) return;
      // Ignore stale cached entries from before this page load / reset
      if (data.updatedAt && data.updatedAt < PAGE_LOAD_TIME) return;
      linkedStream = data;
      streamLocked = true;

      // Build hash list for SMDB lookup (stremioHash first, then derivedHash)
      activeHashes = [];
      if (data.stremioHash) activeHashes.push(data.stremioHash);
      if (data.videoHash) activeHashes.push(data.videoHash);
      // Remove duplicates
      activeHashes = [...new Set(activeHashes)];

      // Expand with persistent hash mappings so we find subtitles stored under
      // either hash even if stream activity lost the stremioHash after restart
      activeHashes = await resolveAssociatedHashes(activeHashes);

      // Update UI
      document.getElementById('stream-waiting').classList.add('hidden');
      document.getElementById('stream-info').classList.remove('hidden');

      document.getElementById('meta-video').textContent = data.videoId || '—';
      document.getElementById('meta-file').textContent = data.filename ? decodeURIComponent(data.filename) : '—';

      const hashEl = document.getElementById('meta-hash');
      if (data.stremioHash) {
        hashEl.innerHTML = '<span class="hash-badge">' + escapeClientHtml(data.stremioHash.slice(0, 16)) + '…</span> <span style="font-size:0.78rem;color:var(--muted)">(OpenSubtitles)</span>';
      } else if (data.videoHash) {
        hashEl.innerHTML = '<span class="hash-badge derived">' + escapeClientHtml(data.videoHash.slice(0, 16)) + '…</span> <span style="font-size:0.78rem;color:var(--muted)">(derived)</span>';
      } else {
        hashEl.textContent = '—';
      }

      // Show content area and reset-link button
      document.getElementById('content-area').classList.remove('hidden');
      document.getElementById('reset-link-btn').classList.add('visible');

      // Load existing subtitles
      loadSubtitleList();
    }

    // ── Load subtitle list ──────────────────────────────────────────────────
    async function loadSubtitleList() {
      const listEl = document.getElementById('sub-list');
      const emptyEl = document.getElementById('sub-empty');
      const loadingEl = document.getElementById('sub-list-loading');
      listEl.classList.add('hidden');
      emptyEl.classList.add('hidden');
      loadingEl.classList.remove('hidden');

      try {
        // Fetch for each hash
        const allSubs = [];
        const seenLangs = new Set();
        for (const hash of activeHashes) {
          const res = await fetch('/api/smdb/list?videoHash=' + encodeURIComponent(hash) + '&config=' + encodeURIComponent(CONFIG_STR));
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.subtitles)) {
              for (const sub of data.subtitles) {
                if (!seenLangs.has(sub.languageCode)) {
                  seenLangs.add(sub.languageCode);
                  allSubs.push({ ...sub, videoHash: hash });
                }
              }
            }
          }
        }

        currentSubs = allSubs;
        loadingEl.classList.add('hidden');

        if (allSubs.length === 0) {
          emptyEl.classList.remove('hidden');
          return;
        }

        listEl.innerHTML = allSubs.map((sub, idx) => {
          const langName = sub.languageName || sub.languageCode;
          // Build language dropdown items (exclude the source language)
          const dropdownItems = TARGET_LANGUAGES
            .filter(tl => tl.code !== sub.languageCode)
            .map(tl => {
              const exists = allSubs.some(s => s.languageCode === tl.code);
              return '<button class="translate-dropdown-item" data-video-hash="' + escapeClientHtml(sub.videoHash) + '" data-source="' + escapeClientHtml(sub.languageCode) + '" data-target="' + escapeClientHtml(tl.code) + '" data-idx="' + idx + '">' +
                escapeClientHtml(tl.name) + (exists ? ' ⚠️' : '') +
              '</button>';
            }).join('');
          return '<div class="sub-item" id="sub-item-' + idx + '">' +
            '<span class="sub-lang">' + escapeClientHtml(langName) + '</span>' +
            '<div class="sub-actions">' +
              '<a class="sub-btn primary-btn" href="/api/smdb/download?videoHash=' + encodeURIComponent(sub.videoHash) + '&lang=' + encodeURIComponent(sub.languageCode) + '&config=' + encodeURIComponent(CONFIG_STR) + '" download="smdb_' + sub.languageCode + '.srt">⬇ Download</a>' +
              '<div class="sub-translate-wrap">' +
                '<button class="sub-btn translate-toggle-btn" data-dd-idx="' + idx + '">🌐 Translate</button>' +
                '<div class="translate-dropdown" id="translate-dd-' + idx + '">' + dropdownItems + '</div>' +
              '</div>' +
            '</div>' +
          '</div>';
        }).join('');

        // Attach click handlers to translate toggle buttons (no inline onclick – CSP safe)
        listEl.querySelectorAll('.translate-toggle-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleTranslateDropdown(parseInt(e.currentTarget.dataset.ddIdx));
          });
        });

        // Attach click handlers to dropdown items
        listEl.querySelectorAll('.translate-dropdown-item').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const el = e.currentTarget;
            translateSubtitle(el.dataset.videoHash, el.dataset.source, el.dataset.target, parseInt(el.dataset.idx));
          });
        });
        listEl.classList.remove('hidden');
      } catch (err) {
        loadingEl.classList.add('hidden');
        emptyEl.textContent = 'Failed to load subtitles.';
        emptyEl.classList.remove('hidden');
      }
    }

    function escapeClientHtml(str) {
      const d = document.createElement('div');
      d.textContent = str;
      return d.innerHTML;
    }

    // ── Translate dropdown & handler ─────────────────────────────────────────
    function toggleTranslateDropdown(idx) {
      // Close all other dropdowns first
      document.querySelectorAll('.translate-dropdown.open').forEach(dd => {
        if (dd.id !== 'translate-dd-' + idx) dd.classList.remove('open');
      });
      const dd = document.getElementById('translate-dd-' + idx);
      if (dd) dd.classList.toggle('open');
    }

    // Close dropdowns on click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.sub-translate-wrap')) {
        document.querySelectorAll('.translate-dropdown.open').forEach(dd => dd.classList.remove('open'));
      }
    });

    let pendingTranslateOverride = null; // { videoHash, sourceLang, targetLang, idx }

    async function translateSubtitle(videoHash, sourceLang, targetLang, idx, forceOverride) {
      // Close dropdown
      document.querySelectorAll('.translate-dropdown.open').forEach(dd => dd.classList.remove('open'));

      const subItem = document.getElementById('sub-item-' + idx);
      if (subItem) subItem.classList.add('translating');
      clearTranslateStatus();
      showTranslateStatus('🌐 Translating... This may take a minute.', 'info');

      try {
        const res = await fetch('/api/smdb/translate?config=' + encodeURIComponent(CONFIG_STR), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoHash: videoHash,
            sourceLangCode: sourceLang,
            targetLangCode: targetLang,
            forceOverride: forceOverride || false
          })
        });

        const data = await res.json();

        if (res.ok && data.success) {
          const overrideText = data.isOverride ? ' (overridden)' : '';
          showTranslateStatus('✅ Translation saved successfully' + overrideText + '!', 'success');
          loadSubtitleList();
        } else if (res.status === 409) {
          // Target language exists — prompt override
          const targetName = TARGET_LANGUAGES.find(l => l.code === targetLang)?.name || targetLang;
          document.getElementById('override-msg').textContent =
            'A subtitle for "' + targetName + '" already exists. Override it with the translation?';
          if (data.remaining !== undefined) {
            document.getElementById('override-msg').textContent += ' (' + data.remaining + ' overrides remaining this hour)';
          }
          document.getElementById('override-modal').classList.add('active');
          pendingTranslateOverride = { videoHash, sourceLang, targetLang, idx };
        } else if (res.status === 429) {
          showTranslateStatus('⏰ Override limit reached (3/hour). Please try again later.', 'warning');
        } else {
          showTranslateStatus('❌ ' + (data.error || 'Translation failed'), 'error');
        }
      } catch (err) {
        showTranslateStatus('❌ Translation error: ' + err.message, 'error');
      } finally {
        if (subItem) subItem.classList.remove('translating');
      }
    }

    // ── Upload ──────────────────────────────────────────────────────────────
    let pendingOverride = false;
    uploadBtn.addEventListener('click', () => doUpload(false));

    async function doUpload(forceOverride) {
      clearStatus();
      const lang = langSelect.value;
      const file = fileInput.files[0];
      if (!lang || !file || !activeHashes.length) return;

      uploadBtn.disabled = true;
      uploadBtn.textContent = '⏳ Uploading...';

      try {
        const content = await file.text();
        // Use the best hash (stremioHash preferred)
        const uploadHash = activeHashes[0];

        const body = {
          videoHash: uploadHash,
          languageCode: lang,
          content: content,
          forceOverride: forceOverride
        };

        const res = await fetch('/api/smdb/upload?config=' + encodeURIComponent(CONFIG_STR), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        const data = await res.json();

        if (res.ok && data.success) {
          const overrideText = data.isOverride ? ' (overridden)' : '';
          showStatus('✅ Subtitle uploaded successfully' + overrideText + '!', 'success');
          loadSubtitleList();
          fileInput.value = '';
          updateUploadBtn();
        } else if (res.status === 409) {
          // Subtitle exists — prompt override
          document.getElementById('override-msg').textContent =
            'A subtitle for "' + (ALL_LANGUAGES.find(l => l.code === lang)?.name || lang) + '" already exists for this stream. Override it?';
          if (data.remaining !== undefined) {
            document.getElementById('override-msg').textContent += ' (' + data.remaining + ' overrides remaining this hour)';
          }
          document.getElementById('override-modal').classList.add('active');
          pendingOverride = true;
        } else if (res.status === 429) {
          showStatus('⏰ Override limit reached (3/hour). Please try again later.', 'warning');
        } else {
          showStatus('❌ ' + (data.error || 'Upload failed'), 'error');
        }
      } catch (err) {
        showStatus('❌ Upload error: ' + err.message, 'error');
      } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = '⬆️ Upload Subtitle';
        updateUploadBtn();
      }
    }

    // ── Override modal ──────────────────────────────────────────────────────
    document.getElementById('override-cancel').addEventListener('click', () => {
      document.getElementById('override-modal').classList.remove('active');
      pendingOverride = false;
      pendingTranslateOverride = null;
    });
    document.getElementById('override-confirm').addEventListener('click', () => {
      document.getElementById('override-modal').classList.remove('active');
      if (pendingTranslateOverride) {
        const { videoHash, sourceLang, targetLang, idx } = pendingTranslateOverride;
        pendingTranslateOverride = null;
        translateSubtitle(videoHash, sourceLang, targetLang, idx, true);
      } else if (pendingOverride) {
        pendingOverride = false;
        doUpload(true);
      }
    });
    // Close modal on backdrop click
    document.getElementById('override-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        e.currentTarget.classList.remove('active');
        pendingOverride = false;
        pendingTranslateOverride = null;
      }
    });

    // ── Reset Link ────────────────────────────────────────────────────────────
    document.getElementById('reset-link-btn').addEventListener('click', () => {
      streamLocked = false;
      linkedStream = null;
      activeHashes = [];
      currentSubs = [];
      PAGE_LOAD_TIME = Date.now();

      // Reset UI to waiting state
      document.getElementById('stream-waiting').classList.remove('hidden');
      document.getElementById('stream-info').classList.add('hidden');
      document.getElementById('reset-link-btn').classList.remove('visible');
      document.getElementById('content-area').classList.add('hidden');
      clearStatus();
    });

    // ── Init ────────────────────────────────────────────────────────────────
    connectStreamActivity();

    // If we already have a valid videoId/hash from the URL, try an immediate poll
    if (VIDEO_ID && DERIVED_HASH) {
      fetch('/api/stream-activity?config=' + encodeURIComponent(CONFIG_STR))
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data) handleStreamLinked(data); })
        .catch(() => {});
    }
  </script>
  <script src="/js/subtitle-menu.js?v=${escapeHtml(appVersion || 'dev')}&_cb=${escapeHtml(appVersion || 'dev')}"></script>
  <script>
    // ── Subtitle Menu (floating button) ──────────────────────────────────────
    const SUBTITLE_MENU_TARGETS = ${JSON.stringify(subtitleMenuTargets)};
    const SUBTITLE_MENU_SOURCES = ${JSON.stringify(config.sourceLanguages || [])};
    const SUBTITLE_MENU_TARGET_CODES = ${JSON.stringify(config.targetLanguages || [])};
    const SUBTITLE_LANGUAGE_MAPS = JSON.parse(${JSON.stringify(JSON.stringify(languageMaps))});
    let subtitleMenuInstance = null;

    function mountSubtitleMenu() {
      if (!window.SubtitleMenu || typeof window.SubtitleMenu.mount !== 'function') return null;
      try {
        return window.SubtitleMenu.mount({
          configStr: CONFIG_STR,
          videoId: VIDEO_ID,
          filename: FILENAME,
          videoHash: DERIVED_HASH,
          targetOptions: SUBTITLE_MENU_TARGETS,
          sourceLanguages: SUBTITLE_MENU_SOURCES,
          targetLanguages: SUBTITLE_MENU_TARGET_CODES,
          languageMaps: SUBTITLE_LANGUAGE_MAPS,
          getVideoHash: function() {
            if (linkedStream) return linkedStream.stremioHash || linkedStream.videoHash || DERIVED_HASH || '';
            return DERIVED_HASH || '';
          },
          version: '${escapeHtml(appVersion || 'dev')}'
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

    // Wire stream link events to the subtitle menu
    var _origHandleStreamLinked = handleStreamLinked;
    handleStreamLinked = function(data) {
      _origHandleStreamLinked(data);
      // Forward the linked stream to the subtitle floating menu
      if (subtitleMenuInstance && typeof subtitleMenuInstance.updateStream === 'function' && data && data.videoId) {
        subtitleMenuInstance.updateStream({
          videoId: data.videoId,
          filename: data.filename || '',
          videoHash: data.stremioHash || data.videoHash || ''
        });
      }
    };

    // Wire reset to clear the subtitle menu
    (function() {
      var resetBtn = document.getElementById('reset-link-btn');
      if (resetBtn) {
        resetBtn.addEventListener('click', function() {
          if (subtitleMenuInstance && typeof subtitleMenuInstance.updateStream === 'function') {
            subtitleMenuInstance.updateStream({ videoId: '', filename: '', videoHash: '' });
          }
        });
      }
    })();
  </script>
  <script>
    ${quickNavScript()}
  </script>
</body>
</html>`;
}

module.exports = { generateSmdbPage };
