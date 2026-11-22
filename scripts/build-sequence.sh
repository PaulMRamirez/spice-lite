#!/usr/bin/env bash
#
# Builds the demonstration sequence: examples/sequence/sun_watch.c, the library,
# and the sun-earth-moon blob as one WebAssembly module of strict Wasm 1.0 whose
# only imports are the F Prime WasmSequencer host calls it uses.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CC="${CC:-clang}"
LD="${WASM_LD:-wasm-ld}"
# SEQUENCE_OUT, SEQUENCE_BLOB, and SEQUENCE_DEFS (extra -D options for the
# sequence, such as -DCHECK_PERIOD_US=20000000ull) build a variant; left unset,
# the module is the one the tests and documents describe.
OUT="${SEQUENCE_OUT:-$ROOT/build/sun_watch.wasm}"
BLOB="${SEQUENCE_BLOB:-$ROOT/test/blobs/sun-earth-moon.slb}"
mkdir -p "$ROOT/build"
# The blob as a C array, 8-byte aligned so the library can read doubles in place.
node -e '
const fs = require("fs");
const b = fs.readFileSync(process.argv[1]);
let out = "#include <stdint.h>\n__attribute__((aligned(8))) const uint8_t sequence_blob[] = {\n";
for (let i = 0; i < b.length; i += 16) out += "  " + [...b.subarray(i, i + 16)].join(",") + ",\n";
out += "};\nconst uint32_t sequence_blob_len = " + b.length + "u;\n";
fs.writeFileSync(process.argv[2], out);
' "$BLOB" "$ROOT/build/sequence_blob.c"
# Compiled and linked as two steps so that clang never runs wasm-opt on the
# module (see scripts/build-wasm.sh).
OBJS=()
for src in "$ROOT/examples/sequence/sun_watch.c" "$ROOT/src/spice_lite.c" "$ROOT/build/sequence_blob.c"; do
  obj="$ROOT/build/sequence_$(basename "$src" .c).o"
  "$CC" --target=wasm32 -mcpu=mvp -O2 -std=c99 -ffreestanding -nostdlib -fno-builtin \
    -ffp-contract=off -fvisibility=hidden -Wall -Wextra -Werror -I"$ROOT/include" ${SEQUENCE_DEFS:-} -c -o "$obj" "$src"
  OBJS+=("$obj")
done
"$LD" --no-entry --strip-all -z stack-size=4096 --initial-memory=65536 -o "$OUT" "${OBJS[@]}"
rm -f "${OBJS[@]}"
echo "$OUT: $(wc -c < "$OUT") bytes"
