/*
 * spice-lite: a small, import-free geometry library that answers questions
 * about body positions, orientations, and surface sites from one read-only
 * blob. See SPEC.md for the blob format (draft 0.1) and README.md for scope.
 *
 * The library uses no heap, no libc, and no host imports. All state lives in
 * one small static block, so one blob is active at a time. Every call returns
 * a status code and writes results through pointers; no call traps on bad
 * input once lite_init has accepted the blob.
 *
 * Units: kilometers, kilometers per second, seconds, radians. Times are TDB
 * seconds past J2000 (the quantity SPICE calls ET). States are in J2000.
 *
 * This is a personal open-source project. It is not a product of, and is not
 * endorsed by, NAIF, NASA, JPL, or Caltech.
 */
#ifndef SPICE_LITE_H
#define SPICE_LITE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(__wasm__)
#define LITE_API __attribute__((visibility("default")))
#else
#define LITE_API
#endif

/* Status codes. */
#define LITE_OK 0
#define LITE_OUT_OF_COVERAGE 1 /* a needed segment exists but does not cover the time */
#define LITE_NO_PATH 2         /* the bodies are unknown or not connected */
#define LITE_STALE 3           /* the supplied state is too old and no segment replaces it */
#define LITE_BAD_BLOB 4        /* lite_init rejected the blob, or no blob is active */
#define LITE_UNSUPPORTED 5     /* valid request this build or this blob cannot serve */
#define LITE_BAD_ARG 6

/* Aberration corrections for lite_state. LT and LT_S need a blob whose body
 * tree is rooted at the solar system barycenter (header flag bit 0). */
#define LITE_NONE 0
#define LITE_LT 1
#define LITE_LT_S 2

/* Where a state came from; the worst source along the path is reported. */
#define LITE_SRC_PUBLISHED 0
#define LITE_SRC_PREDICTED 1
#define LITE_SRC_SUPPLIED 2

/* lite_init flags. */
#define LITE_INIT_SKIP_CRC 1u

/* Checks the blob (magic, version, lengths, offsets, counts, tree shape, and
 * the checksum unless LITE_INIT_SKIP_CRC is set) and makes it the active blob.
 * The checksum is CRC-32, or Fletcher-32 in a blob whose header says so (flag
 * bit 4); the flag skips either. The
 * memory must stay valid and unchanged while the blob is active, and should be
 * 8-byte aligned. Any supplied state is dropped. */
LITE_API int lite_init(const void *blob, uint32_t len, uint32_t flags);

/* Converts a host clock reading to ET using the TIME section: the piece of
 * this time base with the latest start not after the reading, found by binary
 * search (lite_init has checked that the entries are sorted). Returns
 * LITE_OUT_OF_COVERAGE when no piece of the base starts at or before the
 * reading, or when the piece that does is a gap: readings the blob says the
 * clock never showed, or that lie past what the blob was cut for.
 *
 * Only the low 16 bits of time_base are the time base. In a blob whose header
 * says its pieces are selected by context as well (flag bit 2), bits 16 to 23
 * are the context, and a piece answers only readings of its own base and
 * context; in any other blob those bits are ignored. */
LITE_API int lite_host2et(uint32_t time_base, uint32_t seconds, uint32_t useconds, double *et);

/* Same, from a serialized F Prime Fw::Time in its default layout: time base
 * (U16), context (U8), seconds (U32), microseconds (U32), big-endian, 11 bytes.
 * The context byte is passed on as the context described above, so it counts
 * only in a blob that selects by context. Deployments that change those types
 * or the byte order should decode the time themselves and call lite_host2et. */
LITE_API int lite_fwtime2et(const uint8_t *bytes, uint32_t len, double *et);

/* State of target relative to observer in J2000. state receives position then
 * velocity. lt receives the one-way light time; source receives a
 * LITE_SRC_ code. lt and source may be null. Under LITE_LT and LITE_LT_S the
 * position follows SPICE's LT and LT+S; the velocity is the target's velocity
 * at the retarded time minus the observer's, without SPICE's light-time rate
 * terms. */
LITE_API int lite_state(int32_t target, int32_t observer, double et, int32_t corr,
                        double state[6], double *lt, int32_t *source);

/* Supplies the spacecraft's state (for example from onboard navigation). body
 * must be flagged as the spacecraft in the blob; center must be a body in the
 * blob that does not depend on the spacecraft. The state is used, extrapolated
 * in a straight line, for query times within max_age seconds of et; otherwise
 * the predicted segment, if any, is used. */
LITE_API int lite_set_state(int32_t body, int32_t center, double et, const double state[6],
                            double max_age);
LITE_API int lite_clear_state(void);

/* Magnitude of the difference between the supplied state and the predicted
 * segment at et. Needs both. */
LITE_API int lite_state_gap(double et, double *dpos_km, double *dvel_km_s);

/* Rotation from J2000 to the body-fixed frame, row-major: fixed = rot * j2000. */
LITE_API int lite_orient(int32_t body, double et, double rot[9]);

