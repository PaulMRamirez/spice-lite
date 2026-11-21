/*
 * Native test driver for spice-lite. Two modes:
 *
 *   driver run <blob>            reads queries on stdin, prints one result
 *                                line per query (the same text the WebAssembly
 *                                harness prints, so outputs compare byte for
 *                                byte across hosts)
 *   driver fuzz <blob> <n> <seed>  corrupts copies of the blob n times and
 *                                runs a fixed battery of calls on each; meant
 *                                to run under the sanitizers
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
            }
        }
        for (i = 0; i < 6; i++) s[i] = 1000.0 * (double)(i + 1);
        (void)lite_set_state(-82, ids[k], t, s, 30.0);
        (void)lite_state(-82, 399, t + 5.0, 0, s, &lt, &src);
        for (i = 3; i < 6; i++) {
            (void)lite_sub_point(ids[i], -82, t + 5.0, &az, &el, &rg);
            (void)lite_occulted(ids[i], ids[i + 1], -82, t + 5.0, &src);
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

static int fuzz(const char *path, int iterations, uint32_t seed)
{
    uint32_t len;
    uint8_t *orig = load(path, &len);
    double t0, t1;
    int it, accepted = 0;
    memcpy(&t0, orig + 24, 8);
    memcpy(&t1, orig + 32, 8);
    rng_state = seed ? seed : 1u;
    for (it = 0; it < iterations; it++) {
        uint32_t n = len;
        uint8_t *copy;
        int edits = 1 + (int)(rng() % 4u), e;
        uint32_t mode = rng() % 10u;
        if (mode == 0u) {
            n = rng() % (len + 1u); /* truncation */
        }
        copy = malloc(n ? n : 1u);
        memcpy(copy, orig, n);
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
        if (lite_init(copy, n, (rng() % 8u) ? LITE_INIT_SKIP_CRC : 0u) == LITE_OK) {
            accepted++;
        }
        battery(t0, t1);
        (void)lite_init(0, 0, 0);
        free(copy);
    }
    printf("fuzz: %d iterations, %d blobs accepted, %d rejected, no faults\n", iterations, accepted,
           iterations - accepted);
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
