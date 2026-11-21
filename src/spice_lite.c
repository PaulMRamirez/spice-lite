/*
 * spice-lite, draft 0.1. See include/spice_lite.h and SPEC.md.
 *
 * Constraints this file keeps: C99, freestanding (no libc, no heap, no host
 * imports), little-endian host, and only the arithmetic WebAssembly 1.0
 * defines exactly: add, subtract, multiply, divide, and square root on 64-bit
 * floats. Compile with floating-point contraction off (-ffp-contract=off) so
 * that every host produces bit-identical results.
 *
 * The sine, cosine, and arctangent kernels use the polynomial coefficients of
 * the freely distributable fdlibm library:
 *
 *   Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 *   Developed at SunPro, a Sun Microsystems, Inc. business.
 *   Permission to use, copy, modify, and distribute this software is freely
 *   granted, provided that this notice is preserved.
 */
#include "spice_lite.h"

#if defined(__BYTE_ORDER__) && defined(__ORDER_LITTLE_ENDIAN__)
#if __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "spice-lite 0.1 supports little-endian hosts only"
#endif
#endif

#define SEC_TIME 1
#define SEC_BODY 2
#define SEC_EPHEM 3
#define SEC_ORIENT 4
#define SEC_SITE 5
#define SEC_PROV 6
#define SEC_MAX 6

#define HEADER_SIZE 64u
#define DIR_ENTRY 16u
#define TIME_ENTRY 32u
#define BODY_ENTRY 32u
#define EPHEM_ENTRY 48u
#define ORIENT_ENTRY 64u
#define SITE_ENTRY 32u

#define MAX_SECTIONS 16u
#define MAX_BODIES 64u
#define MAX_DEPTH 8
#define MAX_DEGREE 40u
#define BLOB_LIMIT (1u << 20)

#define CLIGHT 299792.458
#define TWO_PI 6.28318530717958647692
#define TRIG_LIMIT 1.0e6

typedef struct {
    uint32_t off;
    uint32_t count;
    int present;
} section;

static struct {
    const uint8_t *b;
    uint32_t len;
    uint32_t flags;
    int ready;
    int root;
    section sec[SEC_MAX + 1];
    /* supplied spacecraft state */
    int sup_has;
    int sup_body;
    int sup_center;
    double sup_et;
    double sup_age;
    double sup_s[6];
} G;

/* ---- byte access -------------------------------------------------------- */

static uint16_t rd16(const uint8_t *p) { return (uint16_t)(p[0] | ((uint16_t)p[1] << 8)); }

static uint32_t rd32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static int32_t rdi32(const uint8_t *p) { return (int32_t)rd32(p); }

static int16_t rdi16(const uint8_t *p) { return (int16_t)rd16(p); }

static double rdf64(const uint8_t *p)
{
    double d;
    __builtin_memcpy(&d, p, 8);
    return d;
}

static int finite64(double x) { return (x - x) == 0.0; }

/* ---- small math --------------------------------------------------------- */

static double lite_sqrt(double x) { return __builtin_sqrt(x); }

static double lite_fabs(double x) { return x < 0.0 ? -x : x; }

static void sincos_kernel(double x, double *s, double *c)
{
    static const double S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03,
                        S3 = -1.98412698298579493134e-04, S4 = 2.75573137070700676789e-06,
                        S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
    static const double C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03,
                        C3 = 2.48015872894767294178e-05, C4 = -2.75573143513906633035e-07,
                        C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
    double z = x * x;
    double v = z * x;
    double r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    double q;
    *s = x + v * (S1 + z * r);
    q = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    *c = 1.0 - (0.5 * z - z * q);
}

/* Sine and cosine for |x| <= TRIG_LIMIT. Returns 0 on success. */
static int lite_sincos(double x, double *s, double *c)
{
    static const double INVPIO2 = 6.36619772367581382433e-01;
    static const double P1 = 1.57079632673412561417e+00; /* first 33 bits of pi/2 */
    static const double P2 = 6.07710050630396597660e-11; /* next 33 bits */
    static const double P2T = 2.02226624879595063154e-21;
    double t, fn, r, ks, kc;
    int64_t n;
    if (!finite64(x) || lite_fabs(x) > TRIG_LIMIT) {
        return 1;
    }
    t = x * INVPIO2;
    n = (int64_t)(t + (t >= 0.0 ? 0.5 : -0.5));
    fn = (double)n;
    r = ((x - fn * P1) - fn * P2) - fn * P2T;
    sincos_kernel(r, &ks, &kc);
    switch ((int)(n & 3)) {
    case 0: *s = ks; *c = kc; break;
    case 1: *s = kc; *c = -ks; break;
    case 2: *s = -ks; *c = -kc; break;
    default: *s = -kc; *c = ks; break;
    }
    return 0;
}

