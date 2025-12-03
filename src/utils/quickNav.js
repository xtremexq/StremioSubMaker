function quickNavStyles() {
  return `
    .quick-nav {
      position: sticky;
      top: 2rem;
      z-index: 10002;
      width: min(1180px, calc(100% - 56px));
      max-width: 1180px;
      margin: 1.25rem auto 0;
      padding: 0.65rem 0.85rem;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.65rem;
      background: linear-gradient(135deg, rgba(8, 164, 213, 0.12) 0%, rgba(51, 185, 225, 0.12) 100%);
      border: 1px solid var(--border);
      border-radius: 14px;
      box-shadow: 0 10px 26px var(--shadow-color, rgba(0, 0, 0, 0.08));
      backdrop-filter: blur(10px);
      flex-wrap: nowrap;
      overflow-x: auto;
      overflow-y: hidden;
      -ms-overflow-style: none;
      scrollbar-width: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
      font-size: 0.95rem;
    }
    .quick-nav::-webkit-scrollbar { display: none; }

    .quick-nav-links {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: nowrap;
      justify-content: center;
      flex: 1;
    }

    .quick-nav-link {
      display: inline-flex;
      align-items: center;
      gap: 0.55rem;
      padding: 0.65rem 1rem;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text-primary);
      text-decoration: none;
      font-weight: 600;
      transition: all 0.25s ease;
      box-shadow: 0 6px 18px var(--shadow-color, rgba(0, 0, 0, 0.08));
      white-space: nowrap;
      flex-shrink: 0;
      font-size: inherit;
      cursor: pointer;
    }
    .quick-nav-link.quick-nav-refresh {
      position: relative;
      background: radial-gradient(140% 140% at 18% 18%, rgba(8, 164, 213, 0.28), transparent 46%), linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
      color: #0b2336;
      font-weight: 800;
      border: 1px solid rgba(255, 255, 255, 0.22);
      box-shadow: 0 12px 26px rgba(8, 164, 213, 0.22), 0 6px 16px var(--shadow-color, rgba(0, 0, 0, 0.1));
      padding: 0;
      gap: 0;
      cursor: pointer;
      width: 52px;
      height: 52px;
      border-radius: 14px;
      overflow: hidden;
      isolation: isolate;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .quick-nav-link.quick-nav-refresh::before {
      content: '';
      position: absolute;
      inset: -40%;
      background: conic-gradient(from 140deg, rgba(255,255,255,0.26), rgba(255,255,255,0), rgba(255,255,255,0.26), rgba(255,255,255,0));
      opacity: 0.7;
      animation: spin 9s linear infinite;
      z-index: 0;
    }
    .quick-nav-link.quick-nav-refresh::after {
      content: '';
      position: absolute;
      inset: 7px;
      border-radius: 10px;
      background: radial-gradient(circle at 26% 22%, rgba(255,255,255,0.25), rgba(255,255,255,0.05));
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.12), inset 0 -6px 14px rgba(0, 0, 0, 0.18);
      z-index: 0;
    }
    .quick-nav-link.quick-nav-refresh .refresh-icon {
      position: relative;
      z-index: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border-radius: 11px;
      background: radial-gradient(130% 130% at 25% 22%, rgba(255,255,255,0.55), transparent 45%), linear-gradient(135deg, #ffffff 0%, #d9ecff 100%);
      color: #0b2840;
      box-shadow: inset 0 -3px 8px rgba(0, 0, 0, 0.2), 0 8px 14px rgba(0, 0, 0, 0.16);
      font-weight: 900;
      font-size: 17px;
      text-shadow: 0 1px 0 rgba(255,255,255,0.4);
      letter-spacing: -0.04em;
    }
    .quick-nav-link.quick-nav-refresh .refresh-label {
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
    .quick-nav-link.quick-nav-refresh.spinning .refresh-icon { animation: spin 0.75s linear infinite; }

    .quick-nav-link:hover {
      transform: translateY(-2px);
      border-color: var(--primary);
      box-shadow: 0 10px 24px var(--glow);
    }

    .quick-nav-link.active {
      background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
      color: #ffffff;
      border-color: transparent;
      box-shadow: 0 10px 24px var(--glow);
    }

    .quick-nav-link.dev-disabled {
      opacity: 0.35;
      pointer-events: none;
      cursor: not-allowed;
      filter: grayscale(0.8);
    }

    .quick-nav-link.dev-disabled:hover {
      transform: none;
      border-color: var(--border);
      box-shadow: 0 6px 18px var(--shadow-color, rgba(0, 0, 0, 0.08));
    }

    .quick-nav-link .pill {
      font-size: 0.8rem;
      padding: 0.25rem 0.55rem;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.16);
      border: 1px solid rgba(255, 255, 255, 0.24);
      color: inherit;
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
      flex-direction: column;
      gap: 6px;
      padding: 10px;
      cursor: pointer;
      z-index: 10001;
      box-shadow: 0 3px 10px var(--shadow-color, rgba(0, 0, 0, 0.2));
      transition: all 0.3s ease;
    }

    .mobile-menu-toggle span {
      display: block;
      width: 22px;
      height: 3px;
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

    /* Form controls baseline (shared across tool pages) */
    select, textarea, input[type="text"], input[type="file"], input[type="number"] {
      background-color: var(--surface-2);
      color: var(--text);
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    select:focus, textarea:focus, input[type="text"]:focus, input[type="file"]:focus, input[type="number"]:focus {
      background-color: var(--surface);
      color: var(--text);
    }

    html.no-scroll, body.no-scroll {
      overflow: hidden;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    @media (max-width: 1600px) {
      .quick-nav {
        width: min(1120px, calc(100% - 48px));
        padding: 0.6rem 0.75rem;
        gap: 0.6rem;
        font-size: 0.92rem;
      }
      .quick-nav-links { gap: 0.55rem; }
      .quick-nav-link { padding: 0.55rem 0.95rem; }
      .quick-nav-link.quick-nav-refresh { width: 50px; height: 50px; }
    }

    @media (max-width: 1280px) {
      .quick-nav {
        width: min(1040px, calc(100% - 44px));
        padding: 0.55rem 0.7rem;
        gap: 0.5rem;
        font-size: 0.88rem;
      }
      .quick-nav-links { gap: 0.45rem; }
      .quick-nav-link { padding: 0.5rem 0.85rem; }
      .quick-nav-link .pill { font-size: 0.78rem; }
      .quick-nav-link.quick-nav-refresh { width: 46px; height: 46px; }
    }

    @media (max-width: 1100px) {
      .mobile-menu-toggle { display: inline-flex !important; }

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

      .quick-nav.open { transform: translateX(0); }

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
    }
  `;
}

