// Measures what the compact orbit segment (EPHEM kind 4) buys: for each
// synthetic orbiter of test/blobs/orbiter.json, the worst error of kind 4 at a
// range of record lengths, and beside each the smallest kind 1 (Chebyshev)
// segment found that is at least as accurate on the same arc. Both are fitted
// and measured by the slicer's own code against CSPICE. Prints the tables of
// docs/orbit-segment.md; with --update-doc, rewrites them there.
//
//   SPICE_LITE_KERNELS=<dir> node tools/orbit-tradeoff.mjs [--update-doc]
//
// The orbiters are synthetic (point mass plus J2); see tools/synth-orbiter.mjs.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSpiceEngine } from 'cspice-wasm';
import { sliceEphem } from './slicer.mjs';
import { sliceOrbit, RECORD_BYTES } from './orbit-model.mjs';
import { furnishSynthetic } from './synth-orbiter.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kernelDir = process.env.SPICE_LITE_KERNELS ?? resolve(root, 'test/blobs/kernels');
const config = JSON.parse(readFileSync(resolve(root, 'test/blobs/orbiter.json'), 'utf8'));
const spice = await createSpiceEngine();
for (const k of config.kernels) await spice.furnsh(k, new Uint8Array(readFileSync(resolve(kernelDir, k))));
const t0 = await spice.str2et(config.window.start);
const DAY = 86400, SPAN = 6 * DAY;
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const sig = (v) => String(Number(v.toPrecision(v >= 100 ? 3 : 2)));
const dist = (km) => (km >= 1 ? sig(km) + ' km' : km >= 1e-3 ? sig(km * 1e3) + ' m' : sig(km * 1e6) + ' mm');
const hours = (s) => (s % DAY === 0 ? `${s / DAY} d` : s % 3600 === 0 ? `${s / 3600} h` : `${Math.round(s / 60)} min`);
const labels = { '-9001': 'Low Earth orbiter', '-9002': 'Low lunar orbiter', '-9003': 'Eccentric Earth orbiter' };
const tables = {};

for (const spec of config.synthetic) {
  // a long pad, so records that overhang the window still have truth under them
  await furnishSynthetic(spice, { ...spec, pad: 2 * DAY }, [t0, t0 + SPAN]);
  const el = spec.elements;
  const period = 2 * Math.PI * Math.sqrt(el.a ** 3 / spec.gm);
  const body = { id: spec.body, predicted: true };
  // Kind 1 on one day: every record length on a grid of orbit fractions, every even degree.
  const cheb = [];
  for (const frac of [0.25, 0.5, 1, 1.5, 2, 3, 4]) {
    const interval = Math.round((frac * period) / 60) * 60;
    for (let degree = 4; degree <= 40; degree += 2) {
      const seg = await sliceEphem(spice, { ...body, interval, degree, checks: 4 * (degree + 1) }, [t0, t0 + Math.max(DAY, interval)], spec.center);
      cheb.push({ interval, degree, err: seg.maxPosErr, vel: seg.maxVelErr, perDay: (24 * (degree + 1) * DAY) / interval });
    }
  }
  const rows = [];
  for (const interval of [1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, DAY, 2 * DAY, 3 * DAY, 6 * DAY]) {
    const seg = await sliceOrbit(spice, { ...body, interval }, [t0, t0 + SPAN], spec.center);
    const perDay = (RECORD_BYTES * DAY) / interval;
    const match = cheb.filter((c) => c.err <= seg.maxPosErr).sort((a, b) => a.perDay - b.perDay)[0];
    rows.push(`| ${hours(interval)} (${(interval / period).toFixed(1)} orbits) | ${fmt(perDay)} | ${dist(seg.maxPosErr)} | ${dist(seg.maxVelErr)}/s | ` +
      (match ? `${fmt(match.perDay)} (degree ${match.degree}, ${hours(match.interval)} records, ${dist(match.err)}) | ${(match.perDay / perDay).toFixed(1)} |` : 'none on the grid | |'));
  }
  const best = cheb.filter((c) => c.err <= 1e-6).sort((a, b) => a.perDay - b.perDay)[0];
  const head = `**${labels[spec.body]}** (synthetic; a = ${el.a} km, e = ${el.e}, period ${(period / 60).toFixed(1)} min). ` +
    (best ? `The smallest kind 1 segment on the grid with error under a millimeter is ${fmt(best.perDay)} bytes per day (degree ${best.degree}, ${hours(best.interval)} records).` : '');
  tables[spec.body] = [head, '', '| Kind 4 record length | Kind 4 bytes per day | Worst position error | Worst velocity error | Smallest kind 1 at least as accurate, bytes per day | Kind 1 over kind 4 |', '| --- | --- | --- | --- | --- | --- |', ...rows].join('\n');
  console.log(tables[spec.body] + '\n');
}
if (process.argv.includes('--update-doc')) {
  const docPath = resolve(root, 'docs/orbit-segment.md');
  let doc = readFileSync(docPath, 'utf8');
  for (const [key, table] of Object.entries(tables)) {
    const [a, b] = [`<!-- tradeoff${key}:start -->`, `<!-- tradeoff${key}:end -->`];
    if (!doc.includes(a) || !doc.includes(b)) throw new Error(`docs/orbit-segment.md lacks the ${key} table markers`);
    doc = doc.slice(0, doc.indexOf(a) + a.length) + '\n' + table + '\n' + doc.slice(doc.indexOf(b));
  }
  writeFileSync(docPath, doc);
}
process.exit(0);
