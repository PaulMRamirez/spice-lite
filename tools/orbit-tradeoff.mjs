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
const DAY = 86400, SPAN = 6 * DAY;
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const sig = (v) => String(Number(v.toPrecision(v >= 100 ? 3 : 2)));
export const dist = (km) => (km >= 1 ? sig(km) + ' km' : km >= 1e-3 ? sig(km * 1e3) + ' m' : sig(km * 1e6) + ' mm');
const hours = (s) => (s % DAY === 0 ? `${s / DAY} d` : s % 3600 === 0 ? `${s / 3600} h` : `${Math.round(s / 60)} min`);

// One table: kind 4 at up to nine record lengths over span seconds from t0 (six
// days unless given; record lengths that do not divide the span are left out),
// and beside each the smallest kind 1 segment of the search grid that is at
// least as accurate over the first day. The orbiter must already be furnished,
// with coverage of the span from t0. head(best) returns the paragraph above
// the table, given the smallest kind 1 segment with error under a millimeter
// (undefined if none on the grid reaches it) and the most accurate one found.
export async function tradeoffTable(spice, { id, center, period, t0, head, span = SPAN }) {
  const body = { id, predicted: true };
  // Kind 1 on one day: every record length on a grid of orbit fractions, every even degree.
  const cheb = [];
  for (const frac of [0.25, 0.5, 1, 1.5, 2, 3, 4]) {
    const interval = Math.round((frac * period) / 60) * 60;
    for (let degree = 4; degree <= 40; degree += 2) {
      const seg = await sliceEphem(spice, { ...body, interval, degree, checks: 4 * (degree + 1) }, [t0, t0 + Math.max(DAY, interval)], center);
      cheb.push({ interval, degree, err: seg.maxPosErr, vel: seg.maxVelErr, perDay: (24 * (degree + 1) * DAY) / interval });
    }
  }
  const rows = [];
  for (const interval of [1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, DAY, 2 * DAY, 3 * DAY, 6 * DAY]) {
    if (span % interval !== 0) continue;
    const seg = await sliceOrbit(spice, { ...body, interval }, [t0, t0 + span], center);
    const perDay = (RECORD_BYTES * DAY) / interval;
    const match = cheb.filter((c) => c.err <= seg.maxPosErr).sort((a, b) => a.perDay - b.perDay)[0];
    rows.push(`| ${hours(interval)} (${(interval / period).toFixed(1)} orbits) | ${fmt(perDay)} | ${dist(seg.maxPosErr)} | ${dist(seg.maxVelErr)}/s | ` +
      (match ? `${fmt(match.perDay)} (degree ${match.degree}, ${hours(match.interval)} records, ${dist(match.err)}) | ${(match.perDay / perDay).toFixed(1)} |` : 'none on the grid | |'));
  }
  const best = cheb.filter((c) => c.err <= 1e-6).sort((a, b) => a.perDay - b.perDay)[0];
  const finest = [...cheb].sort((a, b) => a.err - b.err || a.perDay - b.perDay)[0];
  const describe = (c) => `${fmt(c.perDay)} bytes per day (degree ${c.degree}, ${hours(c.interval)} records)`;
  return [head({ best: best && describe(best), finest: `${describe(finest)}, at ${dist(finest.err)}` }), '',
    '| Kind 4 record length | Kind 4 bytes per day | Worst position error | Worst velocity error | Smallest kind 1 at least as accurate, bytes per day | Kind 1 over kind 4 |', '| --- | --- | --- | --- | --- | --- |', ...rows].join('\n');
}

