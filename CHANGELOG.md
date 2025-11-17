# Changelog

All notable changes to this project will be documented in this file.

## SubMaker 1.2.2

**Performance Improvements:**
- OpenSubtitles V3 filename extraction now batched (10 concurrent requests per batch) to reduce rate limiting errors
- Reduced max subtitles per language from 16 to 12 for improved UI performance
- Enhanced HTTP client configuration with compression and optimized headers across all services

**New Features:**
- DNS caching: Integrated cacheable-lookup for faster DNS resolution across all subtitle services
- Composite quality scoring: Weighted ranking algorithm (downloads 40%, rating 40%, upload date 20%) for better subtitle prioritization
- SubDL release matching: Enhanced ranking by checking all compatible release names from API for improved filename matching
- SubSource episode filtering, metadata enhancements, Bayesian rating algorithm: Confidence-weighted ratings.
- Subtitle format conversion: SubDL and SubSource now support .vtt, .ass, .ssa formats with automatic conversion to .srt
- OpenSubtitles language support: Added mappings for Asturian, Manipuri, Syriac, Tetum, Santali, Extremaduran, Toki Pona, and common regional variants (pt-PT, Spanish Latin America)

**Bug Fixes:**
- Fixed sutitle sources from returning subtitles from all episodes in a season instead of only the requested episode
- Fixed session lookup after server restart: `getSession()` and `updateSession()` now automatically fall back to Redis/storage when sessions are not in memory cache
- Fixed Redis pub/sub self-invalidation: instances now ignore their own invalidation events to prevent sessions from expiring immediately after updates

## SubMaker 1.2.0, 1.2.1

**New Features:**
- Per-token session persistence: Sessions saved individually and immediately for safe multi-instance deployments
- Cross-instance token resolution: Automatic fallback to shared storage when token not found in memory
- Token format validation: Invalid token formats detected and filtered during loading
- Startup readiness: Server waits for session manager initialization before accepting requests
- Sliding inactivity TTL: Sessions expire only after 90 days without access
- Redis lazy-load mode: Optional session preloading (disable with `SESSION_PRELOAD=false`)
- Strict referrer policy: Prevents leaking config tokens in Referer headers
- Enhanced session diagnostics: Detailed logging for session creation, loading, and failure modes
- Memory cleanup: Automatic hourly cleanup of sessions not accessed in 30 days
- Consecutive save failure tracking: Critical alerts after 5 consecutive failures

**Bug Fixes:**
- Fixed Redis session double-prefixing causing migrated sessions to be invisible
- Fixed server accepting requests before sessions loaded (race condition during startup)
- Fixed multi-instance race where single sessions blob could overwrite other instances' sessions
- Fixed session expiration using lastAccessedAt instead of createdAt
- Fixed potential memory leak with LRU cache and sliding TTL
- Fixed invalid tokens in storage breaking session loading
- Fixed client not validating token format before storage
- Fixed concurrent StorageFactory initializations causing race conditions
- Fixed config page blank fields when opened from Stremio gear
- Fixed silent failures in session fallback loading

**Performance Improvements:**
- Redis mode skips marking sessions dirty on read and disables periodic auto-save timer
- Enhanced shutdown handling: Retry logic (3 attempts) with 10-second timeout for session saves


## SubMaker 1.1.7

**New Features:**
- Refined error messages: Improved user-facing error descriptions for safety filter blocks, rate limits, authentication failures, and source file issues

**Bug Fixes:**
- Expanded error type mapping: Enhanced error handler to classify all error types (403, 429, 503, MAX_TOKENS, PROHIBITED_CONTENT, RECITATION, SAFETY, INVALID_SOURCE)
- Fixed 3-click cache reset safety: Now prevents cache deletion when user is at the concurrent translation limit, avoiding abuse and data loss

## SubMaker 1.1.6

**New Features:**
- **Multi-Model Support**: Added Gemini model selection dropdown on config page with two options:
  - Gemini 2.5 Flash - Better quality, slower
  - Gemini 2.5 Flash-Lite - Well tested, faster and cheaper alternative (recommended if Flash has issues)
- Advanced Settings can still override the selected model for per-translation customization

## SubMaker 1.1.5

**Bug Fixes:**
- Fixed PROHIBITED_CONTENT error detection: Now properly identifies all safety filter errors (PROHIBITED_CONTENT, RECITATION, SAFETY) and displays appropriate user message instead of generic "please retry" text
- Improved HTTP error detection: Added direct HTTP status code checking (403, 503, 429) for better error classification and messaging
- Enhanced error messages: Users now see specific error descriptions for 503 (service overloaded), 429 (rate limit), and 403 (authentication) errors instead of generic fallbacks

**Translation Engine Improvements:**
- Better error caching: Translation errors are now properly cached for 15 minutes, allowing users to understand what went wrong and retry appropriately

## SubMaker 1.1.4

**Bug Fixes:**
- Fixed Gemini API key validation: Removed duplicate model fetching messages that appeared after clicking "Test" button
- Fixed Gemini API key input: Green border now only appears when API key is successfully validated by backend, not just when field is not empty
- Moved model fetching status messages to Advanced Settings section only (no longer shows in main config area)

## SubMaker 1.1.3

**New Features:**
- **Gemini v1beta endpoint rollback**: Fixing previous change that introduced problems.
- **API Key Validation**: Added "Test" buttons to validate API keys for SubSource, SubDL, OpenSubtitles, and Gemini directly from the config page
- **Dark Mode**: All addon pages now support automatic dark/light themes based on system preference with manual toggle buttons

