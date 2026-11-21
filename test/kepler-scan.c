/* Scans the Kepler solve of EPHEM kind 4 exactly as it is compiled into the
 * flight library (this file includes the library source to reach the static
 * function). For every eccentricity on a grid from 0 to the limit and every
 * mean anomaly on a grid around the orbit, with a second grid packed within
 * 0.2 radians of periapsis where the equation is stiffest, it counts the steps
 * the solve takes and compares the sine and cosine it returns with a long
 * double solve. Test code only: it uses the C library, the flight code does
 * not.
 *
 *   kepler-scan [eccentricity steps] [mean anomalies per grid] [top eccentricity]
 *
 * Prints one JSON object. test/orbit.test.mjs runs a coarse scan on every test
 * run; docs/orbit-segment.md quotes a fine one. */
#include "../src/spice_lite.c"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv)
{
    int ne = argc > 1 ? atoi(argv[1]) : 180, nm = argc > 2 ? atoi(argv[2]) : 4000;
    double emax = argc > 3 ? atof(argv[3]) : 0.9;
    long hist[ORBIT_KEPLER_MAX + 1] = {0}, failures = 0, cases = 0;
    double worst_err = 0.0, worst_e = 0.0, worst_m = 0.0;
    int ie, im, k, most = 0;
    if (ne < 1 || nm < 1) {
        return 2;
    }
    for (ie = 0; ie <= ne; ie++) {
        double e = emax * ie / ne;
        for (im = 0; im < 2 * nm; im++) {
            double m = im < nm ? 6.283185307179586 * (im + 0.5) / nm : 0.4 * ((im - nm + 0.5) / nm - 0.5);
            double ka = e * sin(m), kb = e * cos(m), sg, cg, err;
            long double g, d;
            int n = kepler_offset(ka, kb, &sg, &cg);
            cases++;
            if (n == 0) {
                failures++;
                continue;
            }
            hist[n]++;
            if (n > most) {
                most = n;
            }
            g = (long double)e * sinl((long double)m + (long double)e * sinl((long double)m));
            for (k = 0; k < 200; k++) {
                d = (g - ((long double)ka * cosl(g) + (long double)kb * sinl(g))) /
                    (1.0L + ((long double)ka * sinl(g) - (long double)kb * cosl(g)));
                g -= d;
                if (fabsl(d) < 1e-19L) {
                    break;
                }
            }
            err = fmax(fabs((double)(sinl(g) - (long double)sg)), fabs((double)(cosl(g) - (long double)cg)));
            if (err > worst_err) {
                worst_err = err;
                worst_e = e;
                worst_m = m;
            }
        }
    }
    printf("{\"topEccentricity\": %.6g, \"eccentricities\": %d, \"meanAnomaliesEach\": %d, \"cases\": %ld, "
           "\"failures\": %ld, \"mostSteps\": %d, \"cap\": %d, \"casesBySteps\": [",
           emax, ne + 1, 2 * nm, cases, failures, most, ORBIT_KEPLER_MAX);
    for (k = 1; k <= ORBIT_KEPLER_MAX; k++) {
        printf("%s%ld", k > 1 ? ", " : "", hist[k]);
    }
    printf("], \"worstError\": %.3g, \"worstErrorAt\": {\"e\": %.6g, \"meanAnomaly\": %.6g}}\n", worst_err, worst_e, worst_m);
    return 0;
}
