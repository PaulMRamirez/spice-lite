#!/usr/bin/env bash
#
# Builds the library as a bare WebAssembly module: strict Wasm 1.0 (-mcpu=mvp),
# freestanding, no libc, and no imports. The link fails if the code references
# anything outside itself, which is how "no imports" is enforced.
#
# Requires clang and wasm-ld with the WebAssembly backend. Override with CC and
# WASM_LD.
# WASM_OUT and WASM_INITIAL_MEMORY let the cost measurement build a variant with
# room for a large test blob; the shipped module declares one page.
# LITE_CRC_TABLES (0, 1, or 4; default 1) picks the checksum table size.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CC="${CC:-clang}"
LD="${WASM_LD:-wasm-ld}"
OUT="${WASM_OUT:-$ROOT/build/spice_lite.wasm}"
INITIAL_MEMORY="${WASM_INITIAL_MEMORY:-65536}"
mkdir -p "$ROOT/build"
# Compile and link as two steps. Asked to link, clang runs binaryen's wasm-opt on
# the module whenever it finds one on the PATH, so the same source came out
# 7% smaller and a few percent cheaper on machines that had it than on those
# that did not (CI among them). Calling wasm-ld directly leaves wasm-opt out
# everywhere: the module depends on the compiler and linker and nothing else.
"$CC" --target=wasm32 -mcpu=mvp -O2 -std=c99 -ffreestanding -nostdlib -fno-builtin \
  -ffp-contract=off -fvisibility=hidden -DLITE_CRC_TABLES="${LITE_CRC_TABLES:-1}" -Wall -Wextra -Werror -I"$ROOT/include" \
  -c -o "$OUT.o" "$ROOT/src/spice_lite.c"
"$LD" --no-entry --export-dynamic --export=__heap_base --strip-all \
  -z stack-size=4096 --initial-memory="$INITIAL_MEMORY" -o "$OUT" "$OUT.o"
rm -f "$OUT.o"
echo "$OUT: $(wc -c < "$OUT") bytes"