/* Azimuth (from north toward east, 0 to 2 pi), elevation, and range of target
 * seen from a site. "Up" is the direction from the body center through the
 * site (planetocentric), unless the blob's header says its sites are geodetic
 * (flag bit 1), in which case it is the outward normal of the body's ellipsoid
 * through the site and the body must have radii (LITE_UNSUPPORTED otherwise).
 * Draft 0.1 supports LITE_NONE only. */
LITE_API int lite_site_view(int32_t site, int32_t target, double et, int32_t corr,
                            double *az, double *el, double *range);

/* The point on a body's surface nearest to an observer, geometric (no
 * aberration correction): planetocentric longitude (-pi to pi) and latitude of
 * that point in the body-fixed frame, and the observer's distance from it in
 * kilometers. The surface is the triaxial ellipsoid of the body's radii, so
 * this is SPICE's subpnt_c with "NEAR POINT/ELLIPSOID" and no correction.
 * Returns LITE_UNSUPPORTED when the blob gives the body no radii or radii that
 * are not all positive (or so extreme that the arithmetic leaves the finite
 * range), the status of lite_orient when the body has no orientation at et
 * (LITE_NO_PATH with no segment at all), and LITE_BAD_ARG when the observer is
 * inside the ellipsoid, which includes the body itself as observer. */
LITE_API int lite_sub_point(int32_t body, int32_t observer, double et,
                            double *lon, double *lat, double *alt);

/* Occultation codes for lite_occulted. The nonzero values equal the magnitude
 * of the code SPICE's occult_c gives for the same geometry. */
#define LITE_OCC_NONE 0    /* no part of target is behind by */
#define LITE_OCC_PARTIAL 1 /* the two disks overlap, neither inside the other */
#define LITE_OCC_ANNULAR 2 /* by lies wholly inside target's disk: a transit */
#define LITE_OCC_FULL 3    /* target lies wholly behind by */

/* Whether body `by` hides body `target` as seen from observer, geometric. A
 * body whose three radii differ is its triaxial ellipsoid, turned by its
 * ORIENT segment at et; a body with equal radii, or with no orientation at et
 * (no segment, or none covering et), is a sphere of the mean of its radii.
 * With ellipsoids the classification is that of SPICE's occult_c with
 * ELLIPSOID shapes; with the sphere stand-in for an unoriented body it can
 * differ while the limbs are within the spread of that body's radii. code
 * receives a LITE_OCC_ value; it is LITE_OCC_NONE whenever `by` is the farther
 * of the two, which is decided by a plane between the bodies and so exactly,
 * except for elongated bodies that all but touch (SPEC.md). Returns LITE_UNSUPPORTED when either body lacks positive radii,
 * and LITE_BAD_ARG when target and by are the same body or the observer is on
 * or inside either body as modeled. */
LITE_API int lite_occulted(int32_t target, int32_t by, int32_t observer, double et,
                           int32_t *code);

/* Shape codes for lite_occulted_shapes: how a body was modeled in one answer. */
#define LITE_SHAPE_SPHERE 0    /* its three radii are equal: a sphere, exactly */
#define LITE_SHAPE_ELLIPSOID 1 /* its triaxial ellipsoid, turned by its ORIENT segment at et */
#define LITE_SHAPE_STANDIN 2   /* its radii differ but the blob has no orientation for it at
                                  et: a sphere of the mean of its radii stood in for it */
#define LITE_SHAPE_BOUND 3     /* its radii differ, and the answer (LITE_OCC_NONE) came from
                                  the spheres of the largest radii being apart in the sky, so
                                  it holds for the ellipsoid in any attitude */

/* lite_occulted, and how each of the two bodies was modeled. The status and
 * code are those of lite_occulted for the same arguments. On LITE_OK,
 * target_shape and by_shape each receive a LITE_SHAPE_ value; either pointer
 * may be null. LITE_SHAPE_STANDIN is the one case where the answer may differ
 * from the ellipsoid's (see lite_occulted): a caller that needs the ellipsoid
 * can test for it. Nothing is written to the shapes on any other status. */
LITE_API int lite_occulted_shapes(int32_t target, int32_t by, int32_t observer, double et,
                                  int32_t *code, int32_t *target_shape, int32_t *by_shape);

/* lite_occulted_shapes with an aberration correction. LITE_NONE is that call.
 * LITE_LT places each of the two bodies where the observer sees it at et: at
 * et less its own one-way light time (one iteration, as in lite_state), with
 * its orientation taken at that earlier time too, which is SPICE's occult_c
 * with "LT". It needs a blob rooted at the solar system barycenter (header
 * flag bit 0) and segments that reach back by the light time: otherwise
 * LITE_UNSUPPORTED and LITE_OUT_OF_COVERAGE. LITE_LT_S returns
 * LITE_UNSUPPORTED: occult_c applies no stellar aberration and neither does
 * this. Light time moves the start and end of an event by the time the
 * farther body takes to cross the nearer one's light-time displacement: about
 * 40 seconds for the Earth hiding the Sun from the Moon, a second or two for
 * Saturn hiding the Sun or the Earth from an orbiter there. */
LITE_API int lite_occulted_corr(int32_t target, int32_t by, int32_t observer, double et,
                                int32_t corr, int32_t *code, int32_t *target_shape,
                                int32_t *by_shape);

#ifdef __cplusplus
}
#endif

#endif /* SPICE_LITE_H */
