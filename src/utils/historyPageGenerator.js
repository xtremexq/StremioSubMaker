const { getLanguageName } = require('./languages');
const { version: appVersion } = require('../../package.json');
const { quickNavStyles, quickNavScript, renderQuickNav } = require('./quickNav');
const { buildClientBootstrap, loadLocale, getTranslator } = require('./i18n');

function buildQuery(params) {
  const entries = Object.entries(params || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (!entries.length) return '';
  const query = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return query ? `?${query}` : '';
}

function escapeHtml(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function truncateText(value, max = 64) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (!raw) return '';
  if (raw.length <= max) return raw;
  if (max <= 3) return raw.slice(0, max);
  return `${raw.slice(0, max - 3)}...`;
}

function resolveUiLang(config) {
  const lang = (config && config.uiLanguage) ? String(config.uiLanguage).toLowerCase() : 'en';
  return escapeHtml(lang || 'en');
}

function themeToggleMarkup(label) {
  // Reusing existing theme toggle markup
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
  const query = buildQuery({
    config: configStr,
    videoId: videoId || 'Stream and Refresh',
    filename: filename || 'Stream and Refresh'
  });
  return {
    translateFiles: `/file-upload${query}`,
    syncSubtitles: `/subtitle-sync${query}`,
    embeddedSubs: `/embedded-subtitles${query}`,
    automaticSubs: `/auto-subtitles${query}`,
    subToolbox: `/sub-toolbox${query}`,
    smdb: `/smdb${query}`,
    configure: `/configure${query}`,
    history: `/sub-history${query}`
  };
}

function generateHistoryPage(configStr, historyEntries, config, videoId, filename) {
  const links = buildToolLinks(configStr, videoId, filename);
  const t = getTranslator(config?.uiLanguage || 'en');
  const devMode = (config || {}).devMode === true;
  const themeToggleLabel = t('fileUpload.themeToggle', {}, 'Toggle theme');
  const localeBootstrap = buildClientBootstrap(loadLocale(config?.uiLanguage || 'en'));

  // Sort history: newest first
  const sortedHistory = [...(historyEntries || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const historyRows = sortedHistory.map(entry => {
    const statusClass = entry.status === 'completed' ? 'success' : (entry.status === 'failed' ? 'error' : 'processing');
    const statusLabel = entry.status === 'completed'
      ? t('history.status.completed', {}, 'Completed')
      : (entry.status === 'failed'
        ? t('history.status.failed', {}, 'Failed')
        : t('history.status.processing', {}, 'Processing'));
    const dateStr = new Date(entry.createdAt).toLocaleString();
    const sourceName = getLanguageName(entry.sourceLanguage) || entry.sourceLanguage || 'Auto';
    const targetName = getLanguageName(entry.targetLanguage) || entry.targetLanguage;

    const providerLabel = entry.provider ? escapeHtml(entry.provider) : 'Unknown';
    const modelLabel = entry.model ? escapeHtml(entry.model) : 'Default';
    const cacheLabel = entry.cached === true
      ? `<span class="history-chip cached">${t('history.cachedLabel', {}, 'Cached')}</span>`
      : '';

    // --- Translation diagnostics (Tier 1-3) ---
    // Tier 1: Critical diagnostics
    //
    // Main provider diagnostics
    const rateLimitChip = (typeof entry.rateLimitErrors === 'number' && entry.rateLimitErrors > 0)
      ? `<span class="history-chip danger" title="Rate limit (429) errors encountered during main provider retries">429 ×${entry.rateLimitErrors}</span>`
      : '';
    const keyRotationChip = (typeof entry.keyRotationRetries === 'number' && entry.keyRotationRetries > 0)
      ? `<span class="history-tag" style="border-color:var(--provider-main-border);color:var(--provider-main);background:var(--provider-main-bg)" title="API key rotations during translation">🔑 ${entry.keyRotationRetries} rotation${entry.keyRotationRetries > 1 ? 's' : ''}</span>`
      : '';
    const errorTypePills = Array.isArray(entry.errorTypes) && entry.errorTypes.length > 0
      ? entry.errorTypes.map(et => `<span class="history-tag error-type" title="Error type encountered on the main provider">${escapeHtml(et)}</span>`).join('')
      : '';
    // Whether main provider had any diagnostic chips worth grouping
    const hasMainDiagnostics = !!(rateLimitChip || keyRotationChip || errorTypePills);

    // Secondary provider diagnostics
    const hasSecondary = entry.usedSecondaryProvider === true;
    const secondaryName = escapeHtml(entry.secondaryProviderName || 'fallback');
    const secondaryChip = hasSecondary
      ? (() => {
        const primaryReason = entry.primaryFailureReason
          ? `: ${escapeHtml(String(entry.primaryFailureReason).slice(0, 120))}`
          : '';
        return `<span class="history-chip secondary-warning" title="Primary provider failed${primaryReason}. Secondary (${secondaryName}) was used as fallback.">⚠ Secondary: ${secondaryName}</span>`;
      })()
      : '';
    // Secondary error types (errors from the secondary provider itself)
    const secondaryErrorTypePills = Array.isArray(entry.secondaryErrorTypes) && entry.secondaryErrorTypes.length > 0
      ? entry.secondaryErrorTypes.map(et => `<span class="history-tag secondary-error-type" title="Error type encountered on the secondary provider">${escapeHtml(et)}</span>`).join('')
      : '';
    // Secondary provider failure reason (shown only when secondary also failed)
    const secondaryFailedChip = entry.secondaryFailureReason
      ? (() => {
        const reason = escapeHtml(String(entry.secondaryFailureReason).slice(0, 120));
        return `<span class="history-chip secondary-danger" title="Secondary provider also failed: ${reason}">✕ Also failed: ${escapeHtml(String(entry.secondaryFailureReason).slice(0, 48))}${entry.secondaryFailureReason.length > 48 ? '…' : ''}</span>`;
      })()
      : '';
    const hasSecondaryDiagnostics = !!(secondaryErrorTypePills || secondaryFailedChip);

    // Tier 2: Quality/performance
    const mismatchChip = entry.mismatchDetected === true
      ? `<span class="history-chip warning" title="AI returned wrong entry count, recovery attempted">⚠ Mismatch: ${entry.missingEntries || 0} missing, ${entry.recoveredEntries || 0} recovered</span>`
      : '';
    const entryCountTag = (typeof entry.entryCount === 'number' && entry.entryCount > 0)
      ? `<span class="history-tag">${entry.entryCount} entries</span>`
      : '';
    const durationTag = (() => {
      if (!entry.createdAt || !entry.completedAt) return '';
      const ms = entry.completedAt - entry.createdAt;
      if (ms <= 0) return '';
      const secs = Math.floor(ms / 1000);
      if (secs < 60) return `<span class="history-tag" title="Translation duration">⏱ ${secs}s</span>`;
      const mins = Math.floor(secs / 60);
      const remSecs = secs % 60;
      return `<span class="history-tag" title="Translation duration">⏱ ${mins}m ${remSecs}s</span>`;
    })();
    const subtitleSourceTag = entry.subtitleSource
      ? `<span class="history-tag" title="Subtitle source provider">📥 ${escapeHtml(entry.subtitleSource)}</span>`
      : '';

    // Tier 3: Configuration context
    const tier3Tags = [];
    if (entry.workflow && entry.workflow !== 'original') {
      const wfLabels = { xml: 'XML', json: 'JSON', ai: 'AI Timestamps' };
      tier3Tags.push(`<span class="history-tag">${wfLabels[entry.workflow] || escapeHtml(entry.workflow)}</span>`);
    }
    if (entry.jsonXmlFallback === true) {
      tier3Tags.push('<span class="history-chip warning" title="JSON structured output failed, fell back to XML">JSON→XML</span>');
    }
    if (typeof entry.batchCount === 'number' && entry.batchCount > 0) {
      tier3Tags.push(`<span class="history-tag">${entry.batchCount} batch${entry.batchCount > 1 ? 'es' : ''}</span>`);
    }
    if (entry.keyRotationMode && entry.keyRotationMode !== 'disabled') {
      tier3Tags.push(`<span class="history-tag">🔑 ${escapeHtml(entry.keyRotationMode)}</span>`);
    }
    if (entry.batchContextEnabled === true) tier3Tags.push('<span class="history-tag">Context</span>');
    if (entry.singleBatchMode === true) tier3Tags.push('<span class="history-tag">Single-batch</span>');
    if (entry.parallelBatchesUsed === true) tier3Tags.push('<span class="history-tag">Parallel</span>');
    if (entry.streaming === true) tier3Tags.push('<span class="history-tag">Streaming</span>');
    const tier3Html = tier3Tags.length > 0 ? tier3Tags.join('') : '';
    const downloadQueryParts = [];
    if (entry.videoId) downloadQueryParts.push(`videoId=${encodeURIComponent(entry.videoId)}`);
    if (entry.filename) downloadQueryParts.push(`filename=${encodeURIComponent(entry.filename)}`);
    const downloadQuery = downloadQueryParts.length ? `?${downloadQueryParts.join('&')}` : '';
    const downloadLink = (entry.scope !== 'embedded' && entry.sourceFileId && entry.targetLanguage && entry.status === 'completed')
      ? `<span class="history-download-wrap"><a class="history-download" href="/addon/${encodeURIComponent(configStr)}/translate/${encodeURIComponent(entry.sourceFileId)}/${encodeURIComponent(entry.targetLanguage)}${downloadQuery}" title="Download translated subtitle">Download</a><span class="history-download-hint"> - or reload the subtitle in Stremio!</span></span>`
      : '';
    // Format season/episode tag - only show season if it's actually a number
    const hasSeason = typeof entry.season === 'number' && Number.isFinite(entry.season);
    const hasEpisode = typeof entry.episode === 'number' && Number.isFinite(entry.episode);
    let seasonEpisode = '';
    if (hasSeason && hasEpisode) {
      seasonEpisode = `S${String(entry.season).padStart(2, '0')}E${String(entry.episode).padStart(2, '0')}`;
    } else if (hasEpisode) {
      seasonEpisode = `E${String(entry.episode).padStart(2, '0')}`; // Anime-style seasonless
    }
    const rawTitle = entry.title || entry.filename || entry.videoId || 'Unknown title';
    const titleText = escapeHtml(rawTitle);
    const displayTitle = escapeHtml(truncateText(rawTitle, 96));
    const titleLine = seasonEpisode ? `${displayTitle} · ${seasonEpisode}` : displayTitle;
    const filenameFull = entry.filename ? escapeHtml(entry.filename) : '';
    const filenameDisplay = entry.filename ? escapeHtml(truncateText(entry.filename, 80)) : '';
    const fileIsId = entry.filename && entry.sourceFileId && entry.filename === entry.sourceFileId;
    const idFull = entry.sourceFileId ? escapeHtml(entry.sourceFileId) : '';
    const idDisplay = entry.sourceFileId ? escapeHtml(truncateText(entry.sourceFileId, 48)) : '';
    const hashFull = entry.videoHash ? escapeHtml(entry.videoHash) : '';
    const hashDisplay = entry.videoHash ? escapeHtml(truncateText(entry.videoHash, 32)) : '';
    const subMetaParts = [
      entry.filename && !fileIsId ? `File: <span title="${filenameFull}">${filenameDisplay}</span>` : '',
      entry.sourceFileId ? `ID: <span title="${idFull}">${idDisplay}</span>` : '',
      entry.videoHash ? `Hash: <span title="${hashFull}">${hashDisplay}</span>` : ''
    ].filter(Boolean).join(' • ');

    // Retranslate button (available for all entries that have sourceFileId and targetLanguage)
    const canRetranslate = entry.sourceFileId && entry.targetLanguage && entry.scope !== 'embedded';
    const retranslateBtn = canRetranslate
      ? `<button class="history-retranslate" data-source-file-id="${escapeHtml(entry.sourceFileId)}" data-target-language="${escapeHtml(entry.targetLanguage)}" title="${t('history.retranslate.tooltip', {}, 'Clear cache and retranslate this subtitle')}">${t('history.retranslate.button', {}, 'Retranslate')}</button>`
      : '';

    return `
      <div class="history-card">
        <div class="history-header">
          <div class="history-title" title="${titleText}">${titleLine}</div>
          <div class="history-status ${statusClass}">${statusLabel}</div>
        </div>
        ${subMetaParts ? `<div class="history-submeta">${subMetaParts}</div>` : ''}
        <div class="history-meta">
          <span>${sourceName} &rarr; ${targetName}</span>
          <span>&bull;</span>
          <span>${dateStr}</span>
        </div>
        <div class="history-details">
          ${/* Main provider tag — always shown with main provider accent */''}
          <span class="history-tag" style="border-color:var(--provider-main-border);color:var(--provider-main);background:var(--provider-main-bg);font-weight:600">${providerLabel}</span>
          <span class="history-tag">${modelLabel}</span>
          ${cacheLabel}
          ${entryCountTag}
          ${durationTag}
          ${subtitleSourceTag}
          ${retranslateBtn}
          ${downloadLink}
        </div>
        ${/* Main provider diagnostic cluster — only shown when there are main-side errors/warnings */''}
        ${hasMainDiagnostics || mismatchChip ? `
        <div class="history-provider-group main">
          <span class="history-provider-label main" title="Diagnostics from the main translation provider">${providerLabel}</span>
          ${rateLimitChip}
          ${keyRotationChip}
          ${errorTypePills}
          ${mismatchChip}
        </div>` : ''}
        ${/* Secondary provider diagnostic cluster — only shown when secondary was involved */''}
        ${hasSecondary ? `
        <div class="history-provider-group secondary">
          <span class="history-provider-label secondary" title="Secondary provider was used as fallback">${secondaryName}</span>
          ${secondaryChip}
          ${hasSecondaryDiagnostics ? secondaryErrorTypePills : ''}
          ${hasSecondaryDiagnostics ? secondaryFailedChip : ''}
        </div>` : ''}
        ${tier3Html ? `<div class="history-config">${tier3Html}</div>` : ''}
        ${entry.error ? `<div class="history-error">${escapeHtml(entry.error)}</div>` : ''}
      </div>
    `;
  }).join('');

  const emptyState = `
    <div class="empty-state">
      <div class="empty-icon">📜</div>
      <h3>No history yet</h3>
      <p>Translations you perform will appear here.</p>
      <a href="${links.translateFiles}" class="btn-primary">Translate a file</a>
    </div>
  `;

  return `
<!DOCTYPE html>
<html lang="${resolveUiLang(config)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${t('history.documentTitle', {}, 'Translation History - SubMaker')}</title>
  ${localeBootstrap}
  <link rel="icon" type="image/svg+xml" href="/favicon-toolbox.svg">
  <link rel="shortcut icon" href="/favicon-toolbox.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@600&display=swap" rel="stylesheet">
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

    html { scroll-behavior: smooth; }

    :root {
      --primary: #08A4D5;
      --primary-light: #33B9E1;
      --primary-dark: #068DB7;
      --secondary: #33B9E1;
      --bg-primary: #f7fafc;
      --surface: #ffffff;
      --surface-2: #f3f7fb;
      --surface-3: #edf2f7;
      --text: #0f172a;
      --text-primary: #0f172a;
      --text-secondary: #475569;
      --muted: #475569;
      --border: #dbe3ea;
      --success: #10b981;
      --error: #ef4444;
      --warning: #f59e0b;
      --shadow: rgba(0, 0, 0, 0.08);
      --shadow-color: rgba(0, 0, 0, 0.08);
      --glow: rgba(8, 164, 213, 0.25);
      --theme-toggle-size: 48px;
      /* Provider accent colors for history card differentiation */
      --provider-main: #08A4D5;          /* Main provider — cyan/blue */
      --provider-main-bg: rgba(8, 164, 213, 0.08);
      --provider-main-border: rgba(8, 164, 213, 0.3);
      --provider-secondary: #f59e0b;     /* Secondary provider — amber */
      --provider-secondary-bg: rgba(245, 158, 11, 0.08);
      --provider-secondary-border: rgba(245, 158, 11, 0.3);
    }
    
    [data-theme="dark"] {
      color-scheme: dark;
      --bg-primary: #0A0E27;
      --surface: #141931;
      --surface-2: #1E2539;
      --surface-3: #111827;
      --text: #E8EAED;
      --text-primary: #E8EAED;
      --text-secondary: #9AA0A6;
      --muted: #9AA0A6;
      --border: #2A3247;
      --shadow: rgba(0, 0, 0, 0.3);
      --shadow-color: rgba(0, 0, 0, 0.3);
      --glow: rgba(8, 164, 213, 0.35);
      --provider-main: #33B9E1;
      --provider-main-bg: rgba(51, 185, 225, 0.1);
      --provider-main-border: rgba(51, 185, 225, 0.25);
      --provider-secondary: #fbbf24;
      --provider-secondary-bg: rgba(251, 191, 36, 0.1);
      --provider-secondary-border: rgba(251, 191, 36, 0.25);
    }

    [data-theme="true-dark"] {
      color-scheme: dark;
      --bg-primary: #000000;
      --surface: #0a0a0a;
      --surface-2: #151515;
      --surface-3: #0f0f0f;
      --text: #E8EAED;
      --text-primary: #E8EAED;
      --text-secondary: #8A8A8A;
      --muted: #8A8A8A;
      --border: #1a1a1a;
      --shadow: rgba(0, 0, 0, 0.8);
      --shadow-color: rgba(0, 0, 0, 0.8);
      --glow: rgba(8, 164, 213, 0.45);
      --provider-main: #33B9E1;
      --provider-main-bg: rgba(51, 185, 225, 0.07);
      --provider-main-border: rgba(51, 185, 225, 0.2);
      --provider-secondary: #fbbf24;
      --provider-secondary-bg: rgba(251, 191, 36, 0.07);
      --provider-secondary-border: rgba(251, 191, 36, 0.2);
    }

    body {
      margin: 0;
      background: linear-gradient(135deg, var(--bg-primary) 0%, #ffffff 60%, var(--bg-primary) 100%);
      color: var(--text-primary);
      font-family: 'Inter', 'Space Grotesk', -apple-system, 'Segoe UI', sans-serif;
      min-height: 100vh;
      overflow-x: hidden;
      position: relative;
      padding: 0;
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
    
    ${quickNavStyles()}
    ${themeToggleStyles()}

    .page {
      max-width: min(1180px, calc(100% - 56px));
      width: min(1180px, calc(100% - 56px));
      margin: 0 auto;
      padding: 2.75rem 0 3.5rem;
      position: relative;
      z-index: 1;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }
    
    .masthead {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 1.25rem 1.5rem;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.08);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    
    .masthead .titles {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }

    .masthead .eyebrow {
      margin: 0;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-secondary);
      font-weight: 700;
      font-size: 0.85rem;
    }

    h1 {
      margin: 0;
      font-family: 'Space Grotesk', sans-serif;
      font-size: 2rem;
      color: var(--text-primary);
    }

    .masthead .lede {
      margin: 0.2rem 0 0;
      color: var(--text-secondary);
      font-size: 1rem;
    }

    .masthead-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 0.65rem;
      flex-wrap: wrap;
    }

    .version-chip {
      padding: 0.45rem 0.8rem;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--surface-2);
      color: var(--text-secondary);
      font-weight: 700;
      font-size: 0.9rem;
      box-shadow: 0 6px 16px var(--shadow);
    }
    
    .history-list {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    
    .history-card {
      background: linear-gradient(160deg, var(--surface) 0%, var(--surface-2) 100%);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem 1.35rem;
      box-shadow: 0 12px 28px var(--shadow);
      backdrop-filter: blur(6px);
      transition: transform 0.2s;
    }
    
    .history-card:hover { transform: translateY(-2px); }
    
    .history-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 0.5rem;
      gap: 1rem;
    }
    
    .history-title {
      font-weight: 600;
      font-size: 1.1rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    
    .history-status {
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      padding: 0.25rem 0.75rem;
      border-radius: 99px;
      white-space: nowrap;
    }
    
    .history-status.success { background: rgba(16, 185, 129, 0.1); color: var(--success); }
    .history-status.error { background: rgba(239, 68, 68, 0.1); color: var(--error); }
    .history-status.processing { background: rgba(245, 158, 11, 0.1); color: var(--warning); }
    
    .history-submeta {
      margin-top: 0.25rem;
      font-size: 0.85rem;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .history-meta {
      display: flex;
      gap: 0.5rem;
      font-size: 0.9rem;
      color: var(--text-secondary);
    }
    
    .history-details {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.5rem;
      color: var(--text-secondary);
      font-size: 0.85rem;
    }
    
    .history-tag {
      padding: 0.15rem 0.5rem;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: rgba(0, 0, 0, 0.02);
      color: var(--text-secondary);
    }
    
    .history-download {
      padding: 0.15rem 0.75rem;
      border-radius: 999px;
      background: var(--primary);
      color: var(--surface);
      text-decoration: none;
      font-weight: 600;
      transition: opacity 0.2s ease;
    }
    .history-download:hover { opacity: 0.88; }
    .history-download-wrap {
      display: inline-flex;
      align-items: center;
    }
    .history-download-hint {
      margin-left: 0.35rem;
      color: var(--text-secondary);
      font-weight: 500;
      white-space: nowrap;
    }
    
    .history-chip {
      padding: 0.15rem 0.5rem;
      border-radius: 999px;
      font-weight: 600;
      font-size: 0.85rem;
      color: var(--surface);
      background: var(--primary);
    }
    
    .history-chip.cached {
      background: var(--success);
    }

    .history-chip.warning {
      background: var(--warning);
      color: #0b2336;
    }

    .history-chip.danger {
      background: var(--error);
    }

    .history-tag.info {
      border-color: var(--primary);
      color: var(--primary);
    }

    .history-tag.error-type {
      border-color: var(--provider-main-border);
      color: var(--provider-main);
      font-weight: 600;
      background: var(--provider-main-bg);
    }

    /* Provider-attributed diagnostic clusters */
    .history-provider-group {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.35rem;
      padding: 0.25rem 0.5rem;
      border-radius: 8px;
      border: 1px solid transparent;
    }
    .history-provider-group.main {
      border-color: var(--provider-main-border);
      background: var(--provider-main-bg);
    }
    .history-provider-group.secondary {
      border-color: var(--provider-secondary-border);
      background: var(--provider-secondary-bg);
    }
    /* Provider label pill inside the group */
    .history-provider-label {
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 0.1rem 0.4rem;
      border-radius: 999px;
      white-space: nowrap;
    }
    .history-provider-label.main {
      color: var(--provider-main);
      background: var(--provider-main-bg);
      border: 1px solid var(--provider-main-border);
    }
    .history-provider-label.secondary {
      color: var(--provider-secondary);
      background: var(--provider-secondary-bg);
      border: 1px solid var(--provider-secondary-border);
    }
    /* Secondary-colored chips */
    .history-chip.secondary-warning {
      background: var(--provider-secondary);
      color: #0b2336;
    }
    .history-chip.secondary-danger {
      background: #e87822;
      color: #0b2336;
    }
    .history-tag.secondary-error-type {
      border-color: var(--provider-secondary-border);
      color: var(--provider-secondary);
      font-weight: 600;
      background: var(--provider-secondary-bg);
    }
    .history-tag.secondary-info {
      border-color: var(--provider-secondary-border);
      color: var(--provider-secondary);
    }

    .history-retranslate {
      padding: 0.2rem 0.6rem;
      border-radius: 999px;
      background: transparent;
      color: var(--warning);
      border: 1px solid var(--warning);
      font-weight: 600;
      font-size: 0.8rem;
      cursor: pointer;
      transition: all 0.2s ease;
      white-space: nowrap;
    }
    .history-retranslate:hover {
      background: var(--warning);
      color: var(--surface);
    }
    .history-retranslate:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .history-retranslate.loading {
      opacity: 0.7;
      pointer-events: none;
    }

    .history-limit-note {
      margin-top: 0.35rem;
      color: var(--text-secondary);
      font-size: 0.9rem;
      text-align: right;
    }
    
    .history-error {
      margin-top: 0.75rem;
      font-size: 0.9rem;
      color: var(--error);
      background: rgba(239, 68, 68, 0.05);
      padding: 0.5rem;
      border-radius: 6px;
    }

    .history-config {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.35rem;
      margin-top: 0.35rem;
      font-size: 0.75rem;
      opacity: 0.7;
    }
    .history-config .history-tag {
      font-size: 0.75rem;
      padding: 0.1rem 0.4rem;
    }
    .history-config .history-chip {
      font-size: 0.75rem;
      padding: 0.1rem 0.4rem;
      font-weight: 500;
    }
    
    .empty-state {
      text-align: center;
      padding: 3.5rem 1rem;
      color: var(--text-secondary);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      box-shadow: 0 10px 24px var(--shadow);
    }
    .empty-icon { font-size: 3rem; margin-bottom: 0.75rem; }
    
    .btn-primary {
      display: inline-block;
      margin-top: 1rem;
      padding: 0.75rem 1.5rem;
      background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
      color: #0b2336;
      text-decoration: none;
      border-radius: 10px;
      font-weight: 700;
      border: 1px solid rgba(255,255,255,0.18);
      box-shadow: 0 10px 26px var(--glow);
    }

    @media (max-width: 920px) {
      .masthead { flex-direction: column; align-items: flex-start; }
      .masthead-actions { width: 100%; justify-content: flex-start; }
      .history-header { flex-direction: column; align-items: flex-start; }
      .history-title { white-space: normal; }
      .history-meta { flex-wrap: wrap; }
      .history-details { gap: 0.35rem; font-size: 0.8rem; }
      .history-tag, .history-chip { font-size: 0.78rem; }
      .history-provider-group { padding: 0.2rem 0.4rem; gap: 0.3rem; font-size: 0.78rem; }
      .history-provider-label { font-size: 0.68rem; }
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
  ${themeToggleMarkup(themeToggleLabel)}

  ${renderQuickNav(links, 'history', false, devMode, t)}

  <div class="page">
    <div class="masthead">
      <div class="titles">
        <p class="eyebrow">${t('history.eyebrow', {}, 'Sub toolbox')}</p>
        <h1>${t('history.title', {}, 'Translation History')}</h1>
        <p class="lede">${t('history.subtitle', {}, 'Review translations performed across your tools')}</p>
      </div>
      <div class="masthead-actions">
        <div class="version-chip">v${escapeHtml(appVersion || 'n/a')}</div>
      </div>
    </div>
    
    <div class="history-list">
      ${sortedHistory.length ? historyRows : emptyState}
    </div>
    <div class="history-limit-note">Showing the newest 20 requests. Older history rolls off automatically.</div>
  </div>

  <script src="/js/sw-register.js"></script>
  <script src="/js/subtitle-menu.js?v=${escapeHtml(appVersion || 'dev')}"></script>
  <script>
    // Retranslate button handler
    (function initRetranslateButtons() {
      const CONFIG_STR = ${JSON.stringify(configStr || '')};
      
      function tt(key, vars, fallback) {
        try {
          if (typeof window.t === 'function') return window.t(key, vars || {}, fallback || key);
        } catch (_) {}
        return fallback || key;
      }

      function handleRetranslate(btn) {
        if (btn.disabled || btn.classList.contains('loading')) return;
        
        const sourceFileId = btn.dataset.sourceFileId;
        const targetLanguage = btn.dataset.targetLanguage;
        
        if (!sourceFileId || !targetLanguage) {
          alert(tt('history.retranslate.missingParams', {}, 'Missing required parameters.'));
          return;
        }
        
        const originalText = btn.textContent;
        btn.textContent = tt('history.retranslate.loading', {}, 'Clearing...');
        btn.classList.add('loading');
        btn.disabled = true;
        
        const url = '/api/retranslate?' + new URLSearchParams({
          config: CONFIG_STR,
          sourceFileId: sourceFileId,
          targetLanguage: targetLanguage
        }).toString();
        
        fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' }, cache: 'no-store' })
          .then(function(resp) { return resp.json().then(function(data) { return { ok: resp.ok, data: data }; }); })
          .then(function(result) {
            if (result.ok && result.data.success) {
              btn.textContent = tt('history.retranslate.done', {}, 'Done!');
              btn.style.borderColor = 'var(--success)';
              btn.style.color = 'var(--success)';
              
              // Show success message and hint
              const hint = tt('history.retranslate.successHint', {}, 'Cache cleared! Reload the subtitle in Stremio or click Download to get the fresh translation.');
              const card = btn.closest('.history-card');
              if (card) {
                let msgEl = card.querySelector('.retranslate-msg');
                if (!msgEl) {
                  msgEl = document.createElement('div');
                  msgEl.className = 'retranslate-msg';
                  msgEl.style.cssText = 'margin-top: 0.5rem; padding: 0.4rem 0.6rem; background: rgba(16,185,129,0.1); border-radius: 6px; font-size: 0.85rem; color: var(--success);';
                  card.appendChild(msgEl);
                }
                msgEl.textContent = hint;
              }
              
              // Re-enable after delay
              setTimeout(function() {
                btn.textContent = originalText;
                btn.classList.remove('loading');
                btn.disabled = false;
                btn.style.borderColor = '';
                btn.style.color = '';
              }, 3000);
            } else {
              throw new Error(result.data.error || tt('history.retranslate.failedReason', {}, 'Retranslation failed'));
            }
          })
          .catch(function(err) {
            btn.textContent = tt('history.retranslate.failed', {}, 'Failed');
            btn.style.borderColor = 'var(--error)';
            btn.style.color = 'var(--error)';
            alert(err.message || tt('history.retranslate.errorGeneric', {}, 'Retranslation failed. Please try again.'));
            
            setTimeout(function() {
              btn.textContent = originalText;
              btn.classList.remove('loading');
              btn.disabled = false;
              btn.style.borderColor = '';
              btn.style.color = '';
            }, 2000);
          });
      }

      document.addEventListener('click', function(e) {
        if (e.target && e.target.classList.contains('history-retranslate')) {
          e.preventDefault();
          handleRetranslate(e.target);
        }
      });
    })();

    (function initSubtitleMenuBridge() {
      const HISTORY = {
        configStr: ${JSON.stringify(configStr || '')},
        videoId: ${JSON.stringify(videoId || '')},
        filename: ${JSON.stringify(filename || '')},
        videoHash: ''
      };
      const SUBTITLE_MENU_TARGETS = ${JSON.stringify(config?.targetLanguages || [])};
      const SUBTITLE_MENU_SOURCES = ${JSON.stringify(config?.sourceLanguages || [])};
      const SUBTITLE_MENU_TARGET_CODES = ${JSON.stringify(config?.targetLanguages || [])};
      const SUBTITLE_LANGUAGE_MAPS = ${JSON.stringify(config?.languageMaps || {})};

      function tryMountSubtitleMenu(attemptsLeft) {
        if (!window.SubtitleMenu || typeof window.SubtitleMenu.mount !== 'function') {
          if (attemptsLeft > 0) setTimeout(() => tryMountSubtitleMenu(attemptsLeft - 1), 200);
          return;
        }
        try {
          const subtitleMenuInstance = window.SubtitleMenu.mount({
            configStr: HISTORY.configStr,
            videoId: HISTORY.videoId,
            filename: HISTORY.filename,
            videoHash: HISTORY.videoHash,
            targetOptions: SUBTITLE_MENU_TARGETS,
            sourceLanguages: SUBTITLE_MENU_SOURCES,
            targetLanguages: SUBTITLE_MENU_TARGET_CODES,
            languageMaps: SUBTITLE_LANGUAGE_MAPS,
            getVideoHash: () => HISTORY.videoHash || '',
            version: '${escapeHtml(appVersion || '')}'
          });

          if (subtitleMenuInstance && typeof subtitleMenuInstance.prefetch === 'function') {
            subtitleMenuInstance.prefetch();
          }
        } catch (err) {
          console.warn('Subtitle menu init failed', err);
        }
      }

      tryMountSubtitleMenu(5);
    })();

    ${quickNavScript()}
  </script>
</body>
</html>
  `;
}

module.exports = { generateHistoryPage };
