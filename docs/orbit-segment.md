# The compact orbit segment (EPHEM kind 4), measured

What kind 4 costs in bytes and in interpreter instructions, how its error grows with record length, and how it compares with a well-tuned Chebyshev segment (kind 1) on the same arc. `SPEC.md` defines the record and its evaluation; this file holds the numbers and how they were made.

Everything here is measured on synthetic orbiters. No real orbiter kernel was available, so `tools/synth-orbiter.mjs` integrates three trajectories under a point mass plus the J2 term about a fixed pole (an eighth-order symplectic integrator at a fixed 10-second step) and hands them to CSPICE as SPK type 13 segments. The slicer then reads them through CSPICE like any kernel. A real orbit also feels higher gravity terms, third bodies, drag, and radiation pressure, none of which are in these trajectories, so the errors below are a floor for the model, not a prediction for a mission. The lunar case is the most optimistic: real lunar gravity is far lumpier than J2.

## The model in one paragraph

A record is 104 bytes: six elements at the record's mid epoch (semi-major axis, the eccentricity vector in the orbit plane, inclination, node, mean argument of latitude), a rate for each plus a quadratic term in the mean argument, and six coefficients of corrections in twice the argument of latitude to the along-track angle, the radius, and the inclination. This is the form of the GPS broadcast ephemeris, with the eccentricity carried as a vector so a circular orbit is regular. The harmonic terms are what make long records possible: the largest periodic effect of an oblate body on a near-circular orbit has exactly that shape, and fitting it (not deriving it) lets the same six numbers soak up whatever else has that frequency. Without them the low Earth orbiter below fits to about 1 km; with them, to about 30 m.

## Size against error

`tools/orbit-tradeoff.mjs` produced these tables. For each record length it cuts a kind 4 segment over six days with the slicer's own code and takes the worst error against CSPICE on a grid four times denser than the fit, record edges included. The kind 1 column is a search, not a single setting: record lengths of 0.25 to 4 orbits and every even degree from 4 to 40, each fitted and measured the same way over one day, and the smallest that is at least as accurate as the kind 4 row is shown. The last column is the ratio of the two sizes.

<!-- tradeoff-9001:start -->
**Low Earth orbiter** (synthetic; a = 6878.137 km, e = 0.0012, period 94.6 min). The smallest kind 1 segment on the grid with error under a millimeter is 7,131 bytes per day (degree 38, 189 min records).

| Kind 4 record length | Kind 4 bytes per day | Worst position error | Worst velocity error | Smallest kind 1 at least as accurate, bytes per day | Kind 1 over kind 4 |
| --- | --- | --- | --- | --- | --- |
| 30 min (0.3 orbits) | 4,992 | 46 mm | 0.72 mm/s | 5,669 (degree 30, 189 min records, 44 mm) | 1.1 |
| 1 h (0.6 orbits) | 2,496 | 4.7 m | 34 mm/s | 4,746 (degree 38, 284 min records, 1.9 m) | 1.9 |
| 3 h (1.9 orbits) | 832 | 32 m | 35 mm/s | 4,259 (degree 34, 284 min records, 15 m) | 5.1 |
| 6 h (3.8 orbits) | 416 | 33 m | 29 mm/s | 4,259 (degree 34, 284 min records, 15 m) | 10.2 |
| 12 h (7.6 orbits) | 208 | 30 m | 27 mm/s | 4,259 (degree 34, 284 min records, 15 m) | 20.5 |
| 1 d (15.2 orbits) | 104 | 30 m | 26 mm/s | 4,259 (degree 34, 284 min records, 15 m) | 41.0 |
| 2 d (30.4 orbits) | 52 | 41 m | 31 mm/s | 4,206 (degree 22, 189 min records, 33 m) | 80.9 |
| 3 d (45.7 orbits) | 35 | 71 m | 48 mm/s | 4,016 (degree 32, 284 min records, 45 m) | 115.8 |
| 6 d (91.3 orbits) | 17 | 272 m | 159 mm/s | 3,749 (degree 40, 378 min records, 102 m) | 216.3 |
<!-- tradeoff-9001:end -->

<!-- tradeoff-9002:start -->
**Low lunar orbiter** (synthetic; a = 1837.4 km, e = 0.004, period 117.8 min). The smallest kind 1 segment on the grid with error under a millimeter is 4,833 bytes per day (degree 32, 236 min records).

