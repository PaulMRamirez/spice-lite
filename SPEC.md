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

Each entry maps a stretch of the host clock to ET with a straight line: `et = et_start + rate * (host - host_start)`. The slicer folds spacecraft clock coefficients, leap seconds, and the periodic TDB term into these pieces, so the library only ever evaluates one line. How the reference slicer derives them, and what a host reading must mean for that to work, is under "Pieces from a spacecraft clock kernel" below.

| Offset | Size | Field | Meaning |
| --- | --- | --- | --- |
| 0 | 2 | `time_base` | Host time base this piece applies to (in F Prime, the `TimeBase` value) |
| 2 | 6 | reserved | Zero |
| 8 | 8 | `host_start` | Host seconds where the piece begins |
| 16 | 8 | `et_start` | ET at `host_start` |
| 24 | 8 | `rate` | ET seconds per host second |

A reading uses the piece with the same base and the latest `host_start` not after it. A piece has no end: it answers until the next piece of its base begins, and the last one is extended in a straight line past the blob's window. A reading below every piece of its base is out of coverage. Host seconds are whole seconds plus microseconds as one 64-bit float, formed as `seconds + microseconds * 1e-6`; every microsecond reading of a 32-bit second count gives a distinct value, but above 2^30 seconds the float resolves only 0.24 microseconds (0.48 above 2^31).

#### Pieces from a spacecraft clock kernel

A slicer configuration gives TIME entries in two forms. The explicit form, `{ "base": 3, "hostStart": 0, "etOffset": 0, "rate": 1.0 }`, is one piece written as given, with `etOffset` measured from the window start. The clock form, `{ "base": 3, "sclk": -82, "maxErrorSeconds": 1e-6 }`, names a spacecraft clock by its NAIF code and a tolerance, and the slicer (`tools/sclk-time.mjs`) derives the pieces from the SCLK kernel among the configured kernels. Optional members are `maxPieces` (default 256) and `partition` (a single partition number, counted from 1).

**What a host reading means.** For the clock form, host seconds are the spacecraft clock's own count: the value of its most significant field, with the lesser fields as a fraction of one count carried in the microseconds. In SPICE terms, host seconds are `ticks / ticks_per_count`, where `ticks` is the reading as the SCLK kernel counts it within its partition (field values less their offsets, the unit of `SCLK_PARTITION_START` and `SCLK_PARTITION_END`) and `ticks_per_count` is the product of every modulus but the first. For the usual clock whose first field counts nominal seconds this is the clock count in seconds measured from the clock's zero, which is what an F Prime deployment reports as an `Fw::Time` with base `TB_SC_TIME` (3) when its time source is that counter. The reading carries no partition number.

**Limits of that convention.**

- A clock count of 2^32 or more does not fit the seconds field, and the slicer refuses a window that needs one.
- The flight software must turn the sub-count fields into microseconds itself. A tick that is not a whole number of microseconds (1/256 of a count is 3,906.25) is rounded by the host, an error of up to half a microsecond of clock time that the blob cannot see and its declared error does not include.
- Encoded SCLK, which SPICE uses internally, runs on through partition boundaries; the clock's own count does not, and the count is what the host has. The slicer therefore maps each partition separately and always starts a new piece at a partition boundary.
- One time base can cover several partitions only if no reading inside the window occurs in two of them, because a piece is selected by the reading alone. A clock that was set forward satisfies this. A clock that was reset to a count it had already shown does not, and the slicer refuses it; the mission then gives each partition its own entry (with `partition`) under its own time base and has the flight software report the base that matches the clock's current partition, or cuts one blob per partition.
- Between two partitions that share a base there are counts the clock never showed. The library answers them anyway, by extending the earlier partition's last line; nothing in the blob marks them as invalid.
- A mission whose flight software reports time some other way (seconds from a mission epoch, a count already corrected onboard, a field layout that is not count plus fraction) must not use the clock form. It computes its own pieces on the ground and gives them in the explicit form.

**How the pieces are cut.** The truth is CSPICE: each reading is converted to encoded SCLK and then to ET with `sct2e`, which applies the kernel's coefficients, its time system (TDB or TT), and through the leapseconds kernel the periodic TDB term. A new piece always starts at the window's first reading, at each partition boundary, and at the first reading at or after each coefficient record (where the rate changes and the time may step). Every `host_start` is a whole microsecond reading formed the way the library forms it, so a reading on a boundary selects the same piece on every host. Between those points each piece is made as long as its line allows: the line has the slope of the chord between the piece's ends and is shifted to halve its largest residual, and the piece grows until that residual reaches nine tenths of the tolerance. The slicer then measures every piece against CSPICE at 2,049 readings including both ends, with the library's own arithmetic; a piece over the tolerance is cut again more finely, and if the tolerance still cannot be met, or more than `maxPieces` pieces would be needed, the slicer fails and writes no blob. The tolerance, the measured worst error, and the piece count are recorded in the slicer's report (`timeFit`) and in PROV (`time`). The TIME entries themselves carry no error field.

