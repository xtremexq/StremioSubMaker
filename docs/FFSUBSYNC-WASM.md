# FFSUBSYNC WebAssembly Plan for SubMaker xSync

Design for replacing the current alass-based sync path with a WASM build of ffsubsync that aligns subtitles directly to audio inside the MV3 background service worker.

## Goals and Constraints
- Input: raw PCM (Float32/Int16) or WAV/Blob plus an SRT string; no secondary reference SRT required.
- MV3/CSP-safe: no `eval`/`new Function`, no dynamic imports that fall back to `eval`.
- Service worker friendly: small, deterministic initialization; allow streaming input to avoid multi-hundred-MB buffers.
- Performance: target <10 MB wasm payload (stripped/optimized) and <500 ms init on desktop; align a 2–5 min clip in a few seconds.
- Reuse existing assets: decode via bundled ffmpeg.wasm; persist nothing except optional caches already used by xSync.

## Core Algorithm (ffsubsync)
Reference: https://github.com/smacke/ffsubsync#how-it-works
- Resample audio to 16 kHz mono; split into 10 ms frames.
- Run VAD per frame (WebRTC VAD) -> binary speech mask A.
- Convert subtitle intervals to the same 10 ms grid -> binary mask B.
- Compute best offset between A and B via FFT-based cross-correlation (O(n log n)).
- Optional framerate search (golden-section or discrete ratios) to correct drift.
- Output: offset (ms), drift ratio, confidence, and a rewritten SRT.

## WASM Implementation Outline
- Language: Rust (`wasm32-unknown-unknown`) with `wasm-bindgen` (no-modules target). Alternatives: Emscripten+CPP is possible but Rust keeps the toolchain smaller and avoids `eval`.
- Dependencies:
  - `webrtc-vad` C library compiled into Rust via `cc` crate or `webrtc-vad-sys` crate.
  - FFT: `rustfft` + `realfft` for real-valued FFT; supports power-of-two padding.
  - SRT parsing/rendering: lightweight Rust parser (custom or `subparse`); ensure pure-Rust, no `std::fs`.
  - Resampling: simple linear or `rubato`/`speexdsp` optional; prefer JS-side resample to 16 kHz to keep wasm small.
- Exported API (via `wasm-bindgen`):
  ```rust
  #[wasm_bindgen]
  pub struct FfsubsyncResult {
      pub offset_ms: i32,
      pub drift: f32,           // 1.0 = none
      pub confidence: f32,      // 0..1 score
      pub segments_used: u32,   // speech segments counted
      pub srt: String,          // shifted SRT text
  }

  #[wasm_bindgen]
  pub struct FfsubsyncOptions {
      pub frame_ms: u16,        // default 10
      pub max_offset_ms: u32,   // default 60000
      pub gss: bool,            // enable golden-section drift search
      pub sample_rate: u32,     // audio SR; expect 16000
      pub use_webrtc_aggressiveness: u8, // 0..3
  }

  #[wasm_bindgen]
  pub fn align_pcm(pcm: &[i16], opts: &FfsubsyncOptions, srt: &str) -> Result<FfsubsyncResult, JsValue>;

  #[wasm_bindgen]
  pub fn align_wav(wav_bytes: &[u8], opts: &FfsubsyncOptions, srt: &str) -> Result<FfsubsyncResult, JsValue>;
  ```
- Initialization: expose `init()` that accepts `{ wasmPath }` and returns `{ alignPcm, alignWav, version }`.
- Memory/size: `cargo build -Z build-std=panic_abort --target wasm32-unknown-unknown -r`, then `wasm-bindgen --target no-modules --omit-default-module-path`, then `wasm-opt -Oz --strip-dwarf --strip-producers`.

