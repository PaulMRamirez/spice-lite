# spice-lite blob format, draft 0.1

This document specifies the blob that spice-lite reads and the behavior of the library that reads it. Major version 0 means anything may still change. Where this text and the code disagree, that is a bug in one of them; the tests in `test/` are the tie-breaker for behavior that is implemented.

## Purpose and scope

The blob is one read-only byte array that gives a small onboard library everything it needs to answer geometry questions for a bounded time window. It replaces kernels, the kernel pool, and file I/O with fixed tables that are read in place.

The pieces, in the order data flows:

1. **Slicer (ground).** Reads full SPICE kernels, cuts a mission window, fits compact segments, and writes the blob with its measured error bounds. The reference slicer is `tools/slicer.mjs`, built on cspice-wasm.
2. **Blob.** Travels with a sequence, normally baked into the sequence module's data section.
3. **spice-lite (flight guest).** A small C library with no imports and no heap, statically linked into a sequence. It reads the blob in place.
4. **Validator (ground).** Replays queries against full CSPICE and checks every answer against the bounds the blob declares. Today this is the accuracy tier of the test suite.

In scope for 0.1: time conversion from the host clock, body states in J2000, body orientation, surface sites, and two spacecraft state sources. Out of scope: reading SPICE kernels onboard, instrument kernels and fields of view, attitude (C-kernel) data, shape models, geometry event search, and any write path.

## Design constraints

Full CSPICE runs correctly as a guest of the SpaceWasm interpreter but needs 96.5 MiB of memory (measured in the cspice-wasm repository, `docs/wasi-mvp-measurements.md`), so the flight side must be a different, much smaller thing. Five rules follow:

- **No parsing onboard.** Every table is fixed width and read in place by offset.
- **No allocation.** The library never grows memory and holds no state beyond one small static block.
- **No imports.** The sequence fetches the clock from its host and passes it in, so the library runs unchanged in F Prime, a browser, or a test harness.
- **Wasm 1.0 arithmetic only.** Add, subtract, multiply, divide, and square root on 64-bit floats, plus the library's own trigonometry.
- **Bounded cost.** Every lookup is constant time: uniform record spacing means an index is one subtraction and one division.

## Blob layout

A blob is a 64-byte header, a section directory, then the sections. All integers and floats are little-endian, matching Wasm linear memory, so nothing is byte-swapped or copied.

Encoding rules:

- Offsets are unsigned 32-bit byte counts from the start of the blob.
- Every section and every record array starts on an 8-byte boundary.
- Padding and reserved bytes are zero. A reader rejects a blob whose reserved header bytes are not zero.
- Times are TDB seconds past J2000, the quantity SPICE calls ET. Lengths are kilometers, velocities kilometers per second, angles radians.
- All states and orientations are expressed in J2000 as SPICE defines it.
- A blob is at most 1 MiB in 0.1.

### Header (64 bytes)

| Offset | Size | Field | Meaning |
| --- | --- | --- | --- |
| 0 | 4 | `magic` | ASCII `SLB1` |
| 4 | 2 | `version_major` | 0 in this draft; a reader rejects a major it does not know |
| 6 | 2 | `version_minor` | 1 in this draft |
| 8 | 4 | `total_length` | Blob length in bytes |
| 12 | 4 | `crc32` | CRC-32 (IEEE 802.3) of bytes 16 to the end |
| 16 | 4 | `flags` | Bit 0: the body tree is rooted at the solar system barycenter (NAIF code 0). Other bits zero |
| 20 | 2 | `section_count` | Number of directory entries, at most 16 |
| 22 | 2 | reserved | Zero |
| 24 | 8 | `coverage_start` | Start of the span every segment covers |
| 32 | 8 | `coverage_stop` | End of that span |
| 40 | 8 | `created` | When the blob's contents were current, as ET |
| 48 | 8 | `blob_id` | First 8 bytes of the SHA-256 of bytes 64 to the end, computed before the CRC is written |
| 56 | 8 | reserved | Zero |

The coverage span is the intersection of all segments and is informational: the library checks each segment's own span on every query, so a body with a longer segment can be queried outside the header span.

### Directory entry (16 bytes each, starting at offset 64)

| Offset | Size | Field | Meaning |
| --- | --- | --- | --- |
| 0 | 2 | `type` | Section type code, below |
| 2 | 2 | `flags` | Bit 0: required. A reader that does not know a required type rejects the blob |
| 4 | 4 | `offset` | Start of the section |
| 8 | 4 | `length` | Section length in bytes, including any record arrays it holds |
| 12 | 4 | `count` | Number of fixed-size entries at the start of the section |

