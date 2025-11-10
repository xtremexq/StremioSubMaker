# Changelog

All notable changes to this project will be documented in this file.

## SubMaker 1.0.3

**UI Redesign:**

**Code Refactoring:**
- Renamed bypass cache directory from `translations_temp` to `translations_bypass` for clarity
- Renamed `tempCache` configuration object to `bypassCacheConfig` (backward compatible with old `tempCache` name)
- Updated all cache-related function names: `readFromTemp` → `readFromBypassCache`, `saveToTemp` → `saveToBypassCache`, `verifyTempCacheIntegrity` → `verifyBypassCacheIntegrity`

**UI & Configuration:**
- Added password visibility toggle (eye icon) to OpenSubtitles password field
- Completely redesigned file translation page with UI matching the configuration page style
- Added support for multiple subtitle formats: SRT, VTT, ASS, SSA (previously only SRT was supported)
- Enhanced file upload interface with drag-and-drop support and animations

**Performance:**
- Subtitle now applies rate limiting per-language after ranking all sources: fetches from all 3 subtitle sources, ranks by quality/filename match, then limits to 12 subtitles per language (ensures best matches appear first)

**Bug Fixes:**
- Fixed validation error notifications: errors now display when saving without required fields (Gemini API key, enabled subtitle sources missing API keys)
- Fixed "Cannot GET /addon/..." error when clicking the config/settings button in Stremio after addon installation
- Configuration page code cleanup: removed unused files and duplicate code, simplified cache/bypass toggle logic
- Various small bug fixes.

## SubMaker 1.0.2

**UI & Configuration:**
- Quick Start guide now appears only on first run, hidden after setup
- API keys section defaults unchecked (enable only what you need)
- Loading message updated to show 0→4h range explaining progressive subtitle loading during translation
- Gemini prompts now use human-readable regional language names instead of codes (e.g., "English")
- Auto-creates `data/` directory on startup (no manual setup needed)
- Fixed language mappings for OpenSubtitles API: Brazilian Portuguese (pt-br), Simplified Chinese (zh-cn), Traditional Chinese (zh-tw), Montenegrin, and Chinese bilingual support
- Portuguese (Brazil) variants (ptbr/pt-br/pob) now consolidated into single selector option with normalized storage as `pob`
- Added OPENSUBTITLES_API_KEY environment variable support
- Subtitle filename priority match algorithm
- Various bug fixes and improvements

**Performance & Stability:**
- Fixed unbounded session cache by adding `maxSessions` limit (50k default, configurable via `SESSION_MAX_SESSIONS`)
- Switched user translation counts to LRU cache (max 50k tracked users, auto-expires after 24h)
- Automatic cleanup of stale session and translation-tracking data
- Cache reset safety: 5-click cache reset now blocked while translation is in progress (prevents interruption)
- Graceful shutdown: Server properly exits, clears timers, and saves sessions before closing
- Duplicate translation prevention: In-flight request deduplication allows simultaneous identical requests to share one translation

## SubMaker 1.0.1

**Features:**
- Progressive subtitle updates during translation: partial SRT saved after each chunk and served while translation is in progress
- Optional token-level streaming for Gemini (enable via `advancedSettings.enableStreaming`)
- Version badge added to configuration and translation selector pages
- `/api/session-stats` endpoint now includes version info

**Bug Fixes:**
- Fixed SRT integrity during partial loading: entries reindexed and tail message positioned after last translated timestamp
- Fixed addon URL generation for private networks (192.168.x.x, 10.x.x.x, 172.16-31.x.x ranges now recognized as local, preventing forced HTTPS)