// Replaces what lies between the <!-- name:start --> and <!-- name:end -->
// markers of a document, for each entry of tables. In docs/orbit-segment.md
// (the default) it then rebuilds the side-by-side table from every tradeoff
// table the document holds, so the summary cannot disagree with the tables it
// summarizes.
export function updateDoc(tables, file = 'docs/orbit-segment.md') {
  const docPath = resolve(root, file);
  let doc = readFileSync(docPath, 'utf8');
  const put = (key, text) => {
    const [a, b] = [`<!-- ${key}:start -->`, `<!-- ${key}:end -->`];
    if (!doc.includes(a) || !doc.includes(b)) throw new Error(`${file} lacks the ${key} table markers`);
    doc = doc.slice(0, doc.indexOf(a) + a.length) + '\n' + text + '\n' + doc.slice(doc.indexOf(b));
  };
  for (const [key, table] of Object.entries(tables)) put(key, table);
  if (file !== 'docs/orbit-segment.md') { writeFileSync(docPath, doc); return; }
  // Worst position error of kind 4 by record length, one column per orbiter.
  const columns = [
    ['tradeoff-9002', 'Low lunar orbiter, synthetic'], ['tradeoff-real-lro', 'LRO, real'],
    ['tradeoff-9001', 'Low Earth orbiter, synthetic'], ['tradeoff-real-mro', 'MRO, real'],
    ['tradeoff-9003', 'Earth orbiter at e = 0.3, synthetic'], ['tradeoff-real-maven', 'MAVEN at e = 0.47, real'],
  ];
  const lengths = ['30 min', '1 h', '3 h', '6 h', '12 h', '1 d', '2 d', '3 d', '6 d'];
  const cells = columns.map(([key]) => {
    const [a, b] = [`<!-- ${key}:start -->`, `<!-- ${key}:end -->`];
    if (!doc.includes(a) || !doc.includes(b)) throw new Error(`docs/orbit-segment.md lacks the ${key} table markers`);
    const found = new Map();
    for (const line of doc.slice(doc.indexOf(a), doc.indexOf(b)).split('\n')) {
      const m = /^\| (\d+ (?:min|h|d)) \([^)]*\) \| [^|]* \| ([^|]*) \|/.exec(line);
      if (m) found.set(m[1], m[2].trim());
    }
    return found;
  });
  put('side-by-side', ['| Kind 4 record length | ' + columns.map((c) => c[1]).join(' | ') + ' |', '| --- |' + columns.map(() => ' --- |').join(''),
    ...lengths.map((len) => `| ${len} | ` + cells.map((c) => c.get(len) ?? 'not measured').join(' | ') + ' |')].join('\n'));
  writeFileSync(docPath, doc);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const kernelDir = process.env.SPICE_LITE_KERNELS ?? resolve(root, 'test/blobs/kernels');
  const config = JSON.parse(readFileSync(resolve(root, 'test/blobs/orbiter.json'), 'utf8'));
  const spice = await createSpiceEngine();
  for (const k of config.kernels) await spice.furnsh(k, new Uint8Array(readFileSync(resolve(kernelDir, k))));
  const t0 = await spice.str2et(config.window.start);
  const labels = { '-9001': 'Low Earth orbiter', '-9002': 'Low lunar orbiter', '-9003': 'Eccentric Earth orbiter' };
  const tables = {};
  for (const spec of config.synthetic) {
    // a long pad, so records that overhang the window still have truth under them
    await furnishSynthetic(spice, { ...spec, pad: 2 * DAY }, [t0, t0 + SPAN]);
    const el = spec.elements;
    const period = 2 * Math.PI * Math.sqrt(el.a ** 3 / spec.gm);
    const head = ({ best }) => `**${labels[spec.body]}** (synthetic; a = ${el.a} km, e = ${el.e}, period ${(period / 60).toFixed(1)} min). ` +
      (best ? `The smallest kind 1 segment on the grid with error under a millimeter is ${best}.` : '');
    tables[`tradeoff${spec.body}`] = await tradeoffTable(spice, { id: spec.body, center: spec.center, period, t0, head });
    console.log(tables[`tradeoff${spec.body}`] + '\n');
  }
  if (process.argv.includes('--update-doc')) updateDoc(tables);
  process.exit(0);
}
