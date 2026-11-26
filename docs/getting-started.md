# Getting started

[Documentation index](README.md) · Next: [Cutting a blob](slicer.md)

This page takes you from a fresh clone to a sequence that carries a blob you cut yourself and makes a decision from geometry inside the SpaceWasm interpreter. Every command below was run as written, and the outputs shown are what they printed.

The path has two halves. On the ground, the slicer reads SPICE kernels and writes a blob. Onboard, your sequence links the library, points it at the blob, and asks questions.

```
 kernels + config.json ──► tools/slicer.mjs ──► blob (.slb) ──┐
                                                              ├─► one .wasm module ──► sequencer
 your_sequence.c + src/spice_lite.c ──────────────────────────┘
```

## 1. Install and verify

You need Node 22 with pnpm, clang and wasm-ld with the WebAssembly backend (clang 18 is what CI uses), and a C compiler with the sanitizer runtimes. Step 7 also needs Rust, for the interpreter harness.

```
pnpm install
pnpm verify
```

`pnpm verify` builds the library as WebAssembly and natively, then runs the tests. Without kernels the accuracy tests are skipped and say so; everything else runs.

## 2. Watch the library answer questions

No kernels are needed for this step: the repository carries test blobs.

```
pnpm tour
```

```
time      host 302400 s -> ET 141868864.184
state     Moon from Earth: -117063.744 -304790.502 -150316.924 km
state     Sun from Earth, apparent: light time 507.315 s, source 0
site      Sun from site 2: azimuth 54.99 deg, elevation -7.05 deg
orient    Moon in the Earth-fixed frame: -283359.845 162151.193 -150368.004 km
subpoint  under the Moon: longitude 150.22 deg, latitude -24.59 deg, altitude 353064.5 km
craft     predicted: 750742.6 km from Saturn's barycenter, source 1
craft     supplied state in use (source 2), 4.939 km from the prediction
status    four refusals, each with the status the header documents
occult    Saturn hides the Sun from minute 937 to minute 968 of the day
occult    code 3, Sun modeled as shape 0, Saturn as shape 1
occult    Earth behind Saturn at mid-window: code 0
tour complete
```

That is [`examples/native/tour.c`](../examples/native/tour.c): every call of the library once, built with your desktop compiler. [Calling the library](api.md) walks through it one question at a time.

## 3. Get the kernels

The slicer reads full SPICE kernels, which are not committed here. The four the examples use are the test fixtures of the cspice-wasm repository:

```
git clone https://github.com/PaulMRamirez/cspice-wasm _kernels-src
export SPICE_LITE_KERNELS=$PWD/_kernels-src/test/fixtures
```

`_kernels-src/` is ignored by git. The directory must hold `naif0012.tls` (leap seconds), `pck00011.tpc` (body sizes and orientations), `de440s-inner-cassini.bsp` (a subset of the DE440 planetary ephemeris, covering mid-2004), and `cassini-soi.bsp` (a Cassini trajectory). For your own mission, put your own kernels in any directory and point `SPICE_LITE_KERNELS` at it.

With the variable set, `pnpm test` runs the accuracy tests too.

## 4. Describe what the sequence will need

A blob holds only what a configuration asks for. [`examples/getting-started/canberra.json`](../examples/getting-started/canberra.json) asks for the Sun and the Earth for a week, one ground site, and a clock:

```json
{
  "name": "canberra",
  "kernels": ["naif0012.tls", "pck00011.tpc", "de440s-inner-cassini.bsp"],
  "window": { "start": "2004-07-01T00:00:00", "stop": "2004-07-08T00:00:00" },
  "bodies": [
    { "id": 0, "parent": null },
    { "id": 3, "parent": 0, "interval": 604800, "degree": 10 },
    { "id": 10, "parent": 0, "interval": 604800, "degree": 8, "radiiFrom": "SUN" },
    { "id": 399, "parent": 3, "interval": 345600, "degree": 12, "radiiFrom": "EARTH" }
  ],
  "orient": [
    { "body": 399, "frame": "IAU_EARTH", "interval": 604800, "degree": 3 }
  ],
  "sites": [
    { "id": 1, "body": 399, "lonDeg": 148.98, "latDeg": -35.40, "altKm": 0.69 }
  ],
  "time": [
    { "base": 3, "hostStart": 0, "etOffset": 0, "rate": 1.0 }
  ]
}
```

Reading it from the top:

