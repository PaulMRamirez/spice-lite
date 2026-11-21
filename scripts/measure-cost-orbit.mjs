// Tier D for the compact orbit segment (EPHEM kind 4): counts the SpaceWasm
// interpreter instructions a kind 4 state costs, using the same host harness
// and method as scripts/measure-cost.mjs, on the synthetic orbiter test blob.
// Writes build/cost-orbit.json and prints a table.
//
//   node scripts/measure-cost-orbit.mjs
//
// Needs cargo (to build bench/spacewasm-host) and the WebAssembly toolchain. A
// kind 4 segment is held to the one-segment ceiling of SPEC.md (2,500
// instructions), and a path through two segments to the three-segment ceiling.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toHex = (d) => { const f = new Float64Array([d]); return new BigUint64Array(f.buffer)[0].toString(16).padStart(16, '0'); };
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
const fmt = (n) => n.toLocaleString('en-US');

mkdirSync(resolve(root, 'build'), { recursive: true });
const wasm = resolve(root, 'build/spice_lite.wasm');
run('bash', [resolve(root, 'scripts/build-wasm.sh')]);
const hostDir = resolve(root, 'bench/spacewasm-host');
run('cargo', ['build', '--release', '--locked', '--quiet'], { cwd: hostDir });
const hostBin = resolve(hostDir, 'target/release/spice-lite-spacewasm-host');

const blobPath = resolve(root, 'test/blobs/orbiter.slb');
const report = JSON.parse(readFileSync(resolve(root, 'test/blobs/orbiter.report.json'), 'utf8'));
const [w0, w1] = report.windowEt;
// Each orbiter relative to its own center at 400 times across the window (the
// cost varies with the number of Kepler iterations, which follows the
// eccentricity and the place in the orbit), then a few longer paths.
const sweeps = [
  [-9001, 399, 'near-circular low Earth orbiter (e = 0.001)'],
  [-9002, 301, 'near-circular low lunar orbiter (e = 0.004)'],
  [-9003, 399, 'eccentric Earth orbiter (e = 0.3)'],
];
const N = 400;
const queries = ['init 1'];
for (const [t, c] of sweeps) for (let i = 0; i < N; i++) queries.push(`state ${t} ${c} ${toHex(w0 + ((w1 - w0) * (i + 0.5)) / N)} 0`);
const tMid = w0 + 0.4321 * (w1 - w0);
const paths = [
  [`state -9001 3 ${toHex(tMid)} 0`, 'low Earth orbiter from the Earth-Moon barycenter (kind 4, then kind 1 at degree 12)', 6000],
  [`state -9001 301 ${toHex(tMid)} 0`, 'low Earth orbiter from the Moon (kind 4, then two of kind 1)', 6000],
  [`state -9002 -9001 ${toHex(tMid)} 0`, 'low lunar orbiter from the low Earth orbiter (two of kind 4, two of kind 1)', null],
];
for (const p of paths) queries.push(p[0]);

// The worst case the model accepts: the low Earth orbiter's first record with its
// eccentricity overwritten by 0.9 (and the checksum skipped), swept over a day of
// orbits. The answers mean nothing; the count is what the Kepler loop can cost.
const blob = readFileSync(blobPath);
const view = new DataView(blob.buffer, blob.byteOffset, blob.length);
let recordAt = -1;
for (let i = 0; i < view.getUint16(20, true); i++) {
  const d = 64 + 16 * i;
  if (view.getUint16(d, true) !== 3) continue;
  for (let k = 0; k < view.getUint32(d + 12, true); k++) {
    const e = view.getUint32(d + 4, true) + 48 * k;
    if (view.getInt32(e, true) === -9001 && view.getUint8(e + 8) === 4) recordAt = view.getUint32(e + 32, true);
  }
}
if (recordAt < 0) throw new Error('the orbiter blob has no kind 4 segment for -9001');
const worstBlob = Buffer.from(blob);
const wv = new DataView(worstBlob.buffer, worstBlob.byteOffset, worstBlob.length);
wv.setFloat64(recordAt + 8, 0.9 * Math.cos(1), true);
wv.setFloat64(recordAt + 16, 0.9 * Math.sin(1), true);
wv.setFloat32(recordAt + 60, 0, true);
wv.setFloat32(recordAt + 64, 0, true);
const worstPath = resolve(root, 'build/cost-orbit.worst.slb');
writeFileSync(worstPath, worstBlob);
const worstQueries = ['init 1'];
for (let i = 0; i < 2000; i++) worstQueries.push(`state -9001 399 ${toHex(w0 + (86400 * (i + 0.5)) / 2000)} 0`);

