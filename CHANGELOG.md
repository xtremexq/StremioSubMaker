# Changelog

All notable changes to this project will be documented in this file.

## SubMaker v1.4.53

**Improvements:**

- **Partial delivery checkpoint schedule logged at translation start:** When streaming translation begins, the addon now logs the full checkpoint schedule showing exactly when partial saves will trigger (e.g., `first=30, step=75, checkpoints=[30, 105, 180, 255, 324]`), along with debounce, minimum delta, and log interval settings. This makes it immediately clear what the save cadence will be for a given file size and streaming mode.

- **Partial saves always logged with next checkpoint info:** Partial cache saves are now always logged with a `[Translation] Partial SAVED:` message that includes the current entry count and the next checkpoint target (`nextCheckpoint=180`). Previously, save logs were throttled by the same interval as progress logs (every 100 entries), making it appear that saves weren't happening when they actually were at checkpoint boundaries (30, 105, 180...).

- **Accurate partial save skip reasons in logs:** Replaced the generic `"partial save skipped by throttle"` log message with detailed skip reasons: `"checkpoint not reached (next=105)"` when waiting for the next save boundary, `"debounce (delta=5<10, elapsed=1200ms<3000ms)"` when new data arrived too fast, `"stale sequence"` for duplicate stream events, or `"batch already saved"` in multi-batch mode. Eliminates ambiguity about why a particular progress event didn't trigger a save.

- **First-in-chain request tracing:** Added a new middleware at the very top of the Express stack (before helmet, CORS, compression) that logs `[Request Trace] >>>` for all subtitle and manifest requests. If a request doesn't produce this log, it truly never reached the server — helping diagnose "Stremio not sending requests" issues.

- **Cache buster redirects now logged:** 307 redirects from the cache-buster middleware now log at DEBUG level showing the redirect path.

- **OpenSubtitles auth hash matching:** When a real Stremio `videoHash` is available (from torrent-based streaming addons like Torrentio), the OpenSubtitles auth search now includes the `moviehash` parameter. Subtitles that the API confirms as exact file matches (`moviehash_match=true`) are flagged with `hashMatch: true` and ranked in Tier 0 alongside SCS hash matches.

- **Provider-agnostic Tier 0 hash ranking:** The highest-priority subtitle ranking tier (200,000+ points) is no longer exclusive to Stremio Community Subtitles. Any provider that sets `hashMatch: true` on its results now qualifies for Tier 0 ranking, enabling OpenSubtitles auth hash-matched subtitles to rank at the top alongside SCS.

