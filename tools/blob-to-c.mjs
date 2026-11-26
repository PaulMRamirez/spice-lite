// Writes a blob as a C source file, for a sequence that carries its blob in
// its own data section:
//
//   node tools/blob-to-c.mjs <blob.slb> <out.c> [name]
//
// The file defines `const uint8_t <name>[]`, aligned to 8 bytes so that the
// library can read doubles in place, and `const uint32_t <name>_len`. The name
// defaults to sequence_blob, which is what examples/sequence/sun_watch.c
// declares. Used by scripts/build-sequence.sh.

import { readFileSync, writeFileSync } from 'node:fs';

export function blobToC(bytes, name = 'sequence_blob') {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`"${name}" is not a C identifier`);
  let out = `#include <stdint.h>\n__attribute__((aligned(8))) const uint8_t ${name}[] = {\n`;
  for (let i = 0; i < bytes.length; i += 16) out += '  ' + [...bytes.subarray(i, i + 16)].join(',') + ',\n';
  out += `};\nconst uint32_t ${name}_len = ${bytes.length}u;\n`;
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [blobPath, outPath, name] = process.argv.slice(2);
  if (!blobPath || !outPath) {
    console.error('usage: node tools/blob-to-c.mjs <blob.slb> <out.c> [name]');
    process.exit(2);
  }
  writeFileSync(outPath, blobToC(readFileSync(blobPath), name));
}