A section type appears at most once.

## Sections

| Code | Name | Entry size | Required | Holds |
| --- | --- | --- | --- | --- |
| 1 | TIME | 32 bytes | no | Host clock to ET, as linear pieces |
| 2 | BODY | 32 bytes | yes | Bodies, their parents, and radii |
| 3 | EPHEM | 48 bytes plus records | yes | Position and velocity segments |
| 4 | ORIENT | 64 bytes plus records | no | Body-fixed orientation segments |
| 5 | SITE | 32 bytes | no | Fixed points on a body |
| 6 | PROV | variable | no | Where the data came from; never read onboard |

### TIME

Each entry maps a stretch of the host clock to ET with a straight line: `et = et_start + rate * (host - host_start)`. The slicer is expected to fold spacecraft clock coefficients, leap seconds, and the periodic TDB term into these pieces. The reference slicer does not do that yet; it writes the pieces its configuration gives it.

| Offset | Size | Field | Meaning |
| --- | --- | --- | --- |
| 0 | 2 | `time_base` | Host time base this piece applies to (in F Prime, the `TimeBase` value) |
| 2 | 6 | reserved | Zero |
| 8 | 8 | `host_start` | Host seconds where the piece begins |
| 16 | 8 | `et_start` | ET at `host_start` |
| 24 | 8 | `rate` | ET seconds per host second |

A reading uses the piece with the same base and the latest `host_start` not after it. Host seconds are whole seconds plus microseconds as one 64-bit float, which is exact for any 32-bit second count.

### BODY

Bodies form a tree. Each body except the root names its parent by index, and the ephemeris section holds segments for each body relative to its parent.

| Offset | Size | Field | Meaning |
| --- | --- | --- | --- |
| 0 | 4 | `naif_id` | NAIF integer code, signed; unique within the table |
| 4 | 2 | `parent` | Index of the parent entry, or -1 for the single root |
| 6 | 2 | `flags` | Bit 0: radii present. Bit 1: this body is the spacecraft |
| 8 | 24 | `radii` | Three semi-axes in kilometers |

The table holds at most 64 bodies and the tree is at most 8 levels deep. The slicer chooses the tree to suit the mission. A tree rooted at the solar system barycenter is required for light-time and stellar aberration corrections; a tree rooted at a planet or moon is smaller and supports geometric states only.

### EPHEM

A segment gives one body relative to its parent on a uniform time grid. Uniform spacing means record `k = floor((t - t_start) / interval)` with no search. A body may have several segments; the first one whose span contains the query time is used.

| Offset | Size | Field | Meaning |
| --- | --- | --- | --- |
| 0 | 4 | `target` | NAIF code of the body |
| 4 | 4 | `center` | NAIF code of its parent |
| 8 | 1 | `kind` | 1, 2, or 3; see below |
| 9 | 1 | `source` | 0: published ephemeris. 1: predicted trajectory |
| 10 | 1 | `degree` | Polynomial degree n, at most 40 |
| 11 | 1 | reserved | Zero |
| 12 | 4 | `record_count` | Number of records |
| 16 | 8 | `t_start` | Start of the first record |
| 24 | 8 | `interval` | Record length in seconds, positive |
| 32 | 4 | `data_offset` | Start of the records |
| 36 | 4 | `max_pos_err` | Worst position error against the source, kilometers (32-bit float) |
| 40 | 4 | `max_vel_err` | Worst velocity error, kilometers per second (32-bit float) |
| 44 | 4 | reserved | Zero |

| Kind | Record contents | Span | Evaluation |
| --- | --- | --- | --- |
| 1 | 3(n+1) floats: Chebyshev coefficients for X, then Y, then Z | `record_count * interval` | Position by Clenshaw recurrence; velocity by differentiating the same series |
| 2 | 6(n+1) floats: position coefficients, then velocity coefficients | `record_count * interval` | Both by Clenshaw recurrence |
| 3 | 6 floats: a state at the grid point | `(record_count - 1) * interval` | Cubic Hermite between adjacent grid points |

Kind 1 is SPICE SPK type 2 with the per-record midpoint and radius removed, since the uniform grid implies them. Kind 2 mirrors SPK type 3. Within a record the normalized time is `x = 2 * (t - t_k) / interval - 1`. A reader that meets a kind it does not know answers queries that need it with the unsupported status.