static double lite_atan(double x)
{
    static const double HI[4] = {4.63647609000806093515e-01, 7.85398163397448278999e-01,
                                 9.82793723247329054082e-01, 1.57079632679489655800e+00};
    static const double LO[4] = {2.26987774529616870924e-17, 3.06161699786838301793e-17,
                                 1.39033110312309984516e-17, 6.12323399573676603587e-17};
    static const double A[11] = {3.33333333333329318027e-01,  -1.99999999998764832476e-01,
                                 1.42857142725034663711e-01,  -1.11111104054623557880e-01,
                                 9.09088713343650656196e-02,  -7.69187620504482999495e-02,
                                 6.66107313738753120669e-02,  -5.83357013379057348645e-02,
                                 4.97687799461593236017e-02,  -3.65315727442169155270e-02,
                                 1.62858201153657823623e-02};
    int neg = x < 0.0;
    int id;
    double z, w, s1, s2, res;
    if (neg) {
        x = -x;
    }
    if (x < 0.4375) {
        id = -1;
    } else if (x < 0.6875) {
        id = 0;
        x = (2.0 * x - 1.0) / (2.0 + x);
    } else if (x < 1.1875) {
        id = 1;
        x = (x - 1.0) / (x + 1.0);
    } else if (x < 2.4375) {
        id = 2;
        x = (x - 1.5) / (1.0 + 1.5 * x);
    } else {
        id = 3;
        x = -1.0 / x;
    }
    z = x * x;
    w = z * z;
    s1 = z * (A[0] + w * (A[2] + w * (A[4] + w * (A[6] + w * (A[8] + w * A[10])))));
    s2 = w * (A[1] + w * (A[3] + w * (A[5] + w * (A[7] + w * A[9]))));
    if (id < 0) {
        res = x - x * (s1 + s2);
    } else {
        res = HI[id] - ((x * (s1 + s2) - LO[id]) - x);
    }
    return neg ? -res : res;
}

static double lite_atan2(double y, double x)
{
    static const double PI = 3.14159265358979311600e+00;
    static const double PIO2 = 1.57079632679489655800e+00;
    if (x > 0.0) {
        return lite_atan(y / x);
    }
    if (x < 0.0) {
        return y >= 0.0 ? lite_atan(y / x) + PI : lite_atan(y / x) - PI;
    }
    if (y > 0.0) {
        return PIO2;
    }
    if (y < 0.0) {
        return -PIO2;
    }
    return 0.0;
}

static double lite_asin(double v)
{
    if (v > 1.0) {
        v = 1.0;
    }
    if (v < -1.0) {
        v = -1.0;
    }
    return lite_atan2(v, lite_sqrt(1.0 - v * v));
}

static double norm3(const double *v) { return lite_sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); }

/* ---- CRC-32 (IEEE 802.3), four bits at a time --------------------------- */

static uint32_t crc32(const uint8_t *p, uint32_t n)
{
    static const uint32_t T[16] = {0x00000000u, 0x1DB71064u, 0x3B6E20C8u, 0x26D930ACu,
                                   0x76DC4190u, 0x6B6B51F4u, 0x4DB26158u, 0x5005713Cu,
                                   0xEDB88320u, 0xF00F9344u, 0xD6D6A3E8u, 0xCB61B38Cu,
                                   0x9B64C2B0u, 0x86D3D2D4u, 0xA00AE278u, 0xBDBDF21Cu};
    uint32_t crc = 0xFFFFFFFFu;
    uint32_t i;
    for (i = 0; i < n; i++) {
        crc ^= p[i];
        crc = T[crc & 15u] ^ (crc >> 4);
        crc = T[crc & 15u] ^ (crc >> 4);
    }
    return ~crc;
}

/* ---- section accessors -------------------------------------------------- */

static const uint8_t *body_at(int i) { return G.b + G.sec[SEC_BODY].off + (uint32_t)i * BODY_ENTRY; }

static int32_t body_naif(int i) { return rdi32(body_at(i)); }

static int body_parent(int i) { return (int)rdi16(body_at(i) + 4); }

static uint16_t body_flags(int i) { return rd16(body_at(i) + 6); }

static int body_index(int32_t naif)
{
    int n = (int)G.sec[SEC_BODY].count;
    int i;
    for (i = 0; i < n; i++) {
        if (body_naif(i) == naif) {
            return i;
        }
    }
    return -1;
}

/* Records occupy rec_size * count bytes at data_offset; all inside the blob. */
static int records_ok(uint32_t data_off, uint32_t count, uint32_t rec_size, uint32_t total)
{
    uint64_t need = (uint64_t)count * (uint64_t)rec_size;
    if ((data_off & 7u) != 0u || data_off < HEADER_SIZE || data_off > total) {
        return 0;
    }
    return need <= (uint64_t)(total - data_off);
}

static uint32_t ephem_rec_size(uint32_t kind, uint32_t degree)
{
    if (kind == 1u) {
        return 3u * (degree + 1u) * 8u;
    }
    if (kind == 2u) {
        return 6u * (degree + 1u) * 8u;
    }
    return 48u; /* kind 3 */
}

/* ---- lite_init ---------------------------------------------------------- */

