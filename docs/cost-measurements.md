# Cost under SpaceWasm

What each spice-lite call costs when the library runs as a guest of NASA JPL's SpaceWasm interpreter, measured, with the method. This is tier D of the conformance tiers in `SPEC.md`.

## Method

`scripts/measure-cost.mjs` builds the module, loads it with the `spacewasm` crate (0.8.0-rc.3) through the host harness in `bench/spacewasm-host`, copies a blob into guest memory, and runs the calls below. The interpreter is resumed with one instruction of fuel at a time, so the number of resumptions is the exact number of instructions a call executed. The interpreter's operand stack is 1,024 words, the F Prime WasmSequencer default. F Prime pins `spacewasm` 0.7.1; the tables here were remeasured once on that version and every row was the same number (`docs/fprime-integration.md`).

The instruction is a SpaceWasm IR instruction, the unit its fuel counts, not a WebAssembly bytecode instruction. One WasmSequencer slice is 1,000 of them by default, so the last column is how many sequencer cycles a call spans.

The counts are deterministic for a given compiler build. CI reruns the measurement and fails if any call exceeds its ceiling, returns an error, or if the shipped module needs more than its one page. The numbers below are from clang 18.1.3 and its `wasm-ld`, and are the ones CI measures. They used to differ between machines: asked to link, clang runs binaryen's `wasm-opt` on the module when it finds one on the PATH, which made the module 7% smaller and the counts 1 to 3% lower on a machine that had it than on the CI runner, which did not. `scripts/build-wasm.sh` and `scripts/build-sequence.sh` now compile and link as two steps, so `wasm-opt` is never run and the module is byte for byte the same wherever it is built (the direct link was checked against the old CI build: identical). A mission that wants the smaller module can run `wasm-opt` itself as a deliberate, pinned step; this project does not, so that its figures need nothing beyond the compiler to reproduce.

## Every call, on the large test blob

The `cassini-soi` blob is 89,840 bytes, too large for the one page the shipped module declares, so this table uses a variant of the module linked with four pages. Memory size does not change what the code executes. Module 26,601 bytes; compiled IR 41,686 bytes.

<!-- full-table:start -->
| Call | Instructions | Slices of 1,000 |
| --- | --- | --- |
| lite_init, checksum verified (90 KB blob) | 1,866,909 | 1,867 |
| lite_init, checksum skipped | 3,036 | 4 |
| lite_host2et | 147 | 1 |
| lite_fwtime2et | 206 | 1 |
| lite_state, one segment (Moon from Earth-Moon barycenter), geometric | 1,758 | 2 |
| lite_state, two segments (Moon from Earth), geometric | 3,598 | 4 |
| lite_state, three segments (Sun from Earth), geometric | 4,744 | 5 |
| lite_state, Sun from Earth, light time | 6,235 | 7 |
| lite_state, Sun from Earth, light time and stellar aberration | 6,336 | 7 |
| lite_state, Moon from Earth, light time and stellar aberration | 9,838 | 10 |
| lite_state, spacecraft from Saturn barycenter (predicted), geometric | 1,472 | 2 |
| lite_state, Earth from spacecraft, light time and stellar aberration | 9,157 | 10 |
| lite_orient, Moon | 1,178 | 2 |
| lite_site_view, Sun from a lunar site | 6,365 | 7 |
| lite_set_state | 258 | 1 |
| lite_state, spacecraft from Saturn barycenter (supplied), geometric | 465 | 1 |
| lite_state, spacecraft from Earth (supplied), geometric | 4,672 | 5 |
| lite_state_gap | 1,517 | 2 |
| lite_clear_state | 7 | 1 |
<!-- full-table:end -->

## The flight-shaped case: one page

The shipped module declares a single 64 KiB page. The `sun-earth-moon` blob (Sun, Earth, and Moon for 30 days, with orientation for both bodies and two sites; 13,160 bytes) sits beside the library in that page with no growth: the module's own data and stack end at byte 6,432, the blob ends at byte 19,592, and 45,944 bytes are left. The interpreter loads and runs it with these costs:

<!-- flight-table:start -->
| Call | Instructions | Slices of 1,000 |
| --- | --- | --- |
| lite_init, checksum verified (13 KB blob) | 275,080 | 276 |
| lite_init, checksum skipped | 2,317 | 3 |
| lite_host2et | 118 | 1 |
| lite_state, Moon from Earth, geometric | 3,452 | 4 |
| lite_state, Sun from Earth, light time and stellar aberration | 6,124 | 7 |
| lite_orient, Moon | 1,178 | 2 |
| lite_site_view, Sun from a lunar site | 6,197 | 7 |
<!-- flight-table:end -->

