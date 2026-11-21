// Tier D, cost: runs spice-lite inside NASA's SpaceWasm interpreter and counts the
// interpreter instructions each call executes, then checks the counts against the
// budgets in SPEC.md. Writes build/cost.json and prints a table.
//
//   node scripts/measure-cost.mjs [--update-doc]
//
// Needs cargo (to build bench/spacewasm-host) and the WebAssembly toolchain. The
// instruction is SpaceWasm's IR instruction, the unit its fuel counts; one F Prime
// WasmSequencer slice is 1,000 of them by default.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toHex = (d) => { const f = new Float64Array([d]); return new BigUint64Array(f.buffer)[0].toString(16).padStart(16, '0'); };
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });

mkdirSync(resolve(root, 'build'), { recursive: true });
const blobPath = resolve(root, 'test/blobs/cassini-soi.slb');
const blob = readFileSync(blobPath);
const report = JSON.parse(readFileSync(resolve(root, 'test/blobs/cassini-soi.report.json'), 'utf8'));

// A variant of the module with room for the 90 KB test blob. Memory size does not
// change what the code executes.
const benchWasm = resolve(root, 'build/spice_lite.bench.wasm');
run('bash', [resolve(root, 'scripts/build-wasm.sh')], { env: { ...process.env, WASM_OUT: benchWasm, WASM_INITIAL_MEMORY: String(4 * 65536) } });

const [w0] = report.windowEt;
const sc = report.ephem.find((s) => s.target === -82);
const tNat = w0 + 9.3 * 86400;        // a time inside every natural-body segment
const tSc = sc.tStart + 40000.5;      // a time inside the spacecraft segment, clear of its start
const zeros = Array(6).fill(toHex(1234.5)).join(' ');
const cases = [
  ['init 0', 'lite_init, checksum verified (90 KB blob)', null],
  ['init 1', 'lite_init, checksum skipped', null],
  ['host2et 3 100 500000', 'lite_host2et', 'time'],
  ['fwtime 00030000000064000001f4', 'lite_fwtime2et', 'time'],
  [`state 301 3 ${toHex(tNat)} 0`, 'lite_state, one segment (Moon from Earth-Moon barycenter), geometric', 'none1'],
  [`state 301 399 ${toHex(tNat)} 0`, 'lite_state, two segments (Moon from Earth), geometric', 'none'],
  [`state 10 399 ${toHex(tNat)} 0`, 'lite_state, three segments (Sun from Earth), geometric', 'none'],
  [`state 10 399 ${toHex(tNat)} 1`, 'lite_state, Sun from Earth, light time', 'lts'],
  [`state 10 399 ${toHex(tNat)} 2`, 'lite_state, Sun from Earth, light time and stellar aberration', 'lts'],
  [`state 301 399 ${toHex(tNat)} 2`, 'lite_state, Moon from Earth, light time and stellar aberration', 'lts'],
  [`state -82 6 ${toHex(tSc)} 0`, 'lite_state, spacecraft from Saturn barycenter (predicted), geometric', 'none1'],
  [`state 399 -82 ${toHex(tSc)} 2`, 'lite_state, Earth from spacecraft, light time and stellar aberration', 'lts'],
  [`orient 301 ${toHex(tNat)}`, 'lite_orient, Moon', null],
  [`siteview 1 10 ${toHex(tNat)} 0`, 'lite_site_view, Sun from a lunar site', null],
  [`setstate -82 6 ${toHex(tSc)} ${zeros} ${toHex(30)}`, 'lite_set_state', null],
  [`state -82 6 ${toHex(tSc + 5)} 0`, 'lite_state, spacecraft from Saturn barycenter (supplied), geometric', 'none1'],
  [`state -82 399 ${toHex(tSc + 5)} 0`, 'lite_state, spacecraft from Earth (supplied), geometric', 'none'],
  [`gap ${toHex(tSc + 5)}`, 'lite_state_gap', null],
  ['clearstate', 'lite_clear_state', null],
];
const hostDir = resolve(root, 'bench/spacewasm-host');
run('cargo', ['build', '--release', '--locked', '--quiet'], { cwd: hostDir });
const hostBin = resolve(hostDir, 'target/release/spice-lite-spacewasm-host');
const fmt = (n) => n.toLocaleString('en-US');
const failures = [];

async function measure(wasm, blobFile, queryList, tag) {
  const { exports: x } = await WebAssembly.instantiate(await WebAssembly.compile(readFileSync(wasm)), {});
  const at = (x.__heap_base.value + 7) & ~7;
  const qp = resolve(root, `build/cost.${tag}.queries`);
  writeFileSync(qp, queryList.map((c) => c[0]).join('\n') + '\n');
  const text = run(hostBin, ['--module', wasm, '--blob', blobFile, '--base', String(at), '--queries', qp]);
  const parsed = text.trim().split('\n').map((l) => JSON.parse(l));
  const rows = parsed.filter((l) => l.query).map((l, i) => ({ label: queryList[i][1], budget: queryList[i][2], status: l.status, instructions: l.instructions, slices: Math.ceil(l.instructions / 1000) }));
  for (const r of rows) if (r.status !== 0) failures.push(`${tag}: ${r.label}: status ${r.status}`);
  return { load: parsed[0].load, rows, base: at };
}
const tableOf = (rows) => ['| Call | Instructions | Slices of 1,000 |', '| --- | --- | --- |', ...rows.map((r) => `| ${r.label} | ${fmt(r.instructions)} | ${fmt(r.slices)} |`)].join('\n');