static int validate(const uint8_t *b, uint32_t len, uint32_t flags)
{
    uint32_t total, nsec, i, dir_end;
    int k;
    if (b == 0 || len < HEADER_SIZE) {
        return 0;
    }
    if (b[0] != 'S' || b[1] != 'L' || b[2] != 'B' || b[3] != '1') {
        return 0;
    }
    if (rd16(b + 4) != 0u) {
        return 0;
    }
    total = rd32(b + 8);
    if (total < HEADER_SIZE || total > len || total > BLOB_LIMIT) {
        return 0;
    }
    if (rd16(b + 22) != 0u) {
        return 0;
    }
    for (i = 56; i < 64; i++) {
        if (b[i] != 0u) {
            return 0;
        }
    }
    if ((rd32(b + 16) & ~1u) != 0u && rd16(b + 6) <= 1u) {
        return 0; /* unknown flag bits in a minor version this reader knows */
    }
    nsec = rd16(b + 20);
    if (nsec > MAX_SECTIONS) {
        return 0;
    }
    dir_end = HEADER_SIZE + nsec * DIR_ENTRY;
    if (dir_end > total) {
        return 0;
    }
    if (!finite64(rdf64(b + 24)) || !finite64(rdf64(b + 32)) || !finite64(rdf64(b + 40)) ||
        rdf64(b + 24) > rdf64(b + 32)) {
        return 0;
    }
    for (k = 0; k <= SEC_MAX; k++) {
        G.sec[k].present = 0;
        G.sec[k].off = 0;
        G.sec[k].count = 0;
    }
    for (i = 0; i < nsec; i++) {
        const uint8_t *e = b + HEADER_SIZE + i * DIR_ENTRY;
        uint32_t type = rd16(e);
        uint32_t eflags = rd16(e + 2);
        uint32_t off = rd32(e + 4);
        uint32_t length = rd32(e + 8);
        uint32_t count = rd32(e + 12);
        uint32_t esize = 0;
        if ((off & 7u) != 0u || off < dir_end || off > total || length > total - off) {
            return 0;
        }
        if (type == 0u || type > SEC_MAX) {
            if ((eflags & 1u) != 0u) {
                return 0;
            }
            continue;
        }
        if (G.sec[type].present) {
            return 0;
        }
        switch (type) {
        case SEC_TIME: esize = TIME_ENTRY; break;
        case SEC_BODY: esize = BODY_ENTRY; break;
        case SEC_EPHEM: esize = EPHEM_ENTRY; break;
        case SEC_ORIENT: esize = ORIENT_ENTRY; break;
        case SEC_SITE: esize = SITE_ENTRY; break;
        default: esize = 0; break; /* PROV: opaque */
        }
        if (esize != 0u && (uint64_t)count * esize > (uint64_t)length) {
            return 0;
        }
        G.sec[type].present = 1;
        G.sec[type].off = off;
        G.sec[type].count = count;
    }
    if (!G.sec[SEC_BODY].present || !G.sec[SEC_EPHEM].present) {
        return 0;
    }
    /* body tree: one root, valid parents, bounded depth, no cycles */
    {
        uint32_t nb = G.sec[SEC_BODY].count;
        int root = -1;
        if (nb == 0u || nb > MAX_BODIES) {
            return 0;
        }
        G.b = b; /* accessors below read through G.b */
        for (i = 0; i < nb; i++) {
            int p = body_parent((int)i);
            int j;
            if (p == -1) {
                if (root != -1) {
                    return 0;
                }
                root = (int)i;
            } else if (p < 0 || (uint32_t)p >= nb || p == (int)i) {
                return 0;
            }
            for (j = (int)i + 1; j < (int)nb; j++) {
                if (body_naif(j) == body_naif((int)i)) {
                    return 0;
                }
            }
            for (j = 0; j < 3; j++) {
                if (!finite64(rdf64(body_at((int)i) + 8 + 8 * (uint32_t)j))) {
                    return 0;
                }
            }
        }
        if (root == -1) {
            return 0;
        }
        for (i = 0; i < nb; i++) {
            int cur = (int)i;
            int steps = 0;
            while (cur != root) {
                cur = body_parent(cur);
                if (++steps > MAX_DEPTH) {
                    return 0;
                }
            }
        }
        G.root = root;
    }
    for (i = 0; i < G.sec[SEC_EPHEM].count; i++) {
        const uint8_t *e = b + G.sec[SEC_EPHEM].off + i * EPHEM_ENTRY;
        uint32_t kind = e[8], degree = e[10], count = rd32(e + 12);
        double t0 = rdf64(e + 16), dt = rdf64(e + 24);
        if (!finite64(t0) || !finite64(dt) || !(dt > 0.0)) {
            return 0;
        }
        if (kind < 1u || kind > 3u) {
            continue; /* unknown kind: queries that need it report unsupported */
        }
        if (degree > MAX_DEGREE || count == 0u || (kind == 3u && count < 2u)) {
            return 0;
        }
        if (!records_ok(rd32(e + 32), count, ephem_rec_size(kind, degree), total)) {
            return 0;
        }
    }
    for (i = 0; i < G.sec[SEC_ORIENT].count; i++) {
        const uint8_t *e = b + G.sec[SEC_ORIENT].off + i * ORIENT_ENTRY;
        uint32_t kind = e[4], degree = e[5], count = rd32(e + 8);
        double t0 = rdf64(e + 16), dt = rdf64(e + 24);
        if (!finite64(t0) || !finite64(dt) || !(dt > 0.0) || !finite64(rdf64(e + 32)) ||
            !finite64(rdf64(e + 40))) {
            return 0;
        }
        if (kind != 1u) {
            continue;
        }
        if (degree > MAX_DEGREE || count == 0u ||
            !records_ok(rd32(e + 12), count, 3u * (degree + 1u) * 8u, total)) {
            return 0;
        }
    }
    for (i = 0; i < G.sec[SEC_TIME].count; i++) {
        const uint8_t *e = b + G.sec[SEC_TIME].off + i * TIME_ENTRY;
        if (!finite64(rdf64(e + 8)) || !finite64(rdf64(e + 16)) || !finite64(rdf64(e + 24))) {
            return 0;
        }
    }
    for (i = 0; i < G.sec[SEC_SITE].count; i++) {
        const uint8_t *e = b + G.sec[SEC_SITE].off + i * SITE_ENTRY;
        int j;
        for (j = 0; j < 3; j++) {
            if (!finite64(rdf64(e + 8 + 8 * (uint32_t)j))) {
                return 0;
            }
        }
    }
    if ((flags & LITE_INIT_SKIP_CRC) == 0u) {
        if (crc32(b + 16, total - 16u) != rd32(b + 12)) {
            return 0;
        }
    }
    G.len = total;
    G.flags = rd32(b + 16);
    return 1;
}

