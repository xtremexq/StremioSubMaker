# Changelog

All notable changes to this project will be documented in this file.

## SubMaker 1.3.4

**Infrastructure & Deployment:**
- Docker Hub Integration: Pre-built multi-platform images now available at [xtremexq/submaker](https://hub.docker.com/r/xtremexq/submaker)
- GitHub Actions: Automated Docker image publishing workflow for AMD64 and ARM64 platforms on release
- Docker Compose: Updated to use pre-built Docker Hub images by default for faster deployment
- Redis Configuration: Enhanced with connection timeouts (300s) and TCP keepalive (60s) for improved reliability
- Security: Improved .dockerignore to prevent encryption keys from being copied into Docker images
- Documentation: Complete rewrite of Docker deployment guide with Docker Hub examples and multiple deployment options

**Bug fixes:**
Multiple minor bug fixes

## SubMaker 1.3.3

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

## SubMaker 1.3.2

**Improvements:**

- Version-aware config migration on app update: resets model and advanced settings to defaults while preserving API keys, provider toggles, source/target languages, and Other Settings. Ensures new/removed config fields are immediately reflected after version change.
- Subtitles ranking improvements for all sources
- Many config page improvements

**Bug Fixes:**

- Fixed SubSource API key validation timing out: endpoint now reuses `SubSourceService` client (proper headers, pooled agents, DNS cache) and performs a single lightweight validation request with clearer error messages

## SubMaker 1.3.1

**Improvements:**

- Multiple changes and improvements to the config page.
- Season and episodes pack ZIP extraction: Prefer .srt over .ass/.ssa when both exist (SubSource & SubDL) to avoid unnecessary conversion and pick native SRT first

## SubMaker 1.3.0

**New Features:**