The error fields are measured by the slicer, between the fit nodes and at both record edges, where the derivative of a Chebyshev fit is at its worst.

### ORIENT

An orientation segment gives the rotation from J2000 to a body-fixed frame as three angles on a uniform grid, the same idea as a binary PCK.

| Offset | Size | Field | Meaning |
| --- | --- | --- | --- |
| 0 | 4 | `body` | NAIF code of the body |
| 4 | 1 | `kind` | 1: Chebyshev angles |
| 5 | 1 | `degree` | Polynomial degree n, at most 40 |
| 6 | 2 | reserved | Zero |
| 8 | 4 | `record_count` | Number of records |
| 12 | 4 | `data_offset` | Start of the records |
| 16 | 8 | `t_start` | Start of the first record |
| 24 | 8 | `interval` | Record length in seconds |
| 32 | 8 | `w0` | Prime meridian angle at `t_start` |
| 40 | 8 | `w_rate` | Prime meridian rate, radians per second |
| 48 | 4 | `max_err` | Worst error in the three fitted angles against the source, radians (32-bit float) |
| 52 | 12 | reserved | Zero |

A record holds 3(n+1) coefficients: right ascension of the pole, declination of the pole, and the prime meridian residual. The meridian angle is `W = w0 + w_rate * (t - t_start) + residual`, which keeps the fitted part small. The rotation is R3(W) R1(pi/2 - Dec) R3(pi/2 + RA), where R1 and R3 are coordinate-frame rotations about the first and third axes. The total meridian angle must stay under one million radians in magnitude.

### SITE

| Offset | Size | Field | Meaning |
| --- | --- | --- | --- |
| 0 | 4 | `site_id` | Mission-assigned code |
| 4 | 4 | `body` | NAIF code of the body the site sits on |
| 8 | 24 | `position` | Body-fixed X, Y, Z in kilometers |

Sites need an ORIENT segment for their body.

### PROV

PROV is UTF-8 JSON, padded with spaces to an 8-byte boundary. It lists each source kernel with its SHA-256, the slicer version, the window, and the fit errors per segment. The flight library never reads it, and a mission may strip it before uplink (and must then rewrite the directory, the identifier, and the CRC).

## Spacecraft state

The spacecraft's own state can come from the blob or from the sequence at run time, and the library supports both at once. The supplied state wins while it is fresh; otherwise the library falls back to the predicted segment.

| Source | Where it lives | Strength | Weakness |
| --- | --- | --- | --- |
| Predicted trajectory | An EPHEM segment with `source` = 1 for the spacecraft body | Needs nothing from the flight software; fully checkable on the ground | Goes stale after a maneuver or a late event; large for fast orbits |
| Supplied state | Passed in by the sequence, which read it from onboard navigation | Current; costs no blob space | Ties the sequence to a telemetry channel; only as good as onboard navigation |

Rules for the supplied state:

- The sequence passes an epoch, a center body, a position and velocity in J2000, and a maximum age in seconds. The library keeps exactly one such state, and only for the body flagged as the spacecraft.
- The center may be any body in the blob that does not itself depend on the spacecraft; it need not be the spacecraft's parent in the tree.
- For query times within the maximum age of the epoch, before or after, the library extrapolates in a straight line. The position error is about half the local acceleration times the elapsed time squared: near 1.4 meters per second squared in low lunar orbit, 10 seconds gives about 70 meters.
- Outside that age the supplied state is ignored and the predicted segment answers, if there is one.

Rules for the predicted segment:

- A query outside its span returns the out-of-coverage status, never an extrapolation.
- The header's `created` time tells a sequence how old the prediction is.

Every state result carries a source code (published, predicted, or supplied; the worst along the path) so the sequence can log which one it acted on. `lite_state_gap` returns the difference between the supplied state and the predicted segment at the same time, which lets a sequence detect that the two have drifted apart and stop.

## Library interface and behavior

Each call returns a status code, writes results through pointers, and never traps on bad input once a blob has been accepted. The declarations are in `include/spice_lite.h`.