int lite_init(const void *blob, uint32_t len, uint32_t flags)
{
    G.ready = 0;
    G.sup_has = 0;
    if (!validate((const uint8_t *)blob, len, flags)) {
        G.b = 0;
        return LITE_BAD_BLOB;
    }
    G.b = (const uint8_t *)blob;
    G.ready = 1;
    return LITE_OK;
}

/* ---- time --------------------------------------------------------------- */

int lite_host2et(uint32_t time_base, uint32_t seconds, uint32_t useconds, double *et)
{
    uint32_t i, n;
    double host;
    const uint8_t *best = 0;
    if (!G.ready) {
        return LITE_BAD_BLOB;
    }
    if (et == 0 || useconds >= 1000000u) {
        return LITE_BAD_ARG;
    }
    host = (double)seconds + (double)useconds * 1.0e-6;
    n = G.sec[SEC_TIME].count;
    for (i = 0; i < n; i++) {
        const uint8_t *e = G.b + G.sec[SEC_TIME].off + i * TIME_ENTRY;
        if (rd16(e) == (uint16_t)time_base && rdf64(e + 8) <= host) {
            if (best == 0 || rdf64(e + 8) >= rdf64(best + 8)) {
                best = e;
            }
        }
    }
    if (best == 0) {
        return LITE_OUT_OF_COVERAGE;
    }
    *et = rdf64(best + 16) + rdf64(best + 24) * (host - rdf64(best + 8));
    return LITE_OK;
}

int lite_fwtime2et(const uint8_t *bytes, uint32_t len, double *et)
{
    uint32_t base, sec, usec;
    if (bytes == 0 || len != 11u) {
        return G.ready ? LITE_BAD_ARG : LITE_BAD_BLOB;
    }
    base = ((uint32_t)bytes[0] << 8) | bytes[1];
    sec = ((uint32_t)bytes[3] << 24) | ((uint32_t)bytes[4] << 16) | ((uint32_t)bytes[5] << 8) | bytes[6];
    usec = ((uint32_t)bytes[7] << 24) | ((uint32_t)bytes[8] << 16) | ((uint32_t)bytes[9] << 8) | bytes[10];
    return lite_host2et(base, sec, usec, et);
}

/* ---- segment evaluation ------------------------------------------------- */

/* Chebyshev value and derivative with respect to the normalized argument. */
static void cheb_vd(const uint8_t *c, uint32_t degree, double x, double *val, double *der)
{
    double x2 = 2.0 * x;
    double w0 = 0.0, w1 = 0.0, w2;
    double d0 = 0.0, d1 = 0.0, d2;
    uint32_t j;
    for (j = degree; j >= 1u; j--) {
        w2 = w1;
        w1 = w0;
        w0 = rdf64(c + 8u * j) + (x2 * w1 - w2);
        d2 = d1;
        d1 = d0;
        d0 = 2.0 * w1 + (x2 * d1 - d2);
    }
    *val = rdf64(c) + (x * w0 - w1);
    *der = w0 + (x * d0 - d1);
}

static double cheb_v(const uint8_t *c, uint32_t degree, double x)
{
    double x2 = 2.0 * x;
    double w0 = 0.0, w1 = 0.0, w2;
    uint32_t j;
    for (j = degree; j >= 1u; j--) {
        w2 = w1;
        w1 = w0;
        w0 = rdf64(c + 8u * j) + (x2 * w1 - w2);
    }
    return rdf64(c) + (x * w0 - w1);
}

