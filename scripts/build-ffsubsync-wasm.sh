#!/usr/bin/env bash
set -euo pipefail

# Build pipeline for ffsubsync-wasm artifacts consumed by SubMaker xSync.
# Outputs (after successful build):
#   SubMaker xSync/assets/lib/ffsubsync-wasm.js   (custom loader wrapper)
#   SubMaker xSync/assets/lib/ffsubsync.js        (wasm-bindgen glue, no-modules)
#   SubMaker xSync/assets/lib/ffsubsync_bg.wasm   (optimized wasm)
#
# Prereqs:
#   - rustup target add wasm32-unknown-unknown
#   - cargo install -f wasm-bindgen-cli
#   - binaryen (wasm-opt) available on PATH
#   - webrtc-vad sources vendored under native/ffsubsync-wasm (TODO in impl)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE_DIR="${ROOT_DIR}/native/ffsubsync-wasm"
OUT_DIR="${ROOT_DIR}/SubMaker xSync/assets/lib"

echo "Building ffsubsync-wasm (release)..."
pushd "${CRATE_DIR}" >/dev/null
cargo build --target wasm32-unknown-unknown --release
popd >/dev/null

WASM_IN="${CRATE_DIR}/target/wasm32-unknown-unknown/release/ffsubsync_wasm.wasm"
if [ ! -f "${WASM_IN}" ]; then
  echo "WASM not found at ${WASM_IN}"
  exit 1
fi

mkdir -p "${OUT_DIR}"

echo "Running wasm-bindgen..."
wasm-bindgen \
  --target no-modules \
  --omit-default-module-path \
  --out-dir "${OUT_DIR}" \
  "${WASM_IN}"

if command -v wasm-opt >/dev/null 2>&1; then
  echo "Optimizing with wasm-opt..."
  wasm-opt -Oz --strip-dwarf --strip-producers \
    -o "${OUT_DIR}/ffsubsync_bg.wasm" \
    "${OUT_DIR}/ffsubsync_bg.wasm"
else
  echo "wasm-opt not found; skipping Binaryen optimization (install binaryen to enable)."
fi

echo "Done. Artifacts in ${OUT_DIR}"