| Call | Does | In the 0.1 library |
| --- | --- | --- |
| `lite_init(blob, len, flags)` | Checks magic, version, lengths, offsets, counts, tree shape, and the CRC unless told to skip it; makes the blob active | yes |
| `lite_host2et(time_base, seconds, useconds, &et)` | Converts a host clock reading to ET | yes |
| `lite_fwtime2et(bytes, len, &et)` | Same, from a serialized F Prime `Fw::Time` in its default 11-byte layout | yes |
| `lite_state(target, observer, et, corr, state, &lt, &source)` | State of target relative to observer in J2000, with light time | yes |
| `lite_set_state(body, center, et, state, max_age)` | Supplies the spacecraft state | yes |
| `lite_clear_state()` | Drops the supplied state | yes |
| `lite_state_gap(et, &dpos, &dvel)` | Difference between supplied and predicted spacecraft state | yes |
| `lite_orient(body, et, rot)` | Rotation from J2000 to the body-fixed frame | yes |
| `lite_site_view(site, target, et, corr, &az, &el, &range)` | Azimuth, elevation, and range of a target seen from a site | geometric only |
| `lite_sub_point(body, observer, et, &lon, &lat, &alt)` | Point on a body beneath an observer | not yet; returns unsupported |
| `lite_occulted(target, by, observer, et, &code)` | Whether one body hides another | not yet; returns unsupported |

A sequence in F Prime reads the clock with the host's `time` call, which writes a serialized `Fw::Time` into guest memory, and passes those bytes to `lite_fwtime2et`. That helper assumes F Prime's default types and big-endian serialization; a deployment that changes them decodes the time itself and calls `lite_host2et`.

**Corrections.** `LITE_NONE` is geometric. `LITE_LT` applies one light-time iteration, matching SPICE's LT: the target is evaluated at the query time minus the geometric light time. `LITE_LT_S` adds stellar aberration with the same formula as SPICE's LT+S. Both need inertial positions, so they work only when header flag bit 0 is set; otherwise they return the unsupported status. Corrected positions match SPICE within the blob's bounds. Corrected velocities are the target's velocity at the retarded time minus the observer's, without SPICE's light-time rate terms, and differ from SPICE at the level of the speed times v/c.

Two consequences of the physics are worth knowing. A light-time correction needs the target's segment to reach back by the light time, which is over an hour between Saturn and Earth. And stellar aberration turns the apparent direction by the observer's speed over c, so an error in the observer's velocity moves the apparent position by the range times that velocity error over c; with a spacecraft observer on a coarse predicted segment this dominates the error budget.

**Site views.** Up is the direction from the body center through the site (planetocentric, not geodetic). North is the body's +Z axis with its component along up removed, east completes the right-handed set, azimuth runs from north toward east, and a site at a pole is refused.

**Status codes.** 0 OK, 1 out of coverage, 2 no path between the bodies (or an unknown body or site), 3 supplied state stale and no predicted segment, 4 bad blob or no active blob, 5 unsupported, 6 bad argument.

**Determinism.** The library uses only add, subtract, multiply, divide, and square root on 64-bit floats, and carries its own sine, cosine, and arctangent. Built with floating-point contraction off, the same blob and query give bit-identical results on every host. The test suite checks this between a WebAssembly build and a native x86-64 build.

**Integrity.** The ground always verifies the CRC. Onboard, `lite_init` verifies it unless the caller passes the skip flag, for missions whose uplink already guarantees integrity. Structural checks always run, and they are what make later calls safe: no call reads outside the blob once it has been accepted.

## Budgets and measurements

Measured on the 0.1 library (clang 18, `-O2`, `-mcpu=mvp`) and the test blob in `test/blobs/`:

| Quantity | Target | Measured |
| --- | --- | --- |
| Module size | under 24 KiB | 13,620 bytes |
| Host imports | none | none |
| Declared memory | one 64 KiB page | one page |
| SpaceWasm compiled IR | under 64 KiB | 11,454 words (22,908 bytes) in 45 code pages |
| SpaceWasm heap for the load | fits flight defaults | 24,770 bytes in 4 of 16 pages of 8,192 bytes |
| State query, no correction | under 3,000 instructions | not yet measured |
| State query, light time and stellar aberration | under 15,000 instructions | not yet measured |
| Time conversion | under 500 instructions | not yet measured |

The SpaceWasm figures come from `spacewasm validate` (spacewasm_tools 0.8.0-rc.3) with its default flight settings, under which the module loads. Instruction counts need a host harness that drives the exports and are the next measurement to take.

Blob sizes, measured from the test blob (30 days in mid 2004, source DE440):