| Kind 4 record length | Kind 4 bytes per day | Worst position error | Worst velocity error | Smallest kind 1 at least as accurate, bytes per day | Kind 1 over kind 4 |
| --- | --- | --- | --- | --- | --- |
| 30 min (0.3 orbits) | 4,992 | 0.89 mm | 0.013 mm/s | 5,125 (degree 34, 236 min records, 0.25 mm) | 1.0 |
| 1 h (0.5 orbits) | 2,496 | 67 mm | 0.61 mm/s | 4,247 (degree 28, 236 min records, 33 mm) | 1.7 |
| 3 h (1.5 orbits) | 832 | 2.7 m | 2.4 mm/s | 3,368 (degree 22, 236 min records, 1.9 m) | 4.0 |
| 6 h (3.1 orbits) | 416 | 2.4 m | 2.1 mm/s | 3,368 (degree 22, 236 min records, 1.9 m) | 8.1 |
| 12 h (6.1 orbits) | 208 | 2.4 m | 2.2 mm/s | 3,368 (degree 22, 236 min records, 1.9 m) | 16.2 |
| 1 d (12.2 orbits) | 104 | 3.1 m | 3.1 mm/s | 3,368 (degree 22, 236 min records, 1.9 m) | 32.4 |
| 2 d (24.5 orbits) | 52 | 9.3 m | 8.6 mm/s | 3,008 (degree 40, 471 min records, 6.7 m) | 57.9 |
| 3 d (36.7 orbits) | 35 | 20 m | 18 mm/s | 2,862 (degree 38, 471 min records, 17 m) | 82.5 |
| 6 d (73.4 orbits) | 17 | 82 m | 72 mm/s | 2,448 (degree 24, 353 min records, 61 m) | 141.2 |
<!-- tradeoff-9002:end -->

<!-- tradeoff-9003:start -->
**Eccentric Earth orbiter** (synthetic; a = 24400 km, e = 0.3, period 632.2 min). The smallest kind 1 segment on the grid with error under a millimeter is 3,609 bytes per day (degree 32, 316 min records).

| Kind 4 record length | Kind 4 bytes per day | Worst position error | Worst velocity error | Smallest kind 1 at least as accurate, bytes per day | Kind 1 over kind 4 |
| --- | --- | --- | --- | --- | --- |
| 30 min (0.0 orbits) | 4,992 | 0.59 mm | 0.0078 mm/s | 3,828 (degree 34, 316 min records, 0.28 mm) | 0.8 |
| 1 h (0.1 orbits) | 2,496 | 32 mm | 0.24 mm/s | 3,172 (degree 28, 316 min records, 12 mm) | 1.3 |
| 3 h (0.3 orbits) | 832 | 10 m | 30 mm/s | 2,297 (degree 20, 316 min records, 3.5 m) | 2.8 |
| 6 h (0.6 orbits) | 416 | 447 m | 255 mm/s | 1,641 (degree 14, 316 min records, 287 m) | 3.9 |
| 12 h (1.1 orbits) | 208 | 1 km | 440 mm/s | 1,586 (degree 28, 632 min records, 903 m) | 7.6 |
| 1 d (2.3 orbits) | 104 | 1.1 km | 405 mm/s | 1,586 (degree 28, 632 min records, 903 m) | 15.2 |
| 2 d (4.6 orbits) | 52 | 1 km | 393 mm/s | 1,586 (degree 28, 632 min records, 903 m) | 30.5 |
| 3 d (6.8 orbits) | 35 | 1 km | 375 mm/s | 1,586 (degree 28, 632 min records, 903 m) | 45.7 |
| 6 d (13.7 orbits) | 17 | 1.1 km | 371 mm/s | 1,586 (degree 28, 632 min records, 903 m) | 91.5 |
<!-- tradeoff-9003:end -->

How to read them:

- **Near-circular orbits are where kind 4 pays.** One record per day is 104 bytes and holds the synthetic low Earth orbiter to about 30 m and the low lunar orbiter to about 3 m. The smallest Chebyshev segment that does as well is 30 to 40 times larger. A month at one record per day is about 3 KB.
- **The error has a floor, then grows.** From about two orbits per record up to a day the error barely moves: it is what the model cannot represent (terms beyond twice the argument of latitude, and second-order effects), not a matter of record length. Past a day or two it grows, because straight-line rates stop describing the slow drift of the elements. Records shorter than about one orbit drive the error down toward millimeters, but by then a Chebyshev segment is as small or smaller, so there is no reason to use kind 4 that way.
- **Eccentric orbits fit poorly.** At an eccentricity of 0.3 the floor is about 1 km, because the periodic terms of an eccentric orbit are not concentrated at twice the argument of latitude. Kind 4 is still much smaller than kind 1 at that accuracy, but a mission that needs better than a kilometer on such an orbit should use kind 1.
- **Kind 1 was undersold.** The Cassini segment in `SPEC.md` (76 KB for two days) uses ten-minute records at degree 10 through a hyperbolic periapsis. On a closed orbit, long records at high degree are far smaller: about 4 to 7 KB per day for the low Earth orbiter at meter to millimeter accuracy, so a month is 130 to 210 KB, inside the 1 MiB limit. The price is evaluation cost, which grows with degree: the measured kind 1 costs (1,711 instructions at degree 10, 1,982 at degree 12) extrapolate to roughly 5,000 at degree 34, an estimate that has not been measured.

