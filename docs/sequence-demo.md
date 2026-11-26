# A sequence, end to end

[Documentation index](README.md) · To build and run this yourself: [Getting started](getting-started.md) · Related: [Running inside F Prime](fprime-integration.md)

Everything else in this repository tests the library by calling it. This is the piece that shows what it is for: a command sequence that makes a decision from geometry onboard, built as one WebAssembly module and run inside NASA JPL's SpaceWasm interpreter with stand-ins for the F Prime WasmSequencer's host calls.

## What the sequence does

`examples/sequence/sun_watch.c` waits at a ground site until the Sun has climbed above 10 degrees of elevation, then commands an image and ends. Every ten minutes it reads the spacecraft clock through the host's `time` call, converts it to ET, asks spice-lite for the Sun's elevation at the site, reports it as an event, and either sends the command or sleeps through the host's `rsleep` call. If the clock is outside the blob's coverage it stops with an error code; it never guesses.

The point of doing this onboard is that the sequence carries no ground-computed time. Started at dusk, at midnight, or an hour before sunrise, the same module images at the right moment.

## What is in the module

`scripts/build-sequence.sh` compiles the sequence, the library, and the `sun-earth-moon` blob (13,160 bytes, generated into a C array) into `build/sun_watch.wasm`:

| Property | Value |
| --- | --- |
| Module size | 32,570 bytes: sequence, library, and blob together |
| Format | Strict WebAssembly 1.0 |
| Imports | `fprime_v1`: `time`, `event`, `cmd`, `rsleep`, `exit`; nothing else |
| Memory | One 64 KiB page, never grown |
| SpaceWasm compiled IR | 29,484 bytes |

## The run

`bench/spacewasm-host --sequence` binds stand-ins for the five host calls over a simulated spacecraft clock, invokes the module's `main`, and counts the instructions the guest executes between sleeps. A sleep pauses the interpreter, as it does in the sequencer, and the simulated clock jumps forward before the guest resumes.

Started with the clock at 14,400 seconds (four hours into the blob's window, which is night at the site), the sequence reports the Sun at -9.81 degrees and falling, follows it down to -30 degrees around local midnight and back up, sleeps 58 times, and at clock 49,200 seconds reports 11.16 degrees, sends the command, and exits with code 0. The check before that read 9.26 degrees and waited.

| Phase | Instructions | Slices of 1,000 |
| --- | --- | --- |
| First cycle: `lite_init` with the checksum, then one decision | 282,419 | 283 |
| Each later decision (clock, elevation, event, sleep) | at most 7,414 | 8 |
| Whole run, 59 decisions over about 9.7 hours of spacecraft time | 710,220 | |

## How it is checked

`test/sequence.test.mjs` runs the sequence and asserts three things. The module is strict WebAssembly 1.0 and imports only the five sequencer calls. It runs in one page, images exactly once, and no decision after the first cycle exceeds 10,000 instructions. And, using full CSPICE through cspice-wasm at the same check times, the command is sent at the first check where the Sun is truly at or above 10 degrees, and every elevation the sequence reported agrees with CSPICE to the two decimals it prints.

## What this does not show

The host calls in this harness are stand-ins, not the F Prime component. The same module has since been run inside F Prime's real `Svc/WasmSequencer`, driven by its unit-test harness, and did the same thing event for event (`docs/fprime-integration.md`); and then in F Prime's reference deployment against the machine's real clock, where it commanded through the application's command dispatcher. Both needed 64 KiB of guest memory configured and one change to F Prime. Built with one-byte memory pages instead (`SEQUENCE_PAGE_SIZE=1`, an optional build that is not WebAssembly 1.0), it needed neither: it was uplinked to an unmodified sequencer and ran with 32 KiB configured. The command is a four-byte placeholder opcode, not a command in a real dictionary's format. The site's elevation is geometric, with no refraction and no light-time correction, and "up" is the direction from the body's center. The entry point is an export named `main`; how a deployment names and invokes entry points is its own configuration.