## JS Glue (assets/lib/ffsubsync-wasm.js)
- Role: MV3-safe loader that:
  - Resolves `ffsubsync_bg.wasm` URL via `chrome.runtime.getURL`.
  - Fetches/streams the wasm binary (ArrayBuffer) and calls the generated `init`.
  - Normalizes inputs: accepts `Blob|ArrayBuffer|TypedArray` for audio; accepts string SRT; ensures 16 kHz mono by resampling through the already-bundled `ffmpeg` worker if needed.
  - Exposes a promise-returning API:
    ```js
    const ffsubsync = await SubMakerFfsubsync.init({ wasmPath });
    const res = await ffsubsync.align({
      audio: blobOrBuffer,
      srtText,
      options: {
        frameMs: 10,
        maxOffsetMs: 60000,
        vadAggressiveness: 2,
        gss: false,
        sampleRate: 16000
      },
      onProgress // optional callback (0-100)
    });
    ```
  - No `eval`, no dynamic `import()`; uses `importScripts` fallback only when available.
- Caches a single wasm instance; guards against concurrent init; surfaces meaningful errors.

## Build Pipeline (proposed `scripts/build-ffsubsync-wasm.sh`)
1. Prereqs: Rust stable, `wasm32-unknown-unknown` target, `wasm-bindgen-cli`, `binaryen` (`wasm-opt`).
2. Vendor deps:
   - Add `native/webrtc_vad/` with upstream C sources; hook via `cc::Build`.
   - Add minimal `srt` parser in `crates/ffsubsync-wasm/src/srt.rs`.
3. Compile:
   ```bash
   export RUSTFLAGS="-C opt-level=z -C lto=fat -C panic=abort"
   cargo build --target wasm32-unknown-unknown --release -p ffsubsync-wasm
   wasm-bindgen --target no-modules --out-dir SubMaker\\ xSync\\assets\\lib --omit-default-module-path target\\wasm32-unknown-unknown\\release\\ffsubsync_wasm.wasm
   wasm-opt -Oz --strip-dwarf --strip-producers -o SubMaker\\ xSync\\assets\\lib\\ffsubsync_bg.wasm SubMaker\\ xSync\\assets\\lib\\ffsubsync_bg.wasm
   ```
4. Outputs to ship: `ffsubsync-wasm.js` (custom loader wrapper), `ffsubsync_wasm.js` (bindgen glue), `ffsubsync_wasm_bg.wasm`.

## Integration into xSync
- Manifest: add the three new assets to `web_accessible_resources`.
- Background worker (`scripts/background/background.js`):
  - Add a lazy loader `getFfsubsync()` mirroring `getAlass()`.
  - Implement `runFfsubsyncSync(audioBlob, subtitleContent, opts)` using:
    - audio extraction/resample path already used for Whisper/alass.
    - progress updates: load (10%), resample (20%), VAD (40%), correlation (70%), rewrite SRT (90%).
  - Branch selection:
    - Preferred path: ffsubsync-first (audio+SRT only, no Whisper needed).
    - Fallbacks: if wasm load fails, drop to existing heuristic or alass branch.
- Options/UI (`pages/options`, `pages/popup`):
  - Add selector for aligner: `ffsubsync (audio)`, `alass (two SRTs)`, `heuristic`.
  - Add toggles for VAD aggressiveness, max offset, framerate search.
- Logging/telemetry: reuse `logToPage`; include `segments_used`, `confidence`.
- Offscreen: reuse existing offscreen audio extraction; ensure max chunk limits are honored.

## Testing and Validation
- Unit tests (Node + `wasm-bindgen-test`):
  - Align known WAV+SRT pairs with known offsets; assert offset within 10 ms.
  - Drift search cases with synthetic time-stretch.
  - VAD edge cases: silence-only, music, noisy backgrounds.
- Integration tests (service worker):
  - Load wasm via `importScripts` and via fetch fallback.
  - Run on a 60 s clip to ensure memory stays <256 MB and completes <5 s on desktop.
- Fixture sources: 10–30 s WAV snippets in `data/test/ffsubsync/`; matching SRT with intentional offset.

## Open Questions / Next Decisions
- Do we prefer JS-side resampling (ffmpeg) vs wasm-side (speexdsp) for size/perf tradeoff?
- Should ffsubsync become the default path once available, or user opt-in until size is validated?
- Need target size budget for `ffsubsync_bg.wasm` (goal <5–7 MB after `wasm-opt`).
