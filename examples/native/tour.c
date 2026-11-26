/*
 * tour: every spice-lite call once, on a desktop, against two of the test
 * blobs in this repository. docs/api.md walks through it section by section.
 *
 * Build and run from the repository root (no kernels needed):
 *
 *   cc -std=c99 -O2 -ffp-contract=off -Iinclude -o build/tour \
 *      examples/native/tour.c src/spice_lite.c -lm
 *   build/tour test/blobs/cassini-soi.slb test/blobs/saturn-soi.slb
 *
 * It exits 0 only if every call returned the status the comments say it
 * should, and test/examples.test.mjs runs it, so the documents that quote it
 * cannot drift from what the library does.
 *
 * This file uses stdio and malloc because it runs on a desktop. The library
 * itself uses neither; examples/sequence/sun_watch.c is the onboard shape.
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include "spice_lite.h"

/* NAIF codes of the bodies in the two blobs, and the site numbers the
 * cassini-soi configuration (test/blobs/cassini-soi.json) gives. */
#define SSB 0
#define SATURN_BARYCENTER 6
#define SUN 10
#define MOON 301
#define EARTH 399
#define SATURN 699
#define CASSINI (-82)
#define SITE_EARTH 2

#define TB_SC_TIME 3 /* the time base the blob's TIME section answers */

static const double DEG = 57.29577951308232;
static int failures = 0;

static const char *status_name(int st)
{
    static const char *names[] = {"LITE_OK", "LITE_OUT_OF_COVERAGE", "LITE_NO_PATH", "LITE_STALE",
                                  "LITE_BAD_BLOB", "LITE_UNSUPPORTED", "LITE_BAD_ARG"};
    return st >= 0 && st <= 6 ? names[st] : "?";
}

/* Reports a call whose status is not the expected one. */
static void expect(const char *what, int got, int want)
{
    if (got != want) {
        printf("FAIL %s: %s, expected %s\n", what, status_name(got), status_name(want));
        failures++;
    }
}

/* Reads a whole file. malloc returns memory aligned for a double, which is
 * the 8-byte alignment lite_init asks for. */
static uint8_t *read_file(const char *path, uint32_t *len)
{
    FILE *f = fopen(path, "rb");
    uint8_t *bytes;
    long n;
    if (f == 0) {
        return 0;
    }
    fseek(f, 0, SEEK_END);
    n = ftell(f);
    fseek(f, 0, SEEK_SET);
    bytes = (uint8_t *)malloc((size_t)n);
    if (bytes == 0 || fread(bytes, 1, (size_t)n, f) != (size_t)n) {
        fclose(f);
        return 0;
    }
    fclose(f);
    *len = (uint32_t)n;
    return bytes;
}