- **`window`** is the span the blob answers for. A query for a time its tables do not reach returns `LITE_OUT_OF_COVERAGE`.
- **`bodies`** is a tree, by NAIF code. Each body is stored relative to its `parent`, as polynomials of the given `degree` over records `interval` seconds long. The Earth (399) hangs from the Earth-Moon barycenter (3), which hangs from the solar system barycenter (0). A root of 0 is what makes light-time corrections available.
- **`orient`** gives a body a rotation, which a site on it needs.
- **`sites`** are surface points, each with a number of your choosing that the sequence will pass to `lite_site_view`.
- **`time`** says how to turn the host clock into ET. This entry says: under time base 3, a reading of 0 seconds is the window start, and the clock runs at one second per second. A real mission derives this from its SCLK kernel or from Unix time instead ([Cutting a blob: time](slicer.md#time-the-host-clock)).

[Cutting a blob](slicer.md) documents every option.

## 5. Cut the blob

```
node tools/slicer.mjs examples/getting-started/canberra.json build/canberra.slb build/canberra.report.json
```

```
build/canberra.slb: 2552 bytes
  ephem 3 wrt 0: 1 records, degree 10, 264 bytes, max error 4.30e-7 km, 6.06e-11 km/s
  ephem 10 wrt 0: 1 records, degree 8, 216 bytes, max error 1.23e-9 km, 1.74e-13 km/s
  ephem 399 wrt 3: 2 records, degree 12, 624 bytes, max error 2.09e-9 km, 6.80e-13 km/s
  orient 399: 1 records, degree 3, 96 bytes, max error 3.83e-12 rad
```

The blob is 2.5 KB. The errors are measured, not estimated: after fitting each segment the slicer compares it with CSPICE on a denser grid and writes the worst difference into the blob. Here every position is within half a millimeter of the kernels. If an error is larger than you want, shorten that body's `interval` or raise its `degree` and cut again.

## 6. Build a sequence around it

The demonstration sequence, [`examples/sequence/sun_watch.c`](../examples/sequence/sun_watch.c), waits at a site until the Sun is 10 degrees up and then commands an image. Its core is five calls:

```c
if (lite_init(sequence_blob, sequence_blob_len, 0) != LITE_OK) { /* report, exit */ }
for (check = 0; check < MAX_CHECKS; check++) {
    fprime_wasm_get_time((uint32_t)(uintptr_t)now, FW_TIME_SIZE);
    if (lite_fwtime2et(now, FW_TIME_SIZE, &et) != LITE_OK ||
        lite_site_view(SITE_ID, SUN, et, LITE_NONE, &az, &el, &range) != LITE_OK) {
        /* Outside the blob's coverage, or no geometry: stop, do not guess. */
    }
    if (el >= MIN_ELEVATION_RAD) { /* command the image, exit */ }
    fprime_wasm_rsleep(CHECK_PERIOD_US);
}
```

Build it with your blob and your site number in place of the defaults:

```
SEQUENCE_BLOB=$PWD/build/canberra.slb SEQUENCE_OUT=$PWD/build/canberra_watch.wasm \
  SEQUENCE_DEFS="-DSITE_ID=1" bash scripts/build-sequence.sh
```

```
build/canberra_watch.wasm: 21962 bytes
```

That one file is the sequence, the library, and the blob: 22 KB of strict WebAssembly 1.0 that imports only the sequencer's host calls and declares one 64 KiB page. [Building it into a sequence](building.md) explains each compiler and linker option, for when you build your own.

## 7. Run it in the SpaceWasm interpreter

`pnpm build:host` builds a small harness around NASA JPL's SpaceWasm interpreter (it needs Rust). Its `--sequence` mode stands in for the F Prime WasmSequencer's host calls over a simulated clock, and prints one JSON line per event, command, and sleep.

```
pnpm build:host
bench/spacewasm-host/target/release/spice-lite-spacewasm-host --sequence \
  --module build/canberra_watch.wasm --start-seconds 36000
```

The clock starts 36,000 seconds into the window: 10:00 UTC on 1 July, which is 20:00 in Canberra. The first and last lines of the output:

```
{"kind":"load","module_bytes":21962,"ir_bytes":29484,"heap_bytes":43878,"guest_memory_bytes":65536}
{"kind":"event","host_seconds":36000.000000,"instructions_since_sleep":61594,"severity":6,"text":"sun_watch: waiting, sun elevation deg -35.34"}
{"kind":"sleep","host_seconds":36000.000000,"instructions_since_sleep":61601,"sleep_seconds":600.000000}
...
{"kind":"event","host_seconds":80400.000000,"instructions_since_sleep":7025,"severity":5,"text":"sun_watch: imaging, sun elevation deg 10.43"}
{"kind":"command","host_seconds":80400.000000,"instructions_since_sleep":7037,"bytes":"00001001"}
{"kind":"exit","code":0,"host_seconds":80400.000000,"sleeps":74,"instructions_total":583910,"instructions_since_sleep":7042}
```

The sequence slept 74 times through the night and commanded its image at 22:20 UTC, which is 08:20 on a winter morning at the site, when the Sun first stood above 10 degrees. Nothing in it was told when that would be. The first cycle cost 61,594 interpreter instructions, nearly all of it `lite_init` verifying the blob's checksum; each later decision cost about 7,000.

## 8. Where to go next

- **Your own bodies, sites, clock, or spacecraft:** [Cutting a blob](slicer.md).
- **Your own questions:** [Calling the library](api.md), including what a sequence should do with each status.
- **Your own sequence source:** [Building it into a sequence](building.md).
- **A real deployment:** [Running inside F Prime](fprime-integration.md) lists what the WasmSequencer must be configured with. The default guest memory of 8,192 bytes is too small.

This project is at draft 0.1 and has not flown. `SPEC.md` lists what is declared but not yet implemented and what is still open.

---

[Documentation index](README.md) · Next: [Cutting a blob](slicer.md)
