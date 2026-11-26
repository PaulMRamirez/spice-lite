/*
 * Native test driver for spice-lite. Two modes:
 *
 *   driver run <blob>            reads queries on stdin, prints one result
 *                                line per query (the same text the WebAssembly
 *                                harness prints, so outputs compare byte for
 *                                byte across hosts)
 *   driver fuzz <blob> <n> <seed>  corrupts copies of the blob n times and
 *                                runs a fixed battery of calls on each; meant
 *                                to run under the sanitizers. Some copies
 *                                have only their TIME section rearranged or
 *                                overwritten, and on every copy the library
 *                                accepts, lite_host2et is compared with a
 *                                scan of every TIME entry
 *
 * Doubles travel as 16 hexadecimal digits of their bit pattern, so nothing is
 * lost or rounded in transit. This file is test code and uses libc freely.
 */
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "spice_lite.h"

static double from_hex(const char *s)
{
    uint64_t u = strtoull(s, 0, 16);
    double d;
    memcpy(&d, &u, 8);
    return d;
}

static void put(double d)
{
    uint64_t u;
    memcpy(&u, &d, 8);
    printf(" %016" PRIx64, u);
}

static uint8_t *load(const char *path, uint32_t *len)
{
    FILE *f = fopen(path, "rb");
    long n;
    uint8_t *buf;
    if (!f) {
        perror(path);
        exit(2);
    }
    fseek(f, 0, SEEK_END);
    n = ftell(f);
    fseek(f, 0, SEEK_SET);
    buf = malloc((size_t)n);
    if (!buf || fread(buf, 1, (size_t)n, f) != (size_t)n) {
        fprintf(stderr, "cannot read %s\n", path);
        exit(2);
    }
    fclose(f);
    *len = (uint32_t)n;
    return buf;
}