int main(int argc, char **argv)
{
    uint8_t *blob, *blob2;
    uint32_t len, len2;
    double et, et_saturn_start, lt, az, el, range, lon, lat, alt, dpos, dvel;
    double state[6], nav[6], rot[9], fixed[3];
    int32_t source, code, target_shape, by_shape;
    int st, k, minute, first_hidden = -1, last_hidden = -1;

    if (argc != 3) {
        fprintf(stderr, "usage: tour <cassini-soi.slb> <saturn-soi.slb>\n");
        return 2;
    }
    blob = read_file(argv[1], &len);
    blob2 = read_file(argv[2], &len2);
    if (blob == 0 || blob2 == 0) {
        fprintf(stderr, "tour: cannot read the blobs\n");
        return 2;
    }

    /* [init] Check the blob and make it the active one. Do this once. */
    st = lite_init(blob, len, 0);
    expect("lite_init", st, LITE_OK);
    if (st != LITE_OK) {
        return 1; /* no other call can succeed without an active blob */
    }
    /* [/init] */

    /* [time] Host clock to ET. The blob maps time base 3 from its window
     * start (2004-06-27T00:00:00 UTC), so 302,400 s is 3.5 days in. A sequence
     * under F Prime passes the 11 bytes of the host's time call to
     * lite_fwtime2et instead (examples/sequence/sun_watch.c). */
    expect("lite_host2et", lite_host2et(TB_SC_TIME, 302400u, 0u, &et), LITE_OK);
    printf("time      host 302400 s -> ET %.3f\n", et);
    et_saturn_start = et; /* the second blob's window starts here */
    /* [/time] */

    /* [state] Where is the Moon from the Earth, as it is now (geometric)? */
    expect("lite_state geometric", lite_state(MOON, EARTH, et, LITE_NONE, state, 0, 0), LITE_OK);
    printf("state     Moon from Earth: %.3f %.3f %.3f km\n", state[0], state[1], state[2]);

    /* Where does the Sun appear from the Earth (light time and stellar
     * aberration), how long did the light take, and what kind of data
     * answered? lt and source may each be null when not wanted. */
    expect("lite_state LT+S", lite_state(SUN, EARTH, et, LITE_LT_S, state, &lt, &source), LITE_OK);
    printf("state     Sun from Earth, apparent: light time %.3f s, source %d\n", lt, (int)source);
    /* [/state] */

    /* [site] Azimuth, elevation, and range of the Sun from a surface site. */
    expect("lite_site_view", lite_site_view(SITE_EARTH, SUN, et, LITE_NONE, &az, &el, &range), LITE_OK);
    printf("site      Sun from site %d: azimuth %.2f deg, elevation %.2f deg\n", SITE_EARTH, az * DEG, el * DEG);
    /* [/site] */

    /* [orient] J2000 to body-fixed. Rotate the Earth-to-Moon direction into
     * the Earth's frame: fixed = rot * j2000, row-major. */
    expect("lite_orient", lite_orient(EARTH, et, rot), LITE_OK);
    expect("lite_state for orient", lite_state(MOON, EARTH, et, LITE_NONE, state, 0, 0), LITE_OK);
    for (k = 0; k < 3; k++) {
        fixed[k] = rot[3 * k] * state[0] + rot[3 * k + 1] * state[1] + rot[3 * k + 2] * state[2];
    }
    printf("orient    Moon in the Earth-fixed frame: %.3f %.3f %.3f km\n", fixed[0], fixed[1], fixed[2]);
    /* [/orient] */

    /* [subpoint] The point on the Earth beneath the Moon, and the Moon's
     * height above it. */
    expect("lite_sub_point", lite_sub_point(EARTH, MOON, et, &lon, &lat, &alt), LITE_OK);
    printf("subpoint  under the Moon: longitude %.2f deg, latitude %.2f deg, altitude %.1f km\n",
           lon * DEG, lat * DEG, alt);
    /* [/subpoint] */

    /* [spacecraft] The spacecraft's own state. The blob carries a predicted
     * trajectory, so with nothing supplied the source is LITE_SRC_PREDICTED. */
    expect("lite_state predicted", lite_state(CASSINI, SATURN_BARYCENTER, et, LITE_NONE, state, 0, &source),
           LITE_OK);
    printf("craft     predicted: %.1f km from Saturn's barycenter, source %d\n",
           sqrt(state[0] * state[0] + state[1] * state[1] + state[2] * state[2]), (int)source);

    /* Onboard navigation has a better state: here, the prediction moved by
     * 5 km. It answers queries within 600 s of its own time. */
    for (k = 0; k < 6; k++) {
        nav[k] = state[k];
    }
    nav[0] += 5.0;
    expect("lite_set_state", lite_set_state(CASSINI, SATURN_BARYCENTER, et, nav, 600.0), LITE_OK);
    expect("lite_state supplied", lite_state(CASSINI, SATURN_BARYCENTER, et + 60.0, LITE_NONE, state, 0, &source),
           LITE_OK);
    if (source != LITE_SRC_SUPPLIED) {
        printf("FAIL the supplied state was not used\n");
        failures++;
    }
    /* How far has navigation moved from the prediction? */
    expect("lite_state_gap", lite_state_gap(et + 60.0, &dpos, &dvel), LITE_OK);
    printf("craft     supplied state in use (source %d), %.3f km from the prediction\n", (int)source, dpos);

    /* An hour later the supplied state is too old, and the prediction answers
     * again. With no predicted segment this would be LITE_STALE. */
    expect("lite_state after max_age", lite_state(CASSINI, SATURN_BARYCENTER, et + 3600.0, LITE_NONE, state, 0, &source),
           LITE_OK);
    if (source != LITE_SRC_PREDICTED) {
        printf("FAIL the prediction did not take over\n");
        failures++;
    }
    expect("lite_state_gap stale", lite_state_gap(et + 3600.0, &dpos, &dvel), LITE_STALE);
    expect("lite_clear_state", lite_clear_state(), LITE_OK);
    /* [/spacecraft] */

    /* [status] What refusals look like. A day before the window: the segment
     * exists but does not reach. */
    expect("before the window", lite_state(MOON, EARTH, et - 5.0 * 86400.0, LITE_NONE, state, 0, 0),
           LITE_OUT_OF_COVERAGE);
    /* A body the blob does not hold. */
    expect("unknown body", lite_state(499, EARTH, et, LITE_NONE, state, 0, 0), LITE_NO_PATH);
    /* A clock reading under a time base the blob has no pieces for. */
    expect("unknown time base", lite_host2et(7u, 302400u, 0u, &et), LITE_OUT_OF_COVERAGE);
    /* A site view with a correction draft 0.1 does not support there. */
    expect("site view with LT", lite_site_view(SITE_EARTH, SUN, et_saturn_start, LITE_LT, &az, &el, &range),
           LITE_UNSUPPORTED);
    printf("status    four refusals, each with the status the header documents\n");
    /* [/status] */

    /* [occult] A second blob: one day around Cassini's arrival, with Saturn's
     * radii and orientation. Calling lite_init again replaces the active blob
     * (and drops any supplied state). */
    expect("lite_init second blob", lite_init(blob2, len2, 0), LITE_OK);

    /* When is the Sun wholly behind Saturn, as the spacecraft sees it (with
     * light time)? Step through the day a minute at a time. */
    for (minute = 0; minute < 24 * 60; minute++) {
        st = lite_occulted_corr(SUN, SATURN, CASSINI, et_saturn_start + 60.0 * minute, LITE_LT, &code,
                                &target_shape, &by_shape);
        if (st != LITE_OK) {
            continue; /* light time reaches back before the window in its first minutes */
        }
        if (code == LITE_OCC_FULL) {
            if (first_hidden < 0) {
                first_hidden = minute;
            }
            last_hidden = minute;
        }
    }
    if (first_hidden < 0) {
        printf("FAIL Saturn never hid the Sun\n");
        failures++;
    }
    printf("occult    Saturn hides the Sun from minute %d to minute %d of the day\n", first_hidden, last_hidden);

    /* The same question without a correction, and how each body was modeled:
     * Saturn has radii and an orientation, so it is its ellipsoid. */
    expect("lite_occulted_shapes",
           lite_occulted_shapes(SUN, SATURN, CASSINI, et_saturn_start + 60.0 * first_hidden + 300.0, &code,
                                &target_shape, &by_shape),
           LITE_OK);
    printf("occult    code %d, Sun modeled as shape %d, Saturn as shape %d\n", (int)code, (int)target_shape,
           (int)by_shape);
    if (by_shape != LITE_SHAPE_ELLIPSOID) {
        printf("FAIL Saturn was not modeled as its ellipsoid\n");
        failures++;
    }
    /* The short form, when the shapes do not matter. */
    expect("lite_occulted", lite_occulted(EARTH, SATURN, CASSINI, et_saturn_start + 43200.0, &code), LITE_OK);
    printf("occult    Earth behind Saturn at mid-window: code %d\n", (int)code);
    /* [/occult] */

    free(blob);
    free(blob2);
    if (failures) {
        printf("%d call(s) did not behave as documented\n", failures);
        return 1;
    }
    printf("tour complete\n");
    return 0;
}
