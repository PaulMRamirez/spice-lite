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
const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(readFileSync(benchWasm)), {});
const base = (exports.__heap_base.value + 7) & ~7;

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
const queryPath = resolve(root, 'build/cost.queries');
writeFileSync(queryPath, cases.map((c) => c[0]).join('\n') + '\n');

const hostDir = resolve(root, 'bench/spacewasm-host');
run('cargo', ['build', '--release', '--locked', '--quiet'], { cwd: hostDir });
const out = run(resolve(hostDir, 'target/release/spice-lite-spacewasm-host'), ['--module', benchWasm, '--blob', blobPath, '--base', String(base), '--queries', queryPath]);
const lines = out.trim().split('\n').map((l) => JSON.parse(l));
const load = lines[0].load;
const rows = lines.filter((l) => l.query).map((l, i) => ({ label: cases[i][1], budget: cases[i][2], status: l.status, instructions: l.instructions, slices: Math.ceil(l.instructions / 1000) }));

// Ceilings from SPEC.md, in instructions: time conversion, a geometric state over one
// segment, a geometric state over up to three segments, and a corrected state.
const budgets = { time: 500, none1: 2500, none: 6000, lts: 15000 };
const failures = [];
for (const r of rows) {
  if (r.status !== 0) failures.push(`${r.label}: status ${r.status}`);
  if (r.budget && r.instructions > budgets[r.budget]) failures.push(`${r.label}: ${r.instructions} instructions, budget ${budgets[r.budget]}`);
}
const result = { spacewasm: '0.8.0-rc.3', load, blobBytes: blob.length, rows, budgets };
writeFileSync(resolve(root, 'build/cost.json'), JSON.stringify(result, null, 2) + '\n');
const fmt = (n) => n.toLocaleString('en-US');
const table = ['| Call | Instructions | Slices of 1,000 |', '| --- | --- | --- |', ...rows.map((r) => `| ${r.label} | ${fmt(r.instructions)} | ${fmt(r.slices)} |`)].join('\n');
console.log(`module ${fmt(load.module_bytes)} bytes, IR ${fmt(load.ir_bytes)} bytes, interpreter heap ${fmt(load.heap_bytes)} bytes, stack ${fmt(load.stack_words)} words`);
console.log(table);
if (process.argv.includes('--update-doc')) {
  const docPath = resolve(root, 'docs/cost-measurements.md');
  const doc = readFileSync(docPath, 'utf8');
  const [a, b] = ['<!-- cost-table:start -->', '<!-- cost-table:end -->'];
  writeFileSync(docPath, doc.slice(0, doc.indexOf(a) + a.length) + '\n' + table + '\n' + doc.slice(doc.indexOf(b)));
}
if (failures.length) {
  console.error('\nover budget or failed:\n  ' + failures.join('\n  '));
  process.exit(1);
}
