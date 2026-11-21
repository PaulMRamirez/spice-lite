# Cost under SpaceWasm

What each spice-lite call costs when the library runs as a guest of NASA JPL's SpaceWasm interpreter, measured, with the method. This is tier D of the conformance tiers in `SPEC.md`.

## Method

`scripts/measure-cost.mjs` builds the module, loads it with the `spacewasm` crate (0.8.0-rc.3) through the host harness in `bench/spacewasm-host`, copies a blob into guest memory, and runs the calls below. The interpreter is resumed with one instruction of fuel at a time, so the number of resumptions is the exact number of instructions a call executed. The interpreter's operand stack is 1,024 words, the F Prime WasmSequencer default.

The instruction is a SpaceWasm IR instruction, the unit its fuel counts, not a WebAssembly bytecode instruction. One WasmSequencer slice is 1,000 of them by default, so the last column is how many sequencer cycles a call spans.

The counts are deterministic for a given compiler build. CI reruns the measurement and fails if any call exceeds its ceiling, returns an error, or if the shipped module needs more than its one page. The numbers below are from the author's clang 18 build; the CI runner's clang 18 build runs about 3% higher.

## Every call, on the large test blob

The `cassini-soi` blob is 89,840 bytes, too large for the one page the shipped module declares, so this table uses a variant of the module linked with four pages. Memory size does not change what the code executes. Module 14,695 bytes; compiled IR 23,120 bytes.

<!-- full-table:start -->
| Call | Instructions | Slices of 1,000 |
| --- | --- | --- |
| lite_init, checksum verified (90 KB blob) | 1,866,852 | 1,867 |
| lite_init, checksum skipped | 2,980 | 3 |
| lite_host2et | 106 | 1 |
| lite_fwtime2et | 163 | 1 |
| lite_state, one segment (Moon from Earth-Moon barycenter), geometric | 2,002 | 3 |
| lite_state, two segments (Moon from Earth), geometric | 3,537 | 4 |
| lite_state, three segments (Sun from Earth), geometric | 4,655 | 5 |
| lite_state, Sun from Earth, light time | 6,502 | 7 |
| lite_state, Sun from Earth, light time and stellar aberration | 6,603 | 7 |
| lite_state, Moon from Earth, light time and stellar aberration | 9,731 | 10 |
| lite_state, spacecraft from Saturn barycenter (predicted), geometric | 1,723 | 2 |
| lite_state, Earth from spacecraft, light time and stellar aberration | 9,053 | 10 |
| lite_orient, Moon | 1,170 | 2 |
| lite_site_view, Sun from a lunar site | 6,213 | 7 |
| lite_set_state | 258 | 1 |
| lite_state, spacecraft from Saturn barycenter (supplied), geometric | 736 | 1 |
| lite_state, spacecraft from Earth (supplied), geometric | 4,574 | 5 |
| lite_state_gap | 1,754 | 2 |
| lite_clear_state | 8 | 1 |
<!-- full-table:end -->

## The flight-shaped case: one page

The shipped module declares a single 64 KiB page. The `sun-earth-moon` blob (Sun, Earth, and Moon for 30 days, with orientation for both bodies and two sites; 13,160 bytes) sits beside the library in that page with no growth: the module's own data and stack end at byte 6,432, the blob ends at byte 19,592, and 45,944 bytes are left. The interpreter loads and runs it with these costs:

<!-- flight-table:start -->
| Call | Instructions | Slices of 1,000 |
| --- | --- | --- |
| lite_init, checksum verified (13 KB blob) | 275,068 | 276 |
| lite_init, checksum skipped | 2,306 | 3 |
| lite_host2et | 83 | 1 |
| lite_state, Moon from Earth, geometric | 3,399 | 4 |
| lite_state, Sun from Earth, light time and stellar aberration | 6,417 | 7 |
| lite_orient, Moon | 1,170 | 2 |
| lite_site_view, Sun from a lunar site | 6,055 | 7 |
<!-- flight-table:end -->