**Bug Fixes:**
- Fixed config page: Gemini API key validation now properly displays notification alerts when field is empty
- Fixed config page: "Just-fetch subtitles" mode now clears validation errors for translation-only fields (Gemini API key, source/target languages)
- Fixed config page: Switching between translation and no-translation modes now clears language selections from the previous mode to prevent unwanted languages from being saved
- Various minor  fixes.

## SubMaker 1.1.2

**New Features:**
- **Intelligent Subtitle Ranking**: Advanced filename matching algorithm prioritizes exact release group matches (RARBG, YTS, etc.) and rip type compatibility (WEB-DL, BluRay) for optimal sync probability
  - Matches resolution, codec, audio, HDR, streaming platform (Netflix, Amazon), and edition markers (Extended, Director's Cut) to find best-synced subtitles
- Added Advanced Settings (EXPERIMENTAL) section to configuration page for fine-tuning AI behavior
- Secret unlock: Click the heart (❤️) in the footer to reveal Advanced Settings

**Performance Improvements:**
- Automatic cache purging when user changes configuration (different config hash = different cache key)
- Configurable environment variables: `SUBTITLE_SEARCH_CACHE_MAX`, `SUBTITLE_SEARCH_CACHE_TTL_MS`

**File Translation:**
- **Parallel Translation for File Upload**: Large SRT files (>15K tokens) are now automatically split into chunks and translated concurrently
  - Parallel API calls, context preservation, environment variables configuration, automatic retry.
- **File Translation Advanced Settings**: Added experimental advanced settings section to file translation page for temporary per-translation overrides of model, prompt, and AI parameters (thinking budget, temperature, top-P, top-K, max tokens, timeout, retries)

**Bug Fixes:**
- **User-Isolated Subtitle Search Cache**: Fixed a problem of cache sharing between users with different configurations (API keys, providers, languages)
- Various major and minor bug fixes.

## SubMaker 1.1.1

**Bug Fixes:**
- Fixed Gemini model defaults: Old session tokens with deprecated models (gemini-flash-latest, gemini-2.0-flash-exp) now automatically use current stable model
- Fixed compression middleware crashes on some environments
- Fixed encryption key regeneration on server restart (was causing session loss)
- Fixed session token error messages displaying incorrectly in Stremio

**Configuration:**
- Added environment variable support for AI translation settings (temperature, top-K, top-P, thinking budget, output tokens, timeout, retries)
- Model defaults consolidated to single source of truth (easier to maintain, eliminates redundancy)
- Deprecated model override system with easy re-enable flag for future user selection

## SubMaker 1.1.0

**Translation Engine - Complete Rewrite:**
- Completely rewrote subtitle translation workflow with structure-first approach to eliminate sync problems
- NEW: Translation engine now preserves original SRT timing (timings never sent to AI, can't be modified)
- Hardcoded gemini-2.5-flash-lite-preview-09-2025 for consistency across all translations
- Model selection UI will return in future versions with workflow optimization for different models

**New Features and Updates:**
- Added OpenSubtitles V3 implementation as an alternative to the default authenticated API
  - Users can now choose between "Auth" (requires OpenSubtitles account) or "V3" (no authentication, uses Stremio's official OpenSubtitles V3 addon)
- Translation Cache Overwrite reduced from 5 clicks in 10 seconds to 3 clicks in 5 seconds (to avoid Stremio rate-limiting)

**Infrastructure:**
- Redis support: Full Redis integration for translation cache, session storage, and subtitle cache with configurable TTLs and automatic key expiration (enables distributed HA deployments)
- Encryption support: AES-256-GCM encryption for user configurations and sensitive API keys with per-user key derivation and secure session token generation
- Docker deployment support with docker-compose configurations for both standalone and Redis-backed deployments
- Filesystem storage adapter still available for local deployment and fallback

**Performance & Logging:**
- Parallel translation chunk processing: Process multiple Gemini chunks simultaneously (EXPERIMENTAL - DISABLED BY DEFAULT)
- Redis Sentinel support (OPTIONAL - disabled by default)
- High-performance logging overhaul: Lazy evaluation with callbacks for all 520+ log statements eliminates 40-70% CPU overhead from string interpolation on filtered logs
- Increased entry cache: 10,000 → 100,000 entries (5x capacity, improves cache hit rate from ~60% to ~75-85%)
- Optimized partial cache flushing: Flush interval increased from 15s → 30s (50% less I/O overhead)
- Enhanced response compression: Maximum compression (level 9) for SRT files: 10-15x bandwidth reduction (500KB → 35KB typical)
- Async file logging with buffering replaces synchronous writes, eliminating event loop blocking (1-5ms per log) that caused 100-300ms p99 latency spikes under load
- Log sampling support for extreme load scenarios (LOG_SAMPLE_RATE, LOG_SAMPLE_DEBUG_ONLY) allows reducing log volume while preserving critical errors

**Bug Fixes:**
- Fixed bypass cache user isolation: Each user now gets their own user-scoped bypass cache entries (identified by config hash), preventing users from accessing each other's cached translations when using "Bypass Database Cache" mode
- Fixed 3-click cache reset to properly handle bypass vs permanent cache
- Config hash generation now handles edge cases gracefully with identifiable fallback values instead of silent failures
- **Various major and minor bug fixes**

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
- Cache reset safety: 3-click cache reset now blocked while translation is in progress (prevents interruption)
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
