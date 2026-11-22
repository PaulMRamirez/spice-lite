# Changelog

The blob format is "SLB1", draft 0.1 (`SPEC.md`). Tags are `vX.Y.Z` on `main`.

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
