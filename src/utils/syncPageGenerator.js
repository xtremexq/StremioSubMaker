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
const { version: appVersion, xsyncMinVersion: REQUIRED_XSYNC_VERSION } = require('../../package.json');
const { quickNavStyles, quickNavScript, renderQuickNav, renderRefreshBadge } = require('./quickNav');
const { buildClientBootstrap, loadLocale, getTranslator } = require('./i18n');

function escapeHtml(text) {
    if (!text) return '';
    return text
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

function buildLinkedMetaSubtitleHtml(topLine, fileLine, fallbackLine) {
    const parts = [];
    if (topLine) parts.push(escapeHtml(topLine));
    if (fileLine) parts.push(`<strong class="meta-file-line">${escapeHtml(fileLine)}</strong>`);
    if (parts.length) return parts.join('<br>');
    return escapeHtml(fallbackLine || '');
}

// Language helpers (mirrors subtitle-menu logic to keep naming consistent)
function normalizeLangKey(val) {
    return (val || '').toString().trim().toLowerCase().replace(/[^a-z]/g, '');
}

function normalizeNameKey(val) {
    return (val || '').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function lookupLanguageName(languageMaps, raw) {
    if (!raw) return null;
    const byCode = languageMaps?.byCode || {};
    const byNameKey = languageMaps?.byNameKey || {};
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

function resolveSubtitleLanguage(sub, languageMaps) {
    const rawLabel = (sub?.language || sub?.lang || sub?.langName || sub?.title || sub?.name || sub?.label || '').toString().trim();
    const code =
        extractLanguageCode(sub?.languageCode) ||
        extractLanguageCode(sub?.lang) ||
        extractLanguageCode(sub?.language) ||
        extractLanguageCode(rawLabel) ||
        extractLanguageCode(sub?.url) ||
        extractLanguageCode(sub?.id);
    const friendly = lookupLanguageName(languageMaps, code) || lookupLanguageName(languageMaps, rawLabel);
    const name = friendly || rawLabel || 'Unknown';
    const key = normalizeLangKey(code || rawLabel || name || 'unknown');
    return {
        code: code || normalizeLangKey(sub?.lang || sub?.language || '') || key,
        name,
        key
    };
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

function buildLinkedVideoLabel(videoId, streamFilename, resolvedTitle, t) {
    const parsed = parseStremioId(videoId);
    const cleanedFilename = streamFilename ? cleanDisplayName(streamFilename) : '';

    const movieTitle = resolvedTitle || cleanedFilename || parsed?.imdbId || parsed?.animeId || streamFilename;

    if (parsed && (parsed.type === 'episode' || parsed.type === 'anime-episode')) {
        const baseTitle = movieTitle || t?.('sync.meta.linkedFallback', {}, 'linked stream') || 'linked stream';
        const suffix = formatEpisodeTag(parsed) || t?.('sync.meta.episodeFallback', {}, 'Episode') || 'Episode';
        return `${baseTitle} - ${suffix}`;
    }

    return movieTitle || t?.('sync.meta.linkedFallback', {}, 'linked stream') || 'linked stream';
}

async function generateSubtitleSyncPage(subtitles, videoId, streamFilename, configStr, config) {
    // Translator must be available before building any UI strings
    const t = getTranslator(config?.uiLanguage || 'en');
    const localeBootstrap = buildClientBootstrap(loadLocale(config?.uiLanguage || 'en'));
    const themeToggleLabel = t('fileUpload.themeToggle', {}, 'Toggle theme');
    const copy = {
        documentTitle: t('sync.documentTitle', {}, 'Subtitles Sync Studio - SubMaker'),
        title: t('sync.title', {}, 'Subtitles Sync Studio'),
        subtitle: t('sync.subtitle', {}, 'Automatically synchronize subtitles with your video using audio analysis'),
        badges: {
            addon: t('sync.badges.addon', {}, 'Addon'),
            extension: t('sync.badges.extension', {}, 'Extension'),
            hash: t('sync.badges.hash', {}, 'Hash'),
            extensionWaiting: t('sync.badges.extensionWaiting', {}, 'Waiting for extension...')
        },
        sectionHeading: t('sync.sectionHeading', {}, 'Link your stream, choose a subtitle, and sync'),
        step1: {
            chip: t('sync.step1.chip', {}, 'Step 1'),
            title: t('sync.step1.title', {}, 'Provide Stream Information'),
            linkedLabel: t('sync.step1.linkedLabel', {}, 'Linked Stream'),
            linkedRefreshTitle: t('toolbox.embedded.videoMeta.refreshTitle', {}, 'Refresh linked stream'),
            streamLabel: t('sync.step1.streamLabel', {}, 'Stream URL:'),
            placeholder: t('sync.step1.placeholder', {}, 'Paste your stream URL here (e.g., http://... or magnet:...)'),
            continue: t('sync.step1.continue', {}, 'Continue to Subtitle Selection')
        },
        step2: {
            chip: t('sync.step2.chip', {}, 'Step 2'),
            title: t('sync.step2.title', {}, 'Select Subtitle to Sync'),
            selectLabel: t('sync.step2.selectLabel', { title: '{title}' }, 'Choose from {title} fetched subtitles:'),
            selectPlaceholder: t('sync.step2.selectPlaceholder', {}, 'Choose a subtitle'),
            loadingPlaceholder: t('sync.step2.loadingPlaceholder', {}, 'Loading subtitles...'),
            emptyPlaceholder: t('sync.step2.emptyPlaceholder', {}, 'No subtitles found'),
            loadFailedPlaceholder: t('sync.step2.loadFailedPlaceholder', {}, 'Failed to load subtitles'),
            uploadTitle: t('sync.step2.uploadTitle', {}, 'Or drag & drop your .srt file here'),
            uploadSubtitle: t('sync.step2.uploadSubtitle', {}, 'Click to browse files'),
            sourceLabel: t('sync.step2.sourceLabel', {}, 'Source Language:'),
            sourcePlaceholder: t('sync.step2.sourcePlaceholder', {}, 'Select source language'),
            translateToggle: t('sync.step2.translateToggle', {}, 'Translate subtitle after syncing'),
            targetLabel: t('sync.step2.targetLabel', {}, 'Target Language:')
        },
        step3: {
            chip: t('sync.step3.chip', {}, 'Step 3'),
            title: t('sync.step3.title', {}, 'Sync Subtitle'),
            primaryLabel: t('sync.step3.primaryLabel', {}, 'Primary Mode:'),
            secondaryLabel: t('sync.step3.secondaryLabel', {}, 'Scan Profile:'),
            primaryOptions: {
                alass: t('sync.step3.primaryOptions.alass', {}, 'ALASS (audio -> subtitle)'),
                ffsubsync: t('sync.step3.primaryOptions.ffsubsync', {}, 'FFSubSync (audio -> subtitle)'),
                vosk: t('sync.step3.primaryOptions.vosk', {}, 'Vosk CTC/DTW (text -> audio)'),
                whisper: t('sync.step3.primaryOptions.whisper', {}, 'Whisper + ALASS (subtitle -> subtitle)')
            },
            start: t('sync.step3.start', {}, 'Apply Sync'),
            startBusy: t('sync.step3.startBusy', {}, 'Syncing...'),
            progress: t('sync.step3.progress', {}, 'Syncing subtitles...'),
            audioTrackLabel: t('toolbox.autoSubs.steps.audioTrackLabel', {}, 'Audio track for transcription'),
            audioTrackHelper: t('toolbox.autoSubs.steps.audioTrackHelper', {}, 'Multiple audio tracks detected. Choose one, then continue.'),
            useTrack: t('toolbox.autoSubs.actions.useTrack', {}, 'Continue with track')
        },
        locks: {
            needContinue: t('sync.locks.needContinue', {}, 'Click Continue to unlock subtitle selection.'),
            needSubtitle: t('sync.locks.needSubtitle', {}, 'Select or upload a subtitle to unlock syncing.')
        },
        step4: {
            title: t('sync.step4.title', {}, 'Preview & Download'),
            downloadSynced: t('sync.step4.downloadSynced', {}, 'Download Synced Subtitle'),
            downloadTranslated: t('sync.step4.downloadTranslated', {}, 'Download Translated Subtitle')
        },
        instructions: {
            help: t('sync.instructions.help', {}, 'Show instructions'),
            title: t('sync.instructions.title', {}, 'Subtitle Sync Instructions'),
            methods: t('sync.instructions.methods', {}, 'Sync Methods'),
            items: {
                fingerprint: t('sync.instructions.items.fingerprint', {}, 'Fast Fingerprint Pre-pass: Coarse ffsubsync fingerprint check to lock the big offset before deeper scans (on by default).'),
                alass: t('sync.instructions.items.alass', {}, 'ALASS (audio -> subtitle): Fast wasm anchors against the audio; pick Rapid/Balanced/Deep/Complete profiles for coverage.'),
                ffsubsync: t('sync.instructions.items.ffsubsync', {}, 'FFSubSync (audio -> subtitle): Drift-aware audio alignment via ffsubsync-wasm; choose a light, balanced, deep, or complete scan.'),
                vosk: t('sync.instructions.items.vosk', {}, 'Vosk CTC/DTW (text -> audio): Force-align your subtitle text directly to audio with Vosk logits + DTW, great for broken timings or big offsets.'),
                whisper: t('sync.instructions.items.whisper', {}, 'Whisper + ALASS (subtitle -> subtitle): Whisper transcript alignment with an ALASS refinement pass; use light/balanced/deep/complete profiles to control scan size.')
            },
            note: t('sync.instructions.note', {}, 'Select a primary engine first, then pick its scan profile. Coverage adapts to the detected runtime so heavy cases can get deeper scans.'),
            dontShow: t('sync.instructions.dontShow', {}, "Don't show this again"),
            gotIt: t('sync.instructions.gotIt', {}, 'Got it'),
            closeAria: t('sync.instructions.closeAria', {}, 'Close instructions')
        },
        toast: {
            title: t('sync.toast.title', {}, 'New stream detected'),
            meta: t('sync.toast.meta', {}, 'A different episode is playing in Stremio.'),
            update: t('sync.toast.update', {}, 'Update'),
            dismiss: t('sync.toast.dismiss', {}, 'Dismiss notification')
        },
        meta: {
            videoIdUnavailable: t('sync.meta.videoIdUnavailable', {}, 'Video ID unavailable'),
            titleLabel: t('sync.meta.titleLabel', {}, 'Title'),
            videoIdLabel: t('sync.meta.videoIdLabel', {}, 'Video ID'),
            episodeLabel: t('sync.meta.episodeLabel', {}, 'Episode'),
            fileLabel: t('sync.meta.fileLabel', {}, 'File'),
            waiting: t('sync.meta.waiting', {}, 'Waiting for a linked stream...'),
            noStream: t('sync.meta.noStream', {}, 'No stream linked'),
            linkedFallback: t('sync.meta.linkedFallback', {}, 'linked stream'),
            episodeFallback: t('sync.meta.episodeFallback', {}, 'Episode')
        }
    };

    const videoHash = deriveVideoHash(streamFilename, videoId);
    const parsedVideoId = parseStremioId(videoId);
    const episodeTag = formatEpisodeTag(parsedVideoId);
    // Avoid blocking first paint on remote metadata lookups.
    // Client-side hydration will resolve the linked title asynchronously.
    const linkedTitle = null;
    const linkedVideoDisplay = buildLinkedVideoLabel(videoId, streamFilename, linkedTitle, t);
    const linkedVideoLabel = escapeHtml(linkedVideoDisplay);
    const initialVideoTitle = escapeHtml(linkedTitle || buildLinkedVideoLabel(videoId, streamFilename, null, t));
    const subtitleDetailsTop = [];
    const hasInitialContext = !!(videoId || streamFilename || linkedTitle);
    if (videoId) subtitleDetailsTop.push(`${copy.meta.videoIdLabel}: ${videoId}`);
    if (linkedTitle) subtitleDetailsTop.push(`${copy.meta.titleLabel}: ${linkedTitle}`);
    if (hasInitialContext) subtitleDetailsTop.push(`${copy.meta.episodeLabel}: ${episodeTag || '-'}`);
    const subtitleDetailsBottom = streamFilename ? `${copy.meta.fileLabel}: ${cleanDisplayName(streamFilename)}` : '';
    const initialVideoSubtitle = buildLinkedMetaSubtitleHtml(subtitleDetailsTop.join(' | '), subtitleDetailsBottom, copy.meta.videoIdUnavailable);
    const links = {
        translateFiles: `/file-upload?config=${encodeURIComponent(configStr || '')}&videoId=${encodeURIComponent(videoId || '')}`,
        syncSubtitles: `/subtitle-sync?config=${encodeURIComponent(configStr || '')}&videoId=${encodeURIComponent(videoId || '')}&filename=${encodeURIComponent(streamFilename || '')}`,
        embeddedSubs: `/embedded-subtitles?config=${encodeURIComponent(configStr || '')}&videoId=${encodeURIComponent(videoId || '')}&filename=${encodeURIComponent(streamFilename || '')}`,
        automaticSubs: `/auto-subtitles?config=${encodeURIComponent(configStr || '')}&videoId=${encodeURIComponent(videoId || '')}&filename=${encodeURIComponent(streamFilename || '')}`,
        subToolbox: `/sub-toolbox?config=${encodeURIComponent(configStr || '')}&videoId=${encodeURIComponent(videoId || '')}&filename=${encodeURIComponent(streamFilename || '')}`,
        smdb: `/smdb?config=${encodeURIComponent(configStr || '')}&videoId=${encodeURIComponent(videoId || '')}&filename=${encodeURIComponent(streamFilename || '')}`,
        configure: `/configure?config=${encodeURIComponent(configStr || '')}`,
        history: `/sub-history?config=${encodeURIComponent(configStr || '')}&videoId=${encodeURIComponent(videoId || '')}&filename=${encodeURIComponent(streamFilename || '')}`
    };
    const devMode = (config || {}).devMode === true;
    const languageMaps = buildLanguageLookupMaps();

    // Filter out action buttons and cached entries to show only fetchable provider subtitles
    // Filter out action buttons (legacy and new Sub Toolbox) so only real subtitles are selectable
    const fetchableSubtitles = subtitles.filter(sub => {
        const id = sub?.id || '';
        return id !== 'sync_subtitles' &&
            id !== 'file_upload' &&
            id !== 'sub_toolbox' &&
            !id.startsWith('translate_') &&
            !id.startsWith('xsync_') &&
            !id.startsWith('auto_');
    });

    // Group subtitles by language
    const subtitlesByLang = new Map();
    for (const sub of fetchableSubtitles) {
        const langInfo = resolveSubtitleLanguage(sub, languageMaps);
        const groupKey = langInfo.key || normalizeLangKey(sub.lang) || 'unknown';
        const langLabel = langInfo.name || sub.lang || 'Unknown';
        const langCode = (sub.lang || sub.language || langInfo.code || groupKey || 'unknown').toString();

        if (!subtitlesByLang.has(groupKey)) {
            subtitlesByLang.set(groupKey, { label: langLabel, code: langCode, items: [] });
        }
        subtitlesByLang.get(groupKey).items.push({ entry: sub, langInfo: { ...langInfo, code: langCode } });
    }

    // Generate subtitle options HTML
    let subtitleOptionsHTML = '';
    if (subtitlesByLang.size === 0) {
        subtitleOptionsHTML = `<option value="" disabled selected>${escapeHtml(copy.step2.loadingPlaceholder)}</option>`;
    } else {
        subtitleOptionsHTML = `<option value="" disabled selected>${escapeHtml(copy.step2.selectPlaceholder)}</option>`;
        for (const { label, code, items } of subtitlesByLang.values()) {
            const langLabel = label || 'Unknown';
            subtitleOptionsHTML += `
                <optgroup label="${escapeHtml(langLabel)}">`;
            for (let i = 0; i < items.length; i++) {
                const sub = items[i].entry;
                const langCode = items[i].langInfo?.code || code || langLabel || 'unknown';
                const displayName = t('sync.step2.subtitleOption', { language: langLabel, index: i + 1 }, `${langLabel} - Subtitle #${i + 1}`);
                subtitleOptionsHTML += `
                    <option value="${escapeHtml(sub.id)}" data-lang="${escapeHtml(langCode)}" data-url="${escapeHtml(sub.url)}">${escapeHtml(displayName)}</option>`;
            }
            subtitleOptionsHTML += `
                </optgroup>`;
        }
    }

    // Generate language options for source (ALL languages for file upload case)
    const allAvailableLanguages = getAllLanguages();
    let allLangOptionsHTML = `<option value="" disabled selected>${escapeHtml(copy.step2.sourcePlaceholder)}</option>`;
    for (const { code, name } of allAvailableLanguages) {
        allLangOptionsHTML += `<option value="${escapeHtml(code)}">${escapeHtml(name)}</option>`;
    }

    // Generate language options for target
    const sourceLanguages = config.sourceLanguages || ['eng'];
    // Include source languages in target list so "same language" sync is always available
    const targetLanguages = [...new Set([...(config.targetLanguages || ['spa', 'fra', 'por']), ...sourceLanguages])];

    let targetLangOptionsHTML = '';
    for (const lang of targetLanguages) {
        const langName = getLanguageName(lang);
        targetLangOptionsHTML += `<option value="${escapeHtml(lang)}">${escapeHtml(langName)}</option>`;
    }
    const selectLabelText = t('sync.step2.selectLabel', { title: linkedVideoDisplay }, `Choose from ${linkedVideoDisplay} fetched subtitles:`);
    const selectLabelHtml = escapeHtml(selectLabelText).replace(escapeHtml(linkedVideoDisplay), `<strong>${linkedVideoLabel}</strong>`);

    // Preserve backslashes when embedding regex literals inside the generated page script
    const pathSplitRegex = String.raw`/[\\/]/`;
    const extStripRegex = String.raw`/\.[a-z0-9]{2,4}$/i`;

    return `
<!DOCTYPE html>
<html lang="${resolveUiLang(config)}" data-third-theme="true-dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${localeBootstrap}
    <title>${escapeHtml(copy.documentTitle)}</title>
    <!-- Favicon -->
    <link rel="icon" type="image/svg+xml" href="/favicon-toolbox.svg">
    <link rel="shortcut icon" href="/favicon-toolbox.svg">
    <link rel="apple-touch-icon" href="/favicon-toolbox.svg">
    <link rel="stylesheet" href="/css/combobox.css">
    <script>
      (function() {
        var html = document.documentElement;
        var thirdTheme = html.getAttribute('data-third-theme') === 'true-dark' ? 'true-dark' : 'blackhole';
        var theme = 'light';
        var saved = null;
        try { saved = localStorage.getItem('theme'); } catch (_) {}
        if (saved === 'blackhole' || saved === 'true-dark') {
          theme = thirdTheme;
        } else if (saved === 'light' || saved === 'dark') {
          theme = saved;
        } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
          theme = 'dark';
        }
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
        .notice {
            margin-top: 10px;
            padding: 12px;
            border-radius: 12px;
            background: rgba(8,164,213,0.12);
            border: 1px solid rgba(8,164,213,0.25);
            color: var(--text);
            font-weight: 700;
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
        .xsync-version-warning {
            margin: 10px auto 0;
            width: min(980px, 100%);
            border-radius: 12px;
            border: 1px solid rgba(245, 158, 11, 0.45);
            background: rgba(245, 158, 11, 0.14);
            color: var(--text-primary);
            font-weight: 700;
            padding: 10px 14px;
            text-align: center;
            box-shadow: 0 8px 24px rgba(245, 158, 11, 0.16);
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
            position: relative;
            overflow: hidden;
            transition: border-color 0.25s ease, box-shadow 0.25s ease, transform 0.25s ease;
        }

        .step-card.locked {
            opacity: 0.55;
        }

        .step-card.locked::after {
            content: attr(data-locked-label);
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
            padding: 1rem;
            background: rgba(255, 255, 255, 0.76);
            color: var(--muted);
            font-weight: 700;
            letter-spacing: -0.01em;
            pointer-events: all;
            z-index: 5;
        }

        [data-theme="dark"] .step-card.locked::after,
        [data-theme="true-dark"] .step-card.locked::after {
            background: rgba(10, 12, 22, 0.78);
            color: #d5def3;
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
            cursor: pointer;
            user-select: none;
        }

        .offset-headline {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 0.75rem;
            flex-wrap: wrap;
        }

        .offset-summary {
            font-weight: 700;
            color: var(--text-primary);
        }

        .offset-hint {
            color: var(--text-secondary);
            font-size: 0.85rem;
            text-align: right;
        }

        .offset-nudges {
            display: flex;
            gap: 0.35rem;
            flex-wrap: wrap;
            justify-content: flex-end;
        }

        .checkbox-group input[type="checkbox"] {
            width: 20px;
            height: 20px;
            cursor: pointer;
            accent-color: var(--primary);
        }

        .checkbox-group span {
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

        #hashStatus {
            margin-top: 0;
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

        .status-message.warn {
            background: rgba(249, 115, 22, 0.1);
            border: 1px solid rgba(249, 115, 22, 0.25);
            color: var(--text-primary);
            text-align: center;
        }
        .hash-mismatch-alert {
            margin-top: 10px;
            padding: 10px 12px;
            border-radius: 12px;
            border: 1px solid rgba(239,68,68,0.35);
            background: rgba(239,68,68,0.08);
            color: #7f1d1d;
            font-weight: 700;
            font-size: 14px;
            box-shadow: 0 8px 22px rgba(239,68,68,0.12);
            display: none;
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
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            width: 100%;
        }
        .hash-mismatch-alert .alert-body {
            font-size: 13px;
            font-weight: 600;
            line-height: 1.4;
            display: flex;
            flex-direction: column;
            gap: 4px;
            text-align: center;
            color: #7f1d1d;
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
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--muted);
            margin: 0 0 4px;
            font-weight: 700;
        }

        .linked-stream-refresh {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 22px;
            height: 22px;
            padding: 0;
            border: 1px solid var(--border);
            border-radius: 6px;
            background: var(--surface);
            color: var(--muted);
            font-size: 13px;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.2s ease;
            line-height: 1;
        }

        .linked-stream-refresh:hover {
            background: var(--surface-light);
            border-color: var(--primary);
            color: var(--primary);
            transform: scale(1.05);
        }

        .linked-stream-refresh:active {
            transform: scale(0.95);
        }

        .linked-stream-refresh.spinning {
            animation: spin 0.8s linear infinite;
        }

        .linked-stream-refresh:disabled {
            opacity: 0.5;
            cursor: not-allowed;
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
            white-space: pre-line;
        }

        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
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

        .sync-audio-track-prompt {
            display: none;
            margin: 0.75rem 0 1rem;
            padding: 0.85rem;
            border: 1px solid var(--border);
            border-radius: 12px;
            background: var(--surface-light);
        }

        .sync-audio-track-prompt.show {
            display: block;
        }

        .sync-audio-track-prompt p {
            margin: 0.35rem 0 0.6rem;
            color: var(--text-secondary);
            font-size: 0.9rem;
        }

        .sync-audio-track-controls {
            display: flex;
            align-items: center;
            gap: 0.6rem;
            flex-wrap: wrap;
        }

        .sync-audio-track-controls select {
            flex: 1 1 260px;
            min-width: 220px;
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
    ${themeToggleMarkup(themeToggleLabel)}
    <button class="help-button mario" id="syncHelp" title="${escapeHtml(copy.instructions.help)}">?</button>
    <div class="modal-overlay" id="syncInstructionsModal" role="dialog" aria-modal="true" aria-labelledby="syncInstructionsTitle">
        <div class="modal">
            <div class="modal-header">
                <h2 id="syncInstructionsTitle">${escapeHtml(copy.instructions.title)}</h2>
                <div class="modal-close" id="closeSyncInstructions" role="button" aria-label="${escapeHtml(copy.instructions.closeAria)}">&times;</div>
            </div>
            <div class="modal-content">
                <h3>${escapeHtml(copy.instructions.methods)}</h3>
                <ol>
                    <li>${escapeHtml(copy.instructions.items.fingerprint)}</li>
                    <li>${escapeHtml(copy.instructions.items.alass)}</li>
                    <li>${escapeHtml(copy.instructions.items.ffsubsync)}</li>
                    <li>${escapeHtml(copy.instructions.items.vosk)}</li>
                    <li>${escapeHtml(copy.instructions.items.whisper)}</li>
                </ol>
                <p>${escapeHtml(copy.instructions.note)}</p>
            </div>
            <div class="modal-footer">
                <label class="modal-checkbox">
                    <input type="checkbox" id="dontShowSyncInstructions">
                    ${escapeHtml(copy.instructions.dontShow)}
                </label>
                <button type="button" class="btn" id="gotItSyncInstructions">${escapeHtml(copy.instructions.gotIt)}</button>
            </div>
        </div>
    </div>
    <div id="episodeToast" class="episode-toast" role="status" aria-live="polite">
        <div class="icon">!</div>
        <div class="content">
            <p class="title" id="episodeToastTitle">${escapeHtml(copy.toast.title)}</p>
            <p class="meta" id="episodeToastMeta">${escapeHtml(copy.toast.meta)}</p>
        </div>
        <button class="close" id="episodeToastDismiss" type="button" aria-label="${escapeHtml(copy.toast.dismiss)}">×</button>
        <button class="action" id="episodeToastUpdate" type="button">${escapeHtml(copy.toast.update)}</button>
    </div>
    ${renderQuickNav(links, 'syncSubtitles', false, devMode, t)}
    <div class="page">
        <header class="masthead">
            <div class="page-hero">
                <div class="page-icon">⏱️</div>
                <h1 class="page-heading">${escapeHtml(copy.title)}</h1>
                <p class="page-subtitle">${escapeHtml(copy.subtitle)}</p>
            </div>
            <div class="badge-row">
                ${renderRefreshBadge(t)}
                <div class="status-badge">
                    <span class="status-dot ok"></span>
                    <div class="status-labels">
                        <span class="label-eyebrow">${escapeHtml(copy.badges.addon)}</span>
                        <strong>v${escapeHtml(appVersion || 'n/a')}</strong>
                    </div>
                </div>
                <div class="status-badge" id="ext-status">
                    <span class="status-dot warn pulse" id="ext-dot"></span>
                    <div class="status-labels">
                        <span class="label-eyebrow">${escapeHtml(copy.badges.extension)}</span>
                        <a id="ext-label" class="ext-link" href="https://chromewebstore.google.com/detail/submaker-xsync/lpocanpndchjkkpgchefobjionncknjn" target="_blank" rel="noopener noreferrer">${escapeHtml(copy.badges.extensionWaiting)}</a>
                    </div>
                </div>
                <div class="status-badge">
                    <span class="status-dot ok"></span>
                    <div class="status-labels">
                        <span class="label-eyebrow">${escapeHtml(copy.badges.hash)}</span>
                        <strong>${escapeHtml(videoHash || 'pending')}</strong>
                    </div>
                </div>
            </div>
        </header>
        <div id="xsync-version-warning" class="xsync-version-warning" style="display:none;" role="status" aria-live="polite"></div>

        <!-- Steps 1-3: Combined Flow -->
        <div class="section" id="syncFlowSection">
            <h2 class="section-heading section-centered"><span class="section-number">1-3</span> ${escapeHtml(copy.sectionHeading)}</h2>
            <div class="step-grid">
                <div class="step-card" id="step1Section">
                    <div class="step-title">
                        <span class="step-chip">${escapeHtml(copy.step1.chip)}</span>
                        <span>${escapeHtml(copy.step1.title)}</span>
                    </div>
                    <div class="video-meta">
                        <p class="video-meta-label">
                            <span>${escapeHtml(copy.step1.linkedLabel)}</span>
                            <button type="button" class="linked-stream-refresh" id="linkedStreamRefresh" title="${escapeHtml(copy.step1.linkedRefreshTitle)}">⟳</button>
                        </p>
                        <p class="video-meta-title" id="sync-video-meta-title">${initialVideoTitle}</p>
                        <p class="video-meta-subtitle" id="sync-video-meta-subtitle">${initialVideoSubtitle}</p>
                    </div>
                    <div class="form-group">
                        <label for="streamUrl">${escapeHtml(copy.step1.streamLabel)}</label>
                        <input type="text" id="streamUrl" placeholder="${escapeHtml(copy.step1.placeholder)}" value="">
                    </div>
                    <div class="hash-mismatch-alert" id="hashMismatchAlert" role="status" aria-live="polite"></div>
                    <button id="continueBtn" class="btn btn-primary">
                        <span>➡️</span> ${escapeHtml(copy.step1.continue)}
                    </button>
                </div>

                <div class="step-card locked" id="step2Section" data-locked-label="${escapeHtml(copy.locks.needContinue)}">
                    <div class="step-title">
                        <span class="step-chip">${escapeHtml(copy.step2.chip)}</span>
                        <span>${escapeHtml(copy.step2.title)}</span>
                    </div>
                    <div class="form-group">
                        <label>${selectLabelHtml}</label>
                        <select id="subtitleSelect" class="subtitle-list">
                            ${subtitleOptionsHTML}
                        </select>
                    </div>
                    <div class="upload-area" id="uploadArea">
                        <p>${escapeHtml(copy.step2.uploadTitle)}</p>
                        <p style="font-size: 0.85rem; color: #9CA3AF; margin-top: 0.5rem;">${escapeHtml(copy.step2.uploadSubtitle)}</p>
                        <input type="file" id="fileInput" accept=".srt" style="display: none;">
                    </div>
                    <div class="form-group" id="sourceLanguageGroup" style="display: none;">
                        <label for="sourceLanguage">${escapeHtml(copy.step2.sourceLabel)}</label>
                        <select id="sourceLanguage">
                            ${allLangOptionsHTML}
                        </select>
                    </div>
                    <label class="checkbox-group" for="translateAfterSync">
                        <input type="checkbox" id="translateAfterSync">
                        <span>${escapeHtml(copy.step2.translateToggle)}</span>
                    </label>
                    <div class="form-group" id="targetLangGroup" style="display: none; margin-top: 1rem;">
                        <label for="targetLanguage">${escapeHtml(copy.step2.targetLabel)}</label>
                        <select id="targetLanguage">
                            ${targetLangOptionsHTML}
                        </select>
                        <p class="label-description" id="syncAddTargetsHint" style="display:none; margin-top: 0.35rem;">
                            ${escapeHtml(t('sync.step3.options.addTargets', {}, 'Add target languages in Configure to enable translation outputs.'))}
                        </p>
                    </div>
                </div>
            </div>
        </div>

        <div class="section step3-section">
            <div class="step3-wrapper">
                <div class="step-card step3-standalone locked" id="step3Section" data-locked-label="${escapeHtml(copy.locks.needContinue)}">
                    <div class="step-title">
                        <span class="step-chip">${escapeHtml(copy.step3.chip)}</span>
                        <span>${escapeHtml(copy.step3.title)}</span>
                    </div>

                    <div class="form-group">
                        <label for="primarySyncMode">${escapeHtml(copy.step3.primaryLabel)}</label>
                        <select id="primarySyncMode">
                            <option value="alass" selected disabled>${escapeHtml(copy.step3.primaryOptions.alass)}</option>
                            <option value="ffsubsync" disabled>${escapeHtml(copy.step3.primaryOptions.ffsubsync)}</option>
                            <option value="vosk-ctc" disabled>${escapeHtml(copy.step3.primaryOptions.vosk)}</option>
                            <option value="whisper-alass" disabled>${escapeHtml(copy.step3.primaryOptions.whisper)}</option>
                        </select>
                    </div>

                    <div class="form-group" id="secondaryModeGroup" style="display: none;">
                        <label for="secondarySyncMode">${escapeHtml(copy.step3.secondaryLabel)}</label>
                        <select id="secondarySyncMode"></select>
                    </div>

                    <!-- Auto Sync Info -->
                    <div id="autoSyncInfo">
                    <div class="info-box auto-sync-box">
                        <p id="syncMethodDescription" class="sync-method-description"></p>
                    </div>
                </div>
                    <div class="form-group" id="fingerprintPrepassGroup" style="display: none;">
                        <label class="modal-checkbox" style="display: flex; align-items: flex-start; gap: 0.5rem;">
                            <input type="checkbox" id="useFingerprintPrepass" checked>
                            <span>
                                <strong>${escapeHtml(t('sync.auto.fingerprintLabel', {}, 'Fast fingerprint pre-pass (recommended)'))}</strong><br>
                                ${escapeHtml(t('sync.auto.fingerprintDescription', {}, 'Runs a quick ffsubsync coarse offset pass on the first audio windows before your selected engine. Disable only if the audio is muted, heavily trimmed, or you want to skip the extra hop.'))}
                            </span>
                        </label>
                    </div>

                    <div class="sync-audio-track-prompt" id="syncTrackPrompt">
                        <label for="syncAudioTrack">${escapeHtml(copy.step3.audioTrackLabel)}</label>
                        <p id="syncTrackHelper">${escapeHtml(copy.step3.audioTrackHelper)}</p>
                        <div class="sync-audio-track-controls">
                            <select id="syncAudioTrack"></select>
                            <button class="btn" type="button" id="syncTrackContinue">${escapeHtml(copy.step3.useTrack)}</button>
                        </div>
                    </div>

                <button id="startSyncBtn" class="btn btn-primary">
                        <span>⚡</span> ${escapeHtml(copy.step3.start)}
                    </button>
                    <div class="progress-container" id="syncProgress">
                        <div class="progress-bar">
                            <div class="progress-fill" id="syncProgressFill"></div>
                        </div>
                        <div class="progress-text" id="syncProgressText">${escapeHtml(copy.step3.progress)}</div>
                    </div>
                    <div class="log-panel" id="syncLog" aria-live="polite"></div>
                    <div class="status-message" id="syncStatus"></div>
                    <div class="download-buttons">
                        <button id="downloadSyncedBtn" class="btn btn-success" style="display: none;">
                            <span>⬇️</span> ${escapeHtml(copy.step4.downloadSynced)}
                        </button>
                        <button id="downloadTranslatedBtn" class="btn btn-success" style="display: none;">
                            <span>⬇️</span> ${escapeHtml(copy.step4.downloadTranslated)}
                        </button>
                    </div>
                    <div class="status-message" id="translateStatus"></div>
                </div>
            </div>
        </div>
    </div>

    <script src="/js/subtitle-menu.js?v=${escapeHtml(appVersion || 'dev')}"></script>
    <script src="/js/combobox.js"></script>
    <script>
        ${quickNavScript()}

        const tt = (key, vars, fallback) => {
            try {
                return window.t ? window.t(key, vars, fallback) : (fallback || key);
            } catch (_) {
                return fallback || key;
            }
        };

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
        const PAGE = {
            configStr: CONFIG.configStr || '',
            videoId: CONFIG.videoId || '',
            filename: CONFIG.streamFilename || '',
            videoHash: CONFIG.videoHash || ''
        };
        // Runtime copy object for safe client-side fallback strings.
        // Prevents ReferenceError if any client code path references copy.*.
        const copy = ${safeJsonSerialize(copy)};
        const subtitleMenuTargets = ${JSON.stringify(targetLanguages.map(lang => ({ code: lang, name: getLanguageName(lang) || lang })))};
        const hashStatusEl = document.getElementById('hashStatus');
        const hashMismatchEl = document.getElementById('hashMismatchAlert');
        const lockReasons = {
            needContinue: ${JSON.stringify(copy.locks.needContinue)},
            needSubtitle: ${JSON.stringify(copy.locks.needSubtitle)}
        };
        const subtitleUi = {
            selectPlaceholder: ${JSON.stringify(copy.step2.selectPlaceholder)},
            loadingPlaceholder: ${JSON.stringify(copy.step2.loadingPlaceholder)},
            emptyPlaceholder: ${JSON.stringify(copy.step2.emptyPlaceholder)},
            loadFailedPlaceholder: ${JSON.stringify(copy.step2.loadFailedPlaceholder)}
        };
        const subtitleLoadState = {
            requestId: 0,
            prefetchSig: '',
            prefetchPromise: null
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
        function normalizeStreamContext(payload = {}) {
            const videoId = (payload.videoId ?? CONFIG.videoId ?? '').toString().trim();
            const filename = (payload.filename ?? CONFIG.streamFilename ?? '').toString().trim();
            return { videoId, filename };
        }
        function subtitleContextSig(payload = {}) {
            const ctx = normalizeStreamContext(payload);
            return ctx.videoId + '::' + ctx.filename;
        }
        function startSubtitlePrefetch(payload = {}, options = {}) {
            const force = !!options.force;
            const ctx = normalizeStreamContext(payload);
            const sig = subtitleContextSig(ctx);

            if (!ctx.videoId) {
                subtitleLoadState.prefetchSig = sig;
                subtitleLoadState.prefetchPromise = Promise.resolve({ success: true, subtitles: [] });
                return subtitleLoadState.prefetchPromise;
            }

            if (!force && subtitleLoadState.prefetchPromise && subtitleLoadState.prefetchSig === sig) {
                return subtitleLoadState.prefetchPromise;
            }

            const query = new URLSearchParams({
                config: CONFIG.configStr || '',
                videoId: ctx.videoId,
                filename: ctx.filename || ''
            });
            subtitleLoadState.prefetchSig = sig;
            subtitleLoadState.prefetchPromise = fetch('/api/subtitle-sync/subtitles?' + query.toString(), { cache: 'no-store' })
                .then((resp) => {
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    return resp.json();
                });
            return subtitleLoadState.prefetchPromise;
        }
        function resetSubtitleSelectionState() {
            const subtitleSelect = document.getElementById('subtitleSelect');
            if (subtitleSelect) {
                subtitleSelect.disabled = true;
                subtitleSelect.innerHTML = '<option value=\"\" disabled selected>' + escapeHtmlClient(subtitleUi.loadingPlaceholder) + '</option>';
            }
            STATE.selectedSubtitleId = null;
            STATE.selectedSubtitleLang = null;
            STATE.subtitleContent = null;
            lockSection('step3Section', lockReasons.needSubtitle);
        }
        // Kick off subtitle fetch immediately on page load so step 2 is warm by the time user confirms step 1.
        startSubtitlePrefetch();
        function buildMetaSubtitleHtml(topLine, fileLine, fallbackLine) {
            const parts = [];
            if (topLine) parts.push(escapeHtmlClient(topLine));
            if (fileLine) parts.push('<strong class="meta-file-line">' + escapeHtmlClient(fileLine) + '</strong>');
            if (parts.length) return parts.join('<br>');
            return escapeHtmlClient(fallbackLine || '');
        }
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
            if (!hashMismatchEl) return;
            if (!message) {
                hashMismatchEl.style.display = 'none';
                hashMismatchEl.innerHTML = '';
                return;
            }
            hashMismatchEl.innerHTML = message;
            hashMismatchEl.style.display = 'block';
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
                // Escape backslashes so the generated script keeps the regex literal intact
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
            const S21 = 5, S22 = 9, S23 = 14, S24 = 20;
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
            return (wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)).toLowerCase();
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
                // First, check for explicit filename-type params (these are reliable)
                const explicitParams = ['filename', 'file', 'download', 'dn'];
                for (const key of explicitParams) {
                    const val = url.searchParams.get(key);
                    if (val && val.trim()) return decodeURIComponent(val.trim().split('/').pop());
                }
                // Next, check pathname for a real filename (has extension)
                const parts = (url.pathname || '').split('/').filter(Boolean);
                if (parts.length) {
                    const lastPart = decodeURIComponent(parts[parts.length - 1]);
                    // If it looks like a real filename (has extension), use it
                    if (/\.[a-z0-9]{2,5}$/i.test(lastPart)) {
                        return lastPart;
                    }
                }
                // Then check 'name' param as fallback (often just title, not filename)
                const nameVal = url.searchParams.get('name');
                if (nameVal && nameVal.trim()) {
                    return decodeURIComponent(nameVal.trim().split('/').pop());
                }
                // Last resort: return pathname last part even without extension
                if (parts.length) {
                    return decodeURIComponent(parts[parts.length - 1]);
                }
                return '';
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
                const paramKeys = ['videoId', 'video', 'id', 'mediaid', 'imdb', 'tmdb', 'kitsu', 'anidb', 'mal', 'myanimelist', 'anilist', 'tvdb', 'simkl', 'livechart', 'anisearch'];
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
            return { hash, filename, videoId: streamVideoId, source: 'stream-url' };
        }

        function collectHashCandidates(values = []) {
            const seen = new Set();
            const out = [];
            values.forEach((value) => {
                const normalized = (value || '').toString().trim().toLowerCase();
                if (!normalized || seen.has(normalized)) return;
                seen.add(normalized);
                out.push(normalized);
            });
            return out;
        }

        function getLinkedHashCandidates() {
            return collectHashCandidates([
                CONFIG.videoHash,
                deriveVideoHashFromParts(CONFIG.streamFilename, CONFIG.videoId)
            ]);
        }

        async function resolveStreamHashCandidates(streamUrl) {
            const fallback = { filename: CONFIG.streamFilename, videoId: CONFIG.videoId };
            const immediate = deriveStreamHashFromUrl(streamUrl, fallback);
            let resolved = null;
            try {
                const resolvedUrl = await resolveStreamUrlRedirect(streamUrl);
                resolved = deriveStreamHashFromUrl(resolvedUrl, fallback);
            } catch (_) {
                resolved = null;
            }
            const hashes = collectHashCandidates([immediate.hash, resolved?.hash]);
            return {
                immediate,
                resolved,
                hashes,
                preferred: resolved?.hash ? resolved : (immediate.hash ? immediate : null)
            };
        }

        function compareHashSets(linkedHashes = [], streamHashes = []) {
            const linkedSet = new Set(collectHashCandidates(linkedHashes));
            const streamSet = new Set(collectHashCandidates(streamHashes));
            const matches = [];
            streamSet.forEach((hash) => {
                if (linkedSet.has(hash)) matches.push(hash);
            });
            return {
                hasLinked: linkedSet.size > 0,
                hasStream: streamSet.size > 0,
                match: matches.length > 0,
                matches,
                linkedHash: linkedSet.values().next().value || '',
                streamHash: streamSet.values().next().value || ''
            };
        }

        // Cache for resolved redirect URLs to avoid repeated fetches
        const resolvedUrlCache = new Map();
        const REDIRECT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

        /**
         * Resolve a stream URL by following redirects to get the final URL.
         * Many debrid/stremio addon URLs (e.g., /resolve/realdebrid/...) redirect
         * to the actual CDN URL which contains the real filename.
         */
        async function resolveStreamUrlRedirect(url) {
            if (!url) return url;
            try {
                const cached = resolvedUrlCache.get(url);
                if (cached && (Date.now() - cached.timestamp < REDIRECT_CACHE_TTL)) {
                    return cached.resolved;
                }
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 8000);
                const response = await fetch(url, {
                    method: 'HEAD',
                    redirect: 'follow',
                    signal: controller.signal,
                    credentials: 'omit'
                });
                clearTimeout(timeoutId);
                const resolved = response.url || url;
                resolvedUrlCache.set(url, { resolved, timestamp: Date.now() });
                return resolved;
            } catch (err) {
                console.warn('[resolveStreamUrlRedirect] Failed to resolve URL, using original:', err.message);
                return url;
            }
        }

        function renderHashStatus(hashes = {}, cacheBlocked = false) {
            const linked = hashes.linked || CONFIG.videoHash || '';
            const stream = hashes.stream || '';
            const hasMismatch = linked && stream && linked !== stream;
            const cacheFlag = stream ? (cacheBlocked || hasMismatch) : false;
            STATE.cacheBlocked = cacheFlag;
            if (hashStatusEl) hashStatusEl.classList.remove('warn', 'success', 'error');
            if (hasMismatch) {
                if (hashStatusEl) {
                    hashStatusEl.textContent = 'Hash mismatch detected.';
                    hashStatusEl.classList.add('warn');
                }
                setHashMismatchAlert(buildHashMismatchAlert(linked, stream));
            } else if (stream) {
                if (hashStatusEl) {
                    hashStatusEl.textContent = 'Hash 1 = Hash 2';
                    hashStatusEl.classList.add('success');
                }
                setHashMismatchAlert('');
            } else {
                if (hashStatusEl) {
                    hashStatusEl.textContent = tt('toolbox.autoSubs.hash.waiting', {}, 'Waiting for stream hash...');
                }
                setHashMismatchAlert('');
            }
        }

        // Track pending hash resolution to debounce and avoid races
        let hashResolutionPending = null;

        async function updateHashStatusFromInput() {
            const streamInput = document.getElementById('streamUrl');
            if (!streamInput) return;
            const streamUrl = (streamInput.value || '').trim();
            const linkedHashes = getLinkedHashCandidates();
            const linkedPrimary = linkedHashes[0] || '';
            if (!streamUrl) {
                STATE.streamHashInfo = null;
                STATE.streamHashCandidates = [];
                renderHashStatus({ linked: linkedPrimary, stream: '' }, STATE.cacheBlocked);
                return;
            }

            // Generate a unique ID for this resolution to handle races
            const resolutionId = Date.now() + Math.random();
            hashResolutionPending = resolutionId;

            // First, immediately compute hash from the input URL as-is
            const immediateDerived = deriveStreamHashFromUrl(streamUrl, { filename: CONFIG.streamFilename, videoId: CONFIG.videoId });
            STATE.streamHashCandidates = collectHashCandidates([immediateDerived.hash]);
            const immediateCompare = compareHashSets(linkedHashes, STATE.streamHashCandidates);

            // If immediate set already intersects, no need to resolve redirects
            if (immediateCompare.match) {
                STATE.streamHashInfo = immediateDerived.hash ? immediateDerived : null;
                renderHashStatus({
                    linked: immediateCompare.linkedHash || linkedPrimary,
                    stream: immediateCompare.matches[0] || immediateCompare.streamHash
                }, STATE.cacheBlocked);
                return;
            }

            // Show a "resolving" state while we fetch the redirect
            if (hashStatusEl) {
                hashStatusEl.textContent = tt('toolbox.autoSubs.hash.resolving', {}, 'Resolving stream URL...');
                hashStatusEl.classList.remove('success', 'error');
                hashStatusEl.classList.add('warn');
            }

            try {
                const resolvedData = await resolveStreamHashCandidates(streamUrl);

                // Check if this resolution is still current (no newer input)
                if (hashResolutionPending !== resolutionId) return;

                STATE.streamHashInfo = resolvedData.preferred;
                STATE.streamHashCandidates = resolvedData.hashes;
                const compared = compareHashSets(linkedHashes, resolvedData.hashes);
                const displayStreamHash = compared.match
                    ? (compared.matches[0] || resolvedData.preferred?.hash || '')
                    : (resolvedData.preferred?.hash || resolvedData.immediate?.hash || '');
                renderHashStatus({ linked: compared.linkedHash || linkedPrimary, stream: displayStreamHash }, STATE.cacheBlocked);
            } catch (err) {
                // Check if this resolution is still current
                if (hashResolutionPending !== resolutionId) return;

                // On error, use the immediate hash
                console.warn('[updateHashStatusFromInput] Redirect resolution failed:', err);
                STATE.streamHashInfo = immediateDerived.hash ? immediateDerived : null;
                STATE.streamHashCandidates = collectHashCandidates([immediateDerived.hash]);
                const compared = compareHashSets(linkedHashes, STATE.streamHashCandidates);
                renderHashStatus({ linked: compared.linkedHash || linkedPrimary, stream: immediateDerived.hash }, STATE.cacheBlocked);
            }
        }

        let subtitleMenuInstance = null;

        let STATE = {
            step1Confirmed: false,
            streamUrl: null,
            streamHashInfo: null,
            streamHashCandidates: [],
            cacheBlocked: false,
            subtitleContent: null,
            selectedSubtitleLang: null,
            selectedSubtitleId: null,
            estimatedDurationMs: null,
            syncedSubtitle: null,
            translatedSubtitle: null,
            activeSyncPlan: null,
            useFingerprintPrepass: true,
            audioTracks: [],
            selectedAudioTrack: null,
            awaitingTrackChoice: false
        };
        const startSyncBtn = document.getElementById('startSyncBtn');
        const startSyncLabel = startSyncBtn ? startSyncBtn.innerHTML : '<span>⚡</span> ' + ${JSON.stringify(copy.step3.start)};
        const startSyncBusyLabel = ${JSON.stringify(copy.step3.startBusy)};
        let syncInFlight = false;
        const syncTrackPrompt = document.getElementById('syncTrackPrompt');
        const syncAudioTrackSelect = document.getElementById('syncAudioTrack');
        const syncTrackContinueBtn = document.getElementById('syncTrackContinue');
        const syncTrackHelper = document.getElementById('syncTrackHelper');

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
                    configStr: PAGE.configStr,
                    videoId: PAGE.videoId,
                    filename: PAGE.filename,
                    videoHash: PAGE.videoHash,
                    targetOptions: subtitleMenuTargets,
                    sourceLanguages: CONFIG.sourceLanguages || [],
                    targetLanguages: CONFIG.targetLanguages || [],
                    languageMaps: CONFIG.languageMaps,
                    getVideoHash: () => PAGE.videoHash || ''
                });
            } catch (err) {
                console.warn('Subtitle menu init failed', err);
                return null;
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

        function normalizeLangKeyClient(val) {
            return (val || '').toString().trim().toLowerCase().replace(/[^a-z]/g, '');
        }

        function normalizeNameKeyClient(val) {
            return (val || '').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');
        }

        function extractLanguageCodeClient(value) {
            if (!value) return '';
            const raw = value.toString();
            const direct = raw.match(/^[a-z]{2,3}(?:-[a-z]{2})?$/i);
            if (direct) return normalizeLangKeyClient(direct[0]);
            const translateMatch = raw.match(/_to_([a-z]{2,3}(?:-[a-z]{2})?)/i);
            if (translateMatch) return normalizeLangKeyClient(translateMatch[1]);
            const urlMatch = raw.match(/\\/([a-z]{2,3}(?:-[a-z]{2})?)\\.srt/i);
            if (urlMatch) return normalizeLangKeyClient(urlMatch[1]);
            const pathMatch = raw.match(/\\/([a-z]{2,3}(?:-[a-z]{2})?)\\/[^/]*$/i);
            if (pathMatch) return normalizeLangKeyClient(pathMatch[1]);
            return '';
        }

        function resolveSubtitleLanguageClient(sub) {
            const rawLabel = (sub?.language || sub?.lang || sub?.langName || sub?.title || sub?.name || sub?.label || '').toString().trim();
            const code =
                extractLanguageCodeClient(sub?.languageCode) ||
                extractLanguageCodeClient(sub?.lang) ||
                extractLanguageCodeClient(sub?.language) ||
                extractLanguageCodeClient(rawLabel) ||
                extractLanguageCodeClient(sub?.url) ||
                extractLanguageCodeClient(sub?.id);
            const byCode = CONFIG?.languageMaps?.byCode || {};
            const byNameKey = CONFIG?.languageMaps?.byNameKey || {};
            const friendly = byCode[normalizeLangKeyClient(code)] || byNameKey[normalizeNameKeyClient(rawLabel)] || '';
            const name = friendly || rawLabel || 'Unknown';
            return {
                code: code || normalizeLangKeyClient(sub?.lang || sub?.language || '') || 'unknown',
                name,
                key: normalizeLangKeyClient(code || rawLabel || name || 'unknown')
            };
        }

        function renderSubtitleOptions(list) {
            const subtitleSelect = document.getElementById('subtitleSelect');
            if (!subtitleSelect) return;
            const subtitles = Array.isArray(list) ? list : [];
            const filtered = subtitles.filter((sub) => {
                const id = (sub && sub.id) ? String(sub.id) : '';
                return id !== 'sync_subtitles' &&
                    id !== 'file_upload' &&
                    id !== 'sub_toolbox' &&
                    !id.startsWith('translate_') &&
                    !id.startsWith('xsync_') &&
                    !id.startsWith('auto_');
            });

            if (!filtered.length) {
                subtitleSelect.innerHTML = '<option value=\"\" disabled selected>' + escapeHtmlClient(subtitleUi.emptyPlaceholder) + '</option>';
                subtitleSelect.disabled = true;
                return;
            }

            const grouped = new Map();
            filtered.forEach((sub) => {
                const langInfo = resolveSubtitleLanguageClient(sub);
                const key = langInfo.key || 'unknown';
                if (!grouped.has(key)) grouped.set(key, { label: langInfo.name || 'Unknown', code: langInfo.code || 'unknown', items: [] });
                grouped.get(key).items.push({ sub, langInfo });
            });

            const parts = ['<option value=\"\" disabled selected>' + escapeHtmlClient(subtitleUi.selectPlaceholder) + '</option>'];
            for (const group of grouped.values()) {
                const label = group.label || 'Unknown';
                parts.push('<optgroup label=\"' + escapeHtmlClient(label) + '\">');
                group.items.forEach((item, idx) => {
                    const displayName = tt('sync.step2.subtitleOption', { language: label, index: idx + 1 }, label + ' - Subtitle #' + (idx + 1));
                    const sub = item.sub || {};
                    const langCode = (item.langInfo && item.langInfo.code) ? item.langInfo.code : (group.code || 'unknown');
                    parts.push('<option value=\"' + escapeHtmlClient(sub.id || '') + '\" data-lang=\"' + escapeHtmlClient(langCode) + '\" data-url=\"' + escapeHtmlClient(sub.url || '') + '\">' + escapeHtmlClient(displayName) + '</option>');
                });
                parts.push('</optgroup>');
            }
            subtitleSelect.innerHTML = parts.join('');
            subtitleSelect.disabled = false;
        }

        async function loadProviderSubtitles() {
            const subtitleSelect = document.getElementById('subtitleSelect');
            if (!subtitleSelect) return;
            const expectedSig = subtitleContextSig();
            const requestId = ++subtitleLoadState.requestId;
            subtitleSelect.disabled = true;
            subtitleSelect.innerHTML = '<option value=\"\" disabled selected>' + escapeHtmlClient(subtitleUi.loadingPlaceholder) + '</option>';
            try {
                const payload = await startSubtitlePrefetch({}, { force: false });
                if (requestId !== subtitleLoadState.requestId) return;
                if (expectedSig !== subtitleContextSig()) return;
                renderSubtitleOptions(payload && payload.subtitles ? payload.subtitles : []);
            } catch (err) {
                if (requestId !== subtitleLoadState.requestId) return;
                if (expectedSig !== subtitleContextSig()) return;
                console.error('[Sync] Failed to load subtitle list:', err);
                subtitleSelect.innerHTML = '<option value=\"\" disabled selected>' + escapeHtmlClient(subtitleUi.loadFailedPlaceholder) + '</option>';
                subtitleSelect.disabled = true;
            }
        }

        loadProviderSubtitles();

        function handleStreamEpisodeUpdate(payload = {}) {
            const nextVideoId = (payload.videoId || '').trim();
            const nextFilename = (payload.filename || '').trim();
            const nextHash = (payload.videoHash || '').trim();
            if (!nextVideoId && !nextFilename && !nextHash) return;

            const changed = (nextVideoId && nextVideoId !== PAGE.videoId)
                || (nextFilename && nextFilename !== PAGE.filename)
                || (nextHash && nextHash !== PAGE.videoHash);
            if (!changed) return;

            if (nextVideoId) {
                PAGE.videoId = nextVideoId;
                CONFIG.videoId = nextVideoId;
            }
            if (nextFilename) {
                PAGE.filename = nextFilename;
                CONFIG.streamFilename = nextFilename;
            }
            if (nextHash) {
                PAGE.videoHash = nextHash;
                CONFIG.videoHash = nextHash;
            } else {
                const derived = deriveVideoHashFromParts(PAGE.filename, PAGE.videoId);
                PAGE.videoHash = derived;
                CONFIG.videoHash = derived;
            }

            resetStepFlow(lockReasons.needContinue);
            resetSubtitleSelectionState();
            updateLinkedMeta({
                videoId: PAGE.videoId,
                filename: PAGE.filename
            });
            updateHashStatusFromInput();
            // Avoid firing extra subtitle-list requests on the old page context.
            // The refreshed/new page will preload immediately with the new stream context.
        }

        function forwardMenuNotification(info) {
            if (!subtitleMenuInstance || typeof subtitleMenuInstance.notify !== 'function') return false;
            const message = (info && info.message) ? info.message : tt('sync.toast.meta', {}, ${JSON.stringify(copy.toast.meta)});
            const title = (info && info.title) ? info.title + ': ' : (tt('sync.toast.title', {}, ${JSON.stringify(copy.toast.title)}) + ': ');
            subtitleMenuInstance.notify(title + message, 'muted', { persist: true });
            return false; // keep page toast visible
        }

        initStreamRefreshButton({
            buttonId: 'quickNavRefresh',
            configStr: PAGE.configStr,
            current: { videoId: PAGE.videoId, filename: PAGE.filename, videoHash: PAGE.videoHash },
            labels: {
                loading: tt('sync.refresh.loading', {}, 'Refreshing...'),
                empty: tt('sync.refresh.empty', {}, 'No stream yet'),
                error: tt('sync.refresh.error', {}, 'Refresh failed'),
                current: tt('sync.refresh.current', {}, 'Already latest')
            },
            buildUrl: (payload) => {
                return '/subtitle-sync?config=' + encodeURIComponent(PAGE.configStr) +
                    '&videoId=' + encodeURIComponent(payload.videoId || '') +
                    '&filename=' + encodeURIComponent(payload.filename || '');
            }
        });
        initStreamRefreshButton({
            buttonId: 'linkedStreamRefresh',
            configStr: PAGE.configStr,
            current: { videoId: PAGE.videoId, filename: PAGE.filename, videoHash: PAGE.videoHash },
            labels: {
                loading: tt('sync.refresh.loading', {}, 'Refreshing...'),
                empty: tt('sync.refresh.empty', {}, 'No stream yet'),
                error: tt('sync.refresh.error', {}, 'Refresh failed'),
                current: tt('sync.refresh.current', {}, 'Already latest')
            },
            buildUrl: (payload) => {
                return '/subtitle-sync?config=' + encodeURIComponent(PAGE.configStr) +
                    '&videoId=' + encodeURIComponent(payload.videoId || '') +
                    '&filename=' + encodeURIComponent(payload.filename || '');
            }
        });

        // Episode change watcher (toast + manual update)
        initStreamWatcher({
            configStr: PAGE.configStr,
            current: { videoId: PAGE.videoId, filename: PAGE.filename, videoHash: PAGE.videoHash },
            buildUrl: (payload) => {
                return '/subtitle-sync?config=' + encodeURIComponent(PAGE.configStr) +
                    '&videoId=' + encodeURIComponent(payload.videoId || '') +
                    '&filename=' + encodeURIComponent(payload.filename || '');
            },
            onEpisode: handleStreamEpisodeUpdate,
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
                logSync(tt('sync.logs.estimatedRuntime', { duration: human }, 'Estimated subtitle runtime (from current subtitle): ' + human), 'info');
            }
            refreshSyncPlanPreview();
        }

        function normalizeTrackLanguageTag(raw) {
            if (!raw) return '';
            const normalized = String(raw).trim().toLowerCase().replace(/_/g, '-');
            const direct = normalized.match(/^[a-z]{2,3}(?:-[a-z]{2})?$/);
            if (direct) return direct[0];
            return '';
        }

        function resolveTrackLanguageLabel(raw) {
            const code = normalizeTrackLanguageTag(raw);
            if (!code) return '';
            const byCode = CONFIG?.languageMaps?.byCode || {};
            const compact = normalizeLangKeyClient(code);
            const baseCompact = normalizeLangKeyClient(code.split('-')[0]);
            return byCode[compact] || byCode[baseCompact] || code.toUpperCase();
        }

        function buildSyncTrackLabel(track, fallbackIndex, suggestedIndex, extractedIndex) {
            const idx = Number.isInteger(track?.index) ? track.index : fallbackIndex;
            const parts = [tt('sync.audioTrack.track', { n: idx + 1 }, 'Track ' + (idx + 1))];
            const lang = resolveTrackLanguageLabel(track?.language || '');
            if (lang) parts.push(lang);
            if (track?.name) parts.push(String(track.name));
            if (track?.codecId) parts.push(String(track.codecId));
            if (idx === suggestedIndex || idx === extractedIndex) {
                parts.push(tt('sync.audioTrack.recommended', {}, 'Recommended'));
            }
            return parts.filter(Boolean).join(' - ');
        }

        function renderSyncTrackOptions(tracks, suggestedIndex, extractedIndex) {
            if (!syncAudioTrackSelect) return;
            const options = Array.isArray(tracks) ? tracks : [];
            syncAudioTrackSelect.innerHTML = '';
            options.forEach((track, pos) => {
                const option = document.createElement('option');
                const idx = Number.isInteger(track?.index) ? track.index : pos;
                option.value = String(idx);
                option.textContent = buildSyncTrackLabel(track, pos, suggestedIndex, extractedIndex);
                syncAudioTrackSelect.appendChild(option);
            });
            const knownChoice = Number.isInteger(STATE.selectedAudioTrack) ? STATE.selectedAudioTrack : null;
            const fallback = Number.isInteger(suggestedIndex)
                ? suggestedIndex
                : (Number.isInteger(extractedIndex) ? extractedIndex : 0);
            const desired = knownChoice !== null ? knownChoice : fallback;
            if (syncAudioTrackSelect.querySelector('option[value="' + String(desired) + '"]')) {
                syncAudioTrackSelect.value = String(desired);
            } else if (!syncAudioTrackSelect.value && options.length) {
                const firstIdx = Number.isInteger(options[0]?.index) ? options[0].index : 0;
                syncAudioTrackSelect.value = String(firstIdx);
            }
        }

        function showSyncTrackPrompt(tracks, suggestedIndex, extractedIndex) {
            STATE.audioTracks = Array.isArray(tracks) ? tracks : [];
            STATE.awaitingTrackChoice = true;
            renderSyncTrackOptions(STATE.audioTracks, suggestedIndex, extractedIndex);
            if (syncTrackHelper) {
                const helperFallback = (copy && copy.step3 && copy.step3.audioTrackHelper)
                    ? copy.step3.audioTrackHelper
                    : 'Multiple audio tracks detected. Choose one, then continue.';
                syncTrackHelper.textContent = tt('toolbox.autoSubs.steps.audioTrackHelper', {}, helperFallback);
            }
            if (syncTrackContinueBtn) syncTrackContinueBtn.disabled = false;
            if (syncTrackPrompt) syncTrackPrompt.classList.add('show');
        }

        function hideSyncTrackPrompt() {
            STATE.awaitingTrackChoice = false;
            STATE.audioTracks = [];
            if (syncTrackPrompt) syncTrackPrompt.classList.remove('show');
            if (syncTrackContinueBtn) syncTrackContinueBtn.disabled = false;
        }

        function handleSyncTrackOptionsMessage(msg) {
            if (!syncInFlight) return;
            if (!msg || !STATE.activeMessageId || (msg.messageId && msg.messageId !== STATE.activeMessageId)) return;
            const tracks = Array.isArray(msg.tracks) ? msg.tracks : [];
            if (tracks.length <= 1) return;
            const suggested = Number.isInteger(msg.suggestedIndex) ? msg.suggestedIndex : msg.extractedIndex;
            const extracted = Number.isInteger(msg.extractedIndex) ? msg.extractedIndex : null;
            showSyncTrackPrompt(tracks, suggested, extracted);
            const status = tt('sync.status.audioTrackPrompt', {}, 'Multiple audio tracks detected. Choose one to continue.');
            showStatus('syncStatus', status, 'info');
            logSync(status, 'info');
        }

        function submitSyncTrackSelection() {
            if (!STATE.awaitingTrackChoice || !STATE.activeMessageId) return;
            const raw = syncAudioTrackSelect ? parseInt(syncAudioTrackSelect.value, 10) : NaN;
            const trackIndex = Number.isInteger(raw) && raw >= 0 ? raw : 0;
            STATE.selectedAudioTrack = trackIndex;
            STATE.awaitingTrackChoice = false;
            if (syncTrackContinueBtn) syncTrackContinueBtn.disabled = true;
            const status = tt('sync.status.continuingTrack', { track: trackIndex + 1 }, 'Continuing with audio track ' + (trackIndex + 1) + '...');
            showStatus('syncStatus', status, 'info');
            logSync(status, 'info');
            window.postMessage({
                type: 'SUBMAKER_SYNC_SELECT_TRACK',
                source: 'webpage',
                messageId: STATE.activeMessageId,
                trackIndex
            }, '*');
            // Backward-compat for older content scripts that only forward AUTOSUB_SELECT_TRACK.
            window.postMessage({
                type: 'SUBMAKER_AUTOSUB_SELECT_TRACK',
                source: 'webpage',
                messageId: STATE.activeMessageId,
                trackIndex
            }, '*');
            hideSyncTrackPrompt();
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

        function lockSection(sectionId, label) {
            const section = document.getElementById(sectionId);
            if (!section) return;
            if (label) section.setAttribute('data-locked-label', label);
            section.classList.add('locked');
            section.setAttribute('aria-disabled', 'true');
            section.inert = true;
        }

        function enableSection(sectionId) {
            const section = document.getElementById(sectionId);
            if (!section) return;
            section.classList.remove('locked');
            section.removeAttribute('aria-disabled');
            section.inert = false;
            section.removeAttribute('inert');
            section.style.opacity = '';
            section.style.pointerEvents = '';
        }

        function resetStepFlow(reasonLabel) {
            STATE.step1Confirmed = false;
            STATE.selectedAudioTrack = null;
            hideSyncTrackPrompt();
            lockSection('step2Section', reasonLabel || lockReasons.needContinue);
            lockSection('step3Section', reasonLabel || lockReasons.needContinue);
        }

        function requireStep1Confirmation() {
            if (STATE.step1Confirmed) return false;
            showStatus('syncStatus', lockReasons.needContinue, 'warn');
            resetStepFlow(lockReasons.needContinue);
            return true;
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
            // Handle anime IDs (anidb, kitsu, mal, anilist)
            // Format: platform:animeId:episode OR platform:animeId:season:episode
            if (/^(anidb|kitsu|mal|myanimelist|anilist|tvdb|simkl|livechart|anisearch)/.test(parts[0])) {
                const animeIdType = parts[0];
                if (parts.length === 1) {
                    // Just platform name - anime movie/series
                    return { type: 'anime', animeId: parts[0], animeIdType, isAnime: true };
                }
                if (parts.length === 3) {
                    // platform:id:episode (seasonless, most common for anime)
                    // Example: kitsu:10941:1 -> animeId=kitsu:10941, episode=1
                    return {
                        type: 'anime-episode',
                        animeId: parts[0] + ':' + parts[1],
                        animeIdType,
                        isAnime: true,
                        episode: parseInt(parts[2], 10)
                    };
                }
                if (parts.length === 4) {
                    // platform:id:season:episode
                    // Example: kitsu:10941:1:5 -> animeId=kitsu:10941, season=1, episode=5
                    return {
                        type: 'anime-episode',
                        animeId: parts[0] + ':' + parts[1],
                        animeIdType,
                        isAnime: true,
                        season: parseInt(parts[2], 10),
                        episode: parseInt(parts[3], 10)
                    };
                }
                return { type: 'anime', animeId: id, animeIdType, isAnime: true };
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

        function formatEpisodeTag(videoId) {
            const parsed = parseVideoId(videoId);
            if (!parsed) return '';
            const s = Number.isFinite(parsed.season) ? 'S' + String(parsed.season).padStart(2, '0') : '';
            const e = Number.isFinite(parsed.episode) ? 'E' + String(parsed.episode).padStart(2, '0') : '';
            return (s || e) ? (s + e) : '';
        }

        async function fetchLinkedTitle(videoId) {
            const parsed = parseVideoId(videoId);
            if (!parsed) return null;
            
            // Handle anime IDs through server-side resolver (supports all platforms)
            if (parsed.isAnime && parsed.animeId) {
                const animeCacheKey = 'anime:' + String(videoId || '').trim().toLowerCase();
                if (linkedTitleCache.has(animeCacheKey)) return linkedTitleCache.get(animeCacheKey);
                try {
                    const url = '/api/resolve-linked-title?config=' + encodeURIComponent(CONFIG.configStr) + '&videoId=' + encodeURIComponent(videoId || '');
                    const resp = await fetch(url, { cache: 'no-store' });
                    if (resp.ok) {
                        const data = await resp.json();
                        const title = (typeof data?.title === 'string' && data.title.trim()) ? data.title.trim() : null;
                        linkedTitleCache.set(animeCacheKey, title);
                        return title;
                    }
                } catch (err) {
                    console.warn('[fetchLinkedTitle] Anime resolver API error:', err);
                }
                linkedTitleCache.set(animeCacheKey, null);
                return null;
            }
            
            // Handle IMDB/TMDB IDs - fetch from Cinemeta
            const metaType = parsed.type === 'episode' ? 'series' : 'movie';
            const metaId = (() => {
                if (parsed.imdbId && /^tt\\\\d{3,}$/i.test(parsed.imdbId)) return parsed.imdbId.toLowerCase();
                if (parsed.tmdbId) return 'tmdb:' + parsed.tmdbId;
                return null;
            })();
            if (!metaId) return null;
            const key = metaId + ':' + metaType;
            if (CONFIG.videoId === videoId && CONFIG.linkedTitle) {
                linkedTitleCache.set(key, CONFIG.linkedTitle);
                return CONFIG.linkedTitle;
            }
            if (linkedTitleCache.has(key)) return linkedTitleCache.get(key);
            const metaUrl = \`https://v3-cinemeta.strem.io/meta/\${metaType}/\${encodeURIComponent(metaId)}.json\`;
              try {
                  const resp = await fetch(metaUrl);
                  if (!resp.ok) throw new Error(tt('sync.errors.metaFetchFailed', {}, 'Failed to fetch metadata'));
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
            const parsed = parseVideoId(source.videoId);
            const episodeTag = formatEpisodeTag(source.videoId);
            const isEpisode = parsed && (parsed.type === 'episode' || parsed.type === 'anime' || parsed.type === 'anime-episode');
            const fallbackTitle = source.title || cleanLinkedName(source.filename) || cleanLinkedName(source.videoId) || tt('sync.meta.noStream', {}, ${JSON.stringify(copy.meta.noStream)});
            // Append episode tag to main title for episodes
            const displayFallbackTitle = (isEpisode && episodeTag && !fallbackTitle.toUpperCase().includes(episodeTag.toUpperCase()))
                ? fallbackTitle + ' - ' + episodeTag
                : fallbackTitle;
            const fallbackDetails = [];
            if (source.videoId) fallbackDetails.push(tt('sync.meta.videoIdLabel', {}, ${JSON.stringify(copy.meta.videoIdLabel)}) + ': ' + source.videoId);
            if (source.title) fallbackDetails.push(tt('sync.meta.titleLabel', {}, ${JSON.stringify(copy.meta.titleLabel)}) + ': ' + source.title);
            if (source.videoId || source.filename || source.title) fallbackDetails.push(tt('sync.meta.episodeLabel', {}, ${JSON.stringify(copy.meta.episodeLabel)}) + ': ' + (episodeTag || '-'));
            const fallbackFileLine = source.filename ? (tt('sync.meta.fileLabel', {}, ${JSON.stringify(copy.meta.fileLabel)}) + ': ' + cleanLinkedName(source.filename)) : '';
            LINKED_META.title.textContent = displayFallbackTitle;
            LINKED_META.subtitle.innerHTML = buildMetaSubtitleHtml(fallbackDetails.join(' | '), fallbackFileLine, tt('sync.meta.waiting', {}, ${JSON.stringify(copy.meta.waiting)}));

            const requestId = ++linkedTitleRequestId;
            const fetchedTitle = source.title || await fetchLinkedTitle(source.videoId);
            if (requestId !== linkedTitleRequestId) return;

            const details = [];
            if (source.videoId) details.push(tt('sync.meta.videoIdLabel', {}, ${JSON.stringify(copy.meta.videoIdLabel)}) + ': ' + source.videoId);
            if (fetchedTitle) details.push(tt('sync.meta.titleLabel', {}, ${JSON.stringify(copy.meta.titleLabel)}) + ': ' + fetchedTitle);
            if (source.videoId || source.filename || fetchedTitle || source.title) details.push(tt('sync.meta.episodeLabel', {}, ${JSON.stringify(copy.meta.episodeLabel)}) + ': ' + (episodeTag || '-'));
            const fileLine = source.filename ? (tt('sync.meta.fileLabel', {}, ${JSON.stringify(copy.meta.fileLabel)}) + ': ' + cleanLinkedName(source.filename)) : '';

            // Append episode tag to main title for episodes
            const resolvedTitle = fetchedTitle || fallbackTitle;
            const displayTitle = (isEpisode && episodeTag && !resolvedTitle.toUpperCase().includes(episodeTag.toUpperCase()))
                ? resolvedTitle + ' - ' + episodeTag
                : resolvedTitle;
            LINKED_META.title.textContent = displayTitle;
            LINKED_META.subtitle.innerHTML = buildMetaSubtitleHtml(details.join(' | '), fileLine, tt('sync.meta.waiting', {}, ${JSON.stringify(copy.meta.waiting)}));
        }

        updateLinkedMeta();

        // SRT parsing and manipulation functions
        function parseSRT(srtContent) {
            const lines = srtContent.trim().split(/\\r?\\n/);
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
                description: tt('sync.modes.alass.description', {}, 'Audio -> subtitle anchors via alass-wasm.'),
                options: [
                    { value: 'alass-rapid', label: tt('sync.presets.alass.rapid.label', {}, 'Rapid anchors (~8-10%)'), description: tt('sync.presets.alass.rapid.description', {}, '4-6 short anchor windows for quick drift locking.'), plan: { coverageTargetPct: 0.1, minWindows: 4, maxWindows: 6, windowSeconds: 45, strategy: 'spread', legacyMode: 'fast' }, preferAlass: true },
                    { value: 'alass-balanced', label: tt('sync.presets.alass.balanced.label', {}, 'Balanced anchors (~14-18%)'), description: tt('sync.presets.alass.balanced.description', {}, '6-9 windows at ~60s for tougher bitrate shifts.'), plan: { coverageTargetPct: 0.16, minWindows: 6, maxWindows: 9, windowSeconds: 60, strategy: 'spread', legacyMode: 'fast' }, preferAlass: true },
                    { value: 'alass-deep', label: tt('sync.presets.alass.deep.label', {}, 'Deep anchors (~26-32%)'), description: tt('sync.presets.alass.deep.description', {}, '9-14 windows at ~75s for heavy drift/ads.'), plan: { coverageTargetPct: 0.28, minWindows: 9, maxWindows: 14, windowSeconds: 75, strategy: 'dense-spread', legacyMode: 'complete' }, preferAlass: true },
                    { value: 'alass-complete', label: tt('sync.presets.alass.complete.label', {}, 'Complete (full runtime)'), description: tt('sync.presets.alass.complete.description', {}, 'Scan the full runtime with alass anchors.'), plan: { coverageTargetPct: 1, strategy: 'full', fullScan: true, legacyMode: 'complete' }, preferAlass: true }
                ]
            },
            ffsubsync: {
                description: tt('sync.modes.ffsubsync.description', {}, 'Audio -> subtitle alignment via ffsubsync-wasm.'),
                options: [
                    { value: 'ffss-light', label: tt('sync.presets.ffsubsync.light.label', {}, 'Light scan (~6-8%)'), description: tt('sync.presets.ffsubsync.light.description', {}, '4-6 windows (~60s) to catch obvious drifts quickly.'), plan: { coverageTargetPct: 0.08, minWindows: 4, maxWindows: 6, windowSeconds: 60, strategy: 'spread', legacyMode: 'fast' }, preferFfsubsync: true },
                    { value: 'ffss-balanced', label: tt('sync.presets.ffsubsync.balanced.label', {}, 'Balanced scan (~12-16%)'), description: tt('sync.presets.ffsubsync.balanced.description', {}, '6-10 windows (~80s) for mixed drift patterns.'), plan: { coverageTargetPct: 0.14, minWindows: 6, maxWindows: 10, windowSeconds: 80, strategy: 'spread', legacyMode: 'fast' }, preferFfsubsync: true },
                    { value: 'ffss-deep', label: tt('sync.presets.ffsubsync.deep.label', {}, 'Deep scan (~22-28%)'), description: tt('sync.presets.ffsubsync.deep.description', {}, '9-14 windows (~100s) for aggressive correction.'), plan: { coverageTargetPct: 0.24, minWindows: 9, maxWindows: 14, windowSeconds: 100, strategy: 'dense-spread', legacyMode: 'complete' }, preferFfsubsync: true },
                    { value: 'ffss-complete', label: tt('sync.presets.ffsubsync.complete.label', {}, 'Complete (full runtime)'), description: tt('sync.presets.ffsubsync.complete.description', {}, 'Full-runtime ffsubsync scan for maximum accuracy.'), plan: { coverageTargetPct: 1, strategy: 'full', fullScan: true, legacyMode: 'complete' }, preferFfsubsync: true }
                ]
            },
            'vosk-ctc': {
                description: tt('sync.modes.vosk.description', {}, 'Text -> audio (Vosk CTC logits + DTW).'),
                options: [
                    { value: 'vosk-light', label: tt('sync.presets.vosk.light.label', {}, 'Vosk Light (~10-12%)'), description: tt('sync.presets.vosk.light.description', {}, 'Quick CTC/DTW pass for big offsets and broken timings.'), plan: { coverageTargetPct: 0.12, minWindows: 4, maxWindows: 7, windowSeconds: 70, strategy: 'spread', legacyMode: 'vosk-light' }, preferCtc: true },
                    { value: 'vosk-balanced', label: tt('sync.presets.vosk.balanced.label', {}, 'Vosk Balanced (~16-20%)'), description: tt('sync.presets.vosk.balanced.description', {}, 'Adds more anchors for ads/drift while staying fast.'), plan: { coverageTargetPct: 0.18, minWindows: 6, maxWindows: 9, windowSeconds: 85, strategy: 'spread', legacyMode: 'vosk-balanced' }, preferCtc: true },
                    { value: 'vosk-deep', label: tt('sync.presets.vosk.deep.label', {}, 'Vosk Deep (~26-32%)'), description: tt('sync.presets.vosk.deep.description', {}, 'Dense anchors for noisy audio or messy subs.'), plan: { coverageTargetPct: 0.28, minWindows: 8, maxWindows: 12, windowSeconds: 95, strategy: 'dense-spread', legacyMode: 'vosk-deep' }, preferCtc: true },
                    { value: 'vosk-complete', label: tt('sync.presets.vosk.complete.label', {}, 'Vosk Complete (full runtime)'), description: tt('sync.presets.vosk.complete.description', {}, 'Full-runtime Vosk CTC/DTW alignment when accuracy is critical.'), plan: { coverageTargetPct: 1, strategy: 'full', fullScan: true, legacyMode: 'vosk-complete' }, preferCtc: true }
                ]
            },
            'whisper-alass': {
                description: tt('sync.modes.whisper.description', {}, 'Subtitle -> subtitle (Whisper transcript + ALASS refine).'),
                options: [
                    { value: 'whisper-light', label: tt('sync.presets.whisper.light.label', {}, 'Light scan (~5-7%)'), description: tt('sync.presets.whisper.light.description', {}, '3-5 Whisper windows (~70s) to sanity-check drift.'), plan: { coverageTargetPct: 0.06, minWindows: 3, maxWindows: 5, windowSeconds: 70, strategy: 'spread', legacyMode: 'fast' } },
                    { value: 'whisper-balanced', label: tt('sync.presets.whisper.balanced.label', {}, 'Balanced scan (~12-16%)'), description: tt('sync.presets.whisper.balanced.description', {}, '5-8 windows (~85s) for typical shows with ads.'), plan: { coverageTargetPct: 0.14, minWindows: 5, maxWindows: 8, windowSeconds: 85, strategy: 'spread', legacyMode: 'fast' } },
                    { value: 'whisper-deep', label: tt('sync.presets.whisper.deep.label', {}, 'Deep scan (~22-28%)'), description: tt('sync.presets.whisper.deep.description', {}, '8-12 windows (~100s) for stubborn drifts.'), plan: { coverageTargetPct: 0.26, minWindows: 8, maxWindows: 12, windowSeconds: 100, strategy: 'dense-spread', legacyMode: 'complete' } },
                    { value: 'whisper-complete', label: tt('sync.presets.whisper.complete.label', {}, 'Complete (full runtime)'), description: tt('sync.presets.whisper.complete.description', {}, 'Full-runtime transcript + align when you need everything.'), plan: { coverageTargetPct: 1, strategy: 'full', fullScan: true, legacyMode: 'complete' } }
                ]
            }
        };
        const PRIMARY_DESCRIPTIONS = {
            alass: tt('sync.primary.alass', {}, 'ALASS anchors the subtitle to audio for fast, offline alignment.'),
            ffsubsync: tt('sync.primary.ffsubsync', {}, 'FFSubSync detects drifts/ads directly from the audio waveform.'),
            'vosk-ctc': tt('sync.primary.vosk', {}, 'Vosk CTC/DTW force-aligns your subtitle text directly to the audio.'),
            'whisper-alass': tt('sync.primary.whisper', {}, 'Whisper transcript alignment with an ALASS refinement pass.')
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

        function buildSyncPlan(primaryMode, secondaryPresetValue, estimatedDurationMs = null, options = {}) {
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
            const useFingerprintPrepass = options.useFingerprintPrepass !== undefined
                ? !!options.useFingerprintPrepass
                : !!(STATE?.useFingerprintPrepass ?? true);

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
                modeGroup: primaryMode,
                primaryMode,
                useFingerprintPrepass
            };

            if (durationSeconds && plan.windowSeconds && plan.windowSeconds > durationSeconds) {
                plan.windowSeconds = durationSeconds;
            }

            return plan;
        }

        function describeSyncPlan(plan) {
            if (!plan) return '';
            if (plan.fullScan) {
                if (plan.windowSeconds) return tt('sync.plan.fullRuntimeSeconds', { seconds: Math.round(plan.windowSeconds) }, 'Full runtime (' + Math.round(plan.windowSeconds) + 's) scan');
                return tt('sync.plan.fullRuntime', {}, 'Full runtime scan');
            }
            const parts = [];
            if (plan.windowCount && plan.windowSeconds) {
                parts.push(tt('sync.plan.windowCountSeconds', { count: plan.windowCount, seconds: Math.round(plan.windowSeconds) }, String(plan.windowCount) + ' x ' + Math.round(plan.windowSeconds) + 's'));
            } else if (plan.windowCount) {
                parts.push(tt('sync.plan.windowCount', { count: plan.windowCount }, String(plan.windowCount) + ' windows'));
            }
            if (plan.durationSeconds && plan.coverageSeconds) {
                const pct = Math.min(100, Math.round((plan.coverageSeconds / plan.durationSeconds) * 100));
                parts.push(tt('sync.plan.coverageDetected', { pct }, '~' + pct + '% of detected runtime'));
            } else if (plan.coverageTargetPct) {
                const pct = Math.round(plan.coverageTargetPct * 100);
                parts.push(tt('sync.plan.coverageTarget', { pct }, '~' + pct + '% target coverage'));
            }
            if (plan.useFingerprintPrepass) {
                parts.push(tt('sync.plan.fingerprint', {}, 'fingerprint pre-pass'));
            }
            return parts.join(' | ');
        }

        // Chrome Extension Communication
        let extensionInstalled = false;
        let pingTimer = null;
        let pingRetryTimer = null;
        let pingAttempts = 0;
        const MAX_PINGS = 5;
        const extDot = document.getElementById('ext-dot');
        const extLabel = document.getElementById('ext-label');
        const extStatus = document.getElementById('ext-status');
        const xsyncVersionWarning = document.getElementById('xsync-version-warning');
        const EXT_INSTALL_URL = 'https://chromewebstore.google.com/detail/submaker-xsync/lpocanpndchjkkpgchefobjionncknjn';
        const REQUIRED_XSYNC_VERSION = ${JSON.stringify(REQUIRED_XSYNC_VERSION)};
        const VERSION_WARNING_TEMPLATE = tt(
            'toolbox.extension.versionOutdated',
            { detected: '{detected}', required: '{required}' },
            'SubMaker xSync {detected} detected. This toolbox expects {required} or newer, so some sync and subtitle tools may behave unpredictably until you update.'
        );
        const primaryModeSelect = document.getElementById('primarySyncMode');
        const secondaryModeSelect = document.getElementById('secondarySyncMode');
        const secondaryModeGroup = document.getElementById('secondaryModeGroup');
        const fingerprintPrepassGroup = document.getElementById('fingerprintPrepassGroup');
        const fingerprintPrepassCheckbox = document.getElementById('useFingerprintPrepass');
        const sourceLanguageSelect = document.getElementById('sourceLanguage');

        function parseVersionParts(version) {
            if (!version) return null;
            const cleaned = String(version).trim().replace(/^v/i, '').split('-')[0];
            if (!cleaned) return null;
            const parts = cleaned.split('.').slice(0, 3).map(part => Number.parseInt(part, 10));
            if (!parts.length || parts.some(part => !Number.isFinite(part))) return null;
            while (parts.length < 3) parts.push(0);
            return parts;
        }

        function compareVersions(a, b) {
            const aParts = parseVersionParts(a);
            const bParts = parseVersionParts(b);
            if (!aParts || !bParts) return null;
            for (let i = 0; i < 3; i += 1) {
                if (aParts[i] > bParts[i]) return 1;
                if (aParts[i] < bParts[i]) return -1;
            }
            return 0;
        }

        function updateVersionWarning(installedVersion) {
            if (!xsyncVersionWarning) return;
            const cmp = compareVersions(installedVersion, REQUIRED_XSYNC_VERSION);
            if (cmp !== null && cmp < 0) {
                const detectedLabel = 'v' + String(installedVersion || '').replace(/^v/i, '');
                xsyncVersionWarning.textContent = VERSION_WARNING_TEMPLATE
                    .replace('{detected}', detectedLabel)
                    .replace('{required}', 'v' + REQUIRED_XSYNC_VERSION);
                xsyncVersionWarning.style.display = 'block';
                return;
            }
            xsyncVersionWarning.style.display = 'none';
            xsyncVersionWarning.textContent = '';
        }

        function setAutoSyncAvailability(enabled) {
            const primaryOptions = ['alass', 'ffsubsync', 'vosk-ctc', 'whisper-alass'];
            primaryOptions.forEach((mode) => {
                const opt = primaryModeSelect?.querySelector('option[value="' + mode + '"]');
                if (opt) opt.disabled = !enabled;
            });
            if (secondaryModeSelect) {
                secondaryModeSelect.disabled = !enabled;
            }
            if (fingerprintPrepassCheckbox) {
                fingerprintPrepassCheckbox.disabled = !enabled;
            }
            if (!enabled) {
                if (primaryModeSelect) {
                    primaryModeSelect.value = 'alass';
                }
                populateSecondaryOptions('alass');
                if (fingerprintPrepassGroup) {
                    fingerprintPrepassGroup.style.display = 'none';
                }
                STATE.activeSyncPlan = null;
            } else {
                populateSecondaryOptions(primaryModeSelect?.value || 'alass');
            }
        }

        // Default: autosync options stay locked until extension is detected
        setAutoSyncAvailability(false);

        function populateSecondaryOptions(primaryMode) {
            if (!secondaryModeSelect || !secondaryModeGroup) return;
            const opts = (SYNC_MODE_LIBRARY[primaryMode] || {}).options || [];
            if (!opts.length) {
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
                extLabel.textContent = ready
                    ? (text || tt('sync.extension.ready', {}, ${JSON.stringify(t('sync.extension.ready', {}, 'Ready'))}))
                    : (text || tt('sync.extension.notDetected', {}, ${JSON.stringify(t('sync.extension.notDetected', {}, 'Extension not detected'))}));
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
            if (ready) {
                if (pingTimer) clearInterval(pingTimer);
                if (pingRetryTimer) {
                    clearTimeout(pingRetryTimer);
                    pingRetryTimer = null;
                }
                setAutoSyncAvailability(true);
            } else {
                setAutoSyncAvailability(false);
            }
        }

        function pingExtension(force = false) {
            if (extensionInstalled && !force) return;
            updateExtensionStatus(false, tt('sync.extension.pinging', {}, 'Pinging extension...'), 'warn');
            if (pingTimer) clearInterval(pingTimer);
            if (pingRetryTimer) {
                clearTimeout(pingRetryTimer);
                pingRetryTimer = null;
            }
            pingAttempts = 0;
            const sendPing = () => {
                if (extensionInstalled) return;
                pingAttempts += 1;
                window.postMessage({ type: 'SUBMAKER_PING', source: 'webpage' }, '*');
                if (pingAttempts >= MAX_PINGS && !extensionInstalled) {
                    clearInterval(pingTimer);
                    updateExtensionStatus(false, tt('sync.extension.notDetected', {}, ${JSON.stringify(t('sync.extension.notDetected', {}, 'Extension not detected'))}), 'bad');
                    if (!pingRetryTimer) {
                        pingRetryTimer = setTimeout(() => {
                            if (!extensionInstalled) pingExtension(true);
                        }, 8000);
                    }
                }
            };
            sendPing();
            pingTimer = setInterval(sendPing, 5000);
        }

        // Set up message listener FIRST, before sending PING
        window.addEventListener('message', (event) => {
            const msg = event.data || {};
            if (!msg || (msg.source && msg.source !== 'extension')) return;

            if (msg.type === 'SUBMAKER_PONG') {
                extensionInstalled = true;
                const version = msg.version || '1.0.0';
                updateExtensionStatus(true, tt('sync.extension.readyVersion', { version }, 'Ready (v' + version + ')'));
                updateVersionWarning(msg.version || '');
                logSync(tt('sync.extension.detected', { version }, 'Extension detected (v' + version + ')'), 'info');
                if (pingTimer) clearInterval(pingTimer);

                setAutoSyncAvailability(true);

                logSync(tt('sync.extension.unlocked', {}, 'Sync engines unlocked (ALASS / FFSubSync / Vosk CTC/DTW / Whisper + ALASS)'), 'info');

                populateSecondaryOptions(primaryModeSelect?.value || 'alass');
                refreshSyncPlanPreview();
                return;
            }
            if (msg.type === 'SUBMAKER_DEBUG_LOG') {
                if (msg.messageId && STATE?.activeMessageId && msg.messageId !== STATE.activeMessageId) {
                    return;
                }
                logSync(msg.text || tt('sync.logs.generic', {}, 'Log event'), msg.level || 'info');
                return;
            }
            if (msg.type === 'SUBMAKER_SYNC_TRACKS') {
                handleSyncTrackOptionsMessage(msg);
                return;
            }
            if (msg.type === 'SUBMAKER_AUTOSUB_TRACKS') {
                // Backward-compat for older content scripts forwarding sync track prompts under autosub type.
                handleSyncTrackOptionsMessage(msg);
                return;
            }
            if (msg.type === 'SUBMAKER_SYNC_PROGRESS') {
                // Progress for the active job is handled by the request-specific listener to avoid duplicates.
                if (!msg.messageId || !STATE?.activeMessageId || msg.messageId !== STATE.activeMessageId) return;
            }
        });

        if (extStatus) {
            extStatus.addEventListener('click', () => {
                if (!extensionInstalled) {
                    pingExtension(true);
                }
            });
        }

        // Kick off extension checks (will retry with a short backoff if not detected)
        setTimeout(pingExtension, 150);

        // Request sync from Chrome extension
        function requestExtensionSync(streamUrl, subtitleContent, primaryMode, plan = null, preferAlass = false, preferFfsubsync = false, preferCtc = false, useFingerprintPrepass = true, audioTrackIndex = null, sourceLanguageHint = '') {
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
                    durationAdjusted: plan.durationAdjusted,
                    modeGroup: plan.modeGroup || plan.primaryMode || primaryMode || null,
                    primaryMode: plan.primaryMode || primaryMode || null,
                    useFingerprintPrepass: !!useFingerprintPrepass
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
                        preferCtc: !!preferCtc,
                        useFingerprintPrepass: !!useFingerprintPrepass,
                        audioTrackIndex: Number.isInteger(audioTrackIndex) && audioTrackIndex >= 0 ? audioTrackIndex : null,
                        sourceLanguageHint: sourceLanguageHint || ''
                    }
                }, '*');
                const summary = describeSyncPlan(plan);
                logSync(tt('sync.logs.sentRequest', { mode: modeToSend, summary: summary ? ' [' + summary + ']' : '' }, 'Sent sync request (' + modeToSend + ')' + (summary ? ' [' + summary + ']' : '') + ' to extension.'), 'info');

                // Timeout after 15 minutes (for Complete mode)
                timeoutId = setTimeout(() => {
                    window.removeEventListener('message', responseHandler);
                    window.removeEventListener('message', progressHandler);
                    STATE.activeMessageId = null;
                    reject(new Error(tt('sync.step3.status.timeout', {}, 'Extension sync timeout')));
                }, 900000);
            });
        }

        // Sync method change handler
        function refreshSyncPlanPreview() {
            const primaryMode = primaryModeSelect ? primaryModeSelect.value : 'alass';
            const autoSyncInfo = document.getElementById('autoSyncInfo');
            const syncMethodDesc = document.getElementById('syncMethodDescription');
            autoSyncInfo.style.display = 'block';
            if (fingerprintPrepassGroup) fingerprintPrepassGroup.style.display = 'block';
            if (fingerprintPrepassCheckbox) {
                fingerprintPrepassCheckbox.checked = STATE.useFingerprintPrepass !== false;
            }

            const preset = resolveSecondaryPreset(primaryMode, secondaryModeSelect?.value);
            const prefs = resolveEnginePrefs(primaryMode, preset ? preset.value : null);
            const fingerprintAllowed = !prefs.preferFfsubsync;
            const useFingerprintPrepass = fingerprintAllowed && STATE.useFingerprintPrepass !== false;
            if (fingerprintPrepassCheckbox) {
                fingerprintPrepassCheckbox.disabled = !fingerprintAllowed;
                fingerprintPrepassCheckbox.checked = useFingerprintPrepass;
            }
            if (fingerprintAllowed === false) {
                STATE.useFingerprintPrepass = false;
            }

            const plan = buildSyncPlan(
                primaryMode,
                preset ? preset.value : null,
                STATE.estimatedDurationMs,
                { useFingerprintPrepass }
            );
            STATE.activeSyncPlan = plan || null;

            const summary = describeSyncPlan(plan);
            const primaryDesc = PRIMARY_DESCRIPTIONS[primaryMode] || '';
            const presetDesc = (preset && PRESET_DESCRIPTIONS[preset.value]) || (preset ? preset.description : '');
            const combinedDesc = [primaryDesc, presetDesc].filter(Boolean).join(' ');
            const fingerprintNote = fingerprintAllowed ? '' : '<div class="plan-summary" style="color: var(--text-secondary);">' + tt('sync.plan.fingerprintSkipped', {}, 'Fingerprint pre-pass is skipped when FFSubSync is the primary engine.') + '</div>';
            const summaryBlock = summary ? '<div class="plan-summary">' + tt('sync.plan.summary', { plan: summary }, 'Plan: ' + summary) + '</div>' : '';
            syncMethodDesc.innerHTML = combinedDesc + summaryBlock + fingerprintNote;
        }

        primaryModeSelect?.addEventListener('change', (e) => {
            populateSecondaryOptions(e.target.value);
            refreshSyncPlanPreview();
        });
        secondaryModeSelect?.addEventListener('change', refreshSyncPlanPreview);

        if (fingerprintPrepassCheckbox) {
            STATE.useFingerprintPrepass = fingerprintPrepassCheckbox.checked;
            fingerprintPrepassCheckbox.addEventListener('change', (e) => {
                STATE.useFingerprintPrepass = !!e.target.checked;
                refreshSyncPlanPreview();
            });
        }
        syncAudioTrackSelect?.addEventListener('change', () => {
            const raw = syncAudioTrackSelect ? parseInt(syncAudioTrackSelect.value, 10) : NaN;
            if (Number.isInteger(raw) && raw >= 0) {
                STATE.selectedAudioTrack = raw;
            }
        });
        syncTrackContinueBtn?.addEventListener('click', submitSyncTrackSelection);

        populateSecondaryOptions(primaryModeSelect?.value || 'alass');
        refreshSyncPlanPreview();

        const streamUrlInput = document.getElementById('streamUrl');
        if (streamUrlInput) {
            ['input', 'change', 'blur'].forEach((evt) => {
                streamUrlInput.addEventListener(evt, () => {
                    updateHashStatusFromInput();
                    if (evt === 'input' && STATE.step1Confirmed) {
                        resetStepFlow(lockReasons.needContinue);
                    }
                });
            });
        }

        resetStepFlow(lockReasons.needContinue);
        updateHashStatusFromInput();

        // Step 1: Continue button
        document.getElementById('continueBtn').addEventListener('click', async () => {
            const streamUrlInput = document.getElementById('streamUrl');
            const streamUrl = (streamUrlInput?.value || '').trim();
            const linkedHashes = getLinkedHashCandidates();
            const requiredMsg = tt('sync.step3.status.urlRequired', {}, 'Autosync requires a valid http(s) stream URL. Please paste it in Step 1.');
            const invalidMsg = tt('sync.step3.status.invalidStream', {}, 'Autosync requires a valid http(s) stream URL.');
            const mismatchMsg = HASH_MISMATCH_LINES[0] || tt('toolbox.embedded.step1.hashMismatchLine1', {}, 'Hashes must match before extraction can start.');
            const resetFlow = (reason) => resetStepFlow(reason || lockReasons.needContinue);

            if (!streamUrl) {
                STATE.streamUrl = null;
                showStatus('syncStatus', requiredMsg, 'error');
                resetFlow(requiredMsg);
                return;
            }

            if (!isHttpUrl(streamUrl)) {
                STATE.streamUrl = null;
                showStatus('syncStatus', invalidMsg, 'error');
                resetFlow(invalidMsg);
                return;
            }

            await updateHashStatusFromInput();
            const streamHashes = collectHashCandidates([
                ...(Array.isArray(STATE.streamHashCandidates) ? STATE.streamHashCandidates : []),
                STATE.streamHashInfo?.hash
            ]);
            const compared = compareHashSets(linkedHashes, streamHashes);
            if (compared.hasLinked && compared.hasStream && !compared.match) {
                STATE.streamUrl = null;
                setHashMismatchAlert(buildHashMismatchAlert(compared.linkedHash, compared.streamHash));
                showStatus('syncStatus', mismatchMsg, 'error');
                resetFlow(mismatchMsg);
                return;
            }

            STATE.step1Confirmed = true;
            enableSection('step2Section');
            if (STATE.subtitleContent) {
                enableSection('step3Section');
            } else {
                lockSection('step3Section', lockReasons.needSubtitle);
            }

            // Store stream URL for extension
            STATE.streamUrl = streamUrl;
            showStatus('syncStatus', tt('sync.step3.status.linked', {}, 'Stream URL linked for autosync.'), 'success');
        });

        // Step 2: Select Subtitle
        document.getElementById('subtitleSelect').addEventListener('change', (e) => {
            if (requireStep1Confirmation()) {
                e.target.selectedIndex = 0;
                return;
            }

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
                        STATE.subtitleContent = null;
                        lockSection('step3Section', lockReasons.needSubtitle);
                        showStatus('syncStatus', tt('sync.step3.status.fetchSubtitleFailed', {}, 'Failed to fetch subtitle'), 'error');
                    });
            } else {
                lockSection('step3Section', lockReasons.needSubtitle);
                STATE.selectedSubtitleId = null;
                STATE.subtitleContent = null;
            }
        });

        // File upload
        const uploadArea = document.getElementById('uploadArea');
        const fileInput = document.getElementById('fileInput');

        uploadArea.addEventListener('click', () => {
            if (requireStep1Confirmation()) return;
            fileInput.click();
        });

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
            if (requireStep1Confirmation()) return;
            handleSubtitleFile(file);
        });

        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (requireStep1Confirmation()) return;
            handleSubtitleFile(file);
        });

        function handleSubtitleFile(file) {
            if (requireStep1Confirmation()) return;
            if (!file || !file.name.endsWith('.srt')) {
                showStatus('syncStatus', tt('sync.upload.invalidFile', {}, 'Please select a valid .srt file'), 'error');
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
                if (sourceLanguageSelect) {
                    sourceLanguageSelect.selectedIndex = 0;
                }

                enableSection('step3Section');
                showStatus('syncStatus', tt('sync.upload.loaded', { name: file.name }, 'Subtitle file loaded: ' + file.name), 'success');
            };
            reader.readAsText(file);
        }

        // Translate checkbox
        document.getElementById('translateAfterSync').addEventListener('change', (e) => {
            document.getElementById('targetLangGroup').style.display = e.target.checked ? 'block' : 'none';
            const hint = document.getElementById('syncAddTargetsHint');
            const hasTargets = Array.isArray(CONFIG.targetLanguages) && CONFIG.targetLanguages.length > 0;
            if (hint) {
                hint.style.display = e.target.checked && !hasTargets ? 'block' : 'none';
            }
        });

        // Step 3: Start Sync
        function setSyncInFlight(active) {
            syncInFlight = !!active;
            if (startSyncBtn) {
                startSyncBtn.disabled = syncInFlight;
                startSyncBtn.innerHTML = syncInFlight ? startSyncBusyLabel : startSyncLabel;
            }
        }

        startSyncBtn?.addEventListener('click', async () => {
            if (requireStep1Confirmation()) return;
            if (syncInFlight) return;
            if (!STATE.subtitleContent) {
                showStatus('syncStatus', tt('sync.step3.status.needSubtitle', {}, 'Please select a subtitle first'), 'error');
                return;
            }

            const primaryMode = primaryModeSelect ? primaryModeSelect.value : 'alass';
            const secondaryMode = secondaryModeSelect ? secondaryModeSelect.value : null;
            const streamInputEl = document.getElementById('streamUrl');
            if (streamInputEl) {
                const latestStream = (streamInputEl.value || '').trim();
                STATE.streamUrl = latestStream || STATE.streamUrl || null;
            }
            const sourceLanguageGroup = document.getElementById('sourceLanguageGroup');
            const needsSourceLanguage = sourceLanguageGroup && sourceLanguageGroup.style.display !== 'none';
            const chosenSourceLanguage = needsSourceLanguage && sourceLanguageSelect ? (sourceLanguageSelect.value || '') : null;
            if (needsSourceLanguage && !chosenSourceLanguage) {
                showStatus('syncStatus', tt('sync.step3.status.needLanguage', {}, 'Select the subtitle language before syncing.'), 'error');
                return;
            }

            try {
                setSyncInFlight(true);
                hideSyncTrackPrompt();
                document.getElementById('syncProgress').style.display = 'block';
                hideStatus('syncStatus');
                hideStatus('translateStatus');
                STATE.syncedSubtitle = null;
                STATE.translatedSubtitle = null;
                document.getElementById('downloadSyncedBtn').style.display = 'none';
                document.getElementById('downloadTranslatedBtn').style.display = 'none';

                if (!extensionInstalled) {
                    pingExtension(true);
                    throw new Error(tt('sync.step3.status.extensionRequired', {}, 'Autosync requires the SubMaker Chrome Extension. Please install/enable it.'));
                }
                if (!isHttpUrl(STATE.streamUrl || '')) {
                    throw new Error(tt('sync.step3.status.urlRequired', {}, 'Autosync requires a valid http(s) stream URL. Please paste it in Step 1.'));
                }

                if (AUTO_PRIMARY_MODES.includes(primaryMode)) {
                    const preset = resolveSecondaryPreset(primaryMode, secondaryMode);
                    if (!preset) {
                        throw new Error(tt('sync.step3.status.profileRequired', {}, 'Select a scan profile before starting autosync.'));
                    }

                    const modeName = preset.label || (secondaryMode || tt('sync.step3.autosync.generic', {}, 'Autosync'));
                    const primaryLabel = primaryModeSelect?.selectedOptions?.[0]?.textContent || primaryMode;
                    const prefs = resolveEnginePrefs(primaryMode, preset.value);
                    const useFingerprintPrepass = (!prefs.preferFfsubsync) && STATE.useFingerprintPrepass !== false;
                    const syncPlan = buildSyncPlan(primaryMode, preset.value, STATE.estimatedDurationMs, { useFingerprintPrepass });
                    STATE.activeSyncPlan = syncPlan;
                    const planSummary = describeSyncPlan(syncPlan);
                    const sourceLanguageHint = (needsSourceLanguage ? chosenSourceLanguage : null) || STATE.selectedSubtitleLang || '';

                    if (planSummary) {
                        logSync(tt('sync.plan.summary', { plan: planSummary }, 'Plan: ' + planSummary), 'info');
                    }

                    const intro = tt('sync.step3.autosync.starting', { mode: modeName, primary: primaryLabel, plan: planSummary ? ' [' + planSummary + ']' : '' }, 'Starting ' + modeName + ' (' + primaryLabel + ')' + (planSummary ? ' [' + planSummary + ']' : '') + '...');
                    updateProgress('syncProgressFill', 'syncProgressText', 10, intro);

                    // Request audio extraction and sync from extension
                    const syncResult = await requestExtensionSync(
                        STATE.streamUrl,
                        STATE.subtitleContent,
                        primaryMode,
                        syncPlan,
                        prefs.preferAlass,
                        prefs.preferFfsubsync,
                        prefs.preferCtc,
                        useFingerprintPrepass,
                        STATE.selectedAudioTrack,
                        sourceLanguageHint
                    );

                    if (!syncResult.success) {
                        throw new Error(syncResult.error || tt('sync.step3.status.extensionSyncFailed', {}, 'Extension sync failed'));
                    }

                    STATE.syncedSubtitle = syncResult.syncedSubtitle;
                    updateProgress('syncProgressFill', 'syncProgressText', 100, tt('sync.step3.autosync.complete', { mode: modeName }, modeName + ' complete!'));
                }

                // Save to cache
                // Extract language code: use file-upload selection when present, otherwise provider language from dropdown
                const sourceLanguage = (needsSourceLanguage ? chosenSourceLanguage : null) || STATE.selectedSubtitleLang || 'eng';
                await saveSyncedSubtitle(CONFIG.videoHash, sourceLanguage, STATE.selectedSubtitleId, STATE.syncedSubtitle);

                showStatus('syncStatus', tt('sync.step3.status.success', {}, 'Subtitle synced successfully!'), 'success');

                // Check if translation is needed
                if (document.getElementById('translateAfterSync').checked) {
                    await translateSubtitle();
                }

                document.getElementById('downloadSyncedBtn').style.display = 'inline-flex';

            } catch (error) {
                console.error('[Sync] Error:', error);
                showStatus('syncStatus', tt('sync.step3.status.failed', { reason: error.message }, 'Sync failed: ' + error.message), 'error');
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
                throw new Error(tt('sync.errors.saveFailed', {}, 'Failed to save synced subtitle'));
            }

            console.log('[Cache] Synced subtitle saved');
        }

        // Translate subtitle (reusing existing translation API)
        async function translateSubtitle() {
            try {
                const targetLanguage = document.getElementById('targetLanguage').value;
                showStatus('translateStatus', tt('sync.translate.inProgress', {}, 'Translating subtitle... This may take 1-5 minutes.'), 'info');

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
                    throw new Error(tt('sync.translate.failed', {}, 'Translation failed'));
                }

                STATE.translatedSubtitle = await response.text();
                showStatus('translateStatus', tt('sync.translate.success', {}, 'Translation completed!'), 'success');
                document.getElementById('downloadTranslatedBtn').style.display = 'inline-flex';

                // Save translated version to cache
                await saveSyncedSubtitle(CONFIG.videoHash, targetLanguage,
                    STATE.selectedSubtitleId + '_translated', STATE.translatedSubtitle);

            } catch (error) {
                console.error('[Translate] Error:', error);
                showStatus('translateStatus', tt('sync.translate.error', { reason: error.message }, 'Translation failed: ' + error.message), 'error');
            }
        }

        // Download handlers
        document.getElementById('downloadSyncedBtn').addEventListener('click', () => {
            if (!STATE.syncedSubtitle) return;
            downloadSubtitle(STATE.syncedSubtitle, 'synced_subtitle.srt');
        });

        document.getElementById('downloadTranslatedBtn').addEventListener('click', () => {
            if (!STATE.translatedSubtitle) return;
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