const { exports: x } = await WebAssembly.instantiate(await WebAssembly.compile(readFileSync(wasm)), {});
const base = (x.__heap_base.value + 7) & ~7;
const qp = resolve(root, 'build/cost-orbit.queries');
writeFileSync(qp, queries.join('\n') + '\n');
const lines = run(hostBin, ['--module', wasm, '--blob', blobPath, '--base', String(base), '--queries', qp]).trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.query);
const failures = [];
for (const l of lines) if (l.status !== 0) failures.push(`${l.query}: status ${l.status}`);
const rows = [];
sweeps.forEach(([, , label], k) => {
  const counts = lines.slice(1 + k * N, 1 + (k + 1) * N).map((l) => l.instructions);
  const row = { label: `lite_state, ${label}, geometric, one kind 4 segment`, min: Math.min(...counts), max: Math.max(...counts), mean: Math.round(counts.reduce((s, v) => s + v, 0) / N) };
  rows.push(row);
  if (row.max > 2500) failures.push(`${row.label}: ${row.max} instructions, ceiling 2500`);
});
paths.forEach(([, label, ceiling], k) => {
  const n = lines[1 + sweeps.length * N + k].instructions;
  rows.push({ label: `lite_state, ${label}`, min: n, max: n, mean: n });
  if (ceiling && n > ceiling) failures.push(`${label}: ${n} instructions, ceiling ${ceiling}`);
});
{
  const wq = resolve(root, 'build/cost-orbit.worst.queries');
  writeFileSync(wq, worstQueries.join('\n') + '\n');
  const out = run(hostBin, ['--module', wasm, '--blob', worstPath, '--base', String(base), '--queries', wq]).trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.query).slice(1);
  for (const l of out) if (l.status !== 0) failures.push(`worst case: ${l.query}: status ${l.status}`);
  const counts = out.map((l) => l.instructions);
  const row = { label: 'lite_state, one kind 4 segment with the eccentricity forced to the limit of 0.9 (cost only)', min: Math.min(...counts), max: Math.max(...counts), mean: Math.round(counts.reduce((s, v) => s + v, 0) / counts.length) };
  rows.push(row);
  if (row.max > 3500) failures.push(`${row.label}: ${row.max} instructions, ceiling 3500`);
}
writeFileSync(resolve(root, 'build/cost-orbit.json'), JSON.stringify({ spacewasm: '0.8.0-rc.3', moduleBytes: readFileSync(wasm).length, rows }, null, 2) + '\n');
console.log(`module ${fmt(readFileSync(wasm).length)} bytes; ${N} times per orbiter`);
console.log(['| Call | Instructions (least to most) | Mean | Slices of 1,000 |', '| --- | --- | --- | --- |',
  ...rows.map((r) => `| ${r.label} | ${r.min === r.max ? fmt(r.min) : fmt(r.min) + ' to ' + fmt(r.max)} | ${fmt(r.mean)} | ${Math.ceil(r.max / 1000)} |`)].join('\n'));
if (failures.length) {
  console.error('\nover a ceiling or failed:\n  ' + failures.join('\n  '));
  process.exit(1);
}