## Checksum options

Verifying the CRC-32 is the costly part of `lite_init`, and its cost trades against read-only table space. `LITE_CRC_TABLES` picks the trade at build time; all three settings compute the same value. Measured on the 13 KB blob:

<!-- crc-table:start -->
| LITE_CRC_TABLES | Table size | Module size | Instructions per blob byte | lite_init on the 13 KB blob | Slices |
| --- | --- | --- | --- | --- | --- |
| 0 | 64 bytes | 22,351 bytes | 34.0 | 449,233 | 450 |
| 1 (default) | 1,024 bytes | 23,426 bytes | 20.8 | 275,068 | 276 |
| 4 | 4,096 bytes | 26,443 bytes | 13.8 | 183,060 | 184 |
<!-- crc-table:end -->

The default is the middle row. A larger table buys less than it would on real hardware, because under an interpreter the cost is dominated by the number of operations, not by memory traffic.

One experiment that is not in the library: replacing the CRC with running sums over 32-bit words (a Fletcher-style check) costs 5.8 instructions per byte with no table at all, which is 519,445 instructions on the 90 KB blob against 1,866,810 for the default CRC. It detects fewer error patterns than a CRC and would change the blob format, so it is recorded here as data for the open question in `SPEC.md`, not adopted.

## Sub-points and occultation

`lite_sub_point` and `lite_occulted`, measured on the two geometry blobs (`eclipses` and `saturn-soi`) with the four-page variant of the module, and held to ceilings of 8,000 and 18,000 instructions: the script fails if a row exceeds its ceiling. The ceilings are the largest measured rows (6,643 and 15,110) with about a fifth of headroom, enough for the CI compiler's 3% and for small changes, not for a blob with deeper trees or higher degrees than these. The sizes quoted in this document and in `SPEC.md` are for the combined library, with these calls and the kind 4 orbit segment in; modeling bodies as ellipsoids in `lite_occulted` added 4,601 bytes to the module (18,825 to 23,426) and 8,180 bytes to its compiled IR (30,434 to 38,614), and the heap `spacewasm validate` reports for the load went from 32,550 bytes in 4 pages to 41,086 in 6 of 16.

<!-- geometry-table:start -->
| Call | Instructions | Slices of 1,000 |
| --- | --- | --- |
| lite_sub_point, Moon (a sphere) from Earth | 5,265 | 6 |
| lite_sub_point, Earth (a spheroid) from the Moon | 5,432 | 6 |
| lite_sub_point, triaxial stand-in from Earth, three segments | 6,643 | 7 |
| lite_sub_point, Earth from a supplied spacecraft state 900 km up | 2,990 | 3 |
| lite_occulted, triaxial stand-in by Earth from a supplied state (two ellipsoids, none) | 5,923 | 6 |
| lite_sub_point, triaxial stand-in from a supplied spacecraft state 10 km up | 2,819 | 3 |
| lite_occulted, Sun by the Moon from a supplied spacecraft state (two spheres, none) | 7,437 | 8 |
| lite_occulted, Earth by the triaxial stand-in from a supplied state (two ellipsoids) | 5,911 | 6 |
| lite_occulted, Earth by the Moon from the Sun (partial) | 9,690 | 10 |
| lite_occulted, Sun by Earth from the Moon (full) | 9,714 | 10 |
| lite_occulted, Earth by the Sun from the Moon (the Sun is behind) | 8,603 | 9 |
| lite_occulted, Sun by Earth from the Moon, far apart in the sky (none) | 7,198 | 8 |
| lite_occulted, Sun by Earth from 2 m above its surface, Sun below the horizon (full) | 8,462 | 9 |
| lite_occulted, Sun by Earth from 2 m above its surface, lower limb on the horizon (partial, by search) | 10,436 | 11 |
| lite_occulted, Sun by Earth from 2 m above its surface, Sun just clear of the horizon (none, by the full search) | 14,828 | 15 |
| lite_sub_point, Saturn (a spheroid) from Cassini (predicted) | 4,811 | 5 |
| lite_occulted, Sun by Saturn from Cassini (full) | 8,596 | 9 |
| lite_occulted, Earth by Saturn from Cassini (two ellipsoids, full) | 11,342 | 12 |
| lite_occulted, Sun by Saturn from Cassini, six hours earlier (none) | 6,160 | 7 |
| lite_occulted, a Moon with unequal radii by Earth from 2 m above its surface, just clear of the horizon (two ellipsoids, none, by the full search) | 15,110 | 16 |
<!-- geometry-table:end -->