// 1. Every call, on the large test blob.
const full = await measure(benchWasm, blobPath, cases, 'full');
// Ceilings from SPEC.md, in instructions: time conversion, a geometric state over one
// segment, a geometric state over up to three segments, and a corrected state.
const budgets = { time: 500, none1: 2500, none: 6000, lts: 15000 };
for (const r of full.rows) if (r.budget && r.instructions > budgets[r.budget]) failures.push(`${r.label}: ${r.instructions} instructions, ceiling ${budgets[r.budget]}`);

// 2. The flight-shaped case: the shipped one-page module with the small blob.
const shipped = resolve(root, 'build/spice_lite.wasm');
run('bash', [resolve(root, 'scripts/build-wasm.sh')]);
const smallPath = resolve(root, 'test/blobs/sun-earth-moon.slb');
const small = readFileSync(smallPath);
const smallReport = JSON.parse(readFileSync(resolve(root, 'test/blobs/sun-earth-moon.report.json'), 'utf8'));
const tS = smallReport.windowEt[0] + 9.3 * 86400;
const flight = await measure(shipped, smallPath, [
  ['init 0', 'lite_init, checksum verified (13 KB blob)', null],
  ['init 1', 'lite_init, checksum skipped', null],
  ['host2et 3 100 500000', 'lite_host2et', null],
  [`state 301 399 ${toHex(tS)} 0`, 'lite_state, Moon from Earth, geometric', null],
  [`state 10 399 ${toHex(tS)} 2`, 'lite_state, Sun from Earth, light time and stellar aberration', null],
  [`orient 301 ${toHex(tS)}`, 'lite_orient, Moon', null],
  [`siteview 1 10 ${toHex(tS)} 0`, 'lite_site_view, Sun from a lunar site', null],
], 'flight');
if (flight.load.guest_memory_bytes !== 65536) failures.push(`the shipped module has ${flight.load.guest_memory_bytes} bytes of memory, not one page`);
const pageUse = { heapBase: flight.base, blobBytes: small.length, end: flight.base + small.length, free: 65536 - (flight.base + small.length) };

// 3. The checksum table options, on the small blob.
const crcRows = [];
for (const tables of [0, 1, 4]) {
  const wasm = resolve(root, `build/spice_lite.crc${tables}.wasm`);
  run('bash', [resolve(root, 'scripts/build-wasm.sh')], { env: { ...process.env, WASM_OUT: wasm, LITE_CRC_TABLES: String(tables) } });
  const m = await measure(wasm, smallPath, [['init 0', 'init', null], ['init 1', 'skip', null]], `crc${tables}`);
  const crcOnly = m.rows[0].instructions - m.rows[1].instructions;
  crcRows.push({ tables, tableBytes: tables === 0 ? 64 : tables * 1024, moduleBytes: m.load.module_bytes, instructions: m.rows[0].instructions, perByte: crcOnly / (small.length - 16), slices: m.rows[0].slices });
}
const crcTable = ['| LITE_CRC_TABLES | Table size | Module size | Instructions per blob byte | lite_init on the 13 KB blob | Slices |', '| --- | --- | --- | --- | --- | --- |',
  ...crcRows.map((r) => `| ${r.tables}${r.tables === 1 ? ' (default)' : ''} | ${fmt(r.tableBytes)} bytes | ${fmt(r.moduleBytes)} bytes | ${r.perByte.toFixed(1)} | ${fmt(r.instructions)} | ${fmt(r.slices)} |`)].join('\n');

const result = { spacewasm: '0.8.0-rc.3', full, flight, pageUse, crc: crcRows, budgets };
writeFileSync(resolve(root, 'build/cost.json'), JSON.stringify(result, null, 2) + '\n');
const tables = { full: tableOf(full.rows), flight: tableOf(flight.rows), crc: crcTable };
console.log(`module ${fmt(full.load.module_bytes)} bytes, IR ${fmt(full.load.ir_bytes)} bytes, interpreter heap ${fmt(full.load.heap_bytes)} bytes, stack ${fmt(full.load.stack_words)} words`);
console.log(tables.full + '\n');
console.log(`one page: module data and stack end at byte ${fmt(pageUse.heapBase)}, the blob ends at ${fmt(pageUse.end)}, ${fmt(pageUse.free)} bytes free`);
console.log(tables.flight + '\n');
console.log(tables.crc);
if (process.argv.includes('--update-doc')) {
  const docPath = resolve(root, 'docs/cost-measurements.md');
  let doc = readFileSync(docPath, 'utf8');
  for (const [key, table] of Object.entries(tables)) {
    const [a, b] = [`<!-- ${key}-table:start -->`, `<!-- ${key}-table:end -->`];
    if (!doc.includes(a) || !doc.includes(b)) throw new Error(`docs/cost-measurements.md lacks the ${key} table markers`);
    doc = doc.slice(0, doc.indexOf(a) + a.length) + '\n' + table + '\n' + doc.slice(doc.indexOf(b));
  }
  writeFileSync(docPath, doc);
}
if (failures.length) {
  console.error('\nover a ceiling or failed:\n  ' + failures.join('\n  '));
  process.exit(1);
}