/* Record index and normalized argument for a uniform grid; 0 if t is outside. */
static int grid_locate(double t, double t0, double dt, uint32_t count, uint32_t *k, double *x)
{
    double u, tk;
    uint32_t idx;
    if (!(t >= t0) || !(t <= t0 + dt * (double)count)) {
        return 0;
    }
    u = (t - t0) / dt;
    idx = (uint32_t)u;
    if (idx >= count) {
        idx = count - 1u;
    }
    tk = t0 + dt * (double)idx;
    *k = idx;
    *x = 2.0 * (t - tk) / dt - 1.0;
    return 1;
}

/* Evaluates one EPHEM entry at t. Returns a status. */
static int eval_ephem(const uint8_t *e, double t, double *s)
{
    uint32_t kind = e[8], degree = e[10], count = rd32(e + 12);
    double t0 = rdf64(e + 16), dt = rdf64(e + 24);
    const uint8_t *data = G.b + rd32(e + 32);
    uint32_t k, n1 = degree + 1u;
    double x;
    int i;
    if (kind == 1u) {
        const uint8_t *rec;
        double scale = 2.0 / dt;
        if (!grid_locate(t, t0, dt, count, &k, &x)) {
            return LITE_OUT_OF_COVERAGE;
        }
        rec = data + (uint64_t)k * (3u * n1 * 8u);
        for (i = 0; i < 3; i++) {
            double v, d;
            cheb_vd(rec + (uint32_t)i * n1 * 8u, degree, x, &v, &d);
            s[i] = v;
            s[i + 3] = d * scale;
        }
        return LITE_OK;
    }
    if (kind == 2u) {
        const uint8_t *rec;
        if (!grid_locate(t, t0, dt, count, &k, &x)) {
            return LITE_OUT_OF_COVERAGE;
        }
        rec = data + (uint64_t)k * (6u * n1 * 8u);
        for (i = 0; i < 6; i++) {
            s[i] = cheb_v(rec + (uint32_t)i * n1 * 8u, degree, x);
        }
        return LITE_OK;
    }
    if (kind == 3u) {
        const uint8_t *a, *b;
        double u, h00, h10, h01, h11, g00, g10, g01, g11, u2, u3;
        if (!grid_locate(t, t0, dt, count - 1u, &k, &x)) {
            return LITE_OUT_OF_COVERAGE;
        }
        a = data + (uint64_t)k * 48u;
        b = a + 48u;
        u = (x + 1.0) * 0.5;
        u2 = u * u;
        u3 = u2 * u;
        h00 = 2.0 * u3 - 3.0 * u2 + 1.0;
        h10 = u3 - 2.0 * u2 + u;
        h01 = -2.0 * u3 + 3.0 * u2;
        h11 = u3 - u2;
        g00 = 6.0 * u2 - 6.0 * u;
        g10 = 3.0 * u2 - 4.0 * u + 1.0;
        g01 = -6.0 * u2 + 6.0 * u;
        g11 = 3.0 * u2 - 2.0 * u;
        for (i = 0; i < 3; i++) {
            double p0 = rdf64(a + 8u * (uint32_t)i), v0 = rdf64(a + 24u + 8u * (uint32_t)i);
            double p1 = rdf64(b + 8u * (uint32_t)i), v1 = rdf64(b + 24u + 8u * (uint32_t)i);
            s[i] = h00 * p0 + h10 * dt * v0 + h01 * p1 + h11 * dt * v1;
            s[i + 3] = (g00 * p0 + g01 * p1) / dt + g10 * v0 + g11 * v1;
        }
        return LITE_OK;
    }
    return LITE_UNSUPPORTED;
}

static int sup_fresh(double et)
{
    return G.sup_has && lite_fabs(et - G.sup_et) <= G.sup_age;
}

/* The node a body hangs from at time et: its supplied center when a fresh
 * supplied state applies, otherwise its parent in the tree. */
static int next_of(int idx, double et, int use_sup)
{
    if (use_sup && idx == G.sup_body && sup_fresh(et)) {
        return G.sup_center;
    }
    return body_parent(idx);
}