A sub-point is a geometric state, an orientation, and the nearest-point solution: from a supplied state, where the state costs almost nothing, the whole call is about 2,900 instructions, of which the orientation is 1,170 and the Newton iteration with its two arctangents the rest. The shape matters little: the triaxial case costs no more than the spheroid.

An occultation is the positions of the target and the front body from the observer, then the shapes. Each link of the body tree on those two paths is evaluated once, so the observer's own path is not paid for twice: four segments where earlier drafts evaluated five or six. What follows depends on the bodies. Two round bodies take three arctangents and two square roots, about 450 instructions, and the answers have the same bits as before. Otherwise the call first asks whether the spheres of the largest radii are apart in the sky, which costs under a hundred instructions and settles most queries a polling sequence makes (the rows marked none at 5,911 to 7,198). Past that, each body that is not round costs one orientation (1,170), and the ellipsoid test about 1,600: the limb, three vectors carried through both frames, a three by three quadratic form, and its sign from the two stationary points of a cubic. The rows marked partial or full at 8,462 to 11,342 are this path.

The search is the costly branch and a rare one: it runs only when the two bodies' cones cross and the observer is so close to the front body that the crossing might be with the target's mirror image behind it (some 70 m above the Earth for the Sun). It costs about 205 instructions for each of at most 31 evaluations and stops at the first one that shows a shared direction, so a partial occultation found this way costs 10,436 and a clear Sun 14,828; the largest row, 15,110, adds a second orientation.

Against earlier drafts, which modeled both bodies as spheres at 7,040 to 9,372 instructions: a query between round bodies or between bodies far apart is cheaper by a segment or two, and a query that needs an ellipsoid is dearer by 200 to 1,500, the price of an answer that agrees with CSPICE at the limb of a flattened body.

## Reading the numbers

A geometric state costs about 1,700 to 2,000 instructions for each segment on the path between the two bodies, plus a few hundred of fixed overhead. Most of that is the Chebyshev recurrence: three components, position and velocity together, at degree 10 to 12. A body tree shaped so that common queries cross one or two segments keeps them within two to four slices.

Light time roughly doubles the cost, because the target's path is evaluated twice. Stellar aberration adds about a hundred instructions on top of that; it needs no trigonometry.

A site view is the sum of its parts: the state, the orientation it contains, and about 400 instructions for the arcsine and arctangent behind elevation and azimuth.

A supplied spacecraft state is cheap by itself (726 instructions relative to its own center) since it replaces a segment evaluation with a straight-line step.

Start-up is where the cost is. Structural validation alone is two to three thousand instructions; verifying the checksum adds about 21 instructions per blob byte with the default table, so 276 slices for the 13 KB blob and 1,867 for the 90 KB one. A mission that already trusts its uplink can pass the skip flag; otherwise the cost is paid once per blob.

For scale, full CSPICE as a SpaceWasm guest (measured in the cspice-wasm repository) takes 31,660 instructions for a geometric Earth and Sun state and 81,606 with light time and stellar aberration, against about 4,600 and 6,500 here, and it needs 96.5 MiB of memory against one page.

## What is not measured

Wall time on flight hardware, behavior inside an actual F Prime deployment, and the cost of the calls on blobs with other shapes (higher degrees, deeper trees, Hermite segments).
