(function (global) {
  if (global.SubtitleMenu) return;

  const STYLE_ID = 'subtitle-menu-styles';
  const DEFAULT_LABELS = {
    eyebrow: 'Stream subtitles',
    title: 'Sources & Targets',
    waiting: 'Waiting for first fetch',
    toggleTitle: 'Stream subtitles',
    refreshTitle: 'Refresh subtitle list',
    closeTitle: 'Close subtitle list'
  };

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
    .subtitle-menu-toggle {
      position: fixed;
      bottom: 1.1rem;
      left: 1.1rem;
      width: 56px;
      height: 56px;
      display: grid;
      place-items: center;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: var(--surface);
      box-shadow: 0 14px 32px var(--shadow);
      cursor: pointer;
      z-index: 12010;
      transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
    }
    .subtitle-menu-toggle:hover {
      transform: translateY(-2px);
      border-color: var(--primary);
      box-shadow: 0 16px 36px var(--shadow-color);
    }
    .subtitle-menu-toggle svg { width: 26px; height: 26px; fill: #0f172a; }
    [data-theme="dark"] .subtitle-menu-toggle svg,
    [data-theme="true-dark"] .subtitle-menu-toggle svg { fill: #E8EAED; }
    .subtitle-menu-toggle.is-loading::after {
      content: '';
      position: absolute;
      top: 8px;
      right: 8px;
      width: 12px;
      height: 12px;
      border-radius: 999px;
      border: 2px solid var(--border);
      border-top-color: var(--primary);
      animation: spin 0.8s linear infinite;
    }
    .subtitle-menu-panel {
      position: fixed;
      bottom: 80px;
      left: 1.1rem;
      width: min(360px, calc(100% - 32px));
      max-height: 72vh;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      box-shadow: 0 18px 42px var(--shadow);
      overflow: hidden;
      z-index: 12005;
      transform: translateY(8px);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease, transform 0.2s ease;
    }
    .subtitle-menu-panel.show {
      opacity: 1;
      transform: translateY(0);
      pointer-events: auto;
    }
    .subtitle-menu-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 14px;
      background: linear-gradient(135deg, rgba(8, 164, 213, 0.08), rgba(51, 185, 225, 0.06));
      border-bottom: 1px solid var(--border);
    }
    .subtitle-menu-titles { display: flex; flex-direction: column; gap: 2px; }
    .subtitle-menu-eyebrow {
      margin: 0;
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 700;
    }
    .subtitle-menu-header strong { display: block; font-size: 16px; color: var(--text-primary); }
    .subtitle-menu-substatus { margin: 0; font-size: 12px; color: var(--muted); font-weight: 700; }
    .subtitle-menu-actions { display: flex; align-items: center; gap: 6px; }
    .subtitle-menu-icon-btn {
      width: 32px;
      height: 32px;
      display: grid;
      place-items: center;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--surface-light);
      cursor: pointer;
      font-weight: 800;
      color: var(--text-secondary);
      font-size: 20px;
      line-height: 1;
      transition: all 0.15s ease;
    }
    .subtitle-menu-icon-btn:hover { background: var(--surface-hover); color: var(--text-primary); border-color: var(--primary); }
    .subtitle-menu-body { padding: 12px 14px 34px; display: flex; flex-direction: column; gap: 10px; overflow: auto; max-height: calc(72vh - 70px); }
    .subtitle-menu-group { display: flex; flex-direction: column; gap: 8px; }
    .subtitle-menu-group-title { font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 8px; }
    .subtitle-menu-group-title::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, var(--border), transparent); }
    .subtitle-menu-list { display: flex; flex-direction: column; gap: 8px; }
    .subtitle-menu-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--surface-light);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }
    .subtitle-menu-item .meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .subtitle-menu-item .label { font-weight: 700; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .subtitle-menu-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 700;
      border: 1px solid var(--border);
      color: var(--text-secondary);
      background: var(--surface);
      white-space: nowrap;
    }
    .subtitle-menu-chip.source { border-color: var(--primary); color: var(--primary); }
    .subtitle-menu-chip.target { border-color: var(--secondary); color: var(--secondary); }
    .subtitle-menu-chip.cached { border-color: var(--muted); color: var(--text-secondary); }
    .subtitle-menu-chip.learn { border-color: #6366f1; color: #6366f1; }
    .subtitle-menu-chip.synced { border-color: #10b981; color: #0f9f6e; }
    .subtitle-menu-link {
      padding: 8px 10px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
      color: #fff;
      font-weight: 700;
      text-decoration: none;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
      box-shadow: 0 8px 18px var(--glow);
      flex-shrink: 0;
    }
    button.subtitle-menu-link { border: none; }
    button.subtitle-menu-link:disabled { opacity: 0.65; cursor: not-allowed; box-shadow: none; transform: none; }
    .subtitle-menu-link:hover { transform: translateY(-1px); box-shadow: 0 10px 20px var(--glow); }
    .subtitle-menu-status {
      position: absolute;
      left: 12px;
      right: 12px;
      bottom: 12px;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid var(--border);
      color: var(--text-secondary);
      font-weight: 700;
      background: var(--surface);
      box-shadow: 0 12px 28px var(--shadow-color);
      opacity: 0;
      pointer-events: none;
      transform: translateY(6px);
      z-index: 2;
      transition: opacity 0.18s ease, transform 0.18s ease;
      display: none;
    }
    .subtitle-menu-status.show { opacity: 1; transform: translateY(0); display: block; }
    .subtitle-menu-status.error { color: var(--danger); border-color: rgba(239, 68, 68, 0.4); box-shadow: 0 12px 28px rgba(239, 68, 68, 0.28); }
    .subtitle-lang-card {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--surface-light);
      overflow: hidden;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .subtitle-lang-card.open { border-color: var(--primary); box-shadow: 0 10px 24px var(--shadow-color); }
    .subtitle-lang-header {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      background: none;
      border: none;
      cursor: pointer;
    }
    .subtitle-lang-meta { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
    .subtitle-lang-label { font-weight: 800; color: var(--text-primary); }
    .subtitle-lang-pill { font-size: 12px; color: var(--muted); font-weight: 700; }
    .subtitle-lang-count {
      padding: 4px 8px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text-secondary);
      font-weight: 800;
    }
    .subtitle-lang-chevron { color: var(--muted); transition: transform 0.2s ease; }
    .subtitle-lang-card.open .subtitle-lang-chevron { transform: rotate(90deg); }
    .subtitle-lang-menu { display: none; flex-direction: column; gap: 8px; padding: 0 12px 12px; }
    .subtitle-lang-card.open .subtitle-lang-menu { display: flex; }
    .subtitle-lang-menu .subtitle-menu-item { margin-top: 4px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);
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

  function createMarkup(labels) {
    const toggle = document.createElement('button');
    toggle.className = 'subtitle-menu-toggle';
    toggle.id = 'subtitleMenuToggle';
    toggle.title = labels.toggleTitle;
    toggle.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 4h16a1 1 0 011 1v10a1 1 0 01-1 1H7l-4 4V5a1 1 0 011-1z"></path>
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
          <button type="button" class="subtitle-menu-icon-btn" id="subtitleMenuRefresh" title="${labels.refreshTitle}">&#8635;</button>
          <button type="button" class="subtitle-menu-icon-btn" id="subtitleMenuClose" title="${labels.closeTitle}">&times;</button>
        </div>
      </div>
      <div class="subtitle-menu-body" id="subtitleMenuBody">
        <div class="subtitle-menu-group">
          <div class="subtitle-menu-group-title">Source languages</div>
          <div class="subtitle-menu-list" id="subtitleMenuSource"></div>
        </div>
        <div class="subtitle-menu-group">
          <div class="subtitle-menu-group-title">Translation</div>
          <div class="subtitle-menu-list" id="subtitleMenuTranslation"></div>
        </div>
        <div class="subtitle-menu-group">
          <div class="subtitle-menu-group-title">Target & cached</div>
          <div class="subtitle-menu-list" id="subtitleMenuTarget"></div>
        </div>
      </div>
      <div class="subtitle-menu-status" id="subtitleMenuStatus" role="status" aria-live="polite"></div>
    `;

    document.body.appendChild(toggle);
    document.body.appendChild(panel);

    return {
      toggle,
      panel,
      status: panel.querySelector('#subtitleMenuStatus'),
      body: panel.querySelector('#subtitleMenuBody'),
      sourceList: panel.querySelector('#subtitleMenuSource'),
      translationList: panel.querySelector('#subtitleMenuTranslation'),
      targetList: panel.querySelector('#subtitleMenuTarget'),
      refresh: panel.querySelector('#subtitleMenuRefresh'),
      close: panel.querySelector('#subtitleMenuClose'),
      substatus: panel.querySelector('#subtitleMenuSubstatus')
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
    if (item?.isTranslation) return { label: 'Translate', cls: 'target' };
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
      onTargetsHydrated: typeof options.onTargetsHydrated === 'function' ? options.onTargetsHydrated : null,
      languageMaps: buildLanguageLookup(options.languageMaps || {}),
      getVideoHash: typeof options.getVideoHash === 'function' ? options.getVideoHash : null
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
    const subtitleInventory = {
      items: [],
      lastFetched: null,
      promise: null,
      streamSig: null,
      promiseStreamSig: null
    };
    const translationActions = new Map();
    let translationRefreshTimer = null;

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
      if (item.type === 'action' || item.type === 'learn') return false;
      const label = (item.label || '').toString().toLowerCase();
      if (label.includes('sub toolbox')) return false;
      return true;
    }

    function normalizeSubtitleEntry(entry) {
      const languageInfo = resolveLanguageInfo(entry, config.languageMaps);
      const languageLabel = languageInfo.name || languageInfo.rawLabel || 'Unknown language';
      const displayLabel = (entry?.title || entry?.name || entry?.label || languageInfo.rawLabel || '').toString().trim()
        || languageLabel
        || 'Untitled';
      const lower = displayLabel.toLowerCase();
      const isTranslation = lower.startsWith('make ');
      const type = isTranslation ? 'target'
        : lower.startsWith('learn ') ? 'learn'
        : lower.startsWith('xembed') ? 'cached'
        : lower.startsWith('xsync') ? 'synced'
        : lower.includes('toolbox') ? 'action'
        : 'source';
      const group = isTranslation ? 'translation' : ((type === 'cached' || type === 'learn') ? 'target' : 'source');
      return {
        id: entry?.id || displayLabel,
        label: displayLabel,
        languageLabel,
        languageKey: languageInfo.code || normalizeNameKey(languageLabel) || displayLabel.toLowerCase(),
        url: entry?.url || '#',
        type,
        group,
        isTranslation
      };
    }

    function groupSubtitlesByLanguage(items) {
      const buckets = { source: new Map(), target: new Map(), translation: new Map() };
      items.forEach(item => {
        const bucket = item.group === 'translation' ? 'translation' : (item.group === 'target' ? 'target' : 'source');
        const map = buckets[bucket];
        const key = item.languageKey || item.languageLabel?.toLowerCase() || item.label.toLowerCase();
        const label = item.languageLabel || item.label;
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
        button.textContent = 'Download';
        button.title = 'Download translated subtitle';
      } else if (status === 'translating') {
        button.textContent = 'Translating...';
        button.title = 'Translation in progress';
      } else if (status === 'error') {
        button.textContent = 'Retry';
        button.title = action.lastError || 'Translation failed. Retry?';
        button.disabled = false;
      } else {
        button.textContent = 'Translate';
        button.title = 'Translate this subtitle';
      }
    }

    function stopTranslationPoll(action) {
      if (action && action.timer) {
        clearTimeout(action.timer);
        action.timer = null;
      }
    }

    function markTranslationLanguageReady(langKey, info = {}) {
      const normalized = normalizeTargetLangCode(langKey || '');
      if (!normalized) return;
      translationActions.forEach(action => {
        if (normalizeTargetLangCode(action.langKey) !== normalized) return;
        stopTranslationPoll(action);
        action.status = 'ready';
        action.downloadUrl = info.downloadUrl || action.downloadUrl || action.url;
        action.cachedContent = info.cachedContent || action.cachedContent || '';
        action.filename = info.filename || action.filename || '';
        applyTranslationActionState(action);
      });
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

    function setSubtitleMenuStatus(els, message, variant = 'muted', options = {}) {
      if (!els.status) return;
      const persist = options.persist === true;
      if (subtitleMenuState.statusTimer) {
        clearTimeout(subtitleMenuState.statusTimer);
        subtitleMenuState.statusTimer = null;
      }
      if (!message) {
        els.status.classList.remove('show');
        subtitleMenuState.statusTimer = setTimeout(() => {
          if (!els.status) return;
          els.status.style.display = 'none';
          els.status.textContent = '';
          subtitleMenuState.statusTimer = null;
        }, 180);
        return;
      }
      els.status.textContent = message || '';
      els.status.className = 'subtitle-menu-status' + (variant === 'error' ? ' error' : '');
      els.status.style.display = 'block';
      requestAnimationFrame(() => els.status?.classList.add('show'));
      if (!persist) {
        subtitleMenuState.statusTimer = setTimeout(() => {
          els.status.classList.remove('show');
          subtitleMenuState.statusTimer = setTimeout(() => {
            if (!els.status) return;
            els.status.style.display = 'none';
            els.status.textContent = '';
            subtitleMenuState.statusTimer = null;
          }, 180);
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
          button.textContent = 'Translate';
        }
        button.addEventListener('click', () => handleTranslationButtonClick(item));
        actionEl = button;
      } else {
        const link = document.createElement('a');
        link.className = 'subtitle-menu-link';
        link.href = item.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Download';
        actionEl = link;
      }

      row.appendChild(meta);
      row.appendChild(actionEl);
      return row;
    }

    function buildLanguageCard(langEntry, openByDefault, container) {
      const card = document.createElement('div');
      card.className = 'subtitle-lang-card' + (openByDefault ? ' open' : '');
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
      count.textContent = langEntry.items.length + ' option' + (langEntry.items.length === 1 ? '' : 's');
      const chevron = document.createElement('span');
      chevron.className = 'subtitle-lang-chevron';
      chevron.textContent = '>';
      right.appendChild(count);
      right.appendChild(chevron);

      header.appendChild(meta);
      header.appendChild(right);

      const menu = document.createElement('div');
      menu.className = 'subtitle-lang-menu';
      const sortedItems = [...langEntry.items].sort((a, b) => a.label.localeCompare(b.label));
      sortedItems.forEach(item => menu.appendChild(buildSubtitleMenuItem(item)));

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

    function renderSubtitleMenu(items, els) {
      if (!els.sourceList || !els.targetList || !els.translationList) return;
      const filtered = (items || []).filter(shouldDisplaySubtitle);
      const grouped = groupSubtitlesByLanguage(filtered);

      const renderList = (container, map) => {
        container.innerHTML = '';
        const languages = Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
        languages.forEach(lang => container.appendChild(buildLanguageCard(lang, false, container)));
      };

      renderList(els.sourceList, grouped.source);
      renderList(els.translationList, grouped.translation);
      renderList(els.targetList, grouped.target);

      if (els.body) {
        const hasAny = filtered.length > 0;
        els.body.style.display = hasAny ? 'flex' : 'none';
      }
    }

    function updateSubtitleMenuMeta(els) {
      if (!els.substatus) return;
      if (subtitleMenuState.loading) {
        els.substatus.textContent = 'Refreshing...';
        return;
      }
      if (subtitleMenuState.lastFetched) {
        const elapsed = Math.max(0, Math.floor((Date.now() - subtitleMenuState.lastFetched) / 1000));
        const recency = elapsed < 5 ? 'just now' : (elapsed + 's ago');
        els.substatus.textContent = 'Updated ' + recency;
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
      return sample.includes('translation in progress')
        || sample.includes('translation is happening in the background')
        || sample.includes('please wait while the selected subtitle is being translated')
        || sample.includes('click this subtitle again to confirm translation')
        || sample.includes('reload this subtitle');
    }

    function parseDownloadFilename(resp, langKey) {
      try {
        const header = typeof resp?.headers?.get === 'function' ? resp.headers.get('Content-Disposition') : null;
        if (header) {
          const match = /filename[^=]*=\s*\"?([^\\";]+)/i.exec(header);
          if (match && match[1]) return match[1].trim();
        }
      } catch (_) {}
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
        setSubtitleMenuStatus(elements, 'Download failed: ' + error.message, 'error', { persist: true });
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
          setSubtitleMenuStatus(els, 'Translation in progress for ' + (action.label || 'subtitle') + '.', 'muted');
          if (action.pollAttempts >= 24) {
            action.status = 'error';
            action.lastError = 'Still processing. Please retry shortly.';
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
        markTranslationLanguageReady(action.langKey, {
          downloadUrl: action.downloadUrl || action.url,
          cachedContent: text,
          filename: action.filename
        });
        queueSubtitleMenuRefresh(els);
        setSubtitleMenuStatus(els, 'Translation ready for ' + (action.label || 'subtitle') + '.', 'muted');
      } catch (error) {
        action.status = 'error';
        action.lastError = error.message || 'Translation failed';
        stopTranslationPoll(action);
        applyTranslationActionState(action);
        setSubtitleMenuStatus(els, 'Translation failed: ' + action.lastError, 'error', { persist: true });
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
        setSubtitleMenuStatus(els, 'Waiting for a linked stream before loading subtitles.', 'muted', { persist: true });
        return;
      }
      subtitleMenuState.loading = true;
      els.toggle?.classList.add('is-loading');
      updateSubtitleMenuMeta(els);
      if (!silent) setSubtitleMenuStatus(els, 'Loading subtitles...', 'muted');
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
            setSubtitleMenuStatus(els, 'Loaded ' + visibleCount + ' subtitle entr' + (visibleCount === 1 ? 'y' : 'ies') + '.');
            if (shouldShowInitialNotice) subtitleMenuState.hasShownInitialNotice = true;
          } else {
            setSubtitleMenuStatus(els, '', 'muted');
          }
        } else if (canShow && (!fromCache || !subtitleMenuState.hasFetchedOnce || force)) {
          setSubtitleMenuStatus(els, 'No subtitles available for this stream yet.');
          if (shouldShowInitialNotice) subtitleMenuState.hasShownInitialNotice = true;
        } else {
          setSubtitleMenuStatus(els, '', 'muted');
        }
        renderMenuFromState(els);
        subtitleMenuState.hasFetchedOnce = true;
      } catch (err) {
        setSubtitleMenuStatus(els, 'Could not load subtitles: ' + err.message, 'error', { persist: true });
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
            setSubtitleMenuStatus(els, 'Loaded ' + visibleCount + ' subtitle entr' + (visibleCount === 1 ? 'y' : 'ies') + '.');
            subtitleMenuState.hasShownInitialNotice = true;
          } else if (subtitleMenuState.hasFetchedOnce) {
            setSubtitleMenuStatus(els, 'No subtitles available for this stream yet.');
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

      resetSubtitleInventoryState();
      subtitleMenuState.items = [];
      subtitleMenuState.lastFetched = null;
      subtitleMenuState.hasFetchedOnce = false;
      subtitleMenuState.hasShownInitialNotice = false;
      renderMenuFromState(els);
      updateSubtitleMenuMeta(els);
      if (config.onTargetsHydrated) {
        config.onTargetsHydrated(config.targetOptions);
      }
      loadSubtitleInventory({ force: false }).catch(() => {});
      if (subtitleMenuState.open) {
        fetchSubtitleMenuData(els, { silent: true });
      }
    }

    injectStyles();
    const elements = createMarkup(config.labels);

    if (elements.toggle) {
      elements.toggle.addEventListener('click', () => toggleSubtitleMenu(elements));
    }
    if (elements.close) {
      elements.close.addEventListener('click', () => toggleSubtitleMenu(elements, false));
    }
    if (elements.refresh) {
      elements.refresh.addEventListener('click', () => fetchSubtitleMenuData(elements, { silent: false, force: true }));
    }
    updateSubtitleMenuMeta(elements);

    if (hasValidStream()) {
      loadSubtitleInventory({ force: false })
        .then(result => {
          hydrateTargetsFromSubtitleInventory((result && result.items) || []);
        })
        .catch(() => {});
    }

    const api = {
      refresh: (opts) => fetchSubtitleMenuData(elements, opts || { silent: false, force: true }),
      prefetch: () => loadSubtitleInventory({ force: false }).catch(() => {}),
      toggle: (open) => toggleSubtitleMenu(elements, open),
      updateStream: (payload) => handleStreamUpdate(payload, elements),
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