| Content | Grid and degree | Records | Bytes | Worst position error |
| --- | --- | --- | --- | --- |
| Moon relative to Earth-Moon barycenter | 4 days, degree 12 | 8 | 2,496 | 0.2 mm |
| Earth relative to Earth-Moon barycenter | 4 days, degree 12 | 8 | 2,496 | 0.002 mm |
| Earth-Moon barycenter relative to solar system barycenter | 16 days, degree 12 | 2 | 624 | 0.7 mm |
| Sun relative to solar system barycenter | 16 days, degree 10 | 2 | 528 | 0.03 mm |
| Saturn barycenter relative to solar system barycenter | 32 days, degree 6 | 1 | 168 | 0.8 mm |
| Moon orientation (IAU model) | 1 day, degree 6 | 30 | 5,040 | 1.5e-13 rad |
| Earth orientation (IAU model) | 10 days, degree 3 | 3 | 288 | 3.5e-12 rad |
| Cassini relative to Saturn barycenter, 2 days around orbit insertion | 10 minutes, degree 10 | 288 | 76,032 | 11.5 m |

Three consequences:

- **Natural bodies are cheap.** A month of Sun, Earth, and Moon geometry with orientation is under 12 KiB at sub-millimeter fit error.
- **Spacecraft trajectories are not.** Two days at ten-minute records is 76 KiB, and a month would be over 1 MiB. Predicted segments suit short windows or slow trajectories; the supplied state exists for everything else.
- **A compact orbit model is the likely next segment kind.** Conic elements with secular rates, like SPK type 15, would cover long arcs in tens of bytes.

One deployment note: the F Prime WasmSequencer default gives a guest 8,192 bytes of memory, less than any useful blob, so a mission using this library must raise that setting.

## Conformance and validation

| Tier | Checks | Pass rule | Status |
| --- | --- | --- | --- |
| A. Exactness | The same blob and queries on different hosts and builds | Results are bit-identical to the committed vectors | `test/exact.test.mjs` |
| B. Accuracy | Each query against full CSPICE through cspice-wasm, using the kernels named in PROV | Error is within the bounds the blob declares, with a slack factor of 1.5 because the test samples different times from the slicer | `test/accuracy.test.mjs` |
| C. Robustness | Truncated and corrupted blobs | Refused or handled with status codes; no trap, no out-of-bounds read | `test/robust.test.mjs` |
| D. Cost | Instruction counts per call under SpaceWasm | Within the budgets above | sizes only so far |

The exactness vectors are text. A query file holds one call per line; the expected file holds one result line per query, with every 64-bit float written as the 16 hexadecimal digits of its bit pattern. Bits, not decimals, are what make tier A an exact comparison.

The slicer is not trusted to grade itself. It writes its fit errors into the blob, and tier B recomputes them independently at other times.

## Versioning and compatibility

- **Major version.** Any change to an existing field's meaning, size, or position bumps it. A reader rejects an unknown major.
- **Minor version.** May add section types, segment kinds, flag bits, and uses for reserved bytes. A reader accepts a higher minor.
- **Unknown section types.** Skipped, unless the entry's required flag is set, in which case the blob is rejected.
- **Unknown segment kinds.** A query that needs such a segment returns unsupported; other queries still work.
- **Reserved bytes and flag bits.** Writers set them to zero. A reader rejects nonzero reserved header bytes, and rejects unknown header flag bits in a blob whose minor version it knows.
- **Byte order.** Little-endian only.
- **Draft status.** The first flight-intended release is 1.0, frozen together with its vector set.

## Open questions

1. **Name.** spice-lite is kept for now. Whether a project that is not NAIF's should carry the SPICE name has been put to NAIF; the answer may force a rename.
2. **Stellar aberration in 0.1.** It is implemented. Whether its dependence on observer velocity accuracy makes it worth keeping for spacecraft observers is open.
3. **Host time bases.** The TIME section assumes one linear map per time base. Spacecraft clock partitions or resets may need more, and the slicer does not yet derive the pieces from an SCLK kernel.
4. **Compact orbit segment.** Which model, and how its error is bounded.
5. **Checksum.** CRC-32 is the draft choice; its cost at init is not yet measured.
6. **Real memory configuration.** The one-page target assumes a mission will grant a sequence 64 KiB.
7. **Geodetic sites, sub-points, and occultation.** Declared, not implemented.
8. **Where the slicer lives.** It is in this repository for now; it may move to cspice-wasm.

## Notes on sources

The SPK type 2 and 3 layouts and the pole and meridian rotation form follow SPICE conventions as the author understands them and as the accuracy tests confirm numerically against CSPICE; they have not been checked line by line against NAIF's required reading. The F Prime time layout was read from `Fw/Time/Time.fpp` and `default/config/FpConfig.fpp` in nasa/fprime.
