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
 * the CRC unless LITE_INIT_SKIP_CRC is set) and makes it the active blob. The
 * memory must stay valid and unchanged while the blob is active, and should be
 * 8-byte aligned. Any supplied state is dropped. */
LITE_API int lite_init(const void *blob, uint32_t len, uint32_t flags);

/* Converts a host clock reading to ET using the TIME section. */
LITE_API int lite_host2et(uint32_t time_base, uint32_t seconds, uint32_t useconds, double *et);

/* Same, from a serialized F Prime Fw::Time in its default layout: time base
 * (U16), context (U8), seconds (U32), microseconds (U32), big-endian, 11 bytes.
 * Deployments that change those types or the byte order should decode the
 * time themselves and call lite_host2et. */
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
 * site (planetocentric). Draft 0.1 supports LITE_NONE only. */
LITE_API int lite_site_view(int32_t site, int32_t target, double et, int32_t corr,
                            double *az, double *el, double *range);

/* Declared by the spec; not implemented in this version. Both return
 * LITE_UNSUPPORTED. */
LITE_API int lite_sub_point(int32_t body, int32_t observer, double et,
                            double *lon, double *lat, double *alt);
LITE_API int lite_occulted(int32_t target, int32_t by, int32_t observer, double et,
                           int32_t *code);

#ifdef __cplusplus
}
#endif

#endif /* SPICE_LITE_H */