## Checksum options

Verifying the CRC-32 is the costly part of `lite_init`, and its cost trades against read-only table space. `LITE_CRC_TABLES` picks the trade at build time; all three settings compute the same value. Measured on the 13 KB blob:

<!-- crc-table:start -->
| LITE_CRC_TABLES | Table size | Module size | Instructions per blob byte | lite_init on the 13 KB blob | Slices |
| --- | --- | --- | --- | --- | --- |
| 0 | 64 bytes | 25,685 bytes | 34.0 | 449,247 | 450 |
| 1 (default) | 1,024 bytes | 26,765 bytes | 20.8 | 275,080 | 276 |
| 4 | 4,096 bytes | 29,787 bytes | 13.8 | 183,072 | 184 |
<!-- crc-table:end -->

The default is the middle row. A larger table buys less than it would on real hardware, because under an interpreter the cost is dominated by the number of operations, not by memory traffic.

One experiment that is not in the library: replacing the CRC with running sums over 32-bit words (a Fletcher-style check) costs 5.8 instructions per byte with no table at all, which is 519,445 instructions on the 90 KB blob against 1,866,810 for the default CRC. It detects fewer error patterns than a CRC and would change the blob format, so it is recorded here as data for the open question in `SPEC.md`, not adopted.

## Sub-points and occultation

`lite_sub_point` and `lite_occulted`, measured on the two geometry blobs (`eclipses` and `saturn-soi`) with the four-page variant of the module, and held to ceilings of 8,000 and 18,000 instructions: the script fails if a row exceeds its ceiling. The ceilings are the largest measured rows (6,734 and 15,311) with about a sixth of headroom, enough for small changes, not for a blob with deeper trees or higher degrees than these. The sizes quoted in this document and in `SPEC.md` are for the combined library, with these calls and the kind 4 orbit segment in; modeling bodies as ellipsoids in `lite_occulted` added 4,601 bytes to the module and 8,180 bytes to its compiled IR on its own branch (the combined library was 24,083 and 39,776 when the two were merged, in a build that `wasm-opt` had been through), and the heap `spacewasm validate` reports for the load went from 32,550 bytes in 4 pages to 41,086 in 6 of 16.

<!-- geometry-table:start -->
| Call | Instructions | Slices of 1,000 |
| --- | --- | --- |
| lite_sub_point, Moon (a sphere) from Earth | 5,334 | 6 |
| lite_sub_point, Earth (a spheroid) from the Moon | 5,504 | 6 |
| lite_sub_point, triaxial stand-in from Earth, three segments | 6,734 | 7 |
| lite_sub_point, Earth from a supplied spacecraft state 900 km up | 2,643 | 3 |
| lite_occulted, triaxial stand-in by Earth from a supplied state (two ellipsoids, none) | 6,092 | 7 |
| lite_sub_point, triaxial stand-in from a supplied spacecraft state 10 km up | 2,564 | 3 |
| lite_occulted, Sun by the Moon from a supplied spacecraft state (two spheres, none) | 7,610 | 8 |
| lite_occulted, Earth by the triaxial stand-in from a supplied state (two ellipsoids) | 6,075 | 7 |
| lite_occulted, Earth by the Moon from the Sun (partial) | 9,909 | 10 |
| lite_occulted, Sun by Earth from the Moon (full) | 9,950 | 10 |
| lite_occulted, Earth by the Sun from the Moon (the Sun is behind) | 8,800 | 9 |
| lite_occulted, Sun by Earth from the Moon, far apart in the sky (none) | 7,407 | 8 |
| lite_occulted, Sun by Earth from 2 m above its surface, Sun below the horizon (full) | 8,648 | 9 |
| lite_occulted, Sun by Earth from 2 m above its surface, lower limb on the horizon (partial, by search) | 10,631 | 11 |
| lite_occulted, Sun by Earth from 2 m above its surface, Sun just clear of the horizon (none, by the full search) | 15,056 | 16 |
| lite_sub_point, Saturn (a spheroid) from Cassini (predicted) | 4,878 | 5 |
| lite_occulted, Sun by Saturn from Cassini (full) | 8,833 | 9 |
| lite_occulted, Earth by Saturn from Cassini (two ellipsoids, full) | 11,610 | 12 |
| lite_occulted, Sun by Saturn from Cassini, six hours earlier (none) | 6,372 | 7 |
| lite_occulted, a Moon with unequal radii by Earth from 2 m above its surface, just clear of the horizon (two ellipsoids, none, by the full search) | 15,311 | 16 |
<!-- geometry-table:end -->

