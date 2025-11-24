# Changelog

All notable changes to this project will be documented in this file.

## SubMaker v1.4.0

**New Features:**

- AI timestamps mode (toggle in Advanced Settings): trust the active translation provider to return/repair timestamps per batch, stream partial SRTs with AI timecodes where supported (Gemini), and rebuild partials safely while throttling with new `SINGLE_BATCH_*` env controls.
- Single-batch Translation Mode with streaming partials to Stremio, token-aware chunking, and new `SINGLE_BATCH_*` env knobs to throttle streaming rebuild/log cadence.
- Beta Mode added to config page - enabling it creates a "Multiple Providers" option on "AI Translation API Keys" section and shows "Advanced Configs" section for changing Gemini parameters.
- Multi-provider translation pipeline: oOpenAI, Anthropic, XAI/Grok, DeepSeek, DeepL, Mistral, OpenRouter, and Cloudflare Workers AI providers with per-provider keys/model pickers and server-side model discovery with a new parallel translation workflow.
- Secondary provider fallback option added to config page (BETA).
- Main Gemini translation workflow now supports Streaming (much faster partials and batch translations). Also implemented to other providers.

**Translation Engine & Providers:**

- Gemini defaults now use `gemini-flash-latest` with SSE streaming support, real token counting, smarter output token budgets, batch headers, and timestamp-aware prompts; cache keys now include prompt variants and AI-timestamp mode.
- Automatic batch-level fallback to the secondary provider on MAX_TOKENS/PROHIBITED_CONTENT/HTTP errors, preserved translation error types (incl. `MULTI_PROVIDER`), and mismatch correction that keeps AI-returned timecodes when requested.
- Token-aware splitting tightened (soft caps per chunk, recursive halving, single-batch dynamic splits), streaming partial persistence throttled/logged to cut Redis I/O, and subtitle search cache reduced to 5k entries to lower memory use.

**Configuration & UI:**

- Config page rebuilt with a multi-provider card (main/fallback selectors), per-provider advanced parameter editors (temperature/top-P/max tokens/timeouts/retries, Anthropic thinking, DeepL formality/formatting), encrypted storage of provider keys, and manifest/README copy updated to reflect non-Gemini providers.
- File translation UI/API now accept provider-specific prompt/model/parameter overrides plus sanitized advanced settings; bypass cache is auto-forced when using advanced, multi-provider, single-batch, or AI-timestamp modes to keep shared caches clean.
- Validation hardened to require at least one configured AI provider, enforce distinct main vs fallback, clamp provider parameters, normalize toggles, and normalize encrypted provider keys on load/save.

**New Files:**
- `src/services/providers/openaiCompatible.js` - Universal provider for OpenAI, XAI/Grok, DeepSeek, Mistral, OpenRouter, and Cloudflare Workers AI
- `src/services/providers/anthropic.js` - Anthropic/Claude provider with extended thinking support
- `src/services/providers/deepl.js` - DeepL provider with beta languages and formality control
- `src/services/translationProviderFactory.js` - Factory pattern with FallbackTranslationProvider class for automatic provider switching

**New Environment Variables:**
- `SINGLE_BATCH_LOG_ENTRY_INTERVAL` - Debug log checkpoint interval for single-batch streaming
- `SINGLE_BATCH_SRT_REBUILD_STEP_SMALL` - Partial SRT rebuild step when entries ≤ threshold
- `SINGLE_BATCH_SRT_REBUILD_STEP_LARGE` - Partial SRT rebuild step when entries > threshold
- `SINGLE_BATCH_SRT_REBUILD_LARGE_THRESHOLD` - Entry threshold to switch rebuild step sizes

**API Endpoints Added:**
- `/api/models/:provider` - Generic model discovery for all non-Gemini providers (OpenAI, Anthropic, DeepL, XAI, DeepSeek, Mistral, OpenRouter, Cloudflare Workers)