What limits a piece's length, once the clock's own rate changes are split out, is the periodic difference between TDB and TT (about 1.7 milliseconds in amplitude, with a period of a year) for a clock kept on TT; a clock kept on TDB has no such term. Measured on the test clocks (`test/sclk.test.mjs`; all but the first are synthetic kernels in `test/fixtures`), over 30 days:

| Clock | Window start | Pieces at 1 microsecond | Worst error | Pieces at 1 millisecond | Worst error |
| --- | --- | --- | --- | --- | --- |
| cassini-demo (TDB, one rate) | 2004-06-27 | 1 | 0.03 microseconds | 1 | 0.03 microseconds |
| Steady clock on TT | 2004-06-27, where the periodic term bends least | 2 | 0.89 microseconds | 1 | 3.6 microseconds |
| Steady clock on TT | 2004-03-20, where it bends most | 6 | 0.92 microseconds | 1 | 27 microseconds |
| Four rates, a 4 ms step, two partitions, on TT | 2004-06-27 | 6 | 0.92 microseconds | 5 | 0.98 microseconds |

The errors are multiples of 0.03 microseconds because that is the spacing of 64-bit ET values in 2004; a tolerance near that spacing cannot be met with any number of pieces. The library scans every TIME entry on each conversion, so the cost grows with the piece count: under SpaceWasm, 83 instructions with one piece, up to 248 with the six pieces of `test/blobs/sclk-drift.slb`, and up to 898 with 26, or roughly 60 plus 33 per piece. The 500-instruction ceiling for a time conversion holds to about a dozen pieces.

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
| 8 | 1 | `kind` | 1, 2, 3, or 4; see below |
| 9 | 1 | `source` | 0: published ephemeris. 1: predicted trajectory |
| 10 | 1 | `degree` | Polynomial degree n, at most 40; zero for kind 4 |
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
| 4 | 104 bytes: orbital elements, their rates, and six harmonic coefficients | `record_count * interval` | Compact orbit model, below |

Kind 1 is SPICE SPK type 2 with the per-record midpoint and radius removed, since the uniform grid implies them. Kind 2 mirrors SPK type 3. Within a record the normalized time is `x = 2 * (t - t_k) / interval - 1`. A reader that meets a kind it does not know answers queries that need it with the unsupported status.

The error fields are measured by the slicer, between the fit nodes and at both record edges, where the derivative of a Chebyshev fit is at its worst.

#### Kind 4: compact orbit

Kind 4 describes a bound orbit around the segment's center with elements that drift, so one record can cover many revolutions. It is the form of the GPS broadcast ephemeris (Keplerian elements, linear rates, and corrections in twice the argument of latitude), with the eccentricity carried as a vector in the orbit plane so that a circular orbit is regular. Elements are referred to J2000: the inclination is measured from the J2000 XY plane and the node from the J2000 X axis. The record carries no gravitational parameter; the velocity is the exact time derivative of the position formula.

A record is 104 bytes. The first seven fields are 64-bit floats and the rest 32-bit floats, which is enough for rates and small corrections. Values are at the record's mid epoch, `t_k + interval / 2`, and `tau` is the query time minus that epoch.

| Offset | Size | Field | Meaning |
| --- | --- | --- | --- |
| 0 | 8 | `a` | Semi-major axis, kilometers |
| 8 | 8 | `ex` | Eccentricity times the cosine of the argument of periapsis |
| 16 | 8 | `ey` | Eccentricity times the sine of the argument of periapsis |
| 24 | 8 | `inc` | Inclination, radians |
| 32 | 8 | `node` | Right ascension of the ascending node, radians |
| 40 | 8 | `lam` | Mean argument of latitude (mean anomaly plus argument of periapsis), radians |
| 48 | 8 | `lam_rate` | Rate of `lam`, radians per second |
| 56 | 4 | `a_rate` | Rate of `a`, kilometers per second |
| 60 | 4 | `ex_rate` | Rate of `ex`, per second |
| 64 | 4 | `ey_rate` | Rate of `ey`, per second |
| 68 | 4 | `inc_rate` | Rate of `inc`, radians per second |
| 72 | 4 | `node_rate` | Rate of `node`, radians per second |
| 76 | 4 | `lam_quad` | Quadratic term of `lam`, radians per second squared |
| 80 | 4 | `cuc`, then `cus` at 84 | Cosine and sine corrections to the argument of latitude, radians |
| 88 | 4 | `crc`, then `crs` at 92 | Cosine and sine corrections to the radius, kilometers |
| 96 | 4 | `cic`, then `cis` at 100 | Cosine and sine corrections to the inclination, radians |