A sub-point is a geometric state, an orientation, and the nearest-point solution: from a supplied state, where the state costs almost nothing, the whole call is about 2,900 instructions, of which the orientation is 1,170 and the Newton iteration with its two arctangents the rest. The shape matters little: the triaxial case costs no more than the spheroid.

An occultation is the positions of the target and the front body from the observer, then the shapes. Each link of the body tree on those two paths is evaluated once, so the observer's own path is not paid for twice: four segments where earlier drafts evaluated five or six. What follows depends on the bodies. Two round bodies take three arctangents and two square roots, about 450 instructions, and the answers have the same bits as before. Otherwise the call first asks whether the spheres of the largest radii are apart in the sky, which costs under a hundred instructions and settles most queries a polling sequence makes (the rows marked none at 5,911 to 7,198). Past that, each body that is not round costs one orientation (1,170), and the ellipsoid test about 1,600: the limb, three vectors carried through both frames, a three by three quadratic form, and its sign from the two stationary points of a cubic. The rows marked partial or full at 8,462 to 11,342 are this path.

The search is the costly branch and a rare one: it runs only when the two bodies' cones cross and the observer is so close to the front body that the crossing might be with the target's mirror image behind it (some 70 m above the Earth for the Sun). It costs about 205 instructions for each of at most 31 evaluations and stops at the first one that shows a shared direction, so a partial occultation found this way costs 10,436 and a clear Sun 14,828; the largest row, 15,110, adds a second orientation.

Against earlier drafts, which modeled both bodies as spheres at 7,040 to 9,372 instructions: a query between round bodies or between bodies far apart is cheaper by a segment or two, and a query that needs an ellipsoid is dearer by 200 to 1,500, the price of an answer that agrees with CSPICE at the limb of a flattened body.

## Time conversion against the piece count

`lite_host2et` finds its TIME piece by binary search over entries that the format requires sorted, so its cost follows the number of probes and not the number of pieces. Each row converts many readings on one blob (every piece's first reading and the reading a microsecond before it, a reading far past each base's last piece, and time bases the blob lacks) and gives the cheapest and the costliest; CI holds every row to the 500-instruction ceiling. The synthetic tables are written by the cost script into a copy of the `sclk-drift` blob.

