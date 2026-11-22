# Running inside F Prime's WasmSequencer

The demonstration sequence (`examples/sequence/sun_watch.c`, `docs/sequence-demo.md`) had only ever run under this repository's own harness, with stand-ins for the sequencer's host calls. This note records the first run inside the real thing: F Prime's `Svc/WasmSequencer` component, built from F Prime's sources, with its own host calls, its own serialization of time, and its own state machines.

Three runs were made, on Linux x86-64, at F Prime commit `633c89d` (`devel`, 19 November 2026), which pins the `spacewasm` interpreter at 0.7.1. In the first the component was driven by its unit-test harness: the harness supplies the clock and answers the command, and everything between (loading the module, running it in slices of fuel, the `time`, `event`, `rsleep`, `cmd`, and `exit` host calls, the timer wake) is the component's flight code. The second and third were a full deployment: F Prime's reference application with its real time source, rate groups, command dispatcher, and event logger, commanded through F Prime's ground system ("In a full deployment", below). None was on a flight processor.

## The result

With one change to F Prime (below), the module loads and runs to completion, and does exactly what the stand-in harness said it would.

| | Stand-in harness | Real WasmSequencer |
| --- | --- | --- |
| Decisions made | 59 | 59 |
| Sleeps of 600 s | 58 | 58 |
| Event text, all 59 lines | | identical, line for line |
| Clock when the image is commanded | 49,200 s | 49,200 s |
| Sun elevation reported then | 11.16 degrees | 11.16 degrees |
| Command bytes on `cmdOut` | | `0000` (packet descriptor) then `00001001` (the opcode) |
| Outcome | exit code 0 | `SequenceSucceeded` |
| Interpreter slices, first decision (start-up with the checksum) | 283 by instruction count | 285 runs of 1,000 fuel |
| Interpreter slices, each later decision | at most 8 | at most 10 or 11 |

The slice counts differ by two or three because a host call ends the component's current run of fuel, and each decision makes three (time, event, sleep or command).

The same run was repeated with a blob whose TIME section was cut for Unix time (`{ "base": 2, "unix": true }`) and the clock given as Unix seconds under `TB_WORKSTATION_TIME`, which is what F Prime's stock time components report. It produced the same 59 event texts and commanded the image at the same instant.

## In a full deployment

F Prime's reference deployment (`TestDeploymentsProject/Ref`) includes a WasmSequencer, wired to the rest of the application: the time comes from `Svc/PosixTime` (Unix time, `TB_WORKSTATION_TIME`), a rate group ticks the sequencer's timers, the sequencer's commands go to the command dispatcher, and its events go to the event logger and down to the ground system. It was built with two local changes (the alignment constant, and `guestMemorySize` raised to 64 KiB where the deployment configures the sequencer), started, and commanded from F Prime's ground system command line: `Ref.wasmSeq.RUN` with the path of the module.

The clock in this run is the machine's own, so the blob has to be about the present. `examples/fprime/make-live-blob.mjs` cuts one for three days from now, with the Sun relative to the Earth, the Earth's orientation, a Unix time TIME section, and a geodetic site on the equator placed where the Sun will climb through 10 degrees a couple of minutes after the start. The sequence was built against it with a 20 second check period and, for its command, the opcode of a command the deployment really has (`CdhCore.cmdDisp.CMD_NO_OP`, `0x01000000`), in place of the placeholder.

What happened, from the ground system's event log on 22 November 2026:

| UTC | Event |
| --- | --- |
| 04:12:01.463 | `Ref.wasmSeq.SequenceStarting` |
| 04:12:01.464 | sun_watch: waiting, sun elevation deg 9.29 |
| 04:12:22 to 04:14:56 | eight more waits, 22 seconds apart: 9.37, 9.46, 9.55, 9.63, 9.72, 9.80, 9.89, 9.98 |
| 04:15:18.283 | sun_watch: imaging, sun elevation deg 10.06 |
| 04:15:18.284 | `CdhCore.cmdDisp.OpCodeDispatched`: opcode 0x1000000 dispatched |
| 04:15:18.284 | `CdhCore.cmdDisp.NoOpReceived`, then `OpCodeCompleted` |
| 04:15:18.284 | `Ref.wasmSeq.SequenceSucceeded` |