## Cost under SpaceWasm

`scripts/measure-cost-orbit.mjs`, with the same host harness and method as `scripts/measure-cost.mjs` (`docs/cost-measurements.md`), on the shipped one-page module and the `orbiter` test blob. Each orbiter is queried at 400 times across the window, because the cost varies with the number of Kepler iterations. Author's clang 18 build.

<!-- cost-table:start -->
| Call | Instructions (least to most) | Mean | Slices of 1,000 |
| --- | --- | --- | --- |
| lite_state, near-circular low Earth orbiter (e = 0.001), geometric, one kind 4 segment | 2,117 to 2,121 | 2,119 | 3 |
| lite_state, near-circular low lunar orbiter (e = 0.004), geometric, one kind 4 segment | 2,069 to 2,192 | 2,138 | 3 |
| lite_state, eccentric Earth orbiter (e = 0.3), geometric, one kind 4 segment | 2,048 to 2,290 | 2,263 | 3 |
| lite_state, low Earth orbiter from the Earth-Moon barycenter (kind 4, then kind 1 at degree 12) | 3,450 | 3,450 | 4 |
| lite_state, low Earth orbiter from the Moon (kind 4, then two of kind 1) | 4,913 | 4,913 | 5 |
| lite_state, low lunar orbiter from the low Earth orbiter (two of kind 4, two of kind 1) | 6,550 | 6,550 | 7 |
| lite_state, one kind 4 segment with the eccentricity forced to the limit of 0.9 (cost only) | 2,119 to 3,207 | 2,658 | 4 |
<!-- cost-table:end -->

A kind 4 state costs about what a degree 12 Chebyshev record does, and is within the 2,500-instruction ceiling `SPEC.md` sets for a one-segment geometric state up to the eccentricities tested (0.3). It is not within that ceiling everywhere the model is accepted: with the eccentricity forced to the limit of 0.9 the Kepler solve takes several more steps and the worst call is 3,207 instructions. The script holds that case to 3,500. Most of the cost is trigonometry: three full sine and cosine pairs (mean argument, inclination, node), one reduced pair for the along-track correction, and one per Kepler step but the last.

Adding kind 4 grew the module from 14,695 to 16,650 bytes with the author's clang 18. The compiled SpaceWasm IR went from 23,120 to 26,570 bytes and the interpreter heap for the load from 25,282 to 40,861 bytes, and the existing calls cost about 1% more (a one-segment Chebyshev state went from 1,982 to 2,002 instructions); all remain inside their ceilings. The figures in `SPEC.md` and `docs/cost-measurements.md` for the other calls predate kind 4 and were not regenerated on this branch.

## What the tests hold

`test/orbit.test.mjs` runs the same tiers as the other blobs on `test/blobs/orbiter.slb` (6,864 bytes: three synthetic orbiters as kind 4, with Earth and Moon from DE440 as kind 1): committed vectors reproduced bit for bit by the WebAssembly and native builds; every state within 1.5 times the declared bounds against CSPICE, including both sides of every record boundary; 200,000 corrupted blobs under the sanitizers; damaged records answered with the unsupported status; and 20,000 records of random bits without a trap.

## What remains

- **Real kernels.** Fit a real low lunar orbiter (LRO), a real low Earth orbiter, and a Mars orbiter from their SPK files and repeat the tables. Expect the floor to rise, most of all at the Moon.
- **Maneuvers.** A record that spans a burn will fit badly and say so in its error; the slicer does not yet split records at maneuvers.
- **More harmonics for eccentric orbits.** Terms at one and three times the argument of latitude, or corrections in true anomaly, would lower the 1 km floor at an eccentricity of 0.3. Not tried.
- **Reference plane.** Elements are referred to J2000. For an orbiter of a body whose equator is tilted from J2000 the node and inclination both drift as the orbit plane precesses about the body's pole; straight-line rates follow that over a day or two (the lunar case above does exactly this), but a per-segment pole would hold longer.
- **Continuity.** Neighboring records are fitted independently, so the state steps at a record boundary by up to twice the declared error.
- **Worst-case cost.** The 3,207-instruction case could be cut with a better starting guess for the Kepler solve at high eccentricity.