Evaluation at `tau`:

1. Each element is its value plus its rate times `tau`; `lam` also adds `lam_quad * tau^2`.
2. Solve Kepler's equation in the form `F - ex sin F + ey cos F = lam` for the eccentric argument of latitude `F`, by Newton steps on the offset `F - lam` starting from zero. A step smaller than 1e-8 radians ends the iteration, and at most 12 steps are taken.
3. With `w = sqrt(1 - ex^2 - ey^2)`, `beta = 1 / (1 + w)`, and `D = ey cos F - ex sin F`, the position in the orbit plane, in units of `a` and with the first axis toward the ascending node, is `X = cos F - ex - beta ey D` and `Y = sin F - ey + beta ex D`. The radius is `r = a (1 - ex cos F - ey sin F)`, and the argument of latitude `u` has `cos u = a X / r` and `sin u = a Y / r`.
4. The corrections are `du = cuc cos 2u + cus sin 2u`, and likewise `dr` from `crc`, `crs` and `di` from `cic`, `cis`.
5. In the orbit plane the corrected point is `x' = (r + dr) cos(u + du)`, `y' = (r + dr) sin(u + du)`. With `i = inc + di`, the J2000 position is `(x' cos node - y' cos i sin node, x' sin node + y' cos i cos node, y' sin i)`.
6. The velocity is the time derivative of steps 1 to 5 with every rate included.

Validity limits. The model is for ellipses only. At the query time the semi-major axis must be positive and finite and the eccentricity at most 0.9; `lam`, `node`, and `inc + di` must each be within one million radians. If any of these fails, or the Kepler iteration has not converged in 12 steps (seven is the most seen at the eccentricity limit), the query returns the unsupported status. These checks keep every divisor in the evaluation away from zero, so a record of arbitrary bits yields a status or a number, never a trap. `lite_init` checks the structure: the `degree` field of a kind 4 segment must be zero and its records must lie inside the blob, or the blob is rejected. Hyperbolic and parabolic arcs are out of scope for this kind; the slicer refuses to fit one.

Accuracy is whatever the slicer measured, as for the other kinds: it fits each record by least squares to states sampled from the source, then measures the stored record (after rounding to its 32-bit fields) against the source on a denser grid that includes both record edges. Neighboring records are fitted independently, so the state can step at a record boundary by up to twice the declared error. On near-circular orbits the model holds tens of meters over a record of a day; on eccentric orbits it is much coarser. `docs/orbit-segment.md` has the measurements, all of them on synthetic orbiters so far.

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

PROV is UTF-8 JSON, padded with spaces to an 8-byte boundary. It lists each source kernel with its SHA-256, the slicer version, the window, the fit errors per segment, and for TIME pieces derived from a spacecraft clock their tolerance and measured worst error. The flight library never reads it, and a mission may strip it before uplink (and must then rewrite the directory, the identifier, and the CRC).

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
| Module size | under 24 KiB | 14,695 bytes with the default checksum table (13,620 with the smallest, 17,712 with the largest) |
| Host imports | none | none |
| Declared memory | one 64 KiB page | one page; with a 13 KB Sun, Earth, Moon blob, 45,944 bytes of it stay free |
| SpaceWasm compiled IR | under 64 KiB | 23,120 bytes |
| SpaceWasm heap for the load | fits flight defaults | 25,282 bytes in 4 of 16 pages of 8,192 bytes |
| Time conversion | under 500 instructions | 106 (163 from serialized F Prime time) |
| Geometric state, one segment | under 2,500 instructions | 1,711 to 1,982 |
| Geometric state, up to three segments | under 6,000 instructions | 3,495 (two), 4,601 (three) |
| State with light time and stellar aberration | under 15,000 instructions | 6,531 to 9,627 |
| Orientation | none set | 1,170 |
| Site view | none set | 6,161 |
| `lite_init`, checksum skipped | none set | 2,278 to 2,938 |
| `lite_init`, checksum verified | none set | 20.8 instructions per blob byte with the default table: 275,040 for a 13 KB blob, 1,866,810 for the 90 KB one |

The heap figure comes from `spacewasm validate` (spacewasm_tools 0.8.0-rc.3) with its default flight settings, under which the module loads. Sizes are from the author's clang 18 build; the CI runner's clang 18 build is larger by several percent while the answers are identical. The instruction counts come from `scripts/measure-cost.mjs`, which runs the module in the SpaceWasm interpreter one instruction of fuel at a time; `docs/cost-measurements.md` has the full table and the method. An instruction here is a SpaceWasm IR instruction, the unit its fuel counts, and one F Prime WasmSequencer slice is 1,000 of them by default.

