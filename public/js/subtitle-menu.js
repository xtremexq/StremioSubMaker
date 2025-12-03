(function (global) {
  if (global.SubtitleMenu) return;

  const STYLE_ID = 'subtitle-menu-styles';
  const translate = (key, vars, fallback) => {
    try {
      if (typeof global.t === 'function') return global.t(key, vars, fallback);
    } catch (_) {}
    return fallback || key;
  };
  const DEFAULT_LABELS = {
    eyebrow: translate('subtitleMenu.eyebrow', {}, 'Stream subtitles'),
    title: translate('subtitleMenu.title', {}, 'Sources & Targets'),
    waiting: translate('subtitleMenu.waiting', {}, 'Waiting for first fetch'),
    toggleTitle: translate('subtitleMenu.toggleTitle', {}, 'Stream subtitles'),
    refreshTitle: translate('subtitleMenu.refreshTitle', {}, 'Refresh subtitle list'),
    closeTitle: translate('subtitleMenu.closeTitle', {}, 'Close subtitle list')
  };
  const tMenu = (key, vars, fallback) => translate(`subtitleMenu.${key}`, vars, fallback);
  const GROUP_LABELS = {
    source: tMenu('group.source', {}, 'Source & Target'),
    target: tMenu('group.target', {}, 'Target Languages'),
    translation: tMenu('group.translation', {}, 'Translation'),
    other: tMenu('group.other', {}, 'Other Entries')
  };
  const GROUP_HINTS = {
    primary: tMenu('group.sourceHint', {}, 'Original + target subtitles'),
    translation: tMenu('group.translationHint', {}, 'Spin up translations'),
    other: tMenu('group.otherHint', {}, 'xEmbed, Learn, xSync & tools')
  };
  const STATUS_LABELS = {
    waitingStream: tMenu('status.waitingStream', {}, 'Waiting for a linked stream before loading subtitles.'),
    loading: tMenu('status.loading', {}, 'Loading subtitles...'),
    none: tMenu('status.none', {}, 'No subtitles available for this stream yet.'),
    loaded: (count) => tMenu('status.loaded', { count }, `Loaded ${count} subtitle entr${count === 1 ? 'y' : 'ies'}.`),
    ready: (label) => tMenu('status.translationReady', { label: label || 'subtitle' }, `Translation ready for ${label || 'subtitle'}.`),
    inProgress: (label) => tMenu('status.translationInProgress', { label: label || 'subtitle' }, `Translation in progress for ${label || 'subtitle'}.`),
    failed: (reason) => tMenu('status.translationFailed', { reason }, `Translation failed: ${reason}`),
    downloadFailed: (reason) => tMenu('status.downloadFailed', { reason }, `Download failed: ${reason}`),
    translationFailedShort: tMenu('status.translationFailedShort', {}, 'Translation failed. Retry?')
  };

  // Guard: ensure a global config object exists to avoid ReferenceError on hosts that
  // inject subtitle-menu before setting window.config
  if (!global.config) {
    global.config = {};
  }
  // Define a global identifier so bare `config` references (non-strict host scripts) don't throw
  // before config.js has loaded; keep it pointing at window.config.
  var config = global.config; // eslint-disable-line no-var

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
    :root {
      --sm-primary: #08A4D5;
      --sm-primary-glow: rgba(8, 164, 213, 0.4);
      --sm-surface: rgba(255, 255, 255, 0.85);
      --sm-surface-hover: rgba(255, 255, 255, 0.95);
      --sm-border: rgba(255, 255, 255, 0.6);
      --sm-text: #0f172a;
      --sm-text-muted: #64748b;
      --sm-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(255, 255, 255, 0.3);
      --sm-glass: blur(16px) saturate(180%);
      --sm-radius: 20px;
      --sm-font: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }

    [data-theme="dark"], [data-theme="true-dark"] {
      --sm-surface: rgba(15, 23, 42, 0.85);
      --sm-surface-hover: rgba(30, 41, 59, 0.9);
      --sm-border: rgba(255, 255, 255, 0.08);
      --sm-text: #f1f5f9;
      --sm-text-muted: #94a3b8;
      --sm-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08);
    }

    .subtitle-menu-toggle {
      position: fixed;
      bottom: 24px;
      left: 24px;
      width: 56px;
      height: 56px;
      padding: 0;
      gap: 0;
      display: grid;
      place-items: center;
      border-radius: 50%;
      border: 1px solid var(--sm-border);
      background: var(--sm-surface);
      backdrop-filter: var(--sm-glass);
      -webkit-backdrop-filter: var(--sm-glass);
      box-shadow: var(--sm-shadow);
      cursor: pointer;
      z-index: 12010;
      transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      color: var(--sm-text);
    }

    .subtitle-menu-toggle:hover {
      transform: translateY(-4px) scale(1.05);
      border-color: var(--sm-primary);
      box-shadow: 0 20px 40px -5px var(--sm-primary-glow);
      color: var(--sm-primary);
    }

    .subtitle-menu-toggle svg {
      width: 28px;
      height: 28px;
      fill: currentColor;
      transition: transform 0.4s ease;
    }

    .subtitle-menu-toggle:hover svg {
      transform: rotate(15deg);
    }

    .subtitle-menu-toggle.is-loading::after {
      content: '';
      position: absolute;
      inset: -3px;
      border-radius: 50%;
      border: 2px solid transparent;
      border-top-color: var(--sm-primary);
      border-right-color: var(--sm-primary);
      animation: sm-spin 1s linear infinite;
    }

    .subtitle-menu-panel {
      position: fixed;
      bottom: 96px;
      left: 24px;
      width: 380px;
      max-width: calc(100vw - 48px);
      max-height: 75vh;
      background: var(--sm-surface);
      backdrop-filter: var(--sm-glass);
      -webkit-backdrop-filter: var(--sm-glass);
      border: 1px solid var(--sm-border);
      border-radius: var(--sm-radius);
      box-shadow: var(--sm-shadow);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      z-index: 12005;
      transform-origin: bottom left;
      transform: scale(0.9) translateY(20px);
      opacity: 0;
      pointer-events: none;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      font-family: var(--sm-font);
    }

    .subtitle-menu-panel.show {
      opacity: 1;
      transform: scale(1) translateY(0);
      pointer-events: auto;
    }

    .subtitle-menu-header {
      padding: 20px 24px 16px;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      border-bottom: 1px solid var(--sm-border);
      background: linear-gradient(to bottom, rgba(255,255,255,0.05), transparent);
      box-shadow: inset 0 -1px rgba(255, 255, 255, 0.08);
    }

    .subtitle-menu-titles {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .subtitle-menu-eyebrow {
      margin: 0;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--sm-primary);
    }

    .subtitle-menu-header strong {
      display: block;
      font-size: 18px;
      font-weight: 700;
      color: var(--sm-text);
      letter-spacing: -0.02em;
    }

    .subtitle-menu-substatus {
      margin: 0;
      font-size: 13px;
      color: var(--sm-text-muted);
      font-weight: 500;
    }

    .subtitle-menu-actions {
      display: flex;
      gap: 8px;
    }

    .subtitle-menu-icon-btn {
      width: 36px;
      height: 36px;
      padding: 0;
      gap: 0;
      display: grid;
      place-items: center;
      border-radius: 10px;
      border: 1px solid transparent;
      background: rgba(125, 125, 125, 0.1);
      color: var(--sm-text);
      cursor: pointer;
      transition: all 0.2s ease;
      font-size: 18px;
      line-height: 1;
      box-shadow: none;
    }

    .subtitle-menu-icon-btn:hover {
      background: var(--sm-surface-hover);
      color: var(--sm-primary);
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }

    .subtitle-menu-body {
      padding: 16px;
      position: relative;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 24px;
      flex: 1;
      min-height: 0;
      scrollbar-width: thin;
      scrollbar-color: var(--sm-text-muted) transparent;
      box-shadow: inset 0 1px rgba(255, 255, 255, 0.06);
    }

    .subtitle-menu-body::-webkit-scrollbar {
      width: 6px;
    }
    .subtitle-menu-body::-webkit-scrollbar-thumb {
      background-color: var(--sm-text-muted);
      border-radius: 3px;
    }

    .subtitle-menu-group {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 12px 14px;
      border: 1px solid var(--sm-border);
      border-radius: 16px;
      background: linear-gradient(135deg, rgba(8, 164, 213, 0.08), rgba(14, 165, 233, 0.04));
      box-shadow: inset 0 1px rgba(255, 255, 255, 0.06);
    }

    .subtitle-menu-group + .subtitle-menu-group {
      margin-top: 2px;
    }

    /* Keep categories in a predictable order */
    .subtitle-menu-group-primary { order: 1; }
    .subtitle-menu-group-translation { order: 2; }
    .subtitle-menu-group-other { order: 3; }

    .subtitle-menu-group.is-collapsed .subtitle-menu-list {
      display: none;
    }

    .subtitle-menu-group-title {
      width: 100%;
      appearance: none;
      outline: none;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 10px 12px;
      background: rgba(255, 255, 255, 0.04);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      color: var(--sm-text);
      cursor: pointer;
      box-shadow: 0 6px 14px -10px rgba(0, 0, 0, 0.35);
      transition: all 0.2s ease;
      text-align: left;
    }

    .subtitle-menu-group-title:hover {
      border-color: var(--sm-primary);
      box-shadow: 0 10px 28px -12px var(--sm-primary-glow);
      transform: translateY(-1px);
    }

    .subtitle-menu-group-heading {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .subtitle-menu-group-labels {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .subtitle-menu-group-label {
      font-size: 13px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--sm-text);
    }

    .subtitle-menu-group-sub {
      font-size: 12px;
      color: var(--sm-text-muted);
      font-weight: 600;
    }

    .subtitle-menu-group-meta {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .subtitle-menu-count-pill {
      padding: 6px 10px;
      border-radius: 10px;
      background: rgba(15, 23, 42, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.06);
      font-size: 12px;
      font-weight: 800;
      color: var(--sm-text);
      min-width: 28px;
      text-align: center;
    }

    .subtitle-menu-group-chevron {
      display: inline-flex;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.08);
      color: var(--sm-text-muted);
      transition: transform 0.2s ease, background 0.2s ease, color 0.2s ease;
    }

    .subtitle-menu-group.is-open .subtitle-menu-group-chevron {
      transform: rotate(90deg);
      background: rgba(8, 164, 213, 0.12);
      color: var(--sm-primary);
    }

    .subtitle-menu-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .subtitle-lang-card {
      border: 1px solid var(--sm-border);
      border-radius: 16px;
      background: rgba(125, 125, 125, 0.03);
      overflow: hidden;
      transition: all 0.3s ease;
    }

    .subtitle-lang-card.open {
      background: var(--sm-surface-hover);
      border-color: var(--sm-primary);
      box-shadow: 0 8px 24px -6px var(--sm-primary-glow);
    }

    .subtitle-lang-header {
      width: 100%;
      padding: 14px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      background: none;
      border: none;
      cursor: pointer;
      text-align: left;
    }

    .subtitle-lang-meta {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .subtitle-lang-label {
      font-size: 15px;
      font-weight: 700;
      color: var(--sm-text);
    }

    .subtitle-lang-pill {
      font-size: 12px;
      color: var(--sm-text-muted);
      font-weight: 500;
    }

    .subtitle-lang-count {
      padding: 4px 10px;
      border-radius: 20px;
      background: rgba(125, 125, 125, 0.1);
      font-size: 12px;
      font-weight: 700;
      color: var(--sm-text);
    }

    .subtitle-lang-chevron {
      color: var(--sm-text-muted);
      transition: transform 0.3s ease;
      font-size: 12px;
    }

    .subtitle-lang-card.open .subtitle-lang-chevron {
      transform: rotate(90deg);
      color: var(--sm-primary);
    }

    .subtitle-lang-menu {
      display: none;
      flex-direction: column;
      gap: 8px;
      padding: 0 12px 12px;
      animation: sm-slide-down 0.3s ease;
    }

    .subtitle-lang-card.open .subtitle-lang-menu {
      display: flex;
    }

    .subtitle-menu-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px;
      border-radius: 12px;
      background: var(--sm-surface);
      border: 1px solid var(--sm-border);
      transition: all 0.2s ease;
    }

    .subtitle-menu-item:hover {
      transform: translateX(4px);
      border-color: var(--sm-primary);
    }

    .subtitle-menu-item .meta {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }

    .subtitle-menu-item .label {
      font-size: 14px;
      font-weight: 600;
      color: var(--sm-text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .subtitle-menu-chip {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }

    .subtitle-menu-chip.source { background: rgba(59, 130, 246, 0.1); color: #3b82f6; }
    .subtitle-menu-chip.target { background: rgba(16, 185, 129, 0.1); color: #10b981; }
    .subtitle-menu-chip.cached { background: rgba(245, 158, 11, 0.1); color: #f59e0b; }
    .subtitle-menu-chip.learn { background: rgba(139, 92, 246, 0.1); color: #8b5cf6; }
    .subtitle-menu-chip.synced { background: rgba(236, 72, 153, 0.1); color: #ec4899; }

    .subtitle-menu-link {
      padding: 8px 16px;
      border-radius: 8px;
      background: linear-gradient(135deg, var(--sm-primary), #0ea5e9);
      color: #fff;
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      border: none;
      cursor: pointer;
      transition: all 0.2s ease;
      box-shadow: 0 4px 12px rgba(8, 164, 213, 0.3);
      white-space: nowrap;
    }

    .subtitle-menu-link:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 16px rgba(8, 164, 213, 0.4);
    }

    .subtitle-menu-link:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
      background: var(--sm-text-muted);
    }

    .subtitle-menu-status {
      position: relative;
      padding: 10px 14px;
      background: var(--sm-surface);
      border-top: 1px solid var(--sm-border);
      font-size: 13px;
      line-height: 1.2;
      font-weight: 600;
      color: var(--sm-text);
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 42px;
      z-index: 20;
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      box-shadow:
        inset 0 1px rgba(255, 255, 255, 0.08),
        inset 0 -1px rgba(15, 23, 42, 0.06);
    }

    .subtitle-menu-status.show {
      display: flex;
    }

    .subtitle-menu-status.base {
      color: var(--sm-text-muted);
      background: var(--sm-surface-hover);
      font-weight: 600;
    }

    .subtitle-menu-status.error {
      background: rgba(239, 68, 68, 0.1);
      color: #ef4444;
      border-top-color: rgba(239, 68, 68, 0.2);
    }

    .subtitle-menu-footer {
      position: relative;
      padding: 12px 16px;
      background: rgba(255, 255, 255, 0.5);
      border-top: 1px solid var(--sm-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-shrink: 0;
      font-size: 12px;
      color: var(--sm-text-muted);
      backdrop-filter: blur(8px);
      z-index: 10;
      min-height: 54px;
      box-shadow:
        inset 0 1px rgba(255, 255, 255, 0.08),
        0 -1px 0 rgba(15, 23, 42, 0.06);
    }

    [data-theme="dark"] .subtitle-menu-footer,
    [data-theme="true-dark"] .subtitle-menu-footer {
      background: rgba(15, 23, 42, 0.5);
    }

    .subtitle-menu-footer-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
      overflow: hidden;
    }

    .subtitle-menu-footer-title {
      font-weight: 600;
      color: var(--sm-text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .subtitle-menu-footer-meta {
      font-size: 11px;
      opacity: 0.8;
    }

    .subtitle-menu-footer-stats {
      display: flex;
      gap: 8px;
    }

    .subtitle-menu-stat {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      background: rgba(125, 125, 125, 0.1);
      border-radius: 6px;
      font-weight: 600;
      color: var(--sm-text);
    }

    .subtitle-menu-stat svg {
      opacity: 0.7;
    }

    @keyframes sm-slide-up { from { transform: translateY(100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

    @keyframes sm-spin { to { transform: rotate(360deg); } }
    @keyframes sm-slide-down { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }

    @media (max-width: 480px) {
      .subtitle-menu-panel {
        bottom: 0;
        left: 0;
        width: 100%;
        max-width: 100%;
        border-radius: 20px 20px 0 0;
        max-height: 85vh;
      }
      .subtitle-menu-toggle {
        bottom: 16px;
        left: 16px;
      }
    }
    `;
    document.head.appendChild(style);
  }

  function normalizeTargetLangCode(lang) {
    return (lang || '').toString().trim().toLowerCase();
  }

  function normalizeImdbId(id) {
    if (!id) return '';
    const match = String(id).match(/(tt)?(\d{5,8})/i);
    return match ? ('tt' + match[2]) : '';
  }

  function cleanDisplayName(raw) {
    if (!raw) return '';
    const lastSegment = String(raw).split(/[/\\]/).pop() || '';
    const withoutExt = lastSegment.replace(/\.[^.]+$/, '');
    const spaced = withoutExt.replace(/[_\\.]+/g, ' ').replace(/\s+/g, ' ').trim();
    return spaced || withoutExt || lastSegment;
  }

  function parseStremioId(id) {
    if (!id) return null;
    const parts = id.split(':');

    if (parts[0] === 'tmdb') {
      const tmdbId = parts[1];
      if (!tmdbId) return null;
      if (parts.length === 2) return { tmdbId, type: 'movie', tmdbMediaType: 'movie' };
      if (parts.length === 3) return { tmdbId, type: 'episode', season: 1, episode: parseInt(parts[2], 10), tmdbMediaType: 'tv' };
      if (parts.length === 4) return { tmdbId, type: 'episode', season: parseInt(parts[2], 10), episode: parseInt(parts[3], 10), tmdbMediaType: 'tv' };
    }

    if (parts[0] && /^(anidb|kitsu|mal|anilist)/.test(parts[0])) {
      const animeIdType = parts[0];
      if (parts.length === 1) return { animeId: parts[0], animeIdType, type: 'anime', isAnime: true };
      if (parts.length === 3) return { animeId: `${parts[0]}:${parts[1]}`, animeIdType, type: 'anime-episode', episode: parseInt(parts[2], 10), isAnime: true };
      if (parts.length === 4) return { animeId: `${parts[0]}:${parts[1]}`, animeIdType, type: 'anime-episode', season: parseInt(parts[2], 10), episode: parseInt(parts[3], 10), isAnime: true };
    }

    const imdbId = normalizeImdbId(parts[0]);
    if (!imdbId) return null;
    if (parts.length === 1) return { imdbId, type: 'movie' };
    if (parts.length === 3) return { imdbId, type: 'episode', season: parseInt(parts[1], 10), episode: parseInt(parts[2], 10) };
    return null;
  }

  function formatEpisodeTag(parsed) {
    if (!parsed) return '';
    const s = Number.isFinite(parsed.season) ? 'S' + String(parsed.season).padStart(2, '0') : '';
    const e = Number.isFinite(parsed.episode) ? 'E' + String(parsed.episode).padStart(2, '0') : '';
    return (s || e) ? (s + e) : '';
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

  function normalizeLanguageList(list = []) {
    return [...new Set((list || []).map(normalizeLangKey).filter(Boolean))];
  }

  function createMarkup(labels, meta = {}) {
    const versionLabel = meta.version ? 'v' + meta.version : '';
    const toggle = document.createElement('button');
    toggle.className = 'subtitle-menu-toggle';
    toggle.id = 'subtitleMenuToggle';
    toggle.title = labels.toggleTitle;
    toggle.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zM6 10h2v2H6zm0 4h8v2H6zm10 0h2v2h-2zm-6-4h8v2h-8z"/>
      </svg>
    `;

    const panel = document.createElement('div');
    panel.className = 'subtitle-menu-panel';
    panel.id = 'subtitleMenu';

    panel.innerHTML = `
      <div class="subtitle-menu-header">
        <div class="subtitle-menu-titles">
          <p class="subtitle-menu-eyebrow">${labels.eyebrow}</p>
          <strong>${labels.title}</strong>
          <p class="subtitle-menu-substatus" id="subtitleMenuSubstatus">${labels.waiting}</p>
        </div>
        <div class="subtitle-menu-actions">
          <button type="button" class="subtitle-menu-icon-btn" id="subtitleMenuRefresh" title="${labels.refreshTitle}">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
          </button>
          <button type="button" class="subtitle-menu-icon-btn" id="subtitleMenuClose" title="${labels.closeTitle}">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </div>
      <div class="subtitle-menu-body" id="subtitleMenuBody">
        <div class="subtitle-menu-group subtitle-menu-group-primary is-collapsed">
          <button class="subtitle-menu-group-title" type="button" id="subtitleMenuPrimaryToggle" aria-expanded="false">
            <div class="subtitle-menu-group-heading">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
              <div class="subtitle-menu-group-labels">
                <span class="subtitle-menu-group-label">${GROUP_LABELS.source}</span>
                <span class="subtitle-menu-group-sub">${GROUP_HINTS.primary}</span>
              </div>
            </div>
            <div class="subtitle-menu-group-meta">
              <span class="subtitle-menu-count-pill" id="subtitleMenuPrimaryCount">0</span>
              <span class="subtitle-menu-group-chevron">›</span>
            </div>
          </button>
          <div class="subtitle-menu-list" id="subtitleMenuPrimary"></div>
        </div>
        <div class="subtitle-menu-group subtitle-menu-group-translation is-collapsed">
          <button class="subtitle-menu-group-title" type="button" id="subtitleMenuTranslationToggle" aria-expanded="false">
            <div class="subtitle-menu-group-heading">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l6 6"></path><path d="M4 14h6"></path><path d="M2 5h12"></path><path d="M7 2h1"></path><path d="M22 22l-5-10-5 10"></path><path d="M14 18h6"></path></svg>
              <div class="subtitle-menu-group-labels">
                <span class="subtitle-menu-group-label">${GROUP_LABELS.translation}</span>
                <span class="subtitle-menu-group-sub">${GROUP_HINTS.translation}</span>
              </div>
            </div>
            <div class="subtitle-menu-group-meta">
              <span class="subtitle-menu-count-pill" id="subtitleMenuTranslationCount">0</span>
              <span class="subtitle-menu-group-chevron">›</span>
            </div>
          </button>
          <div class="subtitle-menu-list" id="subtitleMenuTranslation"></div>
        </div>
        <div class="subtitle-menu-group subtitle-menu-group-other is-collapsed">
          <button class="subtitle-menu-group-title" type="button" id="subtitleMenuOtherToggle" aria-expanded="false">
            <div class="subtitle-menu-group-heading">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
              <div class="subtitle-menu-group-labels">
                <span class="subtitle-menu-group-label">${GROUP_LABELS.other}</span>
                <span class="subtitle-menu-group-sub">${GROUP_HINTS.other}</span>
              </div>
            </div>
            <div class="subtitle-menu-group-meta">
              <span class="subtitle-menu-count-pill" id="subtitleMenuOtherCount">0</span>
              <span class="subtitle-menu-group-chevron">›</span>
            </div>
          </button>
          <div class="subtitle-menu-list" id="subtitleMenuOther"></div>
        </div>
      </div>
      <div class="subtitle-menu-status" id="subtitleMenuStatus" role="status" aria-live="polite"></div>
      <div class="subtitle-menu-footer" id="subtitleMenuFooter">
        <div class="subtitle-menu-footer-info">
          <div class="subtitle-menu-footer-title">SubMaker</div>
          <div class="subtitle-menu-footer-meta">${versionLabel}</div>
        </div>
        <div class="subtitle-menu-footer-stats" id="subtitleMenuFooterStats"></div>
      </div>
    `;

    document.body.appendChild(toggle);
    document.body.appendChild(panel);

    return {
      toggle,
      panel,
      status: panel.querySelector('#subtitleMenuStatus'),
      body: panel.querySelector('#subtitleMenuBody'),
      primaryList: panel.querySelector('#subtitleMenuPrimary'),
      translationList: panel.querySelector('#subtitleMenuTranslation'),
      otherList: panel.querySelector('#subtitleMenuOther'),
      primaryGroup: panel.querySelector('.subtitle-menu-group-primary'),
      translationGroup: panel.querySelector('.subtitle-menu-group-translation'),
      otherGroup: panel.querySelector('.subtitle-menu-group-other'),
      primaryToggle: panel.querySelector('#subtitleMenuPrimaryToggle'),
      translationToggle: panel.querySelector('#subtitleMenuTranslationToggle'),
      otherToggle: panel.querySelector('#subtitleMenuOtherToggle'),
      primaryCount: panel.querySelector('#subtitleMenuPrimaryCount'),
      translationCount: panel.querySelector('#subtitleMenuTranslationCount'),
      otherCount: panel.querySelector('#subtitleMenuOtherCount'),
      refresh: panel.querySelector('#subtitleMenuRefresh'),
      close: panel.querySelector('#subtitleMenuClose'),
      substatus: panel.querySelector('#subtitleMenuSubstatus'),
      footer: panel.querySelector('#subtitleMenuFooter'),
      footerTitle: panel.querySelector('.subtitle-menu-footer-title'),
      footerMeta: panel.querySelector('.subtitle-menu-footer-meta'),
      footerStats: panel.querySelector('#subtitleMenuFooterStats')
    };
  }

  function normalizeStreamValue(val) {
    return (val || '').toString().trim();
  }

  function isPlaceholderStreamValue(val) {
    return normalizeStreamValue(val).toLowerCase() === 'stream and refresh';
  }

  function buildLanguageLookup(languageMaps) {
    return {
      byCode: (languageMaps && languageMaps.byCode) || {},
      byNameKey: (languageMaps && languageMaps.byNameKey) || {}
    };
  }

  function normalizeLangKey(val) {
    return (val || '').toString().trim().toLowerCase().replace(/[^a-z]/g, '');
  }

  function normalizeNameKey(val) {
    return (val || '').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function lookupLanguageName(languageMaps, raw) {
    if (!raw) return null;
    const byCode = languageMaps.byCode;
    const byNameKey = languageMaps.byNameKey;
    const normCode = normalizeLangKey(raw);
    if (byCode[normCode]) return byCode[normCode];
    const nameKey = normalizeNameKey(raw);
    return nameKey ? (byNameKey[nameKey] || null) : null;
  }

  function extractLanguageCode(value) {
    if (!value) return '';
    const raw = value.toString();
    const direct = raw.match(/^[a-z]{2,3}(?:-[a-z]{2})?$/i);
    if (direct) return normalizeLangKey(direct[0]);
    const translateMatch = raw.match(/_to_([a-z]{2,3}(?:-[a-z]{2})?)/i);
    if (translateMatch) return normalizeLangKey(translateMatch[1]);
    const urlMatch = raw.match(/\/([a-z]{2,3}(?:-[a-z]{2})?)\.srt/i);
    if (urlMatch) return normalizeLangKey(urlMatch[1]);
    const pathMatch = raw.match(/\/([a-z]{2,3}(?:-[a-z]{2})?)\/[^/]*$/i);
    if (pathMatch) return normalizeLangKey(pathMatch[1]);
    return '';
  }

  function resolveLanguageInfo(entry, languageMaps) {
    const rawLabel = (entry?.language || entry?.lang || entry?.langName || '').toString().trim();
    const code = extractLanguageCode(entry?.languageCode)
      || extractLanguageCode(rawLabel)
      || extractLanguageCode(entry?.url)
      || extractLanguageCode(entry?.id);
    const friendly = lookupLanguageName(languageMaps, code) || lookupLanguageName(languageMaps, rawLabel);
    return { code, name: friendly, rawLabel };
  }

  function subtitleChipForType(type, item) {
    if (item?.isTranslation) return { label: tMenu('actions.translate', {}, 'Translate'), cls: 'target' };
    switch (type) {
      case 'target': return { label: 'Target', cls: 'target' };
      case 'cached': return { label: 'xEmbed', cls: 'cached' };
      case 'learn': return { label: 'Learn', cls: 'learn' };
      case 'synced': return { label: 'xSync', cls: 'synced' };
      case 'action': return { label: 'Tool', cls: 'cached' };
      default: return { label: 'Source', cls: 'source' };
    }
  }

  function createSubtitleMenu(options = {}) {
    const config = {
      labels: { ...DEFAULT_LABELS, ...(options.labels || {}) },
      configStr: options.configStr || '',
      videoId: normalizeStreamValue(options.videoId),
      filename: normalizeStreamValue(options.filename),
      videoHash: normalizeStreamValue(options.videoHash),
      targetOptions: options.targetOptions || [],
      sourceLanguages: normalizeLanguageList(options.sourceLanguages || []),
      targetLanguages: normalizeLanguageList(options.targetLanguages || (options.targetOptions || []).map(opt => opt.code || opt.lang || opt.value)),
      onTargetsHydrated: typeof options.onTargetsHydrated === 'function' ? options.onTargetsHydrated : null,
      languageMaps: buildLanguageLookup(options.languageMaps || {}),
      getVideoHash: typeof options.getVideoHash === 'function' ? options.getVideoHash : null,
      version: options.version || ''
    };

    const subtitleMenuState = {
      open: false,
      loading: false,
      items: [],
      lastFetched: null,
      hasFetchedOnce: false,
      hasShownInitialNotice: false,
      statusTimer: null
    };
    const streamMeta = {
      parsed: parseStremioId(config.videoId),
      title: '',
      episodeTag: ''
    };
    const subtitleInventory = {
      items: [],
      lastFetched: null,
      promise: null,
      streamSig: null,
      promiseStreamSig: null
    };
    const translationActions = new Map();
    let translationRefreshTimer = null;
    const languageSets = { source: new Set(), target: new Set() };

    function rebuildLanguageSets() {
      languageSets.source = new Set(normalizeLanguageList(config.sourceLanguages || []));
      const fallbackTargets = (config.targetOptions || []).map(opt => opt.code || opt.lang || opt.value);
      const targetList = (config.targetLanguages && config.targetLanguages.length)
        ? config.targetLanguages
        : fallbackTargets;
      languageSets.target = new Set(normalizeLanguageList(targetList));
    }

    rebuildLanguageSets();

    function deriveEpisodeTagFromState() {
      if (streamMeta.episodeTag) return streamMeta.episodeTag;
      return formatEpisodeTag(streamMeta.parsed);
    }

    function deriveStreamDisplayTitle() {
      if (!hasValidStream()) return '';
      const cleanedFilename = cleanDisplayName(config.filename);
      const cleanedVideoId = cleanDisplayName(config.videoId);
      const base = streamMeta.title || cleanedFilename || cleanedVideoId || config.videoId || '';
      const episodeTag = deriveEpisodeTagFromState();
      return [base, episodeTag].filter(Boolean).join(' - ') || base || 'Linked stream';
    }

    async function hydrateStreamMetadata(els) {
      if (!hasValidStream()) return;
      streamMeta.parsed = parseStremioId(config.videoId);
      streamMeta.episodeTag = formatEpisodeTag(streamMeta.parsed);
      const imdbId = streamMeta.parsed?.imdbId;
      const metaType = streamMeta.parsed?.type === 'episode' ? 'series' : 'movie';
      if (!imdbId) {
        if (els) {
          updateSubtitleMenuMeta(els);
          if (els.footerTitle) {
            els.footerTitle.textContent = deriveStreamDisplayTitle();
            els.footerTitle.title = deriveStreamDisplayTitle();
          }
        }
        return;
      }
      try {
        const resp = await fetch('https://v3-cinemeta.strem.io/meta/' + metaType + '/' + encodeURIComponent(imdbId) + '.json', { cache: 'force-cache' });
        if (!resp.ok) throw new Error('Failed to load metadata');
        const data = await resp.json();
        const meta = data && data.meta;
        const title = meta?.name || meta?.english_name || (meta?.nameTranslated && meta.nameTranslated.en) || '';
        if (title) {
          streamMeta.title = title;
          if (els && els.footerTitle) {
            els.footerTitle.textContent = deriveStreamDisplayTitle();
            els.footerTitle.title = deriveStreamDisplayTitle();
          }
          if (els) {
            updateSubtitleMenuMeta(els);
            setSubtitleMenuStatus(els, '', 'muted', { persist: true });
          }
        }
      } catch (_) {
        // Ignore metadata errors; fall back to filename/videoId
      }
    }

    function deriveStreamSignature(stream = {}) {
      const videoId = normalizeStreamValue(stream.videoId !== undefined ? stream.videoId : config.videoId);
      const filename = normalizeStreamValue(stream.filename !== undefined ? stream.filename : config.filename);
      return [videoId, filename].join('::');
    }

    function hasValidStream() {
      if (!config.configStr) return false;
      const videoIdNorm = normalizeStreamValue(config.videoId);
      if (!videoIdNorm) return false;
      if (isPlaceholderStreamValue(videoIdNorm)) return false;
      return true;
    }

    function buildSubtitleFetchUrl() {
      if (!hasValidStream()) return '';
      const parts = (config.videoId || '').split(':');
      const type = (parts[0] === 'tmdb' && parts.length >= 3) || parts.length >= 3 ? 'series' : 'movie';
      const suffix = config.filename ? ('?filename=' + encodeURIComponent(config.filename)) : '';
      return '/addon/' + encodeURIComponent(config.configStr) + '/subtitles/' + type + '/' + encodeURIComponent(config.videoId || '') + '.json' + suffix;
    }

    function shouldDisplaySubtitle(item) {
      if (!item) return false;
      if (item.type === 'action') return false;
      const label = (item.label || '').toString().toLowerCase();
      if (label.includes('sub toolbox')) return false;
      return true;
    }

    function normalizeSubtitleEntry(entry) {
      const languageInfo = resolveLanguageInfo(entry, config.languageMaps);
      const languageLabel = languageInfo.name || languageInfo.rawLabel || 'Unknown language';
      const baseLabel = (entry?.title || entry?.name || entry?.label || languageInfo.rawLabel || '').toString().trim();
      const fallbackLabel = baseLabel || languageLabel || 'Untitled';
      const preferredLabel = baseLabel || languageLabel || fallbackLabel;
      const idLower = (entry?.id || '').toString().toLowerCase();
      const lower = fallbackLabel.toLowerCase();
      const isTranslation = lower.startsWith('make ') || idLower.startsWith('translate_') || idLower.includes('_to_');
      const isLearn = lower.startsWith('learn ') || idLower.startsWith('learn_');
      const isEmbed = lower.startsWith('xembed') || idLower.startsWith('xembed_');
      const isSync = lower.startsWith('xsync') || idLower.startsWith('xsync_');
      const isAction = lower.includes('toolbox') || idLower.includes('toolbox');
      const ensurePrefix = (labelValue, prefix, options = {}) => {
        const raw = (labelValue || '').toString();
        const stripped = raw.replace(new RegExp('^' + prefix + '\\s*', 'i'), '').trim().replace(/^\((.*)\)$/, '$1').trim();
        if (!stripped) return prefix;
        const lowerPrefix = prefix.toLowerCase();
        if (lowerPrefix === 'make') {
          return translate('subtitleMenu.makeLanguage', { language: stripped }, `Make ${stripped}`);
        }
        if (lowerPrefix === 'learn') {
          return translate('subtitleMenu.learnLanguage', { language: stripped }, `Learn ${stripped}`);
        }
        if (options.wrapInParens) return `${prefix} (${stripped})`;
        return `${prefix} ${stripped}`;
      };

      let displayLabel = fallbackLabel;
      if (isTranslation && !lower.startsWith('make ')) {
        displayLabel = ensurePrefix(preferredLabel, 'Make');
      } else if (isLearn && !lower.startsWith('learn ')) {
        displayLabel = ensurePrefix(preferredLabel, 'Learn');
      } else if (isEmbed && !lower.startsWith('xembed')) {
        displayLabel = ensurePrefix(preferredLabel, 'xEmbed', { wrapInParens: true });
      } else if (isSync && !lower.startsWith('xsync')) {
        displayLabel = ensurePrefix(preferredLabel, 'xSync');
      }

      const normalizedEntry = Object.assign({}, entry, { label: displayLabel, languageLabel });
      const langKey = normalizeLangKey(languageInfo.code || parseTargetLangFromSubtitle(normalizedEntry) || '');
      const inTarget = langKey && languageSets.target.has(langKey);
      const inSource = langKey && languageSets.source.has(langKey);
      const type = isTranslation ? 'target'
        : isLearn ? 'learn'
          : isEmbed ? 'cached'
            : isSync ? 'synced'
              : isAction ? 'action'
                : (inTarget && !inSource ? 'target' : 'source');
      let group = 'source';
      if (isTranslation) group = 'translation';
      else if (isLearn || isEmbed || isSync || isAction) group = 'other';
      else if (inTarget && !inSource) group = 'target';
      return {
        id: entry?.id || displayLabel,
        label: displayLabel,
        languageLabel,
        languageKey: langKey || languageInfo.code || normalizeNameKey(languageLabel) || displayLabel.toLowerCase(),
        url: entry?.url || '#',
        type,
        group,
        isTranslation
      };
    }

    function groupSubtitlesByLanguage(items) {
      const buckets = { primary: new Map(), translation: new Map(), other: new Map() };
      items.forEach(item => {
        const bucket = item.group === 'translation' ? 'translation'
          : (item.group === 'other' ? 'other' : 'primary');

        const map = buckets[bucket];

        // For main group, bucket by language so source+target stack together
        // For Translation and Other, group by label (e.g. "Make Portuguese", "Learn Spanish")
        let key, label;

        if (bucket === 'translation' || bucket === 'other') {
          key = item.label; // Group by the full label
          label = item.label;
        } else {
          key = item.languageKey || item.languageLabel?.toLowerCase() || item.label.toLowerCase();
          label = item.languageLabel || item.label;
        }

        if (!map.has(key)) map.set(key, { key, label, items: [] });
        map.get(key).items.push(item);
      });
      return buckets;
    }

    function deriveLangKeyForItem(item) {
      const raw = item?.languageKey || parseTargetLangFromSubtitle(item);
      return normalizeTargetLangCode(raw || '');
    }

    function ensureTranslationAction(item) {
      if (!item || !item.id) return null;
      if (!translationActions.has(item.id)) {
        translationActions.set(item.id, {
          id: item.id,
          status: 'idle',
          timer: null,
          pollAttempts: 0,
          cachedContent: '',
          filename: '',
          downloadUrl: '',
          langKey: deriveLangKeyForItem(item),
          lastError: ''
        });
      }
      const action = translationActions.get(item.id);
      action.id = item.id || action.id || '';
      action.langKey = deriveLangKeyForItem(item) || action.langKey || '';
      action.label = item?.languageLabel || item?.label || action.label || '';
      action.url = item?.url || action.url || '';
      return action;
    }

    function applyTranslationActionState(action) {
      if (!action || !action.button) return;
      const button = action.button;
      const status = action.status || 'idle';
      button.disabled = status === 'translating';
      if (status === 'ready') {
        button.textContent = tMenu('actions.downloadShort', {}, 'Download');
        button.title = tMenu('actions.download', {}, 'Download translated subtitle');
      } else if (status === 'translating') {
        button.textContent = tMenu('actions.translating', {}, 'Translating...');
        button.title = STATUS_LABELS.inProgress(action.label);
      } else if (status === 'error') {
        button.textContent = tMenu('actions.retry', {}, 'Retry');
        button.title = action.lastError || STATUS_LABELS.translationFailedShort;
        button.disabled = false;
      } else {
        button.textContent = tMenu('actions.translate', {}, 'Translate');
        button.title = tMenu('actions.translateThis', {}, 'Translate this subtitle');
      }
    }

    function stopTranslationPoll(action) {
      if (action && action.timer) {
        clearTimeout(action.timer);
        action.timer = null;
      }
    }

    function markTranslationActions(predicate, info = {}) {
      translationActions.forEach(action => {
        if (typeof predicate === 'function' && !predicate(action)) return;
        stopTranslationPoll(action);
        action.status = 'ready';
        action.downloadUrl = info.downloadUrl || action.downloadUrl || action.url;
        action.cachedContent = info.cachedContent || action.cachedContent || '';
        action.filename = info.filename || action.filename || '';
        applyTranslationActionState(action);
      });
    }

    function markTranslationActionReady(actionId, info = {}) {
      if (!actionId) return;
      markTranslationActions(action => action.id === actionId, info);
    }

    function markTranslationLanguageReady(langKey, info = {}, options = {}) {
      const normalized = normalizeTargetLangCode(langKey || '');
      if (!normalized) return;
      const targetActionId = options.actionId || null;
      markTranslationActions(action => {
        const matchesLang = normalizeTargetLangCode(action.langKey) === normalized;
        const matchesId = !targetActionId || action.id === targetActionId;
        return matchesLang && matchesId;
      }, info);
    }

    function syncTranslationActionsFromInventory(items) {
      const present = new Set();
      const readyLangs = new Map();
      (items || []).forEach(it => {
        if (it && it.type === 'cached') {
          const langKey = normalizeTargetLangCode(it.languageKey || parseTargetLangFromSubtitle(it));
          if (langKey) readyLangs.set(langKey, it.url || '');
        }
      });

      (items || []).forEach(it => {
        if (!it || !it.isTranslation) return;
        present.add(it.id);
        const action = ensureTranslationAction(it);
        if (!action) return;
        const langKey = normalizeTargetLangCode(action.langKey);
        if (langKey && readyLangs.has(langKey)) {
          action.status = 'ready';
          action.downloadUrl = readyLangs.get(langKey) || action.downloadUrl || it.url;
          stopTranslationPoll(action);
          applyTranslationActionState(action);
        }
      });

      translationActions.forEach((action, key) => {
        if (!present.has(key)) {
          stopTranslationPoll(action);
          translationActions.delete(key);
        }
      });
    }

    function getBaseStatusMessage() {
      const parts = [];
      const streamLabel = normalizeStreamValue(config.filename) || normalizeStreamValue(config.videoId);
      parts.push(streamLabel ? ('Stream: ' + streamLabel) : 'Waiting for linked stream');
      const hash = (typeof config.getVideoHash === 'function' ? config.getVideoHash() : config.videoHash) || '';
      if (hash) parts.push('Hash ' + hash);
      return parts.join(' | ') || 'Waiting for linked stream';
    }

    function setSubtitleMenuStatus(els, message, variant = 'muted', options = {}) {
      if (!els.status) return;
      const persist = options.persist === true;
      if (subtitleMenuState.statusTimer) {
        clearTimeout(subtitleMenuState.statusTimer);
        subtitleMenuState.statusTimer = null;
      }

      const isBase = !message;
      const statusText = isBase ? getBaseStatusMessage() : message;
      const classes = ['subtitle-menu-status'];
      if (variant === 'error') classes.push('error');
      if (isBase) classes.push('base');
      els.status.textContent = statusText || '';
      els.status.className = classes.join(' ');
      els.status.style.display = 'flex';
      els.status.classList.add('show');

      if (!isBase && !persist) {
        subtitleMenuState.statusTimer = setTimeout(() => {
          subtitleMenuState.statusTimer = null;
          setSubtitleMenuStatus(els, '', 'muted', { persist: true });
        }, 3200);
      }
    }

    function parseTargetLangFromSubtitle(item) {
      if (!item) return '';
      if (item.id && typeof item.id === 'string') {
        const match = item.id.match(/_to_([a-z0-9-]+)/i);
        if (match && match[1]) return match[1];
      }
      const label = (item.languageLabel || item.label || '').toString();
      if (label.toLowerCase().startsWith('make ')) {
        return label.slice(5).trim();
      }
      return label.trim();
    }

    function deriveTargetOptionsFromSubtitles(items = []) {
      const derived = [];
      const seen = new Set();
      items.forEach(item => {
        if (!item || item.type !== 'target') return;
        const code = normalizeTargetLangCode(parseTargetLangFromSubtitle(item));
        if (!code || seen.has(code)) return;
        seen.add(code);
        const prettyName = (item.languageLabel || item.label || '').replace(/^make\\s+/i, '').trim() || code;
        derived.push({ code, name: prettyName, source: 'subtitles' });
      });
      return derived;
    }

    function hydrateTargetsFromSubtitleInventory(items) {
      if (!Array.isArray(items) || !items.length) return;
      const derived = deriveTargetOptionsFromSubtitles(items);
      if (!derived.length) return;
      const merged = mergeTargetOptions(config.targetOptions, derived);
      config.targetOptions = merged;
      rebuildLanguageSets();
      if (config.onTargetsHydrated) {
        config.onTargetsHydrated(merged);
      }
    }

    function buildSubtitleMenuItem(item) {
      const row = document.createElement('div');
      row.className = 'subtitle-menu-item';

      const meta = document.createElement('div');
      meta.className = 'meta';
      const labelEl = document.createElement('div');
      labelEl.className = 'label';
      labelEl.textContent = item.label;
      const chipData = subtitleChipForType(item.type, item);
      const chip = document.createElement('span');
      chip.className = 'subtitle-menu-chip ' + chipData.cls;
      chip.textContent = chipData.label;
      meta.appendChild(labelEl);
      meta.appendChild(chip);

      let actionEl;
      if (item.isTranslation) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'subtitle-menu-link subtitle-menu-translate';
        const action = ensureTranslationAction(item);
        if (action) {
          action.button = button;
          applyTranslationActionState(action);
        } else {
          button.textContent = tMenu('actions.translate', {}, 'Translate');
        }
        button.addEventListener('click', () => handleTranslationButtonClick(item));
        actionEl = button;
      } else {
        const link = document.createElement('a');
        link.className = 'subtitle-menu-link';
        link.href = item.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = tMenu('actions.downloadShort', {}, 'Download');
        actionEl = link;
      }

      row.appendChild(meta);
      row.appendChild(actionEl);
      return row;
    }

    function buildLanguageCard(langEntry, openByDefault, container, groupType) {
      const card = document.createElement('div');
      card.className = 'subtitle-lang-card' + (openByDefault ? ' open' : '');
      card.setAttribute('data-lang-key', langEntry.key || langEntry.label || '');
      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'subtitle-lang-header';

      const meta = document.createElement('div');
      meta.className = 'subtitle-lang-meta';
      const title = document.createElement('div');
      title.className = 'subtitle-lang-label';
      title.textContent = langEntry.label;
      const pill = document.createElement('div');
      pill.className = 'subtitle-lang-pill';
      const counts = langEntry.items.reduce((acc, itm) => {
        acc[itm.type] = (acc[itm.type] || 0) + 1;
        return acc;
      }, {});
      const summaryParts = [];
      if (counts.cached) summaryParts.push(counts.cached + ' xEmbed');
      if (counts.synced) summaryParts.push(counts.synced + ' xSync');
      if (counts.learn) summaryParts.push(counts.learn + ' Learn');
      if (counts.target) summaryParts.push(counts.target + ' target');
      if (counts.source) summaryParts.push(counts.source + ' source');
      pill.textContent = summaryParts.join(' - ') || 'Subtitles';
      meta.appendChild(title);
      meta.appendChild(pill);

      const right = document.createElement('div');
      right.style.display = 'flex';
      right.style.alignItems = 'center';
      right.style.gap = '8px';
      const count = document.createElement('span');
      count.className = 'subtitle-lang-count';
      count.textContent = langEntry.items.length;
      const chevron = document.createElement('span');
      chevron.className = 'subtitle-lang-chevron';
      chevron.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
      right.appendChild(count);
      right.appendChild(chevron);

      header.appendChild(meta);
      header.appendChild(right);

      const menu = document.createElement('div');
      menu.className = 'subtitle-lang-menu';
      const sortedItems = [...langEntry.items].sort((a, b) => a.label.localeCompare(b.label));
      const languageCodeLabel = (() => {
        const codeCandidate = (langEntry.items.find(it => it.languageKey)?.languageKey || langEntry.key || '').toString().trim();
        return codeCandidate ? codeCandidate.toUpperCase() : 'SUB';
      })();
      let sourceCounter = 0;
      sortedItems.forEach((item) => {
        const isSourceType = item.type === 'source';
        const displayItem = (groupType === 'primary' && isSourceType)
          ? Object.assign({}, item, { label: `${languageCodeLabel} - Subtitle ${sourceCounter + 1}` })
          : item;
        if (isSourceType) sourceCounter += 1;
        menu.appendChild(buildSubtitleMenuItem(displayItem));
      });

      const toggle = () => {
        const next = !card.classList.contains('open');
        if (next && container) {
          const openSiblings = container.querySelectorAll('.subtitle-lang-card.open');
          openSiblings.forEach(el => { if (el !== card) el.classList.remove('open'); });
        }
        card.classList.toggle('open', next);
      };
      header.addEventListener('click', toggle);

      card.appendChild(header);
      card.appendChild(menu);
      return card;
    }

    function getOpenCardKeys(container) {
      const keys = new Set();
      if (!container) return keys;
      container.querySelectorAll('.subtitle-lang-card.open').forEach(el => {
        const key = el.getAttribute('data-lang-key');
        if (key) keys.add(key);
      });
      return keys;
    }

    function setGroupOpenState(groupEl, toggleEl, open) {
      if (!groupEl) return;
      const next = open === true;
      groupEl.classList.toggle('is-collapsed', !next);
      groupEl.classList.toggle('is-open', next);
      if (toggleEl) {
        toggleEl.setAttribute('aria-expanded', next ? 'true' : 'false');
      }
    }

    function toggleGroupState(groupEl, toggleEl) {
      if (!groupEl) return;
      const isCurrentlyOpen = groupEl.classList.contains('is-open') && !groupEl.classList.contains('is-collapsed');
      setGroupOpenState(groupEl, toggleEl, !isCurrentlyOpen);
    }

    function renderSubtitleMenu(items, els) {
      if (!els.primaryList || !els.translationList) return;
      const filtered = (items || []).filter(shouldDisplaySubtitle);
      const grouped = groupSubtitlesByLanguage(filtered);

      const renderList = (container, groupEl, map, groupType, countEl, toggleEl) => {
        if (!container) return;
        const openKeys = getOpenCardKeys(container);
        container.innerHTML = '';
        const languages = Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
        const totalItems = languages.reduce((acc, lang) => acc + (lang.items?.length || 0), 0);
        if (countEl) countEl.textContent = totalItems;

        if (languages.length === 0) {
          if (groupEl) {
            groupEl.style.display = 'none';
            groupEl.setAttribute('aria-hidden', 'true');
            setGroupOpenState(groupEl, toggleEl, false);
          }
        } else {
          if (groupEl) {
            groupEl.style.display = 'flex';
            groupEl.removeAttribute('aria-hidden');
            if (toggleEl) {
              const isOpen = groupEl.classList.contains('is-open') && !groupEl.classList.contains('is-collapsed');
              toggleEl.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            }
          }
          languages.forEach(lang => container.appendChild(buildLanguageCard(lang, openKeys.has(lang.key), container, groupType)));
        }
      };

      renderList(els.primaryList, els.primaryGroup, grouped.primary, 'primary', els.primaryCount, els.primaryToggle);
      renderList(els.translationList, els.translationGroup, grouped.translation, 'translation', els.translationCount, els.translationToggle);
      renderList(els.otherList, els.otherGroup, grouped.other, 'other', els.otherCount, els.otherToggle);

      if (els.body) {
        const hasAny = filtered.length > 0;
        els.body.style.display = hasAny ? 'flex' : 'none';
      }

      // Update footer stats
      if (els.footerStats) {
        const totalSubs = filtered.length;
        const totalLangs = new Set(filtered.map(i => i.languageKey)).size;

        els.footerStats.innerHTML = `
          <div class="subtitle-menu-stat" title="Total subtitles">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
            ${totalSubs}
          </div>
          <div class="subtitle-menu-stat" title="Languages available">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
            ${totalLangs}
          </div>
        `;
      }

      if (els.footerTitle) {
        const displayTitle = deriveStreamDisplayTitle();
        if (displayTitle) {
          els.footerTitle.textContent = displayTitle;
          els.footerTitle.title = displayTitle;
        }
      }
    }

    function updateSubtitleMenuMeta(els) {
      if (!els.substatus) return;
      if (subtitleMenuState.loading) {
        els.substatus.textContent = tMenu('meta.refreshing', {}, 'Refreshing...');
        return;
      }
      if (subtitleMenuState.lastFetched) {
        const elapsed = Math.max(0, Math.floor((Date.now() - subtitleMenuState.lastFetched) / 1000));
        const recency = elapsed < 5
          ? tMenu('meta.justNow', {}, 'just now')
          : tMenu('meta.secondsAgo', { seconds: elapsed }, elapsed + 's ago');
        els.substatus.textContent = tMenu('meta.updated', { time: recency }, 'Updated ' + recency);
      } else {
        els.substatus.textContent = config.labels.waiting;
      }
    }

    function resetSubtitleInventoryState() {
      subtitleInventory.items = [];
      subtitleInventory.lastFetched = null;
      subtitleInventory.promise = null;
      subtitleInventory.streamSig = null;
      subtitleInventory.promiseStreamSig = null;
      translationActions.forEach(action => stopTranslationPoll(action));
      translationActions.clear();
      if (translationRefreshTimer) {
        clearTimeout(translationRefreshTimer);
        translationRefreshTimer = null;
      }
    }

    async function loadSubtitleInventory(options = {}) {
      const opts = typeof options === 'object' && options !== null ? options : {};
      const force = opts.force === true;
      const currentSig = deriveStreamSignature();

      if (!hasValidStream()) {
        throw new Error('Waiting for a valid stream before loading subtitles.');
      }

      if (subtitleInventory.streamSig && subtitleInventory.streamSig !== currentSig) {
        resetSubtitleInventoryState();
      }

      if (subtitleInventory.promise && subtitleInventory.promiseStreamSig === currentSig) {
        return subtitleInventory.promise;
      }
      if (!force && subtitleInventory.items.length && subtitleInventory.lastFetched && subtitleInventory.streamSig === currentSig) {
        return Promise.resolve({
          items: subtitleInventory.items,
          fetchedAt: subtitleInventory.lastFetched,
          fromCache: true
        });
      }
      const fetchUrl = buildSubtitleFetchUrl();
      if (!fetchUrl) {
        throw new Error('No subtitle endpoint available for the current stream.');
      }

      subtitleInventory.promise = (async () => {
        subtitleInventory.promiseStreamSig = currentSig;
        const resp = await fetch(fetchUrl, { headers: { 'Accept': 'application/json' } });
        if (!resp.ok) throw new Error('Request failed (' + resp.status + ')');
        const data = await resp.json();
        const normalized = Array.isArray(data?.subtitles) ? data.subtitles.map(normalizeSubtitleEntry) : [];
        subtitleInventory.items = normalized;
        subtitleInventory.lastFetched = Date.now();
        subtitleInventory.streamSig = currentSig;
        return { items: normalized, fetchedAt: subtitleInventory.lastFetched, fromCache: false };
      })();
      try {
        return await subtitleInventory.promise;
      } finally {
        subtitleInventory.promise = null;
        subtitleInventory.promiseStreamSig = null;
      }
    }

    function queueSubtitleMenuRefresh(els) {
      if (translationRefreshTimer) return;
      translationRefreshTimer = setTimeout(() => {
        translationRefreshTimer = null;
        if (subtitleMenuState.loading) {
          queueSubtitleMenuRefresh(els);
          return;
        }
        fetchSubtitleMenuData(els, { silent: true, force: true });
      }, 400);
    }

    function scheduleTranslationPoll(item, action, els, delay = 3500) {
      stopTranslationPoll(action);
      action.timer = setTimeout(() => requestTranslationStatus(item, els, { fromPoll: true }), delay);
    }

    function isTranslationLoadingMessage(text) {
      const sample = (text || '').toLowerCase();
      const marker = translate('subtitle.loadingTitle', {}, '').toLowerCase();
      const tail = translate('subtitle.loadingTail', {}, '').toLowerCase();
      return sample.includes('translation in progress')
        || sample.includes('translation is happening in the background')
        || sample.includes('please wait while the selected subtitle is being translated')
        || sample.includes('click this subtitle again to confirm translation')
        || sample.includes('reload this subtitle')
        || (marker && sample.includes(marker))
        || (tail && sample.includes(tail));
    }

    function parseDownloadFilename(resp, langKey) {
      try {
        const header = typeof resp?.headers?.get === 'function' ? resp.headers.get('Content-Disposition') : null;
        if (header) {
          const match = /filename[^=]*=\s*\"?([^\\";]+)/i.exec(header);
          if (match && match[1]) return match[1].trim();
        }
      } catch (_) { }
      const lang = normalizeTargetLangCode(langKey || '') || 'subtitle';
      const hash = (config.getVideoHash ? config.getVideoHash() : config.videoHash || 'video') || 'video';
      return (hash || 'video') + '_' + lang + '_translated.srt';
    }

    function triggerSubtitleDownload(content, filename) {
      if (!content) return;
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename || 'translated.srt';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 500);
    }

    async function handleTranslationDownload(item) {
      const action = ensureTranslationAction(item);
      if (!action) return;
      const filename = action.filename || parseDownloadFilename(null, action.langKey);
      try {
        if (action.cachedContent) {
          triggerSubtitleDownload(action.cachedContent, filename);
          return;
        }
        const url = action.downloadUrl || action.url || item.url;
        if (!url) throw new Error('No download URL available');
        const resp = await fetch(url, { cache: 'no-store' });
        const text = await resp.text();
        action.cachedContent = text;
        action.filename = parseDownloadFilename(resp, action.langKey) || filename;
        triggerSubtitleDownload(text, action.filename);
      } catch (error) {
        setSubtitleMenuStatus(elements, STATUS_LABELS.downloadFailed(error.message), 'error', { persist: true });
      }
    }

    async function requestTranslationStatus(item, els, options = {}) {
      const action = ensureTranslationAction(item);
      if (!action || !action.url) return;
      if (action.status === 'translating' && options.fromPoll !== true) {
        return;
      }
      if (options.fromPoll !== true) {
        action.pollAttempts = 0;
      }
      action.status = 'translating';
      applyTranslationActionState(action);

      try {
        const resp = await fetch(action.url, { cache: 'no-store' });
        const text = await resp.text();
        const loading = resp.status === 202 || isTranslationLoadingMessage(text);
        if (!resp.ok && resp.status !== 202) {
          throw new Error('Request failed (' + resp.status + ')');
        }

        if (loading) {
          action.pollAttempts = (action.pollAttempts || 0) + 1;
          setSubtitleMenuStatus(els, STATUS_LABELS.inProgress(action.label), 'muted');
          if (action.pollAttempts >= 24) {
            action.status = 'error';
            action.lastError = tMenu('status.stillProcessing', {}, 'Still processing. Please retry shortly.');
            stopTranslationPoll(action);
            applyTranslationActionState(action);
            return;
          }
          scheduleTranslationPoll(item, action, els);
          return;
        }

        action.status = 'ready';
        action.cachedContent = text;
        action.filename = parseDownloadFilename(resp, action.langKey);
        action.pollAttempts = 0;
        applyTranslationActionState(action);
        markTranslationActionReady(action.id, {
          downloadUrl: action.downloadUrl || action.url,
          cachedContent: text,
          filename: action.filename
        });
        queueSubtitleMenuRefresh(els);
        setSubtitleMenuStatus(els, STATUS_LABELS.ready(action.label), 'muted');
      } catch (error) {
        action.status = 'error';
        action.lastError = error.message || STATUS_LABELS.translationFailedShort;
        stopTranslationPoll(action);
        applyTranslationActionState(action);
        setSubtitleMenuStatus(els, STATUS_LABELS.failed(action.lastError), 'error', { persist: true });
      }
    }

    function handleTranslationButtonClick(item) {
      const action = ensureTranslationAction(item);
      if (!action) return;
      if (action.status === 'translating') return;
      if (action.status === 'ready') {
        handleTranslationDownload(item);
        return;
      }
      requestTranslationStatus(item, elements, { fromPoll: false });
    }

    function renderMenuFromState(els) {
      renderSubtitleMenu(subtitleMenuState.items, els);
      updateSubtitleMenuMeta(els);
    }

    async function fetchSubtitleMenuData(els, silentOrOptions = false) {
      const opts = typeof silentOrOptions === 'object' && silentOrOptions !== null
        ? silentOrOptions
        : { silent: !!silentOrOptions };
      const silent = opts.silent === true;
      const force = opts.force === true;
      if (!hasValidStream()) {
        setSubtitleMenuStatus(els, STATUS_LABELS.waitingStream, 'muted', { persist: true });
        return;
      }
      subtitleMenuState.loading = true;
      els.toggle?.classList.add('is-loading');
      updateSubtitleMenuMeta(els);
      if (!silent) setSubtitleMenuStatus(els, STATUS_LABELS.loading, 'muted');
      const panelOpen = subtitleMenuState.open && els.panel?.classList.contains('show');
      const shouldShowInitialNotice = panelOpen && !subtitleMenuState.hasShownInitialNotice;
      const shouldShowActiveNotice = panelOpen && !silent;
      try {
        const { items: normalized, fetchedAt, fromCache } = await loadSubtitleInventory({ force });
        const visibleCount = normalized.filter(shouldDisplaySubtitle).length;
        subtitleMenuState.items = normalized;
        subtitleMenuState.lastFetched = fetchedAt || Date.now();
        syncTranslationActionsFromInventory(normalized);
        hydrateTargetsFromSubtitleInventory(normalized);
        const canShow = shouldShowInitialNotice || shouldShowActiveNotice || !subtitleMenuState.hasFetchedOnce;
        if (visibleCount) {
          if (canShow && (!fromCache || !subtitleMenuState.hasFetchedOnce || force)) {
            setSubtitleMenuStatus(els, STATUS_LABELS.loaded(visibleCount));
            if (shouldShowInitialNotice) subtitleMenuState.hasShownInitialNotice = true;
          } else {
            setSubtitleMenuStatus(els, '', 'muted');
          }
        } else if (canShow && (!fromCache || !subtitleMenuState.hasFetchedOnce || force)) {
          setSubtitleMenuStatus(els, STATUS_LABELS.none);
          if (shouldShowInitialNotice) subtitleMenuState.hasShownInitialNotice = true;
        } else {
          setSubtitleMenuStatus(els, '', 'muted');
        }
        renderMenuFromState(els);
        subtitleMenuState.hasFetchedOnce = true;
      } catch (err) {
        setSubtitleMenuStatus(els, tMenu('status.loadError', { reason: err.message }, 'Could not load subtitles: ' + err.message), 'error', { persist: true });
        subtitleMenuState.items = [];
        translationActions.forEach(action => stopTranslationPoll(action));
        translationActions.clear();
        renderMenuFromState(els);
        subtitleMenuState.hasFetchedOnce = true;
      } finally {
        subtitleMenuState.loading = false;
        els.toggle?.classList.remove('is-loading');
        updateSubtitleMenuMeta(els);
      }
    }

    function toggleSubtitleMenu(els, forceOpen) {
      const nextOpen = typeof forceOpen === 'boolean' ? !!forceOpen : !subtitleMenuState.open;
      subtitleMenuState.open = nextOpen;
      if (els.panel) {
        els.panel.classList.toggle('show', subtitleMenuState.open);
        els.panel.setAttribute('aria-hidden', subtitleMenuState.open ? 'false' : 'true');
      }
      if (subtitleMenuState.open) {
        if (!subtitleMenuState.loading) {
          fetchSubtitleMenuData(els, { silent: true });
        }
        if (!subtitleMenuState.hasShownInitialNotice && subtitleMenuState.items.length) {
          const visibleCount = subtitleMenuState.items.filter(shouldDisplaySubtitle).length;
          if (visibleCount) {
            setSubtitleMenuStatus(els, STATUS_LABELS.loaded(visibleCount));
            subtitleMenuState.hasShownInitialNotice = true;
          } else if (subtitleMenuState.hasFetchedOnce) {
            setSubtitleMenuStatus(els, STATUS_LABELS.none);
            subtitleMenuState.hasShownInitialNotice = true;
          }
        }
      } else {
        setSubtitleMenuStatus(els, '');
      }
    }

    function handleStreamUpdate(payload, els) {
      const nextSig = deriveStreamSignature(payload || {});
      const currentSig = deriveStreamSignature();
      if (!nextSig || nextSig === currentSig) return;

      config.videoId = normalizeStreamValue(payload.videoId) || config.videoId;
      config.filename = normalizeStreamValue(payload.filename) || config.filename;
      config.videoHash = normalizeStreamValue(payload.videoHash) || config.videoHash;
      config.targetOptions = Array.isArray(options.targetOptions) ? [...options.targetOptions] : [];
      config.sourceLanguages = Array.isArray(options.sourceLanguages) ? normalizeLanguageList(options.sourceLanguages) : config.sourceLanguages;
      config.targetLanguages = Array.isArray(options.targetLanguages) ? normalizeLanguageList(options.targetLanguages) : config.targetLanguages;
      rebuildLanguageSets();
      streamMeta.title = '';
      streamMeta.episodeTag = '';
      streamMeta.parsed = parseStremioId(config.videoId);

      resetSubtitleInventoryState();
      subtitleMenuState.items = [];
      subtitleMenuState.lastFetched = null;
      subtitleMenuState.hasFetchedOnce = false;
      subtitleMenuState.hasShownInitialNotice = false;
      renderMenuFromState(els);
      updateSubtitleMenuMeta(els);
      setSubtitleMenuStatus(els, '', 'muted', { persist: true });
      hydrateStreamMetadata(els).catch(() => { });
      if (config.onTargetsHydrated) {
        config.onTargetsHydrated(config.targetOptions);
      }
      loadSubtitleInventory({ force: false }).catch(() => { });
      if (subtitleMenuState.open) {
        fetchSubtitleMenuData(els, { silent: true });
      }
    }

    injectStyles();
    // Guard against unexpected ReferenceErrors during markup creation (e.g., partial loads)
    let elements;
    try {
      elements = createMarkup(config.labels, config);
    } catch (err) {
      console.warn('Subtitle menu markup creation failed', err, { options });
      return {
        prefetch: () => {},
        refresh: () => {},
        toggle: () => {},
        updateStream: () => {},
        notify: () => {},
        getTargets: () => config.targetOptions.slice(),
        destroy: () => {}
      };
    }

    if (elements.toggle) {
      elements.toggle.addEventListener('click', () => toggleSubtitleMenu(elements));
    }
    if (elements.close) {
      elements.close.addEventListener('click', () => toggleSubtitleMenu(elements, false));
    }
    if (elements.refresh) {
      elements.refresh.addEventListener('click', () => fetchSubtitleMenuData(elements, { silent: false, force: true }));
    }

    const attachGroupToggle = (toggleEl, groupEl) => {
      if (!toggleEl || !groupEl) return;
      toggleEl.addEventListener('click', () => toggleGroupState(groupEl, toggleEl));
    };
    attachGroupToggle(elements.primaryToggle, elements.primaryGroup);
    attachGroupToggle(elements.translationToggle, elements.translationGroup);
    attachGroupToggle(elements.otherToggle, elements.otherGroup);

    updateSubtitleMenuMeta(elements);
    setSubtitleMenuStatus(elements, '', 'muted', { persist: true });
    hydrateStreamMetadata(elements).catch(() => { });

    if (hasValidStream()) {
      loadSubtitleInventory({ force: false })
        .then(result => {
          hydrateTargetsFromSubtitleInventory((result && result.items) || []);
        })
        .catch(() => { });
    }

    const api = {
      refresh: (opts) => fetchSubtitleMenuData(elements, opts || { silent: false, force: true }),
      prefetch: () => loadSubtitleInventory({ force: false }).catch(() => { }),
      toggle: (open) => toggleSubtitleMenu(elements, open),
      updateStream: (payload) => handleStreamUpdate(payload, elements),
      notify: (message, variant = 'muted', options = {}) => {
        const opts = Object.assign({ persist: true }, options || {});
        setSubtitleMenuStatus(elements, message, variant, opts);
      },
      getTargets: () => config.targetOptions.slice(),
      destroy: () => {
        setSubtitleMenuStatus(elements, '');
        if (elements.toggle) elements.toggle.remove();
        if (elements.panel) elements.panel.remove();
        resetSubtitleInventoryState();
      }
    };

    return api;
  }

  global.SubtitleMenu = { mount: (options) => createSubtitleMenu(options) };
})(typeof window !== 'undefined' ? window : globalThis);
