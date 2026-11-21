#!/usr/bin/env bash
#
# Builds the library as a bare WebAssembly module: strict Wasm 1.0 (-mcpu=mvp),
# freestanding, no libc, and no imports. The link fails if the code references
# anything outside itself, which is how "no imports" is enforced.
#
# Requires clang and wasm-ld with the WebAssembly backend. Override with CC.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CC="${CC:-clang}"
OUT="$ROOT/build/spice_lite.wasm"
mkdir -p "$ROOT/build"
"$CC" --target=wasm32 -mcpu=mvp -O2 -std=c99 -ffreestanding -nostdlib -fno-builtin \
  -ffp-contract=off -fvisibility=hidden -Wall -Wextra -Werror -I"$ROOT/include" \
  -Wl,--no-entry -Wl,--export-dynamic -Wl,--export=__heap_base -Wl,--strip-all \
  -Wl,-z,stack-size=4096 -Wl,--initial-memory=65536 \
  -o "$OUT" "$ROOT/src/spice_lite.c"
echo "$OUT: $(wc -c < "$OUT") bytes"
