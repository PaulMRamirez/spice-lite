# The compact orbit segment (EPHEM kind 4), measured

[Documentation index](README.md) · To use this segment: [Cutting a blob: a long arc of a closed orbit](slicer.md#a-long-arc-of-a-closed-orbit) · Related: [Real mission kernels](real-kernels.md)

What kind 4 costs in bytes and in interpreter instructions, how its error grows with record length, why its record has the shape it has, and how it compares with a well-tuned Chebyshev segment (kind 1) on the same arc. `SPEC.md` defines the record and its evaluation; this file holds the numbers and how they were made.

The model was designed and tuned on synthetic orbiters, and has since been measured on three real ones. The synthetic trajectories come from `tools/synth-orbiter.mjs`, which integrates a point mass plus the J2 term about a fixed pole (an eighth-order symplectic integrator at a fixed 10-second step) and hands the result to CSPICE as SPK type 13 segments. The real ones are the reconstructed trajectories of the Lunar Reconnaissance Orbiter, the Mars Reconnaissance Orbiter, and MAVEN, from NAIF's public kernels (`docs/real-kernels.md` lists them; none is committed here). The slicer reads both through CSPICE like any kernel.

The short version, stated plainly: the synthetic figures are a floor, and real orbits are far above it. On a point mass plus J2 a one-day record holds a low orbit to meters or better. On the real orbiters a one-day record is off by 2.4 km at the Moon and 15 km at Mars, and it takes records of an hour or less to reach tens of meters, at which length a Chebyshev segment is about as small. "Real orbiters" below has the tables and the reason.

## The model in one paragraph

A record is 160 bytes: six elements at the record's mid epoch (semi-major axis, the eccentricity vector in the orbit plane, inclination, node, mean argument of latitude), a rate for each, a quadratic term in the mean argument and one that bends the path of the eccentricity vector, and 19 coefficients of displacements in kilometers: radial, along-track, and cross-track, each with a cosine and a sine term at one, two, and three times the argument of latitude, plus a constant cross-track offset. The idea is that of the GPS broadcast ephemeris (elements, rates, and harmonic corrections), with the eccentricity carried as a vector so a circular orbit is regular. The harmonic terms are what make long records possible: the periodic effects of an oblate body have those frequencies, and fitting them (not deriving them) lets the same numbers soak up whatever else has them. With the elements and rates alone the low Earth orbiter below fits to about 1 km; with the full record, to well under a meter.

## Why the record grew from 104 bytes

The first draft of kind 4 was the GPS form exactly: 104 bytes, with corrections to the along-track angle, the radius, and the inclination at twice the argument of latitude only. It held the low Earth orbiter to about 30 m and the orbit of eccentricity 0.3 to about 1 km whatever the record length. Three things were missing, and each was found by fitting the old model and looking at what was left, as harmonics of the argument of latitude in the radial, along-track, and cross-track directions.

- **Eccentric orbits need the neighboring harmonics.** Twice the argument of latitude is where the J2 terms of a near-circular orbit sit. An eccentric orbit multiplies them by powers of the radius, which spreads them to one and three times the argument (and beyond, more weakly). On the orbit of eccentricity 0.3 with one-day records, the old model left 696 m of radial error at one times the argument and 487 m of cross-track error at twice it. Adding the first and third harmonics to the old corrections brought the six-hour fit from 407 m to 2.6 m.
- **A correction to the inclination cannot make every cross-track shape.** Its effect across the track is the correction times the sine of the argument of latitude, which is zero at the nodes. What the old model left on the low Earth orbiter was almost purely cross-track: a constant of 15 m plus 11 m at twice the argument, a second-order J2 effect that no inclination correction can produce. A cross-track displacement with its own constant and harmonics removes it (32 m to 1.5 m on six-hour records with nothing else changed), and with it the inclination correction is redundant, so the record carries displacements only.
- **The eccentricity vector does not move in a straight line.** It circles slowly as the periapsis precesses, and over a day the bend is a few meters of position. With the harmonics above in place the low Earth orbiter still stood at 7.4 m on one-day records and 28 m on two-day records, all of it from this. One number, the rate at which the vector's velocity turns, brings those to 0.3 m and 0.6 m; two independent quadratic terms did no better.

Displacements in kilometers also save a sine and cosine pair that the angle correction needed, which pays for most of the added arithmetic. The cost in space is 56 bytes per record, about half again. The tables below are for the new record; the old one's rows for one-day records were 30 m, 3.1 m, and 1.1 km.

Tried and not adopted: harmonics of the eccentric or the mean argument of latitude in place of the true one (no better; the mean argument is worse on the eccentric orbit, 12.5 m against 2.6 m on six-hour records); a fourth harmonic (no gain on one-day records); a node correction beside the inclination correction (as good as the cross-track displacement, with six more numbers); and quadratic terms for the node or the semi-major axis (little or no gain). A quadratic term for the inclination does help the lunar orbiter (2.2 m to 0.4 m on one-day records), because its plane precesses about a pole tilted from J2000; that is the reference plane question under "What remains", and it was left alone.

## Size against error, synthetic orbiters

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

How to read them (these four points are about a point mass plus J2 only; the next section says what survives contact with real orbits):

- **One record per day is 160 bytes and holds all three synthetic orbiters to meters or better.** About 0.3 m for the low Earth orbiter, 2.2 m for the low lunar orbiter, and 4.3 m for the orbit of eccentricity 0.3. The smallest Chebyshev segment that does as well is 14 to 33 times larger. A month at one record per day is under 5 KB.
- **Longer records cost accuracy slowly.** At two days per record (80 bytes per day) the three stand at 0.5 m, 9 m, and 8 m; at six days, 10 m, 82 m, and 20 m. What grows is the part of the slow drift that straight-line rates and the two quadratic terms do not follow. The lunar orbiter grows fastest because its elements are referred to J2000 and its plane precesses about a tilted pole.
- **Short records are no place for kind 4.** Below about one orbit per record a Chebyshev segment is as small or smaller, and the fit of 33 numbers to a fraction of an orbit is poorly determined: the low Earth orbiter at 30-minute records fits to 455 mm, worse than at one hour, and worse than the old 19-number record did there (46 mm).
- **Eccentricity is no longer the weak case, on this evidence.** One synthetic orbit at an eccentricity of 0.3 is all that has been tried here; MAVEN, below, is a real one at 0.47. Nothing says how the fit holds at 0.6 or 0.8, where more harmonics matter.
- **Kind 1 was undersold.** The Cassini segment in `SPEC.md` (76 KB for two days) uses ten-minute records at degree 10 through a hyperbolic periapsis. On a closed orbit, long records at high degree are far smaller: about 4 to 7 KB per day for the low Earth orbiter at meter to millimeter accuracy, so a month is 130 to 210 KB, inside the 1 MiB limit. The price is evaluation cost, which grows with degree at 70.5 instructions each: a one-segment state passes the 2,500 ceiling at degree 26 in the smallest blob and at degree 24 in a larger one, and costs 3,125 at degree 34 (`docs/cost-measurements.md`, "A Chebyshev state against its degree"). An earlier version of this file guessed 5,000 at degree 34.

## Real orbiters

`tools/real-kernels.mjs` fits the same segment to three real spacecraft with the slicer's own code and measures it the same way as the synthetic tables: worst error against CSPICE on a grid four times denser than the fit, record edges included, with the same search for the smallest kind 1 segment that does as well. The windows were chosen to hold no maneuver, and the tool checks that by the step in orbit-mean semi-major axis from one orbit to the next. Reconstructed kernels also have seams, where one orbit solution hands over to the next and the position steps by meters to a hundred meters; the tool finds them, and the windows for LRO and MAVEN are shorter than six days so as to sit between two seams (36 m and 124 m steps respectively). MRO's kernel has two inside its window, of half a meter, far below the errors in its table. A record that spans a seam cannot fit better than about half the step, which is the kernel's doing and not the model's.

Worst position error of kind 4 by record length, each real orbiter beside the synthetic one nearest to it (the six tables above and below hold the detail):

<!-- side-by-side:start -->
| Kind 4 record length | Low lunar orbiter, synthetic | LRO, real | Low Earth orbiter, synthetic | MRO, real | Earth orbiter at e = 0.3, synthetic | MAVEN at e = 0.47, real |
| --- | --- | --- | --- | --- | --- | --- |
| 30 min | 42 mm | 11 m | 455 mm | 15 m | 8.9 mm | 2.1 m |
| 1 h | 38 mm | 24 m | 91 mm | 33 m | 17 mm | 3.9 m |
| 3 h | 41 mm | 60 m | 99 mm | 1.6 km | 357 mm | 14 m |
| 6 h | 128 mm | 184 m | 110 mm | 3.8 km | 220 mm | 1.6 km |
| 12 h | 540 mm | 545 m | 129 mm | 12 km | 2 m | 3.6 km |
| 1 d | 2.2 m | 2.4 km | 303 mm | 15 km | 4.3 m | 5.7 km |
| 2 d | 9.1 m | 6.6 km | 541 mm | 16 km | 7.8 m | not measured |
| 3 d | 21 m | not measured | 1.4 m | 15 km | 10 m | not measured |
| 6 d | 82 m | not measured | 10 m | 18 km | 20 m | not measured |
<!-- side-by-side:end -->

<!-- tradeoff-real-lro:start -->
**Lunar Reconnaissance Orbiter** (real; 2 days from 2010-01-15 12:00 UTC, mean a = 1787.9 km, mean e = 0.0068, period 113.1 min). The orbit-mean semi-major axis moves by at most 2.7 m from one orbit to the next, so the window holds no maneuver; the window was placed between the seams of the kernel, which steps in position by up to 36 m where one orbit solution hands over to the next (2 such seams within three days of the window). No kind 1 segment on the grid reaches a millimeter; the most accurate is 48,137 bytes per day (degree 38, 28 min records), at 98 mm. For contrast, the day from 2010-01-13 holds a station-keeping maneuver (the orbit-mean semi-major axis steps by 11 km), and one record across it fits to 73 km.

| Kind 4 record length | Kind 4 bytes per day | Worst position error | Worst velocity error | Smallest kind 1 at least as accurate, bytes per day | Kind 1 over kind 4 |
| --- | --- | --- | --- | --- | --- |
| 30 min (0.3 orbits) | 7,680 | 11 m | 296 mm/s | 6,669 (degree 10, 57 min records, 10 m) | 0.9 |
| 1 h (0.5 orbits) | 3,840 | 24 m | 327 mm/s | 5,199 (degree 16, 113 min records, 23 m) | 1.4 |
| 3 h (1.6 orbits) | 1,280 | 60 m | 337 mm/s | 3,135 (degree 40, 452 min records, 59 m) | 2.4 |
| 6 h (3.2 orbits) | 640 | 184 m | 379 mm/s | 2,523 (degree 32, 452 min records, 149 m) | 3.9 |
| 12 h (6.4 orbits) | 320 | 545 m | 536 mm/s | 2,345 (degree 22, 339 min records, 387 m) | 7.3 |
| 1 d (12.7 orbits) | 160 | 2.4 km | 1.5 m/s | 2,064 (degree 26, 452 min records, 1.9 km) | 12.9 |
| 2 d (25.5 orbits) | 80 | 6.6 km | 4.7 m/s | 1,912 (degree 24, 452 min records, 5.1 km) | 23.9 |
<!-- tradeoff-real-lro:end -->

<!-- tradeoff-real-mro:start -->
**Mars Reconnaissance Orbiter** (real; 6 days from 2009-01-10 00:00 UTC, mean a = 3657.4 km, mean e = 0.0092, period 111.9 min). The orbit-mean semi-major axis moves by at most 180 m from one orbit to the next, so the window holds no maneuver; the kernel itself steps in position at 2 seams inside the window, by up to 488 mm. No kind 1 segment on the grid reaches a millimeter; the most accurate is 50,606 bytes per day (degree 40, 28 min records), at 11 mm.

| Kind 4 record length | Kind 4 bytes per day | Worst position error | Worst velocity error | Smallest kind 1 at least as accurate, bytes per day | Kind 1 over kind 4 |
| --- | --- | --- | --- | --- | --- |
| 30 min (0.3 orbits) | 7,680 | 15 m | 161 mm/s | 6,789 (degree 10, 56 min records, 8.1 m) | 0.9 |
| 1 h (0.5 orbits) | 3,840 | 33 m | 243 mm/s | 4,629 (degree 14, 112 min records, 32 m) | 1.2 |
| 3 h (1.6 orbits) | 1,280 | 1.6 km | 1.9 m/s | 2,777 (degree 26, 336 min records, 1.3 km) | 2.2 |
| 6 h (3.2 orbits) | 640 | 3.8 km | 4 m/s | 2,237 (degree 28, 448 min records, 3.6 km) | 3.5 |
| 12 h (6.4 orbits) | 320 | 12 km | 11 m/s | 2,006 (degree 12, 224 min records, 11 km) | 6.3 |
| 1 d (12.9 orbits) | 160 | 15 km | 13 m/s | 1,929 (degree 24, 448 min records, 14 km) | 12.1 |
| 2 d (25.7 orbits) | 80 | 16 km | 14 m/s | 1,929 (degree 24, 448 min records, 14 km) | 24.1 |
| 3 d (38.6 orbits) | 53 | 15 km | 14 m/s | 1,929 (degree 24, 448 min records, 14 km) | 36.2 |
| 6 d (77.2 orbits) | 27 | 18 km | 17 m/s | 1,929 (degree 24, 448 min records, 14 km) | 72.3 |
<!-- tradeoff-real-mro:end -->

<!-- tradeoff-real-maven:start -->
**MAVEN** (real; one day from 2015-01-19 06:00 UTC, mean a = 6652.6 km, mean e = 0.4689, period 274.6 min). The orbit-mean semi-major axis moves by at most 643 m from one orbit to the next, so the window holds no maneuver; the window was placed between the seams of the kernel, which steps in position by up to 124 m where one orbit solution hands over to the next (7 such seams within three days of the window). No kind 1 segment on the grid reaches a millimeter; the most accurate is 19,534 bytes per day (degree 38, 69 min records), at 328 mm.

| Kind 4 record length | Kind 4 bytes per day | Worst position error | Worst velocity error | Smallest kind 1 at least as accurate, bytes per day | Kind 1 over kind 4 |
| --- | --- | --- | --- | --- | --- |
| 30 min (0.1 orbits) | 7,680 | 2.1 m | 43 mm/s | 9,334 (degree 36, 137 min records, 1.8 m) | 1.2 |
| 1 h (0.2 orbits) | 3,840 | 3.9 m | 46 mm/s | 5,153 (degree 40, 275 min records, 3.2 m) | 1.3 |
| 3 h (0.7 orbits) | 1,280 | 14 m | 81 mm/s | 4,399 (degree 34, 275 min records, 11 m) | 3.4 |
| 6 h (1.3 orbits) | 640 | 1.6 km | 1.3 m/s | 2,890 (degree 22, 275 min records, 767 m) | 4.5 |
| 12 h (2.6 orbits) | 320 | 3.6 km | 1.8 m/s | 2,388 (degree 18, 275 min records, 3.5 km) | 7.5 |
| 1 d (5.2 orbits) | 160 | 5.7 km | 4.7 m/s | 2,388 (degree 18, 275 min records, 3.5 km) | 14.9 |
<!-- tradeoff-real-maven:end -->

Where real data is worse, which is everywhere:

- **By three to nearly five orders of magnitude at one record per day.** A one-day record is off by 2.4 km for LRO, 15 km for MRO, and 5.7 km for MAVEN. The synthetic figures beside them are 2.2 m, 0.3 m, and 4.3 m.
- **The cause is the rotating gravity field, which the model has no term for.** The record's harmonics are tied to the argument of latitude, so they can follow anything that repeats with the orbit: the zonal terms of the gravity field, J2 above all. The longitude-dependent terms (the tesserals: Tharsis at Mars, the mascons at the Moon) pull on the orbit at frequencies that mix the orbit's with the body's rotation, and their largest effects have periods of a rotation and its fractions. For MRO the residual of a one-day record is almost all along the track, with 9.6 km of amplitude at half a Mars day (12.3 hours) and 3.8 km at a full one; the fit itself has converged (ten times the iterations move the error by less than a part in a thousand). Linear rates and one quadratic term cannot follow a 12-hour wave, and nothing in the record can be spent on it.
- **Short records recover tens of meters.** At an hour or less the slow wave is nearly straight and the fit falls to 11 to 33 m for the two low orbiters. There the smallest Chebyshev segment in these tables that does as well is the same size or smaller (the last column is near 1), but it often gets there with degrees the cost ceiling does not allow (the ceiling is passed at degree 24 to 26); the section after these bullets repeats the comparison with the degree held to 22, and kind 4 comes out ahead at tens of meters. A Chebyshev segment can go on to centimeters where kind 4 cannot. Kind 4 is 3.5 to 15 times smaller than kind 1 at 6 to 24 hours per record, at errors of 0.2 to 15 km.
- **The Moon is not the worst case, contrary to what this file predicted.** The Moon turns once in 27 days, so over a day its lumps act almost like a fixed field and the fit degrades smoothly (24 m at an hour, 184 m at six, 2.4 km at a day). Mars turns in a day, and MRO jumps from 33 m at one hour to 1.6 km at three.
- **Velocity is worse than position suggests at the Moon.** LRO's velocity error does not fall below 0.3 m/s at any record length. The kernel's velocity agrees with the derivative of its position to 0.1 mm/s, so this is not an artifact of the kernel's interpolation. The error varies over a minute or two, which points to gravity on the scale of a hundred kilometers (LRO crosses that in a minute, 50 km up), and no harmonic of the orbit can follow that.
- **Eccentricity 0.47 works, in the sense that the fit converges and behaves like the others.** MAVEN (periapsis near 150 km, with drag) fits to 2 to 14 m at three hours and under, and to kilometers from six hours up, much as MRO does. The first real evidence above an eccentricity of 0.3 is that the eccentricity is not what limits the fit.
- **A maneuver is as bad as expected.** One record across LRO's station-keeping burn of 13 January 2010 fits to 73 km. Breaking the records at the burn repairs it; see the section on breaks below.
- **Kind 1 also has a floor on reconstructed kernels.** No Chebyshev segment on the search grid reaches a millimeter on any of the three (the best are 11 mm, 98 mm, and 328 mm), where on the synthetic orbiters about 5 KB per day does. Part of that is the kernels' own interpolation.

What this means for use. As a compact long-arc ephemeris for a real low orbiter, kind 4 as it stands delivers kilometers, not meters: enough to point at the Sun or the Earth from the spacecraft, or to predict an occultation to a few seconds, and not enough for anything that depends on the ground track or on the limb of the body being orbited (15 km along the track is over 4 seconds of MRO's motion, and moves the point beneath it by as much). Where meters matter, a Chebyshev segment (tens of kilobytes per day; see the next section) or a state supplied by onboard navigation is the tool today. The obvious repair, terms at the body's rotation, has been tried as a ground-side prototype in the section after that, and is not recommended.

### A maneuver, and what breaks do for it

A record that spans a burn fits to kilometers. The slicer now takes `"breaks"` on a body: times that no record may span. The body is cut into one segment per stretch between them, each with its own grid of records, and the segments meet with no gap. The times can be given by hand (here they were read off the kernel as the start and end of each burn), or the slicer can look for them: with `"findBreaks": true` on a body it scans the kernel for burns and seams and breaks there too ("Finding the breaks" below). `node tools/real-kernels.mjs --burn` made these tables.

<!-- burn-real:start -->
**Lunar Reconnaissance Orbiter, the day from 2010-01-13**, which holds two burns of about 110 seconds each (16:50:50, 16:52:40, 19:41:55, 19:43:45 UTC are their starts and ends, given by hand). Left to itself the slicer finds 8 breaks in the day: 16:50:00 (start), 16:52:00 (during), 16:54:00 (end), 19:41:00 (start), 19:42:45 (during), 19:44:30 (during), 19:46:15 (during), 19:48:00 (end).

| Record length asked for | Records, unbroken | Worst position error, unbroken | Records, breaks given | Worst position error, breaks given | Records, breaks found | Worst position error, breaks found |
| --- | --- | --- | --- | --- | --- | --- |
| 30 min | 48 | 204 m | 51 | 7.7 m | 54 | 7.7 m |
| 1 h | 24 | 330 m | 26 | 15 m | 30 | 14 m |
| 3 h | 8 | 569 m | 10 | 79 m | 14 | 78 m |
| 6 h | 4 | 23 km | 7 | 141 m | 11 | 143 m |
<!-- burn-real:end -->

With breaks at the burns the day fits as a day without a maneuver does (compare 24 m at one hour and 184 m at six in LRO's table above): 15 m at one-hour records where unbroken records give 330 m, and 141 m at six hours where they give 23 km. The cost is two or three more records, 320 to 480 bytes, because each burn becomes a short segment of its own. The breaks the slicer finds do as well as the ones given by hand, for a few records more: it brackets each burn more widely than the hand times do (it flags the minutes of disturbed motion after each burn too) and cuts that bracket into records of at most two minutes.

### Finding the breaks

`tools/find-breaks.mjs` needs no force model and no knowledge of the mission. It samples the trajectory every 10 seconds and compares each sample with the cubic through its four neighbors, in position and in velocity. On a smooth orbit the cubic is good to millimeters and hundredths of a millimeter per second (the natural miss in position is about 5 mm on MRO and 14 mm on a circular low Earth orbit); a sample that misses by more than 0.2 m or 2 mm/s has something within two steps of it. Flagged samples within two minutes of each other are one event. An event as narrow as one jump is a step, and is then located by bisection to the exact instant: on MAVEN and MRO the times found are the first representable instant of the new orbit solution, checked by reading the kernel one instant earlier and finding the whole step between the two. A wider event is a burn, which gets a break before, after, and every two minutes inside. The step, the two thresholds, the merge window, and the longest record under thrust can each be set (`"findBreaks": { "stepSeconds": ..., "positionKm": ..., "velocityKmS": ..., "mergeSeconds": ..., "burnSeconds": ... }`), and the slicer's report lists every break found with its kind and the size of what was seen, so a mission can review them.

A stretch that ends at a break is fitted to the trajectory before the break only. The fit samples its closing instant, and at a seam that instant already belongs to the next solution, so the slicer reads it one representable instant earlier. Before this was done, the last record before a 102 m seam was measured at 100 m for that one sample.

<!-- seam-real:start -->
**MAVEN, 4 days from 2015-01-15.** The slicer finds 4 breaks, all steps: 2015-01-15 19:18:52 (92 m), 2015-01-17 00:59:59 (4.8 m), 2015-01-17 18:59:59 (21 m), 2015-01-18 19:14:59 (102 m); the distance is the step in position there.

| Record length asked for | Records, unbroken | Worst position error, unbroken | Records, breaks found | Worst position error, breaks found |
| --- | --- | --- | --- | --- |
| 1 h | 96 | 73 m | 96 | 6.1 m |
| 3 h | 32 | 56 m | 32 | 13 m |
| 6 h | 16 | 978 m | 16 | 1.2 km |
<!-- seam-real:end -->

Seams matter at short records and stop mattering at long ones. MAVEN's reconstructed kernel steps by 5 to 102 m about once a day; at one-hour records, breaking there brings the worst error from 73 m to 6.1 m for no more records, and at six hours the fit's own error (about a kilometer on this orbit) hides the seams entirely.

What the finder does not do. It cannot see an event within 20 seconds of either end of a body's window. It does not see thrust below about 0.6 mm/s^2 at the default step (the miss a change in acceleration causes is a third of that change times the step), which rules out electric propulsion; a longer step raises the sensitivity and the natural floor together. A long steady burn is smooth in its middle, so it shows as two steps where the thrust turns on and off, and the stretch between is cut at the body's ordinary record length, not at two minutes. It is not a maneuver detector in the operational sense: on LRO it also flags small events of 5 to 8 mm/s lasting a minute or two (10:47 on 12 January 2010, 11:39 on 14 January), which may be momentum unloads or artifacts of the orbit reconstruction; breaking at one costs a record and harms nothing. And it has been run on three kernels.

### What a Chebyshev segment costs on the same orbits, within the cost ceiling

If kind 4 cannot give meters on a real orbit, what does the alternative cost? The search in the tables above lets kind 1 go to degree 40, and a one-segment state passes its cost ceiling at degree 24 to 26 (`docs/cost-measurements.md`, "A Chebyshev state against its degree"). This table keeps to degree 22 or below, which stays inside the ceiling in a blob of any size tried, and lets the records run from a thirty-second of an orbit to one orbit; longer records were not tried at these degrees. `tools/real-orbit-study.mjs` made it, over the first day of each orbiter's window.

<!-- kind1-real:start -->
| Orbiter | Worst position error wanted | Smallest kind 1 at degree 22 or below, bytes per day | Smallest kind 4, bytes per day |
| --- | --- | --- | --- |
| Lunar Reconnaissance Orbiter | 1 km | 2,753 (degree 8, 113 min records, 399 m) | 320 (12 h records, 545 m) |
| Lunar Reconnaissance Orbiter | 100 m | 3,364 (degree 10, 113 min records, 80 m) | 1,280 (3 h records, 49 m) |
| Lunar Reconnaissance Orbiter | 10 m | 7,952 (degree 12, 57 min records, 9.6 m) | not reached at any record length |
| Lunar Reconnaissance Orbiter | 1 m | 37,029 (degree 14, 14 min records, 741 mm) | not reached at any record length |
| Lunar Reconnaissance Orbiter | 0.1 m | 93,806 (degree 18, 7 min records, 56 mm) | not reached at any record length |
| Mars Reconnaissance Orbiter | 1 km | 3,394 (degree 10, 112 min records, 349 m) | 3,840 (1 h records, 21 m) |
| Mars Reconnaissance Orbiter | 100 m | 4,011 (degree 12, 112 min records, 91 m) | 3,840 (1 h records, 21 m) |
| Mars Reconnaissance Orbiter | 10 m | 6,789 (degree 10, 56 min records, 8.1 m) | not reached at any record length |
| Mars Reconnaissance Orbiter | 1 m | 17,510 (degree 18, 38 min records, 907 mm) | not reached at any record length |
| Mars Reconnaissance Orbiter | 0.1 m | 28,022 (degree 14, 19 min records, 72 mm) | not reached at any record length |
| MAVEN | 1 km | 2,896 (degree 22, 275 min records, 855 m) | 1,280 (3 h records, 14 m) |
| MAVEN | 100 m | 5,278 (degree 20, 138 min records, 46 m) | 1,280 (3 h records, 14 m) |
| MAVEN | 10 m | 7,932 (degree 20, 92 min records, 5.4 m) | 3,840 (1 h records, 3.9 m) |
| MAVEN | 1 m | 14,275 (degree 18, 46 min records, 977 mm) | not reached at any record length |
| MAVEN | 0.1 m | 30,494 (degree 14, 17 min records, 92 mm) | not reached at any record length |
<!-- kind1-real:end -->

How to read it:

- **Meters on a real low orbit cost tens of kilobytes a day, whatever the kind.** One meter takes 14 to 37 KB per day of kind 1 at these degrees, and ten meters 7 to 8 KB. A month at ten meters is 200 to 240 KB: inside the 1 MiB limit on a blob, far outside the one 64 KiB page the flight-shaped case assumes, which has 45 KB to spare (five or six days at ten meters; one to three at one meter).
- **Kind 4 has a real niche after all, at tens of meters.** At records of one to three hours it holds 14 to 49 m in 1.3 to 3.8 KB per day. Kind 1 held to degree 22 needs 3.4 to 5.3 KB per day for 100 m on the same orbits: the same size for MRO, 2.6 times larger for LRO, 4.1 times larger for MAVEN. The tables further up show kind 1 matching kind 4 at those record lengths, but with records of several orbits at degrees up to 40, most of them beyond what the cost ceiling allows.
- **Below about ten meters there is only kind 1,** or a state supplied by onboard navigation.
- **The figures differ a little from the tables above** (MRO at one hour is 21 m here and 33 m there) because this table covers the first day of each window, not all of it.

### Would terms at the body's rotation rescue kind 4? A prototype

The obvious repair is to give the record terms at the central body's rotation. Before proposing a change to the format, `tools/real-orbit-study.mjs` tries it on the ground: it fits a kind 4 record together with extra displacements along the radial, along-track, and cross-track directions, each a cosine and a sine of `k u + m theta`, where `u` is the argument of latitude and `theta` the angle the body has turned. `k = 0` gives the daily terms; the others are the mixed terms a tesseral field produces. Nothing here is in the format or the library, the angles come from the true trajectory, and only the first record of each window is fitted, so these are indications, not results to quote for a mission.

<!-- rotation-terms:start -->
| Orbiter | One record of | kind 4 as it is | with daily terms at one and two turns of the body (12 more numbers) | with those and mixed terms, k to 2 and m to 2 (60 more numbers) | with daily and mixed terms, k to 3 and m to 4 (168 more numbers) |
| --- | --- | --- | --- | --- | --- |
| Lunar Reconnaissance Orbiter | 6 h | 184 m | 217 m | 45 m | 40 m |
| Lunar Reconnaissance Orbiter | 24 h | 2.4 km | 2.4 km | 459 m | 210 m |
| Mars Reconnaissance Orbiter | 6 h | 2.2 km | 2 km | 75 m | 48 m |
| Mars Reconnaissance Orbiter | 24 h | 14 km | 4.9 km | 3.8 km | 3.1 km |
| MAVEN | 6 h | 530 m | 344 m | 19 m | 3.7 m |
| MAVEN | 24 h | 5.7 km | 3.3 km | 1.6 km | 30 m |
<!-- rotation-terms:end -->

What it shows:

- **A dozen numbers at the daily frequencies are not enough.** They take MRO's one-day record from 14 km to 4.9 km and MAVEN's from 5.7 km to 3.3 km, and do nothing for LRO (the Moon turns too slowly for a daily term to differ from a rate).
- **The mixed terms carry most of it, and there are many of them.** Sixty more numbers bring a six-hour record to 19 to 75 m on all three, and a one-day record to 0.5 km for LRO and 1.6 km for MAVEN; MRO's one-day record is still at 3.8 km. With 168 more numbers MAVEN reaches 30 m at a day and LRO 210 m, and MRO stays at 3.1 km, for a reason this prototype does not explain.
- **So this is not a cheap repair.** Sixty numbers are 240 bytes on a 160-byte record, and thirty more sine and cosine pairs would cost several hundred instructions at the least, against a margin of about 300 under the ceiling. At that size a six-hour record of the extended model (1.6 KB per day for 19 to 75 m) buys little over shorter records of kind 4 as it is: 1.3 KB per day already gives 14 m on MAVEN and 60 m on LRO at three-hour records. Only for MRO would it be a gain, 75 m at less than half the 3.8 KB per day that one-hour records need for 33 m.

The conclusion drawn here is that the record should not be extended with rotation terms. Kind 4 as it stands is a coarse long-arc model (kilometers at a day) and a compact medium-arc one (tens of meters at one to three hours); meters belong to kind 1 or to onboard navigation.

## Cost under SpaceWasm

`scripts/measure-cost-orbit.mjs`, with the same host harness and method as `scripts/measure-cost.mjs` (`docs/cost-measurements.md`), on the shipped one-page module and the `orbiter` test blob. Each orbiter is queried at 400 times across the window, because the cost varies with the number of Kepler steps. The last row is the worst case the model accepts: a record with its eccentricity forced to the limit of 0.9, queried at 1,000 times around the orbit with the periapsis in each of four directions.

<!-- cost-table:start -->
| Call | Instructions (least to most) | Mean | Slices of 1,000 |
| --- | --- | --- | --- |
| lite_state, near-circular low Earth orbiter (e = 0.001), geometric, one kind 4 segment | 1,856 to 2,006 | 1,998 | 3 |
| lite_state, near-circular low lunar orbiter (e = 0.004), geometric, one kind 4 segment | 1,806 to 1,956 | 1,953 | 2 |
| lite_state, eccentric Earth orbiter (e = 0.3), geometric, one kind 4 segment | 1,786 to 1,934 | 1,932 | 2 |
| lite_state, low Earth orbiter from the Earth-Moon barycenter (kind 4, then kind 1 at degree 12) | 3,618 | 3,618 | 4 |
| lite_state, low Earth orbiter from the Moon (kind 4, then two of kind 1) | 5,135 | 5,135 | 6 |
| lite_state, low lunar orbiter from the low Earth orbiter (two of kind 4, two of kind 1) | 6,818 | 6,818 | 7 |
| lite_state, one kind 4 segment with the eccentricity forced to the limit of 0.9 (cost only) | 2,002 to 2,190 | 2,117 | 3 |
<!-- cost-table:end -->

A kind 4 state costs a little more than a degree 12 Chebyshev record and is within the 2,500-instruction ceiling `SPEC.md` sets for a one-segment geometric state at every eccentricity the model accepts: the worst call at the limit of 0.9 is 2,190 instructions, and the script holds that case to the same 2,500 as the others. The margin was 10 instructions until the path from `lite_state` to the segment was shortened: a body asked for relative to the body it hangs from, or the reverse, is one link, and is now recognized as such before any chain of ancestors is built and searched. That took about 290 instructions off every one-segment state, of any kind, changed no arithmetic (the committed vectors still reproduce bit for bit), and made every longer path a little cheaper too, because the two lookups it starts with are reused. Most of the cost is trigonometry: three full sine and cosine pairs (mean argument, inclination, node) and one more for each Kepler step after the first, at about 150 instructions a step.

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

- **Terms at the body's rotation.** Tried as a prototype ("Would terms at the body's rotation rescue kind 4?" above) and not recommended: the terms that matter are many, and a record large enough to carry them is no better than shorter records of the present one. What the prototype leaves unexplained is MRO at one day, which no set of terms tried brings under 3 km.
- **Long Chebyshev records within the ceiling.** The cost of kind 1 is now measured at every even degree to 40, and the ceiling allows degree 22 to 24. The comparison held to that degree stops at records of one orbit; records of two to four orbits at degree 22 or below have not been tried on the real orbiters.
- **A real low Earth orbiter.** None of the three real cases is at the Earth, because NAIF does not publish one; the Earth's tesseral terms are several hundred times smaller than J2 (at Mars the ratio is about thirty), so the Earth should sit between the synthetic and Mars columns. That is a guess.
- **Finding maneuvers and seams, beyond three kernels.** The slicer now finds them on request ("Finding the breaks" above), with the limits listed there: low thrust, the middle of a long steady burn, and the ends of the window are not seen, and the thresholds were set from LRO, MRO, and MAVEN only.
- **Higher eccentricity.** The fit has been measured at eccentricities of 0.3 (synthetic) and 0.47 (MAVEN). The evaluation is tested up to 0.9 for cost and convergence, not for accuracy.
- **Reference plane.** Elements are referred to J2000. For an orbiter of a body whose equator is tilted from J2000 the node and inclination both drift as the orbit plane precesses about the body's pole; straight-line rates follow that over a day or two (the lunar case above does exactly this), but a per-segment pole, or quadratic terms for the plane, would hold longer.
- **Conditioning of the fit.** On a near-circular orbit the first harmonics are nearly interchangeable with small changes to the eccentricity vector, the inclination, and the node. The damped least-squares fit copes, and the declared error is measured after the fact either way, but records shorter than an orbit fit worse than they should.
- **Continuity.** Neighboring records are fitted independently, so the state steps at a record boundary by up to twice the declared error.
- **Cost margin.** The worst case is 310 instructions under the ceiling. What is left is almost all arithmetic inside the record's evaluation; cutting further would mean changing the Kepler solve or the trigonometry, and with them the bits of every answer.
