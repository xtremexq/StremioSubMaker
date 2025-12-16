# Changelog

All notable changes to this project will be documented in this file.

## SubMaker v1.4.24

- **ASS/SSA subtitle first letter fix:** Fixed a bug where converting ASS/SSA subtitles to VTT caused the first letter of each subtitle line to be lost. The issue was in the `subsrt-ts` library's parsing, which consumed the first character of the text field. The fix adds a protective leading space before the text field in Dialogue lines during preprocessing.

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
- **Addon localhost access:** Addon API routes now allow localhost origins (any port) so local browser requests—including macOS Safari/Chrome—can fetch subtitles without being blocked.

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
- **Auto-sub log redesign:** Auto-subtitles toolbox log is now a styled live feed with timestamps, severity coloring, capped history, and a pipeline preview to make each run’s status readable.
- **Upstream error clarity:** Cloudflare transcription responses parse non-JSON bodies, return upstream status codes/body snippets, and surface 5xx hints in API/toolbox flows so failures are actionable.

## SubMaker v1.4.14

- **xEmbed language grouping:** Embedded originals now surface with canonical language codes, so extracted tracks merge into the same Stremio language bucket instead of creating duplicate language entries.
- **Make from embedded:** “Make (Language)” entries now include extracted embedded tracks as valid sources, even when no provider subtitles exist, with deduped source lists.
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
- **Auto-sub flow locks:** Auto-subtitles flow adds a Continue step that unlocks translation/run cards, disables Start until a target is set, and relocks when the stream is edited so runs can’t start on placeholder links or missing targets.
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
- **Shared translation cache reinstated:** Shared “Make (Language)” translations are re-enabled with a new namespaced storage prefix, automatic legacy purge, and hard bypass of reads/writes when a config hash is missing/invalid.
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

- **Stremio install popup formatting:** Fixed manifest description strings that were double-escaped, so `\n` now render as actual line breaks in the install dialog.
- **Batch context in single-batch splits:** When single-batch translations exceed token limits and auto-split, surrounding/previous-entry context is now passed through so coherence is preserved in this edge mode.
- **Embedded studio UX gaps:** Instructions modal now respects the “don’t show again” preference, extraction no longer hangs if the xSync extension goes silent (60s watchdog with reset/re-ping), the extension badge reflects active extraction vs ready state, and single-track extractions auto-select to unlock Step 2 immediately.
- **Mobile quick-nav toggle:** Restored the hamburger bars on tool pages for screens under 1100px width.
- **Resilient language maps:** Subtitle menu now guards language-map bootstrapping and drops stale backups so missing/invalid maps can’t crash subtitle rendering.
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
- File-translation reset modal now just clears page selections/preferences and reloads the page—no cache wipes or token regeneration.
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
- User-facing error subtitles (0→4h) explain quota and suggest remediation
- Logs which subtitle (fileId, language) triggered the rate limit for easier debugging

**Bug Fixes:**
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
- Just Fetch mode: Added a configurable cap on fetched languages (default 9) via `MAX_NO_TRANSLATION_LANGUAGES`, with UI enforcement and backend validation.
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
- **RTL Translations**: Added RTL embedding markers for translated subtitles so punctuation renders correctly for Hebrew/Arabic outputs
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
