# The compact orbit segment (EPHEM kind 4), measured

What kind 4 costs in bytes and in interpreter instructions, how its error grows with record length, why its record has the shape it has, and how it compares with a well-tuned Chebyshev segment (kind 1) on the same arc. `SPEC.md` defines the record and its evaluation; this file holds the numbers and how they were made.

Everything here is measured on synthetic orbiters. No real orbiter kernel was available, so `tools/synth-orbiter.mjs` integrates three trajectories under a point mass plus the J2 term about a fixed pole (an eighth-order symplectic integrator at a fixed 10-second step) and hands them to CSPICE as SPK type 13 segments. The slicer then reads them through CSPICE like any kernel. A real orbit also feels higher gravity terms, third bodies, drag, and radiation pressure, none of which are in these trajectories, so the errors below are a floor for the model, not a prediction for a mission. The lunar case is the most optimistic: real lunar gravity is far lumpier than J2.

## The model in one paragraph

A record is 160 bytes: six elements at the record's mid epoch (semi-major axis, the eccentricity vector in the orbit plane, inclination, node, mean argument of latitude), a rate for each, a quadratic term in the mean argument and one that bends the path of the eccentricity vector, and 19 coefficients of displacements in kilometers: radial, along-track, and cross-track, each with a cosine and a sine term at one, two, and three times the argument of latitude, plus a constant cross-track offset. The idea is that of the GPS broadcast ephemeris (elements, rates, and harmonic corrections), with the eccentricity carried as a vector so a circular orbit is regular. The harmonic terms are what make long records possible: the periodic effects of an oblate body have those frequencies, and fitting them (not deriving them) lets the same numbers soak up whatever else has them. With the elements and rates alone the low Earth orbiter below fits to about 1 km; with the full record, to well under a meter.

## Why the record grew from 104 bytes

The first draft of kind 4 was the GPS form exactly: 104 bytes, with corrections to the along-track angle, the radius, and the inclination at twice the argument of latitude only. It held the low Earth orbiter to about 30 m and the orbit of eccentricity 0.3 to about 1 km whatever the record length. Three things were missing, and each was found by fitting the old model and looking at what was left, as harmonics of the argument of latitude in the radial, along-track, and cross-track directions.

- **Eccentric orbits need the neighboring harmonics.** Twice the argument of latitude is where the J2 terms of a near-circular orbit sit. An eccentric orbit multiplies them by powers of the radius, which spreads them to one and three times the argument (and beyond, more weakly). On the orbit of eccentricity 0.3 with one-day records, the old model left 696 m of radial error at one times the argument and 487 m of cross-track error at twice it. Adding the first and third harmonics to the old corrections brought the six-hour fit from 407 m to 2.6 m.
- **A correction to the inclination cannot make every cross-track shape.** Its effect across the track is the correction times the sine of the argument of latitude, which is zero at the nodes. What the old model left on the low Earth orbiter was almost purely cross-track: a constant of 15 m plus 11 m at twice the argument, a second-order J2 effect that no inclination correction can produce. A cross-track displacement with its own constant and harmonics removes it (32 m to 1.5 m on six-hour records with nothing else changed), and with it the inclination correction is redundant, so the record carries displacements only.
- **The eccentricity vector does not move in a straight line.** It circles slowly as the periapsis precesses, and over a day the bend is a few meters of position. With the harmonics above in place the low Earth orbiter still stood at 7.4 m on one-day records and 28 m on two-day records, all of it from this. One number, the rate at which the vector's velocity turns, brings those to 0.3 m and 0.6 m; two independent quadratic terms did no better.

Displacements in kilometers also save a sine and cosine pair that the angle correction needed, which pays for most of the added arithmetic. The cost in space is 56 bytes per record, about half again. The tables below are for the new record; the old one's rows for one-day records were 30 m, 3.1 m, and 1.1 km.

