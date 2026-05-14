# Changelog

All notable changes to this project will be documented in this file.

## SubMaker v1.4.84

**Improvements:**

- **Retirement of Gemini 3.1 Flash Lite Preview for stable model:** Relevant features like the base model dropdown, advanced Gemini model list, Quick Setup defaults, backend model-specific defaults, and saved-config normalization now use the GA `gemini-3.1-flash-lite` model instead of `gemini-3.1-flash-lite-preview`. Existing saved configs and advanced overrides with the preview slug are migrated before requests are sent to Gemini.

- **Switched Gemini fallback defaults to Flash Lite latest:** Hardcoded fallback paths now resolve to `gemini-flash-lite-latest` instead of the Flash alias when no explicit model is configured, including the `GeminiService` constructor, backend config defaults, frontend config helpers, Quick Setup handoffs, AutoSubs defaults, advanced-settings comparison defaults, and localized helper copy. Old `gemini-flash-latest` saved values are treated as legacy inputs and normalized to the Lite fallback.

- **Implemented OpenAI GPT-5-family request shaping for translation:** OpenAI Chat Completions requests now send `reasoning_effort` instead of the Responses-style `reasoning` object, so configured reasoning no longer breaks `gpt-5.4-mini`, `gpt-5.4`, `gpt-5.5`, and compatible GPT-5 chat models. GPT-5 pro-family requests routed to the Responses API now use `text.format` for structured output instead of Chat's `response_format`, and strict JSON schemas now use the OpenAI-required object root with an `entries` array envelope instead of a root array. Non-reasoning OpenAI models such as `gpt-4.1` no longer receive reasoning parameters even if an old config saved one.

- **Expanded OpenAI reasoning-effort configuration for current models:** The Configure page and file-upload toolbox now preserve and expose `none`, `minimal`, `low`, `medium`, `high`, and `xhigh` reasoning-effort choices where applicable. Backend and frontend config normalization now accept the same values, while the OpenAI provider maps or omits unsupported values per model family to keep requests valid.

- **Token Vault exports now create full configuration backups:** The vault's JSON export format now writes backup schema version `2` files that include each profile's full normalized configuration snapshot, including tuned AI/provider parameters, subtitle-provider settings, key rotation settings, toolbox flags, and other saved options, instead of only exporting local token metadata. Importing one of these full backups creates fresh server sessions with new tokens from the saved snapshots, restores the disabled state when possible, and then saves the restored profiles back into the local browser vault. Older token-only single-profile and full-vault exports remain supported and still import as local token references, so existing backups keep working.

- **Reworked OpenSubtitles Auth rate limiting to prevent avoidable upstream `429`s:** `/login`, `/subtitles`, and `/download` now reserve their OpenSubtitles REST send timestamp before the request is made. `/login` reserves both the shared `5 req/sec/IP` API gate and the stricter `1 req/sec` login gate atomically in Redis, so a login request can no longer take one slot, wait on the other, then send outside the real upstream budget. The Redis limiter keys now use a shared hash tag so multi-key reservations stay valid on Redis Cluster/Sentinel-style deployments, and requests that cannot fit inside the caller timeout fail before reserving a slot.

**Bug Fixes:**

- **Fixed file-upload model overrides to use the selected translation provider:** The `/file-upload` Advanced Settings model override now reloads its model list from the provider selected in Translation Options using the saved session credentials, including Gemini, OpenAI-compatible providers, Anthropic, DeepL, Cloudflare Workers AI, OpenRouter, and custom OpenAI-compatible endpoints. The dropdown no longer reuses stale models after provider switches, custom provider base URLs are preserved server-side without leaking to the page, and `/api/translate-file` now applies the chosen provider/model override to every queued upload even when the saved provider model is only a runtime override for that translation.

- **Removed the hard OpenSubtitles post-`429` cooldown:** an unexpected upstream `429` now only advances the next reservation according to OpenSubtitles response headers such as `ratelimit-reset`/`retry-after`; it does not write a internal cooldown and does not skip later searches because of that cooldown.

- **Stopped `/subtitles` searches from creating extra OpenSubtitles traffic through canonical redirects:** OpenSubtitles Auth search now sends alphabetically sorted, lower-cased GET parameters in the request URL instead of letting axios serialize an arbitrary params object. This follows OpenSubtitles' documented redirect-avoidance guidance, so one SubMaker search maps to one upstream `/subtitles` request instead of sometimes becoming request + redirect.

- **Removed the OpenSubtitles Auth provider-level search-result cache from the rate-limit fix:** search calls are paced correctly rather than hidden behind result caching.

- **OpenSubtitles Auth keep-alive now doesn't bypass the API gate:** the Auth REST keep-alive now probes `/infos/formats` through the same shared OpenSubtitles API limiter with no bearer token and no `/login` call. It is opportunistic (`0ms` queue budget), so it skips when real OpenSubtitles traffic is already using the shared budget, and it runs on a slower configurable cadence (`OPENSUBTITLES_AUTH_KEEPALIVE_INTERVAL_MS`, default 120s) instead of spending a slot at every generic keep-alive tick.

## SubMaker v1.4.83

**Bug Fixes:**

- **Hardened OpenSubtitles Auth against production `429` bursts:** the shared Auth API limiter now uses a Redis-backed leaky gate instead of a fixed one-second bucket, so clustered deployments cannot burst across window boundaries while staying nominally under `4 req/sec`. All `/login`, `/subtitles`, and `/download` API calls, including token-refresh retries, now pass through the same limiter, upstream `429`/rate-limit headers push a short cooldown back into Redis for every pod, and the local no-Redis fallback is conservative at `1 req/sec`. OpenSubtitles credential validation also uses the normal validation endpoint limiter before it enters the upstream login queue.

- **Fixed rate limiting failing open while Redis was late or unavailable:** the `express-rate-limit` Redis store no longer queues startup script loading behind the old 30-second Redis wait. The shared limiters now use Redis when the shared client is ready and immediately fall back to a per-process memory store when Redis is missing or a Redis command fails, so Stremio subtitle traffic no longer triggers `Redis not available for rate limiting after 30s` and no longer runs completely unmetered just because Redis is unavailable.

- **Removed requests caused by cache-buster redirects:** versioned addon paths such as `/addon/{token}/v1.4.83/subtitles/...` are now accepted as internal aliases, while unversioned addon paths are served directly with `no-store` instead of a `307` hop. Configure and Quick Setup keep generating unversioned manifest install URLs so installed Stremio transports are not pinned to a release-specific path.

## SubMaker v1.4.82

**Improvements:**

- **Added SCS Community/Auth modes:** SubMaker now allows an Auth mode where users can provide their own SCS auth key. Auth mode sends SCS the selected SubMaker languages through the upstream `langs` override so requests can avoid the broad all-languages search path (faster), while Community mode preserves the current shared-key behavior for users without an SCS key.

- **Fixed partial provider timeout results becoming sticky in subtitle search cache:** timed-out provider searches can still return the providers that finished in time, but SubMaker now marks those responses as partial and avoids caching them. This prevents a temporary target-only result set from hiding source-backed translation entries such as `Make Serbian` on later refreshes.

- **Fixed Stremio Firebase-hosted web app requests being rejected by the origin policy:** `https://stremio.web.app` is now included in the default known Stremio web frontend origins, and the official `*.stremio.com` wildcard allowlist is explicitly documented in the origin matcher so supported Stremio web clients follow the normal CORS path.

- **Added SCS auth-key setup across Configure and Quick Setup:** the main provider settings and Quick Setup source picker now expose the SCS mode choice and auth-key field, validate that Auth mode has a key before saving, preserve the setting when restoring sessions, and encrypt the SCS auth key alongside the other subtitle-provider credentials.

- **Fixed saved settings changing after refreshing Configure:** the normal page-load path no longer restores translation settings from an empty Just Fetch backup, so saved Learn Mode and other selections stay enabled unless the user is actually returning from Just Fetch mode.

## SubMaker v1.4.81

**New Features:**

- **Added complete Token Vault removal for saved sessions:** The Token Vault manager now includes a `Complete Removal` action that permanently deletes a token from SubMaker storage, clears the browser vault copy, and requires rewriting the exact token before deletion. Server-side deletion now removes loaded and storage-only sessions, alternate storage-prefix remnants, on-disk snapshot entries, token-linked history namespaces, and local caches; deleting the active page token detaches the page into a recovered draft so the current form state is kept only until the user saves again.

**Bug Fixes:**

- **Fixed Nuvio web clients being rejected by the origin policy:** `https://web.nuvioapp.space` is now included in the default known Stremio web frontend origins, so browser-origin addon requests from Nuvio follow the same CORS path as the other supported web frontends without opening a broad `*.nuvioapp.space` wildcard.