static int run(const char *path)
{
    uint32_t len;
    uint8_t *blob = load(path, &len);
    char line[1024];
    int st = lite_init(blob, len, 0);
    printf("init %d\n", st);
    while (fgets(line, sizeof line, stdin)) {
        char *tok[16];
        int n = 0;
        char *p = strtok(line, " \t\r\n");
        while (p && n < 16) {
            tok[n++] = p;
            p = strtok(0, " \t\r\n");
        }
        if (n == 0 || tok[0][0] == '#') {
            continue;
        }
        if (!strcmp(tok[0], "host2et") && n == 4) {
            double et = 0;
            st = lite_host2et((uint32_t)strtoul(tok[1], 0, 10), (uint32_t)strtoul(tok[2], 0, 10),
                              (uint32_t)strtoul(tok[3], 0, 10), &et);
            printf("%d", st);
            if (st == LITE_OK) put(et);
        } else if (!strcmp(tok[0], "fwtime") && n == 2) {
            uint8_t b[32];
            uint32_t k, m = (uint32_t)strlen(tok[1]) / 2;
            double et = 0;
            for (k = 0; k < m && k < 32; k++) {
                unsigned v;
                sscanf(tok[1] + 2 * k, "%2x", &v);
                b[k] = (uint8_t)v;
            }
            st = lite_fwtime2et(b, m, &et);
            printf("%d", st);
            if (st == LITE_OK) put(et);
        } else if (!strcmp(tok[0], "state") && n == 5) {
            double s[6], lt = 0;
            int32_t src = 0;
            int k;
            st = lite_state(atoi(tok[1]), atoi(tok[2]), from_hex(tok[3]), atoi(tok[4]), s, &lt, &src);
            printf("%d", st);
            if (st == LITE_OK) {
                for (k = 0; k < 6; k++) put(s[k]);
                put(lt);
                printf(" i%d", src);
            }
        } else if (!strcmp(tok[0], "setstate") && n == 11) {
            double s[6];
            int k;
            for (k = 0; k < 6; k++) s[k] = from_hex(tok[4 + k]);
            st = lite_set_state(atoi(tok[1]), atoi(tok[2]), from_hex(tok[3]), s, from_hex(tok[10]));
            printf("%d", st);
        } else if (!strcmp(tok[0], "clearstate")) {
            printf("%d", lite_clear_state());
        } else if (!strcmp(tok[0], "gap") && n == 2) {
            double dp = 0, dv = 0;
            st = lite_state_gap(from_hex(tok[1]), &dp, &dv);
            printf("%d", st);
            if (st == LITE_OK) {
                put(dp);
                put(dv);
            }
        } else if (!strcmp(tok[0], "orient") && n == 3) {
            double r[9];
            int k;
            st = lite_orient(atoi(tok[1]), from_hex(tok[2]), r);
            printf("%d", st);
            if (st == LITE_OK) {
                for (k = 0; k < 9; k++) put(r[k]);
            }
        } else if (!strcmp(tok[0], "siteview") && n == 5) {
            double az = 0, el = 0, rg = 0;
            st = lite_site_view(atoi(tok[1]), atoi(tok[2]), from_hex(tok[3]), atoi(tok[4]), &az, &el, &rg);
            printf("%d", st);
            if (st == LITE_OK) {
                put(az);
                put(el);
                put(rg);
            }
        } else if (!strcmp(tok[0], "subpoint") && n == 4) {
            double lon = 0, lat = 0, alt = 0;
            st = lite_sub_point(atoi(tok[1]), atoi(tok[2]), from_hex(tok[3]), &lon, &lat, &alt);
            printf("%d", st);
            if (st == LITE_OK) {
                put(lon);
                put(lat);
                put(alt);
            }
        } else if (!strcmp(tok[0], "occulted") && n == 5) {
            int32_t code = 0;
            st = lite_occulted(atoi(tok[1]), atoi(tok[2]), atoi(tok[3]), from_hex(tok[4]), &code);
            printf("%d", st);
            if (st == LITE_OK) printf(" i%d", code);
        } else if (!strcmp(tok[0], "occcorr") && n == 6) {
            int32_t code = 0, ts = -1, fs = -1;
            st = lite_occulted_corr(atoi(tok[1]), atoi(tok[2]), atoi(tok[3]), from_hex(tok[4]), atoi(tok[5]), &code, &ts, &fs);
            printf("%d", st);
            if (st == LITE_OK) printf(" i%d i%d i%d", code, ts, fs);
        } else if (!strcmp(tok[0], "occshapes") && n == 5) {
            int32_t code = 0, ts = -1, fs = -1;
            st = lite_occulted_shapes(atoi(tok[1]), atoi(tok[2]), atoi(tok[3]), from_hex(tok[4]), &code, &ts, &fs);
            printf("%d", st);
            if (st == LITE_OK) printf(" i%d i%d i%d", code, ts, fs);
        } else {
            printf("?");
        }
        printf("\n");
    }
    free(blob);
    return 0;
}

static uint32_t rng_state;

static uint32_t rng(void)
{
    rng_state ^= rng_state << 13;
    rng_state ^= rng_state >> 17;
    rng_state ^= rng_state << 5;
    return rng_state;
}