Tried and not adopted: harmonics of the eccentric or the mean argument of latitude in place of the true one (no better; the mean argument is worse on the eccentric orbit, 12.5 m against 2.6 m on six-hour records); a fourth harmonic (no gain on one-day records); a node correction beside the inclination correction (as good as the cross-track displacement, with six more numbers); and quadratic terms for the node or the semi-major axis (little or no gain). A quadratic term for the inclination does help the lunar orbiter (2.2 m to 0.4 m on one-day records), because its plane precesses about a pole tilted from J2000; that is the reference plane question under "What remains", and it was left alone.

## Size against error

`tools/orbit-tradeoff.mjs` produced these tables. For each record length it cuts a kind 4 segment over six days with the slicer's own code and takes the worst error against CSPICE on a grid four times denser than the fit, record edges included. The kind 1 column is a search, not a single setting: record lengths of 0.25 to 4 orbits and every even degree from 4 to 40, each fitted and measured the same way over one day, and the smallest that is at least as accurate as the kind 4 row is shown. The last column is the ratio of the two sizes.

<!-- tradeoff-9001:start -->
**Low Earth orbiter** (synthetic; a = 6878.137 km, e = 0.0012, period 94.6 min). The smallest kind 1 segment on the grid with error under a millimeter is 7,131 bytes per day (degree 38, 189 min records).

| Kind 4 record length | Kind 4 bytes per day | Worst position error | Worst velocity error | Smallest kind 1 at least as accurate, bytes per day | Kind 1 over kind 4 |
| --- | --- | --- | --- | --- | --- |
| 30 min (0.3 orbits) | 7,680 | 455 mm | 2.9 mm/s | 5,303 (degree 28, 189 min records, 151 mm) | 0.7 |
| 1 h (0.6 orbits) | 3,840 | 91 mm | 1.2 mm/s | 5,669 (degree 30, 189 min records, 44 mm) | 1.5 |
| 3 h (1.9 orbits) | 1,280 | 99 mm | 0.38 mm/s | 5,669 (degree 30, 189 min records, 44 mm) | 4.4 |
| 6 h (3.8 orbits) | 640 | 110 mm | 0.37 mm/s | 5,669 (degree 30, 189 min records, 44 mm) | 8.9 |
| 12 h (7.6 orbits) | 320 | 129 mm | 0.37 mm/s | 5,669 (degree 30, 189 min records, 44 mm) | 17.7 |
| 1 d (15.2 orbits) | 160 | 303 mm | 0.44 mm/s | 5,303 (degree 28, 189 min records, 151 mm) | 33.1 |
| 2 d (30.4 orbits) | 80 | 541 mm | 0.51 mm/s | 5,303 (degree 28, 189 min records, 151 mm) | 66.3 |
| 3 d (45.7 orbits) | 53 | 1.4 m | 0.78 mm/s | 4,937 (degree 26, 189 min records, 809 mm) | 92.6 |
| 6 d (91.3 orbits) | 27 | 10 m | 5.4 mm/s | 4,503 (degree 36, 284 min records, 5.2 m) | 168.8 |
<!-- tradeoff-9001:end -->

<!-- tradeoff-9002:start -->
**Low lunar orbiter** (synthetic; a = 1837.4 km, e = 0.004, period 117.8 min). The smallest kind 1 segment on the grid with error under a millimeter is 4,833 bytes per day (degree 32, 236 min records).

