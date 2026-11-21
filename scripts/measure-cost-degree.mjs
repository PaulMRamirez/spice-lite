// Tier D for long Chebyshev records: what a one-segment geometric state costs
// under SpaceWasm as the degree of an EPHEM kind 1 segment rises from 4 to 40,
// the most the format allows. Uses the same host harness and method as
// scripts/measure-cost.mjs. The blobs are cut on the spot (the Moon relative to
// the Earth-Moon barycenter, one record of four days at each degree) and are
// not committed; only the count matters here, not the fit.
//
//   SPICE_LITE_KERNELS=<dir> node scripts/measure-cost-degree.mjs [--update-doc]
//
// With --update-doc, rewrites the degree table of docs/cost-measurements.md.
// The one-segment ceiling of SPEC.md is 2,500 instructions; this script reports
// where the cost crosses it and does not fail above it, because no committed
// blob uses such a degree.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slice } from '../tools/slicer.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kernelDir = process.env.SPICE_LITE_KERNELS ?? resolve(root, 'test/blobs/kernels');
const toHex = (d) => new BigUint64Array(new Float64Array([d]).buffer)[0].toString(16).padStart(16, '0');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
const fmt = (n) => n.toLocaleString('en-US');
const CEILING = 2500;

mkdirSync(resolve(root, 'build'), { recursive: true });
const wasm = resolve(root, 'build/spice_lite.wasm');
run('bash', [resolve(root, 'scripts/build-wasm.sh')]);
const hostDir = resolve(root, 'bench/spacewasm-host');
run('cargo', ['build', '--release', '--locked', '--quiet'], { cwd: hostDir });
const hostBin = resolve(hostDir, 'target/release/spice-lite-spacewasm-host');
const { exports: x } = await WebAssembly.instantiate(await WebAssembly.compile(readFileSync(wasm)), {});
const base = (x.__heap_base.value + 7) & ~7;

const rows = [];
for (let degree = 4; degree <= 40; degree += 2) {
  const { blob, report } = await slice({
    name: `degree-${degree}`,
    kernels: ['naif0012.tls', 'de440s-inner-cassini.bsp'],
    window: { start: '2004-06-27T00:00:00', stop: '2004-07-01T00:00:00' },
    bodies: [{ id: 3, parent: null }, { id: 301, parent: 3, interval: 345600, degree }],
  }, kernelDir);
  const blobPath = resolve(root, `build/cost-degree-${degree}.slb`);
  writeFileSync(blobPath, blob);
  const [w0, w1] = report.windowEt;
  const queries = ['init 1'];
  for (let i = 0; i < 16; i++) queries.push(`state 301 3 ${toHex(w0 + ((w1 - w0) * (i + 0.5)) / 16)} 0`);
  const qp = resolve(root, 'build/cost-degree.queries');
  writeFileSync(qp, queries.join('\n') + '\n');
  const lines = run(hostBin, ['--module', wasm, '--blob', blobPath, '--base', String(base), '--queries', qp]).trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.query).slice(1);
  for (const l of lines) if (l.status !== 0) throw new Error(`degree ${degree}: ${l.query}: status ${l.status}`);
  const counts = lines.map((l) => l.instructions);
  rows.push({ degree, min: Math.min(...counts), max: Math.max(...counts), bytes: 3 * (degree + 1) * 8 });
}
const perDegree = (rows.at(-1).max - rows[0].max) / (rows.at(-1).degree - rows[0].degree);
const last = rows.filter((r) => r.max <= CEILING).at(-1);
const table = ['| Degree | Bytes per record | Instructions | Slices of 1,000 | Within the 2,500 ceiling |', '| --- | --- | --- | --- | --- |',
  ...rows.map((r) => `| ${r.degree} | ${fmt(r.bytes)} | ${r.min === r.max ? fmt(r.max) : fmt(r.min) + ' to ' + fmt(r.max)} | ${Math.ceil(r.max / 1000)} | ${r.max <= CEILING ? 'yes' : 'no'} |`)].join('\n');
console.log(`module ${fmt(readFileSync(wasm).length)} bytes`);
console.log(table);
console.log(`\n${perDegree.toFixed(1)} instructions per degree; the highest even degree within the ceiling is ${last.degree}`);
if (process.argv.includes('--update-doc')) {
  const docPath = resolve(root, 'docs/cost-measurements.md');
  const doc = readFileSync(docPath, 'utf8');
  const [a, b] = ['<!-- degree-table:start -->', '<!-- degree-table:end -->'];
  if (!doc.includes(a) || !doc.includes(b)) throw new Error('docs/cost-measurements.md lacks the degree table markers');
  writeFileSync(docPath, doc.slice(0, doc.indexOf(a) + a.length) + '\n' + table + '\n' + doc.slice(doc.indexOf(b)));
}
process.exit(0);
