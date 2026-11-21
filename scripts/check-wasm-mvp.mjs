#!/usr/bin/env node
// Strict WebAssembly MVP checker (taken from the cspice-wasm project, same author).
//
// Walks every section and decodes every instruction of every function body, and fails
// on anything outside WebAssembly 1.0 plus the mutable-globals proposal: the DataCount
// section, passive or declared segments, multiple tables or memories, shared or 64-bit
// memories, multi-value block and function types, reference types, typed select, the
// sign-extension opcodes (0xC0 to 0xC4), and every prefixed opcode family (0xFC
// saturating truncation and bulk memory, 0xFD SIMD, 0xFE threads), plus tail calls and
// exception handling. It has no dependencies, so it runs anywhere Node does, and it is
// deliberately a decoder and not a type checker: a host still validates the module.
//
// Usage: node scripts/check-wasm-mvp.mjs [--json] <module.wasm> ...
// With --json it prints one JSON object per module with the static measurements used
// in the cost report (sizes, counts, imports, memory, data bytes).

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const VALTYPES = new Set([0x7f, 0x7e, 0x7d, 0x7c]);
const SECTION_NAMES = [
  'custom', 'type', 'import', 'function', 'table', 'memory', 'global', 'export', 'start',
  'element', 'code', 'data',
];

class Reader {
  constructor(bytes, pos = 0, end = bytes.length) {
    this.b = bytes;
    this.p = pos;
    this.end = end;
  }
  u8() {
    if (this.p >= this.end) throw new Error(`unexpected end at 0x${this.p.toString(16)}`);
    return this.b[this.p++];
  }
  // Unsigned LEB128 as a Number (values here fit in 53 bits).
  u32() {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 35) throw new Error(`LEB128 too long at 0x${this.p.toString(16)}`);
    }
  }
  // Skip a signed LEB128 of at most maxBytes bytes.
  skipLeb(maxBytes) {
    for (let i = 0; i < maxBytes; i++) if ((this.u8() & 0x80) === 0) return;
    throw new Error(`LEB128 too long at 0x${this.p.toString(16)}`);
  }
  skip(n) {
    if (this.p + n > this.end) throw new Error(`unexpected end at 0x${this.p.toString(16)}`);
    this.p += n;
  }
  name() {
    const len = this.u32();
    const s = Buffer.from(this.b.subarray(this.p, this.p + len)).toString('utf8');
    this.skip(len);
    return s;
  }
  done() {
    return this.p >= this.end;
  }
}

function fail(where, what) {
  throw new Error(`${what} (at byte 0x${where.toString(16)})`);
}

function valtype(r) {
  const at = r.p;
  const t = r.u8();
  if (!VALTYPES.has(t)) fail(at, `value type 0x${t.toString(16)} is not i32, i64, f32, or f64`);
}

function limits(r, what) {
  const at = r.p;
  const flags = r.u8();
  if (flags > 1) fail(at, `${what} limits flags 0x${flags.toString(16)} (shared, 64-bit, or custom page size)`);
  const min = r.u32();
  const max = flags === 1 ? r.u32() : null;
  return { min, max };
}

function tableType(r) {
  const at = r.p;
  if (r.u8() !== 0x70) fail(at, 'table element type is not funcref');
  return limits(r, 'table');
}

// A constant expression in the MVP: one const or global.get, then end.
function constExpr(r) {
  const at = r.p;
  const op = r.u8();
  if (op === 0x41) r.skipLeb(5);
  else if (op === 0x42) r.skipLeb(10);
  else if (op === 0x43) r.skip(4);
  else if (op === 0x44) r.skip(8);
  else if (op === 0x23) r.u32();
  else fail(at, `constant expression opcode 0x${op.toString(16)} (extended const)`);
  if (r.u8() !== 0x0b) fail(at, 'constant expression has more than one instruction (extended const)');
}

function blockType(r) {
  const at = r.p;
  const t = r.u8();
  if (t !== 0x40 && !VALTYPES.has(t)) fail(at, `block type 0x${t.toString(16)} (multi-value or reference type)`);
}

function memarg(r) {
  const at = r.p;
  const align = r.u32();
  if (align >= 0x40) fail(at, 'memarg selects a memory index (multi-memory)');
  r.u32();
}