| Kind 4 record length | Kind 4 bytes per day | Worst position error | Worst velocity error | Smallest kind 1 at least as accurate, bytes per day | Kind 1 over kind 4 |
| --- | --- | --- | --- | --- | --- |
| 30 min (0.3 orbits) | 7,680 | 42 mm | 0.34 mm/s | 4,247 (degree 28, 236 min records, 33 mm) | 0.6 |
| 1 h (0.5 orbits) | 3,840 | 38 mm | 0.3 mm/s | 4,247 (degree 28, 236 min records, 33 mm) | 1.1 |
| 3 h (1.5 orbits) | 1,280 | 41 mm | 0.061 mm/s | 4,247 (degree 28, 236 min records, 33 mm) | 3.3 |
| 6 h (3.1 orbits) | 640 | 128 mm | 0.15 mm/s | 3,954 (degree 26, 236 min records, 90 mm) | 6.2 |
| 12 h (6.1 orbits) | 320 | 540 mm | 0.53 mm/s | 3,661 (degree 24, 236 min records, 270 mm) | 11.4 |
| 1 d (12.2 orbits) | 160 | 2.2 m | 2 mm/s | 3,368 (degree 22, 236 min records, 1.9 m) | 21.1 |
| 2 d (24.5 orbits) | 80 | 9.1 m | 7.9 mm/s | 3,008 (degree 40, 471 min records, 6.7 m) | 37.6 |
| 3 d (36.7 orbits) | 53 | 21 m | 18 mm/s | 2,862 (degree 38, 471 min records, 17 m) | 53.7 |
| 6 d (73.4 orbits) | 27 | 82 m | 72 mm/s | 2,448 (degree 24, 353 min records, 61 m) | 91.8 |
<!-- tradeoff-9002:end -->

<!-- tradeoff-9003:start -->
**Eccentric Earth orbiter** (synthetic; a = 24400 km, e = 0.3, period 632.2 min). The smallest kind 1 segment on the grid with error under a millimeter is 3,609 bytes per day (degree 32, 316 min records).

| Kind 4 record length | Kind 4 bytes per day | Worst position error | Worst velocity error | Smallest kind 1 at least as accurate, bytes per day | Kind 1 over kind 4 |
| --- | --- | --- | --- | --- | --- |
| 30 min (0.0 orbits) | 7,680 | 8.9 mm | 0.094 mm/s | 3,390 (degree 30, 316 min records, 3 mm) | 0.4 |
| 1 h (0.1 orbits) | 3,840 | 17 mm | 0.086 mm/s | 3,172 (degree 28, 316 min records, 12 mm) | 0.8 |
| 3 h (0.3 orbits) | 1,280 | 357 mm | 1.7 mm/s | 2,734 (degree 24, 316 min records, 205 mm) | 2.1 |
| 6 h (0.6 orbits) | 640 | 220 mm | 0.75 mm/s | 2,734 (degree 24, 316 min records, 205 mm) | 4.3 |
| 12 h (1.1 orbits) | 320 | 2 m | 1.3 mm/s | 2,515 (degree 22, 316 min records, 820 mm) | 7.9 |
| 1 d (2.3 orbits) | 160 | 4.3 m | 1.3 mm/s | 2,297 (degree 20, 316 min records, 3.5 m) | 14.4 |
| 2 d (4.6 orbits) | 80 | 7.8 m | 1.5 mm/s | 2,297 (degree 20, 316 min records, 3.5 m) | 28.7 |
| 3 d (6.8 orbits) | 53 | 10 m | 1.8 mm/s | 2,297 (degree 20, 316 min records, 3.5 m) | 43.1 |
| 6 d (13.7 orbits) | 27 | 20 m | 2.6 mm/s | 2,078 (degree 18, 316 min records, 15 m) | 77.9 |
<!-- tradeoff-9003:end -->

How to read them:

- **One record per day is 160 bytes and holds all three synthetic orbiters to meters or better.** About 0.3 m for the low Earth orbiter, 2.2 m for the low lunar orbiter, and 4.3 m for the orbit of eccentricity 0.3. The smallest Chebyshev segment that does as well is 14 to 33 times larger. A month at one record per day is under 5 KB.
- **Longer records cost accuracy slowly.** At two days per record (80 bytes per day) the three stand at 0.5 m, 9 m, and 8 m; at six days, 10 m, 82 m, and 20 m. What grows is the part of the slow drift that straight-line rates and the two quadratic terms do not follow. The lunar orbiter grows fastest because its elements are referred to J2000 and its plane precesses about a tilted pole.
- **Short records are no place for kind 4.** Below about one orbit per record a Chebyshev segment is as small or smaller, and the fit of 33 numbers to a fraction of an orbit is poorly determined: the low Earth orbiter at 30-minute records fits to 455 mm, worse than at one hour, and worse than the old 19-number record did there (46 mm).
- **Eccentricity is no longer the weak case, on this evidence.** One orbit at an eccentricity of 0.3 is all that has been tried; nothing here says how the fit holds at 0.6 or 0.8, where more harmonics matter.
- **Kind 1 was undersold.** The Cassini segment in `SPEC.md` (76 KB for two days) uses ten-minute records at degree 10 through a hyperbolic periapsis. On a closed orbit, long records at high degree are far smaller: about 4 to 7 KB per day for the low Earth orbiter at meter to millimeter accuracy, so a month is 130 to 210 KB, inside the 1 MiB limit. The price is evaluation cost, which grows with degree: the measured kind 1 costs (1,711 instructions at degree 10, 1,982 at degree 12) extrapolate to roughly 5,000 at degree 34, an estimate that has not been measured.

## Cost under SpaceWasm

`scripts/measure-cost-orbit.mjs`, with the same host harness and method as `scripts/measure-cost.mjs` (`docs/cost-measurements.md`), on the shipped one-page module and the `orbiter` test blob. Each orbiter is queried at 400 times across the window, because the cost varies with the number of Kepler steps. The last row is the worst case the model accepts: a record with its eccentricity forced to the limit of 0.9, queried at 1,000 times around the orbit with the periapsis in each of four directions. Author's clang 18 build.

<!-- cost-table:start -->
| Call | Instructions (least to most) | Mean | Slices of 1,000 |
| --- | --- | --- | --- |
| lite_state, near-circular low Earth orbiter (e = 0.001), geometric, one kind 4 segment | 2,127 to 2,277 | 2,269 | 3 |
| lite_state, near-circular low lunar orbiter (e = 0.004), geometric, one kind 4 segment | 2,079 to 2,229 | 2,226 | 3 |
| lite_state, eccentric Earth orbiter (e = 0.3), geometric, one kind 4 segment | 2,061 to 2,209 | 2,207 | 3 |
| lite_state, low Earth orbiter from the Earth-Moon barycenter (kind 4, then kind 1 at degree 12) | 3,600 | 3,600 | 4 |
| lite_state, low Earth orbiter from the Moon (kind 4, then two of kind 1) | 5,057 | 5,057 | 6 |
| lite_state, low lunar orbiter from the low Earth orbiter (two of kind 4, two of kind 1) | 6,731 | 6,731 | 7 |
| lite_state, one kind 4 segment with the eccentricity forced to the limit of 0.9 (cost only) | 2,273 to 2,459 | 2,387 | 3 |
<!-- cost-table:end -->

A kind 4 state costs a little more than a degree 12 Chebyshev record and is within the 2,500-instruction ceiling `SPEC.md` sets for a one-segment geometric state at every eccentricity the model accepts: the worst call at the limit of 0.9 is 2,459 instructions, and the script holds that case to the same 2,500 as the others. Most of the cost is trigonometry: three full sine and cosine pairs (mean argument, inclination, node) and one more for each Kepler step after the first, at about 150 instructions a step.

### The Kepler solve

The first draft solved Kepler's equation by Newton steps from a zero offset and took up to seven of them at an eccentricity of 0.9, where a state cost up to 3,207 instructions. The solve now takes the fourth-order step of Danby: a Newton step, refined by Halley's formula, refined again with the third derivative. For this equation the higher derivatives are free (the second is the offset minus the function, the third is one minus the first), so a step costs a dozen more multiplications and no more trigonometry. The first step starts from a zero offset, where the sine and cosine are known. An offset between 0.78 and 1.56 radians, beyond the range of the library's sine and cosine kernel, is evaluated at half the angle and doubled, which avoids the general range reduction. A step of at most 1e-4 radians is the last, and the sine and cosine are turned through it by a third-order series. Everything is add, subtract, multiply, and divide, so the WebAssembly and native builds agree bit for bit, as the committed vectors check.