function renderQuickNav(links, activeKey, showRefreshButton = true, devMode = true, t = (k, vars, fallback) => fallback || k) {
  const devDisabled = devMode !== true ? ' dev-disabled' : '';
  const label = (key, fallback, vars) => t(`nav.${key}`, vars || {}, fallback);
  const mobileMenuLabel = label('mobileMenu', 'Open menu');
  return `
  <button class="mobile-menu-toggle" id="mobileMenuToggle" aria-label="${mobileMenuLabel}" title="${mobileMenuLabel}">
    <span></span>
    <span></span>
    <span></span>
  </button>
  <div class="mobile-nav-overlay" id="mobileNavOverlay"></div>
  <nav class="quick-nav" id="quickNav">
    <div class="quick-nav-links">
      ${showRefreshButton ? `<button type="button" class="quick-nav-link quick-nav-refresh" id="quickNavRefresh" title="${label('refreshTitle', 'Jump to your latest stream')}">
        <span class="refresh-icon">⟳</span>
        <span class="refresh-label">${label('refresh', 'Refresh stream')}</span>
      </button>` : ''}
      <a class="quick-nav-link${activeKey === 'subToolbox' ? ' active' : ''}" href="${links.subToolbox}">
        <span>🧰</span>
        <span>${label('subToolbox', 'Sub Toolbox')}</span>
      </a>
      <a class="quick-nav-link${activeKey === 'translateFiles' ? ' active' : ''}" href="${links.translateFiles}">
        <span>📂</span>
        <span>${label('translateFiles', 'Translate files')}</span>
        ${activeKey === 'translateFiles' ? `<span class="pill">${label('youAreHere', 'You are here')}</span>` : ''}
      </a>
      <a class="quick-nav-link${activeKey === 'embeddedSubs' ? ' active' : ''}${devDisabled}" href="${devMode ? links.embeddedSubs : '#'}">
        <span>🧲</span>
        <span>${label('embeddedSubs', 'Extract Subs')}</span>
        ${activeKey === 'embeddedSubs' ? `<span class="pill">${label('youAreHere', 'You are here')}</span>` : ''}
      </a>
      <a class="quick-nav-link${activeKey === 'syncSubtitles' ? ' active' : ''}${devDisabled}" href="${devMode ? links.syncSubtitles : '#'}">
        <span>⏱️</span>
        <span>${label('syncSubtitles', 'Sync subtitles')}</span>
        ${activeKey === 'syncSubtitles' ? `<span class="pill">${label('youAreHere', 'You are here')}</span>` : ''}
      </a>
      <a class="quick-nav-link${activeKey === 'automaticSubs' ? ' active' : ''}${devDisabled}" href="${devMode ? links.automaticSubs : '#'}">
        <span>🤖</span>
        <span>${label('automaticSubs', 'Auto subs')}</span>
        ${activeKey === 'automaticSubs' ? `<span class="pill">${label('youAreHere', 'You are here')}</span>` : ''}
      </a>
      <a class="quick-nav-link${activeKey === 'configure' ? ' active' : ''}" href="${links.configure}">
        <span>🛠️</span>
        <span>${label('configure', 'Configure')}</span>
      </a>
    </div>
  </nav>
  `;
}

