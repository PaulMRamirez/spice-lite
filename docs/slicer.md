# Cutting a blob

[Documentation index](README.md) · Previous: [Getting started](getting-started.md) · Next: [Calling the library](api.md)

The slicer is the ground tool that turns SPICE kernels into the blob a sequence carries. You give it a JSON configuration that names the kernels, a time window, and what the sequence will ask about; it fits compact tables, measures them against CSPICE, and writes the blob with those measured errors inside.

This page is the reference for that configuration. `SPEC.md` defines the bytes the slicer writes; you do not need it to use the slicer.

- [Running it](#running-it)
- [A minimal configuration](#a-minimal-configuration)
- [Top-level members](#top-level-members)
- [Bodies](#bodies)
- [Orientation](#orientation)
- [Sites](#sites)
- [Time: the host clock](#time-the-host-clock)
- [A spacecraft](#a-spacecraft)
- [Size and accuracy](#size-and-accuracy)
- [Reading the output and the report](#reading-the-output-and-the-report)
- [What each call needs from the blob](#what-each-call-needs-from-the-blob)
- [Limits](#limits)
- [Errors the slicer raises](#errors-the-slicer-raises)

## Running it

```
node tools/slicer.mjs <config.json> <out.slb> [report.json]
```

Kernel names in the configuration are looked up in the directory named by the `SPICE_LITE_KERNELS` environment variable, or, if it is not set, in a `kernels/` directory beside the configuration file. A name that starts with `./` or `../` is a path relative to the configuration file instead. [Getting started, step 3](getting-started.md#3-get-the-kernels) says where the example kernels come from.

The slicer is ground software. It runs full CSPICE (through cspice-wasm) and takes seconds to minutes. If it cannot meet what the configuration asks, it fails with a message and writes no blob.

From JavaScript, `import { slice } from './tools/slicer.mjs'` and call `await slice(config, kernelDir)`, which returns `{ blob, report }`.

## A minimal configuration

A blob needs one root body and at least one body below it. This is the smallest useful shape, from [`examples/getting-started/canberra.json`](../examples/getting-started/canberra.json):

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
  "orient": [ { "body": 399, "frame": "IAU_EARTH", "interval": 604800, "degree": 3 } ],
  "sites": [ { "id": 1, "body": 399, "lonDeg": 148.98, "latDeg": -35.40, "altKm": 0.69 } ],
  "time": [ { "base": 3, "hostStart": 0, "etOffset": 0, "rate": 1.0 } ]
}
```

The seven configurations in [`test/blobs/`](../test/blobs) are further worked examples; each has a `comment` that says what it is for.

## Top-level members

| Member | Required | Meaning |
| --- | --- | --- |
| `name` | yes | A label, recorded in the blob's provenance and in the report |
| `kernels` | yes | The kernel files to load, in order. A leapseconds kernel is always needed; a PCK for `radiiFrom` and `orient`; an SPK for every body; an SCLK kernel for a clock entry |
| `window` | yes | `{ "start": ..., "stop": ... }`, each a time string CSPICE's `str2et` accepts (UTC unless the string says otherwise). The span the blob answers for |
| `bodies` | yes | The body tree: see [Bodies](#bodies) |
| `orient` | no | Body rotations: see [Orientation](#orientation) |
| `sites` | no | Surface points: see [Sites](#sites) |
| `geodeticSites` | no | `true` reads every site's latitude and altitude as geodetic: see [Sites](#sites) |
| `time` | no | Host clock to ET: see [Time](#time-the-host-clock). Without it the sequence must get ET some other way |
| `checksum` | no | `"crc32"` (the default) or `"fletcher32"`, which `lite_init` verifies about three times faster but which detects less (`SPEC.md` says what it misses; [cost](cost-measurements.md#checksum-options)) |
| `created` | no | A time string written into the header as the blob's creation time. Defaults to the window start, so that the same configuration always gives the same bytes |
| `comment` | no | Ignored by the slicer; for the reader |
| `synthetic` | no | Test use only: trajectories the slicer integrates itself (`tools/synth-orbiter.mjs`) |

## Bodies

`bodies` is a list. Each entry is a body, known by its NAIF code, stored relative to a parent body that is also in the list. Exactly one entry has `"parent": null`: the root. A query between any two bodies walks the tree from each up to where they meet.

```json
{ "id": 301, "parent": 3, "interval": 345600, "degree": 12, "radiiFrom": "MOON" }
```

| Member | Meaning |
| --- | --- |
| `id` | NAIF code of the body. The sequence passes this number to the library |
| `parent` | NAIF code of the body it is stored relative to, or `null` for the root |
| `interval` | Length of one record, in seconds |
| `degree` | Degree of the Chebyshev polynomials in each record, at most 40 |
| `radiiFrom` | A body name whose radii are read from the PCK (`"EARTH"`, `"SATURN"`). Needed for sub-points, occultation, and sites on the body. The name need not match `id`: a barycenter can borrow its planet's radii |
| `window` | A narrower `{ "start", "stop" }` for this body alone, for a short predicted trajectory inside a long blob |
| `checks` | How many points per record the fit is measured at, besides the fit nodes. Default 24 |
| `spacecraft`, `predicted`, `noSegment`, `model`, `breaks`, `findBreaks` | See [A spacecraft](#a-spacecraft) |

Choosing the tree:

- **Root it at 0, the solar system barycenter, if any query will use light time or stellar aberration** (`LITE_LT`, `LITE_LT_S`). The library refuses those corrections in a blob rooted anywhere else.
- **Root it at a planet or moon for a smaller blob** that needs geometric states only. `test/blobs/orbiter.json` is rooted at the Earth-Moon barycenter.
- **Give each body the parent it moves most simply around.** The Moon relative to the Earth-Moon barycenter is a small smooth curve; relative to the Sun it is not. Follow the kernel's own structure: planets and barycenters from 0, moons and planet centers from their barycenter, a spacecraft from the body it orbits.
- **Every step up the tree costs about 1,500 interpreter instructions per query**, so do not add levels the kernels do not need.

Records are whole: the slicer writes as many as cover the window, so the last one can reach past `stop`, and the kernels must cover that overhang. With a week's window and a record of 345,600 seconds (four days), two records cover eight days.

## Orientation

An `orient` entry gives a body its rotation from J2000 to a body-fixed frame.

```json
{ "body": 399, "frame": "IAU_EARTH", "interval": 864000, "degree": 3 }
```

| Member | Meaning |
| --- | --- |
| `body` | NAIF code of a body in `bodies` |
| `frame` | A frame name CSPICE knows from the loaded kernels, normally `IAU_<BODY>` from the PCK |
| `interval`, `degree`, `checks` | As for a body. What is fitted is the pole's direction and the residual of the prime meridian after a constant rate, which are slow, so low degrees and long records do |

A body needs an orientation for `lite_orient`, for a site on it, for `lite_sub_point`, and to be treated as its true ellipsoid in an occultation. Without one, a body with unequal radii is treated in occultations as a sphere of its mean radius, and `lite_occulted_shapes` says so.

## Sites

A site is a point fixed to a body, with a number of your choosing. The site numbers are their own space, separate from NAIF codes.

```json
{ "id": 1, "body": 399, "lonDeg": 148.98, "latDeg": -35.40, "altKm": 0.69 }
```

| Member | Meaning |
| --- | --- |
| `id` | The number the sequence passes to `lite_site_view` |
| `body` | NAIF code of the body it is on. That body needs `radiiFrom` and an `orient` entry |
| `lonDeg`, `latDeg` | East longitude and latitude, in degrees |
| `altKm` | Height, in kilometers. Default 0 |

By default the coordinates are **planetocentric**: the site sits on a sphere of the body's equatorial radius plus `altKm`, and "up" at the site is the direction from the body's center.

With `"geodeticSites": true` at the top level they are **geodetic**: latitude and height are measured on the body's spheroid, as surveyed coordinates are, and "up" is the spheroid's normal. On the Earth the two differ by up to 0.19 degrees of elevation. The choice applies to every site in the blob, and the body's two equatorial radii must be equal.

Use geodetic sites when the coordinates came from a map or a survey of the Earth.

## Time: the host clock

The library works in ET (TDB seconds past J2000). A sequence has only the host's clock. The `time` list tells the blob how to convert, as straight-line pieces the library evaluates in about 120 instructions. Each entry belongs to a **time base**, the 16-bit number the host reports with each reading. In F Prime, `TB_SC_TIME` is 3 and `TB_WORKSTATION_TIME` is 2.

There are three forms. Pick by what your flight software's clock reports.

### The host reports Unix time

This is what F Prime's stock time components (`Svc/PosixTime`, `Svc/ChronoTime`) report, under time base 2.

```json
{ "base": 2, "unix": true, "maxErrorSeconds": 1e-6 }
```

The slicer folds leap seconds and the periodic TDB term into the pieces. Cutting the example blob with this entry prints:

```
  time base 2 from Unix time: 1 pieces, max error 2.98e-8 s (tolerance 1.00e-6 s)
```

### The host reports the spacecraft clock's count

Name the clock by its NAIF code and include its SCLK kernel in `kernels`.

```json
{ "base": 3, "sclk": -82, "maxErrorSeconds": 1e-6 }
```

Host seconds are taken to be the clock's own count: the value of its most significant field, with the lesser fields as a fraction in the microseconds. The slicer derives the pieces from the kernel's coefficients, partitions, and time system, and fails if the tolerance cannot be met. `test/blobs/sclk-drift.json` is an example, and prints:

```
  time base 3 from clock -901: 6 pieces, max error 9.24e-7 s (tolerance 1.00e-6 s)
```

### You know the mapping yourself

One explicit piece, written as given:

```json
{ "base": 3, "hostStart": 0, "etOffset": 0, "rate": 1.0 }
```

It says: from host reading `hostStart` on, ET is the window start plus `etOffset` plus `rate` times the seconds since `hostStart`. Several pieces under one base make a clock with rate changes. This form suits tests and simulations.

### Options

| Member | Applies to | Meaning |
| --- | --- | --- |
| `base` | all | The time base, 0 to 65535 |
| `maxErrorSeconds` | derived | The tolerance each piece must hold against CSPICE. Required for `unix` and `sclk`. On an explicit piece it is optional and is recorded as that piece's stated bound |
| `maxPieces` | derived | Fail if more pieces than this would be needed. Default 256 |
| `refuseGaps` | derived | `true` ends each covered stretch with a gap, so that a reading past the window, or a count the clock never showed, returns `LITE_OUT_OF_COVERAGE`. Without it the last line is extended indefinitely. Recommended for flight blobs |
| `mergeRecords` | `sclk` | `true` joins pieces across the kernel's coefficient records where the tolerance allows. Worth it for a kernel with many small rate corrections and a tolerance looser than they are |
| `partition` | `sclk` | Use this one partition of the clock only (counted from 1) |
| `context` | all | 0 to 255. The pieces then answer only readings that carry this context byte, which is how a clock that was reset fits under one time base |
| `hostStart`, `etOffset`, `rate` | explicit | As above. `etOffset` defaults to 0 and `rate` to 1 |
| `gap` | explicit | `true` in place of an offset and a rate: from `hostStart` on, the base is refused until its next piece |

A clock that was reset to a count it had already shown cannot be mapped under one base without help, because the reading alone no longer identifies the time; the slicer refuses it and says so. `SPEC.md` ("Pieces from a spacecraft clock kernel") gives the ways out.

## A spacecraft

A spacecraft is a body like any other, with flags that say what kind of data its state is.

### A predicted trajectory from an SPK

```json
{ "id": -82, "parent": 6, "interval": 600, "degree": 10, "spacecraft": true, "predicted": true,
  "window": { "start": "2004-06-30T00:00:00", "stop": "2004-07-02T00:00:00" } }
```

| Member | Meaning |
| --- | --- |
| `spacecraft` | `true` marks the body as one `lite_set_state` may supply a state for. The library keeps one supplied state at a time |
| `predicted` | `true` marks the segment as a prediction, so that `lite_state` reports `LITE_SRC_PREDICTED` for any state that depends on it |
| `window` | Usually much shorter than the blob's: trajectories are expensive. Two days at ten-minute records is 76 KiB |

### No trajectory at all: the sequence supplies the state

```json
{ "id": -900, "parent": 0, "spacecraft": true, "noSegment": true }
```

The blob then holds only the body's place in the tree, and the sequence gives the library a state from onboard navigation with `lite_set_state` ([Calling the library](api.md#the-spacecrafts-own-state)). This costs no blob space at all. Both can be combined: a predicted segment as the fallback, and a supplied state while it is fresh.

### A long arc of a closed orbit

```json
{ "id": -9001, "parent": 399, "model": "orbit", "interval": 86400, "spacecraft": true, "predicted": true }
```

`"model": "orbit"` stores each record as orbital elements with rates and harmonic terms, 160 bytes whatever its length, in place of polynomials. `degree` is not used.

| Member | Meaning |
| --- | --- |
| `interval` | Record length. The error grows with it; on real orbiters a record of one to three hours holds tens of meters and a record of a day is off by kilometers |
| `breaks` | A list of time strings no record may span: the start and end of a maneuver, a seam between orbit solutions |
| `findBreaks` | `true` has the slicer look for burns and seams in the kernel and break there. An object overrides its thresholds: `stepSeconds`, `positionKm`, `velocityKmS`, `mergeSeconds`, `burnSeconds` (`tools/find-breaks.mjs`). It does not see low thrust |
| `fitSamples`, `checks` | How many states each record is fitted to and measured at |
| `harmonics` | `false` drops the harmonic terms from the fit. Default `true` |

The model is for ellipses with eccentricity up to 0.9. Read [The compact orbit segment](orbit-segment.md) before relying on it: it has the measured errors on LRO, MRO, and MAVEN.

`breaks` and `findBreaks` also work on a polynomial body.

## Size and accuracy

A polynomial record takes `24 × (degree + 1)` bytes, for a body or an orientation, and there are `window ÷ interval` of them, rounded up. An orbit record takes 160 bytes. The rest of a small blob is about 1.3 KB of header, tables, and provenance.

Starting points, from the committed test blobs (all measured against DE440 and the IAU models):

| What | `interval` | `degree` | Bytes per day | Measured error |
| --- | --- | --- | --- | --- |
| A planet's barycenter or the Sun, from 0 | 1,382,400 s (16 days) | 10 to 12 | 17 to 20 | under a millimeter |
| The Earth or the Moon, from their barycenter | 345,600 s (4 days) | 12 | 78 | under a millimeter |
| The Earth's orientation | 864,000 s (10 days) | 3 | 10 | 4e-12 rad |
| The Moon's orientation | 86,400 s (1 day) | 6 | 168 | 2e-13 rad |
| A spacecraft near a planet (Cassini at Saturn) | 600 s | 10 | 38,016 | 12 m through the orbit insertion burn |
| An orbiter, orbit model, synthetic | 86,400 s | n/a | 160 | meters |

To tune a body: cut the blob, read its line in the output, and adjust.

- **Error too large:** shorten `interval` first. Raising `degree` helps until the trajectory has features shorter than a record.
- **Blob too large:** lengthen `interval` and raise `degree` to compensate, or narrow the body's `window`, or drop bodies the sequence never asks about.
- **Query too slow:** cost grows with degree ([cost against degree](cost-measurements.md#a-chebyshev-state-against-its-degree)); a shorter record at a lower degree costs bytes and saves instructions.

The whole module must fit the sequencer's memory with the library: see [the memory budget](building.md#the-memory-budget).

## Reading the output and the report

The slicer prints one line per segment and per derived clock:

```
build/canberra.slb: 2552 bytes
  ephem 3 wrt 0: 1 records, degree 10, 264 bytes, max error 4.30e-7 km, 6.06e-11 km/s
  ephem 399 wrt 3: 2 records, degree 12, 624 bytes, max error 2.09e-9 km, 6.80e-13 km/s
  orient 399: 1 records, degree 3, 96 bytes, max error 3.83e-12 rad
```

Each `max error` is the worst difference between the stored segment and CSPICE over a grid denser than the fit, including both edges of every record. It is the error of that one link of the tree; the error of a query is at most the sum along its path. The same numbers are written into the blob.

The optional third argument writes a JSON report:

| Member | Contents |
| --- | --- |
| `bytes` | Size of the blob |
| `windowEt`, `coverageEt` | The window in ET, and the span every segment covers |
| `kernels` | Each source kernel with its SHA-256 |
| `ephem`, `orient` | Per segment: record count, degree, interval, bytes, and the measured errors (`maxPosErr` km, `maxVelErr` km/s, `maxErr` rad) |
| `sites` | Each site's body-fixed position in kilometers |
| `time` | Every TIME piece as written |
| `timeFit` | Per derived clock: tolerance, measured worst error and where, piece count, partitions |
| `breaksFound` | The breaks `findBreaks` located |

Keep the report with the blob: it is the record of what was cut from what.

## What each call needs from the blob

| Call | The configuration must have |
| --- | --- |
| `lite_host2et`, `lite_fwtime2et` | A `time` entry for the time base the host reports |
| `lite_state`, geometric | Both bodies in `bodies` |
| `lite_state` with `LITE_LT` or `LITE_LT_S` | The same, in a tree rooted at 0, with coverage that reaches back by the light time |
| `lite_orient` | An `orient` entry for the body |
| `lite_site_view` | The site, and `radiiFrom` and `orient` on its body |
| `lite_sub_point` | `radiiFrom` and `orient` on the body |
| `lite_occulted` and its variants | `radiiFrom` on both bodies; `orient` on each that should be its ellipsoid |
| `lite_set_state` | A body with `"spacecraft": true` |
| `lite_state_gap` | That body with a predicted segment as well |

## Limits

- 64 bodies, in a tree at most 8 levels deep.
- Polynomial degree at most 40.
- 4,096 TIME pieces.
- 1 MiB for the whole blob.
- One supplied state at a time.

## Errors the slicer raises

| Message begins | Cause and fix |
| --- | --- |
| `body N: parent P is not in the body list` | Add body `P` to `bodies`, or correct the `parent` |
| `the body list needs exactly one root` | Exactly one body must have `"parent": null` |
| `site N: geodetic sites need radii for body B` | Give body `B` a `radiiFrom`, and include a PCK in `kernels` |
| `site N: geodetic latitude is defined on a spheroid...` | Body `B`'s equatorial radii differ; use planetocentric sites |
| `TIME: two pieces of time base B start at host second S` | Two explicit entries collide; remove one |
| `TIME: two entries of time base B cover the same readings` | Give each entry its own `base` or its own `context` |
| `TIME: N pieces; a blob holds at most 4,096` | Loosen the clock's `maxErrorSeconds` or shorten the window |
| `body N: every break must be a distinct time inside the body's window` | Correct the `breaks` list |
| `body N: the trajectory does not look like an orbit around P` | `"model": "orbit"` was asked for a body that is not in a closed orbit about its parent |
| An error from CSPICE about insufficient ephemeris data | A kernel does not cover the window, or the overhang of the last record past `stop` |

---

[Documentation index](README.md) · Previous: [Getting started](getting-started.md) · Next: [Calling the library](api.md)
