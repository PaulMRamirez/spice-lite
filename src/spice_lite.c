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

/* EPHEM kind 4, the compact orbit model: record size, the largest squared
 * eccentricity it accepts (0.9 squared), and the cap on Kepler iterations. */
#define ORBIT_REC 160u
#define ORBIT_E2_MAX 0.81
#define ORBIT_KEPLER_MAX 6

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

static double rdf32(const uint8_t *p)
{
    float f;
    __builtin_memcpy(&f, p, 4);
    return (double)f;
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

/* ---- CRC-32 (IEEE 802.3) ------------------------------------------------ */

/* The check is the costly part of lite_init under an interpreter, and the
 * cost trades against read-only table space. LITE_CRC_TABLES picks the trade:
 *
 *   0   one 16-entry table (64 bytes), four bits at a time
 *   1   one 256-entry table (1 KiB), one byte at a time; the default
 *   4   four 256-entry tables (4 KiB), four bytes at a time
 *
 * All three compute the same value. docs/cost-measurements.md has the measured
 * cost per byte of each. The four-byte variant loads a 32-bit word and so
 * assumes a little-endian host, as the rest of this file does. */
#ifndef LITE_CRC_TABLES
#define LITE_CRC_TABLES 1
#endif

#if LITE_CRC_TABLES == 0

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

#elif LITE_CRC_TABLES == 1 || LITE_CRC_TABLES == 4

static const uint32_t CRC_T[LITE_CRC_TABLES][256] = {
    {
     0x00000000u, 0x77073096u, 0xEE0E612Cu, 0x990951BAu, 0x076DC419u, 0x706AF48Fu,
     0xE963A535u, 0x9E6495A3u, 0x0EDB8832u, 0x79DCB8A4u, 0xE0D5E91Eu, 0x97D2D988u,
     0x09B64C2Bu, 0x7EB17CBDu, 0xE7B82D07u, 0x90BF1D91u, 0x1DB71064u, 0x6AB020F2u,
     0xF3B97148u, 0x84BE41DEu, 0x1ADAD47Du, 0x6DDDE4EBu, 0xF4D4B551u, 0x83D385C7u,
     0x136C9856u, 0x646BA8C0u, 0xFD62F97Au, 0x8A65C9ECu, 0x14015C4Fu, 0x63066CD9u,
     0xFA0F3D63u, 0x8D080DF5u, 0x3B6E20C8u, 0x4C69105Eu, 0xD56041E4u, 0xA2677172u,
     0x3C03E4D1u, 0x4B04D447u, 0xD20D85FDu, 0xA50AB56Bu, 0x35B5A8FAu, 0x42B2986Cu,
     0xDBBBC9D6u, 0xACBCF940u, 0x32D86CE3u, 0x45DF5C75u, 0xDCD60DCFu, 0xABD13D59u,
     0x26D930ACu, 0x51DE003Au, 0xC8D75180u, 0xBFD06116u, 0x21B4F4B5u, 0x56B3C423u,
     0xCFBA9599u, 0xB8BDA50Fu, 0x2802B89Eu, 0x5F058808u, 0xC60CD9B2u, 0xB10BE924u,
     0x2F6F7C87u, 0x58684C11u, 0xC1611DABu, 0xB6662D3Du, 0x76DC4190u, 0x01DB7106u,
     0x98D220BCu, 0xEFD5102Au, 0x71B18589u, 0x06B6B51Fu, 0x9FBFE4A5u, 0xE8B8D433u,
     0x7807C9A2u, 0x0F00F934u, 0x9609A88Eu, 0xE10E9818u, 0x7F6A0DBBu, 0x086D3D2Du,
     0x91646C97u, 0xE6635C01u, 0x6B6B51F4u, 0x1C6C6162u, 0x856530D8u, 0xF262004Eu,
     0x6C0695EDu, 0x1B01A57Bu, 0x8208F4C1u, 0xF50FC457u, 0x65B0D9C6u, 0x12B7E950u,
     0x8BBEB8EAu, 0xFCB9887Cu, 0x62DD1DDFu, 0x15DA2D49u, 0x8CD37CF3u, 0xFBD44C65u,
     0x4DB26158u, 0x3AB551CEu, 0xA3BC0074u, 0xD4BB30E2u, 0x4ADFA541u, 0x3DD895D7u,
     0xA4D1C46Du, 0xD3D6F4FBu, 0x4369E96Au, 0x346ED9FCu, 0xAD678846u, 0xDA60B8D0u,
     0x44042D73u, 0x33031DE5u, 0xAA0A4C5Fu, 0xDD0D7CC9u, 0x5005713Cu, 0x270241AAu,
     0xBE0B1010u, 0xC90C2086u, 0x5768B525u, 0x206F85B3u, 0xB966D409u, 0xCE61E49Fu,
     0x5EDEF90Eu, 0x29D9C998u, 0xB0D09822u, 0xC7D7A8B4u, 0x59B33D17u, 0x2EB40D81u,
     0xB7BD5C3Bu, 0xC0BA6CADu, 0xEDB88320u, 0x9ABFB3B6u, 0x03B6E20Cu, 0x74B1D29Au,
     0xEAD54739u, 0x9DD277AFu, 0x04DB2615u, 0x73DC1683u, 0xE3630B12u, 0x94643B84u,
     0x0D6D6A3Eu, 0x7A6A5AA8u, 0xE40ECF0Bu, 0x9309FF9Du, 0x0A00AE27u, 0x7D079EB1u,
     0xF00F9344u, 0x8708A3D2u, 0x1E01F268u, 0x6906C2FEu, 0xF762575Du, 0x806567CBu,
     0x196C3671u, 0x6E6B06E7u, 0xFED41B76u, 0x89D32BE0u, 0x10DA7A5Au, 0x67DD4ACCu,
     0xF9B9DF6Fu, 0x8EBEEFF9u, 0x17B7BE43u, 0x60B08ED5u, 0xD6D6A3E8u, 0xA1D1937Eu,
     0x38D8C2C4u, 0x4FDFF252u, 0xD1BB67F1u, 0xA6BC5767u, 0x3FB506DDu, 0x48B2364Bu,
     0xD80D2BDAu, 0xAF0A1B4Cu, 0x36034AF6u, 0x41047A60u, 0xDF60EFC3u, 0xA867DF55u,
     0x316E8EEFu, 0x4669BE79u, 0xCB61B38Cu, 0xBC66831Au, 0x256FD2A0u, 0x5268E236u,
     0xCC0C7795u, 0xBB0B4703u, 0x220216B9u, 0x5505262Fu, 0xC5BA3BBEu, 0xB2BD0B28u,
     0x2BB45A92u, 0x5CB36A04u, 0xC2D7FFA7u, 0xB5D0CF31u, 0x2CD99E8Bu, 0x5BDEAE1Du,
     0x9B64C2B0u, 0xEC63F226u, 0x756AA39Cu, 0x026D930Au, 0x9C0906A9u, 0xEB0E363Fu,
     0x72076785u, 0x05005713u, 0x95BF4A82u, 0xE2B87A14u, 0x7BB12BAEu, 0x0CB61B38u,
     0x92D28E9Bu, 0xE5D5BE0Du, 0x7CDCEFB7u, 0x0BDBDF21u, 0x86D3D2D4u, 0xF1D4E242u,
     0x68DDB3F8u, 0x1FDA836Eu, 0x81BE16CDu, 0xF6B9265Bu, 0x6FB077E1u, 0x18B74777u,
     0x88085AE6u, 0xFF0F6A70u, 0x66063BCAu, 0x11010B5Cu, 0x8F659EFFu, 0xF862AE69u,
     0x616BFFD3u, 0x166CCF45u, 0xA00AE278u, 0xD70DD2EEu, 0x4E048354u, 0x3903B3C2u,
     0xA7672661u, 0xD06016F7u, 0x4969474Du, 0x3E6E77DBu, 0xAED16A4Au, 0xD9D65ADCu,
     0x40DF0B66u, 0x37D83BF0u, 0xA9BCAE53u, 0xDEBB9EC5u, 0x47B2CF7Fu, 0x30B5FFE9u,
     0xBDBDF21Cu, 0xCABAC28Au, 0x53B39330u, 0x24B4A3A6u, 0xBAD03605u, 0xCDD70693u,
     0x54DE5729u, 0x23D967BFu, 0xB3667A2Eu, 0xC4614AB8u, 0x5D681B02u, 0x2A6F2B94u,
     0xB40BBE37u, 0xC30C8EA1u, 0x5A05DF1Bu, 0x2D02EF8Du}
#if LITE_CRC_TABLES == 4
    ,
    {
     0x00000000u, 0x191B3141u, 0x32366282u, 0x2B2D53C3u, 0x646CC504u, 0x7D77F445u,
     0x565AA786u, 0x4F4196C7u, 0xC8D98A08u, 0xD1C2BB49u, 0xFAEFE88Au, 0xE3F4D9CBu,
     0xACB54F0Cu, 0xB5AE7E4Du, 0x9E832D8Eu, 0x87981CCFu, 0x4AC21251u, 0x53D92310u,
     0x78F470D3u, 0x61EF4192u, 0x2EAED755u, 0x37B5E614u, 0x1C98B5D7u, 0x05838496u,
     0x821B9859u, 0x9B00A918u, 0xB02DFADBu, 0xA936CB9Au, 0xE6775D5Du, 0xFF6C6C1Cu,
     0xD4413FDFu, 0xCD5A0E9Eu, 0x958424A2u, 0x8C9F15E3u, 0xA7B24620u, 0xBEA97761u,
     0xF1E8E1A6u, 0xE8F3D0E7u, 0xC3DE8324u, 0xDAC5B265u, 0x5D5DAEAAu, 0x44469FEBu,
     0x6F6BCC28u, 0x7670FD69u, 0x39316BAEu, 0x202A5AEFu, 0x0B07092Cu, 0x121C386Du,
     0xDF4636F3u, 0xC65D07B2u, 0xED705471u, 0xF46B6530u, 0xBB2AF3F7u, 0xA231C2B6u,
     0x891C9175u, 0x9007A034u, 0x179FBCFBu, 0x0E848DBAu, 0x25A9DE79u, 0x3CB2EF38u,
     0x73F379FFu, 0x6AE848BEu, 0x41C51B7Du, 0x58DE2A3Cu, 0xF0794F05u, 0xE9627E44u,
     0xC24F2D87u, 0xDB541CC6u, 0x94158A01u, 0x8D0EBB40u, 0xA623E883u, 0xBF38D9C2u,
     0x38A0C50Du, 0x21BBF44Cu, 0x0A96A78Fu, 0x138D96CEu, 0x5CCC0009u, 0x45D73148u,
     0x6EFA628Bu, 0x77E153CAu, 0xBABB5D54u, 0xA3A06C15u, 0x888D3FD6u, 0x91960E97u,
     0xDED79850u, 0xC7CCA911u, 0xECE1FAD2u, 0xF5FACB93u, 0x7262D75Cu, 0x6B79E61Du,
     0x4054B5DEu, 0x594F849Fu, 0x160E1258u, 0x0F152319u, 0x243870DAu, 0x3D23419Bu,
     0x65FD6BA7u, 0x7CE65AE6u, 0x57CB0925u, 0x4ED03864u, 0x0191AEA3u, 0x188A9FE2u,
     0x33A7CC21u, 0x2ABCFD60u, 0xAD24E1AFu, 0xB43FD0EEu, 0x9F12832Du, 0x8609B26Cu,
     0xC94824ABu, 0xD05315EAu, 0xFB7E4629u, 0xE2657768u, 0x2F3F79F6u, 0x362448B7u,
     0x1D091B74u, 0x04122A35u, 0x4B53BCF2u, 0x52488DB3u, 0x7965DE70u, 0x607EEF31u,
     0xE7E6F3FEu, 0xFEFDC2BFu, 0xD5D0917Cu, 0xCCCBA03Du, 0x838A36FAu, 0x9A9107BBu,
     0xB1BC5478u, 0xA8A76539u, 0x3B83984Bu, 0x2298A90Au, 0x09B5FAC9u, 0x10AECB88u,
     0x5FEF5D4Fu, 0x46F46C0Eu, 0x6DD93FCDu, 0x74C20E8Cu, 0xF35A1243u, 0xEA412302u,
     0xC16C70C1u, 0xD8774180u, 0x9736D747u, 0x8E2DE606u, 0xA500B5C5u, 0xBC1B8484u,
     0x71418A1Au, 0x685ABB5Bu, 0x4377E898u, 0x5A6CD9D9u, 0x152D4F1Eu, 0x0C367E5Fu,
     0x271B2D9Cu, 0x3E001CDDu, 0xB9980012u, 0xA0833153u, 0x8BAE6290u, 0x92B553D1u,
     0xDDF4C516u, 0xC4EFF457u, 0xEFC2A794u, 0xF6D996D5u, 0xAE07BCE9u, 0xB71C8DA8u,
     0x9C31DE6Bu, 0x852AEF2Au, 0xCA6B79EDu, 0xD37048ACu, 0xF85D1B6Fu, 0xE1462A2Eu,
     0x66DE36E1u, 0x7FC507A0u, 0x54E85463u, 0x4DF36522u, 0x02B2F3E5u, 0x1BA9C2A4u,
     0x30849167u, 0x299FA026u, 0xE4C5AEB8u, 0xFDDE9FF9u, 0xD6F3CC3Au, 0xCFE8FD7Bu,
     0x80A96BBCu, 0x99B25AFDu, 0xB29F093Eu, 0xAB84387Fu, 0x2C1C24B0u, 0x350715F1u,
     0x1E2A4632u, 0x07317773u, 0x4870E1B4u, 0x516BD0F5u, 0x7A468336u, 0x635DB277u,
     0xCBFAD74Eu, 0xD2E1E60Fu, 0xF9CCB5CCu, 0xE0D7848Du, 0xAF96124Au, 0xB68D230Bu,
     0x9DA070C8u, 0x84BB4189u, 0x03235D46u, 0x1A386C07u, 0x31153FC4u, 0x280E0E85u,
     0x674F9842u, 0x7E54A903u, 0x5579FAC0u, 0x4C62CB81u, 0x8138C51Fu, 0x9823F45Eu,
     0xB30EA79Du, 0xAA1596DCu, 0xE554001Bu, 0xFC4F315Au, 0xD7626299u, 0xCE7953D8u,
     0x49E14F17u, 0x50FA7E56u, 0x7BD72D95u, 0x62CC1CD4u, 0x2D8D8A13u, 0x3496BB52u,
     0x1FBBE891u, 0x06A0D9D0u, 0x5E7EF3ECu, 0x4765C2ADu, 0x6C48916Eu, 0x7553A02Fu,
     0x3A1236E8u, 0x230907A9u, 0x0824546Au, 0x113F652Bu, 0x96A779E4u, 0x8FBC48A5u,
     0xA4911B66u, 0xBD8A2A27u, 0xF2CBBCE0u, 0xEBD08DA1u, 0xC0FDDE62u, 0xD9E6EF23u,
     0x14BCE1BDu, 0x0DA7D0FCu, 0x268A833Fu, 0x3F91B27Eu, 0x70D024B9u, 0x69CB15F8u,
     0x42E6463Bu, 0x5BFD777Au, 0xDC656BB5u, 0xC57E5AF4u, 0xEE530937u, 0xF7483876u,
     0xB809AEB1u, 0xA1129FF0u, 0x8A3FCC33u, 0x9324FD72u},
    {
     0x00000000u, 0x01C26A37u, 0x0384D46Eu, 0x0246BE59u, 0x0709A8DCu, 0x06CBC2EBu,
     0x048D7CB2u, 0x054F1685u, 0x0E1351B8u, 0x0FD13B8Fu, 0x0D9785D6u, 0x0C55EFE1u,
     0x091AF964u, 0x08D89353u, 0x0A9E2D0Au, 0x0B5C473Du, 0x1C26A370u, 0x1DE4C947u,
     0x1FA2771Eu, 0x1E601D29u, 0x1B2F0BACu, 0x1AED619Bu, 0x18ABDFC2u, 0x1969B5F5u,
     0x1235F2C8u, 0x13F798FFu, 0x11B126A6u, 0x10734C91u, 0x153C5A14u, 0x14FE3023u,
     0x16B88E7Au, 0x177AE44Du, 0x384D46E0u, 0x398F2CD7u, 0x3BC9928Eu, 0x3A0BF8B9u,
     0x3F44EE3Cu, 0x3E86840Bu, 0x3CC03A52u, 0x3D025065u, 0x365E1758u, 0x379C7D6Fu,
     0x35DAC336u, 0x3418A901u, 0x3157BF84u, 0x3095D5B3u, 0x32D36BEAu, 0x331101DDu,
     0x246BE590u, 0x25A98FA7u, 0x27EF31FEu, 0x262D5BC9u, 0x23624D4Cu, 0x22A0277Bu,
     0x20E69922u, 0x2124F315u, 0x2A78B428u, 0x2BBADE1Fu, 0x29FC6046u, 0x283E0A71u,
     0x2D711CF4u, 0x2CB376C3u, 0x2EF5C89Au, 0x2F37A2ADu, 0x709A8DC0u, 0x7158E7F7u,
     0x731E59AEu, 0x72DC3399u, 0x7793251Cu, 0x76514F2Bu, 0x7417F172u, 0x75D59B45u,
     0x7E89DC78u, 0x7F4BB64Fu, 0x7D0D0816u, 0x7CCF6221u, 0x798074A4u, 0x78421E93u,
     0x7A04A0CAu, 0x7BC6CAFDu, 0x6CBC2EB0u, 0x6D7E4487u, 0x6F38FADEu, 0x6EFA90E9u,
     0x6BB5866Cu, 0x6A77EC5Bu, 0x68315202u, 0x69F33835u, 0x62AF7F08u, 0x636D153Fu,
     0x612BAB66u, 0x60E9C151u, 0x65A6D7D4u, 0x6464BDE3u, 0x662203BAu, 0x67E0698Du,
     0x48D7CB20u, 0x4915A117u, 0x4B531F4Eu, 0x4A917579u, 0x4FDE63FCu, 0x4E1C09CBu,
     0x4C5AB792u, 0x4D98DDA5u, 0x46C49A98u, 0x4706F0AFu, 0x45404EF6u, 0x448224C1u,
     0x41CD3244u, 0x400F5873u, 0x4249E62Au, 0x438B8C1Du, 0x54F16850u, 0x55330267u,
     0x5775BC3Eu, 0x56B7D609u, 0x53F8C08Cu, 0x523AAABBu, 0x507C14E2u, 0x51BE7ED5u,
     0x5AE239E8u, 0x5B2053DFu, 0x5966ED86u, 0x58A487B1u, 0x5DEB9134u, 0x5C29FB03u,
     0x5E6F455Au, 0x5FAD2F6Du, 0xE1351B80u, 0xE0F771B7u, 0xE2B1CFEEu, 0xE373A5D9u,
     0xE63CB35Cu, 0xE7FED96Bu, 0xE5B86732u, 0xE47A0D05u, 0xEF264A38u, 0xEEE4200Fu,
     0xECA29E56u, 0xED60F461u, 0xE82FE2E4u, 0xE9ED88D3u, 0xEBAB368Au, 0xEA695CBDu,
     0xFD13B8F0u, 0xFCD1D2C7u, 0xFE976C9Eu, 0xFF5506A9u, 0xFA1A102Cu, 0xFBD87A1Bu,
     0xF99EC442u, 0xF85CAE75u, 0xF300E948u, 0xF2C2837Fu, 0xF0843D26u, 0xF1465711u,
     0xF4094194u, 0xF5CB2BA3u, 0xF78D95FAu, 0xF64FFFCDu, 0xD9785D60u, 0xD8BA3757u,
     0xDAFC890Eu, 0xDB3EE339u, 0xDE71F5BCu, 0xDFB39F8Bu, 0xDDF521D2u, 0xDC374BE5u,
     0xD76B0CD8u, 0xD6A966EFu, 0xD4EFD8B6u, 0xD52DB281u, 0xD062A404u, 0xD1A0CE33u,
     0xD3E6706Au, 0xD2241A5Du, 0xC55EFE10u, 0xC49C9427u, 0xC6DA2A7Eu, 0xC7184049u,
     0xC25756CCu, 0xC3953CFBu, 0xC1D382A2u, 0xC011E895u, 0xCB4DAFA8u, 0xCA8FC59Fu,
     0xC8C97BC6u, 0xC90B11F1u, 0xCC440774u, 0xCD866D43u, 0xCFC0D31Au, 0xCE02B92Du,
     0x91AF9640u, 0x906DFC77u, 0x922B422Eu, 0x93E92819u, 0x96A63E9Cu, 0x976454ABu,
     0x9522EAF2u, 0x94E080C5u, 0x9FBCC7F8u, 0x9E7EADCFu, 0x9C381396u, 0x9DFA79A1u,
     0x98B56F24u, 0x99770513u, 0x9B31BB4Au, 0x9AF3D17Du, 0x8D893530u, 0x8C4B5F07u,
     0x8E0DE15Eu, 0x8FCF8B69u, 0x8A809DECu, 0x8B42F7DBu, 0x89044982u, 0x88C623B5u,
     0x839A6488u, 0x82580EBFu, 0x801EB0E6u, 0x81DCDAD1u, 0x8493CC54u, 0x8551A663u,
     0x8717183Au, 0x86D5720Du, 0xA9E2D0A0u, 0xA820BA97u, 0xAA6604CEu, 0xABA46EF9u,
     0xAEEB787Cu, 0xAF29124Bu, 0xAD6FAC12u, 0xACADC625u, 0xA7F18118u, 0xA633EB2Fu,
     0xA4755576u, 0xA5B73F41u, 0xA0F829C4u, 0xA13A43F3u, 0xA37CFDAAu, 0xA2BE979Du,
     0xB5C473D0u, 0xB40619E7u, 0xB640A7BEu, 0xB782CD89u, 0xB2CDDB0Cu, 0xB30FB13Bu,
     0xB1490F62u, 0xB08B6555u, 0xBBD72268u, 0xBA15485Fu, 0xB853F606u, 0xB9919C31u,
     0xBCDE8AB4u, 0xBD1CE083u, 0xBF5A5EDAu, 0xBE9834EDu},
    {
     0x00000000u, 0xB8BC6765u, 0xAA09C88Bu, 0x12B5AFEEu, 0x8F629757u, 0x37DEF032u,
     0x256B5FDCu, 0x9DD738B9u, 0xC5B428EFu, 0x7D084F8Au, 0x6FBDE064u, 0xD7018701u,
     0x4AD6BFB8u, 0xF26AD8DDu, 0xE0DF7733u, 0x58631056u, 0x5019579Fu, 0xE8A530FAu,
     0xFA109F14u, 0x42ACF871u, 0xDF7BC0C8u, 0x67C7A7ADu, 0x75720843u, 0xCDCE6F26u,
     0x95AD7F70u, 0x2D111815u, 0x3FA4B7FBu, 0x8718D09Eu, 0x1ACFE827u, 0xA2738F42u,
     0xB0C620ACu, 0x087A47C9u, 0xA032AF3Eu, 0x188EC85Bu, 0x0A3B67B5u, 0xB28700D0u,
     0x2F503869u, 0x97EC5F0Cu, 0x8559F0E2u, 0x3DE59787u, 0x658687D1u, 0xDD3AE0B4u,
     0xCF8F4F5Au, 0x7733283Fu, 0xEAE41086u, 0x525877E3u, 0x40EDD80Du, 0xF851BF68u,
     0xF02BF8A1u, 0x48979FC4u, 0x5A22302Au, 0xE29E574Fu, 0x7F496FF6u, 0xC7F50893u,
     0xD540A77Du, 0x6DFCC018u, 0x359FD04Eu, 0x8D23B72Bu, 0x9F9618C5u, 0x272A7FA0u,
     0xBAFD4719u, 0x0241207Cu, 0x10F48F92u, 0xA848E8F7u, 0x9B14583Du, 0x23A83F58u,
     0x311D90B6u, 0x89A1F7D3u, 0x1476CF6Au, 0xACCAA80Fu, 0xBE7F07E1u, 0x06C36084u,
     0x5EA070D2u, 0xE61C17B7u, 0xF4A9B859u, 0x4C15DF3Cu, 0xD1C2E785u, 0x697E80E0u,
     0x7BCB2F0Eu, 0xC377486Bu, 0xCB0D0FA2u, 0x73B168C7u, 0x6104C729u, 0xD9B8A04Cu,
     0x446F98F5u, 0xFCD3FF90u, 0xEE66507Eu, 0x56DA371Bu, 0x0EB9274Du, 0xB6054028u,
     0xA4B0EFC6u, 0x1C0C88A3u, 0x81DBB01Au, 0x3967D77Fu, 0x2BD27891u, 0x936E1FF4u,
     0x3B26F703u, 0x839A9066u, 0x912F3F88u, 0x299358EDu, 0xB4446054u, 0x0CF80731u,
     0x1E4DA8DFu, 0xA6F1CFBAu, 0xFE92DFECu, 0x462EB889u, 0x549B1767u, 0xEC277002u,
     0x71F048BBu, 0xC94C2FDEu, 0xDBF98030u, 0x6345E755u, 0x6B3FA09Cu, 0xD383C7F9u,
     0xC1366817u, 0x798A0F72u, 0xE45D37CBu, 0x5CE150AEu, 0x4E54FF40u, 0xF6E89825u,
     0xAE8B8873u, 0x1637EF16u, 0x048240F8u, 0xBC3E279Du, 0x21E91F24u, 0x99557841u,
     0x8BE0D7AFu, 0x335CB0CAu, 0xED59B63Bu, 0x55E5D15Eu, 0x47507EB0u, 0xFFEC19D5u,
     0x623B216Cu, 0xDA874609u, 0xC832E9E7u, 0x708E8E82u, 0x28ED9ED4u, 0x9051F9B1u,
     0x82E4565Fu, 0x3A58313Au, 0xA78F0983u, 0x1F336EE6u, 0x0D86C108u, 0xB53AA66Du,
     0xBD40E1A4u, 0x05FC86C1u, 0x1749292Fu, 0xAFF54E4Au, 0x322276F3u, 0x8A9E1196u,
     0x982BBE78u, 0x2097D91Du, 0x78F4C94Bu, 0xC048AE2Eu, 0xD2FD01C0u, 0x6A4166A5u,
     0xF7965E1Cu, 0x4F2A3979u, 0x5D9F9697u, 0xE523F1F2u, 0x4D6B1905u, 0xF5D77E60u,
     0xE762D18Eu, 0x5FDEB6EBu, 0xC2098E52u, 0x7AB5E937u, 0x680046D9u, 0xD0BC21BCu,
     0x88DF31EAu, 0x3063568Fu, 0x22D6F961u, 0x9A6A9E04u, 0x07BDA6BDu, 0xBF01C1D8u,
     0xADB46E36u, 0x15080953u, 0x1D724E9Au, 0xA5CE29FFu, 0xB77B8611u, 0x0FC7E174u,
     0x9210D9CDu, 0x2AACBEA8u, 0x38191146u, 0x80A57623u, 0xD8C66675u, 0x607A0110u,
     0x72CFAEFEu, 0xCA73C99Bu, 0x57A4F122u, 0xEF189647u, 0xFDAD39A9u, 0x45115ECCu,
     0x764DEE06u, 0xCEF18963u, 0xDC44268Du, 0x64F841E8u, 0xF92F7951u, 0x41931E34u,
     0x5326B1DAu, 0xEB9AD6BFu, 0xB3F9C6E9u, 0x0B45A18Cu, 0x19F00E62u, 0xA14C6907u,
     0x3C9B51BEu, 0x842736DBu, 0x96929935u, 0x2E2EFE50u, 0x2654B999u, 0x9EE8DEFCu,
     0x8C5D7112u, 0x34E11677u, 0xA9362ECEu, 0x118A49ABu, 0x033FE645u, 0xBB838120u,
     0xE3E09176u, 0x5B5CF613u, 0x49E959FDu, 0xF1553E98u, 0x6C820621u, 0xD43E6144u,
     0xC68BCEAAu, 0x7E37A9CFu, 0xD67F4138u, 0x6EC3265Du, 0x7C7689B3u, 0xC4CAEED6u,
     0x591DD66Fu, 0xE1A1B10Au, 0xF3141EE4u, 0x4BA87981u, 0x13CB69D7u, 0xAB770EB2u,
     0xB9C2A15Cu, 0x017EC639u, 0x9CA9FE80u, 0x241599E5u, 0x36A0360Bu, 0x8E1C516Eu,
     0x866616A7u, 0x3EDA71C2u, 0x2C6FDE2Cu, 0x94D3B949u, 0x090481F0u, 0xB1B8E695u,
     0xA30D497Bu, 0x1BB12E1Eu, 0x43D23E48u, 0xFB6E592Du, 0xE9DBF6C3u, 0x516791A6u,
     0xCCB0A91Fu, 0x740CCE7Au, 0x66B96194u, 0xDE0506F1u}
#endif
};

static uint32_t crc32(const uint8_t *p, uint32_t n)
{
    uint32_t crc = 0xFFFFFFFFu;
    uint32_t i = 0;
    for (; i + 4u <= n; i += 4u) {
#if LITE_CRC_TABLES == 4
        uint32_t w;
        __builtin_memcpy(&w, p + i, 4);
        crc ^= w;
        crc = CRC_T[3][crc & 0xFFu] ^ CRC_T[2][(crc >> 8) & 0xFFu] ^
              CRC_T[1][(crc >> 16) & 0xFFu] ^ CRC_T[0][crc >> 24];
#else
        crc = CRC_T[0][(crc ^ p[i]) & 0xFFu] ^ (crc >> 8);
        crc = CRC_T[0][(crc ^ p[i + 1u]) & 0xFFu] ^ (crc >> 8);
        crc = CRC_T[0][(crc ^ p[i + 2u]) & 0xFFu] ^ (crc >> 8);
        crc = CRC_T[0][(crc ^ p[i + 3u]) & 0xFFu] ^ (crc >> 8);
#endif
    }
    for (; i < n; i++) {
        crc = CRC_T[0][(crc ^ p[i]) & 0xFFu] ^ (crc >> 8);
    }
    return ~crc;
}

#else
#error "LITE_CRC_TABLES must be 0, 1, or 4"
#endif

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
    if (kind == 4u) {
        return ORBIT_REC;
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
        if (kind < 1u || kind > 4u) {
            continue; /* unknown kind: queries that need it report unsupported */
        }
        if (degree > MAX_DEGREE || count == 0u || (kind == 3u && count < 2u) ||
            (kind == 4u && degree != 0u)) {
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
    /* TIME: finite numbers, and entries in strictly ascending order of time
     * base, then host_start, which is what lets lite_host2et search. Two
     * pieces of one base with the same start are refused with the rest. */
    for (i = 0; i < G.sec[SEC_TIME].count; i++) {
        const uint8_t *e = b + G.sec[SEC_TIME].off + i * TIME_ENTRY;
        if (!finite64(rdf64(e + 8)) || !finite64(rdf64(e + 16)) || !finite64(rdf64(e + 24))) {
            return 0;
        }
        if (i > 0u) {
            uint32_t base = rd16(e), prev = rd16(e - TIME_ENTRY);
            if (base < prev || (base == prev && !(rdf64(e + 8) > rdf64(e - TIME_ENTRY + 8)))) {
                return 0;
            }
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
    uint32_t base;
    double host;
    const uint8_t *lo, *hi, *tab;
    if (!G.ready) {
        return LITE_BAD_BLOB;
    }
    if (et == 0 || useconds >= 1000000u) {
        return LITE_BAD_ARG;
    }
    host = (double)seconds + (double)useconds * 1.0e-6;
    base = (uint16_t)time_base;
    /* lite_init has checked that the entries ascend by time base, then by
     * host_start, with no two alike, so the entries that sort at or before
     * (base, host) are a prefix of the table. The binary search below finds
     * where that prefix ends, at lo; the entry just before lo is the piece of
     * this base with the latest host_start not after the reading, if the
     * prefix is not empty and its last entry has this base. That is the same
     * piece a scan of every entry selects. A blob is at most 1 MiB, so the
     * table has fewer than 2^15 entries and the search takes at most 15
     * probes. The written form (pointers, the base tested for equality
     * first) is the cheapest of several measured under SpaceWasm. */
    tab = G.b + G.sec[SEC_TIME].off;
    lo = tab;
    hi = tab + G.sec[SEC_TIME].count * TIME_ENTRY;
    while (lo < hi) {
        const uint8_t *mid = lo + (((uint32_t)(hi - lo) >> 1) & ~(TIME_ENTRY - 1u));
        uint32_t b = rd16(mid);
        if (b == base ? rdf64(mid + 8) <= host : b < base) {
            lo = mid + TIME_ENTRY;
        } else {
            hi = mid;
        }
    }
    if (lo == tab || rd16(lo - TIME_ENTRY) != base) {
        return LITE_OUT_OF_COVERAGE;
    }
    *et = rdf64(lo - 16) + rdf64(lo - 8) * (host - rdf64(lo - 24));
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

/* Kind 4: one record of the compact orbit model at tau seconds from the
 * record's mid epoch. The record holds six elements (semi-major axis, the
 * eccentricity vector in the orbit plane measured from the ascending node,
 * inclination, node, and mean argument of latitude), their rates, quadratic
 * terms for the mean argument and the eccentricity vector, and 19
 * coefficients of displacements in kilometers: radial, along the track, and
 * across it, each with a cosine and a sine term in one, two, and three times
 * the argument of latitude, plus a constant across the track. It is the idea
 * of the GPS broadcast ephemeris (elements, rates, and harmonic corrections),
 * regular at zero eccentricity and with enough harmonics for an eccentric
 * orbit. The velocity is the exact time derivative of the position formula,
 * so the record needs no gravitational parameter. Ellipses only: an
 * eccentricity over 0.9, a semi-major axis that is not positive, a
 * coefficient that is not a number, or an angle too large for the
 * trigonometry returns LITE_UNSUPPORTED. Every divisor below is bounded away
 * from zero by those checks, and the Kepler loop is capped. */
static int sincos_near(double x, double *s, double *c)
{
    double ax = lite_fabs(x);
    if (ax <= 0.78) { /* inside the kernel's range: no reduction */
        sincos_kernel(x, s, c);
        return 0;
    }
    if (ax <= 1.56) { /* half the angle is inside it: double the angle */
        double hs, hc;
        sincos_kernel(0.5 * x, &hs, &hc);
        *s = 2.0 * hs * hc;
        *c = 1.0 - 2.0 * hs * hs;
        return 0;
    }
    return lite_sincos(x, s, c);
}

/* Kepler's equation for kind 4. With ka = ex sin lam - ey cos lam and
 * kb = ex cos lam + ey sin lam, the offset G = F - lam of the eccentric
 * argument of latitude from the mean one is the root of
 * f(G) = G - ka cos G - kb sin G, and |G| is at most the eccentricity. The
 * higher derivatives of f come free with it (the second is
 * ka cos G + kb sin G = G - f, and the third is kb cos G - ka sin G, which is
 * one minus the first), so each step is the fourth-order one of Danby (1987):
 * a Newton step, refined by Halley's formula, refined once more with the third
 * derivative. The first step starts at G = 0, where the sine and cosine are
 * known, and costs no trigonometry. A step of at most 1e-4 radians is the
 * last: at fourth order what it leaves is below rounding, and so small a step
 * turns the sine and cosine by a third-order series without another
 * evaluation. Writes sin G and cos G and returns the number of steps taken, or
 * 0 if the cap is reached or an iterate leaves the range of the trigonometry
 * (which a record within the eccentricity limit does not do: three steps is
 * the most a scan of the whole accepted range finds; see
 * docs/orbit-segment.md). */
static int kepler_offset(double ka, double kb, double *sg, double *cg)
{
    double g = 0.0, s = 0.0, c = 1.0;
    double f2 = ka, f3 = kb; /* the second and third derivatives at G = 0 */
    int it;
    for (it = 1; it <= ORBIT_KEPLER_MAX; it++) {
        double f = g - f2;
        double f1 = 1.0 - f3;
        double d = f / f1;
        d = f / (f1 - 0.5 * d * f2);
        d = f / (f1 - 0.5 * d * f2 + d * d * f3 * (1.0 / 6.0));
        g -= d;
        if (lite_fabs(d) <= 1.0e-4) {
            double h = 0.5 * d * d;
            double t = d * (1.0 - h * (1.0 / 3.0));
            *sg = s * (1.0 - h) - c * t;
            *cg = c * (1.0 - h) + s * t;
            return it;
        }
        if (sincos_near(g, &s, &c)) {
            return 0;
        }
        f2 = ka * c + kb * s;
        f3 = kb * c - ka * s;
    }
    return 0;
}

/* Three harmonics of the argument of latitude for one displacement: q holds
 * the cosine and sine coefficients of u, 2u, and 3u as 32-bit floats, h the
 * cosines and sines themselves. Returns the sum and writes its derivative with
 * respect to u. */
static double orbit_harmonics(const uint8_t *q, const double *h, double *der)
{
    double c1 = rdf32(q), s1 = rdf32(q + 4), c2 = rdf32(q + 8);
    double s2 = rdf32(q + 12), c3 = rdf32(q + 16), s3 = rdf32(q + 20);
    *der = (s1 * h[0] - c1 * h[1]) + 2.0 * (s2 * h[2] - c2 * h[3]) + 3.0 * (s3 * h[4] - c3 * h[5]);
    return (c1 * h[0] + s1 * h[1]) + (c2 * h[2] + s2 * h[3]) + (c3 * h[4] + s3 * h[5]);
}

static int eval_orbit(const uint8_t *p, double tau, double *s)
{
    double a1 = rdf32(p + 56), ex1 = rdf32(p + 60), ey1 = rdf32(p + 64);
    double inc1 = rdf32(p + 68), node1 = rdf32(p + 72), lam2 = rdf32(p + 76);
    double lam1 = rdf64(p + 48);
    double eq = rdf32(p + 80) * tau;
    double a = rdf64(p) + a1 * tau;
    double ex = rdf64(p + 8) + (ex1 - eq * ey1) * tau;
    double ey = rdf64(p + 16) + (ey1 + eq * ex1) * tau;
    double inc = rdf64(p + 24) + inc1 * tau;
    double node = rdf64(p + 32) + node1 * tau;
    double lam = rdf64(p + 40) + (lam1 + lam2 * tau) * tau;
    double lam_dot = lam1 + 2.0 * lam2 * tau;
    double e2 = ex * ex + ey * ey;
    double exd, eyd, sl, cl, sg, cg;
    double sf, cf, rho, f_dot, w, beta, beta_dot, dd, dd_dot;
    double xn, yn, xn_dot, yn_dot, r, r_dot, u_dot, h[6];
    double dr, dt, dw, dr_u, dt_u, dw_u, rc, rc_dot, dt_dot, dw_dot;
    double xp, yp, xp_dot, yp_dot, si, ci, so, co, q, z, q_dot, x, y;
    if (!(a > 0.0) || !finite64(a) || !(e2 <= ORBIT_E2_MAX)) {
        return LITE_UNSUPPORTED;
    }
    /* the rates of the eccentricity vector at tau: its velocity has turned */
    exd = ex1 - 2.0 * eq * ey1;
    eyd = ey1 + 2.0 * eq * ex1;
    if (lite_sincos(lam, &sl, &cl)) {
        return LITE_UNSUPPORTED;
    }
    /* Kepler's equation, F - ex sin F + ey cos F = lam, for the offset F - lam */
    if (!kepler_offset(ex * sl - ey * cl, ex * cl + ey * sl, &sg, &cg)) {
        return LITE_UNSUPPORTED;
    }
    sf = sl * cg + cl * sg;
    cf = cl * cg - sl * sg;
    rho = 1.0 - (ex * cf + ey * sf);
    f_dot = (lam_dot + (exd * sf - eyd * cf)) / rho;
    /* position in the orbit plane, in units of a, x toward the node */
    w = lite_sqrt(1.0 - e2);
    beta = 1.0 / (1.0 + w);
    beta_dot = ((ex * exd + ey * eyd) * beta * beta) / w;
    dd = ey * cf - ex * sf;
    dd_dot = (eyd * cf - exd * sf) - (ey * sf + ex * cf) * f_dot;
    xn = (cf - ex) - beta * ey * dd;
    yn = (sf - ey) + beta * ex * dd;
    xn_dot = (-sf * f_dot - exd) - ((beta_dot * ey + beta * eyd) * dd + beta * ey * dd_dot);
    yn_dot = (cf * f_dot - eyd) + ((beta_dot * ex + beta * exd) * dd + beta * ex * dd_dot);
    r = a * rho;
    r_dot = a1 * rho - a * ((exd * cf + eyd * sf) + dd * f_dot);
    /* argument of latitude u: its cosine and sine, and those of 2u and 3u */
    h[0] = xn / rho;
    h[1] = yn / rho;
    u_dot = (xn * yn_dot - yn * xn_dot) / (rho * rho);
    h[2] = h[0] * h[0] - h[1] * h[1];
    h[3] = 2.0 * h[0] * h[1];
    h[4] = h[2] * h[0] - h[3] * h[1];
    h[5] = h[3] * h[0] + h[2] * h[1];
    /* displacements in kilometers: radial, along the track, and across it */
    dr = orbit_harmonics(p + 84, h, &dr_u);
    dt = orbit_harmonics(p + 108, h, &dt_u);
    dw = orbit_harmonics(p + 132, h, &dw_u) + rdf32(p + 156);
    if (!finite64(dr + dt + dw)) { /* a coefficient that is not a number */
        return LITE_UNSUPPORTED;
    }
    if (lite_sincos(inc, &si, &ci) || lite_sincos(node, &so, &co)) {
        return LITE_UNSUPPORTED;
    }
    rc = r + dr;
    rc_dot = r_dot + dr_u * u_dot;
    dt_dot = dt_u * u_dot;
    dw_dot = dw_u * u_dot;
    xp = rc * h[0] - dt * h[1];
    yp = rc * h[1] + dt * h[0];
    xp_dot = (rc_dot * h[0] - dt_dot * h[1]) - yp * u_dot;
    yp_dot = (rc_dot * h[1] + dt_dot * h[0]) + xp * u_dot;
    /* tilt by the inclination about the node line, then turn by the node */
    q = yp * ci - dw * si;
    z = yp * si + dw * ci;
    q_dot = (yp_dot * ci - dw_dot * si) - z * inc1;
    x = xp * co - q * so;
    y = xp * so + q * co;
    s[0] = x;
    s[1] = y;
    s[2] = z;
    s[3] = (xp_dot * co - q_dot * so) - y * node1;
    s[4] = (xp_dot * so + q_dot * co) + x * node1;
    s[5] = (yp_dot * si + dw_dot * ci) + q * inc1;
    return LITE_OK;
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
    if (kind == 4u) {
        if (!grid_locate(t, t0, dt, count, &k, &x)) {
            return LITE_OUT_OF_COVERAGE;
        }
        return eval_orbit(data + (uint64_t)k * ORBIT_REC, 0.5 * dt * x, s);
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

/* ---- sub-points and occultation ----------------------------------------- */

#define NEAR_ITER_MAX 24

/* Reads the three radii of a body. Returns 0 when the blob gives none (BODY
 * flag bit 0 clear) or any of them is not positive. */
static int body_radii(int idx, double *r)
{
    int k;
    if ((body_flags(idx) & 1u) == 0u) {
        return 0;
    }
    for (k = 0; k < 3; k++) {
        r[k] = rdf64(body_at(idx) + 8 + 8u * (uint32_t)k);
        if (!(r[k] > 0.0)) {
            return 0;
        }
    }
    return 1;
}

/* Nearest point q on the ellipsoid with semi-axes r to a point p on or outside
 * it, and the distance h between them; all in the body-fixed frame. Returns 0
 * on success, 1 when p is inside the ellipsoid, 2 when the arithmetic left the
 * finite range.
 *
 * The nearest point is q[k] = r[k]^2 p[k] / (r[k]^2 + t), where t >= 0 is the
 * root of F(t) = sum (r[k] p[k] / (r[k]^2 + t))^2 - 1. F is convex and
 * decreasing for t >= 0, so Newton's method started at a point where F >= 0
 * climbs to the root without passing it. Two starting points are tried. The
 * first, max over k of r[k] (|p[k]| - r[k]), never lies beyond the root and
 * leaves F <= 2, which bounds the work. The second, rmin (|p| - rmin), is the
 * exact root for a sphere and close to it for a distant observer of any
 * shape; it is used when F there is not negative beyond rounding. The loop
 * stops when F is at the rounding level of its own evaluation (1e-15) or t
 * stops rising. Four million random cases with axis ratios up to a million
 * needed at most 12 iterations; a case that reaches NEAR_ITER_MAX is reported
 * as status 2 rather than answered loosely. */
static int near_point(const double *r, const double *p, double *q, double *h)
{
    double a2[3], w[3], t = 0.0, tc, f, g, pn, rmin, d2;
    int k, it;
    f = -1.0;
    for (k = 0; k < 3; k++) {
        double u = p[k] / r[k];
        double lo = r[k] * (lite_fabs(p[k]) - r[k]);
        f += u * u;
        a2[k] = r[k] * r[k];
        w[k] = r[k] * p[k];
        if (lo > t) {
            t = lo;
        }
    }
    if (!finite64(f)) {
        return 2;
    }
    if (f < 0.0) {
        return 1;
    }
    rmin = r[0] < r[1] ? r[0] : r[1];
    rmin = rmin < r[2] ? rmin : r[2];
    pn = norm3(p);
    tc = rmin * (pn - rmin);
    if (tc > t) {
        f = -1.0;
        for (k = 0; k < 3; k++) {
            double u = w[k] / (a2[k] + tc);
            f += u * u;
        }
        if (f >= -1.0e-15) {
            t = tc;
        }
    }
    for (it = 0; it < NEAR_ITER_MAX; it++) {
        double tn;
        f = -1.0;
        g = 0.0;
        for (k = 0; k < 3; k++) {
            double s = a2[k] + t;
            double u = w[k] / s;
            f += u * u;
            g += u * u / s;
        }
        if (!(f > 1.0e-15) || !(g > 0.0)) {
            break; /* converged, or not a number */
        }
        tn = t + f / (2.0 * g);
        if (!(tn > t)) {
            break;
        }
        t = tn;
    }
    if (it == NEAR_ITER_MAX) {
        return 2;
    }
    d2 = 0.0;
    for (k = 0; k < 3; k++) {
        double s = a2[k] + t;
        double u = p[k] / s;
        q[k] = a2[k] * u;
        d2 += u * u;
    }
    *h = t * lite_sqrt(d2);
    if (!finite64(q[0]) || !finite64(q[1]) || !finite64(q[2]) || !finite64(*h)) {
        return 2;
    }
    return 0;
}

int lite_sub_point(int32_t body, int32_t observer, double et, double *lon, double *lat, double *alt)
{
    double rot[9], s[6], r[3], p[3], q[3], h = 0.0;
    int bi, oi, st, k;
    if (!G.ready) {
        return LITE_BAD_BLOB;
    }
    if (lon == 0 || lat == 0 || alt == 0 || !finite64(et)) {
        return LITE_BAD_ARG;
    }
    bi = body_index(body);
    oi = body_index(observer);
    if (bi < 0 || oi < 0) {
        return LITE_NO_PATH;
    }
    if (!body_radii(bi, r)) {
        return LITE_UNSUPPORTED;
    }
    st = lite_orient(body, et, rot);
    if (st != LITE_OK) {
        return st;
    }
    st = state_rel(oi, bi, et, 1, s, 0);
    if (st != LITE_OK) {
        return st;
    }
    for (k = 0; k < 3; k++) {
        p[k] = rot[3 * k] * s[0] + rot[3 * k + 1] * s[1] + rot[3 * k + 2] * s[2];
    }
    st = near_point(r, p, q, &h);
    if (st != 0) {
        return st == 1 ? LITE_BAD_ARG : LITE_UNSUPPORTED;
    }
    *lon = lite_atan2(q[1], q[0]);
    *lat = lite_atan2(q[2], lite_sqrt(q[0] * q[0] + q[1] * q[1]));
    *alt = h;
    return LITE_OK;
}

int lite_occulted(int32_t target, int32_t by, int32_t observer, double et, int32_t *code)
{
    double rt[3], rf[3], b[6], f[6], c[3];
    double rb, rfm, pb, pf, ab, af, sep;
    int ti, fi, oi, st;
    if (!G.ready) {
        return LITE_BAD_BLOB;
    }
    if (code == 0 || !finite64(et)) {
        return LITE_BAD_ARG;
    }
    ti = body_index(target);
    fi = body_index(by);
    oi = body_index(observer);
    if (ti < 0 || fi < 0 || oi < 0) {
        return LITE_NO_PATH;
    }
    if (ti == fi) {
        return LITE_BAD_ARG;
    }
    if (!body_radii(ti, rt) || !body_radii(fi, rf)) {
        return LITE_UNSUPPORTED;
    }
    st = state_rel(ti, oi, et, 1, b, 0);
    if (st != LITE_OK) {
        return st;
    }
    st = state_rel(fi, oi, et, 1, f, 0);
    if (st != LITE_OK) {
        return st;
    }
    /* Each body is a sphere of its mean radius. pb and pf are the squared
     * lengths of the tangents from the observer to the two spheres. */
    rb = (rt[0] + rt[1] + rt[2]) / 3.0;
    rfm = (rf[0] + rf[1] + rf[2]) / 3.0;
    pb = (b[0] * b[0] + b[1] * b[1] + b[2] * b[2]) - rb * rb;
    pf = (f[0] * f[0] + f[1] * f[1] + f[2] * f[2]) - rfm * rfm;
    if (!finite64(pb) || !finite64(pf)) {
        return LITE_UNSUPPORTED;
    }
    if (!(pb > 0.0) || !(pf > 0.0)) {
        return LITE_BAD_ARG; /* the observer is on or inside one of the spheres */
    }
    /* The tangent lengths differ by the observer's distance from the plane
     * that separates two disjoint spheres, so the shorter tangent belongs to
     * the sphere every shared line of sight meets first. */
    if (!(pf < pb)) {
        *code = LITE_OCC_NONE;
        return LITE_OK;
    }
    ab = lite_atan2(rb, lite_sqrt(pb));
    af = lite_atan2(rfm, lite_sqrt(pf));
    c[0] = f[1] * b[2] - f[2] * b[1];
    c[1] = f[2] * b[0] - f[0] * b[2];
    c[2] = f[0] * b[1] - f[1] * b[0];
    sep = lite_atan2(norm3(c), f[0] * b[0] + f[1] * b[1] + f[2] * b[2]);
    if (!finite64(sep)) {
        return LITE_UNSUPPORTED;
    }
    if (!(sep < af + ab)) {
        *code = LITE_OCC_NONE;
    } else if (af >= ab && sep <= af - ab) {
        *code = LITE_OCC_FULL;
    } else if (ab > af && sep <= ab - af) {
        *code = LITE_OCC_ANNULAR;
    } else {
        *code = LITE_OCC_PARTIAL;
    }
    return LITE_OK;
}