Each of the ten elevations was recomputed afterwards with CSPICE at the event's own time tag, from the full kernels: the largest difference is 0.005 degrees, which is the rounding of the report. The sequence commanded at the first check where CSPICE puts the Sun above 10 degrees (the check before it stood at 9.975). The waits are 22 seconds apart and not 20 because the sequencer's timers are checked on a rate group tick.

### Uplinked, and with F Prime unmodified

A third run removed both local changes to the sequencer and the shortcut of reading the module from the machine's disk. The sequence was linked with one-byte memory pages (`SEQUENCE_PAGE_SIZE=1`, "The one-byte-page build" below), which F Prime's alignment check accepts as shipped, and the deployment was built with `SPACEWASM_MEMORY_ALIGNMENT` at its own value of 8 and `guestMemorySize = 32768`. The module (21,513 bytes) was sent with F Prime's file uplink (`fprime-cli file-uplink`), which reported `FileReceived`; the copy on the flight side was byte for byte the file sent. `Ref.wasmSeq.RUN sw.wasm NO_BLOCK` then ran it: eleven waits from 9.20 to 9.96 degrees, imaging at 10.05 degrees at 05:11:14 UTC on 22 November 2026, the no-op dispatched and received, `SequenceSucceeded`. All eleven elevations match CSPICE at the events' time tags within 0.005 degrees.

One thing met on the way: `RUN` takes the file name as a command string argument, and F Prime's default `FW_CMD_STRING_MAX_SIZE` is 40, so a 51-character path was refused with a format error. A short name relative to the application's working directory works; a project with long paths raises the constant.

So the chain holds end to end in a running F Prime application: a real clock, through F Prime's serialization, into the library's time conversion and geometry, to a decision, to a command that the application's dispatcher accepted and executed.

## What this settles

- **The host call signatures match.** The five imports the sequence declares (`fprime_v1`: `time`, `event`, `cmd`, `rsleep`, `exit`) resolve against the component's, with the types the guest header gives.
- **The time layout is right, field order included.** `lite_fwtime2et` decoded time that F Prime's own generated serializer wrote, for two different time bases. Had the four fields been in another order, the time base or the seconds would have been wrong and no elevation would have matched. This closes the one point the earlier reading of the sources left as an inference.
- **The cost figures hold on the interpreter F Prime pins.** `docs/cost-measurements.md` was measured with `spacewasm` 0.8.0-rc.3; F Prime pins 0.7.1. The host harness was ported to 0.7.1 in a scratch copy (three lines of API difference) and all three cost scripts rerun: every one of the 95 rows is the same number on both versions, and the demonstration sequence totals 709,136 instructions on both.
- **The component's default interpreter heap is enough.** The default configuration (8 pages of 8,192 bytes, a 1,024-word stack, 256 code pages) loads the 32 KB module with the library and blob inside it.

## What a deployment must do

- **Either build the sequence with one-byte pages, or do the next two things.** With `SEQUENCE_PAGE_SIZE=1` the module needs no change to F Prime and about 19 KB of guest memory ("The one-byte-page build" below). The strict WebAssembly 1.0 module needs both of the following.
- **Give the sequencer 64 KiB of guest memory.** The component's default guest memory pool is 8,192 bytes. The module declares one standard WebAssembly page, 65,536 bytes, so `guestMemorySize` must be at least that. This is the "real memory configuration" question `SPEC.md` has carried from the start, now with its answer: it is a configuration value, and its default is too small.
- **Get past an alignment check, which today needs a change to F Prime.** For a memory of standard 64 KiB pages the interpreter asks the component for guest memory aligned to 16 bytes (`MemPageSize::_65536` in `spacewasm` 0.7.1). The component refuses any alignment above its constant `SPACEWASM_MEMORY_ALIGNMENT`, which is 8, and the load fails with `ERR_GUEST_MEMORY_ALLOC_FAILED` whatever the pool size. F Prime's own test modules never meet this because they are all built with the custom page sizes proposal (pages of one byte, alignment 1). Raising the constant to 16 in a local copy made the module load; F Prime's full WasmSequencer suite (218 tests) still passed with that change, plus this one. Whether the constant is a defect or a deliberate requirement that sequences use one-byte pages is F Prime's to say. It was reported to F Prime on 22 November 2026 as issue 6429 (https://github.com/nasa/fprime/issues/6429), with a 48-byte module and a short test that reproduce it without anything from this project.

