# Changelog

All notable changes to this project will be documented in this file.

## SubMaker 1.2.2 (Unreleased)

**SubSource Subtitle Ranking & Quality Improvements**

Enhanced SubSource integration to leverage their advanced API features for better subtitle quality and matching:

1. **Episode Filtering**
   - **Fixed critical bug**: SubSource was returning subtitles from ALL episodes in a season
   - Pass `season` parameter to movie search to get season-specific movieId
   - Removed unsupported `episode` API parameter that was being ignored
   - Added client-side episode filtering using regex patterns (S02E01, 2x01, etc.)
   - Now correctly filters to show ONLY the requested episode's subtitles

2. **Rebalanced Sorting Strategy**
   - Changed from `sort=rating` to `sort=popular` (downloads)
   - Prioritizes filename/release matching over raw ratings
   - Prevents excluding correct subtitles that may have lower ratings
   - Increased limit to 100 results for better diversity

3. **Enhanced Metadata for Better Matching**
   - Added `productionType` (e.g., translated, retail) to subtitle metadata
   - Added `releaseType` (e.g., web, bluray) for improved filename matching
   - Added `framerate` information for precise video/subtitle sync
   - Automatically enhance subtitle names with production/release type info

4. **Improved Rating Algorithm**
   - Implemented Bayesian averaging for confidence-weighted ratings
   - Prevents low-vote subtitles from ranking unfairly high
   - Better quality assessment using SubSource's good/bad voting system
   - Store detailed rating breakdown (good, bad, total votes)

5. **Provider Reputation Upgrade**
   - Increased SubSource reputation score from 1 to 2 (equal to SubDL)
   - Justified by rich API features and quality metadata

## SubMaker 1.2.0, 1.2.1

**Critical Session Persistence & Reliability Improvements**

This release focuses on completely overhauling the session token/config persistence system to eliminate "session not found" errors that occurred during server restarts, code updates, Docker rebuilds and deployments.

1. **Session Manager Initialization**
   - Added proper async initialization with `waitUntilReady()` method
   - Server now waits for sessions to load before accepting requests
   - Eliminates race conditions during startup

2. **Token/Config Lifecycle Improvements**
   - Fixed session expiration to use `createdAt` (absolute TTL) instead of `lastAccessedAt`
   - Added token format validation (32-char hex) during loading and client-side
   - Client-side token validation and automatic cleanup of malformed tokens

3. **Storage Reliability**
   - Per-token session persistence: each token is stored independently (no single shared blob) to prevent multi-instance clobbering
   - Immediate per-token save on create/update/delete for durability between restarts
   - Automatic migration: legacy `sessions` blob is migrated to per-token entries on startup
   - Concurrent initialization protection in StorageFactory
   - Better Redis fallback to filesystem on connection failures

4. **Enhanced Shutdown Handling**
   - Retry logic (3 attempts) for session saves during shutdown
   - Increased timeout to 10 seconds for shutdown saves
   - Better error handling and logging throughout shutdown process

5. **Error Handling & Logging**
   - Proper 404/410 handling for expired/missing tokens
   - Graceful fallback to creating new sessions on errors
   - `_alreadyLogged` flag to prevent duplicate error logs in translation chains

6. **Memory Management**
   - Periodic memory cleanup (hourly) for sessions not accessed in 30 days
   - Evicted sessions remain in persistent storage and reload if accessed
   - Prevents memory leaks with frequently accessed sessions

**New Features:**

- **Per-Token Persistence**: Sessions are saved individually and immediately, enabling safe multi-instance deployments and reducing data-loss windows
- **Cross-Instance Token Resolution**: Routes fall back to loading tokens directly from shared storage when not found in memory (seamless across replicas)
- **Token Format Validation**: Invalid token formats are detected and filtered during loading, preventing corruption
- **Consecutive Save Failure Tracking**: Critical alerts after 5 consecutive save failures (25 minutes) for monitoring
- **Memory Cleanup**: Automatic hourly cleanup of old sessions from memory while preserving in storage
- **Startup Readiness**: Server waits for session manager to load all sessions before accepting requests
- Sessions now use a sliding inactivity TTL: expire only after 90 days without access. Persistent storage TTL is refreshed on use, and original createdAt is preserved.
- Redis/HA optimizations:
  - Skip Redis preload of all sessions at startup (lazy load per token); can be re-enabled with `SESSION_PRELOAD=true`.
  - Do not mark sessions dirty on read in Redis mode and disable periodic auto-save timer to avoid redundant writes.
  - Added strict referrer policy (`no-referrer`) via Helmet to prevent leaking `?config=` tokens in Referer headers.
  - Note: Ensure all instances share the same `ENCRYPTION_KEY` and `REDIS_KEY_PREFIX` for cross-instance session access.
- Enhanced session diagnostics and logging (fixes #1, #2, #8):
  - Session creation logs now clarify "in-memory" count vs total sessions. In Redis lazy-load mode, this shows only loaded sessions, not all sessions in storage.
  - Added `isLazyLoadingMode` flag to session stats to help operators understand session loading behavior.
  - Detailed error context logging in session fallback mechanism: now logs specific failure modes (not found, expired, decryption error, storage error).
  - Initialization logs clarify when Redis lazy-load mode is active and explain cross-instance fallback behavior.
  - Encryption logs clarified: config contains encrypted individual fields (not double-encrypted full config).


**Bug Fixes:**

- Redis session keys were double-prefixed (client `keyPrefix` + manual prefix), causing migrated sessions to be invisible to preload scans. Removed manual prefixing in the Redis adapter and kept the client `keyPrefix` only.
- Migration counters for sessions now increment only on successful writes; failures are logged to aid troubleshooting.
- Fixed silent failures in session fallback loading: now logs detailed context explaining why session load failed (missing token, expired, decryption error, storage error).
- Fixed server accepting requests before sessions loaded (race condition during startup)
- Fixed multi-instance race where saving a single `sessions` blob could overwrite other instances’ sessions
- Fixed session expiration using wrong timestamp (lastAccessedAt instead of createdAt)
- Fixed potential memory leak with LRU cache and sliding TTL
- Fixed invalid tokens in storage breaking session loading
- Fixed no alerting when storage repeatedly fails
- Fixed client not validating token format before storage
- Fixed concurrent StorageFactory initializations causing race conditions
- Fixed config page blank fields when opened from Stremio gear


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