Convergence is established by scan, not by proof. `test/kepler-scan.c` includes the library source and runs the compiled solve over a grid of eccentricity and mean anomaly, with a second grid of mean anomalies packed within 0.2 radians of periapsis, comparing the returned sine and cosine with a long double solve. Compiled with gcc at the library's flags:

| Scan | Solves | One step | Two steps | Three steps | More | Failures | Worst error in the sine or cosine |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 901 eccentricities from 0 to 0.9, 40,000 mean anomalies each | 36,040,000 | 114,230 | 25,762,820 | 10,162,950 | 0 | 0 | 5.2e-16 |
| 991 eccentricities from 0 to 0.99, 8,000 mean anomalies each (beyond what the model accepts) | 7,928,000 | 22,360 | 5,275,624 | 2,431,412 | 198,604 | 0 | 1.6e-15 |

Three steps are the most up to the limit, and the third first appears at an eccentricity of 0.305. The margin above the limit is thin in eccentricity: on the second scan a fourth step first appears at 0.908 and a fifth at 0.986. The cap is six steps, after which the query returns the unsupported status; the scans never reach it. The worst error is rounding: near periapsis at high eccentricity the equation itself magnifies a rounding error in its inputs by up to ten. The test suite runs a coarser scan (181 eccentricities, 8,000 mean anomalies each) on every run, and sweeps the WebAssembly build over 91 eccentricities from 0 to 0.9 to confirm that every query is answered and agrees with the ground mirror.

The wider record and the new solve grew the module by 411 bytes with the author's clang 18, and the compiled SpaceWasm IR by 728 bytes. The other calls did not get dearer (a one-segment Chebyshev state went from 2,002 to 1,996 instructions). `SPEC.md` and `docs/cost-measurements.md` carry the figures for the combined library.

## What the tests hold

`test/orbit.test.mjs` runs the same tiers as the other blobs on `test/blobs/orbiter.slb` (8,880 bytes: three synthetic orbiters as kind 4, with Earth and Moon from DE440 as kind 1): committed vectors reproduced bit for bit by the WebAssembly and native builds; every state within 1.5 times the declared bounds against CSPICE, including both sides of every record boundary; the Kepler scans described above; 200,000 corrupted blobs under the sanitizers; damaged records answered with the unsupported status; and 20,000 records of random bits without a trap.

## What remains

- **Real kernels.** Fit a real low lunar orbiter (LRO), a real low Earth orbiter, and a Mars orbiter from their SPK files and repeat the tables. Expect the errors to rise, most of all at the Moon. Sub-meter figures in particular are a statement about a point mass plus J2, not about any real orbit.
- **Maneuvers.** A record that spans a burn will fit badly and say so in its error; the slicer does not yet split records at maneuvers.
- **Higher eccentricity.** The fit has been measured at an eccentricity of 0.3 only. The evaluation is tested up to 0.9 for cost and convergence, not for accuracy.
- **Reference plane.** Elements are referred to J2000. For an orbiter of a body whose equator is tilted from J2000 the node and inclination both drift as the orbit plane precesses about the body's pole; straight-line rates follow that over a day or two (the lunar case above does exactly this), but a per-segment pole, or quadratic terms for the plane, would hold longer.
- **Conditioning of the fit.** On a near-circular orbit the first harmonics are nearly interchangeable with small changes to the eccentricity vector, the inclination, and the node. The damped least-squares fit copes, and the declared error is measured after the fact either way, but records shorter than an orbit fit worse than they should.
- **Continuity.** Neighboring records are fitted independently, so the state steps at a record boundary by up to twice the declared error.
- **Cost margin.** The worst case is 41 instructions under the ceiling with the author's compiler. Another compiler version may land differently, and the cost script will say so.
