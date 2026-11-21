/*
 * sun_watch: a demonstration sequence for the F Prime WasmSequencer.
 *
 * It waits at a ground site until the Sun has climbed above a set elevation,
 * then commands an image and ends. The decision is made onboard from geometry
 * (spice-lite and a 13 KB blob baked into this module), not from a time
 * computed on the ground, so the sequence does the right thing whenever it
 * happens to be started.
 *
 * The host calls are the WasmSequencer's guest interface (import module
 * "fprime_v1"); the declarations below restate the ones this sequence uses
 * from F Prime's Svc/WasmSequencer/spacewasm_include/fprime.h. The command
 * opcode is a placeholder: a real deployment takes it from its dictionary and
 * serializes arguments as its command format requires.
 *
 * This is an example, not flight software.
 */
#include <stdint.h>

#include "spice_lite.h"

#define FPRIME_IMPORT(name) __attribute__((import_module("fprime_v1"), import_name(name)))

FPRIME_IMPORT("time") extern void fprime_wasm_get_time(uint32_t time_ptr, uint32_t time_size);
FPRIME_IMPORT("cmd") extern int32_t fprime_wasm_command(uint32_t buf_ptr, uint32_t buf_size);
FPRIME_IMPORT("event") extern void fprime_wasm_event(int32_t severity, uint32_t msg_ptr, uint32_t msg_size);
FPRIME_IMPORT("rsleep") extern void fprime_wasm_rsleep(uint64_t microseconds);
FPRIME_IMPORT("exit") extern void fprime_wasm_exit(int32_t code);

#define FPRIME_EVENT_WARNING_HI 2
#define FPRIME_EVENT_ACTIVITY_HI 5
#define FPRIME_EVENT_ACTIVITY_LO 6
#define FW_TIME_SIZE 11u

/* Mission constants for the demonstration. */
#define SITE_ID 2                       /* the Earth site in the sun-earth-moon blob */
#define SUN 10
#define MIN_ELEVATION_RAD 0.17453292519943295 /* 10 degrees */
#define CHECK_PERIOD_US 600000000ull    /* look again every 10 minutes */
#define MAX_CHECKS 200                  /* give up after about 33 hours */
#define OPCODE_TAKE_IMAGE 0x00001001u   /* placeholder */

/* The blob, generated into build/sequence_blob.c by scripts/build-sequence.sh. */
extern const uint8_t sequence_blob[];
extern const uint32_t sequence_blob_len;

static uint32_t put_text(char *dst, uint32_t at, const char *s)
{
    while (*s) {
        dst[at++] = *s++;
    }
    return at;
}

/* Writes a signed value with two decimals, for example -12.34. */
static uint32_t put_fixed2(char *dst, uint32_t at, double v)
{
    char digits[12];
    int n = 0;
    int64_t scaled;
    if (v < 0.0) {
        dst[at++] = '-';
        v = -v;
    }
    scaled = (int64_t)(v * 100.0 + 0.5);
    do {
        digits[n++] = (char)('0' + (int)(scaled % 10));
        scaled /= 10;
    } while (scaled > 0 && n < 11);
    while (n < 3) {
        digits[n++] = '0';
    }
    while (n > 0) {
        if (n == 2) {
            dst[at++] = '.';
        }
        dst[at++] = digits[--n];
    }
    return at;
}

static void report(int32_t severity, const char *text, double value, int with_value)
{
    char msg[64];
    uint32_t n = put_text(msg, 0, text);
    if (with_value) {
        n = put_fixed2(msg, n, value);
    }
    fprime_wasm_event(severity, (uint32_t)(uintptr_t)msg, n);
}

__attribute__((export_name("main"))) int main(void)
{
    static const double DEG = 57.29577951308232;
    uint8_t now[FW_TIME_SIZE];
    uint8_t command[4] = {(uint8_t)(OPCODE_TAKE_IMAGE >> 24), (uint8_t)(OPCODE_TAKE_IMAGE >> 16),
                          (uint8_t)(OPCODE_TAKE_IMAGE >> 8), (uint8_t)OPCODE_TAKE_IMAGE};
    double et, az, el, range;
    int check;

    if (lite_init(sequence_blob, sequence_blob_len, 0) != LITE_OK) {
        report(FPRIME_EVENT_WARNING_HI, "sun_watch: geometry blob rejected", 0.0, 0);
        fprime_wasm_exit(1);
        return 1;
    }
    for (check = 0; check < MAX_CHECKS; check++) {
        fprime_wasm_get_time((uint32_t)(uintptr_t)now, FW_TIME_SIZE);
        if (lite_fwtime2et(now, FW_TIME_SIZE, &et) != LITE_OK ||
            lite_site_view(SITE_ID, SUN, et, LITE_NONE, &az, &el, &range) != LITE_OK) {
            /* Outside the blob's coverage, or no geometry: stop, do not guess. */
            report(FPRIME_EVENT_WARNING_HI, "sun_watch: no geometry for this time", 0.0, 0);
            fprime_wasm_exit(2);
            return 2;
        }
        if (el >= MIN_ELEVATION_RAD) {
            report(FPRIME_EVENT_ACTIVITY_HI, "sun_watch: imaging, sun elevation deg ", el * DEG, 1);
            if (fprime_wasm_command((uint32_t)(uintptr_t)command, sizeof command) != 0) {
                fprime_wasm_exit(3);
                return 3;
            }
            fprime_wasm_exit(0);
            return 0;
        }
        report(FPRIME_EVENT_ACTIVITY_LO, "sun_watch: waiting, sun elevation deg ", el * DEG, 1);
        fprime_wasm_rsleep(CHECK_PERIOD_US);
    }
    report(FPRIME_EVENT_WARNING_HI, "sun_watch: gave up waiting for the sun", 0.0, 0);
    fprime_wasm_exit(4);
    return 4;
}
