# Calling the library

[Documentation index](README.md) · Previous: [Cutting a blob](slicer.md) · Next: [Building it into a sequence](building.md)

This page goes through the library by the question each call answers, with code for each, and then says what a sequence should do with every status a call can return. The exact contract of each call is its comment in [`include/spice_lite.h`](../include/spice_lite.h), which is 190 lines and worth reading once.

The snippets here are taken, lightly trimmed, from [`examples/native/tour.c`](../examples/native/tour.c), a program you can run with `pnpm tour`, and from the demonstration sequence [`examples/sequence/sun_watch.c`](../examples/sequence/sun_watch.c). The tests run both, so what this page shows is what the library does. In the tour, `expect(name, status, wanted)` is a small helper that reports a status other than the wanted one.

- [Conventions](#conventions)
- [The calls at a glance](#the-calls-at-a-glance)
- [Start: make a blob active](#start-make-a-blob-active)
- [What time is it?](#what-time-is-it)
- [Where is a body?](#where-is-a-body)
- [Where is it in my sky?](#where-is-it-in-my-sky)
- [Which way is a body turned?](#which-way-is-a-body-turned)
- [What is beneath an observer?](#what-is-beneath-an-observer)
- [Is one body hiding another?](#is-one-body-hiding-another)
- [The spacecraft's own state](#the-spacecrafts-own-state)
- [Status codes, and what to do with them](#status-codes-and-what-to-do-with-them)
- [What a call costs](#what-a-call-costs)
- [Things that catch people](#things-that-catch-people)

## Conventions

- **Every call returns a status** and writes its results through pointers. `LITE_OK` is 0. Results are meaningful only on `LITE_OK`.
- **No call traps.** Once `lite_init` has accepted a blob, no input makes the library fault, loop, or read outside the blob. A bad request gets a status.
- **Units:** kilometers, kilometers per second, seconds, and **radians**.
- **Time** is ET: TDB seconds past J2000, the quantity SPICE calls ET.
- **States** are in the J2000 frame, position then velocity.
- **Bodies** are NAIF codes (10 the Sun, 399 the Earth, 301 the Moon, a negative number for a spacecraft). **Sites** are the numbers the slicer configuration gave them.
- **One blob is active at a time.** The library keeps its state in one small static block and uses no heap.

## The calls at a glance

| Question | Call | Needs in the blob |
| --- | --- | --- |
| Is this blob good? | `lite_init` | |
| What is the ET of this clock reading? | `lite_host2et`, or `lite_fwtime2et` from F Prime's serialized time | a TIME entry for the time base |
| Where is a body relative to another, and how fast? | `lite_state` | both bodies |
| Where is a body in the sky of a surface site? | `lite_site_view` | the site; radii and orientation of its body |
| How is a body turned? | `lite_orient` | orientation of the body |
| What point of a body is beneath an observer, and how high is the observer? | `lite_sub_point` | radii and orientation of the body |
| Is one body in front of another? | `lite_occulted`; `lite_occulted_shapes` to learn how each was modeled; `lite_occulted_corr` with light time | radii of both |
| Use a state from onboard navigation | `lite_set_state`, `lite_clear_state` | a body flagged as the spacecraft |
| How far is navigation from the prediction? | `lite_state_gap` | that body, with a predicted segment |

[Cutting a blob](slicer.md#what-each-call-needs-from-the-blob) says how to put each of those in.

## Start: make a blob active

```c
st = lite_init(blob, len, 0);
if (st != LITE_OK) {
    return 1; /* no other call can succeed without an active blob */
}
```

`lite_init` checks the whole blob (its structure, every offset and count, and its checksum) and makes it the active one. Call it once, at the start. The memory must stay valid and unchanged for as long as the blob is active, and should be 8-byte aligned.

The checksum is nearly all of the cost of starting: about 21 interpreter instructions per byte of blob. Passing `LITE_INIT_SKIP_CRC` as the third argument skips it, for a sequence whose module has already been verified by the file system or the uplink that delivered it. The structural checks still run.

Calling `lite_init` again replaces the active blob and drops any supplied state.

## What time is it?

From a time base, seconds, and microseconds:

```c
expect("lite_host2et", lite_host2et(TB_SC_TIME, 302400u, 0u, &et), LITE_OK);
```

Under F Prime's WasmSequencer, hand the 11 bytes the host's `time` call wrote straight to the library:

```c
fprime_wasm_get_time((uint32_t)(uintptr_t)now, FW_TIME_SIZE);
if (lite_fwtime2et(now, FW_TIME_SIZE, &et) != LITE_OK) { /* stop */ }
```

`lite_fwtime2et` assumes F Prime's default time layout (a 16-bit base, an 8-bit context, 32-bit seconds, 32-bit microseconds, big-endian). A deployment that changes those types decodes the time itself and calls `lite_host2et`.

`LITE_OUT_OF_COVERAGE` here means the blob has no mapping for that reading: the time base is not one it knows, the reading is before the first piece, or it falls in a gap the blob declares. Treat it as "this blob is not for now".

## Where is a body?

```c
/* Where is the Moon from the Earth, as it is now (geometric)? */
expect("lite_state geometric", lite_state(MOON, EARTH, et, LITE_NONE, state, 0, 0), LITE_OK);

/* Where does the Sun appear from the Earth (light time and stellar
 * aberration), how long did the light take, and what kind of data
 * answered? lt and source may each be null when not wanted. */
expect("lite_state LT+S", lite_state(SUN, EARTH, et, LITE_LT_S, state, &lt, &source), LITE_OK);
```

The arguments are target, observer, time, and correction. `state[0..2]` is the position of the target relative to the observer and `state[3..5]` its velocity.

| Correction | Gives | Matches SPICE's |
| --- | --- | --- |
| `LITE_NONE` | Where the target is at `et` | `"NONE"` |
| `LITE_LT` | Where the observer sees it at `et`: where it was one light time ago | `"LT"` |
| `LITE_LT_S` | The same, shifted by the observer's motion | `"LT+S"` |

`LITE_LT` and `LITE_LT_S` need a blob rooted at the solar system barycenter and coverage that reaches back by the light time. Under them the position follows SPICE; the velocity is the target's at the earlier time minus the observer's, without SPICE's light-time rate terms.

`source` says what kind of data the answer rests on, the least trustworthy along the path: `LITE_SRC_PUBLISHED` (0, an ephemeris), `LITE_SRC_PREDICTED` (1, a predicted trajectory), or `LITE_SRC_SUPPLIED` (2, a state the sequence supplied).

## Where is it in my sky?

```c
expect("lite_site_view", lite_site_view(SITE_EARTH, SUN, et, LITE_NONE, &az, &el, &range), LITE_OK);
printf("site      Sun from site %d: azimuth %.2f deg, elevation %.2f deg\n", SITE_EARTH, az * DEG, el * DEG);
```

Azimuth is from north toward east, 0 to 2π. Elevation is above the site's horizon, where "up" is from the body's center through the site, or the ellipsoid's normal in a blob cut with geodetic sites. Range is in kilometers. This is the call the demonstration sequence decides with:

```c
if (el >= MIN_ELEVATION_RAD) { /* command the image */ }
```

Draft 0.1 supports `LITE_NONE` only here: the answer is geometric, with no light time and no refraction. For the Sun from the Earth the geometric and apparent directions are 0.006 degrees apart.

## Which way is a body turned?

```c
/* J2000 to body-fixed. Rotate the Earth-to-Moon direction into
 * the Earth's frame: fixed = rot * j2000, row-major. */
expect("lite_orient", lite_orient(EARTH, et, rot), LITE_OK);
expect("lite_state for orient", lite_state(MOON, EARTH, et, LITE_NONE, state, 0, 0), LITE_OK);
for (k = 0; k < 3; k++) {
    fixed[k] = rot[3 * k] * state[0] + rot[3 * k + 1] * state[1] + rot[3 * k + 2] * state[2];
}
```

`rot` is nine doubles, row by row. To go the other way, from body-fixed to J2000, use the transpose.

## What is beneath an observer?

```c
/* The point on the Earth beneath the Moon, and the Moon's
 * height above it. */
expect("lite_sub_point", lite_sub_point(EARTH, MOON, et, &lon, &lat, &alt), LITE_OK);
```

The arguments are the body, then the observer. The point is the one on the body's ellipsoid nearest the observer; `lon` (−π to π) and `lat` are its planetocentric coordinates in the body-fixed frame, and `alt` is the observer's distance from it. For a spacecraft as observer this is its ground track and altitude. It is SPICE's `subpnt_c` with `"NEAR POINT/ELLIPSOID"` and no correction.

## Is one body hiding another?

```c
/* When is the Sun wholly behind Saturn, as the spacecraft sees it (with
 * light time)? Step through the day a minute at a time. */
for (minute = 0; minute < 24 * 60; minute++) {
    st = lite_occulted_corr(SUN, SATURN, CASSINI, et_saturn_start + 60.0 * minute, LITE_LT, &code,
                            &target_shape, &by_shape);
    if (st != LITE_OK) {
        continue; /* light time reaches back before the window in its first minutes */
    }
    if (code == LITE_OCC_FULL) {
        /* in eclipse */
    }
}
```

The arguments are the target, the body that might hide it, and the observer. `code` receives:

| Code | Meaning |
| --- | --- |
| `LITE_OCC_NONE` (0) | No part of the target is behind the other body |
| `LITE_OCC_PARTIAL` (1) | The disks overlap, neither inside the other |
| `LITE_OCC_ANNULAR` (2) | The nearer body lies wholly inside the target's disk: a transit |
| `LITE_OCC_FULL` (3) | The target is wholly hidden |

There are three forms of the call:

- `lite_occulted(target, by, observer, et, &code)` is the short one, geometric.
- `lite_occulted_shapes` also reports how each body was modeled. A body with radii and an orientation is its true ellipsoid (`LITE_SHAPE_ELLIPSOID`); one with equal radii is a sphere (`LITE_SHAPE_SPHERE`). `LITE_SHAPE_STANDIN` is the one to watch for: the body has unequal radii but no orientation in the blob, a sphere stood in for it, and the answer may differ from the ellipsoid's near the limb.
- `lite_occulted_corr` adds a correction argument. `LITE_LT` places each body where the observer sees it, as SPICE's `occult_c` does with `"LT"`. Light time moves the start and end of an event by seconds to tens of seconds.

A sequence deciding whether it is in eclipse wants `target` the Sun, `by` the planet, `observer` the spacecraft, and `code == LITE_OCC_FULL` for umbra or `code != LITE_OCC_NONE` for any shadow.

## The spacecraft's own state

A blob can carry a predicted trajectory for the spacecraft, the sequence can supply a state from onboard navigation, or both.

With only the blob:

```c
expect("lite_state predicted", lite_state(CASSINI, SATURN_BARYCENTER, et, LITE_NONE, state, 0, &source),
       LITE_OK);
/* source is LITE_SRC_PREDICTED */
```

Supplying a state:

```c
/* Onboard navigation has a better state: here, the prediction moved by
 * 5 km. It answers queries within 600 s of its own time. */
nav[0] += 5.0;
expect("lite_set_state", lite_set_state(CASSINI, SATURN_BARYCENTER, et, nav, 600.0), LITE_OK);
expect("lite_state supplied", lite_state(CASSINI, SATURN_BARYCENTER, et + 60.0, LITE_NONE, state, 0, &source),
       LITE_OK);
/* source is LITE_SRC_SUPPLIED */
```

The arguments are the spacecraft, the body the state is relative to, the state's time, the state, and how long it stays usable. Within `max_age` seconds of its time, the supplied state answers every query that involves the spacecraft, moved in a straight line from its time to the query's. That includes sub-points and occultations with the spacecraft as observer, and site views of it. Choose `max_age` for how long a straight line is good enough on your trajectory: minutes in a low orbit, much longer in cruise.

Outside that span the predicted segment answers again, if the blob has one. If it does not, the query returns `LITE_STALE`.

```c
/* How far has navigation moved from the prediction? */
expect("lite_state_gap", lite_state_gap(et + 60.0, &dpos, &dvel), LITE_OK);
```

`lite_state_gap` gives the distance and the speed difference between the supplied state and the prediction, which a sequence can test before trusting either. `lite_clear_state()` drops the supplied state.

## Status codes, and what to do with them

The rule the demonstration sequence follows is the one to keep: **on anything but `LITE_OK`, stop or take the safe branch. Never act on the output values, and never substitute a guess.**

| Status | It means | Usual cause | What a sequence should do |
| --- | --- | --- | --- |
| `LITE_OK` (0) | The outputs are valid | | Use them |
| `LITE_OUT_OF_COVERAGE` (1) | The blob knows the body or clock but has no data for this time | The blob has expired or is not yet in force; the clock reading is wrong; a light-time query near the start of the window | Do not extrapolate. Report it and end, or take the branch that needs no geometry. The fix is a new blob from the ground |
| `LITE_NO_PATH` (2) | A body or site is not in the blob, or two bodies are not connected; `lite_orient` on a body with no orientation; `lite_state_gap` with no supplied state | The sequence and the blob were built from different lists | A build error, not a flight condition: catch it on the ground by running the sequence against its blob. Onboard, report and end |
| `LITE_STALE` (3) | The supplied state is older than its `max_age` and no segment replaces it | Navigation has not updated the state recently | Call `lite_set_state` with a fresh state and ask again, or wait for one |
| `LITE_BAD_BLOB` (4) | `lite_init` rejected the blob, or no blob is active | A corrupted or truncated blob; a blob from a newer format; a call before `lite_init` | Report it and end. Nothing else can work |
| `LITE_UNSUPPORTED` (5) | A valid request that this blob or this build cannot serve | Light time in a blob not rooted at 0; a correction on `lite_site_view`; `LITE_LT_S` on an occultation; a body with no radii; an orbit record outside the model's limits | Usually a build error: change the request or cut the blob with what it needs. Onboard, report and end |
| `LITE_BAD_ARG` (6) | The arguments make no sense | A null pointer or a number that is not finite; the same body twice in an occultation; an observer inside the body it asks about | A bug in the sequence, or an input from elsewhere that needs checking before it is passed on |

In code, the two patterns that cover nearly every sequence:

```c
/* 1. Start-up: nothing works without the blob. */
if (lite_init(sequence_blob, sequence_blob_len, 0) != LITE_OK) {
    report(FPRIME_EVENT_WARNING_HI, "sun_watch: geometry blob rejected", 0.0, 0);
    fprime_wasm_exit(1);
}

/* 2. Each decision: any failure ends it, with a distinct exit code. */
if (lite_fwtime2et(now, FW_TIME_SIZE, &et) != LITE_OK ||
    lite_site_view(SITE_ID, SUN, et, LITE_NONE, &az, &el, &range) != LITE_OK) {
    /* Outside the blob's coverage, or no geometry: stop, do not guess. */
    report(FPRIME_EVENT_WARNING_HI, "sun_watch: no geometry for this time", 0.0, 0);
    fprime_wasm_exit(2);
}
```

A sequence that should outlive a refusal distinguishes the statuses:

```c
st = lite_state(SPACECRAFT, PLANET, et, LITE_NONE, state, 0, &source);
if (st == LITE_STALE) {
    /* ask navigation for a state, lite_set_state, try again next cycle */
} else if (st != LITE_OK) {
    /* report st and end */
}
```

## What a call costs

Under the SpaceWasm interpreter, with the 13 KB example blob, in interpreter instructions (the WasmSequencer runs a sequence in slices of 1,000):

| Call | Instructions |
| --- | --- |
| `lite_init`, checksum verified | 275,077 |
| `lite_init`, checksum skipped | 2,305 |
| `lite_host2et` | 118 |
| `lite_state`, Moon from Earth, geometric | 3,452 |
| `lite_state`, Sun from Earth, light time and stellar aberration | 6,124 |
| `lite_orient` | 1,178 |
| `lite_site_view` | 6,197 |

A geometric state costs about 1,500 to 2,000 instructions for each segment on the path between the two bodies. [Cost under SpaceWasm](cost-measurements.md) has every call, including sub-points and occultations, and the checksum options.

## Things that catch people

- **Angles are radians.** Compare an elevation with `0.1745...`, not `10`.
- **Light time needs a blob rooted at body 0.** In any other blob `LITE_LT` returns `LITE_UNSUPPORTED`.
- **Light time looks backward.** A corrected query in the first seconds or minutes of the window needs data from before it, and returns `LITE_OUT_OF_COVERAGE`. Start the window early enough.
- **`lite_site_view` is geometric only** in draft 0.1.
- **Site numbers are not NAIF codes.** Site 2 and body 2 are unrelated.
- **`lite_sub_point` takes the body first, then the observer;** `lite_state` takes the target first, then the observer.
- **Outputs are untouched or meaningless on failure.** Check the status before reading them.
- **Build with `-ffp-contract=off`.** Without it a compiler may fuse multiplies and adds, and results stop being bit-identical between the ground and flight builds ([Building](building.md)).

---

[Documentation index](README.md) · Previous: [Cutting a blob](slicer.md) · Next: [Building it into a sequence](building.md)
