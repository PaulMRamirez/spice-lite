# spice-lite documentation

Start with the path that matches what you are doing. Every page links back here.

## Using the library

Read these in order the first time; each ends with a link to the next.

| Step | Page | What you get from it |
| --- | --- | --- |
| 1 | [Getting started](getting-started.md) | From a fresh clone to your own blob running in a sequence under the SpaceWasm interpreter, in eight steps |
| 2 | [Cutting a blob](slicer.md) | Every option of the slicer configuration, with a recipe for each common case |
| 3 | [Calling the library](api.md) | Each call by the question it answers, with code, and what to do with each status |
| 4 | [Building it into a sequence](building.md) | The compiler and linker commands, how the blob gets into the module, and the memory budget |
| 5 | [Running inside F Prime](fprime-integration.md) | What a real WasmSequencer deployment must configure, and how the demonstration was run there |

## Find it by task

| I want to... | Go to |
| --- | --- |
| See the library answer questions without installing kernels | [Getting started, step 2](getting-started.md#2-watch-the-library-answer-questions) |
| Get the kernels the tests and the slicer need | [Getting started, step 3](getting-started.md#3-get-the-kernels) |
| Write a slicer configuration for my bodies, sites, and clock | [Cutting a blob](slicer.md) |
| Map my flight clock (SCLK, Unix time, or a fixed offset) to ET | [Cutting a blob: time](slicer.md#time-the-host-clock) |
| Carry a spacecraft trajectory, or supply one from onboard navigation | [Cutting a blob: spacecraft](slicer.md#a-spacecraft), [Calling the library: the spacecraft](api.md#the-spacecrafts-own-state) |
| Make the blob smaller, or trade size against accuracy | [Cutting a blob: size and accuracy](slicer.md#size-and-accuracy) |
| Know which call answers my question | [Calling the library: the calls at a glance](api.md#the-calls-at-a-glance) |
| Decide what a sequence does when a call does not return `LITE_OK` | [Calling the library: status codes](api.md#status-codes-and-what-to-do-with-them) |
| Compile and link the library with my own sequence | [Building it into a sequence](building.md) |
| Fit the module and blob in the sequencer's memory | [Building: the memory budget](building.md#the-memory-budget) |
| Know what a call costs in interpreter instructions | [Cost under SpaceWasm](cost-measurements.md) |
| Know how exact the answers are | [`SPEC.md`, conformance and validation](../SPEC.md#conformance-and-validation) and the report the slicer writes ([Cutting a blob: the report](slicer.md#reading-the-output-and-the-report)) |

## Runnable examples

| Example | What it shows | Run it with |
| --- | --- | --- |
| [`examples/native/tour.c`](../examples/native/tour.c) | Every call once, on a desktop, against two committed blobs | `pnpm tour` |
| [`examples/getting-started/canberra.json`](../examples/getting-started/canberra.json) | A small slicer configuration to copy and change | [Getting started, step 5](getting-started.md#5-cut-the-blob) |
| [`examples/sequence/sun_watch.c`](../examples/sequence/sun_watch.c) | A complete onboard sequence that decides from geometry | `pnpm build:sequence`, then [Getting started, step 7](getting-started.md#7-run-it-in-the-spacewasm-interpreter) |
| [`examples/fprime/`](../examples/fprime) | The same sequence inside F Prime's real WasmSequencer | [Running inside F Prime](fprime-integration.md#repeating-it) |
| [`test/blobs/*.json`](../test/blobs) | Seven more configurations: a predicted trajectory, orbit segments, clocks from SCLK kernels, eclipses | `pnpm slice`, `pnpm slice:orbiter`, `pnpm slice:geometry` |

## Reference

| Page | Contents |
| --- | --- |
| [`include/spice_lite.h`](../include/spice_lite.h) | The whole public interface, with the contract of each call in its comment |
| [`SPEC.md`](../SPEC.md) | The blob format byte by byte, the behavior of every call, the cost ceilings, and what is still open |
| [`CHANGELOG.md`](../CHANGELOG.md) | What changed between versions of the library, the format, and the tools |

## Measurements and background

These report what was measured. They are not needed to use the library, but they are where its numbers come from.

| Page | Contents |
| --- | --- |
| [A sequence, end to end](sequence-demo.md) | The demonstration sequence's run under the SpaceWasm interpreter: what it did and what it cost |
| [Running inside F Prime](fprime-integration.md) | The same sequence in the real WasmSequencer, in unit tests and in a full deployment |
| [Cost under SpaceWasm](cost-measurements.md) | Interpreter instructions for every call, the checksum options, and how cost grows |
| [The compact orbit segment](orbit-segment.md) | Size against error for the orbit model, on synthetic and real orbiters |
| [Real mission kernels](real-kernels.md) | Which public kernels the real-orbiter measurements use, and the clock mapping on real clocks |
