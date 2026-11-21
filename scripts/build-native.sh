#!/usr/bin/env bash
#
# Builds the native test driver twice: plain, for the cross-host exactness
# check, and with AddressSanitizer and UndefinedBehaviorSanitizer, for the
# robustness run over corrupted blobs. Uses NATIVE_CC (default cc); the compiler
# needs its sanitizer runtime installed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CC="${NATIVE_CC:-cc}"
mkdir -p "$ROOT/build"
FLAGS=(-std=c99 -O2 -ffp-contract=off -fno-math-errno -Wall -Wextra -Werror -I"$ROOT/include")
"$CC" "${FLAGS[@]}" -o "$ROOT/build/driver" "$ROOT/src/spice_lite.c" "$ROOT/test/driver.c" -lm
"$CC" "${FLAGS[@]}" -g -fsanitize=address,undefined -fno-sanitize-recover=all \
  -o "$ROOT/build/driver-san" "$ROOT/src/spice_lite.c" "$ROOT/test/driver.c" -lm
echo "built build/driver and build/driver-san"