Two targets from the first draft of this document were missed and are restated above as measured ceilings. A geometric state was budgeted at 3,000 instructions; that holds for one segment but not for two or three, because each segment on the path costs about 1,700 to 2,000. For comparison, full CSPICE as a guest takes 31,660 instructions for a geometric state and 81,606 with light time and stellar aberration, so this library is about 7 and 12 times cheaper on the same question (Sun and Earth). The checksum is the expensive call. `LITE_CRC_TABLES` trades table space for speed (34, 20.8, or 13.8 instructions per byte for 64 bytes, 1 KiB, or 4 KiB of table); with the default, verifying a 13 KB blob takes 276 slices.

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

- **Natural bodies are cheap.** A month of Sun, Earth, and Moon geometry with orientation and two sites is a 13,160-byte blob (`test/blobs/sun-earth-moon.slb`) at sub-millimeter fit error, and it fits beside the library in the module's single page.
- **Spacecraft trajectories are not.** Two days at ten-minute records is 76 KiB, and a month would be over 1 MiB. Predicted segments suit short windows or slow trajectories; the supplied state exists for everything else.
- **A compact orbit model covers long arcs of a closed orbit.** Kind 4 holds a near-circular orbiter in 104 bytes per day: on synthetic trajectories (a point mass plus J2), about 30 m for a low Earth orbiter and 3 m for a low lunar orbiter, 30 to 40 times smaller than the smallest Chebyshev segment of the same accuracy. An eccentric orbit (0.3) fits only to about 1 km. A kind 4 state costs 2,048 to 2,290 instructions under SpaceWasm at those eccentricities and up to 3,207 at the model's limit of 0.9, which is over the one-segment ceiling above. The same study found that kind 1 on a closed orbit is much smaller than the Cassini row suggests when its records are long and its degree high (4 to 7 KB per day for the low Earth orbiter). `docs/orbit-segment.md` has the tables.

One deployment note: the F Prime WasmSequencer default gives a guest 8,192 bytes of memory, less than any useful blob, so a mission using this library must raise that setting.

## Conformance and validation

| Tier | Checks | Pass rule | Status |
| --- | --- | --- | --- |
| A. Exactness | The same blob and queries on different hosts and builds | Results are bit-identical to the committed vectors | `test/exact.test.mjs` |
| B. Accuracy | Each query against full CSPICE through cspice-wasm, using the kernels named in PROV | Error is within the bounds the blob declares, with a slack factor of 1.5 because the test samples different times from the slicer | `test/accuracy.test.mjs` |
| C. Robustness | Truncated and corrupted blobs | Refused or handled with status codes; no trap, no out-of-bounds read | `test/robust.test.mjs` |
| D. Cost | Instruction counts per call under SpaceWasm | Within the ceilings above | `scripts/measure-cost.mjs` |

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
3. **Host time bases.** The slicer now derives the pieces from an SCLK kernel under one stated convention (host seconds are the clock's own count; see TIME). Still open: whether that convention matches what real F Prime deployments put in `TB_SC_TIME`; whether a clock reset should be handled by a second time base, as now, or by a partition number carried in the F Prime time context byte, which `lite_fwtime2et` ignores today; whether the TIME entries should carry their own error bound and an end, so that counts the clock never showed are refused; and whether entries should be required sorted so the library can search instead of scan when a long window needs many pieces. Only type 1 SCLK kernels are read, and the clock's structure is parsed from the kernel text because cspice-wasm does not bind `scpart` or the kernel pool readers.
4. **Compact orbit segment.** Kind 4 exists, with its error bounded by measurement like the other kinds. Still open: validation on real orbiter kernels (everything so far is synthetic, with no gravity beyond J2, no third bodies, and no drag); whether to add harmonics that suit eccentric orbits; whether elements should be referred to the central body's equator instead of J2000; splitting records at maneuvers; and the cost of the Kepler solve near the eccentricity limit.
5. **Checksum.** CRC-32 is the draft choice and it dominates start-up: 20.8 interpreter instructions per byte with the default 1 KiB table, against two to three thousand instructions in total with the check skipped. A Fletcher-style sum over 32-bit words measured at 5.8 instructions per byte with no table, but detects fewer error patterns and would change the format. Whether to keep CRC-32, switch, or rely on uplink integrity is open.
6. **Real memory configuration.** The one-page target assumes a mission will grant a sequence 64 KiB.
7. **Geodetic sites, sub-points, and occultation.** Declared, not implemented.
8. **Where the slicer lives.** It is in this repository for now; it may move to cspice-wasm.

## Notes on sources

The SPK type 2 and 3 layouts and the pole and meridian rotation form follow SPICE conventions as the author understands them and as the accuracy tests confirm numerically against CSPICE; they have not been checked line by line against NAIF's required reading. The F Prime time layout was read from `Fw/Time/Time.fpp` and `default/config/FpConfig.fpp` in nasa/fprime.