- **Offline anime ID resolver (Fribb/anime-lists):** Added `animeIdResolver.js` — a new service that loads the complete [Fribb/anime-lists](https://github.com/Fribb/anime-lists) dataset (~42,000 entries) into memory at startup, building O(1) `Map` lookups for Kitsu, MAL, AniDB, and AniList IDs → IMDB/TMDB. Anime ID resolution now completes instantly via local Map lookup instead of making live API calls to Kitsu, Jikan, AniList GraphQL, or Wikidata SPARQL. Existing live API services are retained as fallbacks for entries not in the static list. The data file is auto-downloaded on first startup if missing, and auto-refreshed weekly with Redis leader election for multi-instance deployments (only one pod downloads; others detect the update via a Redis timestamp key and reload).

- **History title resolution for all anime platforms:** Previously, only Kitsu anime entries in Translation History could resolve titles (via the Kitsu API). MAL, AniDB, and AniList entries showed raw IDs (e.g., `mal:20:1:5`). Now, the offline resolver maps any anime platform ID → IMDB, then Cinemeta provides the title. The Kitsu API remains as a final fallback for Kitsu IDs if the offline→Cinemeta path fails.

- **Native JSON translation workflow:** Added "JSON (Structured)" as a fourth Translation Workflow option alongside Original Timestamps, Send Timestamps to AI, and XML Tags. When selected, subtitle entries are sent to the AI as a clean JSON array (`[{"id":1,"text":"..."},...]`) and the AI responds in the same format — no format ambiguity. This replaces the old `enableJsonOutput` toggle, which bolted JSON instructions onto existing workflows causing "Pattern Trap" issues where the AI ignored the JSON format and returned numbered lists. The new workflow has a dedicated prompt (`_buildJsonPrompt`), input formatter (`_prepareJsonBatchContent`), and response parser. Batch size is intrinsically capped at 150 entries for JSON to reduce syntax errors. Full context support: when batch context is enabled, context is wrapped in a `__context` key in the JSON payload.

- **Auto-migration from enableJsonOutput toggle:** Users who had the old `enableJsonOutput` checkbox enabled are automatically migrated to the new `json` workflow on config load. The `ENABLE_JSON_OUTPUT` environment variable is deprecated but still works (auto-migrates during config validation). Old saved configs with `enableJsonOutput: true` seamlessly upgrade to `translationWorkflow: 'json'` without user intervention.


**Bug Fixes:**


- **Improved auto-sub merge logic for capitalized text:** The `shouldMergeAutoSubEntries` function no longer blocks merging when the next subtitle starts with a capital letter. Previously, any capital letter at the start prevented merging (treating it as a new sentence/speaker), but sentence boundaries are already caught by the punctuation check. Now only obvious speaker/section markers (`-–—♪`) block merging.

- **Reduced minimum subtitle duration from 1200ms to 800ms:** The `splitLongEntry` function now uses 800ms minimum slice duration instead of 1200ms, allowing more granular subtitle timing for fast-paced dialogue.

- **Fixed zero-duration subtitle entries:** Added explicit guard in `splitLongEntry` to prevent zero-duration entries — if `end <= start`, the end time is set to `start + 800ms`.

- **Ensured 800ms minimum duration in final SRT output:** The `normalizeAutoSubSrt` function now enforces a minimum 800ms duration for each subtitle entry during final processing, catching any edge cases missed earlier in the pipeline.

**User Interface:**

- **Simplified Auto Subs translation settings:** Removed the collapsible "Translation Settings" panel and its contents (provider selector, model selector, batch mode, timestamps mode). Translation now uses the settings from the main addon configuration. The target language dropdown remains inline with the translate toggle.

- **Removed unused VAD filter and AssemblyAI options from UI:** Removed the "VAD Filter" checkbox and "Send Full Video" checkbox from the Auto Subs page. VAD filter is now always enabled for Cloudflare mode; AssemblyAI no longer accepts the `sendFullVideo` option.

- **Re-enabled Local mode option:** The Local transcription mode option in the Auto Subs dropdown is no longer disabled, allowing selection when a local transcription setup is available.

- **Forced Cloudflare to use whisper-large-v3-turbo:** When Cloudflare mode is selected, the model dropdown is now hidden and the model is automatically set to `@cf/openai/whisper-large-v3-turbo`.

- **Cloudflare and AssemblyAI modes hide source language and model selectors:** When either Cloudflare or AssemblyAI mode is selected, the source language and model dropdowns are hidden (in addition to the audio track selector) since these services auto-detect language.

- **Improved step card CSS:** Fixed grid alignment (`align-items: start`), added `min-height: 0` to prevent unwanted stretching, and set `height: auto !important` on step 2 card for proper content-based sizing.

- **JSON workflow added to Translation Workflow dropdown:** The Translation Workflow selector now offers four options: Original Timestamps, Send Timestamps to AI, XML Tags (Robust), and JSON (Structured). The old "Enable JSON Structured Output" checkbox has been removed from Advanced Settings — its functionality is now fully integrated into the workflow dropdown.

**Cleanup:**

- **Removed orphaned `_buildXmlInputJsonOutputPrompt` method:** The old XML-input + JSON-output hybrid prompt builder (48 lines) was no longer called after the `enableJsonOutput` bolt-on removal. Its functionality is now handled natively by `_buildJsonPrompt` in the `json` workflow.

- **Removed dead `enableJsonOutput` UI wiring:** Cleaned up 4 stale references in `public/config.js`: event listener for removed checkbox, `areAdvancedSettingsModified()` comparison, save logic, and simplified-mode hide list.


## SubMaker v1.4.52

**New Features:**

- **SubMaker Database (SMDB) — community subtitle sharing:** Introduced a full-featured community subtitle database that lets users upload, browse, download, and translate subtitles linked to specific video streams. SMDB uses a dedicated Redis-backed cache (`SMDB` cache type, 2 GB default, LRU eviction, no TTL) with a new `smdbCache.js` module for storage and a `smdbPageGenerator.js` module for the UI page. Key capabilities:
  - **Upload subtitles** linked to a video hash with language selection, 2 MB content guard, and override support (max 3 overrides per user per hour).
  - **Multi-hash subtitle lookup** — the subtitle handler queries both the real Stremio hash (`extra.videoHash` from streaming addons like Torrentio) and the derived per-stream hash, enabling cross-source subtitle matching. Matching SMDB subtitles appear in Stremio's subtitle list as `SMDB (<language>)` entries.
  - **SRT serving endpoint** (`/smdb/:videoHash/:langCode.srt`) — serves SMDB subtitles directly to the Stremio player with `Access-Control-Allow-Origin: *`.
  - **Full API suite** — `GET /api/smdb/list` (list subtitles for a hash), `GET /api/smdb/download` (download subtitle content), `POST /api/smdb/upload` (upload with override/rate-limit support).
  - **SMDB page** (`/smdb`) — standalone HTML page generated by `smdbPageGenerator.js`, accessible from all QuickNav links across all tool pages.
  - **Stremio addon redirect** — `/addon/:config/smdb/:videoId` redirects to the standalone SMDB page with config, videoId, and filename preserved.
  - Security middleware updated to allow SMDB routes (`/smdb`, `/api/smdb/*`) through CORS and origin checks.

- **Redis Pub/Sub for cross-instance stream activity:** On multi-pod deployments (e.g. ElfHosted), stream activity events are now broadcast via Redis Pub/Sub so the SMDB page can detect linked streams from any instance. Each instance gets a unique `INSTANCE_ID`; published events include `configHash` and full stream entry. Remote events update the local LRU cache and notify local SSE listeners. Uses a dedicated subscriber connection (`redisClient.duplicate()`) as required by ioredis. Graceful shutdown unsubscribes and disconnects. Filesystem deployments are unaffected (pub/sub is a no-op).

- **Stremio hash propagation for cross-source matching:** The subtitle handler now extracts the real OpenSubtitles-style video hash from `extra.videoHash` (provided by streaming addons like Torrentio) and passes it as `stremioHash` through the stream activity system. This hash is persisted alongside the derived per-stream hash, propagated through heartbeats and gap-filling logic, and included in change detection — enabling SMDB to match subtitles across different sources for the same video.

**User Interface:**

- **Sub Toolbox page overhaul:** The hero section is now split into a styled hero-content card (with its own background, border, and border-radius) and a separate `hero-right` column containing the tool shelf. The hero card background gradient was moved from the outer `.hero` grid to the inner `.hero-content` for sharper visual separation. Padding, gaps, and margins throughout the hero and tool tiles were tightened for a more compact layout.

- **"SubMaker Database" button added to Toolbox hero:** A new shimmer-animated SMDB CTA button (📪 SubMaker Database) is placed between "Translation History" and the Configure button. Fully styled for light, dark, and true-dark themes with gradient backgrounds, hover lift/glow animations, and a subtle shimmer sweep.

- **"Translation History" button renamed and styled:** The "Translation Status" button was renamed to "Translation History" (📣 icon added) with updated text-transform, font-size, and letter-spacing to match the new SMDB button.

- **Configure button replaced with emoji:** The "Configure" text button in the Toolbox hero was replaced with a compact 🛠️ emoji-only button.

- **Navbar button sizes reduced ~35%:** All QuickNav buttons across all pages were made more compact — padding, gap, font-size, icon sizes, pill sizes, border-radius, box-shadow, and the refresh button dimensions were all scaled down by roughly 35%. Mobile breakpoint retains full-size buttons for touch targets.

- **"Database" link added to QuickNav:** A new 📪 Database link appears in the QuickNav bar between "Auto subs" and "History" on all tool pages (Toolbox, File Upload, Sync, Embedded Subs, Auto Subs, History, and SMDB). The SMDB link is wired into `buildToolLinks()` in every page generator.

- **Configure button moved after History in QuickNav:** The 🛠️ Configure link now appears after the History link instead of before it, matching the new button order in the Toolbox hero.

- **SMDB section on Toolbox page:** An SMDB hint section with a dashed-border callout and styled SMDB button was added to the toolbox, with full theme support (light/dark/true-dark).

**Bug Fixes:**

- **Fixed missing SMDB directory mapping in FilesystemStorageAdapter:** The `SMDB` cache type was defined in `StorageAdapter.CACHE_TYPES` but had no corresponding directory mapping in `FilesystemStorageAdapter`, causing storage errors on filesystem deployments. Added `path.join(this.baseDir, 'smdb')` mapping.

**Localization:**

- Updated `toolbox.hero.body` text across all 5 locales (en, es, ar, pt-br, pt-pt) to "Enjoy SubMaker's Toolbox!".
- Added `toolbox.hero.smdbHint` key across all 5 locales for the SMDB upload/translate hint.
- Renamed `toolbox.hero.primary` from "Translation Status" to "Translation History" across all 5 locales.

**Infrastructure:**

- **`StorageFactory.getRedisClient()` helper:** New static method on `StorageFactory` that returns the underlying ioredis client (or `null` for filesystem deployments), used by the pub/sub initialization.
- **`RedisStorageAdapter.getClient()` method:** Exposes the initialized ioredis client for creating duplicate connections (needed for Redis Pub/Sub subscriber).

## SubMaker v1.4.51

**Bug Fixes:**

- **Fixed OpenSubtitles 403 rate-limit responses being cached as authentication failures:** When OpenSubtitles returned a 403 "You cannot consume this service" (API key rate-limited/blocked), the error was misclassified as an authentication failure and cached for 5 minutes by `credentialFailureCache`. All subsequent login attempts — both from the config page test button and from actual Stremio subtitle requests — were instantly blocked without contacting OpenSubtitles, showing misleading error messages. The fix detects 403 responses with rate-limit keywords ("cannot consume", "throttle", "too many", "rate limit") and reclassifies them as `rate_limit` errors (429), preventing them from being cached as bad credentials.

- **Fixed validate endpoint not retrying on rate limit (429):** The `/api/validate-opensubtitles` endpoint (config page "Test" button) now retries up to 3 times with exponential backoff (2s, 4s) when OpenSubtitles returns a rate limit error, instead of immediately failing. If all retries are exhausted, the error message now clarifies it's a temporary server-side issue, not a credentials problem.

- **Added cached token fast path to validate endpoint:** The validate endpoint now checks if a valid cached token already exists for the given credentials before calling OpenSubtitles `/login`. If a token is found, credentials are confirmed valid instantly without any API call — eliminating unnecessary rate-limit pressure on the shared API key.

- **Fixed OpenSubtitles CDN 403 showing wrong error message in Stremio:** When the OpenSubtitles CDN returned a 403 for a specific subtitle file (file unavailable on CDN — a per-file issue, not an auth issue), the subtitle download error handler in `subtitles.js` treated ALL 403s as authentication failures and displayed "Please check your OpenSubtitles credentials in the addon configuration and reinstall." Now, CDN 403s (containing "cdn", "file unavailable", "varnish") and rate-limit 403s (containing "cannot consume", "throttle", "rate limit", "too many") are excluded from the auth error path and instead show a generic download failure message.

- **Multiple other fixes.**

## SubMaker v1.4.50

**Bug Fixes:**

- **Fixed `Array buffer allocation failed` crash on large streams:** The xSync extension's `fetchFullStreamBuffer` attempted to pre-allocate a single `Uint8Array` for the entire stream, exceeding V8's ~2GB `ArrayBuffer` limit on streams over 3GB. Rewrote the function to use a chunked streaming approach that collects data incrementally and enforces a 1.8GB safety cap — streams exceeding the cap are gracefully truncated and marked as partial instead of crashing. Also added the same 1.8GB memory cap to `fetchByteRangeSample` (via new `readResponseCapped` helper) and `fetchFullHlsStream` (cumulative segment size guard).

- **Fixed OpenSubtitles CDN 403 misreported as "Authentication failed":** When the OpenSubtitles CDN (Varnish cache server) returned a 403 for a specific subtitle file (file unavailable on CDN, not an auth issue), the error was misclassified as "Authentication failed. Please check your API credentials." by `apiErrorHandler.js`. The download now catches CDN-specific 403/410 errors separately and reports them as "Subtitle file unavailable on OpenSubtitles CDN" with a suggestion to try a different subtitle, instead of misleading users into thinking their credentials are wrong.

**User Interface:**

- **Quick Setup color scheme update:** Updated the Quick Setup wizard to use the same cyan-blue color palette as the main configuration page (`#08A4D5` and variants). Previously used indigo/purple tones that didn't match the overall addon aesthetic. The new color scheme is applied consistently across all three themes (Light, Dark, and Pure Dark/Blackhole).

**Cleanup:**

- **Removed ~860 lines of dead server-side stream-fetching code:** Removed 7 unused constants and 14+ unused functions from `index.js` related to server-side stream downloading, Cloudflare Workers transcription, and AssemblyAI transcription (`fetchWithRedirects`, `downloadStreamAudio`, `transcribeWithCloudflare`, `downloadFullStreamToFile`, `uploadToAssembly`, `transcribeWithAssemblyAi`, and all their helpers). None of these were called from any active route — the auto-subtitle API already requires client-provided transcripts.

## SubMaker v1.4.49

**Changes:**

- **Removed Gemma 27b model:** Removed the Gemma 27b model from the configuration options as it is no longer supported/recommended.

**Bug Fixes:**

- **Fixed Quick Setup not loading existing settings:** Resolved an issue where the Quick Setup wizard would sometimes show an empty state instead of loading the user's existing configuration, particularly if the wizard had been previously opened within the same browser session.

- **Improved Gemini API Key Validation:** Updated the Quick Setup wizard to validate Gemini API keys via the server-side proxy (`/api/validate-gemini`) instead of direct client-side requests, improving reliability and avoiding CORS issues.

- **Fixed Rotation Frequency label layout:** Corrected excessive margin between the "Rotation Frequency" label and its descriptive text in the Gemini settings.

- **Quick Setup safe updates:** The wizard now merges your changes with your existing configuration instead of overwriting it, ensuring advanced settings are preserved.

- **Quick Setup styling improvements:** Adjusted spacing, font sizes, and link colors in the wizard for a more compact and consistent look.

## SubMaker v1.4.48

**New Features:**

- **Quick Setup wizard:** Added a 6-step guided setup wizard for new users. On first visit (no saved session), an entry banner appears at the top of the config page. The wizard walks through: (1) Mode selection (Translate vs. Just Fetch), (2) Subtitle sources with optional OpenSubtitles account login for higher rate limits/VIP features, (3) Gemini API key with live validation against the Google API, (4) Language selection with searchable grid, popular language highlighting, and chip display, (5) Extras (Sub Toolbox, Season Packs, Hide SDH/HI), (6) Summary & Install with direct session creation, Stremio install link, and copy URL. Includes an "Open Advanced Settings" button that pre-fills the main config form with wizard choices for further fine-tuning. The wizard is fully standalone (`quick-setup.js`) and can be removed by deleting 4 references.

- **Expanded archive format support:** The archive extractor now handles 6 additional formats beyond ZIP and RAR: **Gzip**, **Brotli**, **7-Zip**, **Tar**, **Bzip2**, and **XZ**. Includes recursive decompression for layered archives (e.g., `.tar.gz` — Gzip layer is decompressed first, then the inner Tar is extracted). Detection uses magic bytes for all formats. Gzip and Brotli use Node.js built-in `zlib`; Tar uses `tar-stream`; 7-Zip uses `7z-iterator`. Bzip2 (`seek-bzip`) and XZ (`lzma-native`) are optional — if not installed, the addon logs a debug message and skips gracefully. The response analyzer (`analyzeResponseContent`) also detects the new formats and no longer treats Gzip as an error response.

**Bug Fixes:**

- **Fixed valid subtitles being misclassified as error responses:** The response content analyzer (`analyzeResponseContent`) checked for error keywords like "error", "failed", "denied" *before* checking if the response was a valid subtitle file. Any SRT whose dialogue contained those common English words (e.g. an episode about hacking, security, etc.) would be replaced with an error message and cached. Reordered the checks so subtitle format detection (SRT, VTT, ASS/SSA, MicroDVD, MPL2) always runs first. Also added a BOM-stripping step and a fallback timecode scan (`HH:MM:SS,ms -->`) so subtitles with unusual headers or encoding prefixes are still recognized.

- **Hardened text_error detection to reduce false positives:** Replaced the naive `includes('error')` check with word-boundary matching (`\b`) to avoid triggering on words like "terror" or "mirror". Longer responses (≥500 bytes) now require the content to *start* with an error keyword to be classified as `text_error` — a single "error" buried in a large response is no longer enough. Added additional error keywords: "unauthorized", "not found", "bad request", "service unavailable", "internal server".

- **Prevented error/informational subtitles from being cached:** The download cache (`downloadCache.saveCached`) now skips caching content that contains addon-generated error markers ("download failed:" or "informational subtitle was generated by the addon"). Previously, a misclassified error subtitle would be cached for 10 minutes and served on every subsequent request for the same file.

- **Added OpenSubtitles registration link:** The "free account" text in the OpenSubtitles Auth description now links directly to the OpenSubtitles.com registration page.

- **Fixed corrupted archive error messages showing wrong format:** `createCorruptedArchiveSubtitle()` was hardcoded to display either "ZIP" or "RAR" — any other archive type (Gzip, 7z, Tar, etc.) would show "Corrupted ZIP file". Now dynamically uses the detected archive type (e.g., "Corrupted GZIP file", "Corrupted 7Z file").

- **Fixed Gzip responses treated as errors in OpenSubtitles Auth and SubsRo:** When a provider returned Gzip-compressed content, the response analyzer classified it as `type: 'gzip'` which was then treated as an error response, showing users a "download failed" message. Removed `gzip` from the error type list since Gzip is now a properly handled archive format detected by `detectArchiveType()`.

- **Updated stale archive comments across all providers:** Removed outdated "ZIP or RAR" and "handles both ZIP and RAR" references in `opensubtitles.js`, `opensubtitles-v3.js`, `subdl.js`, and `subsource.js`. JSDoc for `isArchive()` and `readFileFromArchive()` in `archiveExtractor.js` now lists all supported formats.

## SubMaker v1.4.47

**Bug Fixes:**

- **Fixed OpenSubtitles rate limiting on multi-pod deployments (ElfHosted):** OpenSubtitles API has aggressive rate limiting on `/login` (~1 request every 2 seconds per API key). On multi-pod deployments like ElfHosted, each pod had its own in-memory token cache, causing redundant login calls that quickly hit the rate limit. **Root cause:** Token cache was a simple JavaScript `Map` not shared across pods. **Solution:** Migrated OpenSubtitles JWT token cache to Redis for cross-pod sharing. Tokens are now stored in Redis with 23-hour TTL, ensuring all pods reuse the same token. Also refactored `/api/validate-opensubtitles` endpoint to use the cached OpenSubtitlesService instead of making direct axios calls (which bypassed the cache entirely).

- **Added VIP API endpoint support for OpenSubtitles:** VIP users now automatically use OpenSubtitles' dedicated VIP server (`vip-api.opensubtitles.com`) which is faster and more stable. When a VIP user logs in, the service extracts the `base_url` from the login response and switches all subsequent requests to the VIP endpoint. The VIP base_url is stored in Redis alongside the JWT token, ensuring all pods use the faster endpoint automatically.

- **Improved OpenSubtitles rate limit error message:** The validation endpoint now shows a clearer message explaining the server-side rate limit (1 req/sec) and suggests waiting before retrying.

- **Fixed OpenSubtitles API headers per official documentation:** Changed `Accept: application/json` to `Accept: */*` as required by OpenSubtitles docs (prevents 406 errors). Also restored `Api-Key` header on all requests including downloads, per docs: "In every request should be present these HTTP headers... Api-Key". Removed unnecessary `validationLimiter` from the validation endpoint since OpenSubtitles handles their own rate limiting server-side.

- **Multiple other minor fixes across the addon.**

## SubMaker v1.4.46

**New Features:**

- **Season pack subtitle toggle:** Added an "Include Season Pack Subtitles" option in Other Settings that controls whether season pack subtitles (containing multiple episodes) appear in results. Enabled by default for backwards compatibility. When disabled, subtitles flagged as `is_season_pack` are filtered out, showing only episode-specific subtitles. Toggle is available in both translation and "Just Fetch" modes.

- **ASS/SSA conversion toggle (alpha - Dev mode):** Added a "Convert ASS/SSA to VTT" option in Other Settings. Enabled by default for backwards compatibility. When disabled, ASS/SSA subtitles are passed directly to Stremio without conversion, preserving original styling (colors, fonts, positioning). Stremio natively supports ASS/SSA subtitles. The toggle is automatically disabled (grayed out) when "Force SRT output" is enabled, since Force SRT requires converting all formats to SRT.

**Bug Fixes:**

- **Added 500/502/504 gateway error handling:** When subtitle servers return gateway errors (Bad Gateway, Internal Server Error, Gateway Timeout), users now see a provider-specific informational subtitle instead of a generic 404. All 7 providers covered (SubDL, SubSource, OpenSubtitles Auth, OpenSubtitles V3, SCS, Wyzie Subs, Subs.ro).

- **Added network-level error handling:** Connection failures now show helpful error messages instead of failing silently. Covers: `ECONNREFUSED` (connection refused), `ENOTFOUND` (DNS failures), `ECONNRESET` (connection reset), `EHOSTUNREACH`/`ENETUNREACH` (unreachable), and SSL/TLS errors. Each error type shows a specific, actionable message.

- **Fixed unhandled errors returning generic 404:** Previously, any error not explicitly caught would propagate to the route handler and return "Subtitle not found (404)". Now, all unhandled errors fall through to a generic fallback that returns an informational subtitle with the provider name and a helpful message, ensuring users always understand what went wrong.

- **Added handling for unsupported subtitle formats:** VobSub (.sub image-based), .idx (VobSub index), .sup (PGS/Blu-ray), and other binary/image-based subtitle formats now return a user-friendly informational subtitle explaining the format is unsupported, instead of displaying garbage content. Also added binary content detection (>10% non-printable characters) and a generic fallback for any format that fails all conversion attempts. OpenSubtitles V3 now uses the centralized converter to benefit from this handling.

- **Unified ASS/SSA conversion across all providers:** WyzieSubs and SCS now convert ASS/SSA subtitles to VTT using the centralized `convertSubtitleToVtt()` function (previously only logged detection). OpenSubtitles Auth's redundant ~50-line inline ASS converter was replaced with a single call to the centralized converter. All providers now benefit from the same robust conversion chain: enhanced `assConverter` → `subsrt-ts` fallback → manual parser → informational subtitle for failures.

- **Centralized ASS/SSA→SRT conversion for all translation paths:** Created `convertToSRT()` and `ensureSRTForTranslation()` in `src/utils/subtitle.js` — a centralized converter that handles any subtitle format (ASS/SSA/VTT/SRT) and converts to SRT for the translation engine. Uses a 3-strategy fallback chain for ASS/SSA: (1) enhanced `assConverter` ASS→VTT→SRT, (2) direct `subsrt-ts` ASS→SRT, (3) manual Dialogue-line parser as last resort. Previously, translation paths only handled VTT→SRT and would pass raw ASS/SSA content to the translation engine when the "Convert ASS/SSA to VTT" toggle was disabled. All 4 translation code paths updated: `performTranslation` (subtitle handler), `/api/translate-file` (file upload), learn mode endpoint, and embedded translate endpoint. Inline `require('subsrt-ts')` conversion blocks replaced with single `ensureSRTForTranslation()` calls. Also rewrote `maybeConvertToSRT()` to delegate to `convertToSRT()` for consistent behavior with the Force SRT output option.

- **Updated ASS/SSA conversion toggle description:** Config page tooltip now clarifies that translations always convert automatically regardless of the toggle setting: "Converts ASS/SSA subtitles to VTT format for compatibility. Disable to send ASS/SSA subtitles as-is to Stremio. (Translations always convert automatically)".

## SubMaker v1.4.45

**Bug Fixes:**

- **Fixed 429 rate limit errors blocking all users on shared hosting (ElfHosted, etc.):** v1.4.41 changed `trust proxy` to default to `false`, which broke rate limiting on deployments behind reverse proxies. All users appeared to share the same IP (the proxy's IP), causing the session creation limit (10/hour) to be exhausted almost immediately. Production deployments (Redis storage) now default to `trust proxy: 1`, ensuring real client IPs from `X-Forwarded-For` headers are used. Local development still defaults to `false`. This will be reviewed in a future update.

- **Added rate limiting to API credential validation endpoints:** All validation endpoints (`/api/validate-opensubtitles`, `/api/validate-subdl`, `/api/validate-gemini`, `/api/validate-subsource`, `/api/validate-subsro`) now share a `validationLimiter` (15 requests per 5 minutes per IP) to prevent hammering external APIs.

- **Improved OpenSubtitles 429 error handling:** When OpenSubtitles API returns a rate limit error during credential validation, the addon now returns a user-friendly message instead of passing through the raw API error. Users are informed their credentials may still be valid and can try saving without validation.

## SubMaker v1.4.44

**Bug Fixes:**

- **Fixed subtitle cache storing sparse/empty results:** When subtitle providers timed out or returned 0 results, the addon was caching these empty results for 10 minutes. Subsequent requests would hit the cache and return 0 subtitles instead of retrying. Now, search results with fewer than 3 subtitles are not cached, allowing fresh searches on the next request. Added a `MIN_CACHED_SUBTITLES_THRESHOLD` constant (default: 3) that controls this behavior.

- **Removed noisy i18n debug logging:** Removed the debug trace logging in `getTranslator()` that was printing stack traces for every non-English translator call (e.g., `[i18n] getTranslator called with lang='en-us' (stack: ...)`).

- **Improved SubDL season pack detection:** Fixed edge cases in SubDL's season pack detection logic. The API's `full_season` field is always `false` (broken), so detection now relies on `episode`, `episode_from`, and `episode_end` fields. Fixed handling where `episode_end=0` is now correctly treated as "not set" (previously caused false negatives). Added `is_multi_episode_pack` flag to distinguish explicit episode ranges (e.g., 1→37) from full season packs. Multi-episode packs now include `episode_range` metadata.

## SubMaker v1.4.43

**Improvements:**

- **Kitsu service migrated to LRUCache:** Replaced unbounded `Map` cache with `LRUCache` (max 2000 entries, 24h TTL, `updateAgeOnGet: true`). This prevents unbounded memory growth on high-traffic instances while maintaining cache effectiveness. Cache hit/miss logic simplified — LRUCache handles TTL automatically.

- **MAL service migrated to LRUCache:** Same LRUCache migration (max 1000 entries, 24h TTL) for the MAL→IMDB mapping service. Prevents memory leaks from long-running servers accumulating stale anime ID mappings.

- **Improved Jikan API rate limit handling:** The MAL service now uses conservative retry delays (3s/6s instead of 2s/6s) to better respect Jikan's 3 req/sec limit. On 429 errors, the service now parses the `Retry-After` header when present and waits the specified duration (+500ms buffer), falling back to a 4s delay when the header is missing. Previously used a fixed 3s minimum which could still trigger rate limits.

- **Multi-instance: Anime ID caches migrated to Redis:** All 4 anime ID mapping services (MAL, AniList, AniDB, Kitsu) now use Redis-backed shared cache (`PROVIDER_METADATA`) instead of in-memory caches. This ensures anime→IMDB lookups are shared across pods — if pod 1 resolves `kitsu:8640` to `tt1234567`, pod 2 will get the cached result without making another external API call. Uses 24h TTL for successful lookups, 10min for misses.

- **Multi-instance: TMDB→IMDB cache migrated to Redis:** The `resolveImdbIdFromTmdb()` cache now uses Redis instead of a local `LRUCache`. Previously, each pod maintained its own cache, causing duplicate Cinemeta/Wikidata lookups for the same TMDB ID. Now shared across pods with 24h/10min TTLs.

- **Multi-instance: User concurrency tracking migrated to Redis:** Per-user translation concurrency limits are now enforced across all pods via Redis atomic counters. Previously, a user could bypass the 3-concurrent-translation limit by having requests routed to different pods. Includes a 30-minute TTL safety net — if a pod crashes mid-translation, the orphaned count will auto-expire instead of blocking the user forever.

- **New `sharedCache.js` utility:** Added centralized Redis cache utility (`src/utils/sharedCache.js`) with `getShared()`/`setShared()` for cache operations and `incrementCounter()`/`decrementCounter()` for atomic Redis counters. Used by all multi-instance fixes.

- **Multi-instance: Key health and rotation migrated to Redis:** API key error counts are now tracked in Redis via `recordKeyError()` and `isKeyCoolingDown()` in `sharedCache.js`. When any pod marks a key as unhealthy (5+ errors), all pods skip it for the 1-hour cooldown period. The round-robin key selection counter is also shared via `getNextRotationIndex()`, enabling truly distributed load balancing. Uses atomic `HINCRBY` for error counting and `INCR` for rotation.

- **TranslationEngine async key rotation:** `_rotateToNextKey()` and `maybeRotateKeyForBatch()` are now async methods that query Redis for cross-pod key health before selecting the next key. Local Map cache is kept as a fast layer; Redis is source of truth. All call sites updated with `await`.

**Bug Fixes:**

- **Added SubDL download retry for 503 errors:** When SubDL's download server returns a 503 (Service Unavailable), the addon now retries up to 2 times with exponential backoff (2s, 4s delays) before giving up. This handles temporary SubDL server overload without failing immediately.

- **Increased SubDL download timeout from 12s to 20s:** SubDL's download server (`dl.subdl.com`) has been consistently slow (10-20s response times for small files), causing timeout errors. Increased the default download timeout to accommodate their server latency while keeping the search API timeout unchanged.

- **Fixed cache hits missing timecodes:** When the translation cache returned a hit, the resulting entry was missing its `timecode` field, causing timecode drift in cached translations. Cache results now include the timecode from the original entry.

- **Fixed context loss during auto-chunked batches:** When a batch exceeded the token limit and was auto-split into two halves, the first half received the original context but the second half received `null` context, breaking translation coherence mid-file. The first half now correctly receives the original context, and the second half receives a context built from the first half's translations — maintaining coherent translation flow across the split.

- **Fixed native batch providers losing timecodes:** Non-LLM translation providers (DeepL, Google Translate) were not applying timecodes from the original batch to their translated entries. Timecodes are now explicitly copied after alignment for native providers.

- **Fixed XML parser dropping entries followed by AI commentary:** When AI models inserted commentary between `</s>` closing tags and the next `<s` opening tag (e.g., "Note: this is informal" or "Hope this helps!"), the lookahead-based regex failed to match the preceding entry. The parser now strips all inter-tag content before parsing, allowing a simpler greedy regex that handles all edge cases.

- **Fixed `tryFallback` closure relying on hoisting:** The `tryFallback` async closure in `translateBatch()` was declared before `batchText` and `prompt` were defined, relying on JavaScript hoisting. While technically valid, this made variable dependencies unclear and fragile. Moved the closure declaration after `batchText`/`prompt` for explicit dependency ordering.

- **Removed dead `fixEntryCountMismatch()` function:** The old mismatch handler (~50 lines) was superseded by `alignTranslatedEntries()` in v1.4.38 but never removed. Native batch providers now use the alignment function directly. Comment references to `fixEntryCountMismatch()` updated to reference `alignTranslatedEntries()`.

- **Fixed user translation concurrency counter leak (multi-instance):** The per-user concurrent translation counter was **never being decremented** — the increment happened at translation start, but the decrement in the `finally` block used a broken implementation. Fixed by migrating to Redis atomic INCR/DECR operations with proper decrement in `finally`, plus a 30-minute TTL safety net. Also fixed a TOCTOU race in `decrementCounter()` (GET then DECR) by replacing with an atomic Lua script. Required adding the missing `getStorageAdapter` export from `storage/index.js` (previously caused `decrementCounter()` to fail silently).

- **Fixed missing `await` on async key rotation:** `translateSubtitle()`, `translateSubtitleSingleBatch()`, and the MAX_TOKENS/PROHIBITED_CONTENT error handlers all called async key rotation methods without `await`, potentially using stale/wrong API keys. All call sites now properly await.

- **Fixed key health tracking issues (multi-instance):** The local `_sharedKeyHealthErrors` Map was never cleared when a key recovered or when Redis TTL expired. Additionally, keys that hit 5 errors stayed marked unhealthy for the full 1-hour TTL even after successful translations. Fixed by adding `_resetKeyHealthOnSuccess()` which clears both local and Redis health records after successful translations.

- **Added error classification utility for catch blocks:** Created `src/utils/errorClassifier.js` to properly distinguish programming bugs (TypeError, ReferenceError, etc.) from operational errors (network timeouts, rate limits). Programming bugs like `getAdapter is not a function` are now logged as `error` level (sent to Sentry) instead of being silently swallowed as warnings. Applied to all cache modules (`sharedCache.js`, `syncCache.js`, `embeddedCache.js`), with imports added to `sessionManager.js`, `translationEngine.js`, `subtitles.js`, and `RedisStorageAdapter.js` for incremental adoption.

- **Fixed `TypeError: this.apiKey.trim is not a function` in subtitle services:** When an API key was passed as a non-string value (e.g., an object due to malformed config), calling `.trim()` would crash the service constructor. Added defensive type coercion in `SubDLService`, `SubSourceService`, and `SubsRoService` constructors to ensure `apiKey` is always a string before use.

- **Fixed handler errors not being sent to Sentry:** The main subtitle handler catch block was only logging the error message, not the Error object itself. Sentry integration only captures errors when the Error object is passed to the logger. Changed to pass both message and Error object, ensuring TypeErrors and other programming bugs are properly reported to Sentry.

## SubMaker v1.4.42

**Improvements:**

- **Multiple new origins allowed for Stremio shells, forks, self-hosted instances and addon managers.**

- **Allow private/LAN IP origins:** Origins from RFC 1918 private addresses (`10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`) and link-local (`169.254.x.x`) are now treated like localhost. Fixes blocks for users running Stremio server on their LAN (e.g. `https://192.168.1.15:8080`).

- **Stremio user-agent now bypasses origin checks everywhere:** Requests with a known Stremio user-agent (e.g. `StremioShell`) are now allowed through both `isOriginAllowed` and the addon API middleware, regardless of origin. Fixes blocks for self-hosted Stremio web instances using StremioShell.

- **Extra wildcard suffixes checked in addon API middleware:** The addon API security middleware now also checks `ALLOWED_ORIGIN_WILDCARD_SUFFIXES` (and the built-in `*.elfhosted.com` / `*.midnightignite.me`), so hosting platforms aren't blocked on addon routes.

- **Static assets bypass CORS origin checks:** Image, font, and icon files (`png`, `svg`, `ico`, `jpg`, `woff2`, `ttf`, etc.) are now served to any origin without restriction. Fixes blocks from browser extensions (`chrome-extension://`) and other clients trying to load `/logo.png` or `/favicon.svg`.

## SubMaker v1.4.41

**Bug Fixes:**

- **Fixed `TranslationEngine` constructor crash breaking ALL translations:** The key rotation initialization code accessed `this.keyRotationConfig.keys` without a null check. When key rotation is disabled (the default for all users), `keyRotationConfig` is `null`, so `null.keys` threw `TypeError: Cannot read properties of null (reading 'keys')`. This crashed the `TranslationEngine` constructor before any translation could start, causing every translation request to fail Affected all 4 translation code paths (subtitle translation, file upload, auto-subs, embedded subtitles) and all providers (Gemini, OpenAI, Anthropic, DeepL, etc.). Fixed by adding optional chaining: `this.keyRotationConfig?.keys`.

- **Fixed `caches` global reference error:** The configuration page reset function checked `window.caches` but then used the bare `caches` global for `.keys()` and `.delete()`. On Google TV's embedded browser (and other restricted environments), `window.caches` exists but `caches` as a global variable may not, causing `Cannot read properties of null (reading 'keys')`. Fixed by consistently using `window.caches` for all Cache API calls.

**Security:**

- **SSRF DNS rebinding defense for custom AI provider endpoints:** Custom provider base URLs are now validated against DNS rebinding attacks. After the existing hostname string check passes, `validateCustomBaseUrl()` resolves the hostname (A + AAAA records) and verifies all resolved IPs are external. If DNS resolution fails entirely, the request is blocked (fail-closed). Added `isInternalIp()` covering RFC 1918, loopback, link-local, unique-local, IPv4-mapped IPv6, carrier-grade NAT (100.64/10), and 0.0.0.0. The `ALLOW_INTERNAL_CUSTOM_ENDPOINTS=true` escape hatch is preserved for self-hosters running local LLMs.

- **Connection-time SSRF protection (TOCTOU gap closed):** Added `createSsrfSafeLookup()` which creates a Node.js-compatible DNS lookup function that re-validates resolved IPs at actual connection time, not just at URL validation time. This prevents attackers from using short-TTL DNS records that pass validation with an external IP but resolve to an internal IP when the HTTP connection is made. Custom providers now use dedicated HTTP agents with this safe lookup for all API calls (model listing, translation, streaming).

- **Configurable `trust proxy` setting:** Express `trust proxy` is no longer hardcoded to `1`. It now reads from the `TRUST_PROXY` environment variable, defaulting to `false` (no proxy trust) when unset. This prevents IP spoofing when the server is directly exposed without a reverse proxy. Supports all Express formats: numeric depth (`1`, `2`), boolean (`true`/`false`), named values (`loopback`, `linklocal`, `uniquelocal`), and subnet strings. Docker deployments set `TRUST_PROXY=1` automatically via `docker-compose.yaml`.

## SubMaker v1.4.40

**Improvements:**

- **CORS wildcard domain allowlisting:** Added support for wildcard domain suffixes in origin checks. `*.elfhosted.com` and `*.midnightignite.me` are now always allowed. Additional suffixes can be added via the `ALLOWED_ORIGIN_WILDCARD_SUFFIXES` env var (comma-separated, e.g. `.example.com,.other.org`).

- **Allow localhost origins through CORS:** Requests from `localhost` / `127.0.0.1` (e.g. Stremio desktop at `http://localhost:11470`) are now allowed regardless of user-agent. Previously these were blocked when the browser UA didn't contain a Stremio hint.

- **MAL and AniList ID mapping services:** Added `src/services/mal.js` (uses Jikan API `/anime/{id}/external` to find IMDB links) and `src/services/anilist.js` (uses AniList GraphQL API to check `externalLinks` for IMDB, with a fallback to MAL ID → Jikan chain). MAL (`mal:`) and AniList (`anilist:`) prefixed IDs were previously recognized by `parseStremioId` but had no mapping implementation — the handler logged "No IMDB mapping available" and all IMDB-only providers (OpenSubtitles, SubDL, SubSource) silently returned zero results. Both services follow the same patterns as the existing AniDB/Kitsu services (24h cache, 10min negative cache, 2 retries with 2s/6s backoff, 429 rate-limit handling).

- **ID resolution timeout cap (30s):** The entire anime ID mapping + TMDB→IMDB resolution chain (Cinemeta 8s + Wikidata 8s + Kitsu retries) now runs inside a `Promise.race` with a 30-second budget. Previously this pre-resolution step had no overall timeout — worst case could exceed 20s before subtitle providers even started. On timeout, the handler logs a warning and proceeds to providers with whatever IMDB ID was resolved so far (or none). The timeout timer is properly cleaned up via `.finally(() => clearTimeout(...))` to avoid dangling unhandled rejections.

- **SCS now supports native anime ID lookups as fallback:** `searchParams` now includes `animeId` and `animeIdType` fields. When anime content fails to map to an IMDB ID (e.g., AniDB/Kitsu mapping miss), SCS can now search using the native anime ID (e.g., `kitsu:8640:1:2`) instead of silently returning zero results. IMDB ID is still preferred when available since SCS's database is primarily IMDB-indexed. Previously, SCS had dead code referencing a `params.kitsuId` field that was never populated.

**Bug Fixes:**

- **Rewrote AniDB service — previous implementation used a fictional API:** The old `AniDBService` called `https://api.anidb.net/api/anime/{id}`, which doesn't exist (AniDB uses a UDP-based API requiring a registered client). Every request failed with a connection error, got cached as `null` for 10 minutes, and AniDB→IMDB mapping was completely non-functional. Replaced with Wikidata SPARQL using property P5646 (AniDB anime ID) → P345 (IMDB ID), the same proven pattern used for TMDB→IMDB elsewhere. Includes retry logic (2 retries at 2s/6s), input sanitization, and 24h/10min caching for hits/misses.

- **AniDB now has a Cinemeta title search fallback:** Unlike Kitsu (which fell back to Cinemeta title search when mappings failed), AniDB previously just returned `null` if the (broken) API call failed. The Wikidata query now also fetches the entity's English label, and when the entity exists but has no IMDB mapping, the service searches Cinemeta by that title — matching Kitsu's fallback behavior.

- **Fixed `parseStremioId` returning `null` for 2-part IMDB IDs:** If Stremio sent `tt1234567:5` (2 parts), the IMDB section only handled `parts.length === 1` (movie) and `parts.length === 3` (episode), so length 2 fell through and returned `null`. Now handles `tt1234567:5` as season 1, episode 5 — consistent with how TMDB and anime 3-part IDs treat implicit season 1.

- **Clarified `parseStremioId` TMDB 2-part type inference:** Added documentation that `tmdb:{id}` with no season/episode keeps `type: 'movie'` (since providers need season/episode for series queries) but `tmdbMediaType` is correctly derived from the `stremioType` hint, which drives the Cinemeta lookup type in `resolveImdbIdFromTmdb`. This ensures TMDB series IDs resolve to the correct IMDB ID even without explicit season/episode.

- **Fixed Wikidata SPARQL query not validating `tmdbId` format:** Both `queryWikidataTmdbToImdb` functions (in `subtitles.js` and `kitsu.js`) interpolated `tmdbId` directly into the SPARQL query string without validation. While TMDB IDs from Stremio are always numeric, a non-numeric value containing `"` or `\` could break or inject into the query. Added a `/^\d+$/` guard that rejects non-numeric TMDB IDs before they reach the SPARQL template.

- **Fixed `searchParams` not passing `tmdb_id` to providers that support it:** WyzieSubs and SubsRo both support native TMDB ID search, but the subtitle handler only passed `imdb_id` in the search parameters. When TMDB→IMDB mapping failed (e.g. Cinemeta down, Wikidata miss), these providers received `null` for both IDs and silently returned zero results — even though they could have searched by TMDB ID directly. `searchParams` now includes `tmdb_id: videoInfo.tmdbId` so WyzieSubs and SubsRo can fall back to TMDB search when no IMDB ID is available.

- **Fixed `parseStremioId` not handling anime movie IDs (`kitsu:8640`, `anidb:1234`):** Anime IDs like `kitsu:8640` split into 2 parts, but the anime branch only handled `parts.length === 1` (dead code — a single part like `"kitsu"` without a numeric ID can never match), `3`, and `4`. Length 2 fell through to the IMDB handler, which tried to normalize `"kitsu"` as an IMDB ID and returned `imdbId: "kitsu"`. Fixed the anime branch to handle `parts.length === 2` correctly, producing a proper `animeId: "kitsu:8640"` with `isAnime: true`.

- **Fixed TMDB→IMDB mapping cache locking failures for 24 hours:** Both Cinemeta errors and "not found" results were cached in `tmdbToImdbCache` with the full 24-hour TTL. A temporary Cinemeta outage would block all TMDB→IMDB lookups for that ID for a full day. Negative results (mapping not found) now cache for 10 minutes, and error results cache for 5 minutes, allowing recovery without hammering the API.

- **Fixed AniDB service having no retry logic and caching failures for 24 hours:** Unlike Kitsu (which had 2 retries with 2s/6s backoff), AniDB made a single HTTP attempt and cached `null` for 24 hours on any error. Added matching retry logic (2 retries at 2s and 6s delays for 5xx, ECONNRESET, ETIMEDOUT, ENOTFOUND errors) and reduced the negative cache TTL from 24 hours to 10 minutes. The same shorter negative cache TTL was also applied to Kitsu's failed lookups.

- **Language-hinted encoding detection for Arabic, Hebrew, and other non-Latin scripts:** The encoding detector (`detectAndConvertEncoding`) now accepts an optional `languageHint` parameter. When the subtitle's language is known (from provider metadata or route params), the detector uses it to override chardet's guess when it picks an implausible encoding. For example, if chardet detects `ISO-8859-1` but the language hint says Arabic, `windows-1256` is tried first. A Unicode script validation step (`validateDecodedForLanguage`) confirms the decoded content actually contains characters from the expected script block (e.g., U+0600–U+06FF for Arabic, U+0590–U+05FF for Hebrew), catching silent misdetections where chardet produces valid-but-wrong Latin characters. Coverage includes Arabic, Hebrew, Persian, Urdu, Greek, Turkish, Russian, Ukrainian, Bulgarian, Serbian, Polish, Czech, Hungarian, Romanian, Thai, Vietnamese, Chinese, Japanese, Korean, and Baltic languages.

- **Language hint propagated through all subtitle download paths:** `handleSubtitleDownload` now passes the `language` parameter from the route through to every provider's `downloadSubtitle()` call via `options.languageHint`. The translation pre-flight download path in `handleTranslation` similarly derives the hint from `options.sourceLanguage` or `config.sourceLanguages`. All 7 providers (OpenSubtitles Auth, OpenSubtitles V3, SubDL, SubSource, WyzieSubs, SubsRo, Stremio Community Subtitles) and the centralized archive extractor forward the hint to `detectAndConvertEncoding`.

- **`tryFallbackEncodings` now prioritizes language-hinted encodings:** When chardet fails entirely or produces high replacement ratios, the fallback encoding loop now tries language-specific encodings first (with script validation) before falling back to the general encoding list. This prevents the "lowest replacement ratio" heuristic from silently picking a wrong Latin codepage for Arabic/Hebrew content.

## SubMaker v1.4.39

**Improvements:**

- **Gemini safety filters upgraded from `BLOCK_NONE` to `OFF`:** The `BLOCK_NONE` threshold was not being respected by newer Gemini models (2.0+), which could still block subtitle content despite the setting. Switched both `generateContent` and `streamGenerateContent` requests to use the `OFF` threshold, which fully disables the safety filter. Also removed the deprecated `HARM_CATEGORY_CIVIC_INTEGRITY` category (Google now recommends `enableEnhancedCivicAnswers` instead).

- **Mobile mode polling interval increased to 5 seconds:** `waitForFinalCachedTranslation` previously polled every 1 second, creating significant I/O pressure with multiple mobile clients. Now 5 seconds, reducing storage reads by ~80%.

- **Partial delivery circuit breaker on persistent save failures:** After consecutive partial cache save failures exceed the threshold, partial delivery is now disabled entirely for that translation via a `partialDeliveryDisabled` flag, avoiding wasted I/O on a broken storage path.

- **API key rotation improvements:** Key selection now uses a global monotonically increasing `_keyRotationCounter` instead of `batchIndex % keys.length`, so retries within the same batch no longer reuse the same key. Additionally, 429 (rate limit) and 503 (service unavailable) errors now trigger an automatic rotation to the next API key before falling through to the fallback provider.

- **Key health tracking with automatic cooldown:** When key rotation is enabled, the engine now tracks errors per API key. After 5 errors on the same key within a 1-hour window, that key is automatically skipped during rotation for the remainder of the cooldown period. If all keys are in cooldown, the next key is used anyway (best effort). Error counts reset after the 1-hour cooldown elapses. This prevents repeatedly hitting a rate-limited or quota-exhausted key when healthy alternatives are available.

- **Per-request rotation mode now benefits from retry key rotation:** Previously, `per-request` mode selected a single key at provider creation time and all error-retry paths (429/503, MAX_TOKENS, PROHIBITED_CONTENT, empty-stream, two-pass recovery, full batch mismatch) were gated behind `perBatchRotationEnabled`, which was `false` for `per-request` mode. Introduced a separate `retryRotationEnabled` flag that is `true` for both `per-batch` and `per-request` modes, so error retries can rotate to a different key regardless of the rotation mode. `maybeRotateKeyForBatch()` still only fires for `per-batch` mode.

- **Redis key rotation counter TTL optimization:** `selectGeminiApiKey()` previously called `expire(redisKey, 86400)` on every single request, resetting the TTL and adding an extra Redis round-trip. The `expire` call now only fires when the counter is first created (`counter === 1`), eliminating the redundant round-trip on subsequent requests.

**Bug Fixes:**

- **Fixed error-retry paths dropping streaming on key rotation:** When a translation batch failed with a 429/503, MAX_TOKENS, or PROHIBITED_CONTENT error and key rotation retried the batch, the retry always used non-streaming `translateSubtitle()` even if the original request was streaming. Users lost real-time progress for the retried batch. Extracted the streaming callback into a reusable `streamCallback` closure and introduced `_translateCall()` which dispatches to streaming or non-streaming based on the original request mode. All retry paths now use `_translateCall()` so streaming is preserved across retries. The empty-stream fallback intentionally drops to non-streaming (that's the point of that retry).

- **Fixed key rotation creating new GeminiService instances that lose cached model limits:** Every call to `_rotateToNextKey()` created a fresh `GeminiService`, discarding the previous instance's `_modelLimits` cache (fetched via an API call to `models/{model}`). For a file with 20 batches and 3 keys, this caused ~20 redundant HTTP requests. The engine now preserves model limits in `_sharedModelLimits` before replacing the instance and restores them onto the new one.

- **Fixed `_rotateToNextKey` losing `enableJsonOutput` and other engine settings:** When creating a new `GeminiService`, `_rotateToNextKey` used `this.keyRotationConfig.advancedSettings || this.advancedSettings` — if `keyRotationConfig.advancedSettings` was set to `{}` explicitly, it wouldn't fall through to `this.advancedSettings`, losing settings like `enableJsonOutput`. The `keyRotationConfig.advancedSettings` is now built by merging engine-level `this.advancedSettings` as the base with the rotation config's settings as overrides during construction.

- **Overhauled JSON response parsing and recovery:** `parseJsonResponse()` previously failed entirely on slightly malformed AI output (unescaped quotes, trailing commas, missing commas), and the numbered-list/XML fallback parsers couldn't handle JSON-shaped text at all — resulting in 0 recovered entries. Added a 3-tier recovery chain: (1) direct `JSON.parse()`, (2) `repairAndParseJson()` for common syntax issues, (3) `extractJsonEntries()` regex extraction of individual `{"id":N,"text":"..."}` objects. `parseResponseForWorkflow()` also now runs `extractJsonEntries()` as an intermediate step before the workflow-specific parser, so JSON-shaped responses are always recoverable. The regex patterns in both repair functions were also updated to use `\\[\s\S]` instead of `\\.` so they correctly match multi-line subtitle text containing `\n`.

- **Fixed Anthropic provider ignoring `enableJsonOutput` setting:** The `AnthropicProvider` class never stored or used the flag. Added constructor storage, assistant prefill with `[` in `buildRequestBody()` (Anthropic's recommended JSON forcing approach), `[` prepending on response paths, and the missing pass-through in the provider factory. Skipped when thinking is enabled (prefill conflicts with thinking mode).

- **Fixed large batch sizes causing frequent JSON parse failures:** When `enableJsonOutput` is true, batch size is now capped at 150 entries regardless of model (previously up to 400 for `gemini-3-flash`), reducing JSON syntax errors while maintaining throughput.

- **Fixed contradictory prompt when XML workflow + JSON output were both enabled:** The XML and JSON instructions directly contradicted each other, and the previous regex-surgery fix was brittle. Replaced with a dedicated `_buildXmlInputJsonOutputPrompt()` method that constructs the prompt cleanly from scratch with no contradictory instructions.

- **Fixed XML parser truncating entries containing literal `</s>` in text:** The lazy regex matched the first `</s>` encountered, truncating entries with `</s>` in their dialogue. Now uses a lookahead requiring the closing tag to be followed by the next `<s` tag or end-of-string.

- **Fixed XML parser dropping entries with empty translated text:** The `if (id > 0 && text)` check treated `""` as falsy, silently dropping legitimate empty translations (e.g. "♪", sound effects). Now only checks `if (id > 0)`.

- **Fixed streaming progress with JSON Structured Output:** `buildStreamingProgress()` had no JSON parser, so users saw no real-time progress until the full response arrived. The method now uses `extractJsonEntries()` directly for streaming chunks (bypassing the guaranteed-to-fail `JSON.parse()` on incomplete data) and falls back to the workflow-specific parser.

- **Fixed Gemini `responseMimeType` conflicting with thinking mode:** `responseMimeType: 'application/json'` is now only set when thinking is disabled (`thinkingBudget === 0`). Prompt-level JSON instructions still apply when thinking is active.

- **Fixed `parseJsonResponse` silently dropping entries with `id: 0`:** Zero-indexed IDs mapped to index `-1` and were lost. The parser now accepts both 0-indexed and 1-indexed IDs.

- **Fixed `parseJsonResponse` not logging count mismatches:** The `expectedCount` parameter was accepted but never used. Now logs a debug message when parsed count doesn't match.

- **Fixed two-pass mismatch recovery using positional merge instead of ID-based matching:** Recovered entries were merged by sequential position regardless of their actual IDs. Now uses ID-based matching from JSON/XML parsers when available, falling back to positional mapping only for numbered-list responses.

- **Fixed non-LLM providers (DeepL, Google Translate) receiving LLM-only settings:** The engine now force-disables `enableJsonOutput` and forces `translationWorkflow` to `'original'` for non-LLM providers at initialization.

- **Fixed `translationStatus` TTL mismatch causing duplicate translations:** The `translationStatus` LRU cache had a 10-minute TTL while `inFlightTranslations` and shared locks used 30 minutes. Translations exceeding 10 minutes could trigger duplicates. TTL is now aligned at 30 minutes across all three mechanisms.

- **Fixed errors not cached for non-bypass users:** Failed translations were not persisted anywhere, so the next request silently re-triggered the same failure. Errors are now cached to permanent storage so users see the error message and can retry intentionally.

- **Fixed race window between final cache write and partial cache deletion:** The partial cache was deleted before verifying the final write was readable, creating a window where concurrent requests found neither. Partial is now only deleted after verifying the final translation is readable from storage.

- **Fixed concurrent partial saves racing and regressing progress:** Simultaneous `saveToPartialCacheAsync` calls could cause a slower write with older data to overwrite newer data. Partial saves are now serialized through a promise chain.

- **Fixed `fs.existsSync` blocking the event loop in cache management:** Replaced synchronous `fs.existsSync` in `calculateCacheSize` and `enforceCacheSizeLimit` with `await fs.promises.access`.

- **Fixed partial cache key mismatch in route handler:** Translation and learn mode routes read partials using `cacheKey` but they're saved under `runtimeKey`. Both routes now consistently use `runtimeKey`.

- **Fixed learn mode partial delivery missing cache-control headers:** Partial translations for learn mode were sent without `Cache-Control: no-store`, allowing browsers to cache incomplete VTT and never poll for the complete version.

- **Fixed single-batch streaming partials losing completed chunks:** In single-batch mode with auto-split, streaming callbacks only emitted the current chunk's partial SRT. Previously completed chunks would disappear during streaming. The method now accumulates `completedChunksSRT` across chunks.

- **Fixed JSON Structured Output silently ignored for 'ai' workflow mode:** When both `enableJsonOutput` and "Send Timestamps to AI" were enabled, JSON output was silently skipped with no warning. The engine now detects this incompatible combination at initialization, logs a warning, and sets `enableJsonOutput = false`.

- **Fixed `parseBatchSrtResponse()` using positional index instead of SRT entry IDs:** In 'ai' workflow mode, entries were mapped by array position rather than their actual SRT sequence number, causing translations to be silently assigned to wrong timecodes when the AI skipped or reordered entries. The parser now derives the index from the SRT ID, with `Set`-based deduplication and corrected timecode backfill. This also fixes two-pass mismatch recovery for 'ai' mode, which previously couldn't distinguish missing entries from shifted ones due to the positional indexing.

- **Fixed `sanitizeTimecodes()` stripping timecode-like dialogue in 'ai' workflow mode:** The aggressive timecode cleanup ran unconditionally, but in 'ai' mode the SRT parser already separates timecodes from dialogue cleanly. `sanitizeTimecodes()` is now skipped when `translationWorkflow === 'ai'`; the narrower `cleanTranslatedText()` regex still runs as a defensive cleanup.

- **Fixed partial SRT tail timecode overlapping with last translated entry:** The "TRANSLATION IN PROGRESS" status cue started at the exact end time of the last entry, causing overlap on some players. Now starts 1 second after.

- **Fixed error entries persisting indefinitely in permanent cache:** Cached errors used the TRANSLATION type's default TTL of `null` (no expiry). `saveToStorage` now accepts an optional `ttl` override, and errors are saved with a 15-minute TTL.

- **Numbered-list parser overhaul:** Replaced the split-on-double-newline approach with a line-by-line state machine, fixing multi-line subtitle entries with blank lines being silently dropped. Added `Set`-based deduplication to prevent duplicate entry numbers from inflating counts. Added filtering to strip context markers (`[Context N]` / `[Translated N]`) and section delimiters that the AI might echo back. The same fixes were applied to `buildStreamingProgress()`.

- **Fixed literal `\n` showing in error subtitle text:** The `interpolate` function in `getTranslator()` and client-side `window.t` never converted the two-character literal `\n` from locale JSON files to actual newlines. Added `.replace(/\\n/g, '\n')` to both functions in `src/utils/i18n.js`.

- **Fixed two-pass and mismatch retries bypassing `_translateCall()`:** The targeted two-pass recovery and full-batch mismatch retry paths called `this.gemini.translateSubtitle()` directly instead of routing through `_translateCall()`. While these retries intentionally don't use streaming (they're small recovery batches), bypassing `_translateCall()` meant they wouldn't benefit from any future enhancements to the centralized call path. Both now use `this._translateCall(text, lang, prompt, false, null)`.

- **Fixed `_sharedModelLimits` only captured on first key rotation:** The `_rotateToNextKey()` method had a `!this._sharedModelLimits` guard that prevented updating the cached model limits after the first rotation. If the initial instance had conservative fallback limits and a later instance fetched real values from the API, the real values were never propagated to subsequent rotations. The guard is removed — every rotation now captures the latest `_modelLimits` from the outgoing instance.

- **Key health errors now shared across engine instances:** `_keyHealthErrors` was previously a per-instance `Map`, so a key that repeatedly 429'd during one translation would be retried fresh by the next translation request. The health map is now module-level (`_sharedKeyHealthErrors`), shared across all `TranslationEngine` instances within the same process. A key that hits the error threshold is skipped by all subsequent translations until the 1-hour cooldown elapses.

- **Fixed `_keyRotationCounter` always starting at 0 regardless of initial key:** In per-batch mode, `selectGeminiApiKey()` picked a key (e.g. index 2 via the global Redis/memory counter), but `_keyRotationCounter` started at 0, so `maybeRotateKeyForBatch(0)` immediately overwrote the initial key with `keys[0]` — wasting the initial `selectGeminiApiKey` call, its Redis INCR, and the GeminiService construction. The counter is now seeded to `initialKeyIndex + 1` by looking up the initial key's position in the keys array, and `maybeRotateKeyForBatch()` skips batch 0 since the initial instance already has the correct key. In per-request mode, this also ensures retry rotation starts from the next key after the initial one rather than always from index 0.

- **Fixed `enableStreaming` not re-verified after key rotation:** `_rotateToNextKey()` replaces `this.gemini` with a new `GeminiService` instance but never re-checked whether the new instance supports `streamTranslateSubtitle`. Currently all `GeminiService` instances support it, but this guards against future provider heterogeneity. `enableStreaming` is now re-verified after every rotation.

## SubMaker v1.4.38

**New Features:**

- **XML Tags translation workflow:** Added "XML Tags (Robust)" as a third Translation Workflow option alongside "Original Timestamps" and "Send Timestamps to AI". When selected, each subtitle entry is wrapped in `<s id="N">text</s>` tags before being sent to the AI, and the response is parsed by matching those same tags back. This provides robust ID-based entry recovery that is resistant to the AI merging, splitting, or reordering entries — the most common cause of translation sync problems. The XML parser deduplicates by ID and sorts by index, so even if the AI repeats or shuffles entries, the output stays aligned. Available in Translation Settings (beta mode).

- **JSON Structured Output mode:** Added an opt-in "Enable JSON Structured Output" checkbox in Translation Settings (beta mode, disabled by default). When enabled, the translation engine requests the AI to return translations as a JSON array (`[{"id":1,"text":"..."},...]`) instead of plain text. This works at two levels:
  - **API level:** Gemini uses `responseMimeType: 'application/json'` in `generationConfig`; OpenAI-compatible providers (OpenAI, XAI, DeepSeek, Mistral, OpenRouter, Cloudflare Workers, Custom) use `response_format: { type: 'json_object' }` in the request body. These enforce valid JSON at the model level.
  - **Prompt level:** JSON format instructions are appended to the translation prompt for all LLM providers, including Anthropic (which has no native JSON mode API). DeepL and Google Translate are unaffected (non-LLM native batch providers).
  - **Response parsing:** When JSON output is enabled, `parseResponseForWorkflow()` always attempts JSON parsing first regardless of the selected workflow mode, then falls back to the standard parser (numbered list, XML, or SRT) if JSON parsing fails. This makes it a safe override — worst case, it degrades gracefully.
  - JSON output and XML workflow are complementary: XML controls how entries are *sent* to the AI, JSON controls how the AI *responds*.

- **Two-pass mismatch recovery:** Replaced the old "retry the whole batch N times" approach with intelligent targeted recovery when the AI returns a different number of entries than expected:
  - **Pass 1 — Alignment:** `alignTranslatedEntries()` maps each translated entry back to its original batch position by index. Entries that the AI returned correctly are kept; missing positions are identified and marked with `[⚠]` prefixes.
  - **Pass 2 — Targeted re-translation:** If ≤30% of entries are missing, only those specific entries are re-sent to the AI in a small follow-up batch and merged back into the aligned result. This is much faster and cheaper than retrying the entire batch.
  - **Fallback:** If >30% of entries are missing (indicating a more fundamental problem), the engine falls back to a full batch retry (configurable via Mismatch Retries setting, default 1).
  - Works with all three workflow modes (Original Timestamps, Send Timestamps to AI, XML Tags).

**Bug Fixes:**

- **Fixed auto-chunk half-batch streaming progress missing `streamSequence`:** When a batch exceeds the token limit and is auto-split, the mid-chunk streaming progress emission was missing the `streamSequence` property. The `streamSequence` variable declaration was also moved before the auto-chunk block to prevent a potential `ReferenceError`.

- **Fixed Learn Mode subtitles overlapping on Android/Android TV:** The previous implementation used two separate WebVTT cues with positioning tags (`line`, `region`) that Stremio's player (ExoPlayer) doesn't support properly and was breaking on Android. Both languages are now merged into a single cue separated by a line break, with the learned language italicized for visual distinction. Works consistently across all Stremio platforms.

- **Fixed SRT-mode mismatch retry never triggering:** `parseBatchSrtResponse` was internally calling `fixEntryCountMismatch` which padded the entries array to the correct length before the outer retry logic could detect the mismatch. The inner alignment was removed so the raw parsed count is returned, allowing the retry logic to work correctly for both SRT-mode and text-mode translations.

**Improvements:**

- **Translation Workflow is now a 3-way selector:** The old "Send Timestamps to AI" checkbox has been replaced with a dropdown offering three modes: "Original Timestamps" (numbered list, reattach original timecodes), "Send Timestamps to AI" (full SRT, trust AI to preserve timecodes), and "XML Tags (Robust)" (XML-tagged entries for ID-based recovery). Backward compatible — existing configs with `sendTimestampsToAI: true` automatically map to the "ai" workflow.

- **Streaming progress parsing for XML mode:** The `buildStreamingProgress()` method now handles partial XML tag parsing during streaming translation, so users see real-time progress when using the XML Tags workflow.

- **JSON output wired to all OpenAI-compatible providers:** The `enableJsonOutput` flag is passed through `globalOptions` in `createProviderInstance()` and propagated to all 7 OpenAI-compatible provider instantiations (OpenAI, XAI, DeepSeek, Mistral, OpenRouter, Cloudflare Workers, Custom) plus Gemini. The factory's `createTranslationProvider()` extracts the setting from `config.advancedSettings.enableJsonOutput` and threads it to every provider creation call site, including secondary/fallback providers.

- **Accurate token counting with gpt-tokenizer for BPE providers:** Replaced the rough character-based heuristic (`chars/3 * 1.1`) with actual BPE tokenization via `gpt-tokenizer` for OpenAI-compatible and Anthropic providers. This gives much more accurate batch sizing and auto-chunking decisions, especially for CJK languages where the old heuristic could be off by 2-3x. Falls back to the heuristic if the tokenizer fails.

- **Gemini safety filters set to BLOCK_NONE:** Both `generateContent` and `streamGenerateContent` requests now include `safetySettings` with `BLOCK_NONE` for all five harm categories (HARASSMENT, HATE_SPEECH, SEXUALLY_EXPLICIT, DANGEROUS_CONTENT, CIVIC_INTEGRITY). This should dramatically reduce false-positive safety blocks on fictional dialogue in subtitles. The existing PROHIBITED_CONTENT retry with modified prompt is kept as a fallback.

- **Optimized streaming reconstruction:** During streaming translation, the engine no longer rebuilds a full merged SRT from all entries on every chunk. Instead, it maintains a pre-built SRT snapshot for completed batches and only rebuilds the current streaming batch, then concatenates. This turns an O(totalEntries) operation per streaming chunk into O(currentBatchEntries), which is a significant improvement for large files (1000+ entries) in later batches.

- **Native batch path for non-LLM providers (DeepL, Google Translate):** The translation engine now detects non-LLM providers and sends them raw SRT directly via a new `translateBatchNative()` method, bypassing numbered-list prompt construction, context injection, and numbered-list response parsing entirely. Previously, these providers received numbered-list-wrapped content and had to parse it back out via `extractEntries()`, which was wasted overhead.

- **Faster partial delivery — save after every batch:** Partial translation results are now saved to cache after every completed batch instead of only at batches 1, 4, 9, and every 5th batch. Users clicking to reload will see progress from every batch, eliminating the "skipped batches" gap where 2-3 batches of translated content were invisible.

- **Earlier first streaming partial (30 entries, was 95):** The first streaming partial is now emitted after ~30 translated entries instead of ~95, so users see initial progress roughly 3x faster when using streaming providers (Gemini, OpenAI, Anthropic). Configurable via `STREAM_FIRST_PARTIAL_MIN_ENTRIES` env var.

- **More frequent streaming updates for large files:** The SRT rebuild interval for large files (600+ entries) was reduced from every 250 entries to every 200 entries (`SINGLE_BATCH_SRT_REBUILD_STEP_LARGE`), and the streaming save debounce was reduced from 4s to 3s. Both remain env-configurable.

- **Faster mismatch retry recovery:** When the AI returns a mismatched entry count and a retry is triggered, the pause before retry was reduced from 1500ms to 500ms. The retry itself already takes seconds, so the extra wait was unnecessary latency.

- **Auto-chunking now emits mid-chunk streaming progress:** When a batch exceeds the token limit and is auto-split into two halves, a streaming progress callback is now emitted after the first half completes. Previously, no progress was visible until both halves finished, leaving a gap during large auto-chunked batches.

- **Security block events now reported to Sentry:** All three security middleware rejection points (addon API origin block, `applySafeCors` origin rejection, and browser CORS block) now log at `error` level and send detailed events to Sentry. Each event includes the blocked origin, user-agent, request path, method, IP, and a `blockReason` tag (`unknown_origin_addon_api`, `origin_not_allowed`, `browser_cors_blocked`).

- **Increased batch size for Gemini 3.0 Flash:** The `gemini-3-flash-preview` model now uses 400 entries per batch (up from the default 250).

- **Entry count mismatch retry with visual marker:** When the AI returns a different number of subtitle entries than expected, the batch is now retried (default: 1 retry, configurable 0-3 via "Mismatch Retries" in Advanced Settings or `MISMATCH_RETRIES` env var). If retries don't resolve the mismatch, untranslated entries are marked with a `[⚠]` prefix instead of being silently backfilled with the original language text. Users can now see exactly which lines the AI skipped.

- **Partial cache cleanup with retry:** When a translation completes or fails, the partial cache cleanup now retries once after 2 seconds if the initial delete fails. This reduces orphaned partial cache entries that could serve stale data for up to 1 hour.

- **Translation cache completeness metadata:** All cache writes (partial, bypass, and permanent) now include an `isComplete` flag (`false` for in-progress partials, `true` for finished translations). This enables downstream code to distinguish complete translations from in-progress partials at the metadata level.

- **Progress callback failure tracking:** Partial cache save errors during translation are now tracked with a consecutive failure counter. The first 3 failures log individual warnings; after that, a single error-level message is logged indicating partial delivery is broken for that translation, and further warnings are suppressed to avoid log spam.

- **Final streaming partial always saved:** Fixed a gap where the last streaming partial might not be persisted if the total entry count fell between rebuild checkpoints. The `shouldRebuildPartial` throttle now unconditionally allows saving when all entries are complete, closing the window where neither partial nor permanent cache had data.

## SubMaker v1.4.37

**New Features:**

- **Custom Providers LLM support:** Added a "Custom Provider" option to connect to any OpenAI-compatible endpoint such as Ollama, LM Studio, LocalAI, or custom API servers. Configurable base URL, optional API key, and custom model input. Includes higher default timeout (120s) for slower endpoints. **Security:** Internal/private IPs are blocked by default to prevent SSRF attacks on public deployments. Self-hosters can enable local endpoints with `ALLOW_INTERNAL_CUSTOM_ENDPOINTS=true` in `.env`.

- **Force SRT output option:** Added a new "Force SRT output" checkbox in Other Settings that automatically converts all downloaded subtitles to SRT format for maximum player compatibility. When enabled, VTT, ASS, and SSA subtitles are converted to SRT before being served to Stremio. Uses the existing `subsrt-ts` library for VTT→SRT conversion and `assConverter` for ASS/SSA→VTT→SRT conversion. Gracefully falls back to the original content if conversion fails.

- **Subtitle deduplication across providers:** Added automatic deduplication of subtitle results when multiple providers return the same subtitle. When providers like SubDL and OpenSubtitles return identical subtitles (same release name), only the first occurrence is kept.

**Bug Fixes:**

- **Fixed multi-language subtitle encoding issues:** Subtitles in Arabic, Hebrew, Greek, Turkish, Vietnamese, Thai, and Baltic languages were displaying garbled characters (mojibake) when source files used legacy Windows codepage encodings instead of UTF-8. Added comprehensive encoding support including: Arabic (`windows-1256`, `ISO-8859-6`), Hebrew (`windows-1255`, `ISO-8859-8`), Greek (`windows-1253`, `ISO-8859-7`), Turkish (`windows-1254`, `ISO-8859-9`), Vietnamese (`windows-1258`), Thai (`windows-874`, `TIS-620`), Baltic (`windows-1257`), and Russian/Ukrainian alternatives (`KOI8-R`, `KOI8-U`).

**Improvements:**

- **Provider timeout now fully respected:** Removed hardcoded 28-30 second minimum/maximum timeout overrides from SCS (Stremio Community Subtitles) and SubSource providers. Your configured provider timeout setting is now applied directly to all providers without being overridden. Previously, SCS enforced a 28s minimum and SubSource had a 30s total cap, which ignored user preferences for faster timeouts.

- **Centralized encoding detection across all providers:** Updated OpenSubtitles, OpenSubtitles V3, Stremio Community Subtitles (SCS), and the archive extractor to use the centralized encoding detector instead of raw UTF-8 decoding. This ensures consistent handling of non-UTF-8 encoded subtitles across all subtitle sources.

- **Improved encoding fallback order:** The encoding fallback list now includes 20+ encodings grouped by script family (Latin, Central European, Cyrillic, Arabic, Hebrew, Greek, Turkish, Vietnamese, Thai, Baltic) for more efficient detection when primary detection fails.

## SubMaker v1.4.36

**New Features:**

- **Added bare manifest for Stremio Community addon list:** Added `/manifest.json` endpoint that returns a generic addon manifest without requiring user configuration. This allows SubMaker to be published to the Stremio Community addon list. When users install from the community list, Stremio will automatically redirect them to the configuration page.

**Bug Fixes:**

- **Fixed SCS subtitles crashing Stremio for long filenames:** SCS (Stremio Community Subtitles) uses Base64-encoded JSON as file IDs which include the video filename. Long filenames caused IDs to exceed the 200-character validation limit, returning a JSON error instead of a subtitle. This crashed Stremio's player with `TypeError: list[0] must be Buffer`. Increased fileId limit from 200 to 600 characters.

## SubMaker v1.4.35

**Improvements:**

- **Changed default API key rotation frequency to "Per Batch":** When enabling Gemini API key rotation, the default rotation frequency is now "Per Batch" (rotates key for each translation batch) instead of "Per Request" (once per file). This provides better rate limit distribution across multiple API keys. "Per Batch" is now also listed first in the dropdown as the recommended option.

- **Centralized shared subtitle helper functions:** Refactored `createEpisodeNotFoundSubtitle` and `createZipTooLargeSubtitle` from duplicate local implementations in each provider (`subsource.js`, `subdl.js`, `opensubtitles.js`, `opensubtitles-v3.js`, `subsRo.js`) into a single shared implementation in `archiveExtractor.js`. This eliminates ~500 lines of duplicated code while maintaining all functionality including episode number extraction, season pack detection, and user-friendly error messages.

- **Centralized response content analysis:** Moved `analyzeResponseContent` function from `subsource.js` to the shared `responseAnalyzer.js` utility. All providers (SubSource, SubDL, OpenSubtitles, OpenSubtitles V3, Subs.ro) now use the centralized version for consistent detection of HTML error pages, Cloudflare blocks, CAPTCHA pages, JSON errors, gzip responses, and other non-subtitle content.

- **Enhanced response analysis patterns:** Improved the `analyzeResponseContent` function with additional detection patterns: added 'challenge' keyword detection for CAPTCHA challenges, added 'failed' keyword detection for error responses, and added detection for `status: 'error'` string patterns in JSON responses.

- **Improved SCS timeout warning:** Added debug logging when the user's configured timeout is too low for Stremio Community Subtitles (SCS). SCS requires ~30 seconds due to server-side hash matching. When timeout is below 28s, a debug message now suggests increasing the timeout for reliable SCS results.

- **Enhanced SCS performance logging:** Added detailed timing logs for SCS search and download operations, making it easier to diagnose slow SCS responses and understand performance characteristics.

**Cleanup:**

- **Removed Sentry debug endpoints:** Removed `/debug-sentry` and `/api/sentry-test` endpoints that were only used for verifying Sentry integration during initial setup. Core Sentry error tracking remains active for production error monitoring.

- **Removed Gemini 2.5 Pro from model selection:** Removed `gemini-2.5-pro` from the Translation Model dropdown. Gemini 3.0 Pro remains available for users who need a Pro-tier model.

- **Removed duplicate subtitle helper functions from providers:** Cleaned up ~500 lines of duplicated code by removing local copies of `createEpisodeNotFoundSubtitle`, `createZipTooLargeSubtitle`, and `analyzeResponseContent` from `subsource.js`, `subdl.js`, `opensubtitles.js`, `opensubtitles-v3.js`, and `subsRo.js`. These providers now import the shared implementations from `archiveExtractor.js` and `responseAnalyzer.js`.

- **Removed spurious auto-save on Learn Mode toggle:** Fixed Learn Mode toggle and radio buttons triggering `saveConfig()` on every change. These controls now only update `currentConfig` without saving, consistent with other config page controls that require explicit save.

**Bug Fixes:**

- **Fixed OpenSubtitles config section padding asymmetry:** The OpenSubtitles provider section had asymmetric padding (only bottom padding), causing it to appear closer to the section above compared to other provider entries. Changed to symmetric padding matching other providers.

- **Fixed createInvalidResponseSubtitle signature:** Updated the function signature in `responseAnalyzer.js` to make `responseSize` parameter optional with a default of 0, preventing errors when providers call it without the size argument.

- **Fixed UTF-8 BOM in subtitles.js:** Removed UTF-8 BOM character from the beginning of `src/handlers/subtitles.js` that was causing potential parsing issues.

## SubMaker v1.4.34

**Bug Fixes:**

- **Fixed Wyzie Subs downloads not working:** The `downloadSubtitle` function had an incorrect signature that expected a number but received an options object. This caused the download loop to never execute, resulting in "failed to load external subtitle" errors for all Wyzie Subs. Fixed by updating the function signature to match other providers.

- **Fixed Stremio Community/libmpv request spam:** Resolved an issue where Stremio Community clients using libmpv would generate excessive requests when opening the subtitle menu. The root cause was the addon returning `202 Accepted` with a `Retry-After: 3` header for duplicate translation requests, which caused libmpv to poll every 3 seconds indefinitely. The fix removes the retry header and returns a normal response, stopping the polling loop.

- **Fixed SubSource API key validation endpoint:** The `/api/validate-subsource` endpoint was not passing API key headers when making requests, causing 401/403 authentication failures even with valid keys. Added the required headers to the validation request.

- **Disabled session fingerprint validation:** Fingerprint validation was causing false positives and incorrectly deleting valid sessions when the config schema changed (e.g., new fields added, encrypted values differing after decrypt cycle). Token validation is sufficient to detect cross-session contamination. Fingerprint mismatches are now logged at debug level for diagnostics only - sessions are no longer deleted on mismatch.

- **Fixed prefetch cooldown not working:** The prefetch cooldown mechanism for Stremio Community V5 clients was not blocking libmpv prefetch requests as intended. The root cause was a key mismatch: the cooldown was being set using the session token (e.g., `d20c...6e87`) from `req.params.config`, but was being checked using a computed config hash (e.g., `0f966b7b17ad091e`) from `ensureConfigHash()`. Since these keys never matched, the cooldown check always returned "not blocked." Fixed by using the session token consistently for both setting and checking the cooldown.

**Performance:**

- **Debounced session TTL refresh writes to Redis:** Previously, every single request (manifest, subtitle search, download, etc.) would trigger a Redis SET to refresh the session TTL. With thousands of users, this created massive Redis write overhead. Now TTL refreshes are debounced to once per hour per session, reducing Redis writes by ~99% while maintaining sliding window session expiry.

**Improvements:**

- **Improved Stremio Community detection:** Enhanced detection to also identify libmpv requests (the player that does prefetching) when they have no origin header. This improves the accuracy of the prefetch cooldown system for Stremio Community clients.

- **Enhanced session persistence diagnostics:** Added debug logging throughout the session lifecycle to help diagnose disappearing sessions. This includes verification that sessions are written to Redis, logging of fingerprint values on mismatch, and tracing of successful session loads.

- **Removed automatic Android mobile mode:** Mobile mode is now only enabled when explicitly configured via `mobileMode=true` in the config or forced via query string. Automatic detection based on Android user-agent has been removed for consistency across all devices.

**New Features:**

- **Translation Burst Detection:** Added detection for when Stremio/libmpv prefetches ALL translation URLs simultaneously (common with Stremio Community). When 3+ translation requests arrive within 300ms from the same user, only the first request proceeds - the rest receive a "loading" message. This prevents starting multiple expensive AI translations during prefetch. Configurable via:
  - `TRANSLATION_BURST_WINDOW_MS` (default: 300ms)
  - `TRANSLATION_BURST_THRESHOLD` (default: 3 requests)
  - `DISABLE_TRANSLATION_BURST_DETECTION=true` to disable

- **Download Burst Detection:** Added detection for when Stremio prefetches all subtitle download URLs at once. When 5+ download requests (cache misses) arrive within 500ms, only the first proceeds - the rest are deferred to save provider API quota. Configurable via:
  - `DOWNLOAD_BURST_WINDOW_MS` (default: 500ms)
  - `DOWNLOAD_BURST_THRESHOLD` (default: 5 requests)
  - `DISABLE_DOWNLOAD_BURST_DETECTION=true` to disable

- **Stremio Community Prefetch Cooldown:** Added targeted blocking for Stremio Community's aggressive libmpv prefetching behavior. When the addon serves a subtitle list to a Stremio Community client (detected via `origin=zarg` or `user-agent=StremioShell`), a 2.5 second cooldown is set for that user's config hash. During the cooldown, libmpv prefetch requests to `/subtitle/` and `/translate/` routes are blocked with a "Click again to load" message. Non-libmpv requests (user actually selecting a subtitle) are allowed through. Official Stremio apps are unaffected since the cooldown is only set for Stremio Community requests. Configurable via:
  - `STREMIO_COMMUNITY_COOLDOWN_MS` (default: 2500ms)
  - `DISABLE_STREMIO_COMMUNITY_COOLDOWN=true` to disable

- **Disable Download Cache Option:** Added `DISABLE_DOWNLOAD_CACHE=true` environment variable to completely disable the in-memory download cache if needed.

## SubMaker v1.4.32

**New Features:**

- **Gemma 27b Translation Model:** Added "Gemma 27b (beta) (Recommended for Rate Limits)" to the Gemini model selection dropdown. Gemma 27b is now the default model for new users, offering better rate limit handling for free-tier API users.

**Performance Improvements:**

- **Connection pre-warming at startup:** The addon warms up TLS connections to all subtitle providers (OpenSubtitles V3, SubDL, SubSource, Wyzie Subs, SCS, Subs.ro) during server startup. This is a one-time optimization for the very first user after a deploy.
- **Keep-alive pings every 45 seconds:** A background task continuously pings all major providers (OpenSubtitles V3, SubDL, SubSource, Wyzie Subs, SCS) to maintain warm connections and detect outages. This is the **main mechanism** that keeps connections ready over time. When a provider starts failing (timeouts, connection errors), the circuit breaker immediately knows.
- **Proactive provider skipping:** When a user requests subtitles, the addon **immediately skips unhealthy providers** instead of waiting 12-20 seconds for a timeout. If provider pings have failed 3 times in a row, that provider is skipped for 60 seconds. This prevents one slow/dead provider from delaying the entire subtitle response. Applied to both the main subtitle search AND the translation selector endpoints.
- **Circuit breaker integration in all subtitle searches:** Both the main subtitle handler and the translation selector now record success/failure to the circuit breaker. Connection errors (timeout, reset, abort, EPROTO) trigger failures. Successful requests help close the circuit after provider recovery.
- **Static/singleton axios clients for subtitle services:** `WyzieSubsService`, `SubDLService`, `OpenSubtitlesV3Service`, `StremioCommunitySubtitlesService`, and `SubSourceService` now use static axios clients shared across all instances. This maximizes connection reuse and reduces memory allocation.
- **Connection pool statistics:** Added `getPoolStats()` and `isProviderHealthy()` functions for monitoring and debugging.
- **SubSource MovieID Cache:** Implemented Redis-backed persistent cache for SubSource `movieId` lookups with 30-day TTL. This eliminates redundant API calls for repeated lookups of the same title, significantly improving SubSource response times for frequently accessed content. Cache is shared across instances via Redis with Pub/Sub invalidation support.

**Configurable Provider Timeouts:**

- **Configurable subtitle provider timeout:** New slider in the "Other Settings" section on the config page allows adjusting the timeout for subtitle provider searches (8-30 seconds, default 17s). Lower values provide faster responses but may miss slow providers; higher values are more reliable but slower.
- **Default timeout increased to 17 seconds:** The default provider timeout has been increased from 12s to 17s to accommodate slower providers like SCS, Wyzie, and SubSource. Existing user sessions without a saved timeout will automatically use the new default.
- **Slow provider warning:** Added a red warning message on the config page informing users that "SCS, Wyzie and SubSource might be slow. If you get no subtitle results, we recommend higher timeout values."
- **Timeout setting moved to Other Settings:** The provider timeout configuration has been moved from the "More Providers (beta)" section to the "Other Settings" section, making it accessible to all users regardless of beta mode.
- **Unified timeout architecture:** The configurable timeout now controls three layers:
  - **Individual provider request timeout:** Each subtitle service's search request uses `(configTimeout - 2s)` to allow buffer for orchestration.
  - **Orchestration timeout:** The main search races all providers and returns available results after `configTimeout` seconds.
  - **Download timeout:** Subtitle file downloads use `max(12s, configTimeout)` to ensure adequate time for larger files.
- **Per-provider timeout handling:** All 7 subtitle services (OpenSubtitles V3, OpenSubtitles Auth, SubDL, SubSource, SCS, WyzieSubs, SubsRo) now use the configurable timeout for both search and download operations. SCS maintains a minimum 25s timeout due to known slow server responses.
- **Backend normalization:** The timeout value is clamped to 8-30 seconds in `normalizeConfig()` to prevent extreme values.
- **Environment variable override preserved:** The `PROVIDER_SEARCH_TIMEOUT_MS` environment variable still works as an override for the orchestration timeout when needed.

**Gemini Improvements:**

- **Gemini retry logic for Gemma models:** Gemma models now automatically retry on `finishReason: OTHER` errors which can occur during normal operation. Additionally, Gemma models retry on rate limit errors (429s) up to 2 times with exponential backoff (8s → 24s) to handle free-tier rate limits gracefully.

**Bug Fixes:**

- **Fixed "Configuration Error" on re-entry with OpenSubtitles Auth:** Fixed a critical bug where users with OpenSubtitles Auth credentials would see "Configuration Error: Session token not found or expired" when re-entering content after the first access. The root cause was internal flags (`_encrypted`, `__decryptionWarning`, `__credentialDecryptionFailed`, etc.) polluting the session fingerprint computation. These transient flags were added during the encrypt/decrypt/normalize cycle but weren't present when the original fingerprint was computed at session creation, causing fingerprint mismatches and session deletion. The fix strips all internal flags before fingerprint computation during session load.
- **Fixed SubDL subtitle fetching for TV shows:** Fixed an issue where SubDL returned 0 results for some TV show episodes. The fix ensures correct handling of season packs and episode-specific subtitles, properly filtering by season and episode numbers when searching for TV content.
- **Fixed SubSource API key authentication:** Fixed 401 Unauthorized errors when using the SubSource API. API keys are now correctly included in all SubSource requests, including movieId lookups and subtitle searches.
- **Fixed OpenSubtitles timeout errors misreported as invalid credentials:** When the OpenSubtitles API times out during authentication (e.g., `timeout of 12000ms exceeded`), the addon was incorrectly reporting "authentication failed: invalid username/password" even when credentials were valid. The root cause was that `loginWithCredentials()` called `handleAuthError()` for ALL errors (including timeouts/network issues), which returned `null`, and then `searchSubtitles()` interpreted any `null` return as "bad credentials". Now timeout, network, and DNS errors are properly thrown and logged as connection issues, while only actual authentication failures (401/403 responses) trigger the "invalid credentials" message. Additionally, 400 "Bad Request" errors are no longer automatically treated as auth failures - they now require an explicit credential-related message to be classified as such.
- **LOTS of subtitles providers' improvements.**

## SubMaker v1.4.31

**Improvements:**

- **Centralized error reporting:** All `log.error()` and `console.error()` calls that include Error objects now automatically report to Sentry. This eliminates the need for manual `sentry.captureError()` calls throughout the codebase and ensures comprehensive error tracking.

- **Removed error filtering:** Removed all error pattern filters from Sentry integration. Previously, operational errors (rate limits, auth failures, network issues) were filtered out. Now ALL errors are sent to Sentry for complete visibility into production issues.

- **Enhanced Sentry diagnostics:** Added detailed diagnostic logging during Sentry initialization showing DSN presence, environment, and initialization status. Error captures now log event IDs for traceability.

## SubMaker v1.4.30

**New Features:**

- **RAR Archive Support:** Subtitle providers (SubDL, SubSource, OpenSubtitles, OpenSubtitles V3, Subs.ro) now support RAR archives in addition to ZIP files. Previously, providers returning RAR archives instead of ZIP would fail with "Invalid ZIP file signature detected" errors. The addon now automatically detects RAR archives (`Rar!` signature) and extracts subtitles from them seamlessly.

**Improvements:**

- **Centralized archive extraction utility:** Created a new `archiveExtractor.js` utility that consolidates all archive handling logic (ZIP and RAR) into a single location. This reduces code duplication across providers (~1000+ lines removed) and ensures consistent handling of:
  - Archive type detection (ZIP/RAR)
  - Season pack episode extraction (TV show and anime patterns)
  - Subtitle file selection (SRT priority, fallback to VTT/ASS/SSA/SUB)
  - Subtitle format conversion to VTT
  - BOM-aware encoding detection (UTF-16LE/BE)
  - Size limit enforcement (25MB default)
  - Error subtitles for oversized archives, missing episodes, and corrupted files

- **Response analyzer RAR detection:** Updated the response analyzer utility to detect RAR archives in addition to ZIP, improving content type analysis for debugging.

- **Enhanced archive debugging:** Added comprehensive debug logging throughout the archive extraction pipeline, including first bytes hex dump, RAR version detection (RAR4/RAR5), file count and entry listing, per-file extraction progress, subtitle format conversion attempts and fallback chains, and stack traces for all errors.

- **Sentry error capture in Express error handlers:** All Express error handlers (subtitle, translation, translate-selector, file-translate, sub-toolbox, and general) now capture errors to Sentry with module context, path, and method information for improved production debugging.

**Bug Fixes:**

- **Fixed unhandled rejection on OpenSubtitles rate limit:** Fixed an issue where OpenSubtitles 429 (rate limit) errors during login caused unhandled promise rejections to be logged. The root cause was the login mutex promise being rejected when no concurrent requests were waiting on it. Added `.catch()` handler to swallow the rejection (the error is still handled by the try/catch block). Also improved the mutex waiter error handling to return `null` gracefully for rate limits and retryable errors instead of re-throwing.

- **Added global unhandled error handlers:** Added `process.on('unhandledRejection')` and `process.on('uncaughtException')` handlers that log errors and report them to Sentry. This provides a safety net for any async errors that escape try/catch blocks across the entire application. Uncaught exceptions gracefully exit after giving Sentry time to send the error.

- **Removed dead code from Subs.ro service:** Removed ~200 lines of unused extraction methods (`_findFirstSubtitleFile`, `_findEpisodeFile`, `_extractAndConvertSubtitle`) that were superseded by the centralized `archiveExtractor.js` utility.

## SubMaker v1.4.29

**New Subtitle Providers:**

- **Stremio Community Subtitles (SCS) integration:** Added support for the community-driven subtitle database at [stremio-community-subtitles.top](https://stremio-community-subtitles.top/). When enabled, SubMaker searches SCS alongside other providers (OpenSubtitles, SubDL, SubSource) and can translate community-uploaded subtitles. Includes full language code normalization (ISO 639-2/T to B conversion), Kitsu anime ID support, and automatic fallback token for zero-config usage.

- **Wyzie Subs integration:** Added support for [Wyzie Subs](https://sub.wyzie.ru), a free, open-source subtitle aggregator that searches OpenSubtitles and SubDL simultaneously. No API key required. Supports both IMDB and TMDB IDs, hearing impaired filtering, and automatic ZIP extraction (handled server-side by Wyzie). Includes comprehensive language code normalization and per-language result limiting to prevent overwhelming results.

- **Subs.ro integration:** Added support for [Subs.ro](https://subs.ro), a Romanian subtitle database. Requires an API key from subs.ro. Provides access to Romanian-language subtitles with full download support and API key validation.

**Bug Fixes:**

- **Fixed SubSource anime season pack false detection:** Fixed a bug where anime episode filtering incorrectly classified single-episode subtitles as season packs. The issue was that the episode exclusion regex used `/regex/` syntax where `${targetEpisode}` was not interpolated (interpreted as literal characters instead of the variable value). Now uses `new RegExp()` so episode numbers are properly matched, preventing incorrect season pack classification and "episode not found in season pack" errors.

- **Fixed OpenSubtitles Auth warning log spam:** Resolved an issue where the warning "OpenSubtitles Auth selected without credentials; switching to V3" was logged 20+ times in 3 seconds on every request. The root cause was that saved sessions with `implementationType: 'auth'` but without credentials would trigger the warning on every config load, but the corrected config was never persisted back to the session. Now, when the addon auto-corrects the implementation type from 'auth' to 'v3', it persists this fix to the session storage asynchronously, so the warning only appears once and subsequent requests use the already-corrected config.

**Other Changes:**

- Session manager now gracefully skips fingerprint validation when decryption warnings are detected, preserving the session
- Config normalization detects OpenSubtitles Auth credentials that still appear encrypted (decryption failed) and silently falls back to OpenSubtitles V3
- Gemini API keys that failed to decrypt are also detected and cleared with a warning log

## SubMaker v1.4.28

**Logging & Monitoring:**

- **Log level indicator in console output:** Console logs now include level tags (`[DEBUG]`, `[INFO]`, `[WARN]`, `[ERROR]`, `[CRITICAL]`) for easier filtering and debugging.
- **Sentry error tracking integration:** Added optional Sentry integration for production error monitoring. Set `SENTRY_DSN` environment variable to enable. Only actual code errors are sent to Sentry - operational issues (rate limits, auth failures, network errors) are filtered out.
- **New `log.critical()` function:** For errors that must always be logged and reported to Sentry regardless of log level. Used for bugs that indicate code issues, exluding operational problems.
- **Changed API errors from `error` to `warn` level:** Rate limits (429), authentication failures, service unavailability (502/503), and other expected operational issues are now logged as warnings, not errors. This reduces noise in error logs and Sentry.
- **Changed OpenSubtitles init messages to `debug` level:** "API key loaded successfully" and "Initialized with user account authentication" messages now only appear when `LOG_LEVEL=debug`.
- **Unhandled promise rejection handler:** Added global handler to capture and report async errors that aren't caught with try/catch.

**Environment Variables:**

- `SENTRY_DSN` - Your Sentry project DSN (required to enable Sentry)
- `SENTRY_ENVIRONMENT` - Environment name for Sentry (default: 'production')
- `SENTRY_SAMPLE_RATE` - Error sample rate 0-1 (default: 1.0 = 100%)
- `SENTRY_ENABLED` - Set to 'false' to disable Sentry even with DSN set

## SubMaker v1.4.27

**Improvements:**

- **Localization cleanup:** Removed hardcoded English strings in Sub Toolbox, History, and Sync pages.
- **Manifest logging:** Added detailed request metadata logging (client IP, forwarded headers) for debugging.
- **Auto-subs retry UX:** Renamed "Retranslate" to "Retry translation," improved button fallbacks, and only show download actions when SRT exists.
- **Layout tweaks:** Adjusted step card alignment for cleaner auto-subs layout on larger screens
- **O(1) index existence checks:** Added fast `EXISTS` checks to `syncCache` and `embeddedCache` before falling back to expensive `SCAN` operations. For new videos (never synced/embedded), lookups now return immediately instead of scanning all Redis keys. This alone can reduce latency by 60-80% for first-time video requests.
- **Parallel sync cache lookups:** Changed xSync subtitle lookups from sequential per-language loops to parallel `Promise.all()` execution. With 2 configured languages, this halves the sync cache lookup time.
- **Parallel embedded cache preloading:** Both embedded originals AND translations are now fetched in parallel at the start of subtitle handler, stored in Maps, and reused throughout the request. This eliminates 2 redundant Redis calls that were happening later in the flow.
- **Eliminated duplicate listEmbeddedOriginals call:** The xEmbed section was calling `listEmbeddedOriginals()` a second time despite the data already being cached in `embeddedOriginalsByHash` Map. Now reuses the pre-fetched data.
- **Eliminated duplicate listEmbeddedTranslations call:** The xEmbed section was calling `listEmbeddedTranslations()` despite translations already being pre-fetched. Now reuses the `embeddedTranslationsByHash` Map.

**Bug Fixes:**

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
- **Stream hash mismatch resolution:** Fixed hash mismatch errors when pasting debrid/addon stream URLs (e.g., `/resolve/realdebrid/...`). These URLs redirect to CDN URLs containing the actual filename, but the hash was being computed from the redirect URL path instead. Now, the client follows redirects with a HEAD request to get the final URL before computing the hash, ensuring it matches the linked stream hash.
- **Anime season pack matching:** Fixed episode matching for filenames like `Berserk - 01[1080 BD X265].ass` regex now recognizes `[` and `(` as valid episode terminators.
- **SubSource API key sanitization:** Fixed "Invalid character in header content" errors by sanitizing API keys containing control characters.
- **Rate limit error handling:** Fixed OpenSubtitles login 429 errors being misclassified as `type: 'unknown'`. The `parseApiError()` utility now preserves original error properties.
- **Locale fixes:** Repaired corrupted Arabic strings and synced missing keys (ar/es/pt-br/pt-pt) with English.
- **XSS Defense-in-Depth:** Added additional HTML escaping at the source when building hash mismatch alert messages in `toolboxPageGenerator.js`. While the downstream `buildHashStatusContent()` function already escapes the entire string, this defense-in-depth approach prevents XSS if future refactoring accidentally removes the later escape.

**Auto-subs Improvements:**

- **Parallel transcription:** Audio windows now transcribe in parallel (up to 4 concurrent requests), reducing an 8-window video from ~2+ minutes to ~30 seconds.
- **Whisper Large V3 Turbo Base64 fix:** The Cloudflare API requires Base64-encoded audio in JSON payloads for the Turbo model (not raw binary or array format like the base model).
- **Duration estimation fix for TS streams:** Fixed incomplete subtitle coverage where only half the video was transcribed. For TS (transport stream) containers where duration probing fails, the byte-based estimation now uses 0.8 Mbps (down from 2 Mbps), ensuring full coverage for lower-bitrate streams.
- **Graceful window failures:** Individual failed audio windows are now skipped instead of failing the entire transcription improves resilience for problematic segments (silence, music, etc.).
- **Model-aware window sizes:** Base Whisper model uses 30s windows (its max), Turbo model uses 90s by default with UI slider support up to 25 minutes.
- **VAD filter option:** Added "Enable VAD filter" checkbox for Turbo model to remove silence from audio for cleaner transcription. Turbo is now the default model.

## SubMaker v1.4.26

- **Linked stream refresh button:** Added a refresh action on Sync, Embedded Subtitles, and Auto-subs pages so users can pull the latest linked stream metadata without leaving the page.
- **Clearer hash mismatch guidance:** Updated the embedded tools helper copy to instruct users to refresh the linked stream before pasting the Stream URL.
- **Wikidata TMDB?IMDB fallback:** When Cinemeta doesn't have a TMDB-to-IMDB mapping (previously causing "Could not map TMDB to IMDB" errors), the addon now queries Wikidata as a free, no-API-key fallback. This improves subtitle availability for content that Cinemeta hasn't indexed yet.
- **OpenSubtitles "Auth" rate limit fix:** Fixed 429 rate limit errors when using OpenSubtitles Auth mode by implementing a static token cache and login mutex. Previously, each request created a new `OpenSubtitlesService` instance with its own token, causing multiple concurrent requests (e.g., Stremio prefetching subtitles) to all call `/login` simultaneously exceeding OpenSubtitles' 1 request/second login limit. Now, JWT tokens are cached per credential and reused across instances, and concurrent login attempts for the same credentials are serialized via a mutex. Also removed the unnecessary global download rate limiter (12/min cap).

## SubMaker v1.4.25


**Translation History Improvements:**

- **Retranslate button:** The Translation History page (`/sub-history`) now includes a "Retranslate" button on each history entry. Clicking it clears the cached translation and allows you to trigger a fresh retranslation the next time the subtitle is loaded in Stremio. This provides the same functionality as the 3-click cache reset mechanism, with the same rate limits and safety checks.
- **Seasonless episode tags:** History entries now show `E##` for anime-style IDs without seasons, instead of forcing a fake season number.

**Improved ZIP Handling & Error Detection:**

- **SubSource intelligent content analysis:** When SubSource returns a response declared as ZIP but containing other content (HTML error pages, JSON errors, Cloudflare blocks, CAPTCHA pages, etc.), the addon now analyzes the response and returns a user-friendly error subtitle instead of crashing. Handles: Cloudflare challenges, CAPTCHA pages, 404/500/503 HTML errors, rate limit pages, truncated responses, and direct subtitle content mis-labeled as ZIP.
- **Corrupted ZIP handling:** All providers (SubSource, SubDL, OpenSubtitles Auth, OpenSubtitles V3) now catch JSZip parsing errors and return informative error subtitles instead of throwing when a ZIP file passes the magic byte check but fails to parse.
- **Enhanced "too small" detection:** Subtitle content validation now uses intelligent analysis to distinguish between valid short subtitles (credits-only files with timecodes) and actual errors (HTML pages, JSON errors, truncated responses), providing specific feedback based on what was detected.
- **Shared response analyzer utility:** Added `src/utils/responseAnalyzer.js` with reusable functions for analyzing HTTP response content across all providers, supporting consistent error detection and user-friendly messages.

**Performance Optimizations:**

- **Early provider timeout:** New `PROVIDER_SEARCH_TIMEOUT_MS` environment variable (default 7 seconds) returns available subtitle results after the timeout, instead of waiting for all providers. Slow or unresponsive providers no longer block the entire response.
- **Reduced provider timeouts:** OpenSubtitles and SubDL API timeouts reduced from 15 seconds to 10 seconds for faster failure detection on slow providers.
- **Reduced results per language:** Each provider now returns a maximum of 14 subtitles per language (was 20), reducing processing overhead and response size.
- **OpenSubtitles V3 filename extraction:** Subtitle fetching is now significantly faster (3-6 seconds saved) by skipping slow HEAD requests for filename extraction. The fast URL-based extraction is enabled by default; set `V3_EXTRACT_FILENAMES=true` to re-enable accurate Content-Disposition filename extraction if needed.
- **Reduced default subtitles per language:** Changed `MAX_SUBTITLES_PER_LANGUAGE` default from 12 to 8 for faster subtitle loading and reduced UI overhead.

**Other Changes:**

- **Gemini Pro default thinking budget:** Set Gemini 2.5 Pro and 3.0 Pro defaults to a fixed thinking budget of 1000 (aligned with config UI).
- **Advanced settings gating for Gemini:** Advanced settings are now applied only when explicitly enabled, so disabled advanced settings no longer leak prior tuning values into Gemini requests.
- **Mobile responsive fix for API key rotation:** Fixed layout issues on mobile devices where Gemini API key rotation fields had misaligned icons, oversized buttons, and broken input containers.
- **Fixed Kitsu/anime ID parsing:** Corrected episode tag display for anime streams from Kitsu, AniDB, MAL, and AniList. Previously, video IDs like `kitsu:10941:1` were incorrectly parsed to show "S10941E01" (treating the anime ID as the season number). Now correctly shows "E01" for seasonless anime episodes, and "S01E05" for anime with explicit seasons (e.g., `kitsu:10941:1:5`). Fixed across all toolbox pages (Sub Toolbox, Sync, Auto-subs) and stream notification toasts.
- **Kitsu title lookups:** Toolbox, Sync, Auto-subs, and the floating subtitle menu now query the Kitsu API for Kitsu anime IDs to display proper anime titles (e.g., "Elfen Lied - E12" instead of filenames). IMDB/TMDB continues to use Cinemeta. Episode tags (E## or S##E##) are now consistently appended to the main title display across all tools pages.
- **Legacy session cleanup across Redis prefixes:** Invalid sessions loaded via cross-prefix migration are now deleted in all known prefix variants, preventing repeated migration loops and noisy logs.
- **Subtitle menu redesign:** The floating subtitle menu now features a completely redesigned interior with premium styling gradient backgrounds, animated accent borders, polished language cards with colored type badges, numbered subtitle entries, enhanced chips with glowing indicators, and smooth micro-animations throughout.
- **Subtitle menu toggle visibility:** The floating toggle button is now much more visible with a vibrant gradient background (blue-to-purple), stronger glow effects, inner/outer highlight rings, and improved contrast against any background.
- **Fixed IMDB/TMDB title display in subtitle menu:** The floating subtitle menu footer now correctly fetches and displays show/movie titles from Cinemeta for IMDB and TMDB streams. Previously, it was showing the cleaned filename instead of the actual title. Also fixed the episode tag to show "S01E01" format with proper season/episode parsing, and added support for TMDB ID lookups via Cinemeta.

## SubMaker v1.4.24

- **Gemini API key rotation:** Config now supports multiple Gemini keys with per-request or per-batch rotation, encrypted storage, and a compact UI for managing extra keys.
- **Gemini 3.0 Flash and Pro (Preview):** Added the new Gemini 3.0 Flash and Pro preview models to the translation model dropdown. Also updated the Gemini 2.5 Flash option to use the `gemini-2.5-flash-preview-09-2025` model version.
- **ASS/SSA subtitle first letter fix:** Fixed a bug where converting ASS/SSA subtitles to VTT caused the first letter of each subtitle line to be lost. The issue was in the `subsrt-ts` library's parsing, which consumed the first character of the text field. The fix adds a protective leading space before the text field in Dialogue lines during preprocessing.
- **Stream hash mismatch fix:** Fixed hash mismatch errors on AutoSubs/Sync pages when pasting Comet, Torrentio, or debrid stream URLs. The issue occurred because the `name` query parameter (used for display) often contained a short title different from the actual filename in the URL pathname. The fix now prioritizes the pathname when it contains a valid filename with extension, falling back to `name` only when needed.

## SubMaker v1.4.23

- **Target language prompt normalization:** Translation providers now use consistent, canonical target language labels across config codes (e.g., `por`/`pob` Portuguese variants, `spa`/`spn` Spanish variants, `chi`/`zhs`/`zht` Chinese variants) to reduce dialect mismatches and improve prompt reliability.
- **Exclude SDH/HI subtitles:** Added an option to filter out SDH/HI subtitles (e.g., captions with hearing-impaired cues) when fetching results, improving subtitle matching for standard dialogue-only tracks.
- **UI language (pt-PT):** Added Portuguese (Portugal) (`pt-pt`) to the interface language selector.

## SubMaker v1.4.22

- **Auto-subs cue splitting:** Long auto-sub entries split more naturally by sentence boundaries with duration weighted by segment length, improving readability and timing stability.
- **Audio track selection prompt:** When multiple audio tracks are detected for auto-subs, the toolbox now surfaces an inline track picker and a dedicated "Continue with track" action.
- **Raw transcript downloads:** Auto-subs can now expose a downloadable raw transcript alongside SRT/VTT outputs.
- **Retranslate target languages:** Translation cards include a "Retranslate {lang}" action that reruns translation for a specific target without restarting the full auto-subs pipeline.
- **Cloudflare window sizing:** Added an optional Cloudflare Workers AI "window size (MB)" control to tune chunk size (up to 25 MB) for long/complex audio.
- **Status badge accuracy + UI tightening:** Decode badges update only when decoding actually completes, and pill badges are slightly smaller for a cleaner auto-subs status layout.
- **Partial cache busting:** HTML partial includes now append a cache-buster query to avoid stale UI fragments on cached hosts/CDNs.
- **BOM stripping for providers:** Subtitle downloads from OpenSubtitles (auth/v3), SubDL, and SubSource strip UTF-8 BOMs to prevent first-character/cue corruption, especially in RTL languages.

## SubMaker v1.4.21

- **History storage upgrade:** Translation history now stores all entries per user in a single Redis record with pruning (60 retained, 20 shown) instead of many per-entry keys, eliminating keyspace SCANs on history loads.
- **Legacy migration:** Older per-entry history keys are auto-read and migrated into the new per-user store on first access, keeping existing history visible without manual cleanup.
- **Write efficiency:** History updates merge into the per-user store with TTL refresh, reducing Redis churn while still capturing status transitions and metadata changes.
- **Secondary provider/config fixes:** Secondary provider dropdown now builds from currently enabled providers before toggling, preserves/auto-defaults the choice with a placeholder option, translation workflow details moved into a tooltip, Learn Mode/config helper text points to the Languages section, and descriptions respect intentional line breaks.
- **Offscreen buffer reuse:** Autosubs and embedded-subtitles offscreen demux now reuse shared buffers and avoid cloning full-span views, so IDB stash logs no longer balloon with one entry per window/buffer.
- **Auto-subs UI polish:** Status pills start at `WAITING`/`OK`, update labels per stage (fetch/transcribe/align/translate/deliver), and reset when Step 1 edits occur; translation chips show skipped/failed counts, hash/linked-stream cards and Step 2/targets are centered/narrowed to match the embedded page, and errors surface clearly via badges/tooltips.
- **AssemblyAI via extension + live logs:** AssemblyAI auto-subs now request transcripts through the xSync extension (with optional full-video uploads) and stream live log trails via `/api/auto-subtitles/logs` (SSE or JSON) keyed by `jobId`; auto-subs accept extension-supplied transcripts/diagnostics, force diarization, and strip speaker labels from Cloudflare/Assembly outputs.
- **Stream update stability:** Placeholder Stremio pings (missing filename/hash or "Stream and Refresh") no longer overwrite a good linked stream snapshot, and QuickNav tracks the latest signature/timestamp so duplicate or stale "Update linked stream" toasts are cleared promptly on toolbox/sync pages.
- **xSync/xEmbed language scoping:** Synced/embedded subtitle cache entries are only surfaced when their language matches the user's configured source/target (or no-translation) languages, preventing cross-language leakage and unnecessary cache scans.

## SubMaker v1.4.20

- **Learn Mode clarity:** Learn-mode validation now surfaces the correct error, and the config description reminds users to pick target learn languages.
- **Config copy refresh:** Translation workflow/database descriptions and multi-provider help text are clearer across the config UI, with consistent icons and copy updates in all locales (en/es/pt-br/ar).
- **UI polish:** True-dark themes now restyle section close links for better contrast, and config labels use clearer symbols.

## SubMaker v1.4.19

- **Learn mode stability:** Fixes missing `videoId` handling that was causing Learn-mode VTT requests to throw, and logs full error objects for translation/Learn failures to aid debugging.
- **RTL detection hardening:** RTL language detection now tokenizes language labels (with diacritic stripping) to avoid substring false positives (e.g., Bulgarian/Hungarian) while still wrapping RTL outputs correctly.
- **Secondary provider persistence:** Config page now keeps the Secondary Provider toggle/selection checked after save + reload, instead of silently clearing the fallback choice.

## SubMaker v1.4.18

- **Config page experience:** Config UI copy reorganized (new Cloudflare Workers auto-subs field + validator, refreshed toolbox instructions, advanced settings split, icon/section styling, mobile preview), and Cloudflare/Assembly keys are preserved for auto-subs flows.
- **Translation history:** Added a `/sub-history` page that shows per-user translation runs (titles, source/target, provider/model, status, download links); it pulls Cinemeta titles when available and is now linked from QuickNav and the Sub Toolbox for all users (no Dev Mode required).
- **Auto-subs AssemblyAI path:** Added an AssemblyAI auto-subs mode (with optional full-video uploads up to 5GB, timeout/polling guards, and diarized SRT fallbacks) that auto-selects when Cloudflare keys are missing; diarization is now forced for all auto-subs engines and speaker labels are stripped from outputs.
- **Auto-subs UX polish:** Toolbox pills now track decode/transcribe/translate states with a dedicated FFmpeg decode badge, long previews are truncated safely, downloads are proper links, duplicate logs are suppressed, and auto-sub requests use longer, refreshed timeouts with clearer hash mismatch copy.
- **Auto-subs providers:** Cloudflare Workers keys get stricter parsing/validation in the config and toolbox, translation provider resolution prefers Gemini and falls back to any available provider when the chosen one is missing, and Gemini provider creation is fixed.
- **Embedded/linked streams:** Linked stream titles avoid placeholder collisions and episode tags now render correctly; extraction hash-mismatch messaging explicitly calls out Linked Stream vs Stream URL alignment; autosubs Step 2 layout/text is left-aligned for readability.

- **RTL translations:** Translated subtitles now wrap RTL targets with embedding markers so punctuation renders correctly for Hebrew/Arabic outputs.
- **Addon localhost access:** Addon API routes now allow localhost origins (any port) so local browser requests including macOS Safari/Chrome can fetch subtitles without being blocked.

## SubMaker v1.4.17

- **Auto-subs via xSync:** Auto-subtitles now relies on the xSync extension for Cloudflare transcription; the server only accepts client-provided transcripts, logs CF status/snippets, and uses the official "Whisper" / "Whisper Large V3 Turbo" labels (diarization toggle removed).
- **Auto-subs gating/resets:** Step 1/2 each require a Continue click, runs are blocked until the extension + CF credentials are detected, hash alerts reserve space to avoid jumps, and downloads stay locked until a run completes with refreshed status/progress logs.
- **Embedded metadata parity:** Embedded-subtitles uses a shared linked-video label helper so titles/episode tags and reload hints match Subtitle Sync, with consistent separators and context labels; the extra Step 2 helper copy was removed.
- **Config flags dock:** UI language flags stay expanded after you open them, even when translations re-render late.
- **Stream activity isolation:** Stream activity buckets are scoped per session/token and the poller treats 204s as healthy with the proper failure cap, preventing cross-user collisions and long pauses after idle periods.
- **Various minor fixes.**

## SubMaker v1.4.16

- **Config cache busting:** Config UI assets/partials now force cache-busting redirects and no-store headers to avoid stale CSS/JS on hosts with long-lived CDN caches.
- **Auto-subs audio pipeline:** Stream audio fetch now detects playlists/HTML/HLS/DASH, falls back to bundled FFmpeg decoding, enforces byte/time limits, and reports the fetch source/type for hosted runs.
- **Cloudflare diagnostics:** Whisper calls surface CF status/segment counts and return full per-run log trails plus diagnostics so 5xx/502 failures are actionable instead of silent.
- **Log window parity:** Auto-subs UI displays backend logTrail entries (fetch/FFmpeg/Cloudflare/translation) in the live log so step 3 shows every action and failure inline.

## SubMaker v1.4.15

- **Locale/i18n resilience:** `/api/locale` now favors explicit `lang` values, syncs translators to the resolved language, falls back safely to defaults, and reapplies translations after late partial/combobox loads; the UI-language dock self-builds if the partial is missing and flags force emoji-safe fonts.
- **Safer i18n attributes:** `data-i18n-attr` accepts comma/space lists, filters invalid names, and guards setter errors so broken attributes no longer throw while preserving fallbacks.
- **Auto-sub log redesign:** Auto-subtitles toolbox log is now a styled live feed with timestamps, severity coloring, capped history, and a pipeline preview to make each run s status readable.
- **Upstream error clarity:** Cloudflare transcription responses parse non-JSON bodies, return upstream status codes/body snippets, and surface 5xx hints in API/toolbox flows so failures are actionable.

## SubMaker v1.4.14

- **xEmbed language grouping:** Embedded originals now surface with canonical language codes, so extracted tracks merge into the same Stremio language bucket instead of creating duplicate language entries.
- **Make from embedded:**  Make (Language)  entries now include extracted embedded tracks as valid sources, even when no provider subtitles exist, with deduped source lists.
- **Embedded translation path:** Translations triggered from embedded originals pull directly from the xEmbed cache (skipping provider downloads) and save the resulting xEmbed translations back with metadata for reuse.
- **Toolbox subtitle toggle:** Subtitles Toolbox now mounts the floating subtitle menu with a pulsing toggle button, prefetching stream data so source/target lists stay handy while working in the toolbox.
- **Auto-subtitles stream guards:** Auto-subtitles and sync Step 1 now demand valid/matching stream URLs, reset flows when the link changes, and surface clearer hash-mismatch alerts to stop runs from starting on stale or mismatched streams.
- **Cloudflare Whisper path:** Workers AI endpoint keeps model paths unencoded (preserving slashes) so Whisper requests reach Cloudflare successfully.
- **Other minor fixes.**

## SubMaker v1.4.13

- **Subtitle caching:** Final SRT/VTT responses (downloads, xSync, xEmbed) now use device-private caching so user-set subtitle delays are kept instead of resetting when the player reloads the track.
- **Storage outage handling:** All config-driven routes now bail out early when config storage is unavailable, ensuring the storage-unavailable response is sent instead of double responses or broken redirects.
- **Auto-subtitles UI stability:** Auto-subtitles page now bootstraps its runtime with translated copy/video metadata to fix broken rendering and keeps the hash badge/cache-block state consistent.
- **Embedded extraction logs:** Extraction logs stay visible after successful embedded runs for easier troubleshooting, while auto-sub hash/cache badges keep cache-block flags without noisy warnings.
- **RTL + flags:** Arabic UI now flips to RTL with isolated LTR tokens for mixed Arabic/English lines, and UI language flags map to real locales (Arabic -> Saudi Arabia, pt-br -> Brazil, en -> US).
- **Hash/status UX:** Embedded toolbox now shows a linked stream card plus hash status badge, and translation cards lock with overlays until extraction finishes and a track is selected, keeping mismatch messaging clear.
- **Auto-sub flow locks:** Auto-subtitles flow adds a Continue step that unlocks translation/run cards, disables Start until a target is set, and relocks when the stream is edited so runs can t start on placeholder links or missing targets.
- **Metadata fetch guards:** Cinemeta lookups skip invalid IMDb IDs, normalize them to lowercase, and fall back to TMDB IDs when available to avoid noisy 404s while still filling stream titles.
- **Accessibility/i18n polish:** UI language dock/help buttons now carry translated aria-labels and Step 1 labels get explicit colons/shortened copy for clearer screen-reader prompts.

## SubMaker v1.4.12

- **Extract Subs rollout:** Embedded subtitles extractor is now always enabled in Sub Toolbox and QuickNav.
- **Subtitle menu UX:** Stream subtitle menu now surfaces source and target tracks together under "Source & Target," with categories collapsed by default (per-locale labels updated), pill counts, and refreshed chrome for quicker scanning.
- **BCP-47 locale support:** Locale loader now accepts alphanumeric tags with dashes/underscores (e.g., `es-419`, `pt_BR`) instead of silently falling back to English.
- **Safe alerts:** Config alerts no longer render via `innerHTML`, preventing HTML injection from bubbled error strings while keeping icons/spacing intact.
- **data-i18n vars respected:** `data-i18n-vars` is parsed and applied for any element using `data-i18n`, so dynamic placeholders stay translated when copy is re-applied.
- **Subtitle sync load:** Subtitle Sync page initializes translation/copy helpers before usage to avoid ReferenceErrors that previously broke `/subtitle-sync` loads.
- **Tool pages extension detection:** Fixed inline script escapes and translation helper init on sync/embedded tool pages so scripts parse correctly and the xSync extension status can be detected (no more stuck "Waiting for extension..." badges when the extension is present).
- **Inline script stability:** Escaped line breaks in the subtitle sync SRT helpers and initialized the embedded-subtitles `tt` helper to prevent inline script parse errors that blocked extension detection.

## SubMaker v1.4.11

**New Features:**
- **Shared translation cache reinstated:** Shared  Make (Language)  translations are re-enabled with a new namespaced storage prefix, automatic legacy purge, and hard bypass of reads/writes when a config hash is missing/invalid.
- **Floating subtitle menu:** Extended Stream Subtitles widget to sync and file-upload pages with grouped source/translation/target lists, quick refresh/prefetch, and live stream updates from QuickNav.
- **Localization groundwork:** Added shared i18n helper with locale bootstrap and UI-language plumbing through config/session so pages and subtitle messages can render per-user language for future addon translations.

**Subtitles Toolbox:**
- **Floating menu translation controls:** Translation entries now ship with Translate/Download buttons that poll background translations, cache finished files, and surface ready-to-download targets without page reloads.
- **Autosync mode picker:** Subtitle Sync now offers ALASS, FFSubSync, Vosk CTC/DTW, or Whisper+ALASS as the primary engine with light/balanced/deep/complete scan profiles, plus a new manual-offset slider/hotkeys and inline CTA when the xSync helper is missing.

**Security & Infrastructure:**

- **Service Worker Cache:** API cache bumped to `v2` with `Vary: *` safeguards, version-tagged/hourly registration, and automatic bypass/unregister on toolbox/addon pages so dynamic tools never reuse stale controllers.
- **Origin allowlist:** Expanded trusted Stremio origins to include `*.stremio.one` and `*.stremio.com` alongside existing `*.strem.io`, covering official hosts while keeping addon API lockdown intact.
- **Session-gated subtitle caches:** xSync/xEmbed reads and writes now require valid session tokens, respond with `no-store`, and keep embedded originals opt-in configurable (default on) to prevent cross-user cache leakage.

**Bug Fixes:**

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
- **Stremio install popup formatting:** Fixed manifest description strings that were double-escaped, so `\n` now render as actual line breaks in the install dialog.
- **Batch context in single-batch splits:** When single-batch translations exceed token limits and auto-split, surrounding/previous-entry context is now passed through so coherence is preserved in this edge mode.
- **Embedded studio UX gaps:** Instructions modal now respects the  don t show again  preference, extraction no longer hangs if the xSync extension goes silent (60s watchdog with reset/re-ping), the extension badge reflects active extraction vs ready state, and single-track extractions auto-select to unlock Step 2 immediately.
- **Mobile quick-nav toggle:** Restored the hamburger bars on tool pages for screens under 1100px width.
- **Resilient language maps:** Subtitle menu now guards language-map bootstrapping and drops stale backups so missing/invalid maps can t crash subtitle rendering.
- **3-click cache reset:** Triple-click cache reset no longer consumes rate limits or leave partial purges when users retry quickly.
- **Many other major and minor bug fixes.**

**Improvements:**

- **Subtitle intelligence:** Language lookup now normalizes ISO1/ISO2 codes and common aliases (e.g., LATAM Spanish, Brazilian Portuguese), improving grouping/labels across providers and cached translations; labels normalize Make/Learn/xEmbed/xSync variants and keep language cards open across refreshes.
- **Stream context:** QuickNav toasts clean filenames, add episode tags, fetch Cinemeta titles, refresh ownership faster, and avoid duplicate SSE connections.
- **Subtitle menu polish:** Menu is reorganized into Source/Target/Translation/Other groups with better spacing, separators, accessibility labels, and notification handling; the footer shows version/filename plus subtitle/language counts and status overlays stay anchored without hiding ready-to-download translations.
- **Subtitle sync UX:** Autosync options surface per-engine scan profiles with preserved plan metadata, language labels are corrected, manual offsets clamp to zero start times and include slider nudges/hotkeys, and plan summaries stay accurate.
- **Fingerprint pre-pass:** Autosync adds an optional (default on) fast audio fingerprint pre-pass toggle to lock coarse offsets before deeper engines run; plan summaries include the pre-pass and the extension payload carries the flag.
- **Autosync help copy:** Instructions now call out the fingerprint pre-pass alongside ALASS/FFSubSync/Vosk/Whisper options so users understand when to keep it enabled.
- **Cache indexing:** Embedded and sync caches now keep per-video indexes to avoid storage scans, cap index size, and drop stale keys when reads fail.
- **Embedded studio alignment:** Embedded-subtitles page now mirrors xSync behavior: model fetch status is visible, extension debug logs surface in the live log, stream changes clear stale outputs, and extraction requests send the latest filename/videoHash.
- **Subtitle cache integrity:** Synced/embedded caches prune stray originals/translations per video, keep embedded originals, and xSync/xEmbed downloads serve with no-store headers to avoid cross-user leakage via shared cache.
- **Cache maintenance:** Subtitle cache/bypass integrity checks, size calculation, and evictions now run asynchronously to avoid blocking the event loop during periodic cleanups.
- **Session counting:** Redis sessions now maintain a set-based index for O(1) counts; the index is verified on startup and every 3 hours with automatic rebuild on drift, and session purges fetch metadata with bounded concurrency to reduce spikes.
- **Locale API + bootstrap:** Pages now embed locale JSON (and set `<html lang>`) via `/api/locale`, enabling toolbox/sync/file-upload/config UIs and subtitle menu to consume translated labels.

## SubMaker v1.4.10

**New Features:**
- **Subtitles Extracting Page:** Added a floating "Stream subtitles" quick menu that loads current source/target/xEmbed/xSync links for the active stream.
- **Auto-Sync Page:** Added a live log panel that forwards background logs to the UI with monotonic progress updates.

**Security & Infrastructure:**

- **Cache Hardening:** Service worker and all token/config-bearing endpoints now use strict `no-store` and cache bypass headers (`Vary: *`, `X-Cache-Buster`, etc.) to prevent sensitive data caching.
- **Secure Secrets:** Encryption keys and Redis passwords are now auto-generated and persisted to the `keys` volume if unset.
- **Session Resiliency:** Improved session persistence with integrity metadata, legacy payload backfilling, and fail-fast Redis initialization.
- **Redis:** Normalized key-prefix handling with non-destructive cross-prefix self-healing.

**Bug Fixes:**

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
- **Redis SCAN:** Fixed a critical bug where `list()` returned zero keys due to missing key prefix in SCAN patterns, causing silent session data loss.
- **Session Persistence:** Fixed `createSession` and `updateSession` to properly handle Redis failures and prevent "ghost" sessions or silent data loss.
- **Cross-Instance Invalidation:** Fixed Pub/Sub invalidation for multi-pod deployments by using consistent connection options and retry logic.
- **Stream Guard:** Stremio subtitle fetch guard now ignores placeholder "stream and refresh" values.
- **Many other bug fixes.**

**Improvements:**

- **Configuration:** Disabled automatic Redis prefix migration by default (`REDIS_PREFIX_MIGRATION=false`) to prevent issues.
- **Logging:** Added diagnostic logging for Redis SCAN patterns and alerts when storage operations fail but in-memory cache has data.
- **Layout:** Tweaked layout and dependencies for clearer long-running syncs.
- **Many other improvements.**


## SubMaker v1.4.9

- Fixed per-user translation concurrency tracking so the 3-slot cap is enforced reliably even when multiple translations are started at the same time.
- Subtitle lookups now understand `tmdb:` IDs, map them to IMDB via Cinemeta with a 24h cache, and fall back to TMDB IDs in dedup keys so TMDB-only titles still return subtitles without cache collisions.
- Translation selector uses the same IMDB/TMDB mapping and cache-key fix, ensuring available subtitles populate correctly for TMDB-sourced streams and stay scoped to each user's config hash.
- Service worker cache writes are now guarded against `Vary: *`/`no-store` responses (including precache), preventing runtime `cache.put` failures when CDNs inject non-cacheable headers.
- Embedded subtitles page moves the MKV caution inline with the stream URL input so the warning is visible while choosing a source.
- Embedded-subtitles page CSP now explicitly allows Stremio Cinemeta metadata fetches and the hosting Cloudflare beacon script, preventing console CSP blocks for title lookups.

## SubMaker v1.4.8-beta

- Instructions modal now appears as a bottom-left peek after the main content loads, auto-tucks into the FAB after ~2.6s, and respects the "don't show again" preference while keeping body scroll unlocked.
- Modal overlays no longer close when clicking inside the modal content, and reopening via the help FAB clears any pending auto-minimize timer.
- Partials loader prioritizes the main partial before overlays/footers and exposes `mainPartialReady` for scripts that need core content ready (e.g., instructions peek gate); config loader now waits on that signal.
- Combobox dropdown panels now portal to the document body so they no longer get clipped or stuck behind neighboring cards/sections.
- File-upload translation options allow overflow again, so "Timestamps Strategy" and similar selects render fully instead of being truncated inside the accordion.
- File-translation reset modal now just clears page selections/preferences and reloads the page no cache wipes or token regeneration.
- Session manager now backfills missing token metadata, upgrades legacy unencrypted payloads in place, and keeps sessions for retry on decrypt errors instead of deleting them.

## SubMaker v1.4.7-beta

v1.4.6 hotfix.

- Default storage now redis: runtime fallback is redis unless explicitly set to filesystem; documentation updated to reflect redis as default and keep filesystem as an opt-in for local dev.

- Synced subtitle saves now reject missing/invalid session tokens with a 401 response, preventing cross-user pollution of the shared sync cache.
- Service worker skips caching responses that advertise `Vary: *` or `no-store`, avoiding runtime cache failures and leaking user-specific assets.
- Gemini config button visibility no longer flickers during init; it shows whenever a session token is present for the current origin.
- Simplified Gemini API key help by removing the inline tooltip widget; translation UI copy clarified for the triple-click retrigger tip.

## SubMaker v1.4.6-beta

- Addon origin checks now accept any `*.strem.io` host to prevent false security blocks from Stremio edge domains.
- Service worker now treats session/token API calls as non-cacheable and honors server no-store headers before caching API responses to avoid persisting sensitive data.
- Config page caches are now scoped to the active session token so swapping tokens can't leak or reuse another user's saved configuration.
- Session manager fingerprints configs and backfills token metadata, deleting mismatched or corrupted sessions from storage to prevent cross-user contamination.
- Session manager now removes sessions immediately when decryption fails or yields empty configs, ensuring corrupted payloads cannot be reused across users.
- Session-token config resolutions now always bypass the in-process resolve cache, preventing stale token lookups from leaking other users' language/target settings.
- Session-token addon routers are no longer served from the router cache; routers are rebuilt per request to eliminate stale token bleed across users.
- Package version bumped to 1.4.6 so runtime version reporting and cache busting align with the release notes.
- Redis storage now self-heals legacy double-prefixed keys (e.g., `stremio:stremio:*`) so sessions/configs stay visible whether the prefix includes a colon or not and across multi-instance Redis deployments.
- Redis key prefixes are now normalized to a canonical colon-suffixed form while still accepting colon/non-colon/custom variants, preventing mixed-prefix splits like `stremiosession:*`.
- Redis migrations reuse a raw migration client, handle cross-prefix self-healing across all variants, and clean up duplicates when targets already exist.
- Redis pub/sub invalidation subscribes and publishes on both prefixed and unprefixed channels to keep cache invalidations working across hosts with different prefixes.
- Startup validation now scans for double-prefixed keys across all configured prefix variants to flag misconfigurations early.

## SubMaker v1.4.5-hotfix

**Automatic Config Regeneration & Session Recovery:**

This release implements comprehensive automatic recovery for corrupted, missing, or expired session configurations, ensuring users never get permanently stuck with broken configs.

- **Automatic session regeneration**: New `/api/get-session/:token?autoRegenerate=true` endpoint automatically generates fresh default sessions when:
  - Session token is missing or expired from storage
  - Config payload is corrupted (resolves to `empty_config_00` hash)
  - Returns regeneration metadata (`regenerated: true`, `reason`, new `token`)
- **Smart config resolution**: `resolveConfigAsync()` now returns error-flagged default configs instead of creating tokens, preventing token proliferation during page initialization
- **Error subtitle reinstall links**: Session token errors in Stremio now display direct reinstall links with auto-regenerated tokens for one-click recovery
- **Config page auto-recovery**: Install page detects regenerated sessions and properly handles localStorage cleanup to prevent token mismatches
- **Reset button enhancement**: Full reset now requests fresh default token before clearing storage, ensuring clean bootstrap on /configure/{freshToken}
- **Session validation helper**: `regenerateDefaultConfig()` helper creates fresh default sessions tagged with regeneration metadata for error handlers

**Critical Bug Fixes:**

- **Fixed token mismatch on save after session loss**: Config page was storing regenerated tokens in localStorage during initialization, causing save operations to use a different token than what was installed in Stremio. Now properly clears invalid tokens and forces fresh session creation on save, requiring user to reinstall (expected behavior).
- **Fixed multiple token creation on page load**: `resolveConfigAsync()` was creating a new token on every invocation when session was missing, leading to dozens of tokens generated during page initialization. Now only `/api/get-session?autoRegenerate=true` creates tokens (called once).
- **Fixed error subtitle token generation**: Error subtitles now generate one-time tokens for reinstall links only when actually serving the error, not on every config resolution request.

**Other changes:**

- **Cloudflare-specific cache bypass headers**: Added `CF-Cache-Status: BYPASS`, `Cloudflare-CDN-Cache-Control: no-store, max-age=0`, `Vary: *` (universal variance), and `X-Cache-Buster` timestamp to force Cloudflare Workers/Warp to bypass caching on all user-specific routes
- **Enhanced proxy/CDN cache prevention**: Added `X-Accel-Expires: 0` (nginx), `CDN-Cache-Control: no-store` headers to prevent caching by reverse proxies and generic CDNs
- **Router cache validation**: Cached routers are now tagged with their config string and validated on retrieval - if a mismatch is detected, the cache is purged and contamination is logged
- **Enhanced diagnostic logging**: Added IP address, user agent, and config hash logging when routers are created; cached router serves now log target languages and cache age for debugging
- **Session validation endpoint**: New `/api/validate-session/:token` endpoint allows users to verify their session configuration and check for contamination in real-time
- **Router metadata tracking**: Routers are tagged with `__configStr`, `__targetLanguages`, and `__createdAt` for contamination detection and debugging

## SubMaker v1.4.4

**New Features:**
- **Stream activity feed:** New `/api/stream-activity` endpoint (SSE + polling) tracks the latest stream per config, keeping toolbox pages in sync with what you're watching
- **Google Translate provider (unofficial, keyless):** Uses the public web endpoint (no API key needed), works as main or fallback provider, includes safe token estimation and prompt compatibility, and is available in the config UI/manifest
- **File translation queue:** File-upload tool now queues multiple uploads with configurable batch size/concurrency, shows per-file progress/download links, and respects your saved main/fallback provider settings and advanced toggles
- **Lots of fixes to all new features from the unreleased v1.4.3**

**Translation Providers:**
- Providers with optional keys are now allowed in validation/manifest generation (keyless providers don't block saves)
- Translation overrides now accept explicit provider/workflow/timing options (source language, single-batch/AI-timestamps flags) so the UI can safely pass per-job overrides

**Subtitles, Sync & Embedded:**
- xEmbed translations are now listed directly in Stremio as downloadable "xEmbed (Language)" subtitles, keyed by the embedded cache
- First streaming partials wait for a minimum number of entries (`STREAM_FIRST_PARTIAL_MIN_ENTRIES`) to avoid ultra-short partial subtitles
- xSync lookups use stable video hashes (filename + videoId) with legacy-hash fallback and dedupe, keeping existing synced subs accessible and preventing duplicate buttons

**UI & Configuration:**
- Google Translate card added to the AI providers list (fixed `web` model, optional key); main/secondary provider validation accepts optional-key providers
- Localhost/base64 configs are normalized and validated (base64url padding restored) and invalid tokens are purged before reuse; session updates accept both session tokens and base64 tokens
- Toolbox/file-upload/sync pages share a sticky quick-nav (mobile drawer) plus a "jump to latest stream" refresh/watcher wired to stream-activity so you can hop to the current episode from any tool

**Storage, Cache & Infrastructure:**
- Router cache + in-flight request deduplication reduce duplicate router builds and repeated operations; session caps tuned (30k in-memory, 60k persisted) with autosave override support
- Translation caches (permanent/partial/bypass) now use config-scoped keys with legacy fallback/promotion and user-scoped purge logic; translation search dedupe keys include the config hash to avoid cross-user collisions
- Session manager now caches decrypted configs briefly (with safe cloning) to avoid repeated decrypt/log churn when users bounce between pages

**Security & Safety:**
- Config/host hardening: strict host validation with additive origin/user-agent allowlists via `ALLOWED_ORIGINS` and `STREMIO_USER_AGENT_HINTS`, and no-store headers on stream-activity responses
- Host validation now accepts IPv6/bracketed hosts and zone IDs while still rejecting injected/invalid Host headers (keeps manifests/addon URLs working on IPv6/self-hosted setups)
- Session logging now redacts tokens across cache operations and pub/sub invalidations

**Bug Fixes:**

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
- Translation engine now falls back to safe token estimates when providers don't expose token counters
- Base64 decode failures are prevented via normalization and stricter client/server token validation; manifest/model validation no longer blocks optional-key providers
- Parallel translation chunks now carry the detected source language and cache lookups fall back to legacy keys so chunked jobs and upgrades reuse cached work instead of re-translating

**Environment Variables:**
- `FILE_UPLOAD_MAX_BATCH_FILES`, `FILE_UPLOAD_MAX_CONCURRENCY` tune the file-upload queue limits for batch translations
- `ALLOWED_ORIGINS`, `STREMIO_USER_AGENT_HINTS` extend the host/user-agent allowlists for self-hosted or forked Stremio clients

## SubMaker v1.4.3 (unreleased)

**New Features:**
- Sub Toolbox: Unified hub for all subtitle tools accessible directly from Stremio's subtitle menu (right click>download subtitles opens browser page with all available tools)
- Video hash utility (`src/utils/videoHash.js`): Centralized video hash generation with `deriveVideoHash()` (stable hash combining filename + video ID), replacing inline MD5 hashing scattered throughout codebase
- Embedded Subtitle Extraction & Translation (BETA, UNTESTED, NEEDS CHROME EXTENSION): Extract embedded subtitles from video files/streams (HLS, MP4, MKV) with language/codec detection, automatic VTT to SRT conversion, web-based UI for track selection/preview/management, requires integration with "SubMaker xSync" Chrome extension for client-side extraction
- xEmbed cache system: Stores both original extracted tracks and translated versions, keyed by video hash (MD5 of filename) + track ID + language codes, shared across all users for same video file, prevents duplicate extraction/translation work, persistent storage with metadata
- TranslationEngine integration for embedded subtitles: Respects user's configured provider (Gemini, OpenAI, Anthropic, etc.), supports all advanced settings, single-batch mode and timestamps-to-AI toggle support, per-translation provider/model overrides, streaming disabled for embedded translations (batch-only)
- Chrome Extension Protocol: Message-based communication for subtitle extraction (`SUBMAKER_PING`/`PONG`, `EXTRACT_REQUEST`/`PROGRESS`/`RESPONSE`)

**New Routes & Pages:**
- `/addon/:config/sub-toolbox/:videoId` - Redirects to standalone Sub Toolbox page with session
- `/sub-toolbox` - Main toolbox hub page with links to all tools
- `/embedded-subtitles` - Embedded subtitle extraction and translation interface with extension status indicator, stream URL input, track selection grid, target language multi-select, provider/model selectors, translation options toggles, real-time logging, download cards
- `/auto-subtitles` - Placeholder page for upcoming automatic subtitle generation feature

**API Endpoints:**
- `/api/save-embedded-subtitle` - Save extracted embedded subtitle to cache (accepts: configStr, videoHash, trackId, languageCode, content, metadata; returns: cacheKey and metadata)
- `/api/translate-embedded` - Translate embedded subtitle with TranslationEngine (accepts: configStr, videoHash, trackId, sourceLanguageCode, targetLanguage, content, options, overrides, forceRetranslate; returns: translatedContent, cacheKey, metadata, cached flag; includes automatic VTT to SRT conversion, cache lookup with force retranslate option)
- `/addon/:config/xembedded/:videoHash/:lang/:trackId` - Download translated xEmbed subtitle (embedded translation)
- `/addon/:config/xembedded/:videoHash/:lang/:trackId/original` - Download original xEmbed subtitle (embedded original)

**Storage System Enhancements:**
- New cache type `StorageAdapter.CACHE_TYPES.EMBEDDED` for embedded subtitle storage (separate from translation/sync cache, supports original tracks and translated versions)
- Pattern-based key listing for video hash lookups (Redis uses SCAN with `embedded:<pattern>`)
- Redis implementation uses same LRU eviction + size-counter enforcement as other caches (default limit 0.5GB, configurable via `CACHE_LIMIT_EMBEDDED`, no TTL by default)
- New StorageAdapter methods: `list(cacheType, pattern)` for listing cache keys matching glob pattern, `getStats(cacheType)` for cache statistics
- FilesystemStorageAdapter: Added `data/embedded/` directory, implemented pattern matching with glob support, cache statistics calculation
- Storage factory cleanup: Hourly cleanup interval added for embedded cache type (matches sync/bypass/partial)

**Configuration Updates:**
- Unified "Enable Sub Toolbox" toggle replaces separate "Translate SRT" and "Sync Subtitles" checkboxes
- Removed "Dev" section entirely - `syncSubtitlesEnabled` toggle no longer shown separately
- Config migration logic automatically consolidates `subToolboxEnabled`, `fileTranslationEnabled`, and `syncSubtitlesEnabled` flags (if any are true in saved config, all three set to true on load, ensures backward compatibility)
- Modal renamed from "Translate SRT Instructions" to "Sub Toolbox Instructions" with updated content
- Visual state localStorage key updated: `submaker_dont_show_sub_toolbox` (preserves legacy key for backward compat)
- Description updated to mention all four tools: translate files, sync subtitles, extract embedded subs, automatic subs

**UI Improvements:**
- Sub Toolbox page: Modern gradient design with card-based tool layout, hero section with configuration summary, quick links to all tools, "How it works" guide, responsive grid layout
- Embedded subtitles page: Full-featured extraction and translation interface with extension status indicator, stream URL input with extraction controls, track selection grid with visual feedback, target language multi-select with status pills, provider and model dropdown selectors, translation options toggles (single-batch, timestamps), real-time logging for extraction/translation progress, download cards for originals/translated files, "Reload subtitle list" reminder after successful translations
- Auto subtitles page: Placeholder with feature preview and links to other tools
- Single "Sub Toolbox" action button in Stremio subtitle list replaces separate "Translate SRT" and "Sync Subtitles" buttons (appears when `subToolboxEnabled === true`, links to `/addon/:config/sub-toolbox/:videoId?filename=...`)

**Security & Cache Safety:**
- All toolbox routes protected with cache prevention headers
- Session token validation before serving toolbox pages
- Config validation on all embedded subtitle API endpoints
- VTT to SRT conversion sandboxed with error handling
- Provider override sanitization and validation
- Advanced settings clamping (temperature 0-2, topP 0-1, etc.)
- Centralized `setNoStore(res)` helper function (sets Cache-Control, Pragma, Expires, Surrogate-Control headers for cache prevention)

**Error Handling Improvements:**
- Enhanced OpenSubtitles Auth rate limit detection (429) with implementation-specific guidance
- Differentiated error messages: Auth with credentials ("rate limiting your account"), Auth without credentials ("basic rate limit, add username/password or switch to V3"), V3 (standard rate limit subtitle)
- Rate limit errors (429) no longer misclassified as authentication failures
- User-facing error subtitles (0?4h) explain quota and suggest remediation
- Logs which subtitle (fileId, language) triggered the rate limit for easier debugging

**Bug Fixes:**

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
- Fixed VTT content not being convertible for translation
- Fixed provider override not applying to embedded subtitle workflows
- Fixed cache key collisions between different subtitle types
- Fixed missing cache headers on session management endpoints
- Fixed redirect cache for `/addon/:config/sub-toolbox/:videoId` route

**Performance & Infrastructure:**
- JSON payload limit increased from 1MB to 6MB (`express.json({ limit: '6mb' })`) for embedded subtitle uploads up to ~5MB (browser-extracted SRT content)
- Sync page (`syncPageGenerator.js`) filters out `sub_toolbox` action button from fetchable subtitle list
- OpenSubtitles `implementationType` defaults to 'v3' during config normalization (was implicit before)
- Subtitle handler logs now include cache type counts: `xSync`, `xEmbed`, `learn`, `translations`, `actions`

**Environment Variables:**
- `CACHE_LIMIT_EMBEDDED` - Configurable embedded subtitle cache limit (default 0.5GB, documented in `.env.example`)

**This release addresses multiple security vulnerabilities:**

**CRITICAL Security Fixes:**
- XSS (Cross-Site Scripting) in `src/utils/toolboxPageGenerator.js` and `src/utils/syncPageGenerator.js`: Added `safeJsonSerialize()` using double-encoding to prevent `</script>` breakout, replaced `.innerHTML` with safe DOM methods (prevented session token theft, API key exfiltration, account compromise)
- NoSQL Injection in Redis (`src/storage/RedisStorageAdapter.js`, `src/utils/embeddedCache.js`): Added `_sanitizeKey()` removing wildcards (`*?[]\`), validates length, hashes oversized keys (prevented cache poisoning, data exfiltration via wildcard patterns, key collision attacks)
- Session Token Exposure in Logs (`src/utils/sessionManager.js`, `index.js`): Created `redactToken()` utility showing only first/last 4 chars, updated 12+ log statements (prevented session hijacking if logs compromised)

**HIGH Priority Security Fixes:**
- Path Traversal in `src/storage/FilesystemStorageAdapter.js`: Double URL-decode detection, strengthened path verification with proper boundary checks (prevented arbitrary file read/write outside cache directories)
- API Key Exposure: Created `src/utils/security.js` with `sanitizeError()`, `sanitizeConfig()`, `redactApiKey()` utilities (prevented API keys in error messages and logs)
- Closed caching gaps: Expanded no-store middleware to every user-specific API listed in v1.4.2 (manifests/addon paths were already covered) and disabled ETags even for static assets to stop conditional caching bleed (index.js)
- Blocked host-header poisoning: Added strict host validation and now build addon URLs/manifests with sanitized hosts so malicious Host headers can't poison generated links (index.js)
- Hardened config handling: Validated all `:config` path params (length/characters) before parsing, added 120KB guardrail on session create/update payloads, and kept request bodies under control without changing normal flows (index.js)

**Security Audit Summary:**
- Vulnerabilities fixed by type: XSS (2), NoSQL Injection (1 + defense-in-depth), Information Disclosure (3), Path Traversal (1), Input Validation (4), Security Misconfiguration (6), Caching Gaps (1), Host Header Poisoning (1)

## SubMaker v1.4.2

**Critical Bug Fix - Comprehensive Cache Prevention:**

- **Fixed critical incomplete cache fix**: The past fix for cross-user configuration contamination only added cache prevention headers to `/api/get-session/:token` endpoint.

**Complete fix includes:**
  1. **Early middleware**: Added `/addon` to `noStorePaths` array to catch all addon routes at the earliest middleware layer
  2. **Disabled ETags globally**: Set `app.set('etag', false)` to prevent any conditional caching mechanisms
  3. **Explicit cache headers on all user-specific routes** (defense-in-depth):
     - **Configuration pages**: `/`, `/configure`, `/file-upload`, `/subtitle-sync`
     - **Addon routes**:
       - `/addon/:config` - Base addon path redirect
       - `/addon/:config/manifest.json` - Primary manifest endpoint that Stremio uses
       - `/addon/:config/configure` - Addon configuration redirect
       - `/addon/:config/subtitle/*` - Custom subtitle download routes
       - `/addon/:config/translate/*` - Custom translation routes
       - `/addon/:config/translate-selector/*` - Translation selector routes
       - `/addon/:config/learn/*` - Learn mode dual-language routes
       - `/addon/:config/error-subtitle/*` - Error subtitle routes
       - `/addon/:config/file-translate/*` - File translation routes
       - `/addon/:config/sync-subtitles/*` - Subtitle sync routes
       - `/addon/:config/xsync/*` - Synced subtitle download routes
     - **Session API routes**:
       - `/api/create-session` - Session creation endpoint
       - `/api/update-session/:token` - Session update endpoint
       - `/api/get-session/:token` - Session retrieval (already had headers from v1.4.0)
     - **Translation & File API routes**:
       - `/api/translate-file` - File translation endpoint with user config
       - `/api/save-synced-subtitle` - Synced subtitle storage with user config
     - **Model Discovery & Validation API routes**:
       - `/api/gemini-models` - Gemini model discovery with user credentials
       - `/api/models/:provider` - Generic provider model discovery with user credentials
       - `/api/validate-gemini` - Gemini API key validation
       - `/api/validate-subsource` - SubSource API key validation
       - `/api/validate-subdl` - SubDL API key validation
       - `/api/validate-opensubtitles` - OpenSubtitles credentials validation
     - **Toolbox pages**: `/file-upload`, `/subtitle-sync`, `/sub-toolbox`, `/embedded-subtitles`, `/auto-subtitles`

- This comprehensive fix uses a **defense-in-depth strategy** with cache prevention at three layers (early middleware, route-specific headers, and disabled ETags) to ensure no user-specific content is ever cached by proxies, CDNs, or browsers. This should completely resolve all reported cases of "random language in Make button" issues.

## SubMaker v1.4.1

**Bug Fixes:**

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
- Min-size guard now allows internal informational subtitles to surface instead of being replaced by generic corruption errors: hidden informational notes are emitted (as >4h cues) to keep addon-generated subtitles above Stremio's minimum-size heuristics while keeping the note off-screen.
- Provider downloads that return 404 or corrupted ZIPs now surface as user-facing subtitles (SubDL, SubSource, OpenSubtitles, OpenSubtitles V3).
- Added 25 MB ZIP size caps for SubSource, SubDL, OpenSubtitles, and OpenSubtitles V3; oversized packs return a user-facing subtitle instead of being parsed.

## SubMaker v1.4.0

**New Features:**

- AI timestamps mode (toggle in Advanced Settings): trust the active translation provider to return/repair timestamps per batch, stream partial SRTs with AI timecodes where supported (Gemini), and rebuild partials safely while throttling with new `SINGLE_BATCH_*` env controls.
- Single-batch Translation Mode with streaming partials to Stremio, token-aware chunking, and new `SINGLE_BATCH_*` env knobs to throttle streaming rebuild/log cadence.
- Beta Mode added to config page - enabling it creates a "Multiple Providers" option on "AI Translation API Keys" section and shows "Advanced Configs" section for changing Gemini parameters.
- Multi-provider translation pipeline: oOpenAI, Anthropic, XAI/Grok, DeepSeek, DeepL, Mistral, OpenRouter, and Cloudflare Workers AI providers with per-provider keys/model pickers and automatic model discovery with a new parallel translation workflow.
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
- `SINGLE_BATCH_SRT_REBUILD_STEP_SMALL` - Partial SRT rebuild step when entries = threshold
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
- Just Fetch mode: Added a configurable cap on fetched languages (default 9) via `MAX_NO_TRANSLATION_LANGUAGES`, with UI enforcement and backend validation.
- Config/UI: Updated Gemini model options to use `gemini-flash-latest` and `gemini-flash-lite-latest` for the Flash defaults.
- Translation engine: Each batch prompt now carries an explicit `BATCH X/Y` header so the model knows which chunk it is translating.
- Advanced settings: New  Send timestamps to AI  toggle sends timecodes to Gemini and trusts the model to return corrected timestamps per batch using the default translation prompt.

**Bug Fixes:**

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
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

**Bug Fixes:**

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
- Multiple minor bug fixes

## SubMaker v1.3.3

**New Features:**

- Learn Mode: Adds dual-language subtitles outputs ("Learn [Language]") with configurable order for language learning
- Mobile Mode: Holds Stremio subtitles requests until the translation is finished before returning it

**SubSource:**

- Downloads: CDN-first with endpoint fallback. When available, we now fetch the provider's direct download link first (4s timeout) and fall back to the authenticated `/subtitles/{id}/download` endpoint with retries, then details>CDN as a final fallback. This significantly reduces user-facing timeouts on slow endpoints while preserving existing ZIP/VTT/SRT handling.
- Latency tuning: Reduced primary `/subtitles/{id}/download` retry budget to ~7s and, on the first retryable failure, launch a parallel details>CDN fetch and return the first success. This caps worst-case latency and improves reliability on slow or flaky endpoints.
- MovieId lookup resilience: If `/movies/search` returns empty or times out, derive `movieId` via imdb-based endpoints (`/subtitles?imdb= ` then `/search?imdb= `) as a fallback, reducing transient lookup failures and improving overall subtitle search reliability.
- Download timeouts: Added a user-facing subtitle (0>4h) when the SubSource API times out during download, informing the user and suggesting a retry or choosing a different subtitle (similar to existing PROHIBITED_CONTENT/429/503 messages).
- Timeout detection: Broadened SubSource timeout detection so axios-style rewrites still return the timeout subtitle instead of bubbling an unhandled error.

**OpenSubtitles Auth:**

- Detect season packs during search and extract the requested episode from season-pack ZIPs on download (parity with SubDL/SubSource).
- Add client-side episode filtering to reduce wrong-episode results when API returns broader matches.
- 429 handling: Rate limit responses are no longer misclassified as authentication failures; we now show a clear  rate limit (429)  subtitle and avoid caching invalid-credential blocks for retryable errors.
- Download auth handling: 401/invalid OpenSubtitles login errors now return the auth error subtitle instead of bubbling an unhandled download failure.
- Login: Improved error classification to bubble up 429/503 so callers can present user-friendly wait-and-retry guidance instead of generic auth errors.
- Guardrails: Block saving Auth without username/password and auto-fall back to V3 if Auth is selected without credentials to avoid runtime login errors.
- Daily quota handling: When OpenSubtitles returns 406 for exceeding the 20 downloads/24h limit, the addon now serves a single-cue error subtitle (0>4h) explaining the quota and advising to retry after the next UTC midnight (mirrors existing PROHIBITED_CONTENT/429/503 behavior).

**OpenSubtitles v3:**

- 429/503 handling: V3 download errors now return a single-cue error subtitle (0>4h) with clear wait-and-retry guidance, consistent with other provider and safety messages.
- Filename extraction: add a single retry after 2s when HEAD requests return 429 during filename extraction; per-attempt timeout remains 3s (processed in batches of 10).
- Format awareness and file-upload translation: infer actual format for OpenSubtitles V3 results from filename/URL (no longer hardcoded SRT); convert uploaded VTT/ASS/SSA to SRT before translation; and always download translated uploads as .srt.

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

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
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
- Session monitoring & alerting: Added comprehensive monitoring with alerts for storage utilization (warning at >80%, critical at =90%), abnormal session growth (>20%/hour), and eviction spikes (>3x average)
- Automatic storage cleanup: Hourly cleanup process that purges 100 oldest-accessed sessions when storage utilization reaches 90%

**Environment Variables:**

- `SESSION_MAX_SESSIONS`: Updated default from 50,000 to 30,000 (in-memory limit)
- `SESSION_STORAGE_MAX_SESSIONS`: New variable, default 60,000 (storage limit)
- `SESSION_STORAGE_MAX_AGE`: New variable, default 90 days (storage retention period)

**Bug Fixes:**

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
- Fixed .ass to .vtt conversion producing empty files (~23 bytes): Now validates converted VTT contains timing cues and falls back to manual ASS parser if library conversion produces invalid output
- Updated subsrt-ts from 2.0.1 to 2.1.2 for improved conversion reliability
- Removed unused advanced configs from install page

## SubMaker v1.2.6

**Bug Fixes:**

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
- Translation flow now validates source subtitle size before returning loading message to prevent users from waiting indefinitely for corrupted files
- Fixed purge trigger failing to detect cached translations in bypass cache mode: `hasCachedTranslation` now correctly calls `readFromBypassStorage` instead of non-existent `readFromBypassCache`

## SubMaker v1.2.5

**Bug Fixes:**

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
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

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
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

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
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

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
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

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
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

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
- Fixed PROHIBITED_CONTENT error detection: Now properly identifies all safety filter errors (PROHIBITED_CONTENT, RECITATION, SAFETY) and displays appropriate user message instead of generic "please retry" text
- Improved HTTP error detection: Added direct HTTP status code checking (403, 503, 429) for better error classification and messaging
- Enhanced error messages: Users now see specific error descriptions for 503 (service overloaded), 429 (rate limit), and 403 (authentication) errors instead of generic fallbacks

**Translation Engine Improvements:**
- Better error caching: Translation errors are now properly cached for 15 minutes, allowing users to understand what went wrong and retry appropriately

## SubMaker v1.1.4

**Bug Fixes:**

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
- Fixed Gemini API key validation: Removed duplicate model fetching messages that appeared after clicking "Test" button
- Fixed Gemini API key input: Green border now only appears when API key is successfully validated by backend, not just when field is not empty
- Moved model fetching status messages to Advanced Settings section only (no longer shows in main config area)

## SubMaker v1.1.3

**New Features:**
- **Gemini v1beta endpoint rollback**: Fixing previous change that introduced problems.
- **API Key Validation**: Added "Test" buttons to validate API keys for SubSource, SubDL, OpenSubtitles, and Gemini directly from the config page
- **Dark Mode**: All addon pages now support automatic dark/light themes based on system preference with manual toggle buttons

**Bug Fixes:**

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
- Fixed config page: Gemini API key validation now properly displays notification alerts when field is empty
- Fixed config page: "Just-fetch subtitles" mode now clears validation errors for translation-only fields (Gemini API key, source/target languages)
- Fixed config page: Switching between translation and no-translation modes now clears language selections from the previous mode to prevent unwanted languages from being saved
- Various minor  fixes.

## SubMaker v1.1.2

**New Features:**
- **Intelligent Subtitle Ranking**: Advanced filename matching algorithm prioritizes exact release group matches (RARBG, YTS, etc.) and rip type compatibility (WEB-DL, BluRay) for optimal sync probability
  - Matches resolution, codec, audio, HDR, streaming platform (Netflix, Amazon), and edition markers (Extended, Director's Cut) to find best-synced subtitles
- Added Advanced Settings (EXPERIMENTAL) section to configuration page for fine-tuning AI behavior
- Secret unlock: Click the heart (??) in the footer to reveal Advanced Settings

**Performance Improvements:**
- Automatic cache purging when user changes configuration (different config hash = different cache key)
- Configurable environment variables: `SUBTITLE_SEARCH_CACHE_MAX`, `SUBTITLE_SEARCH_CACHE_TTL_MS`

**File Translation:**
- **Parallel Translation for File Upload**: Large SRT files (>15K tokens) are now automatically split into chunks and translated concurrently
  - Parallel API calls, context preservation, environment variables configuration, automatic retry.
- **File Translation Advanced Settings**: Added experimental advanced settings section to file translation page for temporary per-translation overrides of model, prompt, and AI parameters (thinking budget, temperature, top-P, top-K, max tokens, timeout, retries)

**Bug Fixes:**

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
- **User-Isolated Subtitle Search Cache**: Fixed a problem of cache sharing between users with different configurations (API keys, providers, languages)
- **RTL Translations**: Added RTL embedding markers for translated subtitles so punctuation renders correctly for Hebrew/Arabic outputs
- Various major and minor bug fixes.

## SubMaker v1.1.1

**Bug Fixes:**

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
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
- Increased entry cache: 10,000 ? 100,000 entries (5x capacity, improves cache hit rate from ~60% to ~75-85%)
- Optimized partial cache flushing: Flush interval increased from 15s ? 30s (50% less I/O overhead)
- Enhanced response compression: Maximum compression (level 9) for SRT files: 10-15x bandwidth reduction (500KB ? 35KB typical)
- Async file logging with buffering replaces synchronous writes, eliminating event loop blocking (1-5ms per log) that caused 100-300ms p99 latency spikes under load
- Log sampling support for extreme load scenarios (LOG_SAMPLE_RATE, LOG_SAMPLE_DEBUG_ONLY) allows reducing log volume while preserving critical errors

**Bug Fixes:**

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
- Fixed bypass cache user isolation: Each user now gets their own user-scoped bypass cache entries (identified by config hash), preventing users from accessing each other's cached translations when using "Bypass Database Cache" mode
- Fixed 3-click cache reset to properly handle bypass vs permanent cache
- Config hash generation now handles edge cases gracefully with identifiable fallback values instead of silent failures
- **Various major and minor bug fixes**

## SubMaker v1.0.3

**UI Redesign:**

**Code Refactoring:**
- Renamed bypass cache directory from `translations_temp` to `translations_bypass` for clarity
- Renamed `tempCache` configuration object to `bypassCacheConfig` (backward compatible with old `tempCache` name)
- Updated all cache-related function names: `readFromTemp` ? `readFromBypassCache`, `saveToTemp` ? `saveToBypassCache`, `verifyTempCacheIntegrity` ? `verifyBypassCacheIntegrity`

**UI & Configuration:**
- Added password visibility toggle (eye icon) to OpenSubtitles password field
- Completely redesigned file translation page with UI matching the configuration page style
- Added support for multiple subtitle formats: SRT, VTT, ASS, SSA (previously only SRT was supported)
- Enhanced file upload interface with drag-and-drop support and animations

**Performance:**
- Subtitle now applies rate limiting per-language after ranking all sources: fetches from all 3 subtitle sources, ranks by quality/filename match, then limits to 12 subtitles per language (ensures best matches appear first)

**Bug Fixes:**

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
- Fixed validation error notifications: errors now display when saving without required fields (Gemini API key, enabled subtitle sources missing API keys)
- Fixed "Cannot GET /addon/..." error when clicking the config/settings button in Stremio after addon installation
- Configuration page code cleanup: removed unused files and duplicate code, simplified cache/bypass toggle logic
- Various small bug fixes.

## SubMaker v1.0.2

**UI & Configuration:**
- Quick Start guide now appears only on first run, hidden after setup
- API keys section defaults unchecked (enable only what you need)
- Loading message updated to show 0?4h range explaining progressive subtitle loading during translation
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

- **Config reset scope fix:** Fixed config reset throwing ReferenceError by keeping the fresh token in scope for the reload step.
- **Locale key flash fix:** Prevented raw i18n keys from appearing briefly before localized text loads on config pages.
- Fixed SRT integrity during partial loading: entries reindexed and tail message positioned after last translated timestamp
- Fixed addon URL generation for private networks (192.168.x.x, 10.x.x.x, 172.16-31.x.x ranges now recognized as local, preventing forced HTTPS)