- **Fixed Quick Setup SubDL API-key validation false failures:** The `Test SubDL API` path now matches the real SubDL provider search request by including `subs_per_page`, which avoids `Not Authorized` responses for valid keys when actual SubDL search/download already works. The validation fix is in `/api/validate-subdl` and follows the documented SubDL search request shape from [SubDL's API docs](https://subdl.com/api-doc).

- **Fixed empty SubDL/SubSource API-key configs creating noisy no-result searches:** Omitted or keyless SubDL/SubSource configs now normalize to `enabled: false`, subtitle search dispatch skips those providers unless a usable API key is present, and the service-level missing-key fallback now logs at debug level and returns no results instead of producing provider errors.

## SubMaker v1.4.80

**Improvements:**

- **Relaxed background keep-alive probing for subtitle providers:** periodic provider keep-alive probes now wait up to `10s` instead of `5s` before timing out, which gives slower hosts more room to respond during idle warm-connection checks. Wyzie and SCS keep using background probes, but failed keep-alive pings for those two providers no longer feed the shared provider circuit breaker, so a slow or flaky idle probe cannot temporarily suppress real user searches for SCS or Wyzie anymore.

- **Fixed Wyzie Subs after the upstream API-key rollout:** Wyzie search requests now target `sub.wyzie.io` and include the required `key` query parameter, while the returned `sub.wyzie.io/c/...` download URLs continue to work through the existing subtitle download flow. SubMaker stores `subtitleProviders.wyzie.apiKey` alongside the other sensitive provider credentials with the normal session encryption/recovery path, adds `/api/validate-wyzie`, and updates both the main Configure page and Quick Setup wizard with a Wyzie API-key input, live validation button, redeem link to `https://sub.wyzie.io/redeem`, and corrected saved-source normalization for legacy `opensubs` configs.

**Bug Fixes:**

- **Fixed `ASS/SSA Passthrough` missing from Just Fetch settings and aligned the settings order across both config modes:** the no-translation (`Just Fetch`) config surface did not expose the passthrough toggle even though the main `Other Settings` card had it, and the visible option order had drifted between the two modes. Just Fetch now shows `Enable Sub Toolbox`, `Include Season Pack Subtitles`, `Hide SDH/HI subtitles`, `ASS/SSA Passthrough`, and `Force SRT output` in that order, and the main `Other Settings` card now places `ASS/SSA Passthrough` directly below `Hide SDH/HI subtitles` to keep both layouts aligned.

- **Fixed the Configure instructions modal shipping incomplete rewritten copy in v1.4.79:** the new theme-aware Configure instructions modal already had the styling hook and locale key for its intro copy, but the intro paragraph was never rendered and the shipped `en`, `es`, `pt-br`, `pt-pt`, and `ar` locale bundles all left `config.overlays.instructions.intro` blank. The modal now renders that intro, shows the missing `Translation timing` heading, and all supported UI locales ship the missing copy.

- **Fixed the Configure instructions modal overflowing off-screen on mobile:** the rewritten popup could size itself against unstable small-screen viewport height and keep too much internal spacing, which let the dialog extend past the visible viewport and hide the close button on phones. The mobile modal overlay now respects safe-area padding, uses a dynamic viewport height cap where available, aligns the dialog from the top on narrow screens, and trims the mobile header/content spacing so the instructions stay fully reachable and scroll correctly.

## SubMaker v1.4.79

**Improvements:**

- **Reworked SubMaker instructions in both Quick Setup and Configure:** Step 4 in Quick Setup now includes a dedicated `SubMaker instructions` link with its own nested popup layered above the wizard, explaining how `Make [Target Language]` lists work, why a single source language is usually best, and when to reload a subtitle after starting translation. The main Configure instructions modal was also rewritten around the same source-order/sync guidance and restyled with a theme-aware hero/card layout for light, dark, and blackhole themes. All supported UI locales were updated with the new copy.

**Bug Fixes:**

- **Fixed SCS subtitle IDs failing validation and downloads when the upstream API returned human-readable `sub.id` values:** live Stremio Community Subtitles responses expose label-like IDs with spaces, colons, or brackets that are not valid SubMaker route params and are also not the real download key. SubMaker now derives its stored `scs_...` `fileId` from the opaque token embedded in `sub.url`, wraps any unsafe upstream identifier into a route-safe base64url payload when needed, keeps legacy `comm_*` downloads working, and falls back to a future sanitized `sub.id` if SCS later normalizes that field upstream. That fixes the current validation failures without relaxing the general `fileId` contract and stays compatible with both current and future SCS payload shapes.

- **Fixed SubDL Cloudflare download blocks being misreported as API-key errors:** SubDL download failures that came back as Cloudflare challenge/block pages could previously fall through the generic `403` auth path and show users the wrong `SubDL API key error` guidance, even though the failure was on SubDL's download side. SubMaker now classifies those responses separately, shows a single `0 -> 4h` user-facing subtitle that says Cloudflare is blocking the SubDL download and to try another subtitle or later, and reuses the same copy for HTML challenge pages that arrive as invalid download bodies. SubDL ZIP downloads also now use a dedicated clean download client instead of inheriting JSON API headers from the search API client.

- **Fixed translated xEmbed embedded subtitles being served with forced `.srt` semantics even when the cached translation was preserved as ASS/SSA:** addon-path embedded translations could reassemble and persist native ASS/SSA payloads, but the translated `/xembedded/...` download route still treated them like plain SRT downloads. Translated xEmbed deliveries now use the same shared format-aware delivery path as embedded originals, preserving or converting ASS/SSA/VTT according to the active subtitle output settings and returning matching MIME types and filename extensions. The embedded translation cache now also records the actual stored translated format so future readers do not have to guess from stale source metadata.

- **Fixed Quick Setup language selection drifting from the main Configure language flow:** Quick Setup Step 4 no longer treats English as a permanently fixed source language. It now shows the current source language plus a `change` link that exits into the main `Source Languages` card with the wizard state preserved, and the wizard now persists/restores real `sourceLanguages` instead of hardcoding `eng`. Translate/Learn mode in Quick Setup now also uses the full `/api/languages/translation` target list with the shared extended-languages toggle and combined target+learn limit logic, restoring English and the regional/translation-capable languages that were missing there. Added regression coverage and finished the locale wiring for the new controls.

- **Hardened the Quick Setup restore path and instructions modal accessibility:** Quick Setup now clamps restored `sourceLanguages`, fetch selections, and combined target/learn selections back to the same server-driven limits enforced in the main Configure flow, so older or hand-edited configs cannot reopen with invalid over-limit language state and get re-saved unchanged. The nested Quick Setup instructions popup now traps `Tab` focus correctly, and the main Configure instructions popup close control is now a real keyboard-focusable button with localized accessibility copy.

## SubMaker v1.4.78

**Bug Fixes:**

- **Fixed delayed Config Page UI load:** `/configure` now bootstraps the current app version and language-selection limits directly into its generated HTML shell, inlines the main/footer/overlays/quick-setup partials into the first response, and loads `config.js` from that bootstrapped version instead of waiting on `/api/session-stats` before the page can initialize. That removes the late pop-in on some assets. The generated configure shell is also cached in memory.

- **Fixed misleading Gemini `429` guidance in logs and translation error subtitles:** Gemini rate-limit/usage-limit failures were still reusing the generic "wait a few minutes and try again" copy in the shared API error formatter and in the single-cue `0->4h` translation error subtitle, even though waiting often does not help when the key has simply exhausted its usage/quota. Gemini-specific `429` messaging now tells users to check API key usage/quota or use another key, the localized subtitle strings were updated to match.

- **Fixed OpenSubtitles Auth still hitting `429` on shared-IP multi-instance deployments:** the earlier distributed lock only serialized `/login`, but `/subtitles` and `/download` calls were still gated by a pod-local token bucket, so 2+ SubMaker instances behind one egress IP could still overshoot OpenSubtitles' shared `5 req/sec` cap and surface search-side `429` warnings. OpenSubtitles Auth now uses a Redis-backed cross-pod limiter for its API budget, keeps a small safety buffer at `4 req/sec` cluster-wide, falls back to the local bucket if Redis is unavailable.

- **Fixed Quick Setup using stale Gemini defaults and copy on the config page:** Quick Setup now reads the main Gemini dropdown's declared default option in `main.html` for its saved model, model-specific advanced defaults, and Step 3/summary labels instead of using separate hardcoded assumptions. Locale strings now use `{model}` placeholders, the wizard refreshes that dynamic copy after locale changes.

## SubMaker v1.4.77

**Improvements:**

- **Expanded provider connection warm-up and keep-alive coverage:** Startup connection priming now includes the OpenSubtitles Auth REST API host in addition to OpenSubtitles V3, SubDL, SubSource, Wyzie, Stremio Community Subtitles, Subs.ro, and the `dl.subdl.com` download host. OpenSubtitles Auth is warmed against its general `/api/v1` REST surface rather than `/login`, so the addon primes the real authenticated API host without burning user-auth login slots. Warm-up and keep-alive target selection now comes from one shared provider registry, so the same static hosts that are pre-warmed at startup are also the ones kept warm during idle periods instead of those two lists drifting apart over time.

- **Provider-specific connection health and agent alignment for OpenSubtitles Auth and SCS:** OpenSubtitles Auth now has its own circuit-breaker health key instead of piggybacking on OpenSubtitles V3, so auth-host health probing, success/failure accounting, and skip decisions reflect the real REST API host rather than the public V3 addon host. Stremio Community Subtitles warm-up and keep-alive probes now also use the same custom Chrome-like TLS/JA3-mimicking HTTPS agent as the runtime SCS client, which means the probes finally warm the actual socket pool and TLS fingerprint path that real SCS requests reuse instead of only touching the generic shared HTTPS agent.

**Bug Fixes:**

- **Fixed false nested-encrypted saved sessions:** Some session updates could persist already-encrypted fields back into the same token, wrapping Gemini keys, OpenSubtitles credentials, SubDL/SubSource keys, and provider API keys in a second AES layer instead of storing a single encrypted copy. On the next request, one decrypt pass still left those values looking like `1:iv:tag:ciphertext`, which made config normalization misclassify them as undecryptable, clear Gemini keys, fall back from OpenSubtitles Auth to V3, and log misleading "encryption key mismatch" warnings even though the token and encryption key had not changed. Sensitive inputs are now normalized before session saves so encrypted-looking values are unwrapped first, read-time decryption now unwraps nested layers with the current key, healed sessions update their stored fingerprint/integrity to the recovered plaintext config, and cache-hit/preloaded sessions now persist that repair immediately.

- **Fixed anime season resolution being lost for MyAnimeList and related anime IDs:** The anime resolver could collapse different Stremio/TVDB and TMDB season numbers into one field, which made seasonless anime episode IDs search the wrong season in some cases, such as `mal:57658:10` for Jujutsu Kaisen's third season resolving like season 1. Anime ID resolution now preserves separate season hints, uses the Stremio-facing season for normal subtitle matching, and still keeps TMDB-specific season data available for TMDB-native providers.

- **Fixed anime TMDB season fallback drifting across IMDb-only and TMDB-native providers:** Some season-specific anime rows only exposed `tmdb:` data even though the shared TVDB show still pointed to a usable IMDb mapping, which could block IMDb-only providers entirely. The resolver now backfills that shared IMDb mapping when it is unambiguous, while Wyzie and Subs.ro start with the Stremio-facing season and only fall back to TMDB-specific numbering when a TMDB-native lookup would otherwise return nothing. That keeps season-specific TMDB/TVDB hints available without causing wrong-season regressions.

- **Fixed malformed supported-prefix IDs being accepted too far into the pipeline:** Requests like empty/non-numeric anime IDs or non-numeric `tmdb:` IDs could still pass the prefix-level support check and only fail later in inconsistent ways. The Stremio ID parser and route validation now require structurally valid numeric IDs for supported prefixed formats, so malformed `mal:`/`tmdb:`/related anime IDs are rejected cleanly with validation errors instead of reaching lookup/render paths.

- **Fixed explicit wrong-season anime matches surviving provider-side filtering:** OpenSubtitles V3, OpenSubtitles Auth, SubSource, and Subs.ro now reject filenames that explicitly point to a different season/episode before anime episode-only heuristics can keep them. The shared explicit-parser now also catches common anime naming forms such as `S3 - 03`, `3rd Season - 10`, `Season 3 - 10`, and mixed alias strings like `... S3E10 / ... S01E57`, which reduces wrong-season subtitle leaks without falsely dropping entries that still contain a correct explicit alias for the requested episode.

- **Fixed colliding anime TVDB IDs inheriting arbitrary mappings:** Some anime entries share the same TVDB show ID across multiple seasons, specials, or movies. Resolver collisions are now treated as ambiguous by default instead of silently inheriting the last-seen mapping, and explicit IDs in the form `tvdb:{show}:{season}:{episode}` now disambiguate correctly.

- **Fixed filename season hints not being used to rescue ambiguous anime episode IDs:** Some Stremio anime requests arrive without an explicit season in the ID even when the stream filename already contains `SxxExx`. The subtitle search flow now applies that explicit filename season hint before anime ID resolution, which lets cases like `tvdb:377543:10` plus a `S03E10` filename resolve to the correct mapped season instead of staying ambiguous or falling back to season 1 behavior.

- **Fixed the standalone `/configure` shell being version-hardcoded:** `/configure` and `/configure.html` are now rendered through a server-side generator that injects the current `package.json` version at request time, so the shell stays aligned with the live app version instead of relying on a hand-edited release artifact. Regression coverage now validates the generated output.

- **Fixed brittle large-file xSync Complete-mode extraction paths:** Complete mode now routes oversized regular MKVs through the chunked local-OPFS demux backend before targeted recovery, aligns the larger OPFS watchdog budgets across offscreen/background paths, resumes stalled full-download reads from the last committed byte, recovers from transient OPFS write failures, and skips unsupported bitmap-subtitle OCR detours with a clear `OCR extraction is not implemented yet` failure. Unknown or stale embedded extract-mode values now also normalize to `complete`, so the embedded page, content script, and background service stay aligned on the same default extraction mode.

- **Fixed Auto Subs still taking the old multi-GB memory path on large direct files:** Embedded Subtitles Complete mode had already moved to disk-backed OPFS temp-file demux, but Auto Subs could still pull full non-HLS streams back into JS memory during Cloudflare / Assembly transcription prep and fail again on `2GB+` files. The matching xSync `1.0.9` update now keeps those full-stream autosubs inputs on OPFS through background fetch planning, offscreen audio decode, and AssemblyAI full-video upload preparation, uses the dedicated FFmpeg worker for large OPFS-backed decode instead of staged MEMFS copies, and scales the longer decode watchdogs for those runs.

- **Fixed the Embedded Subtitles page ignoring the ASS/SSA passthrough setting for extracted originals:** Extracted embedded tracks were still being delivered straight from the raw extension payload, so ASS/SSA originals could stay raw even when the main config page was set to convert them for delivery. The embedded page now prepares extracted originals through the same config-aware delivery path used by xEmbed originals: when `ASS/SSA Passthrough` is enabled, extracted ASS/SSA files are delivered as-is for both page downloads and xEmbed original delivery; when it is disabled, those same extracted originals are converted to SRT before delivery. Raw originals are still kept internally with format metadata so later xEmbed/original requests and translate-first flows follow the same delivery rule instead of drifting depending on which action happened first.

- **Fixed embedded translation history seeding the linked stream `videoId` with the embedded `videoHash` instead of the real Stremio video ID:** Embedded translations previously wrote history entries with `videoId = videoHash`, which made later metadata enrichment unable to resolve the actual movie or episode title and could leave embedded history cards stuck on weak track labels. The embedded page now forwards the linked stream `videoId` and filename when saving/extracting/translating tracks, embedded history now stores the real linked stream identity when available, and added regression coverage locks that request shape in place.

- **Fixed embedded-subtitles and auto-subs pages translation settings drifting from the main workflow:** `/embedded-subtitles` and `/auto-subtitles` now expose the same provider, workflow, batching, and batch-context controls as the other translation pages, and their APIs now apply those options instead of falling back to legacy timestamp-only behavior.

- **Removed the dormant `/translate-selector` helper route and its dead HTML subtitle picker:** nothing in the addon linked to it, and normal `Make ...` subtitle entries have always pointed directly to `/translate/{sourceFileId}/{targetLang}`. The unused route, its dedicated source-subtitle search helper, validation schema, HTML generator, error handler, and selector-only locale strings are gone, while the useful regression coverage for season-pack filtering, deduplication, ranking, per-language caps, and orchestration timeout behavior now stays on the live normal subtitle fetch route.

**Notes:**

- **Seasonless anime `tvdb:` episode IDs can still be ambiguous when no season signal exists:** When upstream TVDB data reuses one show ID for multiple seasons or specials, `tvdb:{show}:{episode}` does not always identify a single canonical season. If the request also carries a filename with an explicit `SxxExx`, SubMaker can now use that as a disambiguation hint, but otherwise explicit `tvdb:{show}:{season}:{episode}` IDs are still required.

- **`tmdb:` TV episode support is still provider-dependent:** TMDB-native providers such as Wyzie work correctly with `tmdb:` TV episode IDs, but IMDb-only providers can still miss some TMDB TV requests when TMDB-to-IMDb fallback metadata is incomplete upstream.

## SubMaker v1.4.76

**Bug Fixes:**

- **Fixed new Token Vault miscounting live profiles and stranding older tokens:** Browsers that already had a live config token before the new Vault UI shipped could show `0/5` even with a real profile loaded, because the page tracked the active token separately from the new browser-local vault store and never backfilled it into the local profile list on load/refresh. That also meant `Add new profile` or switching to another profile could detach the page from the live token, clear its local pointer, and make the old profile appear gone even though the server session still existed. The config page now counts the current live profile correctly, backfills active tokens into the local vault when it is safe, preserves the current profile before opening a fresh draft or switching away from it, includes detached live profiles in full-vault exports, and hides Vault actions like local `Forget` when the token was never actually saved into the browser vault.

- **Fixed the Token Vault manager getting stuck on the old Disable button state for the live profile:** Disabling or re-enabling the token that is currently loaded on the page already worked on the backend, but the Profile Manager modal only refreshed the rail/launcher state and skipped re-rendering the manager view itself. That left the hero action button orange and labeled `Disable token` even after the session had already flipped to disabled, and it could also leave the route-state copy/actions stale until the modal was reopened. Active session context changes now re-sync the full Token Vault UI so the manager, rail, and related profile surfaces stay in step after live token state changes.

- **Fixed Docker deployments shipping without the in-app changelog file:** .dockerignore was excluding all Markdown files except README.md, which stripped CHANGELOG.md from the official image even though /api/changelog reads it from /app/CHANGELOG.md. Docker builds now keep CHANGELOG.md in the image, and the changelog loader now falls back to a small release-note stub that points users to the GitHub release page if the file is missing or malformed, instead of leaving the "What's New" panel blank.

- **Fixed the Embedded Subtitles page getting stuck on "Waiting for extension...":** The embedded page's generated client runtime had several regexes that were escaped for server-side JS instead of the final inline browser script, which produced a browser parse error before the page could schedule its `SUBMAKER_PING` handshake. After correcting that, the same page still had an early init crash because linked-stream metadata rendering called an undefined `cleanDisplayNameClient()` helper before the ping bootstrap ran. The embedded runtime now escapes its `vtt`/`ssa`/`ass`/`srt` format-detection and MIME-filter regexes correctly for generated client code, restores the missing display-name helper, and includes regression coverage so the inline scripts compile cleanly and extension detection can initialize again.

- **Fixed cache-buster drift and redirect-prone shared assets across the tool, SMDB, Sync, and Configure pages:** `sub-toolbox`, `file-upload`, `auto-subtitles`, `sub-history`, `smdb`, and `subtitle-sync` were still emitting some shared UI assets (`sw-register.js`, `theme-toggle.js`, `subtitle-menu.js`, `combobox.css`, `combobox.js`, and toolbox favicons) without the `_cb` cache-buster query that the middleware expects. Most of those pages still appeared to work because the browser followed the resulting `307` redirects, but they were paying extra asset hops on every load and relying on redirect behavior for core JS/CSS. The remaining real runtime failure on the earlier pass was on `/sub-history`: `public/js/sw-register.js` still tried to register `/sw.js` without `_cb`, and browsers reject redirected service-worker scripts, so the page logged `The script resource is behind a redirect, which is disallowed.` and skipped service-worker registration on that load. The standalone `/configure` shell also still hard-coded `1.4.16` asset cache-busters after the app had moved to `1.4.76`, so browsers could stay pinned to stale immutable CSS/JS, and `sw-register.js` had to fall back to `window.__APP_VERSION__ === undefined` there. Tool, history, SMDB, and sync page generators now emit direct cache-busted asset URLs, `sw-register.js` registers `/sw.js?...&_cb=...` directly, the configure page now bootstraps the current app version and matching `_cb` tags again, and added regression coverage now compiles the affected standalone-page runtimes and asserts those cache-busted URLs stay direct and version-aligned.

## SubMaker v1.4.75

**New Features:**

- **Token Vault profile manager on the config page:** Saved session tokens now work like browser-local profiles instead of loose strings. The new floating Vault opens both a quick-switch rail and a full profile manager where you can keep up to 5 profiles, rename them, switch away from dirty drafts with save/discard prompts, and see clear states like live, draft, recovered, or disabled. Profiles can be enabled or disabled, copied as manifest/config links, installed in Stremio, opened in History or Sub Toolbox, validated, and imported/exported as raw tokens, URLs, single-profile JSON, or full-vault backups. If the vault is full, SubMaker previews which oldest local profile will be replaced before anything is removed.

**Improvements:**

- **Refreshed bundled anime ID mappings:** Updated the built-in anime ID database with newer IMDb, TMDB, TVDB, and season matches. `animeIdResolver` now also understands the newer upstream `season` format and skips known placeholder target-ID pairs, which makes offline anime matching more reliable.

**Bug Fixes:**

- **Fixed the config-page "Reset settings to default" flow:** Reset now clears browser/site data for that SubMaker page, including saved Vault entries, Quick Setup progress, preferences, cookies, service workers, Cache Storage, and IndexedDB, then reloads `/configure` as a fresh blank draft instead of dropping you into another saved profile. The warning text was also rewritten and localized to explain what is cleared, what returns to defaults, and what is **not** deleted: server-side tokens/profiles still exist and can be reopened later if you still have their token URL.

- **Fixed the config page instructions modal "Don't show this again":** SubMaker now uses one saved preference for this, migrates older values forward, updates it whether you check or uncheck the box, keeps the checkbox in sync when reopening the modal, and no longer lets app updates or cache migrations silently turn the popup back on.

- **Fixed ASS/SSA subtitle files from archive packs turning into `WEBVTT undefined` or empty output after extraction:** Some fansub files include blank lines inside the `[Events]` section, which made the converter stop reading dialogue too early and sometimes accept garbage output. SubMaker now cleans those lines first, validates converted VTT output before accepting it, falls back to safer recovery paths when needed, and rejects cue-id-only or otherwise malformed output. Successful ASS/VTT-to-SRT conversions are also validated and renumbered before translation, so broken cue numbering from third-party tools does not leak through.

- **Fixed SubDL episode searches keeping multi-episode packs that do not contain the requested episode:** Full-season packs are still kept, but explicit ranges like episodes 5-7 are now filtered out when the user asked for a different episode. That stops obviously wrong packs from surviving until a later "episode not found in this subtitle pack" failure.

- **Fixed Gemini model selection disappearing on the config page after reloads, migrations, and Quick Setup handoffs:** The base Gemini dropdown could be filled with backend-only alias values such as `gemini-flash-latest` that the UI does not list, which made the selector look blank. SubMaker now normalizes those values to the first visible dropdown option during page load, migrations, and Quick Setup, and aligns Quick Setup's Gemini defaults with that same visible model so it no longer saves mismatched advanced defaults.

- **Separated the main Gemini model from the advanced Gemini override across translation runs:** Advanced settings could overwrite the saved base Gemini model, mixing up the two selectors and feeding unsupported values back into the config page. SubMaker now keeps the main saved model unchanged, uses the advanced model only as a runtime override when explicitly enabled, and applies that same effective runtime model consistently across validation, history/cache metadata, toolbox/file-upload bootstrap data, and request handling.

- **Fixed provider search timeout drifting away from the subtitle timeout shown in settings:** Provider searches now follow the timeout you set in SubMaker instead of a separate hidden `PROVIDER_SEARCH_TIMEOUT_MS` override being able to wait longer or cut off sooner.

- **Fixed unsupported Stremio ID requests being filtered client-side before SubMaker could log them:** Unsupported or malformed IDs now reach SubMaker, get logged with the rejection reason, and return an empty subtitle list instead of disappearing before the server sees them. That gives consistent behavior and server-side visibility when Stremio sends something unsupported.

- **Improved subtitle matching for query-style subtitle requests that already reach SubMaker:** Some Stremio clients send subtitle details in the URL query string instead of the path format the addon SDK expects. SubMaker now rewrites those subtitle requests into the SDK-compatible form before routing, keeps unrelated query params, and logs when the normalization happens so request-shape issues are easier to spot.

- **Fixed weaker subtitle searches polluting stronger retries for the same title/episode:** Cache keys did not include stream details like filename, video hash, or video size, so a weak first request could be reused for a later better-informed one. Search keys now include normalized stream context, keeping low-information searches separate from stronger stream-aware retries.

- **Fixed Sub Toolbox embedded-track language resolution preferring stale guesses over trusted xSync/container metadata:** The toolbox now keeps richer xSync language fields, resolves track language using source-aware priority, and uses that same logic when saving embedded originals to xEmbed. That keeps stronger metadata in charge and improves exact/regional tag handling such as `pt-BR`, `pt-PT`, `es-419`, `zh-Hans`, and `zh-Hant`.

- **Fixed xEmbed, xSync, and AUTO entries disappearing after switching streams and coming back:** Local subtitle lookups used to rebuild from one fresh request hash, so missing or changed filename data could hide cached local entries when you returned to a stream. SubMaker now checks an ordered set of stronger hash candidates built from the current request, remembered stream activity, and persisted hash links, so those local entries survive stream switching more reliably.

- **Fixed xEmbed saves/translations not always showing up on the next subtitle refresh:** Saving embedded originals or creating xEmbed translations now invalidates stale cached subtitle lists immediately by bumping the per-user subtitle-search revision, so new xEmbed entries show up on the next refresh instead of waiting for unrelated cache churn.

- **Fixed xSync Complete extraction failing too easily on brief stream read errors and flooding the live log with FFmpeg noise:** Full-download mode now retries transient read failures up to 3 times, resumes with HTTP Range requests instead of restarting from zero, and still rejects clearly truncated or broken subtitle output. The live log also suppresses repetitive FFmpeg banner/metadata noise so real failures are easier to spot.

- **Hardened local hash recovery so weak videoId-only fallback hashes do not permanently link unrelated releases:** The videoId-only fallback is still used as a last-resort direct lookup, but it is no longer the main local subtitle hash and is no longer saved into the shared hash-link graph. That preserves SMDB plus local xEmbed/xSync/AUTO recovery while reducing cross-release mix-ups between different files for the same movie or episode.

## SubMaker v1.4.74

**Bug Fixes:**

- **Fixed config saves minting unintended fresh sessions after transient update failures:** The config page previously fell back to creating a brand-new session on generic update errors or network failures, which could strand users on a fresh empty state and make history/session-backed data appear lost. Save now preserves the current token and asks the user to retry when session storage returns `503`, when update requests fail, or when the network flakes out, instead of silently generating a replacement session. Added regression coverage for the new stable history identity and the empty-history no-scan path.

- **Fixed translation history disappearing after saving settings:** History identity was effectively tied to the recomputed config hash, so saving settings over the same session token could still move the user onto a different empty history namespace and make all prior cards appear to vanish. Sessions now persist a dedicated stable history user hash derived from the session token, and history reads/writes now prefer that stable session-scoped namespace instead of relying on the mutable config hash. Added a one-time legacy bridge on the history page so existing config-hash-based history is copied into the stable namespace when detected, preserving older entries after the upgrade.

- **Fixed empty translation history pages still taking 20s+ on large Redis deployments:** The `/sub-history` route could still fall back to the legacy per-user Redis `SCAN` recovery path when both the aggregated history store key and the sorted-set index were missing, so a user with no history could still pay the cost of walking a large shared Redis keyspace. Added a session-scoped fast path that skips the slow scan for modern empty history namespaces, so truly empty first-load history pages now return immediately instead of stalling on Redis keyspace scans. Also added stale-index cleanup during indexed reads so expired history entry IDs are pruned from the Redis zset instead of causing repeated dead lookups on later page loads.

- **Fixed the history page still feeling dead while stale Redis reads were in progress:** `/sub-history` no longer blocks first paint on the bounded stale-path history lookup. The route now returns the page shell immediately, shows a dedicated loading state, and fetches the history list asynchronously from a separate endpoint so the page stays responsive even when Redis is slow. Added an inline retry state for fragment-load failures instead of dumping the user onto a blank error page.

- **Extended the history fast-path freshness window from 15s to 60s:** The aggregated history store key is now trusted for 1 minute before the page falls back to the bounded Redis index refresh path. This keeps hot history pages on the cheap single-GET path longer and reduces how often users hit the slower indexed recovery path on busy public deployments.

## SubMaker v1.4.73

**Improvements:**

- **Docker timezone support for localized log timestamps:** The Docker image now installs `tzdata`, allowing the full IANA timezone database to be used inside the container instead of being limited to UTC. Added `TZ` configuration guidance to `.env.example` plus both compose files, and updated `docker-entrypoint.sh` to apply `/etc/localtime` and `/etc/timezone` automatically when `TZ` points to a valid zoneinfo entry.

- **Backward-compatible timezone-aware logger:** Application log timestamps are no longer hard-coded to UTC when `TZ` is configured. The logger now preserves the existing `toISOString()` UTC output when `TZ` is unset or invalid, but switches to local ISO-8601 timestamps with an explicit UTC offset when a valid timezone is provided. Added regression coverage for UTC fallback, valid named zones, and non-hour offsets such as `Asia/Kathmandu`.

**Bug Fixes:**

- **Fixed blackhole theme on Sub Toolbox pages, duplicate-looking theme toggle states, and theme persistence drift across pages:** The app had split third-theme identifiers (`blackhole` on config surfaces vs `true-dark` on most toolbox/tool pages), so selecting the third theme on the config page could make toolbox pages fall back to their default styling and make the toggle look like it had "light" twice. Theme handling is now unified so manual theme choices persist across the config page, Sub Toolbox, individual tool pages, SMDB, translation history, and the subtitle selection page, while each page still maps the shared saved preference to the theme token its CSS expects. Added legacy compatibility for older saved `true-dark` values, removed the last page-local toggle implementation that could drift from the shared logic, and fixed Quick Setup's config-page blackhole styling so its overlay/banner now match the active third theme correctly. Also stopped the shared toggle from writing a theme preference on first load when the user has not explicitly chosen one, so system theme following still works until a real manual selection is made.

- **Fixed translation history page stale-load latency and removed broad Redis history scans from the normal stale path:** The `/sub-history` page already had a fast-path aggregated store key, but once that cache aged past 15 seconds it fell back to scanning history entry keys and re-reading them one by one. On larger Redis datasets this still made stale page loads feel heavier than they should. Added a per-user Redis sorted-set history index (`histidx__{userHash}`) that is updated alongside each history entry write. History reads now use this bounded recent-entry index when the store key is stale, and only fall back to the legacy SCAN-based recovery path if no index exists yet. This keeps normal history-page work to a small, fixed set of recent entries instead of walking the broader history keyspace.

- **Fixed History-page Retranslate not actually starting a new translation or creating a visible new history card:** The old `/api/retranslate` route only purged cache and returned a translation URL, but the history page never navigated to that URL, so clicking `Retranslate` often did nothing user-visible and did not create a fresh history entry. The route now validates concurrency correctly, purges stale cache if present, creates a brand new `processing` history entry immediately, and then starts a fresh background translation using the same history request ID so the entry is later updated to `completed` or `failed` instead of disappearing. The History page button now sends the card metadata the backend needs, reloads the page after a successful start so the new card appears right away, and all retranslate copy/tooltips/messages were updated to describe the real behavior (`Start a fresh translation`) instead of the confusing old `Cache cleared` wording. Also fixed an async safety bug where cache-reset/retranslate concurrency checks called `canUserStartTranslation()` without `await`, weakening those guards.

- **Fixed backend/default workflow mismatch so XML Tags is now the true default everywhere:** The frontend already defaulted to `translationWorkflow: 'xml'`, but backend config loading still defaulted to `'original'`, and the `TranslationEngine` constructor also fell back to `'original'` when the workflow was missing or invalid. This created an inconsistent default depending on whether a request used saved config, normalized config, or direct engine construction. Updated both `getDefaultConfig()` and `normalizeConfig()` in `src/utils/config.js`, plus the engine-level fallback in `src/services/translationEngine.js`, so XML Tags is now the consistent default across addon translations, file upload defaults, and engine initialization.

- **Fixed ASS/SSA + "Send Timestamps to AI" dropping AI-adjusted timings during ASS reassembly:** The ASS-aware translation path previously rebuilt every `Dialogue:` line with the original ASS start/end times, even when the `ai` workflow returned corrected SRT timecodes. `reassembleASS()` now parses translated SRT timeranges and writes the translated start/end times back into the ASS `Start` and `End` fields while preserving original spacing and document structure. This restores the intended timing behavior of the `ai` workflow for ASS/SSA passthrough translations instead of silently degrading it to text-only reassembly.

- **Fixed ASS/SSA helper position mapping around `\N`, `\n`, and `\h`, and preserved drawing-mode payloads correctly:** The original helper recorded tag positions before normalizing ASS escape sequences, which could shift tags after translation when earlier line breaks or hard spaces were present. It also treated drawing-mode (`\p`) vector payloads as ordinary translatable text. Reworked `assTranslationHelper.js` so it extracts normalized clean text and a unified list of preserved raw ASS segments, including override tags and drawing payloads, using positions based on the normalized text stream. Re-insertion now maps those preserved segments proportionally back into the translated line, keeping drawing commands intact and out of the translation request while avoiding post-`\N` tag drift.

- **Fixed weak ASS/SSA detection in the make-translation route:** The addon translation path used an inline case-sensitive content check for `[Script Info]` plus `[V4+ Styles]` / `[V4 Styles]`, which missed valid lowercase or variant ASS/SSA payloads. Replaced that check with the shared `detectASSFormat()` utility from `src/utils/subtitle.js`, so the ASS-aware wrapper path now reliably activates for both ASS and SSA inputs that the rest of the codebase already recognizes.

- **Fixed stale ASS/SSA passthrough semantics and workflow copy on the main config surface:** The old config page still rendered the checkbox as "Convert ASS/SSA to VTT" with the box checked by default, even though the JS logic already treated checked as passthrough. Updated `public/partials/main.html` so the control is rendered as `ASS/SSA Passthrough`, unchecked by default, matching the stored config semantics (`convertAssToVtt: true` means conversion enabled; `false` means passthrough). Also updated the main-page description, the URL-extension helper text, and locale workflow copy so they no longer claim translations always auto-convert, and so workflow labels/tooltips consistently describe XML Tags as the default, Original Timestamps as legacy, and JSON as a supported workflow option.

## SubMaker v1.4.72

**New Features:**

- **Added 3 new Wyzie subtitle sources (Kitsunekko, Jimaku, YIFY):** The Wyzie API added 3 new subtitle providers — **Kitsunekko** (anime subtitles), **Jimaku** (Japanese anime subtitles), and **YIFY** (movie subtitles) — bringing the total from 6 to 9 available sources. Added the new providers across the full config stack: backend `allSources` array in `wyzieSubs.js`, config defaults and migration/backwards-compatibility fallback in `config.js`, form population and collection logic in `config.js`, new checkboxes in the main settings page (`main.html`) and Quick Setup wizard (`quick-setup.html`), and state defaults/reading/restore in `quick-setup.js`. New sources default to disabled for new users; existing Wyzie users who had sources enabled get the new providers auto-enabled via the migration fallback. All 3 providers use the same Wyzie API response format — no backend logic changes were needed.

- **"ASS/SSA Passthrough" setting exposed to all users:** The `convertAssToVtt` toggle was previously hidden. It is now always visible in the Settings section for all users, since ASS passthrough is production-ready with the new translation pipeline. Removed `display:none` from `main.html`, and removed devMode gating in `config.js` (`toggleConvertAssToVttGroup()` function and config-load visibility).

- **ASS/SSA subtitles:** ASS/SSA subtitles can now be fetched and translated while preserving their original format — styles, fonts, colors, positioning tags (`{\an8}`, `{\pos()}`, `{\b1}`, etc.), and document structure (`[Script Info]`, `[V4+ Styles]`, `[Events]`). Previously, all ASS/SSA subtitles were unconditionally converted to SRT before translation. The new pipeline uses a wrapper approach: (1) parse ASS dialogue entries, separating override tags from translatable text, (2) build a temporary SRT from the extracted clean text, (3) translate via the existing `TranslationEngine` (unchanged), (4) re-inject translated text back into the original ASS structure with tags restored at proportionally-mapped positions. New `assTranslationHelper.js` utility (~280 lines) with `parseASSForTranslation()`, `buildSRTFromASSDialogue()`, and `reassembleASS()` functions. Modified `subtitles.js` to pass `skipAssConversion` to all 14 provider download calls in both pre-flight and main translation paths, detect ASS format via content inspection (`[Script Info]` + `[V4+ Styles]`), conditionally bypass `ensureSRTForTranslation()`, and reassemble ASS after translation completes. Added `_ass` cache key variant in `cacheKeys.js` to prevent format collisions between ASS and SRT translations in the permanent (shared) cache. Updated `index.js` translation route to detect payload format via `detectSubtitlePayloadFormat()` and serve correct `Content-Type` (`text/x-ssa`) and file extension (`.ass`/`.ssa`) in all 3 response paths (bypass cache, permanent cache, main response). Learn Mode compatibility preserved: translated ASS content is converted to SRT via `ensureSRTForTranslation()` before `srtPairToWebVTT()` pairing.

- **ASS/SSA format-aware subtitle file selection in archives:** `findSubtitleFile` in `archiveExtractor.js` now respects the ASS passthrough setting when selecting subtitle files from archives. When `skipAssConversion` is enabled, the function prioritizes ASS/SSA files over SRT files (using a `primaryFiles`/`secondaryFiles` abstraction) for both season-pack episode matching (anime + TV patterns) and single-file selection. Previously, the function always searched SRT files first regardless of passthrough setting — ASS files were only found via the all-entries fallback, which worked by accident but would select an SRT file over an ASS file when both existed in the same archive.

- **Automatic URL extension enforcement for ASS passthrough:** When ASS passthrough is enabled (`convertAssToVtt: false`), the addon now automatically forces `urlExtensionTest` to `'none'` (no file extension in subtitle URLs). Previously, subtitle URLs were built with a `.srt` extension by default, causing an extension/payload mismatch when the actual content was ASS/SSA — Stremio would request a `.srt` URL but receive ASS content. The enforcement is applied in three places: backend config normalization (`src/utils/config.js`), frontend `collectConfig()` (`public/config.js`), and the existing URL builder in the subtitle handler (`subtitles.js:2860-2862`) already handles the `'none'` value correctly by setting both `urlExtension` and `translationUrlExtension` to empty strings. The serving route at `index.js` detects the payload format dynamically and sets the correct `Content-Type` header (`text/x-ssa; charset=utf-8`) regardless of URL extension.

PS: Partial delivery during translation remains SRT (from the translation engine), with final ASS reassembly applied only to the completed output. Activated by unchecking "Convert ASS/SSA to VTT" in settings — when disabled and the source is ASS/SSA, the translation pipeline automatically uses the new ASS-aware path.

**Bug Fixes:**

- **Fixed phantom "New stream detected" notifications for streams watched hours/days ago:** The stream activity LRU cache had `updateAgeOnGet: true`, which reset the 6-hour TTL on every SSE connect, heartbeat, or page refresh — old entries essentially never expired as long as a toolbox tab was open. When opening a new toolbox/SMDB page, `subscribe()` would immediately send the cached entry as an `episode` event, triggering a toast for a stream that was watched days ago. Removed `updateAgeOnGet` so entries actually expire after 6 hours. Added a `firstSeenAt` timestamp to stream activity entries (preserved across heartbeat/enrichment updates) so clients can distinguish "stream started 3 hours ago" from "entry refreshed 10 seconds ago." Added a 30-minute age check (configurable via `STREAM_ACTIVITY_SNAPSHOT_MAX_AGE_MS`) in `subscribe()` that suppresses stale cached entries from being sent to new SSE subscribers. Added a matching client-side staleness guard in `quickNav.js` that checks `firstSeenAt` against `window.__SUBMAKER_PAGE_LOAD_TIME` before showing a toast, catching stale data from the polling fallback path that bypasses the server-side SSE check.

- **Fixed ghost linked streams with non-matching hashes on the same title:** When Stremio sent multiple subtitle requests for the same `videoId` with slightly different filenames (different stream sources, URL encoding differences, different addons), `deriveVideoHash()` produced different MD5 hashes, and the merge logic in `recordStreamActivity()` allowed the hash to flip — triggering a "new stream" notification for what was really the same stream with a mangled hash. Strengthened the hash drift guard: when the previous entry already has an authoritative filename+hash pair for the same `videoId`, the incoming hash is rejected regardless of whether the incoming payload has a filename or not. Additionally, notifications now only fire when the `videoId` actually changes — field enrichment for the same `videoId` (e.g., empty hash → real hash) is stored silently without broadcasting. The SMDB page's `handleStreamLinked()` also gained a duplicate-videoId guard and uses `firstSeenAt` for its staleness check. The `_handleRemoteStreamEvent` Redis pub/sub handler now applies the same change-detection guards instead of blindly setting LRU entries and notifying listeners.

- **Fixed Google Translate failing on larger subtitle files:** The `GoogleTranslateProvider.callTranslate()` method used `axios.get()` with `params`, placing the entire joined subtitle text into the URL query string. Google's endpoint returns HTTP 400 (Bad Request) when the URL-encoded payload exceeds ~15K characters, which commonly happens with batches of 300+ subtitle entries. Switched `callTranslate()` from GET to POST with `application/x-www-form-urlencoded` body, eliminating the URL length ceiling entirely. Additionally, added internal chunking (`chunkTexts()` + `_translateChunked()`) that splits large payloads into ~6K-character chunks at entry boundaries when the joined text exceeds `MAX_CHARS_PER_REQUEST`. Each chunk is translated in a separate sequential API call and results are reassembled in correct order. A graceful fallback (`_isPayloadTooLargeError()`) detects 400/413/414 status codes and automatically switches from single-request to chunked mode, providing resilience even if Google changes their exact limit. All changes are self-contained in `googleTranslate.js` — no modifications needed to the `TranslationEngine` or handler code. The fix applies regardless of whether Google Translate is configured as the main or secondary/fallback provider, since all code paths call `GoogleTranslateProvider.translateSubtitle()`.

**xSync Extension:**

- **OPFS-based stream download for large files (fixes "Array buffer allocation failed"):** The xSync extension previously pre-allocated a single `Uint8Array(totalBytes)` in RAM when downloading full streams in Complete mode — any file exceeding the browser's ~2-4 GB memory ceiling would crash with "Array buffer allocation failed." Added a new `fetchFullStreamBufferOPFS()` function that streams download chunks directly to the Origin Private File System (OPFS) via `FileSystemWritableFileStream`, avoiding the upfront memory allocation entirely. After download completes, the file is read back as an `ArrayBuffer` using the browser's memory-mapped file I/O (significantly more efficient than pre-allocating a contiguous buffer). A `fetchFullStream()` dispatcher reads the user's preferred mode and delegates to either the OPFS or legacy RAM path. If OPFS is unavailable (e.g. older browser), it silently falls back to RAM. All 5 call sites across embedded-subs extraction (`extractEmbeddedSubtitles`), autosync audio extraction (`extractAudioFromStream` — 3 sites), and Assembly AI autosubs (`handleAssemblyAutoSubRequest`) now route through the dispatcher. Return shape is unchanged (`{ buffer, totalBytes, contentType }`), so all downstream consumers (FFmpeg offscreen page, subtitle extraction, audio decoding) work without modification.

- **Stream Buffer Mode setting:** Added a new "Stream Buffer Mode" dropdown to the xSync options page (General → Global Behaviour section) with two options: **Disk (default)** — uses OPFS, safe for large files; **RAM** — legacy in-memory path, faster but may crash on files >2 GB. The setting is stored in `chrome.storage.sync` under `xsync-settings` and read by the background service worker before each full-stream download. Default is Disk for safety.

- **Fixed FFmpeg subtitle extraction silently doing nothing (bare core no-op):** The offscreen FFmpeg bare core's `run()` function checked for `module.exec` then `module.callMain` to invoke FFmpeg, but `ffmpeg-core.js` exports neither symbol. The fallthrough `?: 0` silently returned success without ever executing FFmpeg, causing all subtitle extractions via the bare core path to report "No subtitle streams found" regardless of whether the file contained subtitles. Combined with `forceBareCore = true` (which bypassed the working ffmpeg.wasm wrapper), the offscreen demux path was completely broken. Fixed by setting `forceBareCore = false` to restore the ffmpeg.wasm wrapper path, and replaced the silent fallthrough with an explicit `throw` so a missing entry point is immediately surfaced as an error. Applied the same safety fix to `background.full.js`.

## SubMaker v1.4.71

**Improvements:**

- **Translation history page now loads instantly:** The `/sub-history` page previously blocked on a sequential enrichment loop that called external APIs (Cinemeta/Kitsu, 7.5s timeout each) and performed 3 Redis round-trips per entry — all before sending any HTML. With 20 history entries this could take 4–20+ seconds. The page now renders immediately after fetching history data, with enrichment running in the background (fire-and-forget after `res.send()`). Missing titles are resolved in parallel via `Promise.allSettled` and storage writes are batched into a single store-key update instead of per-entry read-modify-write cycles. Entries that already have titles (the common case — titles are resolved at translation time) display normally; entries still showing "unknown" are enriched in the background for the next page load.

## SubMaker v1.4.70

**Improvements:**

- **Added Gemini 3.1 Flash Lite as the new default translation model:** Added `gemini-3.1-flash-lite` ("Gemini 3.1 Flash Lite") to the model dropdown in the config page and set as default.

- **Switched all hardcoded model fallbacks to `gemini-flash-latest` alias:** All `|| 'fallback'` patterns across the codebase — `GeminiService` constructor, `normalizeConfig()`, `getDefaultConfig()`, `ensureAutoSubsDefaults()`, `areAdvancedSettingsModified()`, `loadSettings()`, `collectConfig()`, and Quick Setup `buildConfigObject()` — now use `gemini-flash-latest` instead of a pinned model version. This `-latest` alias always resolves server-side to Google's current Flash model, making fallbacks future-proof without code changes when new model versions are released.

- **Full localization of the Quick Setup wizard:** Translated the entire Quick Setup wizard into all 5 supported locales (English, Spanish, Brazilian Portuguese, European Portuguese, and Arabic). Added 123 translation keys per locale under `config.quickSetup` covering all 7 wizard steps — mode selection, subtitle sources, AI translation, language selection, extras, learn language selection, and summary/install — plus navigation, validation messages, and status indicators.

- **Quick Setup no longer enables Single Batch Mode by default:** The `buildConfigObject()` in the Quick Setup wizard previously set `singleBatchMode: true`, causing new users to start with single-batch translation enabled. Changed the default to `false` so new setups use the standard multi-batch translation mode.

**Bug Fixes:**

- **Fixed "Too many session creation requests" error after ~10 config saves:** The `/api/update-session/:token` endpoint was incorrectly using `sessionCreationLimiter` (10/hour, IP-based) — the same strict rate limiter meant only for new session creation. Every config save (even updates to an existing session) counted against the 10/hour creation quota, locking users out with a 429 error after approximately 10 saves in an hour. Created a separate `sessionUpdateLimiter` (60/hour) with its own Redis key prefix (`rl:sessupdate:`) for the update endpoint.

## SubMaker v1.4.69

**Improvements:**

- **Expanded SubDL and SubSource language normalization to cover 70+ previously unrecognized API response names:** Both providers' `normalizeLanguageCode()` functions now map all language names returned by their APIs back to ISO-639-2 codes, ensuring no valid subtitle results are silently filtered out. **SubDL** (20 languages added): the API returns names like `farsi_persian`, `Azerbaijani`, `Bosnian`, `Burmese`, `Esperanto`, `Georgian`, `Greenlandic`, `Icelandic`, `Kurdish`, `Macedonian`, `Malayalam`, `Manipuri`, `Sinhala`, `Tagalog`, `Tamil`, `Telugu`, `Urdu`, and the typo `Ukranian` — all now mapped. **SubSource** (51 languages added): the API returns names with typos (`Espranto`, `Gaelician`, `Northen Sami`, `Santli`, `Brazillian Portuguese`), compound formats (`Farsi/Persian`, `Chinese (Cantonese)`, `Chinese Bilingual`, `French (Canada)`, `Spanish (Spain)`), and uncommon languages (`Montenegrin`, `Luxembourgish`, `Toki Pona`, `Sylheti`, `Tetum`) — all now mapped. Added 38 mappings to SubDL and 55 mappings to SubSource. Verified all language names from both APIs normalize correctly.

- **Changed Latin American Spanish country code normalization to correctly fetch LatAm subtitles:** All 19 LatAm country codes (`es-MX`, `es-AR`, `es-CO`, `es-CL`, `es-PE`, `es-VE`, `es-CU`, `es-PR`, `es-DO`, `es-EC`, `es-BO`, `es-UY`, `es-PY`, `es-GT`, `es-HN`, `es-SV`, `es-NI`, `es-CR`, `es-PA`) now correctly normalize to `spn` (Latin American Spanish) in `normalizeLanguageCode()` instead of `spa` (European Spanish). Previously, only `es-419` (the generic UN M.49 LatAm code) mapped to `spn`, which meant providers that distinguish LatAm vs European Spanish (SubSource: `spanish_latin_america` vs `spanish`, Wyzie: `ea` vs `es`, OpenSubtitles V3: `spn` vs `spa` filtering) never received requests for LatAm-tagged subtitles when users selected a specific LatAm country variant. The `languageEquivalents` post-fetch filter (spa↔spn) partially masked the issue by accepting cross-tagged results that happened to come back, but providers that serve different results for each code were never queried correctly. Added a `Set` of LatAm country codes in the BCP-47 handler that maps them to `spn`. `es` (generic) and `es-ES` (Spain) continue to normalize to `spa`.

- **Fixed OpenSubtitles Auth silently returning 0 results for 5 languages due to strict API code requirements:** The OpenSubtitles Auth API only accepts the exact 74 codes from its `/infos/languages` endpoint — any other code (even valid ISO-639-1) silently returns 0 results with no error. Five languages were affected: **European Portuguese** (`por` sent `pt`, API requires `pt-pt` — 0 vs 31 results), **Latin American Spanish** (`spn` sent `ea`, not in API at all — now falls back to `es`), **Chinese** (`chi` sent `zh`, API requires `zh-cn` — 0 vs 8 results), **Norwegian Bokmål** (`nob` sent `nb`, API requires `no` — 0 vs 8 results), and **Norwegian Nynorsk** (`nno` sent `nn`, API requires `no`). Added explicit mappings in `searchSubtitles()` before the generic `toISO6391()` fallback. Also added `nob`/`nno` → `NO` and `zhs`/`zht` → `ZH` to SubDL's outgoing language map to prevent similar misses. All fixes confirmed via live API testing.

- **Fixed Dari and Kurdish Sorani subtitle searches sending garbage codes to providers:** `prs` (Dari) and `ckb` (Kurdish Sorani) are in the 433-language list but had no explicit outgoing mappings in SubDL or OpenSubtitles Auth. Both fell through to fallback logic that derived nonsense codes (`PR`/`CK` for SubDL, raw 3-letter codes for OS Auth) — silently returning 0 results. Added `prs → FA` and `ckb → KU` to SubDL's outgoing map, and `prs → fa` and `ckb → ku` to OpenSubtitles Auth's special cases, mapping them to their parent languages (Persian and Kurdish) which is what providers actually index. Verified via full scan of all 433 languages — these were the only two non-extended languages with broken outgoing codes. The remaining 65 unmapped languages (Acehnese, Balinese, Cantonese, etc.) are translation-only languages with no subtitle content on any provider.

## SubMaker v1.4.68

**Bug Fixes:**

- **Fixed LLM hallucinating ASS override tags in translated SRT subtitles:** The translation model (Gemini) sometimes injected `{\an8}` and other ASS/SSA positioning tags into translated subtitle text, even when the source SRT contained none. Added a post-translation cleanup step in `cleanTranslatedText()` that strips all `{\...}` ASS override tag patterns (e.g., `{\an8}`, `{\pos(x,y)}`, `{\b1}`, `{\fad(...)}`) from translated text. The regex `{\\[^}]*}` targets the unique ASS signature (opening brace + backslash) to avoid false positives on normal text.

- **Fixed Romanian (and 4 other languages) translating to Arabic instead of the correct language:** The `normalizeTargetLanguageForPrompt()` function used bare `nameKey.includes('oman')` to detect Arabic (Oman) regional variants, but `'romanian'.includes('oman')` is `true` — so Romanian, Romani, Aromanian, and Romansh all matched the Oman check and were sent to the AI as "Gulf Arabic". The same substring collision pattern affected 28 regional variant checks across Arabic, English, Korean, Serbian, Dutch, and Italian families (e.g., `'uk'` matched Sukuma/Chuukese/Inuktitut/Tumbuka/Volapük → British English; `'syria'` matched Classical Syriac → Syrian Arabic; `'south'` matched English (South Africa) → Korean). All `nameKey.includes()` checks now require the language family as a compound condition (e.g., `nameKey.includes('arabic') && nameKey.includes('oman')`), preventing cross-language false positives.

## SubMaker v1.4.67

**New Features:**

- **"What's New" changelog portal on the config page:** A visually immersive "portal" at the top of the configuration page that displays recent changelog entries. A "new" indicator dot appears when updates haven't been viewed yet, tracked via localStorage. Fully themed for light, dark, and blackhole modes. Pure CSS = zero JavaScript overhead!

**Improvements:**

- **Config page compactness overhaul:** Reduced vertical spacing across the entire config page for a more compact desktop experience. Smaller header (logo, title, subtitle), tighter section blocks and cards, smaller section/card icons (56→40px), compact toggle switches (56×32→44×24px), reduced form-group/label/input padding, smaller buttons, compact Quick Setup banner and Just Fetch Subtitles box, and tighter footer spacing. Reduced custom combobox dropdown height (~25% smaller padding, explicit 0.85rem font-size, smaller chevron and option items). Shrunk text/password input fields for API keys. Unified all Test/Load Models buttons to compact size. Moved Load Models buttons from provider title rows to sit inline next to their model dropdown selects. Styled all number inputs (temperature, top-p, retries, etc.) to match text fields — themed background, rounded borders, focus glow, hidden native spinners. Added styled chevrons to provider dropdowns.

- **Improved config page language description texts:** Updated the Source and Target language section descriptions to be clearer about how source languages relate to "Make (language)" translation lists, how original subtitles are fetched and displayed, and how target language subtitles and translation buttons work.

- **Selected languages field now only appears when populated:** The "Click languages below to add..." selected-languages container is now hidden until at least one language is selected. Applies to all language sections (Source, Target, Just-fetch, and Learn Mode).

- **Single-batch mode no longer forces bypass mode:** Users can now enable single-batch mode and independently choose whether to use the shared database or bypass mode.

- **Docker entrypoint with automatic permission fixing (su-exec):** The Dockerfile no longer sets `USER node`. Instead, the entrypoint starts as root, creates required directories (`/app/.cache`, `/app/data`, `/app/logs`, `/app/keys`), chowns them to PUID:PGID (env vars, default 1000:1000 = `node`), then drops privileges via `su-exec` before starting the app. This is the standard Docker pattern (used by postgres, redis, etc.) and handles the common case where Docker creates bind-mount directories as root on the host. Users should use `PUID`/`PGID` environment variables instead of the `user:` compose directive — the entrypoint handles everything automatically. If running as non-root (via `user:` directive), the entrypoint falls back to best-effort directory creation with actionable error messages.

- **Deterministic isolation key fallback instead of random ID:** When all methods of deriving a stable isolation key fail, the system now falls back to a deterministic hostname-based hash (`host_<hash>`) instead of a random `crypto.randomBytes` value. The previous random fallback changed on every container restart, causing the storage adapter to create a new cache directory each time — making all previously stored data unreachable.

- **Accurate storage initialization error messages:** Fixed `StorageFactory` logging "Redis storage initialization failed" when `STORAGE_TYPE=filesystem` and the filesystem adapter failed to initialize. The error message now correctly identifies the actual storage type that failed (e.g., "filesystem storage initialization failed"). The retry failure path also now logs actionable guidance about checking directory permissions when using Docker with custom UIDs.

**Bug Fixes:**

- **Fixed self-hosted addon resetting to defaults on container restart:** When using `user: ${PUID}:${PGID}` in docker-compose with bind-mounted volumes, the container process ran as a different UID than the `node` user (UID 1000) that owned the directories at build time. This caused a cascade of EACCES permission errors: (1) encryption key couldn't be saved → fail-fast throw, (2) isolation key derivation fell back to a random in-memory ID that changed on every restart, (3) filesystem storage adapter couldn't create cache directories under the random isolation prefix, (4) session loading failed → config appeared reset to defaults.

- **Fixed `syncCache.js` crashing on permission errors during legacy directory creation:** `initSyncCache()` previously threw on any `fs.mkdir` failure, including EACCES/EPERM permission errors. Since the actual sync cache operations use the storage adapter (which manages its own isolation-aware directories), the legacy `SYNC_CACHE_DIR` path is only needed for backwards compatibility. EACCES/EPERM errors are now caught and logged as warnings instead of crashing the sync cache initialization.

- **Docker permission hardening for custom UID deployments:** Added `docker-entrypoint.sh` that creates required directories (`/app/.cache`, `/app/data`, `/app/logs`, `/app/keys`) and validates write access before the application starts — printing the current UID:GID, failing path, and exact `chown` command when a directory is not writable. Data directories are set to `chmod 777` at build time so containers with arbitrary UIDs via `user: PUID:PGID` can write when using named volumes (bind mounts still depend on host permissions, validated by the entrypoint). The encryption key handler also now includes UID:GID and a `chown` command in EACCES errors, with a suggestion to use the `ENCRYPTION_KEY` env var as an alternative.

- **Deterministic isolation key fallback instead of random ID:** When all methods of deriving a stable isolation key fail, the system now falls back to a deterministic hostname-based hash (`host_<hash>`) instead of a random `crypto.randomBytes` value. The previous random fallback changed on every container restart, causing the storage adapter to create a new cache directory each time — making all previously stored data unreachable.

- **Accurate storage initialization error messages:** Fixed `StorageFactory` logging "Redis storage initialization failed" when `STORAGE_TYPE=filesystem` and the filesystem adapter failed to initialize. The error message now correctly identifies the actual storage type that failed (e.g., "filesystem storage initialization failed"). The retry failure path also now logs actionable guidance about checking directory permissions when using Docker with custom UIDs.

**Bug Fixes:**

- **Fixed self-hosted addon resetting to defaults on container restart:** When using `user: ${PUID}:${PGID}` in docker-compose with bind-mounted volumes, the container process ran as a different UID than the `node` user (UID 1000) that owned the directories at build time. This caused a cascade of EACCES permission errors: (1) encryption key couldn't be saved → fail-fast throw, (2) isolation key derivation fell back to a random in-memory ID that changed on every restart, (3) filesystem storage adapter couldn't create cache directories under the random isolation prefix, (4) session loading failed → config appeared reset to defaults.

- **Fixed `syncCache.js` crashing on permission errors during legacy directory creation:** `initSyncCache()` previously threw on any `fs.mkdir` failure, including EACCES/EPERM permission errors. Since the actual sync cache operations use the storage adapter (which manages its own isolation-aware directories), the legacy `SYNC_CACHE_DIR` path is only needed for backwards compatibility. EACCES/EPERM errors are now caught and logged as warnings instead of crashing the sync cache initialization.

- **Cross-instance rate limiting with Redis-backed store:** All 8 `express-rate-limit` instances (search, file translation, embedded translation, auto-sub, user data writes, session creation, stats, validation) now use `rate-limit-redis` with the existing ioredis client from `StorageFactory.getRedisClient()`. Previously, rate limit counters were stored in-memory per process — with 2 pods behind a load balancer, every user effectively got 2× the intended rate limit. Counters are now shared across all instances via Redis with unique key prefixes per limiter (`rl:search:`, `rl:filetrans:`, `rl:embedded:`, `rl:autosub:`, `rl:write:`, `rl:sesscreate:`, `rl:stats:`, `rl:validation:`). The `sendCommand` wrapper queues `SCRIPT LOAD` calls issued during store construction (before Redis is available) and drains them once the client connects, using a single poll timer per store instance. All limiters set `passOnStoreError: true` so the service fails open (allows requests without rate limiting) if Redis becomes unavailable, rather than returning HTTP 500. Constructor script-load Promise rejections are swallowed with `.catch()` handlers to prevent `unhandledRejection` noise during startup or in filesystem-only deployments.

- **Periodic health monitoring log:** Added a `setInterval`-based health log emitted every 5 minutes (configurable via `HEALTH_LOG_INTERVAL_MS` env var) after the startup banner. Logs a single grep-friendly line at `warn` level (visible at default production `LOG_LEVEL=warn`) with key operational metrics: heap and RSS memory usage, in-flight request count (`inFlightRequests.size`), in-flight translation count (`inFlightTranslations.size`), active session count, HTTP/HTTPS socket pool counts (`getPoolStats()`), and process uptime. Timer uses `.unref?.()` so it doesn't keep the process alive during shutdown. Example output: `[Health] heap=142.3MB rss=198.5MB inflight=3 translations=1 sessions=847 sockets=12/45 uptime=3600s`.

- **Tightened shared translation in-flight lock TTL from 30 to 15 minutes:** The cross-instance translation lock (`SHARED_TRANSLATION_LOCK_TTL_SECONDS`) defaulted to 30 minutes, but the stale-lock detection threshold is `max(10 minutes, translationTimeout)` — meaning a stale lock could sit in Redis for up to 20 minutes after the stale threshold before Redis expired it (if no new request triggered stale detection for that key). Lowered the default to 15 minutes. This is safe because: the maximum allowed `translationTimeout` is 720s (12 minutes, enforced by Joi validation), the stale detection threshold is `max(10 min, translationTimeout)` = 12 minutes, and 15 minutes exceeds both — so locks won't expire during legitimate translations, and the worst-case stale lock window is cut from 20 to 3 minutes. Still configurable via `TRANSLATION_LOCK_TTL_SECONDS` env var (minimum 60s enforced by `Math.max`).

- **Increased maximum translation timeout from 10 to 12 minutes:** Raised the maximum allowed `translationTimeout` from 600s to 720s across all validation layers (Joi schema, server-side config sanitization, frontend config sanitization, HTML input constraints, file upload page). The new default for the Gemini legacy `advancedSettings.translationTimeout` and `.env` fallback (`GEMINI_TRANSLATION_TIMEOUT`) is also 720s.

- **Comprehensive BCP-47 language code normalizer:** Rewrote and extracted `normalizeLanguageCode` into a shared utility in `src/utils/languages.js`. The old inline version only handled `base-XX` and `pt-BR` — all other BCP-47 subtags were stripped to garbage (e.g., `zh-Hant-HK` → `zhhanthk`). The new implementation properly handles script subtags (`sr-Cyrl` → `srp`, `zh-Hant` → `zht`), numeric regions (`es-419` → `spn`), multi-part tags (`zh-Hant-HK` → `zht`), variant/extension subtags, and Chinese simplified/traditional distinction. Updated `languageCodeSchema` to accept 4-letter script subtags and 3-digit numeric regions (previously rejected with HTTP 400). BCP-47 codes in `searchParams.languages` are now normalized to ISO-639-2 at both subtitle search entry points before being sent to providers — previously raw codes caused total failures on OpenSubtitles Auth, unfiltered garbage on SubSource, and partial results on SubDL/V3. Raw regional codes are preserved for translation button logic; only provider queries are normalized (e.g., `[es-MX, es-AR, eng]` → `[spa, eng]` deduplicated). Dedup cache keys also use normalized languages.

- **Per-variant translation buttons for regional language codes:** When selecting multiple regional variants as target languages (e.g., `es`, `es-MX`, `es-AR`, `es-ES`), each variant now gets its own "Make" translation button with a distinct AI translation prompt. Previously, the system normalized all variants to the same base code (e.g., `spa`) and only created a single button for whichever variant appeared first. Replaced the normalized deduplication with exact-code deduplication so each selected variant gets its own translation button (e.g., "Make Spanish", "Make Spanish (Mexico)", "Make Spanish (Argentina)"). Also added a fallback for display names when `getLanguageName` returns null for obscure codes.

- **Chinese subtitle equivalences for cross-provider compatibility:** Added Chinese equivalences to `languageEquivalents`: `chi ↔ zhs, zht, ze`. When users select `zh-CN` or `zh-TW`, the handler normalizes to `zhs`/`zht`, but OpenSubtitles V1/V3 may return subtitles tagged as `chi`, `zhs`, `zht`, or `ze` (Bilingual). Without equivalences, results from providers using different Chinese tagging conventions were silently filtered out. All Chinese variants now accept results from all providers regardless of how they tag Chinese subtitles.

- **Fixed OpenSubtitles paid accounts receiving rate-limited errors at free-tier 20/day quota:** A race condition in `isTokenExpired()` allowed tokens to pass the expiry check but expire before the actual `/download` POST request, causing the auth interceptor to silently drop the Bearer header. The API then treated the request as unauthenticated, applying the free-tier 20/day limit instead of the user's actual quota (200/day for Gold, 1000/day for VIP). Added a 60-second safety margin to `isTokenExpired()` so tokens are considered expired before they actually expire, preventing the race window.

- **Added 406 retry-with-relogin for OpenSubtitles download quota errors:** When a `/download` request fails with HTTP 406 (quota exceeded) and the user has credentials configured, the addon now forces a fresh login and retries once before propagating the error. This catches the case where a stale/expired token caused the API to see an unauthenticated request and hit the wrong (free-tier) quota. If the retry also returns 406, the error is genuine and propagated normally.

- **Plan-agnostic OpenSubtitles quota detection:** The 406 quota detection in both `apiErrorHandler.js` and `subtitles.js` previously matched the specific string "20 subtitles" — which only matched the free tier. Gold (200) and VIP (1000) quota messages were not recognized as quota errors and fell through to generic error handling. Detection now matches the pattern `"allowed" + "subtitles"` to catch all plan tiers. The user-facing quota subtitle now displays the actual API error message (e.g., "You have downloaded the allowed 200 subtitles in the last 24h") so users see their real limit.

- **Added diagnostic auth-state logging for OpenSubtitles downloads:** Before each `/download` POST, the addon now logs whether the Bearer token is present or missing, its remaining TTL, and whether VIP base URL is active. When credentials are configured but the token is missing, a warning is logged. The `remaining` and `allowed` download counts from the API response are also logged, providing at-a-glance visibility into quota usage.

- **Fixed `es-MX` mapped to generic `es-419` in OpenAI provider, losing Mexican specificity:** The `variantMap` in the OpenAI-compatible provider mapped `es-mx` → `es-419` (generic Latin American Spanish), which erased the country-specific information even though `normalizeTargetLanguageForPrompt` already had explicit handling for `es-mx` → "Mexican Spanish (Español de México)". Removed the `es-mx` → `es-419` entry from `variantMap` so regional codes like `es-mx` pass through to the existing per-country prompt logic. Other entries in the variant map that are true aliases (e.g., `pob` → `pt-br`, `spn` → `es-419`, `zht` → `zh-hant`) are unaffected.

## SubMaker v1.4.66

**Bug Fixes:**

- **Fixed Kubernetes startup probe failure causing restart loops with large session counts:** The HTTP server only bound to port 7001 *after* the session manager finished loading all sessions from Redis. With 21K+ sessions, the `verifySessionIndex()` SCAN + index rebuild took 2+ minutes, during which the Kubernetes startup probe received "connection refused" and eventually restarted the pod — creating an infinite restart loop. The server now binds the HTTP port immediately on startup (Phase 1), then runs all heavy initialization (session loading, cache init, validation) afterward (Phase 2). The existing `FORCE_SESSION_READY` middleware already gates all session-dependent routes, so no user requests are served with missing sessions. The `/health` endpoint now returns a lightweight `200 OK` with `{"status": "starting"}` while the session manager is still initializing, allowing startup/liveness probes to pass immediately. Added `/health` to the readiness middleware skip list so health checks are never blocked by session loading.

- **Changed file upload page requiring `videoId` parameter:** File translation is a standalone tool that only needs the config token — `videoId` is now optional.

- **File translation now always uses the `TranslationEngine`**, which already handles batching, parallel translation, and all workflows (xml/json/original/ai) internally.

## SubMaker v1.4.65

**Bug Fixes:**

- **Fixed AnimeIdResolver crash on read-only filesystems (Docker/containers):** The anime ID resolver attempted to download `anime-list-full.json` at startup if the bundled file was missing, failing with `EROFS: read-only file system` in containerized environments. The file is now committed to git (via `.gitignore` negation: `!data/anime-list-full.json`) and bundled with Docker builds. Additionally, the resolver now gracefully handles read-only filesystems: it detects `EROFS`, `EPERM`, and `EACCES` errors, sets a `_readOnlyFilesystem` flag, skips all download/refresh attempts, and logs an informative message when using bundled data. Weekly refresh scheduling is also disabled on read-only filesystems to avoid futile retries.

- **Fixed Sentry events not being flushed on forced shutdown:** When Kubernetes sends SIGTERM and the server takes longer than 5 seconds to close gracefully, the force-exit timeout was calling `process.exit()` without first flushing pending Sentry events. This caused errors and crash reports to be lost when pods were forcefully terminated. Added `sentry.flush(2000)` to the force-exit path in `sessionManager.js` to ensure error reports are sent before the process exits.

## SubMaker v1.4.64

**Improvements:**

- **Massively expanded language support:** Added 100+ new languages to allLanguages.js including Acehnese, Balinese, Cantonese (yue), Cherokee, Crimean Tatar, Dhivehi, Dzongkha, Faroese, Fijian, Hakka, Ilocano, Konkani, Lao, Limburgish, Lombard, Mongolian dialects, Navajo, Occitan, Ossetian, Quechua, Sanskrit, Shan, Sicilian, Tibetan, Tigrinya, Tok Pisin, Wolof, and many more. Extended section adds ancient languages (Akkadian, Ancient Egyptian, Ancient Greek, Classical Chinese, Gothic, Hittite, Latin variants, Old English, Old Norse, Sumerian), constructed languages (Esperanto, Lojban, Quenya, Sindarin), and additional regional languages.

- **Extended languages list toggle:** Added "Extended languages list" checkbox to the Target Languages and Learn Languages sections on the config page. When enabled, displays ~100 additional rare, ancient, regional, and constructed languages (AI translation only). The toggle state persists in localStorage and syncs between both language sections. Extended languages are marked with `extended: true` in allLanguages.js and filtered out by default.

- **Language name consistency across codebase:** Unified language names between languages.js (ISO-639-2 mappings for Stremio) and allLanguages.js (translation tools). Examples: "Abkhazian" → "Abkhaz", "Kirghiz" → "Kyrgyz", "Panjabi" → "Punjabi", "Pushto" → "Pashto", "Uighur" → "Uyghur", "Central Khmer" → "Khmer", "Chichewa" → "Nyanja (Chichewa)", "Gaelic" → "Scottish Gaelic", "Southern Sotho" → "Sesotho".

- **Separate language functions for different use cases:** Added `getAllTranslationLanguages()` function in languages.js that merges `languageMap` with `allLanguages.js` entries. The original `getAllLanguages()` now returns only `languageMap` entries (provider-compatible). This separation ensures source language selection shows what Stremio supports while target language selection shows what AI can translate to.

- **Added Filipino as custom language mapping:** Added `'fil': { code1: 'fil', name: 'Filipino', isCustom: true }` to languageMap in languages.js to ensure Filipino is available as a distinct option alongside Tagalog. Also added `fil` → `tl` normalization in config.js `normalizeLanguageCodes()` function. Filipino and Tagalog are the same language; both now resolve to the `tl` code. Added deduplication step to prevent duplicate entries after normalization (e.g., if user had both `fil` and `tl` selected).

- **DeepL beta languages expanded:** Added 30+ new beta language codes to deepl.js: AB (Abkhaz), AK (Akan), BM (Bambara), CV (Chuvash), DV (Dhivehi), DZ (Dzongkha), EE (Ewe), FF (Fulani), FIL (Filipino), FJ (Fijian), FO (Faroese), LG (Luganda), LI (Limburgish), NR (South Ndebele), NSO (Northern Sotho), OS (Ossetian), RN (Kirundi), RW (Kinyarwanda), SG (Sango), SI (Sinhala), SM (Samoan), SN (Shona), SS (Swati), TI (Tigrinya), VE (Venda), YO (Yoruba), and others.

**Bug Fixes:**

- **Fixed 524 timeout for large file translations (keepalive streaming):** Even with the correct workflow, translating large subtitle files (400+ entries) takes 2-5+ minutes, exceeding Cloudflare's 100-second origin response timeout. The `/api/translate-file` endpoint now streams periodic keepalive newline bytes (`\n`) every 30 seconds during translation (configurable via `FILE_UPLOAD_KEEPALIVE_INTERVAL`). Each byte resets Cloudflare's timer. `res.flush()` is called after each write to push data through Express's compression middleware. On success, the SRT content is appended after the keepalive newlines (SRT parsers ignore leading blank lines). On error after HTTP 200 is committed, a `[TRANSLATION_ERROR]` marker is written so the client can detect the failure. The client trims leading keepalive newlines from the response and checks for the error marker before processing.

- **Fixed source/no-translation language grids showing 400+ languages with unusable regional variants:** The expanded `allLanguages.js` (for AI translation) was being merged into `getAllLanguages()`, causing source and no-translation language grids to show 11 English variants (en-AU, en-GB, etc.), 22 Spanish variants, 17 Arabic variants, etc. These regional codes don't work with Stremio or subtitle providers (OpenSubtitles, SubDL, etc.) which only recognize ISO-639-2 codes. Split language endpoints:
  - `GET /api/languages` now returns only the 197 provider-compatible languages (ISO-639-2 codes from `languageMap`)
  - `GET /api/languages/translation` returns the full 434 translation-capable languages including regional variants and extended languages
  - Config page fetches both endpoints in parallel: source/no-translation grids use provider languages; target/learn grids use translation languages
  - Quick Setup, SMDB, and Sync pages continue using `/api/languages` (provider-compatible codes only)
  - File Upload and Toolbox pages import `allLanguages.js` directly for translation target selection

- **Fixed regional language variants breaking subtitle fetching in Stremio:** If users selected regional variants like `es-MX` (Spanish Mexico), `en-GB` (English UK), or `zh-CN` (Chinese Simplified) as target languages, subtitle fetching would fail because the `normalizeLanguageCode()` function converted `es-MX` to `esmx` instead of the provider-compatible `spa`. Updated the normalization to detect regional variant format (e.g., `xx-YY`) and extract the base language code, then convert to ISO-639-2. Now `es-MX` → `spa`, `en-GB` → `eng`, `pt-BR` → `pob`, `zh-CN` → `chi`, etc. Also handles script variants (e.g., `mni-Mtei` → `mni`, `sr-Cyrl` → `srp`).

- **Fixed Frisian language code mapping:** Added `fry` (Western Frisian) to languageMap with ISO-639-1 code `fy`. The 2-letter code `fy` now correctly maps to the provider-compatible `fry`.

- **Fixed regional variants losing their specificity in AI translation prompts:** Translation button URLs now preserve the original regional variant code (e.g., `es-MX`) instead of normalizing it to the base language (`spa`). This ensures the AI receives the specific regional variant and can produce translations appropriate for that region. Expanded `normalizeTargetLanguageForPrompt.js` with 71/72 regional variant mappings:
  - Spanish (19 variants): Mexican, Argentine, Colombian, Chilean, Peruvian, Venezuelan, Cuban, Puerto Rican, Dominican, Ecuadorian, Bolivian, Uruguayan, Paraguayan, Guatemalan, Honduran, Salvadoran, Nicaraguan, Costa Rican, Panamanian
  - English (10 variants): British, American, Australian, Canadian, Indian, Irish, New Zealand, South African, Singaporean, Philippine
  - Arabic (16 variants): Egyptian, Saudi, Moroccan, Lebanese, Algerian, Tunisian, Libyan, Iraqi, Syrian, Jordanian, Gulf (UAE/Qatar/Bahrain/Oman), Kuwaiti, Yemeni
  - French (4 variants): Canadian, Belgian, Swiss, Standard
  - German (3 variants): Austrian, Swiss, Standard
  - Chinese (4 variants): Simplified, Traditional, Hong Kong, Singapore
  - Other: Dutch (Flemish), Italian (Swiss), Swedish (Finland), Korean (South/North), Serbian (Cyrillic/Latin), Bosnian (Cyrillic), Malay (Jawi), Punjabi (Shahmukhi)

## SubMaker v1.4.63

**Bug Fixes:**

- **Fixed 524 Cloudflare timeout on file translation page:** The file translation API endpoint (`/api/translate-file`) never forwarded the `translationWorkflow` value (xml/json/original/ai) to the TranslationEngine. The engine always used whatever workflow was in the user's saved config, with no way for the file upload page to override it. Combined with single-batch mode, this could cause the entire file to be processed in one API call using an unintended workflow, exceeding Cloudflare's 100-second origin timeout.

- **Fixed TranslationEngine error catch allowing incorrect fallback for structured workflows:** When the TranslationEngine failed for xml/json/ai workflows, the error catch block checked `singleBatchMode || sendTimestampsToAI` to decide whether to throw or fall back to the legacy parallel/single-call path. Since xml/json workflows didn't set `sendTimestampsToAI`, failures would silently fall back to the legacy path which doesn't support structured workflows, producing garbled output. Now only the `original` workflow without `singleBatchMode` can fall back to the legacy path.

**Improvements:**

- **File translation page now mirrors main config translation workflow options:** Replaced the simplified "Translation Flow" dropdown (batched/single-pass) and "Timestamps Strategy" dropdown (preserve-timing/ai-timing) with the real 4-option Translation Workflow dropdown matching the main config page: XML Tags (Default), JSON (Structured), Original Timestamps (Legacy), and Send Timestamps to AI. Added separate "Single Batch Mode" checkbox and "Enable Batch Context" checkbox, also matching the main config page. All three settings are initialized from the user's saved config defaults and correctly forwarded to the API.

- **File translation API now accepts `translationWorkflow` and `enableBatchContext` per-request overrides:** The `POST /api/translate-file` endpoint now reads `options.translationWorkflow` (xml/json/original/ai) and forwards it to `config.advancedSettings.translationWorkflow` for the TranslationEngine. Also reads `options.enableBatchContext` and forwards to `config.advancedSettings.enableBatchContext`. The `shouldUseEngine` decision is now workflow-aware — any workflow other than `original` routes through the TranslationEngine.

- **Joi validation schema updated for new file translation options:** Added `translationWorkflow`, `singleBatchMode`, and `enableBatchContext` to the `translationOptionsSchema`. Legacy fields (`workflow`, `timingMode`, `sendTimestampsToAI`) are preserved for backward compatibility. Without this update, Joi's `stripUnknown: true` would silently discard the new fields from requests.

- **File translation queue summary now shows actual workflow name:** Queue metadata display updated from "Single-batch/Multiple batches • Rebuild timestamps/Send timestamps to AI" to "XML Tags/JSON/Original Timestamps/Send to AI • Single-batch/Multiple batches", accurately reflecting the selected workflow.

## SubMaker v1.4.62

**Bug Fixes:**

- **Fixed history cards always showing wrong provider and model tags:** The initial `historyEntry` object in `performTranslation()` hardcoded `provider: config.mainProvider` and `model: config.geminiModel` regardless of what was actually used. When `multiProviderEnabled` is `true` and `mainProvider` is anything other than Gemini, `config.geminiModel` is meaningless for the model field. Fixed the initial seed to use `resolveModelNameFromConfig(config)` (which correctly reads `config.geminiModel` for Gemini and `config.providers[provider].model` for all others) and to derive the provider from the actual `multiProviderEnabled` state. Additionally, `providerName` and `effectiveModel` are hoisted to function scope and returned inside `translationStats` from both the success path and the error path — so `Object.assign(historyEntry, extra)` in `updateHistory` always overwrites the initial placeholder values with the actual values used during translation.

- **Fixed secondary provider chip never appearing for native provider fallbacks:** `translateBatchNative()` (used by DeepL and Google Translate as primary providers) had its own inline `try/catch` fallback that called `this.fallbackProvider.translateSubtitle()` but never set `this.translationStats.usedSecondaryProvider = true` or `this.translationStats.secondaryProviderName`. When a native primary provider failed and secondary handled the batch, the history card would show no secondary indicator at all. Fixed by adding the same stats update that the LLM `tryFallback` closure applies, including `primaryFailureReason`.

- **Fixed embedded translation history cards missing all diagnostic fields:** The `/api/translate-embedded` endpoint in `index.js` creates a `TranslationEngine`, runs `engine.translateSubtitle()`, then calls `persistHistory('completed', {...})` — but `engine.translationStats` was never read. All secondary provider flags, error types, rate limit counts, batch details, and other diagnostics were silently discarded for embedded subtitle translation history cards. Fixed by spreading `...(engine.translationStats || {})` into the `persistHistory` call.

**Improvements:**

- **Primary failure reason now surfaced on secondary provider chip tooltip:** When the secondary provider is used as a fallback (in any batch), the engine now stores the primary provider's error message in `translationStats.primaryFailureReason`. The history card's "⚠ Secondary: {name}" chip tooltip now reads "Primary provider failed: {reason}. Secondary was used as fallback." instead of the generic message. The reason is truncated to 120 characters in the rendered tooltip. Both the LLM `tryFallback` closure and the native `translateBatchNative` fallback path record this field (first-occurrence-wins across batches).

- **`primaryFailureReason` tracked through parallel translation:** Parallel worker engine clones now include `primaryFailureReason: ''` in their isolated `translationStats` objects, and the merge-back step propagates it to the main engine's stats using the same first-wins logic as `secondaryProviderName`.

- **History cards now differentiate main vs. secondary provider errors with distinct color accents:** Main provider diagnostics are shown with a cyan/blue accent (`--provider-main`); secondary provider diagnostics with an amber/orange accent (`--provider-secondary`). Both colors are defined as CSS custom properties in all three themes (light, dark, true-dark).

- **Main and secondary provider diagnostics grouped into labeled cluster rows:** Instead of a flat list of mixed chips, history cards now render separate `history-provider-group` rows — one for the main provider (rate-limit chip, key-rotation chip, error-type pills, mismatch chip) and one for the secondary provider (secondary chip, secondary error types, secondary failure chip). Each row is labeled with a tiny uppercase provider name pill and accented with its respective color border/background. Rows only appear when they contain at least one diagnostic chip.

- **Secondary provider error types now tracked in stats (`secondaryErrorTypes[]`):** Previously, errors from the secondary provider were not captured individually — only the combined `MULTI_PROVIDER` label appeared. Now, when the secondary provider itself fails, its `error.translationErrorType` is pushed to `translationStats.secondaryErrorTypes[]`. Falls back to a generic `SECONDARY_FAILED` label if the error has no classification. Rendered as amber-tinted pills on the history card.

- **Secondary provider failure reason now tracked in stats (`secondaryFailureReason`):** When the secondary provider also fails (both main and secondary exhausted), the secondary's error message is stored in `translationStats.secondaryFailureReason`. Rendered on the history card as a dark-orange "✕ Also failed: …" chip with the reason truncated to 48 characters (full reason on hover). This makes the "both providers failed" case explicitly visible rather than only showing the generic error div.

- **Secondary provider failure tracked on both LLM (`tryFallback`) and native (`translateBatchNative`) fallback paths:** Both fallback code paths now populate `usedSecondaryProvider`, `secondaryProviderName`, `primaryFailureReason`, `secondaryFailureReason`, and `secondaryErrorTypes` consistently on secondary failure, mirroring the stats recorded on success.

- **`EMPTY_STREAM` error type now tracked in stats:** When Gemini streaming returns no content and the engine silently retries without streaming, `'EMPTY_STREAM'` is pushed to `translationStats.errorTypes`. This makes previously invisible silent retries visible on the history card.

- **Main provider tag accented when secondary was used:** When a secondary provider was involved, the main provider name tag on the history card gains a cyan/blue border and background to signal "this is the main provider that failed."

- **`secondaryErrorTypes` and `secondaryFailureReason` propagated through parallel batch worker merge:** Parallel worker engines now initialize with `secondaryErrorTypes: []` and `secondaryFailureReason: ''`. The merge-back step aggregates `secondaryErrorTypes` (deduplicated union) and `secondaryFailureReason` (first-wins) from all worker batches into the main engine stats.

- **Responsive styles for new provider group rows:** Provider group rows scale to smaller font and tighter padding on mobile (≤920px) viewport, consistent with existing chip/tag responsive behavior.

- **Fixed translation history entries silently lost on multi-instance deployments:** `saveRequestToHistory` used a non-atomic read-modify-write cycle on a single aggregated store key (`histset__{hash}`). With two SubMaker pods running concurrently, both pods could read the store key at the same time, merge their respective new entries independently, then each overwrite the other's write — causing the entry from whichever pod wrote first to be permanently lost. Fixed by writing each history entry to its **own independent key** (`hist__{hash}__{id}`) as a pure atomic SET with no prior read. Concurrent pods now write to different keys and can never clobber each other. The aggregated store key is still updated as a best-effort read-cache immediately after the entry write so the history page fast-path stays warm.

- **History page reads now use a time-gated fast-path to avoid expensive Redis SCANs:** `getHistoryForUser` previously always performed a full Redis SCAN of per-entry keys on every history page load. With thousands of users this created unnecessary SCAN pressure on the Redis cluster. The function now checks the aggregated store key first: if it was refreshed within the last 15 seconds, the result is returned immediately from a single GET without touching SCAN. If the cache is stale or missing, the slow path runs a full SCAN, merges per-entry keys from all pods with any cached store entries (newest version of each entry wins), then rebuilds the store key so subsequent reads within the next 15 seconds use the fast path.

## SubMaker v1.4.61

**Improvements:**

- **Error subtitles are now provider-agnostic:** All user-facing translation error subtitles now dynamically display the actual provider name (Gemini, DeepL, Google Translate, OpenAI, etc.) instead of hardcoded "Gemini" references. A `displayProvider` helper formats provider names for user display (e.g., `deepl` → `DeepL`, `googletranslate` → `Google Translate`). The `providerName` parameter is passed through the error cache and read back when serving cached errors.

- **Error subtitles consolidated to single 0→4h entry:** All translation error subtitles now use a single SRT entry spanning `00:00:00,000 → 04:00:00,000` instead of the previous 3-entry format. This ensures the error message is visible regardless of where the user seeks in the video timeline.

- **`MODEL_NOT_FOUND` error type for 404 errors:** Added a dedicated `MODEL_NOT_FOUND` error classification for HTTP 404 errors from translation APIs. When a configured AI model is renamed or deprecated, users now see "Translation Failed: Model Not Found (404)" with actionable guidance to check the model setting, instead of a generic "Resource not found" message.

- **`SAFETY` and `PROHIBITED_CONTENT` error handling consolidated:** Both error types now produce the same user-facing "Content Filtered" subtitle. Previously they had separate branches with identical output.

- **Translation History cards now show rich diagnostics:** History cards now display up to 16 new diagnostic fields organized into visually distinct tiers:
  - **Tier 1 (Critical):** ⚠ orange "Secondary: {name}" chip when fallback provider was used, red "429 × N" chip for rate-limit errors, 🔑 blue key rotation tag, red-bordered error type pills (429, MAX_TOKENS, PROHIBITED_CONTENT).
  - **Tier 2 (Quality/performance):** ⚠ orange mismatch chip with missing/recovered counts, "{N} entries" tag, ⏱ duration tag (computed from createdAt → completedAt), 📥 subtitle source tag (SubDL, SubSource, OpenSubtitles V3, Community Subtitles, Wyzie Subs, Subs.ro, Embedded, OpenSubtitles).
  - **Tier 3 (Config context):** Workflow tag (XML/JSON/AI), JSON→XML fallback warning chip, batch count, key rotation mode, Context/Single-batch/Parallel/Streaming tags. Rendered in a dedicated subdued row (smaller font, 70% opacity) to reduce visual clutter.
  - All fields are backward-compatible — older history entries without these fields display normally.

- **Translation diagnostics collected on the engine:** `TranslationEngine` now initializes a `translationStats` object in the constructor and accumulates data at all key instrumentation points: `translateBatch()` (secondary provider fallback, 429/503 retries, key rotation, error type classification, mismatch detection with two-pass and full-batch recovery tracking, JSON→XML fallback), `translateSubtitle()` (entry count, batch count, parallel batches flag), and `translateSubtitleSingleBatch()` (actual chunk count after auto-splitting).

- **Diagnostics bridged from engine to history:** `performTranslation()` in `subtitles.js` captures `translationEngine.translationStats` after translation completes and returns it. The `.then()` handler spreads all stats into `updateHistory('completed', { ...stats })`. On failure, the catch block attaches stats to the error object via `error.translationStats`, and the `.catch()` handler extracts and saves them — ensuring failed translations retain diagnostic data (e.g., "429 × 5" shows why it failed).

- **Subtitle source derived from sourceFileId:** History entries now record which subtitle provider was used based on the `sourceFileId` prefix mapping: `subdl_` → SubDL, `subsource_` → SubSource, `v3_` → OpenSubtitles V3, `scs_` → Community Subtitles, `wyzie_` → Wyzie Subs, `subsro_` → Subs.ro, `xembed_` → Embedded, default → OpenSubtitles.

- **Parallel batch count tracked:** `parallelTranslation.js` now writes `engine.translationStats.batchCount` after computing batches, so parallel translation history cards show the correct batch count instead of 0.

- **History card UI responsive for mobile:** Added `align-items: center` to `.history-details` flex container. At ≤920px, chip/tag font sizes reduce to 0.78rem and gap tightens to 0.35rem. Tier 3 config row uses compact 0.75rem tags.

**Bug Fixes:**

- **Fixed critical variable shadowing bug causing all standard batched translations to return empty subtitles (introduced in v1.4.60):** The v1.4.60 refactor that added Parallel Batches wrapped the standard batched path in an `else` block and accidentally re-declared `translatedEntries` with `const` inside that block, shadowing the outer `let translatedEntries = []`. The 454-entry translation loop accumulated results into the inner block-scoped constant — which went out of scope at the closing brace — while the outer variable remained permanently empty. `toSRT(translatedEntries)` at the end of `translateSubtitle()` always received an empty array, producing a 1-character empty SRT that was cached and served to Stremio, causing "failed to load external subtitles." Streaming partial saves during translation worked correctly (they used the inner variable), so progress was visible in the UI but the final assembled result was always broken. Single-batch mode and parallel batches mode were unaffected (different code paths). Fixed by removing the inner `const` declaration so the batch loop writes into the outer `let` as originally intended.

- **Fixed `serviceName` lost during `TranslationEngine` error wrapping:** When `translationEngine.js` wrapped batch errors, it copied `translationErrorType`, `statusCode`, `type`, `isRetryable`, and `originalError` from the original error but not `serviceName`. This caused `errorProvider` to always be `null` in the error cache, so error subtitles fell back to the generic "API" label instead of showing the actual provider name (e.g., "Gemini", "DeepL").

- **Fixed full-batch mismatch retry not tracking recovered entries:** When the full-batch retry path (>30% missing entries) successfully recovered all entries, `translationStats.recoveredEntries` was not incremented. Only the targeted two-pass recovery path tracked recoveries. Now both paths correctly report recovery counts.

- **Fixed `rateLimitErrors` counter only counting first 429/503 detection:** The `rateLimitErrors` stat was incremented once when a 429/503 was first detected, but not on each subsequent failed retry within the key-rotation loop. The history card's "429 × N" chip now accurately reflects total rate-limit failures including retries.

- **Fixed unclassified error types missing from history pills:** Error types like `MODEL_NOT_FOUND` (404), `403`, and `503` were classified by `apiErrorHandler.js` but never pushed to `translationStats.errorTypes` because `translateBatch()` only tracked `429`, `MAX_TOKENS`, and `PROHIBITED_CONTENT`. Added a catch-all in the final error handler that records any `translationErrorType` to the stats array.

- **Fixed `displayProvider` incorrect capitalization for multi-word providers:** The generic first-letter-only capitalizer produced `Openai`, `Deepseek`, `Openrouter`, `Xai` instead of `OpenAI`, `DeepSeek`, `OpenRouter`, `xAI`. Replaced with an explicit lookup table covering all known providers, with the generic capitalizer as fallback for unknown ones.

- **Fixed parallel worker engines sharing `translationStats` by reference:** Parallel batch workers created via `Object.assign()` shared the original engine's `translationStats` object reference. Concurrent batches mutating shared counters (e.g., `rateLimitErrors++`) was a race condition. Workers now get fresh zeroed stats objects and merge results back to the parent engine's stats after each batch completes. The merge uses `try/finally` so diagnostics from failed batches (rate limits, error types) are always preserved — critical since the most useful diagnostics come from batches that fail.

**Cleanup:**

- **Removed ~50 lines of redundant error classification in `performTranslation`:** The catch block previously had 4 layers of error type detection: (1) `translationErrorType`, (2) `statusCode` checks, (3) `error.response.status` checks, (4) message-string fallbacks. All layers produced identical results since `handleTranslationError()` in `apiErrorHandler.js` already sets `translationErrorType` before errors reach `performTranslation`. Replaced with a single line: `const errorType = error.translationErrorType || 'other'`.

## SubMaker v1.4.60

**New Features:**

- **Parallel Batch Translation Engine (Dev mode):** Added a new experimental parallel translation mode that concurrently processes multiple subtitle batches to maximize throughput. Available exclusively in Dev Mode and disabled on ElfHosted instances (`ELFHOSTED=true`). When enabled, all batches are dispatched simultaneously under a configurable concurrency limit (1–5, default 3), and results are merged back into the output in sequential order as batches complete. Batch 0 uses streaming for real-time progress; remaining batches use worker-engine clones (shallow-copied instances) to prevent API key rotation mutations on the shared engine instance. UI controls appear in Translation Settings in a dashed dev-mode section.

- **Parallel Batches Count selector:** When Parallel Batches is enabled, a dropdown appears to select the concurrency level: 1 Batch (Testing), 2 Batches, 3 Batches (Recommended), 4 Batches, or 5 Batches. Values are clamped to [1, 5] during config normalization; selecting a higher value increases token throughput at the cost of higher TPM (tokens per minute) consumption.

**Improvements:**

- **`parallelTranslation.js` fully rewritten:** The previous implementation (`translateInParallel`) was a standalone SRT-string-in/SRT-string-out function with its own SRT parser, token estimator, and context chunker — incompatible with the `TranslationEngine` lifecycle. Replaced with `executeParallelTranslation`, a tightly integrated function that works directly with parsed entry arrays and the engine's own `translateBatch()` method, supporting all existing workflows (XML, JSON, Numbered, Send Timestamps to AI), API key rotation, batch context, streaming, mismatch retries, and provider fallbacks. Fixed the first-batch streaming blocking issue from the previous implementation by using `runWithProgressiveSequentialResolution`, an ordered queue that drains completed batches in order without holding up concurrently running ones.

- **Single Batch Mode takes priority over Parallel Batches:** If both Single Batch Mode and Parallel Batches are enabled simultaneously, Single Batch Mode wins unconditionally and a warning is logged. Parallel mode never runs in that configuration.

- **Parallel Batches bypasses translation cache:** Like Single Batch Mode and Multi-Provider, enabling Parallel Batches now adds `'parallel-batches'` to the `bypassReasons` list in config normalization, preventing stale cached translations from being served when parallel mode is active.

- **Parallel Batches config forwarded from `subtitles.js`:** `parallelBatchesEnabled` and `parallelBatchesCount` are now spread into the `advancedSettings` object when constructing a `TranslationEngine` instance, making them available throughout the engine without requiring top-level constructor changes.

- **Default config values added for parallel batches:** `parallelBatchesEnabled: false` and `parallelBatchesCount: 3` are now defined in both `src/utils/config.js` and `public/config.js` default configs, ensuring clean state for all users by default.

- **"Enable Batch Context" setting moved to Translation Settings:** The "Enable Batch Context" checkbox was relocated from the Advanced Settings section to the Translation Settings section (below "Enable Single Batch"), where it is more logically grouped with other per-batch translation options.

- **XML workflow prompt refined:** `createXmlBatchPrompt()` prompt header changed from `"You are translating subtitle text to..."` to `"You are a professional subtitle translator. Translate to..."`. Added explicit rule to preserve existing formatting tags. Removed `customPromptText` interpolation and the old escaped `\\n7` context rule (which had double-escaped newlines).

- **JSON workflow prompt refined:** `_buildJsonPrompt()` prompt header updated to the same professional tone. Simplified and consolidated the critical rules list — cleaned up redundant formatting and removed the split `ADDITIONAL INSTRUCTIONS/TRANSLATION STYLE` sections into one cohesive block. Removed `customPromptText` block and the stale `"Translate to {target_language}."` closing line. Fixed raw string escaping (`\\"` → `\\\"`) in JSON format instructions.

- **Numbered-list workflow prompt refined:** `createBatchPrompt()` prompt header updated. Merged the overly verbose rule list into a clean, deduplicated set. Fixed double-escaped newline in context rule (`\\n7` → `\n8`). Removed `customPromptText` interpolation block and consolidated `DO NOT` rules.

## SubMaker v1.4.59

**Improvements:**

- **Batch context refactored — removed `previousTranslations`, kept `surroundingOriginal` only:** The context sent to AI translation workflows no longer includes recently translated entries (`previousTranslations`). Only the preceding original source entries (`surroundingOriginal`) are now included as context. This avoids feeding conflicts to the AI while still providing enough narrative continuity. All four workflows (XML, JSON, Original Timestamps, and Send Timestamps to AI) were updated accordingly — context section builders simplified and deduplicated throughout `TranslationEngine`.

- **Context size default increased from 3 to 8:** The `contextSize` setting (number of preceding original entries sent as context per batch) now defaults to `8` across all config layers (`src/utils/config.js`, `public/config.js`, `TranslationEngine` fallback, and the config page UI input/description). This provides more surrounding narrative context for better translation coherence at minimal token cost.

- **JSON workflow prompt significantly enhanced:** `_buildJsonPrompt()` in `translationEngine.js` received a major prompt upgrade:
  - Explicit rules for JSON validity (escaping double-quotes, `\n` for line breaks, no trailing commas).
  - Strict `id` field preservation with no modification.
  - Gender/pronoun/speech level consistency enforced across the batch with best-effort disambiguation.
  - Rule to never return original source text unless it is a proper noun.
  - Rule to pass through empty/whitespace/tag-only fields unchanged.
  - Additional professional localization instructions: cinematic subtitle style, Unicode punctuation, lyric adaptation intent, formatting tag preservation.
  - Closing statements consolidated to avoid duplicate "DO NOT add explanations" lines.

- **JSON workflow context description updated:** Context instructions for JSON workflow now correctly describe `__context.preceding` as "preceding original source text" instead of the removed "preceding original text and/or recent translations".

- **Numbered-list workflow context label updated:** Context section marker for the numbered-list (original timestamps) workflow now reads "Context entries are marked with [Context N]" — removed the stale "[Translated N]" label that referenced the now-removed `previousTranslations`.

- **`surroundingEndIdx` off-by-one corrected:** `_getBatchContext()` now uses `firstEntryId - 2` as the end index for surrounding context (instead of `firstEntryId - 1`), ensuring the batch's own first entry is not inadvertently included in its own context window.

- **Stremio GitHub Pages origin allowed:** Added `https://stremio.github.io` to the `DEFAULT_STREMIO_WEB_ORIGINS` allowlist in `index.js`, enabling the Stremio web shell hosted on GitHub Pages to communicate with the addon without CORS blocks.

- **SubDL `chinese bg code` language mapping added:** Added `'chinese bg code': 'chi'` to SubDL's language-to-ISO-code map, fixing subtitle searches that fail when SubDL returns the `Chinese BG Code` language tag for Simplified Chinese subtitles.

- **DeepSeek JSON workflow fix (400 errors resolved):** DeepSeek's API rejects `response_format: json_schema` (strict) with a 400 error — it only supports the simpler `json_object` format. When the JSON workflow is active and the provider is DeepSeek, the request now sends `{ type: 'json_object' }` instead of the full strict `json_schema` contract. Both `deepseek-chat` and `deepseek-reasoner` accept `json_object` and produce valid JSON output; the prompt already instructs the exact `[{id, text}]` structure so schema enforcement at the API level is not needed. All other providers continue using the strict `json_schema` path unchanged.

- **Gemini model IDs updated to stable names:** Replaced all hardcoded preview/alias model slugs with their current stable API identifiers across the full config stack (`src/utils/config.js`, `public/config.js`, `public/partials/main.html`):
  - `gemini-2.5-flash-preview-09-2025` → `gemini-2.5-flash`
  - `gemini-flash-lite-latest` → `gemini-2.5-flash-lite`
  Both old IDs now return 404 from the Gemini API; new IDs are confirmed valid. Backward-compatible migration is applied at both the frontend form-load level (users with old saved model values have it silently corrected when the config page loads) and the server-side deprecated model override (old IDs are included in `DEPRECATED_MODEL_NAMES` and replaced with the current default on config resolution).

## SubMaker v1.4.58

- **OpenAI model compatibility hotfix (400 errors resolved):** Fixed OpenAI request shaping for modern GPT families. OpenAI chat requests now use `max_completion_tokens` (instead of `max_tokens`), and GPT-5-family requests no longer send unsupported sampling params (`temperature`/`top_p`) that were triggering `400 invalid_request_error` responses.

- **GPT-5 Pro endpoint routing:** Added automatic routing for GPT-5 Pro variants to the OpenAI Responses API (`/v1/responses`) instead of Chat Completions, with provider-side extraction of translated text from Responses payloads.

- **Reasoning effort compatibility hardening:** Expanded accepted reasoning-effort values (`none`, `low`, `medium`, `high`, `xhigh`) and added model-aware normalization so unsupported effort values are auto-adjusted before request dispatch.

- **Streaming fallback behavior tightened:** Improved stream unsupported detection so non-stream fallback is only triggered for genuine stream/SSE incompatibility cases, reducing false fallbacks on other request validation errors.

- **Cross-model OpenAI smoke test coverage:** Added `scripts/test-openai-compat.js` to validate translation behavior (capped to 30 subtitle entries per test request) across GPT-5/GPT-4.1/GPT-4o families and common dated model variants.

- **DeepSeek max-token compatibility fix (400 invalid request resolved):** Fixed DeepSeek translation failures caused by oversized `max_tokens` values. The OpenAI-compatible provider now applies model-aware token ceilings for DeepSeek requests at runtime (`deepseek-chat` capped to `8192`, `deepseek-reasoner` capped to `65536`) before request dispatch.

- **DeepSeek model-aware defaults in config normalization:** Added DeepSeek-specific defaulting so when users have not explicitly set `providerParameters.deepseek.maxOutputTokens`, normalized config now auto-selects `8192` for `deepseek-chat` and `65536` for `deepseek-reasoner` based on the configured DeepSeek model.

- **DeepSeek baseline default adjusted:** Updated the DeepSeek provider parameter default (`PROVIDER_PARAMETER_DEFAULTS.deepseek.maxOutputTokens`) to `8192` so fresh configs are safe for `deepseek-chat` out of the box.

- **Anthropic Claude 4.5 compatibility fix (400 invalid request resolved):** Fixed Anthropic request shaping for Claude 4.5 models that reject `temperature` + `top_p` together. The provider now auto-retries with model-compatible parameters (dropping `top_p` when required) instead of failing the batch.

- **Anthropic stream-mode 400 fallback hardening:** Improved streaming error handling so generic `400` responses no longer get stuck in stream retry loops. Stream path now falls back once to non-stream translation flow, which applies compatibility retries and successfully completes more model/base combinations.

- **Anthropic thinking-mode compatibility safeguards:** Added adaptive retry logic for thinking-related validation constraints (including model requirements around temperature settings when thinking is enabled), reducing configuration-sensitive request failures across Claude variants.

- **Anthropic JSON prefill compatibility fallback:** Added retry downgrade when assistant prefill for JSON forcing is unsupported/deprecated on a given model, so translation can continue without manual config changes.

- **Claude 4.5 verification coverage (30-entry capped tests):** Validated non-stream, stream, and JSON non-stream translation paths against `claude-haiku-4-5-20251001`, `claude-sonnet-4-5-20250929`, and alias forms (`claude-haiku-4-5`, `claude-sonnet-4-5`) with test payloads capped to 30 subtitle entries per request.

## SubMaker v1.4.57

- **OpenSubtitles distributed rate limit hotfix:** Fixed v1.4.56 distributed lock not properly throttling across pods—replaced spin-wait polling with TTL-based waiting, added lock refresh after login completion (1.1s cooldown starts after request, not before), and removed redundant retry loop in credential validation endpoint.

## SubMaker v1.4.56

- **Strict global rate limiting for OpenSubtitles login:** Implemented a serialized request queue that enforces a strict 1 request/1.2s limit for the `/login` endpoint across the entire process. This prevents the "429 Too Many Requests" errors caused by burst login attempts (e.g., from retries or concurrent users), ensuring compliance with OpenSubtitles' 1 req/sec limit.

- **Distributed rate limiting for multi-instance deployments:** Added a Redis-backed distributed lock mechanism (`tryAcquireLock`) that coordinates OpenSubtitles login attempts across multiple addon instances (pods). In clustered environments (like ElfHosted), all instances now respect the global 1 req/sec limit, preventing aggregate traffic from triggering rate limits.

- **OpenSubtitles token validity re-check:** Added robust error handling for `500` "invalid token" and `401` unauthorized responses from OpenSubtitles. The addon now automatically invalidates the local/redis token cache and retries the request once with a fresh login, handling server-side token revocations gracefully without user intervention.

## SubMaker v1.4.55

**Hotfix for Sentry logs.**

## SubMaker v1.4.54

**New Features:**

- **AutoSubs is now officially released:** Added the new **AutoSubs page** in Toolbox as a guided subtitle-generation flow for stream/video inputs. The page is organized as a step-by-step pipeline (input URL, mode/audio setup, run, preview/download) and is designed to generate subtitles automatically and optionally translate output to a selected target language.

**Improvements:**

- **AutoSubs cache is now fully separated from xSync:** AutoSubs outputs are now stored in a dedicated cache namespace (`AUTOSUB`) instead of the manual sync cache (`SYNC`). Subtitle lists now surface these as `Auto (Language)` entries while manual sync remains under `xSync (Language)`, preventing method/source collisions.

- **Dedicated Auto subtitle download route:** Added `GET /addon/:config/auto/:videoHash/:lang/:sourceSubId` for Auto entries. AutoSubs API responses now return `/auto/...` download URLs instead of `/xsync/...`, so Auto and manual-sync flows remain isolated end-to-end.

- **Legacy AutoSubs compatibility path:** Existing historical AutoSubs records that were saved in `xSync` cache are now treated as legacy Auto data: they are excluded from `xSync` listing, surfaced under `Auto`, and still downloadable through the new `/auto/...` route via controlled fallback.

- **Storage controls for Auto cache:** Added independent cache sizing and cleanup for AutoSubs (`CACHE_LIMIT_AUTOSUB`, default `0.5GB`) with periodic cleanup scheduling equivalent to other cache types.

- **Immediate cache visibility after sync/autosub writes:** Subtitle search dedup keys now include a per-user revision token that is bumped after sync/autosub cache writes, so newly created `xSync`/`Auto` entries appear without waiting for subtitle-search TTL expiry.

- **AssemblyAI timing preservation in normalization pipeline:** `normalizeAutoSubSrt()` now supports `preserveTiming` mode. When AutoSubs runs with AssemblyAI, subtitle entries keep original timing shape (with monotonic guard + minimum duration) instead of being aggressively re-merged, reducing timing drift in generated SRTs.

- **AutoSubs run route now applies engine-aware normalization options:** `/api/auto-subtitles/run` now computes normalization options based on engine/model (`assemblyai`) and applies the same option set consistently to both transcript payload fallback input and the final transcription SRT.

- **Clearer AutoSubs run log during translation path:** when "translate output" is enabled, the success log after transcription now explicitly appends a "Translating..." status so the next processing phase is visible immediately in the UI trail.

- **New local decode warning in AutoSubs Step 1:** Added a prominent warning banner explaining that large files are less ideal because stream download + audio decode happen locally before transcription.

- **AutoSubs checkbox copy clarified:** Updated wording from "Translate to target languages" to singular "Translate to target language" (and localized equivalents) to match actual selection behavior.

- **AutoSubs control wrapper class cleanup:** standardized `.controls.controls-wrap` usage for layout consistency across mode controls and track-selection controls.

- **AutoSubs is no longer dev-mode gated in UI navigation:** the AutoSubs entry now stays enabled in Quick Nav and in the main Toolbox tiles even when `devMode` is disabled, so the feature is visible by default.

- **Configure page "Other API Keys" visibility now follows Sub Toolbox state:** the section is now shown whenever Sub Toolbox is enabled (instead of requiring Dev Mode), matching AutoSubs availability expectations.

- **xSync AutoSubs language normalization expanded for many real-world tags:** the background worker now normalizes a much wider range of source-language hints across ISO-639-1/2 codes, common language names, locale/script variants, and legacy aliases (for example `eng`, `jpn`, `es-419`, `pt-BR`, `zh-Hant`, `iw`, `in`, `ji`) before STT provider requests.

- **Cloudflare/AssemblyAI track-language matching hardened:** preferred audio-track selection now uses the shared normalization path, improving matching for locale-formatted metadata (including underscore variants like `en_us`) and reducing fallback-to-`und` behavior.

- **AssemblyAI source-language handling now normalizes at input boundary:** explicit source language values are normalized immediately in the request handler, preventing invalid raw tags from blocking selected-track language fallback.

**Bug Fixes:**

- **Final subtitle responses now enforce no-store:** all subtitle payloads served via `setSubtitleCacheHeaders(..., 'final')` (standard downloads, translation finals, xSync, Auto, xEmbed, and addon SMDB SRT route) now return strict no-store headers instead of `private, max-age=86400`, reducing stale subtitle reuse on clients that persist subtitle responses too aggressively.

- **Removed duplicate language rows for cached sync outputs:** Listing logic now selects only the newest cached entry per language for both `xSync` and `Auto`, eliminating repeated `#1/#2/...` style duplicates in subtitle menus.

- **Sync page subtitle source filtering updated:** The sync page now excludes `Auto` cached entries from the selectable provider subtitle list (same treatment as `xSync`/action entries), preventing cache entries from appearing as raw source candidates.

- **Invalid CSS class selector fixed:** replaced `.controls.wrap` usage with `.controls.controls-wrap`, ensuring the intended layout rules are applied predictably in AutoSubs cards.

- **Fixed malformed track-language normalization entry (`mlt`) in xSync:** corrected incorrect mapping of `mlt` to Chinese; `mlt` now maps to Maltese, and additional Chinese-family alias coverage was aligned.

- **Fixed xSync source-language propagation for multi-track AutoSubs runs:** when source language is auto, the selected audio track language is now used consistently for transcription request hints (Cloudflare and AssemblyAI paths), improving language consistency for dual-audio content.

- **Matroska audio default-language fallback applied in xSync track probing:** when MKV audio track language elements are omitted, probing now treats the track as English by default, matching Matroska defaults and avoiding empty-language edge cases.

**User Interface:**

- **Auto Subs Step 4 action cleanup:** removed the Step 4 `Download VTT` button and runtime wiring from the Auto Subs output UI.

- **Auto Subs Step 4 warning block added:** when translation succeeds, the page now shows a final warning block at the bottom to clarify expected behavior for the generated outputs.

- **Auto Subs Step 1 recommendation banners:** Added centered "English audio source recommended." and updated "Avoid large files when possible…" warning texts in the Step 1 card.

- **Re-enabled Cloudflare Whisper model selector:** The model dropdown now shows when Cloudflare mode is selected (previously hidden). Normal users see only "Whisper Large V3 Turbo"; the base "Whisper" option is gated behind dev mode.

**Localization:**

- **Updated AutoSubs locale keys across supported languages:** added `localDecodeWarning` and aligned `translateOutput` text in `en`, `es`, `pt-br`, `pt-pt`, and added `localDecodeWarning` in `ar`.

## SubMaker v1.4.53

**New Features:**

- **Offline anime ID resolver (Fribb/anime-lists):** Added `animeIdResolver.js` — a new service that loads the complete [Fribb/anime-lists](https://github.com/Fribb/anime-lists) dataset (~42,000 entries) into memory at startup, building O(1) `Map` lookups for Kitsu, MAL, AniDB, and AniList IDs → IMDB/TMDB. Anime ID resolution now completes instantly via local Map lookup instead of making live API calls to Kitsu, Jikan, AniList GraphQL, or Wikidata SPARQL. Existing live API services are retained as fallbacks for entries not in the static list. The data file is auto-downloaded on first startup if missing, and auto-refreshed weekly with Redis leader election for multi-instance deployments (only one pod downloads; others detect the update via a Redis timestamp key and reload).

- **Native JSON translation workflow:** Added "JSON (Structured)" as a fourth Translation Workflow option alongside Original Timestamps, Send Timestamps to AI, and XML Tags. When selected, subtitle entries are sent to the AI as a clean JSON array (`[{"id":1,"text":"..."},...]`) and the AI responds in the same format — no format ambiguity. This replaces the old `enableJsonOutput` toggle, which bolted JSON instructions onto existing workflows causing "Pattern Trap" issues where the AI ignored the JSON format and returned numbered lists. The new workflow has a dedicated prompt (`_buildJsonPrompt`), input formatter (`_prepareJsonBatchContent`), and response parser. Batch size is intrinsically capped at 150 entries for JSON to reduce syntax errors. Full context support: when batch context is enabled, context is wrapped in a `__context` key in the JSON payload.

- **OpenSubtitles auth hash matching:** When a real Stremio `videoHash` is available (from torrent-based streaming addons like Torrentio), the OpenSubtitles auth search now includes the `moviehash` parameter. Subtitles that the API confirms as exact file matches (`moviehash_match=true`) are flagged with `hashMatch: true` and ranked in Tier 0 alongside SCS hash matches.

**Improvements:**

- **Expanded supported anime ID schemes in the manifest:** SubMaker now advertises and accepts additional anime ecosystem ID prefixes used by catalog addons: `myanimelist`, `tvdb`, `simkl`, `livechart`, and `anisearch` (alongside `anidb`, `kitsu`, `mal`, and `anilist`).

- **Extended offline resolver maps to additional platforms:** The bundled Fribb/anime-lists resolver now builds O(1) in-memory maps not only for Kitsu/MAL/AniDB/AniList, but also for TVDB, SIMKL, LiveChart, and AniSearch IDs.

- **Provider-agnostic Tier 0 hash ranking:** The highest-priority subtitle ranking tier (200,000+ points) is no longer exclusive to Stremio Community Subtitles. Any provider that sets `hashMatch: true` on its results now qualifies for Tier 0 ranking, enabling OpenSubtitles auth hash-matched subtitles to rank at the top alongside SCS.

- **History title resolution for all anime platforms:** Previously, only Kitsu anime entries in Translation History could resolve titles (via the Kitsu API). MAL, AniDB, and AniList entries showed raw IDs (e.g., `mal:20:1:5`). Now, the offline resolver maps any anime platform ID → IMDB, then Cinemeta provides the title. The Kitsu API remains as a final fallback for Kitsu IDs if the offline→Cinemeta path fails.

- **Partial delivery checkpoint schedule logged at translation start:** When streaming translation begins, the addon now logs the full checkpoint schedule showing exactly when partial saves will trigger (e.g., `first=30, step=75, checkpoints=[30, 105, 180, 255, 324]`), along with debounce, minimum delta, and log interval settings. This makes it immediately clear what the save cadence will be for a given file size and streaming mode.

- **Partial saves always logged with next checkpoint info:** Partial cache saves are now always logged with a `[Translation] Partial SAVED:` message that includes the current entry count and the next checkpoint target (`nextCheckpoint=180`). Previously, save logs were throttled by the same interval as progress logs (every 100 entries), making it appear that saves weren't happening when they actually were at checkpoint boundaries (30, 105, 180...).

- **Accurate partial save skip reasons in logs:** Replaced the generic `"partial save skipped by throttle"` log message with detailed skip reasons: `"checkpoint not reached (next=105)"` when waiting for the next save boundary, `"debounce (delta=5<10, elapsed=1200ms<3000ms)"` when new data arrived too fast, `"stale sequence"` for duplicate stream events, or `"batch already saved"` in multi-batch mode. Eliminates ambiguity about why a particular progress event didn't trigger a save.

- **First-in-chain request tracing:** Added a new middleware at the very top of the Express stack (before helmet, CORS, compression) that logs `[Request Trace] >>>` for all subtitle and manifest requests. If a request doesn't produce this log, it truly never reached the server — helping diagnose "Stremio not sending requests" issues.

- **Cache buster redirects now logged:** 307 redirects from the cache-buster middleware now log at DEBUG level showing the redirect path.

- **Auto-migration from enableJsonOutput toggle:** Users who had the old `enableJsonOutput` checkbox enabled are automatically migrated to the new `json` workflow on config load. The `ENABLE_JSON_OUTPUT` environment variable is deprecated but still works (auto-migrates during config validation). Old saved configs with `enableJsonOutput: true` seamlessly upgrade to `translationWorkflow: 'json'` without user intervention.

- **Raised JSON workflow batch cap to 200 entries:** Increased the JSON structured workflow cap from 150 to 200 (`TranslationEngine`), so high-throughput models like `gemini-3-flash` now log and run at `400 -> 200` instead of `400 -> 150`.

- **MAL alias normalization (`myanimelist` -> `mal`):** Incoming IDs using `myanimelist:*` are normalized to the canonical `mal:*` path so they resolve through the same fast offline mapping.

- **TMDB-only offline crosswalks are now first-class:** Anime IDs that resolve offline to TMDB (but not IMDb) are now preserved and used in search/title flows instead of being treated as misses.

- **Optional season hint support from bundled mapping:** The resolver now carries mapping `season` metadata and can apply it to seasonless anime-episode IDs when `ANIME_SEASON_HINT_ENABLED=true`.

- **Safer canonical Stremio ID parsing:** Unknown prefixed IDs no longer fall through as pseudo-IMDb IDs; invalid/unknown prefixed formats now fail closed, reducing false-positive searches.

- **Cross-surface ID compatibility updates:** Stream-ID extraction and anime-ID recognition were expanded consistently in server and toolbox/sync/quick-nav generated pages for the same prefix set.

- **Redis refresh coordination hardened for multi-instance deployments:** Weekly mapping refresh leader election now uses atomic Redis `SET ... NX EX` lock acquisition when Redis is available, with existing standalone fallback preserved.

- **Linked stream title resolution unified across Toolbox/Sync surfaces:** Anime linked-title display in browser UIs is no longer effectively Kitsu-only. Client pages now call a server API resolver that supports all mapped anime ID platforms (`anidb`, `kitsu`, `mal`/`myanimelist`, `anilist`, `tvdb`, `simkl`, `livechart`, `anisearch`) through the offline resolver + Cinemeta fallback chain.

- **New metadata endpoint for linked-title resolution:** Added `GET /api/resolve-linked-title` for toolbox/sync UI title hydration. The endpoint validates config/session state, applies `no-store` caching headers, and returns normalized `{ title, season, episode }` metadata for a provided `videoId`.

- **Rate-limit keying improved for query-based config endpoints:** `searchLimiter` now keys on `req.query.config` in addition to params/body config sources, so GET metadata endpoints using query tokens are user/config scoped (not shared IP fallback).

**Bug Fixes:**

- **429/503 retry rotation now walks all remaining Gemini keys:** Translation retries for HTTP rate-limit/unavailable errors no longer stop after a single rotated-key attempt. When key rotation is enabled with multiple keys, the engine now retries across remaining keys (`keys - 1` max) before falling back. Rotation also stops early if the latest retry failure is no longer an HTTP retryable error.

- **JSON workflow now drives provider structured mode (not only deprecated toggle):** Fixed provider wiring so selecting `translationWorkflow: 'json'` reliably enables provider-side structured output behavior (with `enableJsonOutput` still accepted for backward compatibility). Previously, some paths only checked the deprecated flag, so JSON workflow could be selected while providers were still running in plain-text mode.

- **OpenAI-compatible structured output aligned to array contract + graceful downgrade:** Replaced `response_format: { type: 'json_object' }` with a strict `json_schema` that matches SubMaker's expected array of `{id,text}` entries. Added automatic one-shot retry without structured `response_format` when the model/base URL rejects structured output parameters.

- **Automatic JSON -> XML workflow fallback on hard failures:** Added batch-level XML fallback when JSON structured mode fails in practice (provider structured-capability errors, total JSON parse failure, or mismatch recovery ending with warning placeholders). This keeps translation progress moving with robust ID-based XML parsing instead of returning sparse/placeholder output.

- **JSON parser now accepts object envelopes in addition to arrays:** `parseJsonResponse()` now recovers from structured responses wrapped as objects (for example `{ "entries": [...] }`, `{ "items": [...] }`, `{ "data": [...] }`) rather than failing when a model returns an envelope instead of a raw array.

- **DeepL/Google native flow enforced as secondary fallback too:** DeepL and Google Translate were already forced to native/original flow when selected as main providers. Extended this behavior to secondary fallback usage: when either is secondary, fallback calls now send native SRT input with no JSON/XML prompt contract, preventing workflow-format mismatches in JSON-mode error recovery.

- **Fixed duplicate in-flight translations caused by config-hash drift during playback:** Some requests for the same subtitle/language pair could generate different user-scoped runtime keys (for example, `...__u_b955...` then `...__u_014e...`) when stream/runtime metadata changed between requests. This bypassed in-flight deduplication and started parallel background translations for the same job.

- **Stabilized translation cache identity by excluding volatile stream metadata from config hashing:** `computeConfigHash()` now ignores runtime-only fields (`lastStream`, `streamFilename`, `videoFilename`, `videoId`, `videoHash`, `streamUrl`, `linkedTitle`, `lastLinkedTitle`) so playback activity no longer changes bypass/partial cache namespaces mid-translation.

- **Fixed "Partial SAVED" logs with missing visible partials (key-split symptom):** Partial checkpoints were being persisted, but duplicate polls under a drifted hash looked in a different partial key and saw only loading/final output. With stable hash identity, partial reads and writes now remain in the same keyspace for the full translation lifecycle.

- **Eliminated misleading post-completion partial-save logs from parallel duplicate runs:** Logs like `Partial SAVED ... 331/392` or `392/392` after an earlier completion were emitted by a second duplicate translation still running under another runtime key. Preventing hash-drift duplicates removes this delayed second completion pattern.

- **Partial save deduplicated by payload fingerprint (not only counters):** Partial checkpoint persistence now hashes the generated partial SRT payload and skips writes when the payload is identical to the last saved snapshot. This removes redundant writes/logs when streaming and batch-end callbacks emit the same state (for example duplicate `392/392` saves), while still allowing legitimate updates with the same entry count.

- **In-flight duplicate polling now re-checks final cache before falling back to loading:** During active translations, duplicate/status paths now check final cache resolution (bypass/permanent) before serving partial/loading placeholders. This closes race windows where final output was already available but callers still received loading.

- **Duplicate route now resolves permanent-cache finals and cached errors consistently:** The `/addon/:config/translate/:sourceFileId/:targetLang` duplicate-request fast path now reads permanent cache (`t2s__...`) when bypass is not active, and serves cached translation errors (`isError`) for both bypass and permanent modes instead of falling through to loading.

- **Bypass duplicate reads now enforce configHash guards with explicit diagnostics:** Duplicate bypass-cache checks now log and ignore entries with missing/mismatched `configHash`, matching the same isolation guard behavior used in main translation cache reads.

- **Loading-vs-partial response classification corrected in translation route logs/headers:** Partial SRT payloads (multi-cue payloads with a `TRANSLATION IN PROGRESS` tail) are now classified as partial content rather than placeholder loading messages. This avoids misleading logs and keeps no-store behavior focused on true in-progress payload semantics.

- **Hardened file-upload route hash handling to preserve canonical scoped hash:** `/file-upload` no longer overwrites `config.__configHash` with an unscoped recompute when a canonical hash already exists from config resolution; it now only computes a fallback hash when missing. This keeps hash semantics aligned across routes.

- **Improved auto-sub merge logic for capitalized text:** The `shouldMergeAutoSubEntries` function no longer blocks merging when the next subtitle starts with a capital letter. Previously, any capital letter at the start prevented merging (treating it as a new sentence/speaker), but sentence boundaries are already caught by the punctuation check. Now only obvious speaker/section markers (`-–—♪`) block merging.

- **Reduced minimum subtitle duration from 1200ms to 800ms:** The `splitLongEntry` function now uses 800ms minimum slice duration instead of 1200ms, allowing more granular subtitle timing for fast-paced dialogue.

- **Fixed zero-duration subtitle entries:** Added explicit guard in `splitLongEntry` to prevent zero-duration entries — if `end <= start`, the end time is set to `start + 800ms`.

- **Ensured 800ms minimum duration in final SRT output:** The `normalizeAutoSubSrt` function now enforces a minimum 800ms duration for each subtitle entry during final processing, catching any edge cases missed earlier in the pipeline.

- **Resolved-title cache behavior hardened for transient metadata misses:** Title history resolution now uses short-lived negative caching for unresolved lookups (5 minutes) instead of letting unresolved states linger in the long-lived history title cache window.

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

- **Wyzie Subs integration:** Added support for [Wyzie Subs](https://sub.wyzie.io), a free, open-source subtitle aggregator that searches OpenSubtitles and SubDL simultaneously. Wyzie now requires an API key for search requests. Supports both IMDB and TMDB IDs, hearing impaired filtering, and automatic ZIP extraction (handled server-side by Wyzie). Includes comprehensive language code normalization and per-language result limiting to prevent overwhelming results.

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
