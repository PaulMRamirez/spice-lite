# Building it into a sequence

[Documentation index](README.md) · Previous: [Calling the library](api.md) · Next: [Running inside F Prime](fprime-integration.md)

The flight library is two files, [`include/spice_lite.h`](../include/spice_lite.h) and [`src/spice_lite.c`](../src/spice_lite.c). There is nothing to install: you compile the one source file with your sequence. This page gives the commands, explains each option, and shows how the blob gets into the module and how much memory the result needs.

- [The short way: the example's build script](#the-short-way-the-examples-build-script)
- [The long way: your own sequence, by hand](#the-long-way-your-own-sequence-by-hand)
- [What each option is for](#what-each-option-is-for)
- [Getting the blob into the module](#getting-the-blob-into-the-module)
- [The memory budget](#the-memory-budget)
- [Checking the result](#checking-the-result)
- [A native build, for ground tests](#a-native-build-for-ground-tests)
- [Build-time options](#build-time-options)
- [Before it goes to a sequencer](#before-it-goes-to-a-sequencer)

## The short way: the example's build script

[`scripts/build-sequence.sh`](../scripts/build-sequence.sh) builds [`examples/sequence/sun_watch.c`](../examples/sequence/sun_watch.c) with the library and a blob into one module. Environment variables make it build variants:

| Variable | Default | Effect |
| --- | --- | --- |
| `SEQUENCE_BLOB` | `test/blobs/sun-earth-moon.slb` | The blob to embed (an absolute path) |
| `SEQUENCE_OUT` | `build/sun_watch.wasm` | Where to write the module (an absolute path) |
| `SEQUENCE_DEFS` | none | Extra compiler options for the sequence, such as `-DSITE_ID=1 -DCHECK_PERIOD_US=20000000ull` |
| `SEQUENCE_PAGE_SIZE` | `65536` | `1` links with one-byte memory pages: see [below](#before-it-goes-to-a-sequencer) |
| `CC`, `WASM_LD` | `clang`, `wasm-ld` | The compiler and linker |

```
SEQUENCE_BLOB=$PWD/build/canberra.slb SEQUENCE_OUT=$PWD/build/canberra_watch.wasm \
  SEQUENCE_DEFS="-DSITE_ID=1" bash scripts/build-sequence.sh
```

## The long way: your own sequence, by hand

Three sources go into the module: your sequence, the library, and the blob as a C array. This is a complete sequence that needs no host calls, so that it can be tried anywhere. Save it as `my_sequence.c`:

```c
#include <stdint.h>
#include "spice_lite.h"

extern const uint8_t sequence_blob[];
extern const uint32_t sequence_blob_len;

__attribute__((export_name("main"))) int main(void)
{
    double et = 141912064.0 + 3600.0, az, el, range; /* an hour into the canberra blob */
    if (lite_init(sequence_blob, sequence_blob_len, 0) != LITE_OK) {
        return 1;
    }
    if (lite_site_view(1, 10, et, LITE_NONE, &az, &el, &range) != LITE_OK) {
        return 2;
    }
    return el > 0.0 ? 10 : 11; /* is the Sun up at site 1? */
}
```

Then, with `ROOT` the path of this repository and the blob from [Getting started](getting-started.md#5-cut-the-blob):

```
node $ROOT/tools/blob-to-c.mjs $ROOT/build/canberra.slb blob.c

for src in my_sequence.c blob.c $ROOT/src/spice_lite.c; do
  clang --target=wasm32 -mcpu=mvp -O2 -std=c99 -ffreestanding -nostdlib -fno-builtin \
    -ffp-contract=off -fvisibility=hidden -I$ROOT/include -c -o $(basename $src .c).o $src
done

wasm-ld --no-entry --strip-all -z stack-size=4096 --initial-memory=65536 \
  -o my_sequence.wasm my_sequence.o blob.o spice_lite.o
```

The result is 20,225 bytes. It can be tried at once in Node, since it imports nothing:

```
node -e 'WebAssembly.instantiate(require("fs").readFileSync("my_sequence.wasm"), {})
  .then(({ instance }) => console.log(instance.exports.main()))'
```

That prints `10`: the Sun is up. A real sequence replaces the fixed time with the host's clock and adds the host's imports, as `sun_watch.c` does for F Prime:

```c
#define FPRIME_IMPORT(name) __attribute__((import_module("fprime_v1"), import_name(name)))
FPRIME_IMPORT("time") extern void fprime_wasm_get_time(uint32_t time_ptr, uint32_t time_size);
```

## What each option is for

Compiler:

| Option | Why |
| --- | --- |
| `--target=wasm32` | A bare WebAssembly module, no operating system interface |
| `-mcpu=mvp` | WebAssembly 1.0 only: no later features an interpreter may lack |
| `-ffreestanding -nostdlib -fno-builtin` | No libc. The library needs none, and the compiler must not turn a loop into a call to `memcpy` that nothing provides |
| `-ffp-contract=off` | **Required for the library.** Keeps each multiply and add separate, so that results are bit-identical on every host and match the test vectors |
| `-fvisibility=hidden` | Only what you mark for export is exported |
| `-O2 -std=c99` | What the measurements were made with |

Linker:

| Option | Why |
| --- | --- |
| `--no-entry` | The module has no `_start`; the sequencer calls an export |
| `--strip-all` | No names or debug sections in the module |
| `-z stack-size=4096` | The C stack. Every example and test here runs in this much; raise it if your own code uses large locals |
| `--initial-memory=65536` | One 64 KiB page, never grown |

The build compiles and links as separate steps on purpose. Asked to do both, clang runs `wasm-opt` on the result if it finds one installed, and the module then differs from machine to machine.

On any other compiler or target the rule is the same: compile `src/spice_lite.c` as C99 with floating-point contraction off. The library assumes a little-endian host with IEEE 754 doubles and refuses to compile for a big-endian one.

## Getting the blob into the module

The library reads the blob in place, so the blob must be somewhere in the module's memory, 8-byte aligned, and unchanged while it is in use. The simplest place is the module's own data section. [`tools/blob-to-c.mjs`](../tools/blob-to-c.mjs) writes it as a C source file:

```
node tools/blob-to-c.mjs <blob.slb> <out.c> [name]
```

```c
#include <stdint.h>
__attribute__((aligned(8))) const uint8_t sequence_blob[] = {
  83,76,66,49, ...
};
const uint32_t sequence_blob_len = 2552u;
```

The sequence declares the two symbols `extern` and passes them to `lite_init`. The optional third argument names the array something other than `sequence_blob`.

A blob can instead be delivered separately and copied into the module's memory by the host, as the test harness does; the library does not care where the bytes came from, only that the pointer and length are right. Baking it in means one file to uplink and one thing to verify.

## The memory budget

A module built this way uses, from address 0 up:

| Part | Bytes |
| --- | --- |
| The C stack | 4,096 |
| The library's constants and state, including the 1 KB checksum table | about 2,300 |
| The blob | its size, rounded up to 8 |
| Your sequence's own data | whatever it declares |

With the 2.5 KB blob of the walkthrough that comes to 8,992 bytes; with the 13 KB example blob, 19,592. One standard page is 65,536, so **a strict WebAssembly 1.0 sequence has room for a blob of about 59 KB**, and the sequencer must grant it that page. A larger blob needs `--initial-memory` raised by whole pages and a sequencer configured to match.

To see the figure for your own module, link with `--export=__heap_base` and read the exported global: it is the first address past everything above.

What takes the space in a blob, and how to shrink it, is in [Cutting a blob: size and accuracy](slicer.md#size-and-accuracy).

## Checking the result

```
node scripts/check-wasm-mvp.mjs my_sequence.wasm
```

```
my_sequence.wasm: ok, WebAssembly 1.0 plus mutable globals only; 20225 bytes, 14 functions, 7591 instructions, 0 imports, 1 initial pages (0.1 MiB), 3688 data bytes
```

The checker fails on any feature beyond WebAssembly 1.0. Check the imports as well: a sequence should import its host's calls and nothing else. An unexpected import such as `env.memcpy` means a compiler option above is missing.

To run a sequence that uses the F Prime host calls without F Prime, use the harness from [Getting started, step 7](getting-started.md#7-run-it-in-the-spacewasm-interpreter). It counts the instructions between sleeps, which is how you learn whether each cycle fits the slices your sequencer allows.

## A native build, for ground tests

The same source builds with any desktop C compiler, and gives the same bits:

```
cc -std=c99 -O2 -ffp-contract=off -Iinclude -o build/tour examples/native/tour.c src/spice_lite.c -lm
build/tour test/blobs/cassini-soi.slb test/blobs/saturn-soi.slb
```

`-lm` is for the example's own `sqrt`; the library does not use the math library. This is the quickest way to try a new blob against the questions your sequence will ask, with a debugger and `printf` at hand. `pnpm tour` runs exactly these two lines.

## Build-time options

| Macro | Values | Effect |
| --- | --- | --- |
| `LITE_CRC_TABLES` | `1` (default), `0`, `4` | The size of the CRC-32 table: none, 1 KB, or 4 KB. More table makes `lite_init` cheaper and the module larger. [Cost: checksum options](cost-measurements.md#checksum-options) has the numbers |

Pass it as `-DLITE_CRC_TABLES=4` when compiling `src/spice_lite.c`. Two other ways to make start-up cheaper need no rebuild of the library: cut the blob with `"checksum": "fletcher32"`, or pass `LITE_INIT_SKIP_CRC` to `lite_init` where something else already verifies the module.

## Before it goes to a sequencer

- **Memory.** The module declares 65,536 bytes. F Prime's WasmSequencer grants 8,192 by default, so `guestMemorySize` must be raised.
- **Page size.** At the F Prime commit tested, the sequencer also refuses the alignment a standard 64 KiB page asks for. `SEQUENCE_PAGE_SIZE=1 bash scripts/build-sequence.sh` links with one-byte pages instead (it needs `wasm-ld` from LLVM 20 or later, named with `WASM_LD`). That module is not WebAssembly 1.0, but it loads in F Prime as shipped and needs only about 19 KB of guest memory with the 13 KB blob.
- **Entry point.** The examples export `main`. What your sequencer calls is its own configuration.
- **Time layout.** `lite_fwtime2et` assumes F Prime's default `Fw::Time` serialization.
- **Commands.** The opcode in `sun_watch.c` is a placeholder. Take yours from your dictionary.

[Running inside F Prime](fprime-integration.md) has the details of each, and the steps that were used to run the demonstration in the real component.

---

[Documentation index](README.md) · Previous: [Calling the library](api.md) · Next: [Running inside F Prime](fprime-integration.md)