## The one-byte-page build

`SEQUENCE_PAGE_SIZE=1 bash scripts/build-sequence.sh` links the same objects with `wasm-ld --page-size=1`: the memory is declared in pages of one byte (the custom page sizes proposal), sized to what the module uses and no more. This is how F Prime's own test modules are built. It is an optional second build, not the default: the result is not WebAssembly 1.0, so the strict checker does not pass it and CI does not build it, and it needs a `wasm-ld` from LLVM 20 or later (`WASM_LD=` names one; the run here used LLD 24 from the Emscripten SDK, with the objects still compiled by clang 18).

What it changes, measured: the demonstration module declares 18,704 bytes of memory in place of 65,536. Under this repository's harness it executes the same 709,136 instructions and makes the same decisions. In F Prime's sequencer unit test, with the alignment constant as shipped, it loads and runs to `SequenceSucceeded` with `guestMemorySize` 18,704 or 20,480 and fails to load at 16,384. The module file is the same size to within a few bytes (32,158 here). The library itself is untouched; only the link step differs.

## What remains unproven

- A flight processor, and wall-clock time on one. All runs were on a Linux x86-64 machine.
- A deployment other than F Prime's reference application, and a real link: the uplink above went through F Prime's file uplink and downlink components and its ground system, over a local TCP connection.
- The blob uplinked on its own. Here it is linked into the module, so a new blob means a new module.
- The spacecraft clock convention (`TB_SC_TIME`), which F Prime leaves to each project.

## Repeating it

For the unit-test run, `examples/fprime/SpiceLiteSunWatch.cpp` is the test, with instructions at its top. In outline: clone `nasa/fprime` with its `googletest` submodule, install its Python requirements, `fprime-util generate --ut`, copy `build/sun_watch.wasm` into `Svc/WasmSequencer/test/wasm/`, append the test to the suite, change `SPACEWASM_MEMORY_ALIGNMENT` from 8 to 16 in `Svc/WasmSequencer/WasmSequencer.hpp`, and build and run the WasmSequencer unit tests. It needs Rust 1.87 or later for the interpreter.

For the full deployment: in `TestDeploymentsProject`, make the same change to the alignment constant, and in `Ref/Top/instances.fpp` configure `wasmSeq` with `guestMemorySize = 65536`; `fprime-util generate` and `fprime-util build`; start the ground system from `Ref` with `fprime-gds -n` and the application with `build-artifacts/Linux/Ref/bin/Ref -a 127.0.0.1 -p 50000`. Then cut the blob and build the sequence, and send the command:

```
SPICE_LITE_KERNELS=<dir with naif0012.tls, pck00011.tpc, de440s.bsp> \
  node examples/fprime/make-live-blob.mjs build/live.slb "$(date -u -d '+40 seconds' +%Y-%m-%dT%H:%M:%S)" 150
SEQUENCE_OUT=/tmp/sun_watch_live.wasm SEQUENCE_BLOB=$PWD/build/live.slb \
  SEQUENCE_DEFS="-DCHECK_PERIOD_US=20000000ull -DOPCODE_TAKE_IMAGE=0x01000000u" bash scripts/build-sequence.sh
fprime-cli command-send Ref.wasmSeq.RUN --arguments /tmp/sun_watch_live.wasm NO_BLOCK
```

For the uplinked run with F Prime unmodified: leave the alignment constant alone, set `guestMemorySize = 32768`, add `SEQUENCE_PAGE_SIZE=1 WASM_LD=<wasm-ld of LLVM 20 or later>` to the build line above, and in place of the last line:

```
fprime-cli file-uplink /tmp/sun_watch_live.wasm sw.wasm
fprime-cli command-send Ref.wasmSeq.RUN --arguments sw.wasm NO_BLOCK
```

`de440s.bsp` is NAIF's generic planetary ephemeris (`generic_kernels/spk/planets`), needed because the test fixtures do not cover the present. Nothing from F Prime is copied into this repository.
