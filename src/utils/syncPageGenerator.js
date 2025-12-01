/**
 * Generate HTML page for subtitle synchronization
 * This page allows users to:
 * 1. Extract audio from stream link
 * 2. Select a subtitle to sync
 * 3. Sync using alass-wasm
 * 4. Preview synced result
 * 5. Optionally translate after syncing
 * 6. Download results
 */

const axios = require('axios');
const { getLanguageName, getAllLanguages, buildLanguageLookupMaps } = require('./languages');
const { deriveVideoHash } = require('./videoHash');
const { parseStremioId } = require('./subtitle');
const { version: appVersion } = require('../../package.json');
const { quickNavStyles, quickNavScript, renderQuickNav, renderRefreshBadge } = require('./quickNav');

function escapeHtml(text) {
    if (!text) return '';
    return text
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

function formatEpisodeTag(parsed) {
    if (!parsed) return '';
    if (parsed.type === 'episode' || parsed.type === 'anime-episode') {
        const season = Number.isFinite(parsed.season) ? `S${String(parsed.season).padStart(2, '0')}` : '';
        const episode = Number.isFinite(parsed.episode) ? `E${String(parsed.episode).padStart(2, '0')}` : '';
        return season || episode ? `${season}${episode}` : '';
    }
    return '';
}

function cleanDisplayName(raw) {
    if (!raw) return '';
    const lastSegment = String(raw).split(/[/\\]/).pop() || '';
    const withoutExt = lastSegment.replace(/\.[^.]+$/, '');
    const spaced = withoutExt.replace(/[_\\.]+/g, ' ').replace(/\s+/g, ' ').trim();
    return spaced || withoutExt || lastSegment;
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

function buildLinkedVideoLabel(videoId, streamFilename, resolvedTitle) {
    const parsed = parseStremioId(videoId);
    const cleanedFilename = streamFilename ? cleanDisplayName(streamFilename) : '';

    const movieTitle = resolvedTitle || cleanedFilename || parsed?.imdbId || parsed?.animeId || streamFilename;

    if (parsed && (parsed.type === 'episode' || parsed.type === 'anime-episode')) {
        const baseTitle = movieTitle || 'linked stream';
        const suffix = formatEpisodeTag(parsed) || 'Episode';
        return `${baseTitle} - ${suffix}`;
    }

    return movieTitle || 'linked stream';
}

async function generateSubtitleSyncPage(subtitles, videoId, streamFilename, configStr, config) {
    const videoHash = deriveVideoHash(streamFilename, videoId);
    const parsedVideoId = parseStremioId(videoId);
    const episodeTag = formatEpisodeTag(parsedVideoId);
    const linkedTitle = await fetchLinkedTitleServer(videoId);
    const linkedVideoLabel = escapeHtml(buildLinkedVideoLabel(videoId, streamFilename, linkedTitle));
    const initialVideoTitle = escapeHtml(linkedTitle || buildLinkedVideoLabel(videoId, streamFilename));
    const subtitleDetails = [];
    if (linkedTitle) {
        subtitleDetails.push(`Title: ${linkedTitle}`);
    } else if (videoId) {
        subtitleDetails.push(`Video ID: ${videoId}`);
    }
    if (episodeTag) subtitleDetails.push(`Episode: ${episodeTag}`);
    if (streamFilename) subtitleDetails.push(`File: ${cleanDisplayName(streamFilename)}`);
    const initialVideoSubtitle = escapeHtml(subtitleDetails.join(' • ') || 'Video ID unavailable');
    const links = {
        translateFiles: `/file-upload?config=${encodeURIComponent(configStr || '')}&videoId=${encodeURIComponent(videoId || '')}`,
        syncSubtitles: `/subtitle-sync?config=${encodeURIComponent(configStr || '')}&videoId=${encodeURIComponent(videoId || '')}&filename=${encodeURIComponent(streamFilename || '')}`,
        embeddedSubs: `/embedded-subtitles?config=${encodeURIComponent(configStr || '')}&videoId=${encodeURIComponent(videoId || '')}&filename=${encodeURIComponent(streamFilename || '')}`,
        automaticSubs: `/auto-subtitles?config=${encodeURIComponent(configStr || '')}&videoId=${encodeURIComponent(videoId || '')}&filename=${encodeURIComponent(streamFilename || '')}`,
        subToolbox: `/sub-toolbox?config=${encodeURIComponent(configStr || '')}&videoId=${encodeURIComponent(videoId || '')}&filename=${encodeURIComponent(streamFilename || '')}`,
        configure: `/configure?config=${encodeURIComponent(configStr || '')}`
    };
    const devMode = (config || {}).devMode === true;

    // Filter out action buttons and xSync entries to show only fetchable subtitles
    // Filter out action buttons (legacy and new Sub Toolbox) so only real subtitles are selectable
    const fetchableSubtitles = subtitles.filter(sub => {
        const id = sub?.id || '';
        return id !== 'sync_subtitles' &&
               id !== 'file_upload' &&
               id !== 'sub_toolbox' &&
               !id.startsWith('translate_') &&
               !id.startsWith('xsync_');
    });

    // Group subtitles by language
    const subtitlesByLang = {};
    for (const sub of fetchableSubtitles) {
        const langName = sub.lang || 'Unknown';
        if (!subtitlesByLang[langName]) {
            subtitlesByLang[langName] = [];
        }
        subtitlesByLang[langName].push(sub);
    }

    // Generate subtitle options HTML
    let subtitleOptionsHTML = '<option value="" disabled selected>Choose a subtitle</option>';
    for (const [lang, subs] of Object.entries(subtitlesByLang)) {
        subtitleOptionsHTML += `
            <optgroup label="${escapeHtml(lang)}">`;
        for (let i = 0; i < subs.length; i++) {
            const sub = subs[i];
            const displayName = `${lang} #${i + 1}`;
            subtitleOptionsHTML += `
                <option value="${escapeHtml(sub.id)}" data-lang="${escapeHtml(lang)}" data-url="${escapeHtml(sub.url)}">${escapeHtml(displayName)}</option>`;
        }
        subtitleOptionsHTML += `
            </optgroup>`;
    }

    // Generate language options for source (ALL languages for file upload case)
    const allAvailableLanguages = getAllLanguages();
    let allLangOptionsHTML = '';
    for (const { code, name } of allAvailableLanguages) {
        allLangOptionsHTML += `<option value="${escapeHtml(code)}">${escapeHtml(name)}</option>`;
    }

    // Generate language options for target
    const sourceLanguages = config.sourceLanguages || ['eng'];
    // Include source languages in target list so "same language" sync is always available
    const targetLanguages = [...new Set([...(config.targetLanguages || ['spa', 'fra', 'por']), ...sourceLanguages])];
    const languageMaps = buildLanguageLookupMaps();

    let targetLangOptionsHTML = '';
    for (const lang of targetLanguages) {
        const langName = getLanguageName(lang);
        targetLangOptionsHTML += `<option value="${escapeHtml(lang)}">${escapeHtml(langName)}</option>`;
    }

    // Preserve backslashes when embedding regex literals inside the generated page script
    const pathSplitRegex = String.raw`/[\\/]/`;
    const extStripRegex = String.raw`/\.[a-z0-9]{2,4}$/i`;

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Subtitles Sync Studio - SubMaker</title>
    <!-- Favicon -->
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
            --warning: #f59e0b;
            --danger: #ef4444;
            --bg-primary: #f7fafc;
            --surface: #ffffff;
            --surface-light: #f3f7fb;
            --surface-2: #f4f7fc;
            --text-primary: #0f172a;
            --text-secondary: #475569;
            --text: #0f172a;
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
            --warning: #f59e0b;
            --danger: #ef4444;
            --bg-primary: #0A0E27;
            --surface: #141931;
            --surface-light: #1E2539;
            --surface-2: #1e2539;
            --text-primary: #E8EAED;
            --text-secondary: #9AA0A6;
            --text: #E8EAED;
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
            --warning: #f59e0b;
            --danger: #ef4444;
            --bg-primary: #000000;
            --surface: #0a0a0a;
            --surface-light: #151515;
            --surface-2: #151515;
            --text-primary: #E8EAED;
            --text-secondary: #8A8A8A;
            --text: #E8EAED;
            --muted: #8A8A8A;
            --border: #1a1a1a;
            --shadow: rgba(0, 0, 0, 0.8);
            --glow: rgba(8, 164, 213, 0.45);
        }

        /* Removed forced color-scheme override - let theme cascade handle it naturally */

        ${quickNavStyles()}

        body {
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

        body.modal-open {
            overflow: hidden;
        }

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

        .container {
            max-width: 1000px;
            margin: 0 auto;
            padding: 3rem 1.5rem;
            position: relative;
            z-index: 1;
        }

        .header {
            text-align: center;
            margin-bottom: 3rem;
            animation: fadeInDown 0.6s cubic-bezier(0.16, 1, 0.3, 1);
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

        .logo-icon {
            width: 80px;
            height: 80px;
            margin: 0 auto 1.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            border-radius: 20px;
            font-size: 2.5rem;
            box-shadow: 0 20px 60px var(--glow);
            animation: float 3s ease-in-out infinite;
        }

        @keyframes float {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-10px); }
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

            .quick-nav-hero { width: 100%; }

            :root { --theme-toggle-size: 42px; }
            .theme-toggle {
                top: 1rem;
                right: 1rem;
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

        .page { max-width: 1200px; margin: 0 auto; padding: 24px 18px 0; }
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
        .page-heading {
            margin: 0;
            font-size: 30px;
            letter-spacing: -0.02em;
            font-weight: 700;
            color: var(--text-primary);
            text-align: center;
        }
        .page-subtitle {
            margin: 0;
            color: var(--muted);
            font-weight: 600;
            text-align: center;
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
        }
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

        .section {
            background:
                linear-gradient(180deg, rgba(255, 255, 255, 0.9) 0%, rgba(255, 255, 255, 0.82) 100%),
                var(--surface);
            backdrop-filter: blur(12px);
            border-radius: 20px;
            padding: 2rem;
            margin-bottom: 1.5rem;
            border: 1px solid var(--border);
            box-shadow: 0 8px 24px var(--shadow);
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            animation: fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) backwards;
        }

        [data-theme="dark"] .section {
            background:
                linear-gradient(180deg, rgba(20, 25, 49, 0.9) 0%, rgba(20, 25, 49, 0.82) 100%),
                var(--surface);
            box-shadow: 0 12px 34px var(--shadow), 0 0 0 1px rgba(8, 164, 213, 0.1);
        }

        [data-theme="true-dark"] .section {
            background:
                linear-gradient(180deg, rgba(10, 10, 10, 0.94) 0%, rgba(10, 10, 10, 0.86) 100%),
                var(--surface);
            box-shadow: 0 14px 40px var(--shadow), 0 0 0 1px rgba(8, 164, 213, 0.12);
        }

        .section:hover {
            border-color: var(--primary);
            box-shadow: 0 12px 48px var(--glow);
            transform: translateY(-2px);
        }

        .section h2 {
            font-size: 1.5rem;
            font-weight: 700;
            margin-bottom: 1.5rem;
            display: flex;
            align-items: center;
            gap: 0.75rem;
            color: var(--text-primary);
            letter-spacing: -0.02em;
        }

        .section h2.section-heading {
            width: 100%;
        }

        .section h2.section-centered {
            justify-content: center;
            text-align: center;
        }

        .section-number {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 36px;
            height: 36px;
            border-radius: 50%;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            font-size: 1rem;
            font-weight: 700;
            color: white;
            box-shadow: 0 4px 12px var(--glow);
        }

        .step-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
            gap: 1rem;
        }

        @media (min-width: 960px) {
            .step-grid {
                grid-template-columns: repeat(2, minmax(0, 1fr));
            }
        }

        .step-card {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 14px;
            padding: 1.25rem;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.6);
            display: flex;
            flex-direction: column;
            gap: 1rem;
            height: 100%;
            transition: border-color 0.25s ease, box-shadow 0.25s ease, transform 0.25s ease;
        }

        [data-theme="dark"] .step-card,
        [data-theme="true-dark"] .step-card {
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
            background: linear-gradient(180deg, rgba(20,25,49,0.18) 0%, rgba(20,25,49,0.06) 100%), var(--surface);
        }

        [data-theme="true-dark"] .step-card {
            background: linear-gradient(180deg, rgba(12,12,12,0.28) 0%, rgba(12,12,12,0.12) 100%), var(--surface);
        }

        .step-card:hover {
            border-color: var(--primary);
            box-shadow: 0 6px 18px var(--shadow);
            transform: translateY(-2px);
        }

        .step3-wrapper {
            margin-top: 1rem;
            display: flex;
            justify-content: center;
        }

        .step3-section {
            max-width: 880px;
            margin-left: auto;
            margin-right: auto;
            padding-left: 1.5rem;
            padding-right: 1.5rem;
        }

        .step3-wrapper .step-card {
            width: 100%;
            max-width: 760px;
        }

        .step3-standalone {
            margin-top: 0;
        }

        .step-title {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 0.75rem;
            font-weight: 700;
            color: var(--text-primary);
        }

        .step-title > span:last-child {
            width: 100%;
            text-align: center;
        }

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

        .form-group {
            margin-bottom: 1.5rem;
        }

        .form-group label {
            display: block;
            margin-bottom: 0.5rem;
            color: var(--text-primary);
            font-size: 0.95rem;
            font-weight: 600;
            text-align: center;
        }

        .label-description {
            display: block;
            font-size: 0.875rem;
            color: var(--text-secondary);
            font-weight: 400;
            margin-top: 0.25rem;
            text-align: center;
        }

        .form-group input[type="text"],
        .form-group select,
        .form-group textarea {
            width: 100%;
            padding: 0.875rem 1rem;
            background: var(--surface);
            border: 2px solid var(--border);
            border-radius: 12px;
            color: var(--text-primary);
            font-size: 1rem;
            transition: border-color 0.2s ease, box-shadow 0.2s ease;
            font-family: inherit;
            text-align: center;
        }

        .form-group input[type="text"]:focus,
        .form-group select:focus,
        .form-group textarea:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 4px var(--glow);
        }

        .form-group textarea {
            min-height: 100px;
            resize: vertical;
            font-family: monospace;
        }

        .checkbox-group {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            margin-top: 1rem;
            padding: 1rem;
            background: var(--surface-light);
            border-radius: 12px;
        }

        .checkbox-group input[type="checkbox"] {
            width: 20px;
            height: 20px;
            cursor: pointer;
            accent-color: var(--primary);
        }

        .checkbox-group label {
            margin: 0;
            cursor: pointer;
            font-weight: 500;
            color: var(--text-primary);
        }

        .btn {
            padding: 0.875rem 1.5rem;
            border: none;
            border-radius: 12px;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            font-family: inherit;
            margin: 0 auto;
        }

        .btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }

        .btn-primary {
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            color: white;
            box-shadow: 0 4px 12px var(--glow);
        }

        .btn-primary:hover:not(:disabled) {
            transform: translateY(-2px);
            box-shadow: 0 8px 24px var(--glow);
        }

        .btn-secondary {
            background: var(--surface-light);
            color: var(--text-primary);
            border: 2px solid var(--border);
        }

        .btn-secondary:hover:not(:disabled) {
            border-color: var(--primary);
            background: var(--surface);
        }

        .btn-success {
            background: linear-gradient(135deg, var(--success) 0%, #059669 100%);
            color: white;
            box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
        }

        .btn-success:hover:not(:disabled) {
            transform: translateY(-2px);
            box-shadow: 0 8px 24px rgba(16, 185, 129, 0.3);
        }

        .progress-container {
            margin-top: 1.5rem;
            display: none;
        }

        .progress-bar {
            width: 100%;
            height: 10px;
            background: var(--surface-light);
            border-radius: 10px;
            overflow: hidden;
            border: 1px solid var(--border);
        }

        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, var(--primary) 0%, var(--secondary) 100%);
            width: 0%;
            transition: width 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .progress-text {
            margin-top: 0.75rem;
            font-size: 0.95rem;
            color: var(--text-primary);
            text-align: center;
            font-weight: 500;
        }

        .log-panel {
            margin-top: 0.75rem;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 10px 12px;
            max-height: 260px;
            overflow-y: auto;
            font-family: 'Space Grotesk', 'Inter', system-ui, -apple-system, sans-serif;
            font-size: 0.9rem;
            line-height: 1.35;
            color: var(--text);
            box-shadow: 0 6px 20px rgba(0,0,0,0.08);
        }
        .log-panel .log-entry {
            padding: 4px 0;
            border-bottom: 1px dashed rgba(0,0,0,0.07);
        }
        .log-panel .log-entry:last-child { border-bottom: none; }
        .log-entry .log-time { color: var(--muted); font-weight: 600; margin-right: 6px; }
        .log-entry.info { color: var(--text); }
        .log-entry.warn { color: #d99000; }
        .log-entry.error { color: #d7263d; }

        .status-message {
            padding: 1.25rem;
            border-radius: 12px;
            margin-top: 1rem;
            display: none;
            font-weight: 500;
        }

        .status-message.info {
            background: rgba(8, 164, 213, 0.08);
            border: 1px solid rgba(8, 164, 213, 0.2);
            color: var(--text-primary);
            text-align: center;
        }

        .status-message.success {
            background: rgba(16, 185, 129, 0.08);
            border: 1px solid rgba(16, 185, 129, 0.2);
            color: var(--text-primary);
            text-align: center;
        }

        .status-message.error {
            background: rgba(239, 68, 68, 0.08);
            border: 1px solid var(--danger);
            color: var(--danger);
            text-align: center;
        }

        .video-meta {
            margin-top: 0.75rem;
            padding: 12px;
            border-radius: 12px;
            border: 1px dashed var(--border);
            background: var(--surface-2);
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

        .video-preview {
            width: 100%;
            max-height: 400px;
            border-radius: 12px;
            display: none;
            margin-top: 1rem;
            border: 1px solid var(--border);
        }

        .subtitle-list {
            width: 100%;
            padding: 0.875rem 1rem;
            border: 2px solid var(--border);
            border-radius: 12px;
            background: var(--surface);
            color: var(--text-primary);
            font-size: 1rem;
            appearance: none;
            -webkit-appearance: none;
            -moz-appearance: none;
            background-image:
                linear-gradient(45deg, transparent 50%, var(--text-secondary) 50%),
                linear-gradient(135deg, var(--text-secondary) 50%, transparent 50%),
                linear-gradient(to right, transparent, transparent);
            background-position:
                calc(100% - 20px) calc(50% - 4px),
                calc(100% - 12px) calc(50% - 4px),
                0 0;
            background-size: 8px 8px, 8px 8px, 0 100%;
            background-repeat: no-repeat;
            padding-right: 2.5rem;
            text-align: center;
        }

        .subtitle-list:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 4px var(--glow);
        }

        .upload-area {
            border: 2px dashed var(--border);
            border-radius: 12px;
            padding: 2.5rem 2rem;
            text-align: center;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            margin-bottom: 1rem;
            background: var(--surface);
        }

        .upload-area:hover {
            border-color: var(--primary);
            background: var(--surface-light);
            transform: translateY(-2px);
        }

        .upload-area.dragover {
            border-color: var(--primary);
            background: rgba(8, 164, 213, 0.08);
            border-style: solid;
        }

        .upload-area p {
            font-size: 1.05rem;
            font-weight: 500;
            color: var(--text-primary);
        }

        .upload-area p:last-child {
            font-size: 0.875rem;
            color: var(--text-secondary);
        }

        .hidden {
            display: none !important;
        }

        .download-buttons {
            display: flex;
            gap: 1rem;
            margin-top: 1.5rem;
            flex-wrap: wrap;
        }

        .info-box {
            background: rgba(8, 164, 213, 0.08);
            border: 1px solid rgba(8, 164, 213, 0.2);
            border-radius: 12px;
            padding: 1.25rem;
            margin-bottom: 1rem;
        }

        .info-box h4 {
            margin-bottom: 0.5rem;
            color: var(--text-primary);
            font-size: 1rem;
            font-weight: 600;
        }

        .info-box p {
            font-size: 0.875rem;
            color: var(--text-secondary);
            line-height: 1.6;
        }

        .auto-sync-box {
            background: rgba(8, 164, 213, 0.12);
            border-color: rgba(8, 164, 213, 0.25);
            color: var(--text-primary);
        }

        [data-theme="dark"] .auto-sync-box,
        [data-theme="true-dark"] .auto-sync-box {
            background: rgba(30, 64, 175, 0.25);
            border-color: rgba(59, 130, 246, 0.55);
        }

        .sync-method-description {
            margin: 0;
            color: var(--text-primary);
        }

        [data-theme="dark"] .sync-method-description,
        [data-theme="true-dark"] .sync-method-description {
            color: #e8edf7;
        }

        .plan-summary {
            margin-top: 0.35rem;
            color: var(--text-secondary);
            font-size: 0.95rem;
        }

        [data-theme="dark"] .plan-summary,
        [data-theme="true-dark"] .plan-summary {
            color: #c9d5eb;
        }
    ${themeToggleStyles()}
    </style>
    <script src="/js/theme-toggle.js" defer></script>
</head>
<body>
    ${themeToggleMarkup()}
    <button class="help-button mario" id="syncHelp" title="Show instructions">?</button>
    <div class="modal-overlay" id="syncInstructionsModal" role="dialog" aria-modal="true" aria-labelledby="syncInstructionsTitle">
        <div class="modal">
            <div class="modal-header">
                <h2 id="syncInstructionsTitle">Subtitle Sync Instructions</h2>
                <div class="modal-close" id="closeSyncInstructions" role="button" aria-label="Close instructions">&times;</div>
            </div>
            <div class="modal-content">
                <h3>Sync Methods</h3>
                <ol>
                    <li><strong>Manual Offset:</strong> Adjust subtitle timing manually with positive/negative milliseconds when you don't want to run autosync.</li>
                    <li><strong>ALASS (audio ➜ subtitle):</strong> Fast wasm anchors against the audio; pick Rapid/Balanced/Deep/Complete profiles for coverage.</li>
                    <li><strong>FFSubSync (audio ➜ subtitle):</strong> Drift-aware audio alignment via ffsubsync-wasm; choose a light, balanced, deep, or complete scan.</li>
                    <li><strong>Vosk CTC/DTW (text ➜ audio):</strong> Force-align your subtitle text directly to audio with Vosk logits + DTW, great for broken timings or big offsets.</li>
                    <li><strong>Whisper + ALASS (subtitle ➜ subtitle):</strong> Whisper transcript alignment with an ALASS refinement pass; use light/balanced/deep/complete profiles to control scan size.</li>
                </ol>
                <p>Select a primary engine first, then pick its scan profile. Coverage adapts to the detected runtime so heavy cases can get deeper scans.</p>
            </div>
            <div class="modal-footer">
                <label class="modal-checkbox">
                    <input type="checkbox" id="dontShowSyncInstructions">
                    Don't show this again
                </label>
                <button type="button" class="btn" id="gotItSyncInstructions">Got it</button>
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
    ${renderQuickNav(links, 'syncSubtitles', false, devMode)}
    <div class="page">
        <header class="masthead">
            <div class="page-hero">
                <div class="page-icon">⏱️</div>
                <h1 class="page-heading">Subtitles Sync Studio</h1>
                <p class="page-subtitle">Automatically synchronize subtitles with your video using audio analysis</p>
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
                        <a id="ext-label" class="ext-link" href="https://chromewebstore.google.com/detail/submaker-xsync/lpocanpndchjkkpgchefobjionncknjn?authuser=0&hl=en" target="_blank" rel="noopener noreferrer">Waiting for extension...</a>
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

        <!-- Steps 1-3: Combined Flow -->
        <div class="section" id="syncFlowSection">
            <h2 class="section-heading section-centered"><span class="section-number">1-3</span> Link your stream, choose a subtitle, and sync</h2>
            <div class="step-grid">
                <div class="step-card" id="step1Section">
                    <div class="step-title">
                        <span class="step-chip">Step 1</span>
                        <span>Provide Stream Information</span>
                    </div>
                    <div class="video-meta">
                        <p class="video-meta-label">Linked stream</p>
                        <p class="video-meta-title" id="sync-video-meta-title">${initialVideoTitle}</p>
                        <p class="video-meta-subtitle" id="sync-video-meta-subtitle">${initialVideoSubtitle}</p>
                    </div>
                    <div class="form-group">
                        <label for="streamUrl">Stream URL:</label>
                        <input type="text" id="streamUrl" placeholder="Paste your stream URL here (e.g., http://... or magnet:...)" value="">
                    </div>
                    <div class="status-message info" style="display: block;">
                        <strong>ℹ️ Subtitles Sync:</strong> Ensure the linked stream is the intended one (same as the Stream URL) and that the extension is detected before continuing.
                    </div>
                    <button id="continueBtn" class="btn btn-primary">
                        <span>➡️</span> Continue to Subtitle Selection
                    </button>
                </div>

                <div class="step-card" id="step2Section" style="opacity: 0.5; pointer-events: none;">
                    <div class="step-title">
                        <span class="step-chip">Step 2</span>
                        <span>Select Subtitle to Sync</span>
                    </div>
                    <div class="form-group">
                        <label>Choose from <strong>${linkedVideoLabel}</strong> fetched subtitles:</label>
                        <select id="subtitleSelect" class="subtitle-list">
                            ${subtitleOptionsHTML}
                        </select>
                    </div>
                    <div class="upload-area" id="uploadArea">
                        <p>📁 Or drag & drop your .srt file here</p>
                        <p style="font-size: 0.85rem; color: #9CA3AF; margin-top: 0.5rem;">Click to browse files</p>
                        <input type="file" id="fileInput" accept=".srt" style="display: none;">
                    </div>
                    <div class="form-group" id="sourceLanguageGroup" style="display: none;">
                        <label for="sourceLanguage">Source Language:</label>
                        <select id="sourceLanguage">
                            ${allLangOptionsHTML}
                        </select>
                    </div>
                    <div class="checkbox-group">
                        <input type="checkbox" id="translateAfterSync">
                        <label for="translateAfterSync">Translate subtitle after syncing</label>
                    </div>
                    <div class="form-group" id="targetLangGroup" style="display: none; margin-top: 1rem;">
                        <label for="targetLanguage">Target Language:</label>
                        <select id="targetLanguage">
                            ${targetLangOptionsHTML}
                        </select>
                    </div>
                </div>
            </div>
        </div>

        <div class="section step3-section">
            <div class="step3-wrapper">
                <div class="step-card step3-standalone" id="step3Section" style="opacity: 0.5; pointer-events: none;">
                    <div class="step-title">
                        <span class="step-chip">Step 3</span>
                        <span>Sync Subtitle</span>
                    </div>

                    <div class="form-group">
                        <label for="primarySyncMode">Primary Mode:</label>
                        <select id="primarySyncMode">
                            <option value="manual">📝 Manual Offset Adjustment</option>
                            <option value="alass" disabled>🎯 ALASS (audio ➜ subtitle)</option>
                            <option value="ffsubsync" disabled>🎛️ FFSubSync (audio ➜ subtitle)</option>
                            <option value="vosk-ctc" disabled>🧭 Vosk CTC/DTW (text ➜ audio)</option>
                            <option value="whisper-alass" disabled>🗣️ Whisper + ALASS (subtitle ➜ subtitle)</option>
                        </select>
                    </div>

                    <div class="form-group" id="secondaryModeGroup" style="display: none;">
                        <label for="secondarySyncMode">Scan Profile:</label>
                        <select id="secondarySyncMode"></select>
                    </div>

                    <!-- Manual Sync Controls -->
                    <div id="manualSyncControls">
                        <div class="form-group">
                            <label for="offsetMs">Time Offset (milliseconds):</label>
                            <div style="display: flex; gap: 0.5rem; align-items: center;">
                                <input type="number" id="offsetMs" value="0" step="100" style="flex: 1;">
                                <button class="btn btn-secondary" onclick="document.getElementById('offsetMs').value = parseInt(document.getElementById('offsetMs').value) - 1000">-1s</button>
                                <button class="btn btn-secondary" onclick="document.getElementById('offsetMs').value = parseInt(document.getElementById('offsetMs').value) - 100">-100ms</button>
                                <button class="btn btn-secondary" onclick="document.getElementById('offsetMs').value = 0">Reset</button>
                                <button class="btn btn-secondary" onclick="document.getElementById('offsetMs').value = parseInt(document.getElementById('offsetMs').value) + 100">+100ms</button>
                                <button class="btn btn-secondary" onclick="document.getElementById('offsetMs').value = parseInt(document.getElementById('offsetMs').value) + 1000">+1s</button>
                            </div>
                            <p style="font-size: 0.85rem; color: #9CA3AF; margin-top: 0.5rem;">
                                Positive values = delay subtitles (appear later)<br>
                                Negative values = advance subtitles (appear earlier)
                            </p>
                        </div>
                    </div>

                    <!-- Auto Sync Info -->
                    <div id="autoSyncInfo" style="display: none;">
                        <div class="info-box auto-sync-box">
                            <p id="syncMethodDescription" class="sync-method-description"></p>
                        </div>
                    </div>

                    <button id="startSyncBtn" class="btn btn-primary">
                        <span>⚡</span> Apply Sync
                    </button>
                    <div class="progress-container" id="syncProgress">
                        <div class="progress-bar">
                            <div class="progress-fill" id="syncProgressFill"></div>
                        </div>
                        <div class="progress-text" id="syncProgressText">Syncing subtitles...</div>
                    </div>
                    <div class="log-panel" id="syncLog" aria-live="polite"></div>
                    <div class="status-message" id="syncStatus"></div>
                </div>
            </div>
        </div>

        <!-- Step 4: Preview & Download -->
        <div class="section" id="step4Section" style="display: none;">
            <h2><span class="section-number">4</span> Preview & Download</h2>
            <video id="videoPreview" class="video-preview" controls></video>
            <div class="download-buttons">
                <button id="downloadSyncedBtn" class="btn btn-success">
                    <span>⬇️</span> Download Synced Subtitle
                </button>
                <button id="downloadTranslatedBtn" class="btn btn-success" style="display: none;">
                    <span>⬇️</span> Download Translated Subtitle
                </button>
            </div>
            <div class="status-message" id="translateStatus"></div>
        </div>
    </div>

    <script src="/js/subtitle-menu.js?v=${escapeHtml(appVersion || 'dev')}"></script>
    <script src="/js/combobox.js"></script>
    <script>
        ${quickNavScript()}

        if (window.ComboBox && typeof window.ComboBox.enhanceAll === 'function') {
            window.ComboBox.enhanceAll(document);
        }

        // Configuration and state
        const CONFIG = ${safeJsonSerialize({
            configStr,
            videoId,
            streamFilename,
            videoHash,
            linkedTitle,
            languageMaps,
            geminiApiKey: config.geminiApiKey || '',
            sourceLanguages: config.sourceLanguages || [],
            targetLanguages: config.targetLanguages || []
        })};
        const subtitleMenuTargets = ${JSON.stringify(targetLanguages.map(lang => ({ code: lang, name: getLanguageName(lang) || lang })))};
        let subtitleMenuInstance = null;

        let STATE = {
            streamUrl: null,
            subtitleContent: null,
            selectedSubtitleLang: null,
            selectedSubtitleId: null,
            estimatedDurationMs: null,
            syncedSubtitle: null,
            translatedSubtitle: null,
            activeSyncPlan: null
        };
        const startSyncBtn = document.getElementById('startSyncBtn');
        const startSyncLabel = startSyncBtn ? startSyncBtn.innerHTML : 'Apply Sync';
        let syncInFlight = false;

        const LINKED_META = {
            title: document.getElementById('sync-video-meta-title'),
            subtitle: document.getElementById('sync-video-meta-subtitle')
        };

        const linkedTitleCache = new Map();
        let linkedTitleRequestId = 0;

        const instructionsEls = {
            overlay: document.getElementById('syncInstructionsModal'),
            help: document.getElementById('syncHelp'),
            close: document.getElementById('closeSyncInstructions'),
            gotIt: document.getElementById('gotItSyncInstructions'),
            dontShow: document.getElementById('dontShowSyncInstructions')
        };
        const SYNC_INSTRUCTIONS_KEY = 'submaker_sync_instructions_visited';

        function setInstructionLock(active) {
            document.body.classList.toggle('modal-open', !!active);
        }

        function mountSubtitleMenu() {
            if (!window.SubtitleMenu || typeof window.SubtitleMenu.mount !== 'function') return null;
            try {
                return window.SubtitleMenu.mount({
                    configStr: CONFIG.configStr,
                    videoId: CONFIG.videoId,
                    filename: CONFIG.streamFilename,
                    videoHash: CONFIG.videoHash,
                    targetOptions: subtitleMenuTargets,
                    sourceLanguages: CONFIG.sourceLanguages || [],
                    targetLanguages: CONFIG.targetLanguages || [],
                    languageMaps: CONFIG.languageMaps,
                    getVideoHash: () => CONFIG.videoHash || ''
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
            const changed = (nextVideoId && nextVideoId !== CONFIG.videoId) ||
                (nextFilename && nextFilename !== CONFIG.streamFilename) ||
                (nextHash && nextHash !== CONFIG.videoHash);
            if (!changed) return;

            CONFIG.videoId = nextVideoId || CONFIG.videoId;
            CONFIG.streamFilename = nextFilename || CONFIG.streamFilename;
            CONFIG.videoHash = nextHash || CONFIG.videoHash;

            updateLinkedMeta({
                videoId: CONFIG.videoId,
                filename: CONFIG.streamFilename,
                title: CONFIG.linkedTitle
            });

            if (subtitleMenuInstance && typeof subtitleMenuInstance.updateStream === 'function') {
                subtitleMenuInstance.updateStream({
                    videoId: CONFIG.videoId,
                    filename: CONFIG.streamFilename,
                    videoHash: CONFIG.videoHash
                });
                if (typeof subtitleMenuInstance.prefetch === 'function') {
                    subtitleMenuInstance.prefetch();
                }
            }
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
            try { localStorage.setItem(SYNC_INSTRUCTIONS_KEY, 'true'); } catch (_) {}
        }

        function initInstructions() {
            const hasVisited = (() => {
                try { return localStorage.getItem(SYNC_INSTRUCTIONS_KEY) === 'true'; } catch (_) { return false; }
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

        initInstructions();
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
            configStr: CONFIG.configStr,
            current: { videoId: CONFIG.videoId, filename: CONFIG.streamFilename, videoHash: CONFIG.videoHash },
            labels: { loading: 'Refreshing...', empty: 'No stream yet', error: 'Refresh failed', current: 'Already latest' },
            buildUrl: (payload) => {
                return '/subtitle-sync?config=' + encodeURIComponent(CONFIG.configStr) +
                    '&videoId=' + encodeURIComponent(payload.videoId || '') +
                    '&filename=' + encodeURIComponent(payload.filename || '');
            }
        });

        // Episode change watcher (toast + manual update)
        initStreamWatcher({
            configStr: CONFIG.configStr,
            current: { videoId: CONFIG.videoId, filename: CONFIG.streamFilename, videoHash: CONFIG.videoHash },
            buildUrl: (payload) => {
                return '/subtitle-sync?config=' + encodeURIComponent(CONFIG.configStr) +
                    '&videoId=' + encodeURIComponent(payload.videoId || '') +
                    '&filename=' + encodeURIComponent(payload.filename || '');
            },
            onEpisode: handleStreamUpdate,
            notify: forwardMenuNotification
        });

        // Helper functions
        function updateProgress(fillId, textId, percent, text) {
            document.getElementById(fillId).style.width = percent + '%';
            document.getElementById(textId).textContent = text;
        }

        const dedupeState = { lastText: null, lastTs: 0 };
        function logSync(message, level = 'info') {
            const panel = document.getElementById('syncLog');
            if (!panel) return;
            const now = Date.now();
            // Suppress immediate duplicates to avoid triplicate spam from repeated events.
            if (dedupeState.lastText === message && (now - dedupeState.lastTs) < 800) {
                return;
            }
            dedupeState.lastText = message;
            dedupeState.lastTs = now;
            const entry = document.createElement('div');
            entry.className = 'log-entry ' + level;
            const time = document.createElement('span');
            time.className = 'log-time';
            time.textContent = '[' + new Date().toLocaleTimeString() + ']';
            const text = document.createElement('span');
            text.textContent = ' ' + message;
            entry.appendChild(time);
            entry.appendChild(text);
            panel.insertBefore(entry, panel.firstChild);
            while (panel.childElementCount > 400) {
                panel.removeChild(panel.lastChild);
            }
        }

        function updateEstimatedDuration(content) {
            const estimatedMs = estimateSubtitleDurationMs(content);
            STATE.estimatedDurationMs = estimatedMs;
            const human = formatDurationShort(estimatedMs);
            if (human) {
                logSync('Estimated subtitle runtime (from current subtitle): ' + human, 'info');
            }
            refreshSyncPlanPreview();
        }

        function isHttpUrl(url) {
            try {
                const u = new URL(url);
                return u.protocol === 'http:' || u.protocol === 'https:';
            } catch (_) {
                return false;
            }
        }

        function showStatus(elementId, message, type) {
            const element = document.getElementById(elementId);
            element.textContent = message;
            element.className = 'status-message ' + type;
            element.style.display = 'block';
        }

        function hideStatus(elementId) {
            document.getElementById(elementId).style.display = 'none';
        }

        function enableSection(sectionId) {
            const section = document.getElementById(sectionId);
            section.style.opacity = '1';
            section.style.pointerEvents = 'auto';
        }

        function cleanLinkedName(raw) {
            if (!raw) return '';
            const lastSegment = String(raw).split(${pathSplitRegex}).pop() || '';
            return lastSegment.replace(${extStripRegex}, '').replace(/[._]/g, ' ').trim() || lastSegment;
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

        function formatEpisodeTag(videoId) {
            const parsed = parseVideoId(videoId);
            if (!parsed) return '';
            const s = Number.isFinite(parsed.season) ? 'S' + String(parsed.season).padStart(2, '0') : '';
            const e = Number.isFinite(parsed.episode) ? 'E' + String(parsed.episode).padStart(2, '0') : '';
            return (s || e) ? (s + e) : '';
        }

        async function fetchLinkedTitle(videoId) {
            const parsed = parseVideoId(videoId);
            if (!parsed || !parsed.imdbId) return null;
            const key = parsed.imdbId + ':' + (parsed.type === 'episode' ? 'series' : 'movie');
            if (CONFIG.videoId === videoId && CONFIG.linkedTitle) {
                linkedTitleCache.set(key, CONFIG.linkedTitle);
                return CONFIG.linkedTitle;
            }
            if (linkedTitleCache.has(key)) return linkedTitleCache.get(key);
            const metaUrl = \`https://v3-cinemeta.strem.io/meta/\${parsed.type === 'episode' ? 'series' : 'movie'}/\${encodeURIComponent(parsed.imdbId)}.json\`;
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

        async function updateLinkedMeta(payload = {}) {
            if (!LINKED_META.title || !LINKED_META.subtitle) return;
            const source = {
                videoId: payload.videoId || CONFIG.videoId,
                filename: payload.filename || CONFIG.streamFilename || '',
                title: payload.title || CONFIG.linkedTitle || ''
            };
            const episodeTag = formatEpisodeTag(source.videoId);
            const fallbackTitle = source.title || cleanLinkedName(source.filename) || cleanLinkedName(source.videoId) || 'No stream linked';
            const fallbackDetails = [];
            if (source.title) {
                fallbackDetails.push('Title: ' + source.title);
            } else if (source.videoId) {
                fallbackDetails.push('Video ID: ' + source.videoId);
            }
            if (episodeTag) fallbackDetails.push('Episode: ' + episodeTag);
            if (source.filename) fallbackDetails.push('File: ' + source.filename);
            LINKED_META.title.textContent = fallbackTitle;
            LINKED_META.subtitle.textContent = fallbackDetails.join(' • ') || 'Waiting for a linked stream...';

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

            LINKED_META.title.textContent = fetchedTitle || fallbackTitle;
            LINKED_META.subtitle.textContent = details.join(' • ') || 'Waiting for a linked stream...';
        }

        updateLinkedMeta();

        // SRT parsing and manipulation functions
        function parseSRT(srtContent) {
            const lines = srtContent.trim().split('\\n');
            const subtitles = [];
            let current = {};

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();

                if (!line) {
                    if (current.index) {
                        subtitles.push(current);
                        current = {};
                    }
                    continue;
                }

                if (!current.index && /^\\d+$/.test(line)) {
                    current.index = parseInt(line);
                } else if (line.includes('-->')) {
                    const times = line.split('-->').map(t => t.trim());
                    current.start = parseTime(times[0]);
                    current.end = parseTime(times[1]);
                } else if (current.start !== undefined) {
                    current.text = (current.text || '') + line + '\\n';
                }
            }

            if (current.index) subtitles.push(current);
            return subtitles;
        }

        function parseTime(timeStr) {
            const match = timeStr.match(/(\\d+):(\\d+):(\\d+)[,\\.](\\d+)/);
            if (!match) return 0;
            const hours = parseInt(match[1]);
            const minutes = parseInt(match[2]);
            const seconds = parseInt(match[3]);
            const ms = parseInt(match[4].padEnd(3, '0').substring(0, 3));
            return hours * 3600000 + minutes * 60000 + seconds * 1000 + ms;
        }

        function formatTime(ms) {
            if (ms < 0) ms = 0;
            const hours = Math.floor(ms / 3600000);
            const minutes = Math.floor((ms % 3600000) / 60000);
            const seconds = Math.floor((ms % 60000) / 1000);
            const milliseconds = ms % 1000;

            return \`\${String(hours).padStart(2, '0')}:\${String(minutes).padStart(2, '0')}:\${String(seconds).padStart(2, '0')},\${String(milliseconds).padStart(3, '0')}\`;
        }

        function estimateSubtitleDurationMs(srtContent) {
            try {
                const subs = parseSRT(srtContent || '');
                if (!subs.length) return null;
                const maxEnd = subs.reduce((max, sub) => Math.max(max, sub.end || 0), 0);
                return Number.isFinite(maxEnd) && maxEnd > 0 ? maxEnd : null;
            } catch (_) {
                return null;
            }
        }

        function formatDurationShort(ms) {
            if (!Number.isFinite(ms) || ms <= 0) return null;
            const totalSeconds = Math.round(ms / 1000);
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = totalSeconds % 60;
            if (minutes >= 120) {
                const hours = (minutes / 60).toFixed(1).replace(/\.0$/, '');
                return \`\${hours}h\`;
            }
            if (minutes >= 1) {
                return seconds > 0 ? \`\${minutes}m \${seconds}s\` : \`\${minutes}m\`;
            }
            return \`\${seconds}s\`;
        }

        const AUTO_PRIMARY_MODES = ['alass', 'ffsubsync', 'vosk-ctc', 'whisper-alass'];
        const SYNC_MODE_LIBRARY = {
            alass: {
                description: 'Audio ➜ subtitle anchors via alass-wasm.',
                options: [
                    { value: 'alass-rapid', label: 'Rapid anchors (~8–10%)', description: '4–6 short anchor windows for quick drift locking.', plan: { coverageTargetPct: 0.1, minWindows: 4, maxWindows: 6, windowSeconds: 45, strategy: 'spread', legacyMode: 'fast' }, preferAlass: true },
                    { value: 'alass-balanced', label: 'Balanced anchors (~14–18%)', description: '6–9 windows at ~60s for tougher bitrate shifts.', plan: { coverageTargetPct: 0.16, minWindows: 6, maxWindows: 9, windowSeconds: 60, strategy: 'spread', legacyMode: 'fast' }, preferAlass: true },
                    { value: 'alass-deep', label: 'Deep anchors (~26–32%)', description: '9–14 windows at ~75s for heavy drift/ads.', plan: { coverageTargetPct: 0.28, minWindows: 9, maxWindows: 14, windowSeconds: 75, strategy: 'dense-spread', legacyMode: 'complete' }, preferAlass: true },
                    { value: 'alass-complete', label: 'Complete (full runtime)', description: 'Scan the full runtime with alass anchors.', plan: { coverageTargetPct: 1, strategy: 'full', fullScan: true, legacyMode: 'complete' }, preferAlass: true }
                ]
            },
            ffsubsync: {
                description: 'Audio ➜ subtitle alignment via ffsubsync-wasm.',
                options: [
                    { value: 'ffss-light', label: 'Light scan (~6–8%)', description: '4–6 windows (~60s) to catch obvious drifts quickly.', plan: { coverageTargetPct: 0.08, minWindows: 4, maxWindows: 6, windowSeconds: 60, strategy: 'spread', legacyMode: 'fast' }, preferFfsubsync: true },
                    { value: 'ffss-balanced', label: 'Balanced scan (~12–16%)', description: '6–10 windows (~80s) for mixed drift patterns.', plan: { coverageTargetPct: 0.14, minWindows: 6, maxWindows: 10, windowSeconds: 80, strategy: 'spread', legacyMode: 'fast' }, preferFfsubsync: true },
                    { value: 'ffss-deep', label: 'Deep scan (~22–28%)', description: '9–14 windows (~100s) for aggressive correction.', plan: { coverageTargetPct: 0.24, minWindows: 9, maxWindows: 14, windowSeconds: 100, strategy: 'dense-spread', legacyMode: 'complete' }, preferFfsubsync: true },
                    { value: 'ffss-complete', label: 'Complete (full runtime)', description: 'Full-runtime ffsubsync scan for maximum accuracy.', plan: { coverageTargetPct: 1, strategy: 'full', fullScan: true, legacyMode: 'complete' }, preferFfsubsync: true }
                ]
            },
            'vosk-ctc': {
                description: 'Text ➜ audio (Vosk CTC logits + DTW).',
                options: [
                    { value: 'vosk-light', label: 'Vosk Light (~10–12%)', description: 'Quick CTC/DTW pass for big offsets and broken timings.', plan: { coverageTargetPct: 0.12, minWindows: 4, maxWindows: 7, windowSeconds: 70, strategy: 'spread', legacyMode: 'vosk-light' }, preferCtc: true },
                    { value: 'vosk-balanced', label: 'Vosk Balanced (~16–20%)', description: 'Adds more anchors for ads/drift while staying fast.', plan: { coverageTargetPct: 0.18, minWindows: 6, maxWindows: 9, windowSeconds: 85, strategy: 'spread', legacyMode: 'vosk-balanced' }, preferCtc: true },
                    { value: 'vosk-deep', label: 'Vosk Deep (~26–32%)', description: 'Dense anchors for noisy audio or messy subs.', plan: { coverageTargetPct: 0.28, minWindows: 8, maxWindows: 12, windowSeconds: 95, strategy: 'dense-spread', legacyMode: 'vosk-deep' }, preferCtc: true },
                    { value: 'vosk-complete', label: 'Vosk Complete (full runtime)', description: 'Full-runtime Vosk CTC/DTW alignment when accuracy is critical.', plan: { coverageTargetPct: 1, strategy: 'full', fullScan: true, legacyMode: 'vosk-complete' }, preferCtc: true }
                ]
            },
            'whisper-alass': {
                description: 'Subtitle ➜ subtitle (Whisper transcript + ALASS refine).',
                options: [
                    { value: 'whisper-light', label: 'Light scan (~5–7%)', description: '3–5 Whisper windows (~70s) to sanity-check drift.', plan: { coverageTargetPct: 0.06, minWindows: 3, maxWindows: 5, windowSeconds: 70, strategy: 'spread', legacyMode: 'fast' } },
                    { value: 'whisper-balanced', label: 'Balanced scan (~12–16%)', description: '5–8 windows (~85s) for typical shows with ads.', plan: { coverageTargetPct: 0.14, minWindows: 5, maxWindows: 8, windowSeconds: 85, strategy: 'spread', legacyMode: 'fast' } },
                    { value: 'whisper-deep', label: 'Deep scan (~22–28%)', description: '8–12 windows (~100s) for stubborn drifts.', plan: { coverageTargetPct: 0.26, minWindows: 8, maxWindows: 12, windowSeconds: 100, strategy: 'dense-spread', legacyMode: 'complete' } },
                    { value: 'whisper-complete', label: 'Complete (full runtime)', description: 'Full-runtime transcript + align when you need everything.', plan: { coverageTargetPct: 1, strategy: 'full', fullScan: true, legacyMode: 'complete' } }
                ]
            }
        };
        const PRIMARY_DESCRIPTIONS = {
            manual: '📝 Manual offset: type the millisecond shift you need.',
            alass: '🎯 ALASS anchors the subtitle to audio for fast, offline alignment.',
            ffsubsync: '🎛️ FFSubSync detects drifts/ads directly from the audio waveform.',
            'vosk-ctc': '🧭 Vosk CTC/DTW force-aligns your subtitle text directly to the audio.',
            'whisper-alass': '🗣️ Whisper transcript alignment with an ALASS refinement pass.'
        };
        const PRESET_DESCRIPTIONS = (() => {
            const map = {};
            Object.values(SYNC_MODE_LIBRARY).forEach(group => {
                (group.options || []).forEach(opt => {
                    map[opt.value] = opt.description || '';
                });
            });
            return map;
        })();
        const MIN_WINDOW_SECONDS = 20;
        const MAX_WINDOW_SECONDS = 7200;

        function resolveSecondaryPreset(primaryMode, secondaryPresetValue) {
            const options = (SYNC_MODE_LIBRARY[primaryMode] || {}).options || [];
            if (!options.length) return null;
            return options.find(opt => opt.value === secondaryPresetValue) || options[0];
        }

        function buildSyncPlan(primaryMode, secondaryPresetValue, estimatedDurationMs = null) {
            const preset = resolveSecondaryPreset(primaryMode, secondaryPresetValue);
            if (!preset) return null;
            const durationSeconds = estimatedDurationMs ? Math.max(0, estimatedDurationMs / 1000) : null;
            const targetCoverage = Number.isFinite(preset.plan?.coverageTargetPct)
                ? Math.max(0.01, Math.min(1, preset.plan.coverageTargetPct))
                : Number.isFinite(preset.plan?.coveragePct)
                    ? Math.max(0.01, Math.min(1, preset.plan.coveragePct))
                    : 0.1;

            const minWindows = Number.isFinite(preset.plan?.minWindows) ? preset.plan.minWindows : null;
            const maxWindows = Number.isFinite(preset.plan?.maxWindows) ? preset.plan.maxWindows : null;
            const fullScan = preset.plan?.fullScan === true || preset.plan?.strategy === 'full';

            const minWindow = durationSeconds ? Math.min(MIN_WINDOW_SECONDS, Math.max(durationSeconds, 1)) : MIN_WINDOW_SECONDS;

            let windowSeconds = Number.isFinite(preset.plan?.windowSeconds) ? preset.plan.windowSeconds : null;
            if (windowSeconds != null) {
                windowSeconds = Math.min(Math.max(windowSeconds, minWindow), MAX_WINDOW_SECONDS);
            } else if (durationSeconds && targetCoverage && (minWindows || maxWindows) && !fullScan) {
                const targetCoverageSec = durationSeconds * targetCoverage;
                const divisor = Math.max(1, minWindows || 3);
                windowSeconds = Math.min(Math.max(targetCoverageSec / divisor, minWindow), Math.max(180, minWindow));
            }
            const requestedWindowSeconds = windowSeconds;

            const targetCoveragePct = targetCoverage || 0.1;
            let windowCount = fullScan ? null : (Number.isFinite(preset.plan?.windowCount) ? preset.plan.windowCount : (minWindows || 3));
            let durationAdjusted = false;

            if (durationSeconds && !fullScan) {
                const targetCoverageSeconds = durationSeconds * targetCoveragePct;
                const desiredCount = windowSeconds
                    ? Math.ceil(targetCoverageSeconds / windowSeconds)
                    : (minWindows || 3);
                const bounded = maxWindows ? Math.min(maxWindows, desiredCount) : desiredCount;
                const minBound = minWindows || 1;
                const adjustedCount = Math.max(minBound, bounded);
                if (windowCount !== adjustedCount) durationAdjusted = true;
                windowCount = adjustedCount;
            }

            let coverageSeconds = fullScan ? (durationSeconds || null) : ((windowCount && windowSeconds) ? windowCount * windowSeconds : null);

            const plan = {
                preset: preset.value,
                legacyMode: preset.plan?.legacyMode || preset.value,
                windowCount: fullScan ? null : windowCount,
                windowSeconds: fullScan
                    ? (durationSeconds || preset.plan?.windowSeconds || null)
                    : windowSeconds,
                requestedWindowSeconds,
                coverageSeconds,
                coverageTargetPct: targetCoveragePct,
                durationSeconds,
                minWindows: minWindows || null,
                maxWindows: maxWindows || null,
                strategy: preset.plan?.strategy || (fullScan ? 'full' : 'spread'),
                fullScan,
                durationAdjusted,
                modeGroup: primaryMode
            };

            if (durationSeconds && plan.windowSeconds && plan.windowSeconds > durationSeconds) {
                plan.windowSeconds = durationSeconds;
            }

            return plan;
        }

        function describeSyncPlan(plan) {
            if (!plan) return '';
            if (plan.fullScan) {
                if (plan.windowSeconds) return \`Full runtime (\${Math.round(plan.windowSeconds)}s) scan\`;
                return 'Full runtime scan';
            }
            const parts = [];
            if (plan.windowCount && plan.windowSeconds) {
                parts.push(\`\${plan.windowCount} x \${Math.round(plan.windowSeconds)}s\`);
            } else if (plan.windowCount) {
                parts.push(\`\${plan.windowCount} windows\`);
            }
            if (plan.durationSeconds && plan.coverageSeconds) {
                const pct = Math.min(100, Math.round((plan.coverageSeconds / plan.durationSeconds) * 100));
                parts.push(\`~\${pct}% of detected runtime\`);
            } else if (plan.coverageTargetPct) {
                parts.push(\`~\${Math.round(plan.coverageTargetPct * 100)}% target coverage\`);
            }
            return parts.join(' • ');
        }

        function offsetSubtitles(srtContent, offsetMs) {
            const subtitles = parseSRT(srtContent);
            let result = '';

            for (const sub of subtitles) {
                const newStart = sub.start + offsetMs;
                const newEnd = sub.end + offsetMs;

                result += \`\${sub.index}\\n\`;
                result += \`\${formatTime(newStart)} --> \${formatTime(newEnd)}\\n\`;
                result += sub.text;
                result += '\\n';
            }

            return result.trim();
        }

        // Chrome Extension Communication
        let extensionInstalled = false;
        let pingTimer = null;
        let pingAttempts = 0;
        const MAX_PINGS = 5;
        const extDot = document.getElementById('ext-dot');
        const extLabel = document.getElementById('ext-label');
        const extStatus = document.getElementById('ext-status');
        const EXT_INSTALL_URL = 'https://chromewebstore.google.com/detail/submaker-xsync/lpocanpndchjkkpgchefobjionncknjn?authuser=0&hl=en';
        const primaryModeSelect = document.getElementById('primarySyncMode');
        const secondaryModeSelect = document.getElementById('secondarySyncMode');
        const secondaryModeGroup = document.getElementById('secondaryModeGroup');

        function setAutoSyncAvailability(enabled) {
            const primaryOptions = ['alass', 'ffsubsync', 'vosk-ctc', 'whisper-alass'];
            primaryOptions.forEach((mode) => {
                const opt = primaryModeSelect?.querySelector('option[value="' + mode + '"]');
                if (opt) opt.disabled = !enabled;
            });
            if (secondaryModeSelect) {
                secondaryModeSelect.disabled = !enabled;
            }
        }

        function populateSecondaryOptions(primaryMode) {
            if (!secondaryModeSelect || !secondaryModeGroup) return;
            const opts = (SYNC_MODE_LIBRARY[primaryMode] || {}).options || [];
            if (!opts.length || primaryMode === 'manual') {
                secondaryModeGroup.style.display = 'none';
                secondaryModeSelect.innerHTML = '';
                return;
            }

            const previous = secondaryModeSelect.value;
            secondaryModeSelect.innerHTML = '';
            opts.forEach((opt) => {
                const optionEl = document.createElement('option');
                optionEl.value = opt.value;
                optionEl.textContent = opt.label;
                secondaryModeSelect.appendChild(optionEl);
            });
            const restored = previous && opts.some(o => o.value === previous);
            if (restored) {
                secondaryModeSelect.value = previous;
            } else if (secondaryModeSelect.options.length) {
                secondaryModeSelect.value = secondaryModeSelect.options[0].value;
            }
            secondaryModeGroup.style.display = 'block';
        }

        function resolveEnginePrefs(primaryMode, secondaryPresetValue) {
            const preset = resolveSecondaryPreset(primaryMode, secondaryPresetValue);
            return {
                preferAlass: !!(preset?.preferAlass || primaryMode === 'alass'),
                preferFfsubsync: !!(preset?.preferFfsubsync || primaryMode === 'ffsubsync'),
                preferCtc: !!(preset?.preferCtc || primaryMode === 'vosk-ctc')
            };
        }

        function updateExtensionStatus(ready, text, tone) {
            extensionInstalled = ready;
            const dotTone = ready ? 'ok' : (tone || 'bad');
            if (extDot) extDot.className = 'status-dot ' + dotTone;
            if (extLabel) {
                extLabel.textContent = ready ? (text || 'Ready') : (text || 'Extension not detected');
                if (ready) {
                    extLabel.classList.add('ready');
                    extLabel.removeAttribute('href');
                    extLabel.removeAttribute('target');
                    extLabel.removeAttribute('rel');
                } else {
                    extLabel.classList.remove('ready');
                    extLabel.setAttribute('href', EXT_INSTALL_URL);
                    extLabel.setAttribute('target', '_blank');
                    extLabel.setAttribute('rel', 'noopener noreferrer');
                }
            }
            if (extStatus) extStatus.title = text || '';
        }

        function pingExtension() {
            updateExtensionStatus(false, 'Pinging extension...', 'warn');
            setAutoSyncAvailability(false);
            if (pingTimer) clearInterval(pingTimer);
            pingAttempts = 0;
            const sendPing = () => {
                if (extensionInstalled) return;
                pingAttempts += 1;
                window.postMessage({ type: 'SUBMAKER_PING', source: 'webpage' }, '*');
                if (pingAttempts >= MAX_PINGS && !extensionInstalled) {
                    clearInterval(pingTimer);
                    updateExtensionStatus(false, 'Extension not detected', 'bad');
                }
            };
            sendPing();
            pingTimer = setInterval(sendPing, 2000);
        }

        // Set up message listener FIRST, before sending PING
        window.addEventListener('message', (event) => {
            const msg = event.data || {};
            if (!msg || (msg.source && msg.source !== 'extension')) return;

            switch (msg.type) {
                case 'SUBMAKER_PONG': {
                    extensionInstalled = true;
                    const version = msg.version || '1.0.0';
                    updateExtensionStatus(true, 'Ready (v' + version + ')');
                    logSync('Extension detected (v' + version + ')', 'info');
                    if (pingTimer) clearInterval(pingTimer);

                    setAutoSyncAvailability(true);

                    logSync('Sync engines unlocked (ALASS / FFSubSync / Vosk CTC/DTW / Whisper + ALASS)', 'info');

                    if (primaryModeSelect && primaryModeSelect.value === 'manual') {
                        primaryModeSelect.value = 'whisper-alass';
                    }
                    populateSecondaryOptions(primaryModeSelect?.value || 'whisper-alass');
                    refreshSyncPlanPreview();
                    break;
                }
                case 'SUBMAKER_DEBUG_LOG': {
                    if (msg.messageId && STATE?.activeMessageId && msg.messageId !== STATE.activeMessageId) {
                        break;
                    }
                    logSync(msg.text || 'Log event', msg.level || 'info');
                    break;
                }
                case 'SUBMAKER_SYNC_PROGRESS': {
                    // Progress for the active job is handled by the request-specific listener to avoid duplicates.
                    if (!msg.messageId || !STATE?.activeMessageId || msg.messageId !== STATE.activeMessageId) break;
                    break;
                }
                default:
                    break;
            }
        });

        // Check for extension on page load (single sequence, no retries beyond limit)
        setTimeout(pingExtension, 150);

        // Request sync from Chrome extension
        function requestExtensionSync(streamUrl, subtitleContent, plan = null, preferAlass = false, preferFfsubsync = false, preferCtc = false) {
            return new Promise((resolve, reject) => {
                const messageId = 'sync_' + Date.now();
                const modeToSend = (plan && plan.legacyMode) ? plan.legacyMode : (plan && plan.preset) ? plan.preset : 'smart';
                const planPayload = plan ? {
                    preset: plan.preset,
                    windowCount: plan.windowCount,
                    windowSeconds: plan.windowSeconds,
                    coverageTargetPct: plan.coverageTargetPct,
                    requestedWindowSeconds: plan.requestedWindowSeconds,
                    coverageSeconds: plan.coverageSeconds,
                    durationSeconds: plan.durationSeconds,
                    strategy: plan.strategy,
                    minWindows: plan.minWindows,
                    maxWindows: plan.maxWindows,
                    fullScan: plan.fullScan,
                    durationAdjusted: plan.durationAdjusted
                } : null;
                let timeoutId;
                STATE.activeMessageId = messageId;

                // Listen for response
                const responseHandler = (event) => {
                    if (event.data.type === 'SUBMAKER_SYNC_RESPONSE' &&
                        event.data.messageId === messageId) {
                        window.removeEventListener('message', responseHandler);
                        window.removeEventListener('message', progressHandler);
                        clearTimeout(timeoutId);
                        STATE.activeMessageId = null;
                        resolve(event.data);
                    }
                };

                window.addEventListener('message', responseHandler);

                // Listen for progress updates
                const progressHandler = (event) => {
                    if (event.data.type === 'SUBMAKER_SYNC_PROGRESS' &&
                        event.data.messageId === messageId) {
                        updateProgress('syncProgressFill', 'syncProgressText', event.data.progress, event.data.status);
                        if (event.data.status) {
                            logSync(event.data.status, 'info');
                        }
                    }
                };

                window.addEventListener('message', progressHandler);

                // Send sync request to extension
                window.postMessage({
                    type: 'SUBMAKER_SYNC_REQUEST',
                    messageId,
                    source: 'webpage',
                    data: {
                        streamUrl,
                        subtitleContent,
                        mode: modeToSend,  // Pass mode to extension
                        preset: plan?.preset || modeToSend,
                    plan: planPayload,
                    preferAlass: !!preferAlass,
                    preferFfsubsync: !!preferFfsubsync,
                    preferCtc: !!preferCtc
                }
                }, '*');
                const summary = describeSyncPlan(plan);
                logSync('Sent sync request (' + modeToSend + ')' + (summary ? ' [' + summary + ']' : '') + ' to extension.', 'info');

                // Timeout after 15 minutes (for Complete mode)
                timeoutId = setTimeout(() => {
                    window.removeEventListener('message', responseHandler);
                    window.removeEventListener('message', progressHandler);
                    STATE.activeMessageId = null;
                    reject(new Error('Extension sync timeout'));
                }, 900000);
            });
        }

        // Sync method change handler
        function refreshSyncPlanPreview() {
            const primaryMode = primaryModeSelect ? primaryModeSelect.value : 'manual';
            const manualControls = document.getElementById('manualSyncControls');
            const autoSyncInfo = document.getElementById('autoSyncInfo');
            const syncMethodDesc = document.getElementById('syncMethodDescription');

            if (primaryMode === 'manual') {
                manualControls.style.display = 'block';
                autoSyncInfo.style.display = 'none';
                syncMethodDesc.innerHTML = '';
                STATE.activeSyncPlan = null;
                return;
            }

            manualControls.style.display = 'none';
            autoSyncInfo.style.display = 'block';

            const preset = resolveSecondaryPreset(primaryMode, secondaryModeSelect?.value);
            const plan = buildSyncPlan(primaryMode, preset ? preset.value : null, STATE.estimatedDurationMs);
            STATE.activeSyncPlan = plan || null;

            const summary = describeSyncPlan(plan);
            const primaryDesc = PRIMARY_DESCRIPTIONS[primaryMode] || '';
            const presetDesc = (preset && PRESET_DESCRIPTIONS[preset.value]) || (preset ? preset.description : '');
            const combinedDesc = [primaryDesc, presetDesc].filter(Boolean).join(' ');
            syncMethodDesc.innerHTML = combinedDesc + (summary ? '<div class="plan-summary">Plan: ' + summary + '</div>' : '');
        }

        primaryModeSelect?.addEventListener('change', (e) => {
            populateSecondaryOptions(e.target.value);
            refreshSyncPlanPreview();
        });
        secondaryModeSelect?.addEventListener('change', refreshSyncPlanPreview);

        populateSecondaryOptions(primaryModeSelect?.value || 'manual');
        refreshSyncPlanPreview();

        // Step 1: Continue button
        document.getElementById('continueBtn').addEventListener('click', async () => {
            const streamUrl = document.getElementById('streamUrl').value.trim();

            if (!isHttpUrl(streamUrl)) {
                showStatus('syncStatus', 'Please provide a valid http(s) stream URL (required for autosync).', 'error');
                return;
            }

            // Store stream URL for extension
            STATE.streamUrl = streamUrl;

            // Enable next step
            enableSection('step2Section');
        });

        // Step 2: Select Subtitle
        document.getElementById('subtitleSelect').addEventListener('change', (e) => {
            const option = e.target.selectedOptions[0];
            if (option && option.value) {
                STATE.selectedSubtitleId = option.value;
                STATE.selectedSubtitleLang = option.getAttribute('data-lang');
                const subtitleUrl = option.getAttribute('data-url');

                // Hide source language selector when selecting from dropdown (language is auto-detected)
                document.getElementById('sourceLanguageGroup').style.display = 'none';

                // Fetch subtitle content
                fetch(subtitleUrl.replace('{{ADDON_URL}}', '/addon/' + CONFIG.configStr))
                    .then(res => res.text())
                    .then(content => {
                        STATE.subtitleContent = content;
                        updateEstimatedDuration(content);
                        enableSection('step3Section');
                        console.log('[Subtitle] Loaded from server');
                    })
                    .catch(error => {
                        console.error('[Subtitle] Fetch failed:', error);
                        showStatus('syncStatus', 'Failed to fetch subtitle', 'error');
                    });
            }
        });

        // File upload
        const uploadArea = document.getElementById('uploadArea');
        const fileInput = document.getElementById('fileInput');

        uploadArea.addEventListener('click', () => fileInput.click());

        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('dragover');
        });

        uploadArea.addEventListener('dragleave', () => {
            uploadArea.classList.remove('dragover');
        });

        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('dragover');
            const file = e.dataTransfer.files[0];
            handleSubtitleFile(file);
        });

        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            handleSubtitleFile(file);
        });

        function handleSubtitleFile(file) {
            if (!file || !file.name.endsWith('.srt')) {
                showStatus('syncStatus', 'Please select a valid .srt file', 'error');
                return;
            }

            const reader = new FileReader();
            reader.onload = (e) => {
                STATE.subtitleContent = e.target.result;
                updateEstimatedDuration(STATE.subtitleContent);
                STATE.selectedSubtitleId = 'uploaded_' + Date.now();
                // For uploaded files, clear auto-detected language (user must select)
                STATE.selectedSubtitleLang = null;

                // Show source language selector for uploaded files
                document.getElementById('sourceLanguageGroup').style.display = 'block';

                enableSection('step3Section');
                showStatus('syncStatus', 'Subtitle file loaded: ' + file.name, 'success');
            };
            reader.readAsText(file);
        }

        // Translate checkbox
        document.getElementById('translateAfterSync').addEventListener('change', (e) => {
            document.getElementById('targetLangGroup').style.display = e.target.checked ? 'block' : 'none';
        });

        // Step 3: Start Sync
        function setSyncInFlight(active) {
            syncInFlight = !!active;
            if (startSyncBtn) {
                startSyncBtn.disabled = syncInFlight;
                startSyncBtn.innerHTML = syncInFlight ? 'Syncing...' : startSyncLabel;
            }
        }

        startSyncBtn?.addEventListener('click', async () => {
            if (syncInFlight) return;
            if (!STATE.subtitleContent) {
                showStatus('syncStatus', 'Please select a subtitle first', 'error');
                return;
            }

            const primaryMode = primaryModeSelect ? primaryModeSelect.value : 'manual';
            const secondaryMode = secondaryModeSelect ? secondaryModeSelect.value : null;

            try {
                setSyncInFlight(true);
                document.getElementById('syncProgress').style.display = 'block';
                hideStatus('syncStatus');

                if (primaryMode !== 'manual') {
                    if (!extensionInstalled) {
                        throw new Error('Autosync requires the SubMaker Chrome Extension. Please install/enable it.');
                    }
                    if (!isHttpUrl(STATE.streamUrl || '')) {
                        throw new Error('Autosync requires a valid http(s) stream URL. Please paste it in Step 1.');
                    }
                }

                if (primaryMode === 'manual') {
                    // Manual offset adjustment
                    const offsetMs = parseInt(document.getElementById('offsetMs').value) || 0;

                    updateProgress('syncProgressFill', 'syncProgressText', 50, \`Applying offset: \${offsetMs}ms...\`);

                    // Apply offset to subtitle
                    STATE.syncedSubtitle = offsetSubtitles(STATE.subtitleContent, offsetMs);

                    updateProgress('syncProgressFill', 'syncProgressText', 100, 'Sync complete!');
                } else if (AUTO_PRIMARY_MODES.includes(primaryMode)) {
                    const preset = resolveSecondaryPreset(primaryMode, secondaryMode);
                    if (!preset) {
                        throw new Error('Select a scan profile before starting autosync.');
                    }

                    const modeName = preset.label || (secondaryMode || 'Autosync');
                    const primaryLabel = primaryModeSelect?.selectedOptions?.[0]?.textContent || primaryMode;
                    const prefs = resolveEnginePrefs(primaryMode, preset.value);
                    const syncPlan = buildSyncPlan(primaryMode, preset.value, STATE.estimatedDurationMs);
                    STATE.activeSyncPlan = syncPlan;
                    const planSummary = describeSyncPlan(syncPlan);

                    if (planSummary) {
                        logSync('Plan: ' + planSummary, 'info');
                    }

                    const intro = \`Starting \${modeName} (\${primaryLabel})\${planSummary ? ' [' + planSummary + ']' : ''}...\`;
                    updateProgress('syncProgressFill', 'syncProgressText', 10, intro);

                    // Request audio extraction and sync from extension
                    const syncResult = await requestExtensionSync(
                        STATE.streamUrl,
                        STATE.subtitleContent,
                        syncPlan,
                        prefs.preferAlass,
                        prefs.preferFfsubsync,
                        prefs.preferCtc
                    );

                    if (!syncResult.success) {
                        throw new Error(syncResult.error || 'Extension sync failed');
                    }

                    STATE.syncedSubtitle = syncResult.syncedSubtitle;
                    updateProgress('syncProgressFill', 'syncProgressText', 100, \`\${modeName} complete!\`);
                }

                // Save to cache
                // Extract language code: use manual selection if visible (file upload), otherwise auto-detected (dropdown)
                let sourceLanguage;
                const sourceLanguageGroup = document.getElementById('sourceLanguageGroup');
                if (sourceLanguageGroup && sourceLanguageGroup.style.display !== 'none') {
                    // File was uploaded, use user-selected language
                    sourceLanguage = document.getElementById('sourceLanguage').value;
                } else {
                    // Subtitle selected from dropdown, use auto-detected language
                    sourceLanguage = STATE.selectedSubtitleLang || 'eng';
                }
                await saveSyncedSubtitle(CONFIG.videoHash, sourceLanguage, STATE.selectedSubtitleId, STATE.syncedSubtitle);

                showStatus('syncStatus', 'Subtitle synced successfully!', 'success');

                // Check if translation is needed
                if (document.getElementById('translateAfterSync').checked) {
                    await translateSubtitle();
                }

                // Show preview section
                document.getElementById('step4Section').style.display = 'block';
                document.getElementById('downloadSyncedBtn').style.display = 'inline-flex';

            } catch (error) {
                console.error('[Sync] Error:', error);
                showStatus('syncStatus', 'Sync failed: ' + error.message, 'error');
            } finally {
                setSyncInFlight(false);
                document.getElementById('syncProgress').style.display = 'none';
            }
        });

        // Save synced subtitle to server
        async function saveSyncedSubtitle(videoHash, languageCode, sourceSubId, content) {
            const response = await fetch('/api/save-synced-subtitle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    configStr: CONFIG.configStr,
                    videoHash,
                    languageCode,
                    sourceSubId,
                    content,
                    originalSubId: sourceSubId,
                    metadata: {
                        syncedAt: Date.now(),
                        streamFilename: CONFIG.streamFilename
                    }
                })
            });

            if (!response.ok) {
                throw new Error('Failed to save synced subtitle');
            }

            console.log('[Cache] Synced subtitle saved');
        }

        // Translate subtitle (reusing existing translation API)
        async function translateSubtitle() {
            try {
                const targetLanguage = document.getElementById('targetLanguage').value;
                showStatus('translateStatus', 'Translating subtitle... This may take 1-5 minutes.', 'info');

                const response = await fetch('/api/translate-file', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        content: STATE.syncedSubtitle,
                        targetLanguage,
                        configStr: CONFIG.configStr
                    })
                });

                if (!response.ok) {
                    throw new Error('Translation failed');
                }

                STATE.translatedSubtitle = await response.text();
                showStatus('translateStatus', 'Translation completed!', 'success');
                document.getElementById('downloadTranslatedBtn').style.display = 'inline-flex';

                // Save translated version to cache
                await saveSyncedSubtitle(CONFIG.videoHash, targetLanguage,
                    STATE.selectedSubtitleId + '_translated', STATE.translatedSubtitle);

            } catch (error) {
                console.error('[Translate] Error:', error);
                showStatus('translateStatus', 'Translation failed: ' + error.message, 'error');
            }
        }

        // Download handlers
        document.getElementById('downloadSyncedBtn').addEventListener('click', () => {
            downloadSubtitle(STATE.syncedSubtitle, 'synced_subtitle.srt');
        });

        document.getElementById('downloadTranslatedBtn').addEventListener('click', () => {
            downloadSubtitle(STATE.translatedSubtitle, 'translated_subtitle.srt');
        });

        function downloadSubtitle(content, filename) {
            const blob = new Blob([content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
        }

    </script>
</body>
</html>
    `;
}

module.exports = {
    generateSubtitleSyncPage
};