**API Enhancements:**
- `/api/gemini-models` now accepts `configStr` for fetching models using saved session token
- `/api/translate-file` now accepts `overrides` parameter for provider-specific settings (prompt, model, parameters)

**File Translation UI:**
- Provider-specific overrides: prompt, model, parameters
- Advanced settings override panel with input clamping
- Bypass cache auto-forced when using advanced/multi-provider/single-batch/AI-timestamp modes
- Multiple bug fixes

**Other Bug Fixes:**

- **Fixed critical cross-user configuration contamination bug**: Added aggressive cache prevention headers (`Cache-Control`, `Pragma`, `Expires`) to `/api/get-session/:token` endpoint and implemented client-side cache-busting with timestamp query parameters. This bug was causing users to randomly see other users' language settings (e.g., Croatian, Hebrew, Polish) due to HTTP caching by browsers, proxies, or CDNs.
- Translation error classification retains upstream flags (429/503/MAX_TOKENS/PROHIBITED_CONTENT/INVALID_SOURCE) so user messaging and fallback routing stay accurate.
- Various minor bug fixes.

## SubMaker v1.3.6 (unreleased)

**Improvements:**

- 3-click cache resets are now rate limited based on time (defaults: 6/15m for permanent cache, 12/15m for bypass cache) and configurable via `CACHE_RESET_LIMIT_TRANSLATION`, `CACHE_RESET_LIMIT_BYPASS`, and `CACHE_RESET_WINDOW_MINUTES`.
- Config/UI: Source-language selection cap is now configurable via `MAX_SOURCE_LANGUAGES`.
- Config/UI: Added combined target/learn languages cap (default 6) configurable via `MAX_TARGET_LANGUAGES` to prevent oversized selections.
- Just Fetch mode: Added a configurable cap on fetched languages (default 9) via `MAX_NO_TRANSLATION_LANGUAGES`, with UI enforcement and server-side validation.
- Config/UI: Updated Gemini model options to use `gemini-flash-latest` and `gemini-flash-lite-latest` for the Flash defaults.
- Translation engine: Each batch prompt now carries an explicit `BATCH X/Y` header so the model knows which chunk it is translating.
- Advanced settings: New “Send timestamps to AI” toggle sends timecodes to Gemini and trusts the model to return corrected timestamps per batch using the default translation prompt.

**Bug Fixes:**

- SRT Translation UI: Fixed authentication failure in file upload translation page using session tokens configs
- File Translation API: Added support for advanced settings override, allowing UI customizations to be properly applied during translation

## SubMaker v1.3.5

**Improvements:**

- Initial html/js/css refactoring of the configure.html page
- Config: Coerce OpenSubtitles username/password to strings to prevent `trim()` type errors and manifest crashes when non-string values are saved
- Subtitle episode matching: Accept `SxxxEyy` / `xx xEyy` season-pack naming (e.g., `S01xE01`) across SubSource, SubDL, and OpenSubtitles to avoid missing episodes inside ZIPs

## SubMaker v1.3.4

**Infrastructure & Deployment:**

