# Cost under SpaceWasm

What each spice-lite call costs when the library runs as a guest of NASA JPL's SpaceWasm interpreter, measured, with the method. This is tier D of the conformance tiers in `SPEC.md`.

## Method

`scripts/measure-cost.mjs` builds the module, loads it with the `spacewasm` crate (0.8.0-rc.3) through the host harness in `bench/spacewasm-host`, copies the test blob into guest memory, and runs each call below. The interpreter is resumed with one instruction of fuel at a time, so the number of resumptions is the exact number of instructions the call executed. The interpreter's operand stack is 1,024 words, the F Prime WasmSequencer default.

The instruction is a SpaceWasm IR instruction, the unit its fuel counts, not a WebAssembly bytecode instruction. One WasmSequencer slice is 1,000 of them by default, so the last column is how many sequencer cycles a call spans.

The test blob is 89,840 bytes, too large for the one page the shipped module declares, so the measurement links a variant of the module with four pages. Memory size does not change what the code executes. The counts are deterministic: CI reruns the measurement and fails if any call exceeds its ceiling.

## Results

Module 13,620 bytes; compiled IR 22,908 bytes; interpreter heap for the load 37,273 bytes with the harness's settings.

<!-- cost-table:start -->
| Call | Instructions | Slices of 1,000 |
| --- | --- | --- |
| lite_init, checksum verified (90 KB blob) | 3,056,985 | 3,057 |
| lite_init, checksum skipped | 2,938 | 3 |
| lite_host2et | 106 | 1 |
| lite_fwtime2et | 163 | 1 |
| lite_state, one segment (Moon from Earth-Moon barycenter), geometric | 1,982 | 2 |
| lite_state, two segments (Moon from Earth), geometric | 3,495 | 4 |
| lite_state, three segments (Sun from Earth), geometric | 4,601 | 5 |
| lite_state, Sun from Earth, light time | 6,430 | 7 |
| lite_state, Sun from Earth, light time and stellar aberration | 6,531 | 7 |
| lite_state, Moon from Earth, light time and stellar aberration | 9,627 | 10 |
| lite_state, spacecraft from Saturn barycenter (predicted), geometric | 1,711 | 2 |
| lite_state, Earth from spacecraft, light time and stellar aberration | 8,953 | 9 |
| lite_orient, Moon | 1,170 | 2 |
| lite_site_view, Sun from a lunar site | 6,161 | 7 |
| lite_set_state | 258 | 1 |
| lite_state, spacecraft from Saturn barycenter (supplied), geometric | 726 | 1 |
| lite_state, spacecraft from Earth (supplied), geometric | 4,512 | 5 |
| lite_state_gap | 1,732 | 2 |
| lite_clear_state | 8 | 1 |
<!-- cost-table:end -->

## Reading the numbers

A geometric state costs about 1,700 to 2,000 instructions for each segment on the path between the two bodies, plus a few hundred of fixed overhead. Most of that is the Chebyshev recurrence: three components, position and velocity together, at degree 10 to 12. A body tree shaped so that common queries cross one or two segments keeps them within two to four slices.

Light time roughly doubles the cost, because the target's path is evaluated twice. Stellar aberration adds about a hundred instructions on top of that; it needs no trigonometry.

A site view is the sum of its parts: 6,161 instructions against 4,601 for the state and 1,170 for the orientation it contains, plus about 400 for the arcsine and arctangent behind elevation and azimuth.

A supplied spacecraft state is cheap by itself (726 instructions relative to its own center) since it replaces a segment evaluation with a straight-line step.

The checksum dominates start-up. `lite_init` takes 2,938 instructions to validate the structure of the test blob and 3,056,985 to also verify its CRC-32, which is 34 instructions per byte. That is about a thousand slices per 30 KB of blob. A mission that already trusts its uplink can pass the skip flag; otherwise the cost is paid once per blob.

For scale, full CSPICE as a SpaceWasm guest (measured in the cspice-wasm repository) takes 31,660 instructions for a geometric Earth and Sun state and 81,606 with light time and stellar aberration, against 4,601 and 6,531 here, and it needs 96.5 MiB of memory against one page.

## What is not measured

Wall time on flight hardware, behavior inside an actual F Prime deployment, and the cost of the calls on blobs with other shapes (higher degrees, deeper trees, Hermite segments). The counts are for the 13,620-byte build made with the author's clang 18; another compiler build may differ by a few percent.
