# spice-lite

A small, import-free C library that answers spacecraft geometry questions onboard from one compact, read-only blob. It is built for sequences that run inside a WebAssembly interpreter such as NASA JPL's SpaceWasm under the F Prime WasmSequencer, where full SPICE cannot fit: full CSPICE needs 96.5 MiB of memory as a guest, and this library needs one 64 KiB page.

This is an independent, personal open-source project at draft 0.1. It is not a product of, and is not endorsed by, NAIF, NASA, JPL, or Caltech, and it has not flown. Treat it as a design under test, not as flight software.

## What it does

A ground tool (the slicer) reads full SPICE kernels, cuts a mission window, and writes a blob of fixed-width tables with measured error bounds. Onboard, a sequence links this library, points it at the blob, and asks questions:

```c
#include "spice_lite.h"

if (lite_init(blob, blob_len, 0) != LITE_OK) fail();
fprime_wasm_get_time(buf, 11);
if (lite_fwtime2et(buf, 11, &et) != LITE_OK) fail();
if (lite_site_view(SITE_A, SUN, et, LITE_NONE, &az, &el, &range) != LITE_OK) fail();
if (el > MIN_SUN_ELEVATION) take_image();
```

The 0.1 library provides time conversion from the host clock, states of bodies in J2000 (geometric, light-time corrected, and with stellar aberration), body orientation, azimuth and elevation from surface sites, the point on a body beneath an observer with the altitude above it, whether one body hides another (each body as its ellipsoid where the blob gives it an orientation, as a sphere otherwise), and the spacecraft's own state from either a predicted trajectory in the blob or a state the sequence supplies from onboard navigation. A compact orbit segment (elements, rates, and harmonic terms in 160 bytes per record) covers long arcs of a closed orbit; on synthetic orbiters (a point mass plus J2) one record per day holds meters, but on real ones (LRO, MRO, MAVEN) it holds kilometers, because the model has no term for a rotating gravity field; `docs/orbit-segment.md` has the measurements and `docs/real-kernels.md` the kernels. The slicer can derive the clock conversion from a spacecraft clock (SCLK) kernel to a stated tolerance, and does so within a microsecond on the real clocks of those three spacecraft. `SPEC.md` is the format and behavior specification, including what is declared but not yet implemented.

## Properties, as measured

The module is about 24 KB of strict WebAssembly 1.0 with no imports (24,328 bytes with the author's clang 18; the CI runner's build, which lacks binaryen's `wasm-opt`, is 7% larger and gives identical answers) and declares one page of memory. A 13 KB blob holding a month of Sun, Earth, and Moon geometry sits beside it in that page with 45 KB to spare, and the pair loads and runs under the SpaceWasm interpreter. It uses no heap and no libc. The same blob and query give bit-identical results in the WebAssembly build and a native x86-64 build. Against full CSPICE, natural-body positions in the test blob agree to under a millimeter, and every answer in the accuracy tests falls within the error bounds the blob declares. 200,000 corrupted blobs run under AddressSanitizer and UndefinedBehaviorSanitizer without a fault.

Under the SpaceWasm interpreter a geometric state costs about 1,700 to 2,000 instructions per segment on the path (two to five sequencer slices in practice), a state with light time and stellar aberration 6,500 to 9,600, and a clock conversion 110 to 140 for the usual one or two clock pieces, staying under 310 with two hundred (the pieces are sorted and searched). Full CSPICE takes 31,660 and 81,606 for the same two state queries. Verifying the blob's checksum at start-up is the costly step, at about 21 instructions per byte with the default table (276 slices for the 13 KB blob); a build option trades table space for speed, and `docs/cost-measurements.md` has the tables.

## A sequence, end to end

`examples/sequence/sun_watch.c` is a demonstration sequence: it waits at a ground site until the Sun is above 10 degrees, then commands an image. Built with the library and a 13 KB blob it is one 29,582-byte module that imports only the F Prime WasmSequencer's host calls and fits in one page. Run in the SpaceWasm interpreter over a simulated clock, it waits through the night and images at the first check where full CSPICE agrees the Sun has cleared the threshold, at about 7,200 instructions (8 sequencer slices) per decision. `docs/sequence-demo.md` has the run.

## Layout

`include/spice_lite.h` and `src/spice_lite.c` are the whole flight library. `tools/slicer.mjs` is the reference slicer and `tools/make-vectors.mjs` regenerates the exactness vectors. `test/` holds the WebAssembly harness, the native driver, six test blobs with their configurations and reports (a large one with a spacecraft trajectory and a small flight-shaped one), and the test tiers. `scripts/` holds the two build scripts, the strict Wasm 1.0 checker, and the cost measurement, whose SpaceWasm host harness is in `bench/spacewasm-host`.

## Building and testing

`bash scripts/build-wasm.sh` needs clang and wasm-ld with the WebAssembly backend. `bash scripts/build-native.sh` needs a C compiler with the sanitizer runtimes (set `NATIVE_CC`). `pnpm install` then `pnpm verify` builds both and runs the tests under Node 22.

The accuracy tier and the slicer need four public kernels (`naif0012.tls`, `pck00011.tpc`, a DE440 subset, and a Cassini trajectory), which are not committed here. They are the test fixtures of the cspice-wasm repository; point `SPICE_LITE_KERNELS` at that directory. Without it the accuracy tests are skipped and say so. `pnpm slice` rebuilds the test blob, and CI checks that the committed blob and vectors are reproducible.

## Using it in a sequence

Compile `src/spice_lite.c` with your sequence, with floating-point contraction off (`-ffp-contract=off`) so results stay bit-identical across hosts. Place the blob in the module's data section, 8-byte aligned, and call `lite_init` once. One blob is active at a time. Raise the sequencer's guest memory to hold the blob; the F Prime default of 8,192 bytes is too small.

## License

Apache-2.0; see `LICENSE` and `NOTICE`.