static void battery(double t0, double t1)
{
    static const int32_t ids[] = {0, 3, 6, 10, 301, 399, -82, 5, 2147483647, -2147483647 - 1};
    double s[6], lt, r[9], az, el, rg, dp, dv, et;
    int32_t src;
    int i, j, k;
    uint8_t fw[11] = {0, 3, 0, 0, 0, 0, 100, 0, 0, 0, 7};
    for (k = 0; k < 4; k++) {
        double t = t0 + (t1 - t0) * (double)k / 3.0;
        for (i = 0; i < 10; i++) {
            for (j = 0; j < 10; j++) {
                (void)lite_state(ids[i], ids[j], t, (i + j + k) % 3, s, &lt, &src);
            }
            (void)lite_orient(ids[i], t, r);
            (void)lite_site_view(i, ids[i], t, 0, &az, &el, &rg);
            for (j = 0; j < 10; j += 5) {
                (void)lite_sub_point(ids[i], ids[(i + j + k) % 10], t, &az, &el, &rg);
                (void)lite_occulted(ids[i], ids[(i + j + 1) % 10], ids[(j + k) % 10], t, &src);
                (void)lite_occulted_corr(ids[i], ids[(i + j + 1) % 10], ids[(j + k) % 10], t, 1 + (i + j) % 3, &src, 0, 0);
            }
        }
        /* the synthetic orbiters of the kind 4 test blob, at times spread
         * over more of their records */
        for (i = 0; i < 3; i++) {
            static const int32_t orb[] = {-9001, -9002, -9003};
            for (j = 0; j < 4; j++) {
                double tj = t0 + (t1 - t0) * ((double)(4 * j + k) + 0.37) / 16.0;
                (void)lite_state(orb[i], ids[5 - (j & 1)], tj, 0, s, &lt, &src);
                (void)lite_state(3, orb[i], tj, j % 3, s, &lt, &src);
            }
            (void)lite_state(orb[i], orb[(i + 1) % 3], t, 0, s, &lt, &src);
            (void)lite_set_state(orb[i], 399, t, s, 30.0);
            (void)lite_state(orb[i], 301, t + 2.0, 0, s, &lt, &src);
            (void)lite_clear_state();
        }
        for (i = 0; i < 6; i++) s[i] = 1000.0 * (double)(i + 1);
        (void)lite_set_state(-82, ids[k], t, s, 30.0);
        (void)lite_state(-82, 399, t + 5.0, 0, s, &lt, &src);
        for (i = 3; i < 6; i++) {
            (void)lite_sub_point(ids[i], -82, t + 5.0, &az, &el, &rg);
            (void)lite_occulted(ids[i], ids[i + 1], -82, t + 5.0, &src);
            (void)lite_occulted_corr(ids[i], ids[i + 1], -82, t + 5.0, LITE_LT, &src, 0, 0);
        }
        /* the geometry blob: its spacecraft (-900) placed just outside each body
         * that has radii there, where the nearest-point iteration does its work */
        for (i = 0; i < 4; i++) {
            static const int32_t near[4] = {4, 301, 399, 10};
            static const double away[4] = {15.0, 2000.0, 7000.0, 800000.0};
            double p[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
            p[(i + k) % 3] = away[i] * (double)(k + 1);
            p[(i + k + 1) % 3] = away[i] * 0.25 * (double)i;
            (void)lite_set_state(-900, near[i], t, p, 30.0);
            (void)lite_sub_point(near[i], -900, t, &az, &el, &rg);
            (void)lite_occulted(near[(i + 1) % 4], near[i], -900, t, &src);
            (void)lite_occulted(near[i], near[(i + 2) % 4], -900, t, &src);
        }
        (void)lite_state_gap(t + 1.0, &dp, &dv);
        (void)lite_clear_state();
        (void)lite_host2et(3, (uint32_t)(k * 500000), 5, &et);
        (void)lite_fwtime2et(fw, 11, &et);
    }
}

/* ---- the TIME section under the fuzzer ----------------------------------
 *
 * lite_host2et finds its piece by binary search, which is only right on a
 * table sorted by time base, then host_start, with no two entries alike.
 * lite_init must therefore refuse any other table. The functions below hold
 * both to an independent reference: time_sorted() restates the order rule,
 * and time_scan() is the conversion as it was before the search, a scan of
 * every entry. */

#define T_ENTRY 32u

static uint16_t t_base(const uint8_t *e) { return (uint16_t)(e[0] | (e[1] << 8)); }

/* What selects a piece: its time base, and its context too in a blob whose
 * header sets flag bit 2. hflags is the header's flag word. */
static uint32_t t_key(const uint8_t *e, uint32_t hflags)
{
    return (uint32_t)t_base(e) | ((hflags & 4u) != 0u ? (uint32_t)e[2] << 16 : 0u);
}

static uint32_t header_flags(const uint8_t *b)
{
    uint32_t f;
    memcpy(&f, b + 16, 4);
    return f;
}

static double t_f64(const uint8_t *e, uint32_t off)
{
    double d;
    memcpy(&d, e + off, 8);
    return d;
}

/* Finds the TIME section through the directory. Call only on a blob that is
 * known to be well formed (the original, or a copy lite_init accepted). */
static int time_find(const uint8_t *b, uint32_t *off, uint32_t *count)
{
    uint32_t nsec = (uint32_t)(b[20] | (b[21] << 8)), i;
    for (i = 0; i < nsec; i++) {
        const uint8_t *d = b + 64u + 16u * i;
        if ((d[0] | (d[1] << 8)) == 1) {
            memcpy(off, d + 4, 4);
            memcpy(count, d + 12, 4);
            return 1;
        }
    }
    return 0;
}

static int time_sorted(const uint8_t *tab, uint32_t count, uint32_t hflags)
{
    uint32_t i;
    for (i = 0; i < count; i++) {
        const uint8_t *e = tab + i * T_ENTRY;
        double a = t_f64(e, 8), b = t_f64(e, 16), c = t_f64(e, 24);
        float err;
        if (a - a != 0.0 || b - b != 0.0 || c - c != 0.0) {
            return 0;
        }
        /* a gap only where the header announces gaps; an error that is a
         * number and not negative */
        memcpy(&err, e + 4, 4);
        if (((e[3] & 1u) != 0u && (hflags & 8u) == 0u) || !(err >= 0.0f)) {
            return 0;
        }
        if (i > 0u) {
            const uint8_t *p = e - T_ENTRY;
            if (t_key(e, hflags) < t_key(p, hflags) ||
                (t_key(e, hflags) == t_key(p, hflags) && !(a > t_f64(p, 8)))) {
                return 0;
            }
        }
    }
    return 1;
}

static int time_scan(const uint8_t *tab, uint32_t count, uint32_t hflags, uint32_t time_base,
                     uint32_t seconds, uint32_t useconds, double *et)
{
    const uint8_t *best = 0;
    double host;
    uint32_t i;
    if (useconds >= 1000000u) {
        return LITE_BAD_ARG;
    }
    host = (double)seconds + (double)useconds * 1.0e-6;
    for (i = 0; i < count; i++) {
        const uint8_t *e = tab + i * T_ENTRY;
        if (t_key(e, hflags) == (time_base & ((hflags & 4u) != 0u ? 0xffffffu : 0xffffu)) &&
            t_f64(e, 8) <= host) {
            if (best == 0 || t_f64(e, 8) >= t_f64(best, 8)) {
                best = e;
            }
        }
    }
    if (best == 0 || (best[3] & 1u) != 0u) { /* no piece, or a gap */
        return LITE_OUT_OF_COVERAGE;
    }
    *et = t_f64(best, 16) + t_f64(best, 24) * (host - t_f64(best, 8));
    return LITE_OK;
}

static long time_compared;

/* On a blob the library accepted: its TIME table must be sorted, and readings
 * at, just before, and just after entry starts, in the entries' own bases and
 * in others, must convert exactly as the scan converts them. */
static void time_check(const uint8_t *copy)
{
    uint32_t off = 0, count = 0, k;
    const uint8_t *tab;
    if (!time_find(copy, &off, &count)) {
        return;
    }
    tab = copy + off;
    if (!time_sorted(tab, count, header_flags(copy))) {
        printf("fault: lite_init accepted a TIME section that is not sorted\n");
        exit(1);
    }
    for (k = 0; k < 24u; k++) {
        uint32_t base = 3u, sec = rng(), usec = rng() % 1000000u;
        double want = 0, got = 0;
        int sw, sg;
        if (count > 0u && (k % 4u) != 3u) {
            const uint8_t *e = tab + (rng() % count) * T_ENTRY;
            double h = t_f64(e, 8);
            base = t_base(e) | ((uint32_t)e[2] << 16); /* its context too, as F Prime would pass it */
            if (h >= 0.0 && h < 4294967295.0) {
                double us = (h - (double)(uint32_t)h) * 1.0e6 + 0.5;
                sec = (uint32_t)h;
                usec = us < 999999.0 ? (uint32_t)us : 999999u;
                if ((k % 4u) == 1u) { /* a microsecond earlier */
                    if (usec > 0u) usec--;
                    else if (sec > 0u) { sec--; usec = 999999u; }
                } else if ((k % 4u) == 2u) { /* somewhat later */
                    sec += rng() % 50u;
                }
            }
        }
        if ((k % 8u) == 7u) {
            base = rng() % 8u; /* often a base the blob lacks */
        } else if ((k % 8u) == 6u) {
            base += 1u << 24; /* bits above the context never count */
        } else if ((k % 8u) == 5u) {
            base ^= (rng() % 4u) << 16; /* often another context */
        }
        sw = time_scan(tab, count, header_flags(copy), base, sec, usec, &want);
        sg = lite_host2et(base, sec, usec, &got);
        if (sw != sg || (sw == LITE_OK && memcmp(&want, &got, 8) != 0)) {
            printf("fault: lite_host2et(%u, %u, %u) gave status %d, a scan of every entry gives %d%s\n",
                   base, sec, usec, sg, sw, sw == sg ? " and a different time" : "");
            exit(1);
        }
        time_compared++;
    }
}

/* Rearranges or overwrites entries of the copy's TIME table, leaving the rest
 * of the blob alone. Most of these edits break the order; some keep it. */
static void time_edit(uint8_t *copy, uint32_t off, uint32_t count)
{
    uint8_t *tab = copy + off, tmp[T_ENTRY];
    uint32_t i = rng() % count, j = rng() % (count - 1u), kind = rng() % 11u;
    if (j >= i) {
        j++;
    }
    if (kind == 0u) { /* swap two entries */
        memcpy(tmp, tab + i * T_ENTRY, T_ENTRY);
        memcpy(tab + i * T_ENTRY, tab + j * T_ENTRY, T_ENTRY);
        memcpy(tab + j * T_ENTRY, tmp, T_ENTRY);
    } else if (kind == 1u) { /* one entry twice: two pieces that start together */
        memcpy(tab + i * T_ENTRY, tab + j * T_ENTRY, T_ENTRY);
    } else if (kind == 2u) { /* one start copied onto another: an overlap */
        memcpy(tab + i * T_ENTRY + 8u, tab + j * T_ENTRY + 8u, 8);
    } else if (kind == 3u) { /* a start moved a little, which may or may not cross a neighbor */
        double h = t_f64(tab + i * T_ENTRY, 8) + ((double)(rng() % 2001u) - 1000.0) * (double)(1u << (rng() % 16u)) * 1.0e-3;
        memcpy(tab + i * T_ENTRY + 8u, &h, 8);
    } else if (kind == 4u) { /* a time base changed */
        tab[i * T_ENTRY] = (uint8_t)(tab[i * T_ENTRY] + 1u + rng() % 3u);
    } else if (kind == 5u) { /* a run of entries reversed */
        uint32_t a = i < j ? i : j, b = i < j ? j : i;
        while (a < b) {
            memcpy(tmp, tab + a * T_ENTRY, T_ENTRY);
            memcpy(tab + a * T_ENTRY, tab + b * T_ENTRY, T_ENTRY);
            memcpy(tab + b * T_ENTRY, tmp, T_ENTRY);
            a++;
            b--;
        }
    } else if (kind == 6u) { /* a start that is not a finite number */
        tab[i * T_ENTRY + 14u] = 0xF0u;
        tab[i * T_ENTRY + 15u] = (rng() & 1u) ? 0x7Fu : 0xFFu;
    } else if (kind == 8u) { /* an entry made a gap, or no longer one, with the header saying so or not */
        tab[i * T_ENTRY + 3u] ^= 1u;
        if ((rng() & 1u) != 0u) {
            copy[16] ^= 8u;
        }
    } else if (kind == 9u) { /* a context changed, in a blob that selects by context or not */
        tab[i * T_ENTRY + 2u] = (uint8_t)(tab[i * T_ENTRY + 2u] + rng() % 3u);
        if ((rng() & 1u) != 0u) {
            copy[16] ^= 4u;
        }
    } else if (kind == 10u) { /* the error field: a small number, a negative one, or not a number */
        float err = (rng() % 3u) == 0u ? -1.0e-6f : (float)(rng() % 1000u) * 1.0e-9f;
        memcpy(tab + i * T_ENTRY + 4u, &err, 4);
        if ((rng() % 4u) == 0u) {
            tab[i * T_ENTRY + 6u] = 0xC0u;
            tab[i * T_ENTRY + 7u] = 0x7Fu;
        }
    } else { /* the rate and offset rewritten: the order is untouched */
        double r = 1.0 + ((double)(rng() % 2001u) - 1000.0) * 1.0e-9, o = (double)(rng() % 100000u) * 0.01;
        memcpy(tab + i * T_ENTRY + 16u, &o, 8);
        memcpy(tab + i * T_ENTRY + 24u, &r, 8);
    }
}

static int fuzz(const char *path, int iterations, uint32_t seed)
{
    uint32_t len;
    uint8_t *orig = load(path, &len);
    double t0, t1;
    int it, accepted = 0, time_edits = 0, time_kept = 0, time_refused = 0;
    uint32_t time_off = 0, time_count = 0;
    int has_time = time_find(orig, &time_off, &time_count) && time_count >= 2u;
    memcpy(&t0, orig + 24, 8);
    memcpy(&t1, orig + 32, 8);
    rng_state = seed ? seed : 1u;
    for (it = 0; it < iterations; it++) {
        uint32_t n = len, init_flags;
        uint8_t *copy;
        int edits = 1 + (int)(rng() % 4u), e, st, only_time = 0;
        uint32_t mode = rng() % 10u;
        if (mode == 0u) {
            n = rng() % (len + 1u); /* truncation */
        }
        copy = malloc(n ? n : 1u);
        memcpy(copy, orig, n);
        if (has_time && (mode == 1u || mode == 2u)) {
            /* the TIME table rearranged or overwritten; on half of these
             * nothing else is touched, so the verdict of lite_init can be
             * checked against the order rule exactly */
            int rounds = 1 + (int)(rng() % 2u);
            while (rounds-- > 0) {
                time_edit(copy, time_off, time_count);
            }
            time_edits++;
            if (mode == 1u) {
                only_time = 1;
                edits = 0;
            }
        }
        for (e = 0; e < edits && n > 0u; e++) {
            /* most edits land in the header, directory, and section tables,
             * where a wrong offset or count does the most damage */
            uint32_t span = (rng() % 4u) ? (n < 2048u ? n : 2048u) : n;
            uint32_t pos = rng() % span;
            uint32_t kind = rng() % 4u;
            if (kind == 0u) {
                copy[pos] = (uint8_t)rng();
            } else if (kind == 1u) {
                copy[pos] ^= (uint8_t)(1u << (rng() % 8u));
            } else if (kind == 2u) {
                copy[pos] = 0xFFu;
            } else {
                copy[pos] = 0u;
            }
        }
        init_flags = (rng() % 8u) ? LITE_INIT_SKIP_CRC : 0u;
        st = lite_init(copy, n, init_flags);
        if (st == LITE_OK) {
            accepted++;
            time_check(copy);
        }
        if (only_time && init_flags == LITE_INIT_SKIP_CRC) {
            /* nothing but the TIME table changed and the checksum is not
             * looked at: accepted exactly when the table is still sorted */
            int sorted = time_sorted(copy + time_off, time_count, header_flags(copy));
            if ((st == LITE_OK) != sorted) {
                printf("fault: a TIME section that is %s was %s\n", sorted ? "sorted" : "not sorted",
                       st == LITE_OK ? "accepted" : "refused");
                return 1;
            }
            if (sorted) {
                time_kept++;
            } else {
                time_refused++;
            }
        }
        battery(t0, t1);
        (void)lite_init(0, 0, 0);
        free(copy);
    }
    printf("fuzz: %d iterations, %d blobs accepted, %d rejected, no faults\n", iterations, accepted,
           iterations - accepted);
    printf("time: %d TIME sections rearranged or overwritten; of those changed in nothing else and loaded "
           "with the checksum skipped, %d were out of order or not finite and refused, %d were still sorted "
           "and accepted; %ld conversions matched a scan of every entry\n",
           time_edits, time_refused, time_kept, time_compared);
    free(orig);
    return 0;
}

int main(int argc, char **argv)
{
    if (argc == 3 && !strcmp(argv[1], "run")) {
        return run(argv[2]);
    }
    if (argc == 5 && !strcmp(argv[1], "fuzz")) {
        return fuzz(argv[2], atoi(argv[3]), (uint32_t)strtoul(argv[4], 0, 10));
    }
    fprintf(stderr, "usage: driver run <blob> < queries | driver fuzz <blob> <n> <seed>\n");
    return 2;
}
