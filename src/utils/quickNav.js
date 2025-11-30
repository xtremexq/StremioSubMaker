function quickNavStyles() {
  return `
    .quick-nav {
      position: sticky;
      top: 1rem;
      z-index: 10002;
      width: min(1200px, calc(100% - 32px));
      max-width: 1200px;
      margin: 1rem auto 0;
      padding: 0.75rem 1rem;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.75rem;
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
      gap: 4px;
      cursor: pointer;
      z-index: 10001;
      box-shadow: 0 3px 10px var(--shadow-color, rgba(0, 0, 0, 0.2));
      transition: all 0.3s ease;
    }

    .mobile-menu-toggle span {
      display: block;
      width: 18px;
      height: 2px;
      background: var(--text-primary);
      border-radius: 999px;
      box-shadow: 0 1px 0 rgba(0,0,0,0.1);
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

function renderQuickNav(links, activeKey, showRefreshButton = true, devMode = true) {
  const devDisabled = devMode !== true ? ' dev-disabled' : '';
  return `
  <button class="mobile-menu-toggle" id="mobileMenuToggle" aria-label="Open menu">
    <span></span>
    <span></span>
    <span></span>
  </button>
  <div class="mobile-nav-overlay" id="mobileNavOverlay"></div>
  <nav class="quick-nav" id="quickNav">
    <div class="quick-nav-links">
      ${showRefreshButton ? `<button type="button" class="quick-nav-link quick-nav-refresh" id="quickNavRefresh" title="Jump to your latest stream">
        <span class="refresh-icon">⟳</span>
        <span class="refresh-label">Refresh stream</span>
      </button>` : ''}
      <a class="quick-nav-link${activeKey === 'subToolbox' ? ' active' : ''}" href="${links.subToolbox}">
        <span>🧰</span>
        <span>Sub Toolbox</span>
      </a>
      <a class="quick-nav-link${activeKey === 'translateFiles' ? ' active' : ''}" href="${links.translateFiles}">
        <span>📂</span>
        <span>Translate files</span>
        ${activeKey === 'translateFiles' ? '<span class="pill">You are here</span>' : ''}
      </a>
      <a class="quick-nav-link${activeKey === 'embeddedSubs' ? ' active' : ''}${devDisabled}" href="${devMode ? links.embeddedSubs : '#'}">
        <span>🧲</span>
        <span>Extract Subs</span>
        ${activeKey === 'embeddedSubs' ? '<span class="pill">You are here</span>' : ''}
      </a>
      <a class="quick-nav-link${activeKey === 'syncSubtitles' ? ' active' : ''}${devDisabled}" href="${devMode ? links.syncSubtitles : '#'}">
        <span>⏱️</span>
        <span>Sync subtitles</span>
        ${activeKey === 'syncSubtitles' ? '<span class="pill">You are here</span>' : ''}
      </a>
      <a class="quick-nav-link${activeKey === 'automaticSubs' ? ' active' : ''}${devDisabled}" href="${devMode ? links.automaticSubs : '#'}">
        <span>🤖</span>
        <span>Auto subs</span>
        ${activeKey === 'automaticSubs' ? '<span class="pill">You are here</span>' : ''}
      </a>
      <a class="quick-nav-link${activeKey === 'configure' ? ' active' : ''}" href="${links.configure}">
        <span>🛠️</span>
        <span>Configure</span>
      </a>
    </div>
  </nav>
  `;
}

function quickNavScript() {
  return `
    window.initStreamRefreshButton = window.initStreamRefreshButton || function(opts) {
      const btn = document.getElementById(opts.buttonId);
      if (!btn || !opts.configStr || typeof fetch === 'undefined') return;
      const labelEl = btn.querySelector('.refresh-label');
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
      const configStr = opts.configStr;
      const buildUrl = typeof opts.buildUrl === 'function' ? opts.buildUrl : null;

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
      const POLL_INTERVAL_MS = Math.max(300000, Number(opts.pollIntervalMs) || 300000); // 5 minutes
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
        return tag ? `${base} ${tag}` : (base || 'New stream detected');
      }

      let lastMetaRequestKey = '';
      async function enhanceMeta(payload) {
        if (!metaEl || !payload || !payload.videoId) return;
        const parsed = parseVideoId(payload.videoId);
        if (!parsed?.imdbId) return;
        const metaType = parsed.type === 'episode' ? 'series' : 'movie';
        const tag = formatEpisodeTag(parsed);
        const requestKey = `${parsed.imdbId}:${metaType}:${tag}`;
        lastMetaRequestKey = requestKey;
        try {
          const resp = await fetch('https://v3-cinemeta.strem.io/meta/' + metaType + '/' + encodeURIComponent(parsed.imdbId) + '.json', { cache: 'force-cache' });
          if (!resp.ok) return;
          const data = await resp.json();
          const meta = data && data.meta;
          const name = meta?.name || meta?.english_name || (meta?.nameTranslated && meta.nameTranslated.en);
          if (!name || lastMetaRequestKey !== requestKey) return;
          const label = tag ? `${name} ${tag}` : name;
          metaEl.textContent = label;
        } catch (_) { /* ignore */ }
      }

      function showToast(payload) {
        if (titleEl) titleEl.textContent = opts.labels?.title || 'New stream detected';
        if (metaEl) {
          metaEl.textContent = describe(payload);
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
        if (!force && rec && rec.id !== tabId && ownerIsFresh(rec)) {
          return false;
        }
        isOwner = true;
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

      async function pollOnce() {
        if (!isOwner && channel) return;
        try {
          const resp = await fetch('/api/stream-activity?config=' + encodeURIComponent(configStr), { cache: 'no-store' });
          if (!resp.ok || resp.status === 204) return;
          const data = await resp.json();
          handleEpisode(data);
          broadcastEpisode(data);
        } catch (_) {
          // ignore
        } finally {
          pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
        }
      }

      function startSse() {
        if (!isOwner && channel) return;
        if (es) return;
        try {
          if (sseRetryTimer) clearTimeout(sseRetryTimer);
          es = new EventSource('/api/stream-activity?config=' + encodeURIComponent(configStr));

          es.addEventListener('episode', (ev) => {
            try {
              sseRetryCount = 0;
              const data = JSON.parse(ev.data);
              handleEpisode(data);
              broadcastEpisode(data);
            } catch (_) {}
          });

          es.addEventListener('open', () => {
            sseRetryCount = 0;
            if (pollTimer) {
              clearTimeout(pollTimer);
              pollTimer = null;
            }
          });

          es.addEventListener('error', () => {
            try { es.close(); } catch (_) {}
            es = null;

            if (sseRetryCount < MAX_SSE_RETRIES) {
              const delay = Math.min(1000 * Math.pow(2, sseRetryCount), 30000);
              sseRetryCount++;
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
        try { localStorage.removeItem(ownerKey); } catch (_) {}
      }

      window.addEventListener('beforeunload', () => {
        try { es?.close(); } catch (_) {}
        if (pollTimer) clearTimeout(pollTimer);
        if (sseRetryTimer) clearTimeout(sseRetryTimer);
        if (ownerLeaseTimer) clearInterval(ownerLeaseTimer);
        releaseOwner();
      });
      window.addEventListener('pagehide', releaseOwner);

      if (!channel) {
        // No broadcast channel support: every tab owns its own connection
        startSse();
      }
    };

    (function() {
      const quickNav = document.getElementById('quickNav');
      const mobileMenuToggle = document.getElementById('mobileMenuToggle');
      const mobileNavOverlay = document.getElementById('mobileNavOverlay');

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
            if (window.innerWidth <= 768) closeMobileNav();
          });
        });
      }

      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeMobileNav();
      });

      window.addEventListener('resize', () => {
        if (window.innerWidth > 768) closeMobileNav();
      });
    })();
  `;
}

function renderRefreshBadge() {
  return `
    <button type="button" class="quick-nav-link quick-nav-refresh" id="quickNavRefresh" title="Jump to your latest stream">
      <span class="refresh-icon">⟳</span>
      <span class="refresh-label">Refresh stream</span>
    </button>
  `;
}

module.exports = {
  quickNavStyles,
  quickNavScript,
  renderQuickNav,
  renderRefreshBadge
};
