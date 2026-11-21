# Real mission kernels

What spice-lite has been run against beyond its own synthetic test data: three orbiters and their spacecraft clocks, from NAIF's public archives. This file lists the kernels, says how to fetch them, and holds the clock results; the orbit results are in `docs/orbit-segment.md`, under "Real orbiters".

None of these kernels is committed to this repository, and none is used by the test suite or by CI, which run on the small fixtures of cspice-wasm and on synthetic kernels. The figures here are reproducible by hand, not checked on every push.

## The kernels

`tools/real-kernels.json` names each file with its URL at `naif.jpl.nasa.gov` and its SHA-256, and `tools/real-kernels.mjs` refuses a file whose hash differs.

| Kernel | What it is |
| --- | --- |
| `lrorg_2010001_2010091_v01.bsp` | Lunar Reconnaissance Orbiter, reconstructed trajectory, January to March 2010 (7.6 MB) |
| `lro_clkcor_2010096_v00.tsc` | LRO spacecraft clock coefficients |
| `mro_psp10_ssd_mro110c.bsp` | Mars Reconnaissance Orbiter, reconstructed trajectory, January to March 2009 (44 MB) |
| `mro_sclkscet_00119_65536.tsc` | MRO spacecraft clock coefficients |
| `maven_orb_rec_150101_150401_v1.bsp` | MAVEN, reconstructed trajectory, January to March 2015 (38 MB) |
| `MVN_SCLKSCET.00133.tsc` | MAVEN spacecraft clock coefficients |
| `mar097s.bsp` | Mars and its barycenter, which the two Mars orbiters are given relative to (94 MB) |
| `naif0012.tls` | Leap seconds |

```
node tools/real-kernels.mjs --fetch          # curl each file into kernels/real (ignored by git) and check its hash
node tools/real-kernels.mjs --update-doc     # measure, and rewrite the tables here and in docs/orbit-segment.md
```

`SPICE_LITE_REAL_KERNELS` names another directory. The measurement takes about a quarter of an hour. `node tools/real-orbit-study.mjs --update-doc` runs two follow-up studies on the same kernels (a Chebyshev segment held to the cost ceiling, and a prototype of rotation terms for the orbit segment) and takes about as long; their tables are in `docs/orbit-segment.md` too.

## The clock mapping on real clocks

The slicer turns an SCLK kernel into the TIME pieces of a blob: the fewest straight lines from the clock's count to ET that stay within a stated tolerance, with CSPICE's `sct2e` as the truth (`SPEC.md`, "Pieces from a spacecraft clock kernel"). Until now it had only seen synthetic clock kernels. Each row below derives the pieces for one window and measures them against CSPICE at 2,048 readings per piece.

<!-- clocks-real:start -->
| Clock | Window | Tolerance asked | Kernel records that begin inside | Pieces | TIME bytes | Worst error against CSPICE | Pieces with `mergeRecords` | Worst error with it |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Lunar Reconnaissance Orbiter | 1 d from 2010-01-15 | 1 microsecond | 2 | 3 | 96 | 0.12 microseconds | 3 | 0.12 microseconds |
| Lunar Reconnaissance Orbiter | 1 d from 2010-01-15 | 1 millisecond | 2 | 3 | 96 | 0.12 microseconds | 1 | 433.50 microseconds |
| Lunar Reconnaissance Orbiter | 30 d from 2010-01-15 | 1 microsecond | 171 | 172 | 5504 | 0.36 microseconds | 169 | 0.72 microseconds |
| Lunar Reconnaissance Orbiter | 30 d from 2010-01-15 | 1 millisecond | 171 | 172 | 5504 | 0.36 microseconds | 12 | 625.55 microseconds |
| Mars Reconnaissance Orbiter | 1 d from 2009-01-10 | 1 microsecond | 0 | 1 | 32 | 0.06 microseconds | 1 | 0.06 microseconds |
| Mars Reconnaissance Orbiter | 1 d from 2009-01-10 | 1 millisecond | 0 | 1 | 32 | 0.06 microseconds | 1 | 0.06 microseconds |
| Mars Reconnaissance Orbiter | 30 d from 2009-01-10 | 1 microsecond | 0 | 4 | 128 | 0.95 microseconds | 4 | 0.95 microseconds |
| Mars Reconnaissance Orbiter | 30 d from 2009-01-10 | 1 millisecond | 0 | 1 | 32 | 10.79 microseconds | 1 | 10.79 microseconds |
| MAVEN | 1 d from 2015-01-16 | 1 microsecond | 0 | 1 | 32 | 0.06 microseconds | 1 | 0.06 microseconds |
| MAVEN | 1 d from 2015-01-16 | 1 millisecond | 0 | 1 | 32 | 0.06 microseconds | 1 | 0.06 microseconds |
| MAVEN | 30 d from 2015-01-16 | 1 microsecond | 1 | 5 | 160 | 0.95 microseconds | 5 | 0.95 microseconds |
| MAVEN | 30 d from 2015-01-16 | 1 millisecond | 1 | 2 | 64 | 12.52 microseconds | 2 | 12.52 microseconds |
<!-- clocks-real:end -->

All three clocks are type 1 SCLK kernels on TT, which is the one type the slicer reads. LRO and MAVEN count in ticks of 1/65536 of a second and MRO in 1/256; the LRO kernel has one partition and 1,678 coefficient records, MRO 31 partitions and 142 records, MAVEN 3 partitions and 147 records. In every row the measured error is inside the tolerance asked for, with and without `mergeRecords`.

What the real clocks showed:

- **The tolerance is met everywhere, and a day is one to three pieces.** A month of MRO or MAVEN is four or five pieces at one microsecond and one or two at a millisecond. Within one coefficient record the only curvature is the periodic difference between TT and TDB (about 1.7 milliseconds over a year), which is why a month within a microsecond needs several pieces even where the kernel holds a single rate.
- **LRO is the dear case, and loosening the tolerance does not help.** Its kernel carries about six coefficient records a day, and the slicer starts a new piece at every record whatever the tolerance: 172 pieces (5.5 KB) for a month, the same at a millisecond as at a microsecond. At that rate the cap of 4,096 pieces is reached in about two years. The slicer's `mergeRecords` option, added for this case, joins neighboring pieces where one line over both still holds the tolerance (the last two columns): a month of LRO falls from 172 pieces to 12 at a millisecond. At a microsecond it falls only to 169, because the corrections in LRO's kernel are themselves a microsecond or more, so a blob that needs LRO's clock to a microsecond still pays 5.4 KB a month. The option is off unless a configuration asks for it, and the other two clocks have nothing for it to join.
- **The convention is still unchecked.** These rows show that the pieces reproduce CSPICE's reading of each kernel. They do not show that a flight computer would hand the library the count this convention assumes (the clock's own count in its most significant field, the lesser fields as microseconds): that needs a real F Prime time source, and none has been tried.
- **Partitions.** MRO's 31 partitions and MAVEN's 3 are handled in the sense that each window here lies inside one partition and the right one is found. A window that spans a clock reset is refused with an error that says so, as designed; no real case of that has been cut.
