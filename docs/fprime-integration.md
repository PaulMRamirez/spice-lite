# Running inside F Prime's WasmSequencer

The demonstration sequence (`examples/sequence/sun_watch.c`, `docs/sequence-demo.md`) had only ever run under this repository's own harness, with stand-ins for the sequencer's host calls. This note records the first run inside the real thing: F Prime's `Svc/WasmSequencer` component, built from F Prime's sources, with its own host calls, its own serialization of time, and its own state machines.

What was run, and what was not. The component was driven by its unit-test harness, on Linux x86-64, at F Prime commit `633c89d` (`devel`, 19 November 2026), which pins the `spacewasm` interpreter at 0.7.1. The harness supplies the clock and answers the command; everything between (loading the module, running it in slices of fuel, the `time`, `event`, `rsleep`, `cmd`, and `exit` host calls, the timer wake) is the component's flight code. It was not run in a full deployment with a ground system, and not on a flight processor.

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

## What this settles

- **The host call signatures match.** The five imports the sequence declares (`fprime_v1`: `time`, `event`, `cmd`, `rsleep`, `exit`) resolve against the component's, with the types the guest header gives.
- **The time layout is right, field order included.** `lite_fwtime2et` decoded time that F Prime's own generated serializer wrote, for two different time bases. Had the four fields been in another order, the time base or the seconds would have been wrong and no elevation would have matched. This closes the one point the earlier reading of the sources left as an inference.
- **The component's default interpreter heap is enough.** The default configuration (8 pages of 8,192 bytes, a 1,024-word stack, 256 code pages) loads the 32 KB module with the library and blob inside it.

## What a deployment must do

- **Give the sequencer 64 KiB of guest memory.** The component's default guest memory pool is 8,192 bytes. The module declares one standard WebAssembly page, 65,536 bytes, so `guestMemorySize` must be at least that. This is the "real memory configuration" question `SPEC.md` has carried from the start, now with its answer: it is a configuration value, and its default is too small.
- **Get past an alignment check, which today needs a change to F Prime.** For a memory of standard 64 KiB pages the interpreter asks the component for guest memory aligned to 16 bytes (`MemPageSize::_65536` in `spacewasm` 0.7.1). The component refuses any alignment above its constant `SPACEWASM_MEMORY_ALIGNMENT`, which is 8, and the load fails with `ERR_GUEST_MEMORY_ALLOC_FAILED` whatever the pool size. F Prime's own test modules never meet this because they are all built with the custom page sizes proposal (pages of one byte, alignment 1). Raising the constant to 16 in a local copy made the module load; F Prime's full WasmSequencer suite (218 tests) still passed with that change, plus this one. Whether the constant is a defect or a deliberate requirement that sequences use one-byte pages is F Prime's to say; it has not been reported upstream by this project.
- **The other way round that check is not open to this library as built.** A module with one-byte pages would pass it, but that is a post-1.0 WebAssembly feature, and the module here is strict WebAssembly 1.0 by design; the linker pinned for the build (LLVM 18) cannot emit it either.

## What remains unproven

- A full deployment: a topology with the sequencer wired to a real time component, command dispatcher, and event logger, commanded from a ground system. The unit-test harness stands in for those neighbors.
- A flight processor, and wall-clock time on one.
- The cost figures in `docs/cost-measurements.md` were measured with `spacewasm` 0.8.0-rc.3. F Prime pins 0.7.1. The slice counts above agree with those figures as closely as host calls allow, but instruction counts were not compared call by call between the two versions.
- The spacecraft clock convention (`TB_SC_TIME`), which F Prime leaves to each project.

## Repeating it

`examples/fprime/SpiceLiteSunWatch.cpp` is the test, with instructions at its top. In outline: clone `nasa/fprime` with its `googletest` submodule, install its Python requirements, `fprime-util generate --ut`, copy `build/sun_watch.wasm` into `Svc/WasmSequencer/test/wasm/`, append the test to the suite, change `SPACEWASM_MEMORY_ALIGNMENT` from 8 to 16 in `Svc/WasmSequencer/WasmSequencer.hpp`, and build and run the WasmSequencer unit tests. It needs Rust 1.87 or later for the interpreter. Nothing from F Prime is copied into this repository.