// Decode one function body's instruction stream; returns the instruction count.
function instructions(r) {
  let count = 0;
  let depth = 1;
  while (depth > 0) {
    const at = r.p;
    const op = r.u8();
    count++;
    if (op === 0x00 || op === 0x01 || op === 0x0f || op === 0x1a || op === 0x1b) {
      // unreachable, nop, return, drop, select
    } else if (op === 0x02 || op === 0x03 || op === 0x04) {
      blockType(r);
      depth++;
    } else if (op === 0x05) {
      // else
    } else if (op === 0x0b) {
      depth--;
    } else if (op === 0x0c || op === 0x0d || op === 0x10) {
      r.u32();
    } else if (op === 0x0e) {
      const n = r.u32();
      for (let i = 0; i <= n; i++) r.u32();
    } else if (op === 0x11) {
      r.u32();
      if (r.u8() !== 0x00) fail(at, 'call_indirect names a table other than 0 (reference types)');
    } else if (op >= 0x20 && op <= 0x24) {
      r.u32();
    } else if (op >= 0x28 && op <= 0x3e) {
      memarg(r);
    } else if (op === 0x3f || op === 0x40) {
      if (r.u8() !== 0x00) fail(at, 'memory.size or memory.grow names a memory other than 0');
    } else if (op === 0x41) {
      r.skipLeb(5);
    } else if (op === 0x42) {
      r.skipLeb(10);
    } else if (op === 0x43) {
      r.skip(4);
    } else if (op === 0x44) {
      r.skip(8);
    } else if (op >= 0x45 && op <= 0xbf) {
      // numeric comparison, arithmetic, and conversion
    } else if (op >= 0xc0 && op <= 0xc4) {
      fail(at, `opcode 0x${op.toString(16)} is a sign-extension operator`);
    } else if (op === 0xfc) {
      const sub = r.u32();
      fail(at, sub <= 7 ? `opcode 0xfc ${sub} is a saturating float to int conversion` : `opcode 0xfc ${sub} is a bulk memory or table operator`);
    } else if (op === 0xfd) {
      fail(at, 'opcode 0xfd is a SIMD operator');
    } else if (op === 0xfe) {
      fail(at, 'opcode 0xfe is a threads (atomics) operator');
    } else if (op === 0x12 || op === 0x13) {
      fail(at, `opcode 0x${op.toString(16)} is a tail call`);
    } else if (op === 0x1c) {
      fail(at, 'opcode 0x1c is typed select (reference types)');
    } else if (op === 0x25 || op === 0x26 || (op >= 0xd0 && op <= 0xd2)) {
      fail(at, `opcode 0x${op.toString(16)} is a reference types operator`);
    } else {
      fail(at, `opcode 0x${op.toString(16)} is not a WebAssembly 1.0 instruction`);
    }
  }
  return count;
}