/* State of body idx relative to next_of(idx). */
static int link_state(int idx, double et, int use_sup, double *s, int *src)
{
    uint32_t i, n = G.sec[SEC_EPHEM].count;
    int32_t target = body_naif(idx);
    int32_t center;
    int seen = 0, unsupported = 0;
    int p;
    if (use_sup && idx == G.sup_body && sup_fresh(et)) {
        double dt = et - G.sup_et;
        int k;
        for (k = 0; k < 3; k++) {
            s[k] = G.sup_s[k] + G.sup_s[k + 3] * dt;
            s[k + 3] = G.sup_s[k + 3];
        }
        *src = LITE_SRC_SUPPLIED;
        return LITE_OK;
    }
    p = body_parent(idx);
    if (p < 0) {
        return LITE_NO_PATH;
    }
    center = body_naif(p);
    for (i = 0; i < n; i++) {
        const uint8_t *e = G.b + G.sec[SEC_EPHEM].off + i * EPHEM_ENTRY;
        int st;
        if (rdi32(e) != target || rdi32(e + 4) != center) {
            continue;
        }
        seen = 1;
        st = eval_ephem(e, et, s);
        if (st == LITE_OK) {
            *src = e[9] == 1u ? LITE_SRC_PREDICTED : LITE_SRC_PUBLISHED;
            return LITE_OK;
        }
        if (st == LITE_UNSUPPORTED) {
            unsupported = 1;
        }
    }
    if (use_sup && idx == G.sup_body && G.sup_has && !seen) {
        return LITE_STALE;
    }
    if (unsupported) {
        return LITE_UNSUPPORTED;
    }
    return seen ? LITE_OUT_OF_COVERAGE : LITE_NO_PATH;
}

