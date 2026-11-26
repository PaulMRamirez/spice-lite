# Changelog

The blob format is "SLB1", draft 0.1 (`SPEC.md`). Tags are `vX.Y.Z` on `main`.

## Unreleased

Documentation and examples:

- Guides that show use, each linked to the next and to an index (`docs/README.md`): getting started from a clone to a blob of your own running in a sequence, the slicer configuration option by option, the calls by the question each answers with what to do on every status, and the build commands with the memory budget.
- `examples/native/tour.c` makes every call once on a desktop (`pnpm tour`); `examples/getting-started/canberra.json` is the configuration the first guide cuts; `tools/blob-to-c.mjs` writes a blob as a C array, which `scripts/build-sequence.sh` now uses (the module it builds is byte for byte what it was).
- `test/docs.test.mjs` runs the tour, cuts the guide's blob, and checks every link and anchor between the documents.

## 0.2.0 (26 November 2026)

Additions to the blob format, each behind a header flag bit that an 0.1.0 library refuses, so no blob is misread; a blob that uses none of them is what it was, except that a TIME piece the slicer derives now carries its measured error where zeros were.

- TIME: each piece carries its own error bound (`max_err`); a piece may be a gap, which answers out of coverage and so gives a stretch of pieces an end (header flag bit 3; `refuseGaps` in the slicer); pieces may be selected by the F Prime time context as well as the time base, so a clock that was reset fits under one base (header flag bit 2; `context` in the slicer). `lite_fwtime2et` passes the context byte on. A time conversion costs 9 to 33 instructions more; the worst case is 454 of the 500 allowed.
- Checksum: a blob may carry Fletcher-32 in place of CRC-32 (header flag bit 4; `"checksum": "fletcher32"`), verified by the same module at 6.8 instructions per byte against 20.8. `SPEC.md` says what it does not detect.

Flight library:

- `lite_occulted_corr`: occultation with a light-time correction, which is `occult_c` with `LT` and agrees with it within a microsecond on the test events. Light time moves the contacts of the Earth hiding the Sun from the Moon by 40 to 44 seconds.
- Which of two bodies is in front is decided by a plane between them, exactly, where the tangent rule of 0.1.0 named the wrong body in up to one view in nine for bodies with axis ratios of five (`tools/front-rule-study.mjs`). No committed vector changed.
- The module is 28,432 bytes (26,601 in 0.1.0).
- The demonstration sequence built with this library was run again inside F Prime's WasmSequencer, in its unit-test harness: the same 59 events, command, and outcome as before.

Slicer:

- Two clock entries under one time base that cover the same readings are refused; they were accepted, and gave interleaved pieces.

## 0.1.0 (22 November 2026)

Flight library (`src/spice_lite.c`, `include/spice_lite.h`), import-free C99, one 64 KiB page as strict WebAssembly 1.0:

- States from Chebyshev (kinds 1 and 2), Hermite (kind 3), and compact orbit (kind 4) segments; orientation; sites, planetocentric or geodetic by a header flag; time from a host clock through sorted TIME pieces, including F Prime's time layout and Unix time.
- Geometry: site view, sub-point, and occultation with ellipsoids, plus `lite_occulted_shapes`, which reports how each body was modeled.
- A checksum with an optional build-time table; a one-link fast path for states.

Ground tools:

- `tools/slicer.mjs`, the reference slicer, through cspice-wasm. Clock pieces from an SCLK kernel or as Unix time, with records merged where the tolerance allows. `breaks` cut a body's records at named times; `findBreaks` finds burns and seams in the kernel and cuts there.
- Measurements on real mission kernels (LRO, MRO, MAVEN), fetched on demand and never committed, rerun weekly in CI.

Measured, with the figures in `SPEC.md` and `docs/`:

- Module size, heap, and instruction counts under SpaceWasm, each held to a ceiling by a script; the counts are the same on the interpreter version F Prime pins.
- The demonstration sequence run inside F Prime's WasmSequencer: in its unit-test harness, in the reference deployment against the real clock, and uplinked to an unmodified sequencer as a one-byte-page build.

Known limits, stated where they are measured: the compact orbit segment holds kilometers at a day and tens of meters at one to three hours on real orbits; nothing has run on a flight processor; the names "spice-lite" and "cspice-wasm" may change.