export function checkModule(bytes) {
  const r = new Reader(bytes);
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error('not a WebAssembly module');
  }
  if (bytes[4] !== 1 || bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) {
    throw new Error('not a version 1 core module (a component, perhaps)');
  }
  r.skip(8);

  const stats = {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sections: {},
    types: 0,
    imports: [],
    importedFunctions: 0,
    definedFunctions: 0,
    exports: 0,
    exportedFunctions: 0,
    tables: 0,
    tableMin: 0,
    memoryMinPages: 0,
    memoryMaxPages: null,
    globals: 0,
    codeBytes: 0,
    instructions: 0,
    dataSegments: 0,
    dataBytes: 0,
    dataEnd: 0,
    customSections: [],
  };
  let memories = 0;
  let lastId = 0;

  while (!r.done()) {
    const at = r.p;
    const id = r.u8();
    const size = r.u32();
    const s = new Reader(bytes, r.p, r.p + size);
    r.skip(size);
    if (id > 11) fail(at, id === 12 ? 'DataCount section (bulk memory)' : `section id ${id} is not WebAssembly 1.0`);
    if (id !== 0) {
      if (id <= lastId) fail(at, `section id ${id} is out of order or repeated`);
      lastId = id;
    }
    const sectionName = SECTION_NAMES[id];
    stats.sections[sectionName] = (stats.sections[sectionName] ?? 0) + size;

    if (id === 0) {
      stats.customSections.push(s.name());
    } else if (id === 1) {
      stats.types = s.u32();
      for (let i = 0; i < stats.types; i++) {
        const tAt = s.p;
        if (s.u8() !== 0x60) fail(tAt, 'type is not a function type (GC or component model)');
        const params = s.u32();
        for (let j = 0; j < params; j++) valtype(s);
        const results = s.u32();
        if (results > 1) fail(tAt, `function type with ${results} results (multi-value)`);
        for (let j = 0; j < results; j++) valtype(s);
      }
    } else if (id === 2) {
      const n = s.u32();
      for (let i = 0; i < n; i++) {
        const module = s.name();
        const field = s.name();
        const kAt = s.p;
        const kind = s.u8();
        if (kind === 0) {
          s.u32();
          stats.importedFunctions++;
        } else if (kind === 1) {
          tableType(s);
          stats.tables++;
        } else if (kind === 2) {
          const l = limits(s, 'memory');
          stats.memoryMinPages = l.min;
          stats.memoryMaxPages = l.max;
          memories++;
        } else if (kind === 3) {
          valtype(s);
          if (s.u8() > 1) fail(kAt, 'bad global mutability');
        } else {
          fail(kAt, `import kind ${kind} is not WebAssembly 1.0`);
        }
        stats.imports.push(`${module}.${field}`);
      }
    } else if (id === 3) {
      stats.definedFunctions = s.u32();
      for (let i = 0; i < stats.definedFunctions; i++) s.u32();
    } else if (id === 4) {
      const n = s.u32();
      for (let i = 0; i < n; i++) stats.tableMin = tableType(s).min;
      stats.tables += n;
    } else if (id === 5) {
      const n = s.u32();
      for (let i = 0; i < n; i++) {
        const l = limits(s, 'memory');
        stats.memoryMinPages = l.min;
        stats.memoryMaxPages = l.max;
      }
      memories += n;
    } else if (id === 6) {
      stats.globals = s.u32();
      for (let i = 0; i < stats.globals; i++) {
        valtype(s);
        const mAt = s.p;
        if (s.u8() > 1) fail(mAt, 'bad global mutability');
        constExpr(s);
      }
    } else if (id === 7) {
      stats.exports = s.u32();
      for (let i = 0; i < stats.exports; i++) {
        s.name();
        const kAt = s.p;
        const kind = s.u8();
        if (kind > 3) fail(kAt, `export kind ${kind} is not WebAssembly 1.0`);
        if (kind === 0) stats.exportedFunctions++;
        s.u32();
      }
    } else if (id === 8) {
      s.u32();
    } else if (id === 9) {
      const n = s.u32();
      for (let i = 0; i < n; i++) {
        const eAt = s.p;
        if (s.u32() !== 0) fail(eAt, 'element segment is not the MVP active form (bulk memory or reference types)');
        constExpr(s);
        const count = s.u32();
        for (let j = 0; j < count; j++) s.u32();
      }
    } else if (id === 10) {
      const n = s.u32();
      for (let i = 0; i < n; i++) {
        const bodySize = s.u32();
        const body = new Reader(bytes, s.p, s.p + bodySize);
        s.skip(bodySize);
        stats.codeBytes += bodySize;
        const groups = body.u32();
        for (let j = 0; j < groups; j++) {
          body.u32();
          valtype(body);
        }
        stats.instructions += instructions(body);
        if (!body.done()) fail(body.p, 'trailing bytes after a function body');
      }
    } else if (id === 11) {
      stats.dataSegments = s.u32();
      for (let i = 0; i < stats.dataSegments; i++) {
        const dAt = s.p;
        if (s.u32() !== 0) fail(dAt, 'data segment is not the MVP active form (bulk memory)');
        // Record where the segment lands when its offset is a plain i32.const.
        let offset = null;
        if (bytes[s.p] === 0x41) {
          const o = new Reader(bytes, s.p + 1, s.end);
          let result = 0;
          let shift = 0;
          let byte;
          do {
            byte = o.u8();
            result |= (byte & 0x7f) << shift;
            shift += 7;
          } while (byte & 0x80);
          offset = result >>> 0;
        }
        constExpr(s);
        const len = s.u32();
        s.skip(len);
        stats.dataBytes += len;
        if (offset !== null) stats.dataEnd = Math.max(stats.dataEnd, offset + len);
      }
    }
    if (id !== 0 && !s.done()) fail(s.p, `trailing bytes in the ${sectionName} section`);
  }

  if (stats.tables > 1) throw new Error(`${stats.tables} tables (reference types)`);
  if (memories > 1) throw new Error(`${memories} memories (multi-memory)`);
  return stats;
}

function main(argv) {
  const json = argv.includes('--json');
  const files = argv.filter((a) => !a.startsWith('--'));
  if (files.length === 0) {
    console.error('usage: node scripts/check-wasm-mvp.mjs [--json] <module.wasm> ...');
    return 2;
  }
  let status = 0;
  for (const file of files) {
    try {
      const stats = checkModule(new Uint8Array(readFileSync(file)));
      if (json) {
        console.log(JSON.stringify({ file, ...stats }, null, 2));
      } else {
        console.log(
          `${file}: ok, WebAssembly 1.0 plus mutable globals only; ${stats.bytes} bytes, ` +
            `${stats.definedFunctions} functions, ${stats.instructions} instructions, ` +
            `${stats.imports.length} imports, ${stats.memoryMinPages} initial pages ` +
            `(${((stats.memoryMinPages * 65536) / 1048576).toFixed(1)} MiB), ${stats.dataBytes} data bytes`,
        );
      }
    } catch (err) {
      console.error(`${file}: NOT MVP: ${err.message}`);
      status = 1;
    }
  }
  return status;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main(process.argv.slice(2)));
}