/* Geometric state of body a relative to body b at et. */
static int state_rel(int a, int b, double et, int use_sup, double *out, int *src)
{
    int pa[MAX_DEPTH + 3], pb[MAX_DEPTH + 3];
    int na = 0, nb = 0, i, j, la = -1, lb = -1, k, worst = LITE_SRC_PUBLISHED;
    double acc[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
    double s[6];
    int cur;
    for (cur = a; cur >= 0 && na < MAX_DEPTH + 3; cur = next_of(cur, et, use_sup)) {
        pa[na++] = cur;
    }
    for (cur = b; cur >= 0 && nb < MAX_DEPTH + 3; cur = next_of(cur, et, use_sup)) {
        pb[nb++] = cur;
    }
    for (i = 0; i < na && la < 0; i++) {
        for (j = 0; j < nb; j++) {
            if (pa[i] == pb[j]) {
                la = i;
                lb = j;
                break;
            }
        }
    }
    if (la < 0) {
        return LITE_NO_PATH;
    }
    for (i = 0; i < la; i++) {
        int one = LITE_SRC_PUBLISHED;
        int st = link_state(pa[i], et, use_sup, s, &one);
        if (st != LITE_OK) {
            return st;
        }
        for (k = 0; k < 6; k++) {
            acc[k] += s[k];
        }
        if (one > worst) {
            worst = one;
        }
    }
    for (j = 0; j < lb; j++) {
        int one = LITE_SRC_PUBLISHED;
        int st = link_state(pb[j], et, use_sup, s, &one);
        if (st != LITE_OK) {
            return st;
        }
        for (k = 0; k < 6; k++) {
            acc[k] -= s[k];
        }
        if (one > worst) {
            worst = one;
        }
    }
    for (k = 0; k < 6; k++) {
        out[k] = acc[k];
    }
    if (src != 0) {
        *src = worst;
    }
    return LITE_OK;
}

/* ---- public state calls ------------------------------------------------- */

int lite_state(int32_t target, int32_t observer, double et, int32_t corr, double state[6],
               double *lt, int32_t *source)
{
    int ti, oi, st, src = LITE_SRC_PUBLISHED, k;
    double s[6];
    if (!G.ready) {
        return LITE_BAD_BLOB;
    }
    if (state == 0 || !finite64(et) || corr < LITE_NONE || corr > LITE_LT_S) {
        return LITE_BAD_ARG;
    }
    ti = body_index(target);
    oi = body_index(observer);
    if (ti < 0 || oi < 0) {
        return LITE_NO_PATH;
    }
    if (corr == LITE_NONE) {
        st = state_rel(ti, oi, et, 1, s, &src);
        if (st != LITE_OK) {
            return st;
        }
        if (lt != 0) {
            *lt = norm3(s) / CLIGHT;
        }
    } else {
        double obs[6], tgt[6], lt0, ltv;
        int s1 = LITE_SRC_PUBLISHED, s2 = LITE_SRC_PUBLISHED;
        if ((G.flags & 1u) == 0u || body_naif(G.root) != 0) {
            return LITE_UNSUPPORTED;
        }
        st = state_rel(oi, G.root, et, 1, obs, &s1);
        if (st != LITE_OK) {
            return st;
        }
        st = state_rel(ti, G.root, et, 1, tgt, &s2);
        if (st != LITE_OK) {
            return st;
        }
        for (k = 0; k < 3; k++) {
            s[k] = tgt[k] - obs[k];
        }
        lt0 = norm3(s) / CLIGHT;
        st = state_rel(ti, G.root, et - lt0, 1, tgt, &s2);
        if (st != LITE_OK) {
            return st;
        }
        for (k = 0; k < 6; k++) {
            s[k] = tgt[k] - obs[k];
        }
        ltv = norm3(s) / CLIGHT;
        if (corr == LITE_LT_S) {
            double r = norm3(s);
            if (r > 0.0) {
                double u[3], v[3], h[3], sinphi, cosphi;
                for (k = 0; k < 3; k++) {
                    u[k] = s[k] / r;
                    v[k] = obs[k + 3] / CLIGHT;
                }
                h[0] = u[1] * v[2] - u[2] * v[1];
                h[1] = u[2] * v[0] - u[0] * v[2];
                h[2] = u[0] * v[1] - u[1] * v[0];
                sinphi = norm3(h);
                if (sinphi >= 1.0) {
                    return LITE_UNSUPPORTED;
                }
                cosphi = lite_sqrt(1.0 - sinphi * sinphi);
                {
                    double p0 = s[0], p1 = s[1], p2 = s[2];
                    s[0] = p0 * cosphi + (h[1] * p2 - h[2] * p1);
                    s[1] = p1 * cosphi + (h[2] * p0 - h[0] * p2);
                    s[2] = p2 * cosphi + (h[0] * p1 - h[1] * p0);
                }
            }
        }
        if (lt != 0) {
            *lt = ltv;
        }
        src = s1 > s2 ? s1 : s2;
    }
    for (k = 0; k < 6; k++) {
        state[k] = s[k];
    }
    if (source != 0) {
        *source = src;
    }
    return LITE_OK;
}

int lite_set_state(int32_t body, int32_t center, double et, const double state[6], double max_age)
{
    int bi, ci, cur, steps = 0, k;
    if (!G.ready) {
        return LITE_BAD_BLOB;
    }
    if (state == 0 || !finite64(et) || !finite64(max_age) || max_age < 0.0) {
        return LITE_BAD_ARG;
    }
    for (k = 0; k < 6; k++) {
        if (!finite64(state[k])) {
            return LITE_BAD_ARG;
        }
    }
    bi = body_index(body);
    ci = body_index(center);
    if (bi < 0 || ci < 0) {
        return LITE_NO_PATH;
    }
    if ((body_flags(bi) & 2u) == 0u || bi == ci) {
        return LITE_BAD_ARG;
    }
    /* the center must not hang from the spacecraft */
    for (cur = ci; cur >= 0; cur = body_parent(cur)) {
        if (cur == bi || ++steps > MAX_DEPTH + 1) {
            return LITE_BAD_ARG;
        }
    }
    G.sup_body = bi;
    G.sup_center = ci;
    G.sup_et = et;
    G.sup_age = max_age;
    for (k = 0; k < 6; k++) {
        G.sup_s[k] = state[k];
    }
    G.sup_has = 1;
    return LITE_OK;
}

int lite_clear_state(void)
{
    if (!G.ready) {
        return LITE_BAD_BLOB;
    }
    G.sup_has = 0;
    return LITE_OK;
}

int lite_state_gap(double et, double *dpos_km, double *dvel_km_s)
{
    double sup[6], pred[6], d[6];
    int src = 0, st, k;
    if (!G.ready) {
        return LITE_BAD_BLOB;
    }
    if (dpos_km == 0 || dvel_km_s == 0 || !finite64(et)) {
        return LITE_BAD_ARG;
    }
    if (!G.sup_has) {
        return LITE_NO_PATH;
    }
    if (!sup_fresh(et)) {
        return LITE_STALE;
    }
    st = link_state(G.sup_body, et, 1, sup, &src);
    if (st != LITE_OK) {
        return st;
    }
    st = state_rel(G.sup_body, G.sup_center, et, 0, pred, &src);
    if (st != LITE_OK) {
        return st;
    }
    for (k = 0; k < 6; k++) {
        d[k] = sup[k] - pred[k];
    }
    *dpos_km = norm3(d);
    *dvel_km_s = norm3(d + 3);
    return LITE_OK;
}

/* ---- orientation and sites ---------------------------------------------- */

int lite_orient(int32_t body, double et, double rot[9])
{
    uint32_t i, n;
    int seen = 0, unsupported = 0;
    if (!G.ready) {
        return LITE_BAD_BLOB;
    }
    if (rot == 0 || !finite64(et)) {
        return LITE_BAD_ARG;
    }
    n = G.sec[SEC_ORIENT].count;
    for (i = 0; i < n; i++) {
        const uint8_t *e = G.b + G.sec[SEC_ORIENT].off + i * ORIENT_ENTRY;
        uint32_t degree, count, k, n1;
        double t0, dt, x, ra, dec, w;
        double sa, ca, sd, cd, sw, cw;
        const uint8_t *rec;
        if (rdi32(e) != body) {
            continue;
        }
        seen = 1;
        if (e[4] != 1u) {
            unsupported = 1;
            continue;
        }
        degree = e[5];
        count = rd32(e + 8);
        t0 = rdf64(e + 16);
        dt = rdf64(e + 24);
        if (!grid_locate(et, t0, dt, count, &k, &x)) {
            continue;
        }
        n1 = degree + 1u;
        rec = G.b + rd32(e + 12) + (uint64_t)k * (3u * n1 * 8u);
        ra = cheb_v(rec, degree, x);
        dec = cheb_v(rec + n1 * 8u, degree, x);
        w = rdf64(e + 32) + rdf64(e + 40) * (et - t0) + cheb_v(rec + 2u * n1 * 8u, degree, x);
        if (lite_sincos(ra, &sa, &ca) || lite_sincos(dec, &sd, &cd) || lite_sincos(w, &sw, &cw)) {
            return LITE_UNSUPPORTED;
        }
        /* R3(W) * R1(pi/2 - Dec) * R3(pi/2 + RA), written out. With
         * P = R1 * R3: P0 = (-sa, ca, 0), P1 = (-sd*ca, -sd*sa, cd),
         * P2 = (cd*ca, cd*sa, sd). */
        {
            double p00 = -sa, p01 = ca, p02 = 0.0;
            double p10 = -sd * ca, p11 = -sd * sa, p12 = cd;
            rot[0] = cw * p00 + sw * p10;
            rot[1] = cw * p01 + sw * p11;
            rot[2] = cw * p02 + sw * p12;
            rot[3] = -sw * p00 + cw * p10;
            rot[4] = -sw * p01 + cw * p11;
            rot[5] = -sw * p02 + cw * p12;
            rot[6] = cd * ca;
            rot[7] = cd * sa;
            rot[8] = sd;
        }
        return LITE_OK;
    }
    if (unsupported) {
        return LITE_UNSUPPORTED;
    }
    return seen ? LITE_OUT_OF_COVERAGE : LITE_NO_PATH;
}

int lite_site_view(int32_t site, int32_t target, double et, int32_t corr, double *az, double *el,
                   double *range)
{
    uint32_t i, n;
    const uint8_t *e = 0;
    double rot[9], s[6], bf[3], d[3], up[3], north[3], east[3], sp[3];
    double rs, rn, rd, zu;
    int st, k, ti, bi, src = 0;
    static const double PI2 = TWO_PI;
    if (!G.ready) {
        return LITE_BAD_BLOB;
    }
    if (az == 0 || el == 0 || range == 0 || !finite64(et)) {
        return LITE_BAD_ARG;
    }
    if (corr != LITE_NONE) {
        return LITE_UNSUPPORTED;
    }
    n = G.sec[SEC_SITE].count;
    for (i = 0; i < n; i++) {
        const uint8_t *c = G.b + G.sec[SEC_SITE].off + i * SITE_ENTRY;
        if (rdi32(c) == site) {
            e = c;
            break;
        }
    }
    if (e == 0) {
        return LITE_NO_PATH;
    }
    bi = body_index(rdi32(e + 4));
    ti = body_index(target);
    if (bi < 0 || ti < 0) {
        return LITE_NO_PATH;
    }
    st = lite_orient(rdi32(e + 4), et, rot);
    if (st != LITE_OK) {
        return st;
    }
    st = state_rel(ti, bi, et, 1, s, &src);
    if (st != LITE_OK) {
        return st;
    }
    for (k = 0; k < 3; k++) {
        sp[k] = rdf64(e + 8 + 8u * (uint32_t)k);
        bf[k] = rot[3 * k] * s[0] + rot[3 * k + 1] * s[1] + rot[3 * k + 2] * s[2];
    }
    rs = norm3(sp);
    if (!(rs > 0.0)) {
        return LITE_BAD_ARG;
    }
    for (k = 0; k < 3; k++) {
        up[k] = sp[k] / rs;
        d[k] = bf[k] - sp[k];
    }
    /* north: the body's +Z axis with its component along "up" removed */
    zu = up[2];
    north[0] = -zu * up[0];
    north[1] = -zu * up[1];
    north[2] = 1.0 - zu * up[2];
    rn = norm3(north);
    if (!(rn > 1.0e-12)) {
        return LITE_UNSUPPORTED; /* a site at a pole has no north */
    }
    for (k = 0; k < 3; k++) {
        north[k] /= rn;
    }
    east[0] = north[1] * up[2] - north[2] * up[1];
    east[1] = north[2] * up[0] - north[0] * up[2];
    east[2] = north[0] * up[1] - north[1] * up[0];
    rd = norm3(d);
    *range = rd;
    if (!(rd > 0.0)) {
        *az = 0.0;
        *el = 0.0;
        return LITE_OK;
    }
    *el = lite_asin((d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) / rd);
    {
        double a = lite_atan2(d[0] * east[0] + d[1] * east[1] + d[2] * east[2],
                              d[0] * north[0] + d[1] * north[1] + d[2] * north[2]);
        if (a < 0.0) {
            a += PI2;
        }
        *az = a;
    }
    return LITE_OK;
}

int lite_sub_point(int32_t body, int32_t observer, double et, double *lon, double *lat, double *alt)
{
    (void)body;
    (void)observer;
    (void)et;
    (void)lon;
    (void)lat;
    (void)alt;
    return G.ready ? LITE_UNSUPPORTED : LITE_BAD_BLOB;
}

int lite_occulted(int32_t target, int32_t by, int32_t observer, double et, int32_t *code)
{
    (void)target;
    (void)by;
    (void)observer;
    (void)et;
    (void)code;
    return G.ready ? LITE_UNSUPPORTED : LITE_BAD_BLOB;
}