function quickNavScript() {
  return `
    function quickNavTranslate(customT) {
      const base = (typeof customT === 'function') ? customT : (typeof window !== 'undefined' && typeof window.t === 'function' ? window.t : null);
      return function(key, vars, fallback) {
        try {
          if (base) return base(key, vars || {}, fallback || key);
        } catch (_) { /* ignore translation errors */ }
        return fallback || key;
      };
    }

    window.initStreamRefreshButton = window.initStreamRefreshButton || function(opts) {
      const btn = document.getElementById(opts.buttonId);
      if (!btn || !opts.configStr || typeof fetch === 'undefined') return;
      const labelEl = btn.querySelector('.refresh-label');
      const t = quickNavTranslate(opts && opts.t);
      const defaultLabel = labelEl ? labelEl.textContent : t('nav.refresh', {}, 'Refresh stream');
      const labels = {
        loading: (opts.labels && opts.labels.loading) || t('nav.refreshLoading', {}, 'Refreshing...'),
        empty: (opts.labels && opts.labels.empty) || t('nav.refreshEmpty', {}, 'No recent stream'),
        current: (opts.labels && opts.labels.current) || t('nav.refreshCurrent', {}, 'Already current'),
        error: (opts.labels && opts.labels.error) || t('nav.refreshError', {}, 'Refresh failed'),
        missing: (opts.labels && opts.labels.missing) || t('nav.refreshMissing', {}, 'Missing stream data')
      };
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
        setLabel(labels.loading);
        try {
          const resp = await fetch('/api/stream-activity?config=' + encodeURIComponent(opts.configStr), { cache: 'no-store' });
          if (resp.status === 204) {
            setLabel(labels.empty);
            return;
          }
          if (!resp.ok) throw new Error('Bad response');
          const data = await resp.json();
          const payloadSig = [data.videoHash || '', data.videoId || '', data.filename || ''].join('::');
          if (!data || !data.videoId || !payloadSig.trim()) {
            setLabel(labels.empty);
            return;
          }
          if (payloadSig === currentSig) {
            setLabel(labels.current);
            setTimeout(() => setLabel(defaultLabel), 1200);
            return;
          }
          const targetUrl = opts.buildUrl ? opts.buildUrl(data) : null;
          if (targetUrl) {
            btn.classList.add('success');
            window.location.href = targetUrl;
            return;
          }
          setLabel(labels.missing);
        } catch (_) {
          setLabel(labels.error);
        } finally {
          setTimeout(() => setLabel(defaultLabel), 1400);
          setBusy(false);
        }
      });
    };

    window.initStreamWatcher = window.initStreamWatcher || function(opts = {}) {
      const toast = document.getElementById(opts.toastId || 'episodeToast');
      const titleEl = document.getElementById(opts.titleId || 'episodeToastTitle');
      const metaEl = document.getElementById(opts.metaId || 'episodeToastMeta');
      const updateBtn = document.getElementById(opts.updateId || 'episodeToastUpdate');
      const dismissBtn = document.getElementById(opts.dismissId || 'episodeToastDismiss');
      if (!toast || !updateBtn || !opts.configStr) return;

      const current = {
        videoId: opts.current?.videoId || '',
        filename: opts.current?.filename || '',
        videoHash: opts.current?.videoHash || ''
      };
      const t = quickNavTranslate(opts && opts.t);
      const configStr = opts.configStr;
      const buildUrl = typeof opts.buildUrl === 'function' ? opts.buildUrl : null;
      const notify = typeof opts.notify === 'function' ? opts.notify : null;

      let latest = null;
      let es = null;
      let pollTimer = null;
      let pollErrorStreak = 0;
      let sseRetryTimer = null;
      let sseRetryCount = 0;
      let sseCooldownUntil = 0;
      let sseProbeTimer = null;
      let currentSig = '';
      let lastSig = '';
      let hasBaseline = false;
      let lastSeenTs = Date.now();
      let staleCheckTimer = null;
      const MAX_SSE_RETRIES = 5;
      const POLL_INTERVAL_MS = Math.max(15000, Number(opts.pollIntervalMs) || 15000); // Faster fallback when SSE is blocked
      const POLL_BACKOFF_MAX_MS = 60000;
      const POLL_ERROR_STREAK_CAP = 6;
      const STALE_BACKSTOP_MS = Math.max(20000, Number(opts.staleBackstopMs) || 30000); // Force a poll if nothing arrives for ~30s
      const SSE_PROBE_TIMEOUT_MS = 4000; // If no event arrives quickly, assume SSE is blocked
      const SSE_COOLDOWN_MS = 10 * 60 * 1000; // Wait before retrying SSE after repeated failures
      const OWNER_TTL_MS = 45000; // quicker failover if the owning tab closes
      const OWNER_REFRESH_MS = 20000;
      const configSig = (() => {
        try {
          let hash = 0;
          const str = String(configStr || '');
          for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
          }
          return Math.abs(hash).toString(36);
        } catch (_) {
          return 'default';
        }
      })();
      const channelName = 'submaker-stream-' + configSig;
      const ownerKey = 'submaker-stream-owner-' + configSig;
      const tabId = Date.now() + '-' + Math.random().toString(16).slice(2);
      const GLOBAL_OWNER_KEY = '__submakerStreamOwners__';
      const globalOwners = (() => {
        try {
          if (!window[GLOBAL_OWNER_KEY]) window[GLOBAL_OWNER_KEY] = {};
          return window[GLOBAL_OWNER_KEY];
        } catch (_) {
          return {};
        }
      })();
      const hasBroadcast = typeof BroadcastChannel === 'function';
      const channel = hasBroadcast ? new BroadcastChannel(channelName) : null;
      let isOwner = false;
      let ownerLeaseTimer = null;

      function buildSignature(payload) {
        if (!payload) return '';
        const parts = [
          payload.videoHash || '',
          payload.videoId || '',
          payload.filename || ''
        ];
        return parts.join('::');
      }

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

      function describe(payload) {
        const parsed = parseVideoId(payload.videoId);
        const tag = formatEpisodeTag(parsed);
        const base = cleanName(payload.filename) || parsed?.imdbId || payload.videoId;
        return tag ? (base + ' ' + tag) : (base || t('nav.streamDetected', {}, 'New stream detected'));
      }

      let lastMetaRequestKey = '';
      async function enhanceMeta(payload) {
        if (!metaEl || !payload || !payload.videoId) return;
        const parsed = parseVideoId(payload.videoId);
        if (!parsed?.imdbId) return;
        const metaType = parsed.type === 'episode' ? 'series' : 'movie';
        const tag = formatEpisodeTag(parsed);
        const requestKey = parsed.imdbId + ':' + metaType + ':' + tag;
        lastMetaRequestKey = requestKey;
        try {
          const resp = await fetch('https://v3-cinemeta.strem.io/meta/' + metaType + '/' + encodeURIComponent(parsed.imdbId) + '.json', { cache: 'force-cache' });
          if (!resp.ok) return;
          const data = await resp.json();
          const meta = data && data.meta;
          const name = meta?.name || meta?.english_name || (meta?.nameTranslated && meta.nameTranslated.en);
          if (!name || lastMetaRequestKey !== requestKey) return;
          const label = tag ? (name + ' ' + tag) : name;
          metaEl.textContent = label;
        } catch (_) { /* ignore */ }
      }

      function showToast(payload) {
        const description = describe(payload);
        const titleText = opts.labels?.title || t('nav.streamDetected', {}, 'New stream detected');
        if (notify) {
          const handled = notify({
            title: titleText,
            message: description,
            payload,
            updateUrl: buildUrl ? buildUrl(payload) : null
          });
          if (handled === true) return;
        }
        if (titleEl) titleEl.textContent = titleText;
        if (metaEl) {
          metaEl.textContent = description;
          enhanceMeta(payload);
        }
        toast.classList.add('show');
      }

      currentSig = buildSignature(current);
      lastSig = currentSig;

      function broadcastEpisode(payload) {
        if (!payload) return;
        if (channel) {
          try { channel.postMessage({ type: 'episode', payload }); } catch (_) {}
        }
        try {
          localStorage.setItem(channelName + '-evt', JSON.stringify({ payload, ts: Date.now() }));
        } catch (_) { /* ignore */ }
      }

      function readOwner() {
        try {
          const raw = localStorage.getItem(ownerKey);
          return raw ? JSON.parse(raw) : null;
        } catch (_) {
          return null;
        }
      }

      function ownerIsFresh(rec) {
        if (!rec) return false;
        const ts = Number(rec.ts || 0);
        return ts && (Date.now() - ts) < OWNER_TTL_MS;
      }

      function refreshOwnerLease() {
        if (!isOwner) return;
        try { localStorage.setItem(ownerKey, JSON.stringify({ id: tabId, ts: Date.now() })); } catch (_) {}
        if (ownerLeaseTimer) return;
        ownerLeaseTimer = setInterval(() => {
          if (isOwner) {
            try { localStorage.setItem(ownerKey, JSON.stringify({ id: tabId, ts: Date.now() })); } catch (_) {}
          }
        }, OWNER_REFRESH_MS);
      }

      function becomeOwner(force = false) {
        if (isOwner) return true;
        const rec = readOwner();
        const globalOwner = globalOwners[configSig];
        if (!force && globalOwner && globalOwner !== tabId) {
          return false;
        }
        if (!force && rec && rec.id !== tabId && ownerIsFresh(rec)) {
          return false;
        }
        isOwner = true;
        try { globalOwners[configSig] = tabId; } catch (_) {}
        try { localStorage.setItem(ownerKey, JSON.stringify({ id: tabId, ts: Date.now() })); } catch (_) {}
        refreshOwnerLease();
        startSse();
        return true;
      }

      function ensureOwner() {
        if (isOwner) return;
        const rec = readOwner();
        if (!ownerIsFresh(rec)) {
          becomeOwner(true);
        }
      }

      if (channel) {
        channel.onmessage = (ev) => {
          if (!ev || !ev.data) return;
          if (ev.data.type === 'episode') {
            handleEpisode(ev.data.payload);
          }
        };
      }

      window.addEventListener('storage', (e) => {
        if (!e) return;
        if (e.key === channelName + '-evt' && e.newValue) {
          try {
            const parsed = JSON.parse(e.newValue);
            if (parsed && parsed.payload) handleEpisode(parsed.payload);
          } catch (_) {}
        }
      });

      // Attempt to become owner on load if none is fresh
      becomeOwner(false);
      // Owner tab holds the live connection; other tabs listen via BroadcastChannel/storage events
      // Fallback: periodically re-check if owner disappeared
      setInterval(() => ensureOwner(), OWNER_REFRESH_MS);

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
        if (typeof opts.onEpisode === 'function') {
          try { opts.onEpisode(payload); } catch (_) {}
        }
        showToast(payload);
      }

      updateBtn.addEventListener('click', () => {
        if (!latest || !latest.videoId) return;
        const url = buildUrl ? buildUrl(latest) : null;
        if (url) window.location.href = url;
      });

      if (dismissBtn) {
        dismissBtn.addEventListener('click', () => {
          toast.classList.remove('show');
          latest = null;
        });
      }

      async function pollOnce(force = false) {
        const shouldOwnConnection = isOwner || !channel;
        if (!shouldOwnConnection && !force) return;
        const isStale = (Date.now() - lastSeenTs) > STALE_BACKSTOP_MS;
        try {
          const resp = await fetch('/api/stream-activity?config=' + encodeURIComponent(configStr), { cache: 'no-store' });
          if (!resp.ok || resp.status === 204) {
            pollErrorStreak = Math.min(pollErrorStreak + 1, POLL_ERROR_STREAK_CAP);
            return;
          }
          const data = await resp.json();
          pollErrorStreak = 0;
          handleEpisode(data);
          broadcastEpisode(data);
        } catch (_) {
          pollErrorStreak = Math.min(pollErrorStreak + 1, POLL_ERROR_STREAK_CAP);
        } finally {
          const baseDelay = (force || isStale) ? Math.min(POLL_INTERVAL_MS, STALE_BACKSTOP_MS) : POLL_INTERVAL_MS;
          const delay = Math.min(
            POLL_BACKOFF_MAX_MS,
            baseDelay * Math.max(1, Math.pow(2, pollErrorStreak))
          );
          if (shouldOwnConnection) {
            pollTimer = setTimeout(() => pollOnce(false), delay);
          }
        }
      }

      function startSse() {
        const shouldOwnConnection = isOwner || !channel;
        if (!shouldOwnConnection) return;
        const now = Date.now();
        if (now < sseCooldownUntil) return;
        if (es) return;
        try {
          if (sseRetryTimer) clearTimeout(sseRetryTimer);
          if (sseProbeTimer) clearTimeout(sseProbeTimer);

          let sseReady = false;
          const markReady = () => {
            sseReady = true;
            sseRetryCount = 0;
            pollErrorStreak = 0;
            if (sseProbeTimer) {
              clearTimeout(sseProbeTimer);
              sseProbeTimer = null;
            }
            if (pollTimer) {
              clearTimeout(pollTimer);
              pollTimer = null;
            }
          };

          es = new EventSource('/api/stream-activity?config=' + encodeURIComponent(configStr));

          sseProbeTimer = setTimeout(() => {
            if (sseReady) return;
            try { es?.close(); } catch (_) {}
            es = null;
            sseCooldownUntil = Date.now() + SSE_COOLDOWN_MS;
            pollOnce(true);
          }, SSE_PROBE_TIMEOUT_MS);

          es.addEventListener('ready', () => {
            markReady();
          });

          es.addEventListener('ping', () => {
            markReady();
          });

          es.addEventListener('episode', (ev) => {
            try {
              markReady();
              const data = JSON.parse(ev.data);
              handleEpisode(data);
              broadcastEpisode(data);
            } catch (_) {}
          });

          es.addEventListener('open', () => {
            markReady();
          });

          es.addEventListener('error', () => {
            if (sseProbeTimer) {
              clearTimeout(sseProbeTimer);
              sseProbeTimer = null;
            }
            try { es.close(); } catch (_) {}
            es = null;

            if (!sseReady && sseRetryCount >= 2) {
              sseCooldownUntil = Date.now() + SSE_COOLDOWN_MS;
              pollOnce(true);
              return;
            }
            sseRetryCount++;

            if (sseRetryCount < MAX_SSE_RETRIES) {
              // Backoff starting at 5s to avoid rapid reconnect spam
              const delay = Math.min(5000 * Math.pow(2, sseRetryCount), 30000);
              sseRetryTimer = setTimeout(startSse, delay);
            } else {
              pollOnce();
            }
          });
        } catch (_) {
          pollOnce();
        }
      }

      function releaseOwner() {
        if (!isOwner) return;
        try {
          if (globalOwners[configSig] === tabId) delete globalOwners[configSig];
        } catch (_) {}
        try { localStorage.removeItem(ownerKey); } catch (_) {}
      }

      window.addEventListener('beforeunload', () => {
        try { es?.close(); } catch (_) {}
        if (pollTimer) clearTimeout(pollTimer);
        if (sseRetryTimer) clearTimeout(sseRetryTimer);
        if (sseProbeTimer) clearTimeout(sseProbeTimer);
        if (ownerLeaseTimer) clearInterval(ownerLeaseTimer);
        if (staleCheckTimer) clearInterval(staleCheckTimer);
        releaseOwner();
      });
      window.addEventListener('pagehide', releaseOwner);

      if (!channel) {
        // No broadcast channel support: every tab owns its own connection
        startSse();
      }

      // Backstop: if SSE/broadcast is blocked, force a quick poll so we still surface updates
      staleCheckTimer = setInterval(() => {
        const isStale = (Date.now() - lastSeenTs) > STALE_BACKSTOP_MS;
        if (isStale) {
          pollOnce(true);
        }
      }, Math.min(STALE_BACKSTOP_MS, POLL_INTERVAL_MS));
    };

    (function() {
      const quickNav = document.getElementById('quickNav');
      const mobileMenuToggle = document.getElementById('mobileMenuToggle');
      const mobileNavOverlay = document.getElementById('mobileNavOverlay');
      const MOBILE_BREAKPOINT = 1100;

      const closeMobileNav = () => {
        if (quickNav) quickNav.classList.remove('open');
        if (mobileNavOverlay) mobileNavOverlay.classList.remove('show');
        document.documentElement.classList.remove('no-scroll');
        document.body.classList.remove('no-scroll');
      };

      const openMobileNav = () => {
        if (quickNav) quickNav.classList.add('open');
        if (mobileNavOverlay) mobileNavOverlay.classList.add('show');
        document.documentElement.classList.add('no-scroll');
        document.body.classList.add('no-scroll');
      };

      if (mobileMenuToggle) {
        mobileMenuToggle.addEventListener('click', () => {
          const isOpen = quickNav && quickNav.classList.contains('open');
          if (isOpen) closeMobileNav(); else openMobileNav();
        });
      }

      if (mobileNavOverlay) {
        mobileNavOverlay.addEventListener('click', closeMobileNav);
      }

      if (quickNav) {
        quickNav.querySelectorAll('a').forEach(link => {
          link.addEventListener('click', () => {
            if (window.innerWidth <= MOBILE_BREAKPOINT) closeMobileNav();
          });
        });
      }

      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeMobileNav();
      });

      window.addEventListener('resize', () => {
        if (window.innerWidth > MOBILE_BREAKPOINT) closeMobileNav();
      });
    })();
  `;
}

function renderRefreshBadge(t = (k, vars, fallback) => fallback || k) {
  const label = (key, fallback, vars) => t(`nav.${key}`, vars || {}, fallback);
  return `
    <button type="button" class="quick-nav-link quick-nav-refresh" id="quickNavRefresh" title="${label('refreshTitle', 'Jump to your latest stream')}">
      <span class="refresh-icon">⟳</span>
      <span class="refresh-label">${label('refresh', 'Refresh stream')}</span>
    </button>
  `;
}

module.exports = {
  quickNavStyles,
  quickNavScript,
  renderQuickNav,
  renderRefreshBadge
};