<!-- time-table:start -->
| TIME pieces | Blob | Readings | Fewest instructions | Most instructions | Held to 500 |
| --- | --- | --- | --- | --- | --- |
| 1 | sun-earth-moon (committed) | 4 | 82 | 118 | yes |
| 6 | sclk-drift (committed; the synthetic drifting clock to a microsecond) | 15 | 122 | 177 | yes |
| 26 | the first 26 clock pieces of sclk-many (30 days to 0.1 microseconds) | 55 | 180 | 237 | yes |
| 206 | sclk-many (committed; 203 clock pieces and three of other bases) | 416 | 267 | 326 | yes |
| 256 | synthetic table of 256 pieces (the slicer's default limit for one clock) | 515 | 296 | 342 | yes |
| 4,096 | synthetic table of 4,096 pieces (the most the format allows) | 517 | 412 | 454 | yes |
<!-- time-table:end -->

A conversion costs about 85 instructions plus 27 for each probe, and a table of n pieces takes at most the whole part of log2(n) plus one probes: one probe for one piece, three for six, five for 26, eight for 206, thirteen for 4,096. The spread within a row is mostly the number of probes a reading happens to need, and the cheapest readings are those of a time base the blob lacks. The format caps the section at 4,096 entries, so the last row is the largest table a blob may hold and every row is held to the ceiling. Before the cap, the largest table a 1 MiB blob could hold (32,717 entries, 15 probes) measured exactly 500, at the ceiling and not safely under it; that is why the cap exists.

Before the entries were required sorted, `lite_host2et` read every entry: 60 instructions plus 33 per piece. The same readings on the same blobs, measured with the library as it was then:

| TIME pieces | Scan, most instructions | Search, most instructions |
| --- | --- | --- |
| 1 | 83 | 110 |
| 2 (the `cassini-soi` blob, the reading in the first table above) | 106 | 137 |
| 6 | 248 | 165 |
| 26 | 908 | 221 |
| 206 | 6,791 | 304 |
| 256 | 8,460 | 318 |
| 4,096 | 135,180 | 422 |

The search costs more than the scan on a table of one or two pieces, by about 30 instructions, and less from about four pieces on. The scan figures are not rerun by CI; they were taken once, at the change.

## A Chebyshev state against its degree

How high can the degree of an EPHEM kind 1 segment go before a one-segment state passes its ceiling of 2,500 instructions? `scripts/measure-cost-degree.mjs` cuts one blob per degree (the Moon relative to the Earth-Moon barycenter, a single record of four days; the blobs are not committed) and counts a geometric state at 16 times in the record. The count does not depend on the time within a record.

<!-- degree-table:start -->
| Degree | Bytes per record | Instructions | Slices of 1,000 | Within the 2,500 ceiling |
| --- | --- | --- | --- | --- |
| 4 | 120 | 1,010 | 2 | yes |
| 6 | 168 | 1,151 | 2 | yes |
| 8 | 216 | 1,292 | 2 | yes |
| 10 | 264 | 1,433 | 2 | yes |
| 12 | 312 | 1,574 | 2 | yes |
| 14 | 360 | 1,715 | 2 | yes |
| 16 | 408 | 1,856 | 2 | yes |
| 18 | 456 | 1,997 | 2 | yes |
| 20 | 504 | 2,138 | 3 | yes |
| 22 | 552 | 2,279 | 3 | yes |
| 24 | 600 | 2,420 | 3 | yes |
| 26 | 648 | 2,561 | 3 | no |
| 28 | 696 | 2,702 | 3 | no |
| 30 | 744 | 2,843 | 3 | no |
| 32 | 792 | 2,984 | 3 | no |
| 34 | 840 | 3,125 | 4 | no |
| 36 | 888 | 3,266 | 4 | no |
| 38 | 936 | 3,407 | 4 | no |
| 40 | 984 | 3,548 | 4 | no |
<!-- degree-table:end -->

The cost is a straight line: 728 instructions plus 70.5 per degree. These blobs hold two bodies and one segment; a larger blob adds to the fixed part, because bodies and segments are found by scanning (the same state on the Moon in the `cassini-soi` blob, with seven bodies and six segments, costs 184 more at degree 12). So the highest even degree that stays inside the ceiling is 24 in the smallest blob and 22 with that overhead added. An earlier guess in `docs/orbit-segment.md`, about 5,000 instructions at degree 34, came from two points on two different blobs and was wrong by a wide margin: degree 34 measures 3,125.

## Reading the numbers

A geometric state costs about 1,500 to 1,800 instructions for one segment and 1,100 to 1,900 more for each further segment on the path between the two bodies; about 450 of the first is fixed overhead. Most of that is the Chebyshev recurrence: three components, position and velocity together, at degree 10 to 12. A body tree shaped so that common queries cross one or two segments keeps them within two to four slices.

Light time roughly doubles the cost, because the target's path is evaluated twice. Stellar aberration adds about a hundred instructions on top of that; it needs no trigonometry.

A site view is the sum of its parts: the state, the orientation it contains, and about 400 instructions for the arcsine and arctangent behind elevation and azimuth.

A supplied spacecraft state is cheap by itself (465 instructions relative to its own center) since it replaces a segment evaluation with a straight-line step.

Start-up is where the cost is. Structural validation alone is two to three thousand instructions; verifying the checksum adds about 21 instructions per blob byte with the default table, so 276 slices for the 13 KB blob and 1,867 for the 90 KB one. A mission that already trusts its uplink can pass the skip flag; otherwise the cost is paid once per blob.

For scale, full CSPICE as a SpaceWasm guest (measured in the cspice-wasm repository) takes 31,660 instructions for a geometric Earth and Sun state and 81,606 with light time and stellar aberration, against about 4,700 and 6,300 here, and it needs 96.5 MiB of memory against one page.

## What is not measured

Wall time on flight hardware, timing inside an F Prime deployment (the demonstration sequence has run in one, `docs/fprime-integration.md`, but no instruction counts were taken there), and the cost of the calls on blobs with other shapes (deeper trees, Hermite segments, Chebyshev orientation segments of high degree).