- Docker Hub Integration: Pre-built multi-platform images now available at [xtremexq/submaker](https://hub.docker.com/r/xtremexq/submaker)
- GitHub Actions: Automated Docker image publishing workflow for AMD64 and ARM64 platforms on release
- Redis Configuration: Enhanced with connection timeouts (300s) and TCP keepalive (60s) for improved reliability
- Security: Improved .dockerignore to prevent encryption keys from being copied into Docker images
- Documentation: Complete rewrite of Docker deployment guide with Docker Hub examples and multiple deployment options

**Bug fixes:**

- Multiple minor bug fixes

## SubMaker v1.3.3

**New Features:**

- Learn Mode: Adds dual-language subtitles outputs ("Learn [Language]") with configurable order for language learning
- Mobile Mode: Holds Stremio subtitles requests until the translation is finished before returning it

**SubSource:**

- Downloads: CDN-first with endpoint fallback. When available, we now fetch the provider's direct download link first (4s timeout) and fall back to the authenticated `/subtitles/{id}/download` endpoint with retries, then details>CDN as a final fallback. This significantly reduces user-facing timeouts on slow endpoints while preserving existing ZIP/VTT/SRT handling.
- Latency tuning: Reduced primary `/subtitles/{id}/download` retry budget to ~7s and, on the first retryable failure, launch a parallel details>CDN fetch and return the first success. This caps worst-case latency and improves reliability on slow or flaky endpoints.
- MovieId lookup resilience: If `/movies/search` returns empty or times out, derive `movieId` via imdb-based endpoints (`/subtitles?imdb=…` then `/search?imdb=…`) as a fallback, reducing transient lookup failures and improving overall subtitle search reliability.
- Download timeouts: Added a user-facing subtitle (0>4h) when the SubSource API times out during download, informing the user and suggesting a retry or choosing a different subtitle (similar to existing PROHIBITED_CONTENT/429/503 messages).
- Timeout detection: Broadened SubSource timeout detection so axios-style rewrites still return the timeout subtitle instead of bubbling an unhandled error.

**OpenSubtitles Auth:**

- Detect season packs during search and extract the requested episode from season-pack ZIPs on download (parity with SubDL/SubSource).
- Add client-side episode filtering to reduce wrong-episode results when API returns broader matches.
- 429 handling: Rate limit responses are no longer misclassified as authentication failures; we now show a clear “rate limit (429)” subtitle and avoid caching invalid-credential blocks for retryable errors.
- Download auth handling: 401/invalid OpenSubtitles login errors now return the auth error subtitle instead of bubbling an unhandled download failure.
- Login: Improved error classification to bubble up 429/503 so callers can present user-friendly wait-and-retry guidance instead of generic auth errors.
- Guardrails: Block saving Auth without username/password and auto-fall back to V3 if Auth is selected without credentials to avoid runtime login errors.
- Daily quota handling: When OpenSubtitles returns 406 for exceeding the 20 downloads/24h limit, the addon now serves a single-cue error subtitle (0>4h) explaining the quota and advising to retry after the next UTC midnight (mirrors existing PROHIBITED_CONTENT/429/503 behavior).

**OpenSubtitles v3:**

- 429/503 handling: V3 download errors now return a single-cue error subtitle (0>4h) with clear wait-and-retry guidance, consistent with other provider and safety messages.
- Filename extraction: add a single retry after 2s when HEAD requests return 429 during filename extraction; per-attempt timeout remains 3s (processed in batches of 10).
- Format awareness and file-upload translation: infer actual format for OpenSubtitles V3 results from filename/URL (no longer hardcoded SRT); convert uploaded VTT/ASS/SSA to SRT server-side before translation; and always download translated uploads as .srt.

**Other Improvements:**

- Anime season-pack episode detection: match "- 01" and "01en/01eng" filenames inside ZIPs across SubSource, SubDL, and OpenSubtitles.
- Docker: Make Redis AOF fsync settings explicit in `docker-compose.yaml` (`--appendfsync everysec`, `--no-appendfsync-on-rewrite no`) to improve durability and avoid increased risk during AOF rewrites.
- Configuration: The per-language subtitles cap is now configurable via environment variable `MAX_SUBTITLES_PER_LANGUAGE` (default 12, max 50). This replaces the previously hardcoded limit and helps tune UI performance on large result sets.
- Configuration UI: Mask API key/password fields without using `<input type="password">` and disable autocomplete to stop browsers from prompting to save credentials.
- Multiple changes to config page

**Other Bug Fixes:**

- Gemini safety handling: Fixed case where Gemini returned `promptFeedback.blockReason` with no candidates. These are now classified as `PROHIBITED_CONTENT`, enabling the correct error subtitle and retry behavior instead of a generic "No response candidates" error.
- Various minor bug fixes

## SubMaker v1.3.2

**Improvements:**

- Version-aware config migration on app update: resets model and advanced settings to defaults while preserving API keys, provider toggles, source/target languages, and Other Settings. Ensures new/removed config fields are immediately reflected after version change.
- Subtitles ranking improvements for all sources
- Many config page improvements

**Bug Fixes:**

- Fixed SubSource API key validation timing out: endpoint now reuses `SubSourceService` client (proper headers, pooled agents, DNS cache) and performs a single lightweight validation request with clearer error messages

## SubMaker v1.3.1

**Improvements:**

- Multiple changes and improvements to the config page.
- Season and episodes pack ZIP extraction: Prefer .srt over .ass/.ssa when both exist (SubSource & SubDL) to avoid unnecessary conversion and pick native SRT first

## SubMaker v1.3.0

**New Features:**

- Added Gemini 2.5 Pro to translation model dropdown with optimized defaults
- Optional batch context feature: Include original surrounding entries and previous translations when processing batches for improved translation coherence across batch boundaries (disabled by default, can be enabled in Advanced Settings with configurable context size 1-10)
- MicroDVD .sub format support: All subtitle providers now support MicroDVD .sub files with automatic conversion
- Season pack subtitle support: SubSource and SubDL now automatically extract individual episodes from season pack ZIP archives
  - Season packs included in search results as fallback options (ranked last with -5000 penalty)
  - Automatic episode extraction on download (only requested episode extracted from ZIP)
  - Support for both .srt and alternate formats (.vtt, .ass, .ssa, .sub) in season packs
  - Episode info encoded in fileId: `*_seasonpack_s<season>e<episode>`
- Anime season pack support: Enhanced detection and extraction for anime where season numbers are often omitted
  - Detects anime-specific patterns: "complete", "batch", "full series", episode ranges "01-12", "1~12"
  - Episode extraction using anime-friendly patterns: "01", "ep01", "[01]"
  - Avoids false matches with resolutions (1080p) and years (2023)

**Improvements:**

- Changed default translation model from Flash-Lite to Flash on configuration page
- Updated config page beta warning: Changed from "Flash" to "2.5 Pro" to reflect current beta status
- Model-specific default configurations: individual default settings for each model on the configuration page for different translation workflows
- Model-specific thinking budget and temperature defaults
- Dynamic batch sizing: Changed from static to model-based function
- Translation engine now retries batch 1 time on MAX_TOKENS errors before failing to avoid discarding the whole translation
- Enhanced debug logging: Comprehensive Gemini API configuration display showing all parameters (model, temperature, topK, topP, thinkingBudget, maxOutputTokens, timeout, maxRetries)
- Improved Kitsu API reliability: Added retry logic (2 retries at 2s and 6s delays) for all Kitsu and Cinemeta API calls to handle temporary server errors (500) and network issues
- Session statistics now async to support storage-based counting

**Security & Reliability:**

- Session creation rate limiting: Added per-IP rate limiting (10 sessions/hour) to prevent session flooding attacks and monopolization of the global session pool
- Storage session limits: Implemented hard cap of 60,000 sessions in persistent storage (Redis/filesystem) with automatic purge of oldest-accessed sessions to prevent unbounded growth
- Memory session cap reduction: Reduced in-memory session limit from 50,000 to 30,000 for better memory management while maintaining production scale
- Session monitoring & alerting: Added comprehensive monitoring with alerts for storage utilization (warning at >80%, critical at ≥90%), abnormal session growth (>20%/hour), and eviction spikes (>3x average)
- Automatic storage cleanup: Hourly cleanup process that purges 100 oldest-accessed sessions when storage utilization reaches 90%

**Environment Variables:**

- `SESSION_MAX_SESSIONS`: Updated default from 50,000 to 30,000 (in-memory limit)
- `SESSION_STORAGE_MAX_SESSIONS`: New variable, default 60,000 (storage limit)
- `SESSION_STORAGE_MAX_AGE`: New variable, default 90 days (storage retention period)

**Bug Fixes:**

- Fixed .ass to .vtt conversion producing empty files (~23 bytes): Now validates converted VTT contains timing cues and falls back to manual ASS parser if library conversion produces invalid output
- Updated subsrt-ts from 2.0.1 to 2.1.2 for improved conversion reliability
- Removed unused advanced configs from install page

## SubMaker v1.2.6

**Bug Fixes:**
- Translation flow now validates source subtitle size before returning loading message to prevent users from waiting indefinitely for corrupted files
- Fixed purge trigger failing to detect cached translations in bypass cache mode: `hasCachedTranslation` now correctly calls `readFromBypassStorage` instead of non-existent `readFromBypassCache`

## SubMaker v1.2.5

**Bug Fixes:**
- Fixed Spanish (Latin America) language code collision: Changed 'spn' mapping from 'sx' to 'ea' to resolve conflict with Santali language and ensure proper display in Stremio language lists
- Fixed "just fetch subtitles (no translation)" mode returning zero results: Subtitle handler now properly uses `noTranslationLanguages` from config instead of empty `sourceLanguages`/`targetLanguages` arrays

## SubMaker v1.2.4

**New Features:**
- Anime content support: Added AniDB and Kitsu ID mapping services to resolve anime IDs to IMDB for subtitle searching
- Manifest now accepts anime content type and additional ID prefixes (anidb, kitsu, mal, anilist, tmdb)
- Subtitle ID parser enhanced to handle anime-specific ID formats with platform detection
- All subtitle services updated to support anime-episode content type (OpenSubtitles, OpenSubtitles V3, SubDL, SubSource)
- OpenSubtitles auth hint subtitles: When login fails, appends a helpful SRT entry per source language and exposes `error-subtitle/opensubtitles-auth.srt` to guide fixing credentials

**UI Improvements:**
- Configuration page now features three-state theme toggle: Light, Dark and True Dark with cycling icons

**Performance Improvements:**
- Parallelized provider searches with deduplication and safer backoff/retry in SubSource for more resilient fetching

**Bug Fixes:**
- Fixed SafetyBlock error: `inFlightTranslations` now properly exported and imported for 3-click cache reset safety checks
- Subtitle services now gracefully skip search when IMDB ID unavailable (prevents errors with unmapped anime content)
- Fixed anime episode subtitle search: All providers (SubDL, SubSource, OpenSubtitles, OpenSubtitles V3) now default to season 1 for anime episodes without explicit season numbers
- Improved error handling: API error responses now logged safely with proper try-catch to prevent obscure error messages
- Robust subtitle downloads: BOM-aware decoding and ZIP extraction across OpenSubtitles and SubDL with fallback conversion of `.ass/.ssa` to `.vtt` while preserving native `.vtt`
- Anime episode handling refinements: Default season to 1 when missing and improved episode-only filename matching and wrong-episode filtering across providers
- Safer API error logging: Guarded parsing/logging of response payloads with essential fields to prevent logging failures
- SubDL and SubSource API keys now properly redacted in debug logs to prevent credential exposure in debug logs

## SubMaker v1.2.3

**New Features:**
- Native VTT subtitle support: Original VTT files now served directly to Stremio with proper `text/vtt` headers and `.vtt` file extension
- Fixed VTT content type detection: Server now properly detects VTT content and serves with correct MIME type

**UI Improvements:**
- Improved loading subtitle messages
- Simplified partial translation messages

## SubMaker v1.2.2

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

## SubMaker v1.2.0, 1.2.1

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


## SubMaker v1.1.7

**New Features:**
- Refined error messages: Improved user-facing error descriptions for safety filter blocks, rate limits, authentication failures, and source file issues

**Bug Fixes:**
- Expanded error type mapping: Enhanced error handler to classify all error types (403, 429, 503, MAX_TOKENS, PROHIBITED_CONTENT, RECITATION, SAFETY, INVALID_SOURCE)
- Fixed 3-click cache reset safety: Now prevents cache deletion when user is at the concurrent translation limit, avoiding abuse and data loss

## SubMaker v1.1.6

**New Features:**
- **Multi-Model Support**: Added Gemini model selection dropdown on config page with two options:
  - Gemini 2.5 Flash - Better quality, slower
  - Gemini 2.5 Flash-Lite - Well tested, faster and cheaper alternative (recommended if Flash has issues)
- Advanced Settings can still override the selected model for per-translation customization

## SubMaker v1.1.5

**Bug Fixes:**
- Fixed PROHIBITED_CONTENT error detection: Now properly identifies all safety filter errors (PROHIBITED_CONTENT, RECITATION, SAFETY) and displays appropriate user message instead of generic "please retry" text
- Improved HTTP error detection: Added direct HTTP status code checking (403, 503, 429) for better error classification and messaging
- Enhanced error messages: Users now see specific error descriptions for 503 (service overloaded), 429 (rate limit), and 403 (authentication) errors instead of generic fallbacks

**Translation Engine Improvements:**
- Better error caching: Translation errors are now properly cached for 15 minutes, allowing users to understand what went wrong and retry appropriately

## SubMaker v1.1.4

**Bug Fixes:**
- Fixed Gemini API key validation: Removed duplicate model fetching messages that appeared after clicking "Test" button
- Fixed Gemini API key input: Green border now only appears when API key is successfully validated by backend, not just when field is not empty
- Moved model fetching status messages to Advanced Settings section only (no longer shows in main config area)

## SubMaker v1.1.3

**New Features:**
- **Gemini v1beta endpoint rollback**: Fixing previous change that introduced problems.
- **API Key Validation**: Added "Test" buttons to validate API keys for SubSource, SubDL, OpenSubtitles, and Gemini directly from the config page
- **Dark Mode**: All addon pages now support automatic dark/light themes based on system preference with manual toggle buttons

**Bug Fixes:**
- Fixed config page: Gemini API key validation now properly displays notification alerts when field is empty
- Fixed config page: "Just-fetch subtitles" mode now clears validation errors for translation-only fields (Gemini API key, source/target languages)
- Fixed config page: Switching between translation and no-translation modes now clears language selections from the previous mode to prevent unwanted languages from being saved
- Various minor  fixes.

## SubMaker v1.1.2

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

## SubMaker v1.1.1

**Bug Fixes:**
- Fixed Gemini model defaults: Old session tokens with deprecated models (gemini-flash-latest, gemini-2.0-flash-exp) now automatically use current stable model
- Fixed compression middleware crashes on some environments
- Fixed encryption key regeneration on server restart (was causing session loss)
- Fixed session token error messages displaying incorrectly in Stremio

**Configuration:**
- Added environment variable support for AI translation settings (temperature, top-K, top-P, thinking budget, output tokens, timeout, retries)
- Model defaults consolidated to single source of truth (easier to maintain, eliminates redundancy)
- Deprecated model override system with easy re-enable flag for future user selection

## SubMaker v1.1.0

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

## SubMaker v1.0.3

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

## SubMaker v1.0.2

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

## SubMaker v1.0.1

**Features:**
- Progressive subtitle updates during translation: partial SRT saved after each chunk and served while translation is in progress
- Optional token-level streaming for Gemini (enable via `advancedSettings.enableStreaming`)
- Version badge added to configuration and translation selector pages
- `/api/session-stats` endpoint now includes version info

**Bug Fixes:**
- Fixed SRT integrity during partial loading: entries reindexed and tail message positioned after last translated timestamp
- Fixed addon URL generation for private networks (192.168.x.x, 10.x.x.x, 172.16-31.x.x ranges now recognized as local, preventing forced HTTPS)
