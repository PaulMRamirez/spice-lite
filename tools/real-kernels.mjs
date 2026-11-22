// Measures the compact orbit segment (EPHEM kind 4) and the clock mapping (TIME
// pieces from an SCLK kernel) on real mission kernels: the orbiters and clocks
// listed in tools/real-kernels.json. Prints the tables of docs/orbit-segment.md
// that carry real data and the clock table of docs/real-kernels.md; with
// --update-doc, rewrites them there.
//
//   node tools/real-kernels.mjs --fetch         download the kernels (curl) and check their hashes
//   node tools/real-kernels.mjs [--update-doc]  measure
//   node tools/real-kernels.mjs --clocks [--update-doc]  measure the clocks only
//   node tools/real-kernels.mjs --burn [--update-doc]    measure only the day that holds a maneuver, with and without breaks
//
// The kernels are public NAIF products and are never committed here. They live
// in the directory named by SPICE_LITE_REAL_KERNELS (default: kernels/real under
// the repository root, which .gitignore excludes), about 185 MB in all.

import { readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSpiceEngine } from 'cspice-wasm';
import { sliceOrbit, osculating } from './orbit-model.mjs';
import { readSclk, sclkTimePieces } from './sclk-time.mjs';
import { tradeoffTable, updateDoc, dist } from './orbit-tradeoff.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.env.SPICE_LITE_REAL_KERNELS ?? resolve(root, 'kernels/real');
const config = JSON.parse(readFileSync(resolve(root, 'tools/real-kernels.json'), 'utf8'));
const DAY = 86400;
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

if (process.argv.includes('--fetch')) {
  mkdirSync(dir, { recursive: true });
  for (const [name, k] of Object.entries(config.kernels)) {
    const path = resolve(dir, name);
    if (!existsSync(path)) {
      console.log(`fetching ${k.url}`);
      execFileSync('curl', ['-fsS', '--retry', '3', '-o', path + '.part', k.url], { stdio: 'inherit' });
      renameSync(path + '.part', path);
    }
    if (sha(path) !== k.sha256) throw new Error(`${name}: SHA-256 ${sha(path)} is not the ${k.sha256} recorded in tools/real-kernels.json`);
    console.log(`${name}: ok`);
  }
  process.exit(0);
}

async function engine(names) {
  const spice = await createSpiceEngine();
  for (const name of names) {
    const path = resolve(dir, name);
    if (!existsSync(path)) throw new Error(`${path} is missing; run node tools/real-kernels.mjs --fetch`);
    if (sha(path) !== config.kernels[name].sha256) throw new Error(`${name}: not the file recorded in tools/real-kernels.json`);
    await spice.furnsh(name, new Uint8Array(readFileSync(path)));
  }
  return spice;
}

const tables = {};
const clockTables = {};

// ---- orbiters -----------------------------------------------------------------

const only = ['--clocks', '--burn'].find((f) => process.argv.includes(f));
for (const o of only ? [] : config.orbiters) {
  const spice = await engine(o.kernels);
  const t0 = await spice.str2et(o.start);
  const state = async (t) => {
    const s = await spice.spkezr(String(o.body), t, 'J2000', 'NONE', String(o.center));
    return [s.position.x, s.position.y, s.position.z, s.velocity.x, s.velocity.y, s.velocity.z];
  };
  // Mean elements over a span, as plain averages of the osculating ones.
  const mean = async (ta, tb, n) => {
    let a = 0, e = 0;
    for (let j = 0; j < n; j++) {
      const q = osculating(await state(ta + ((tb - ta) * (j + 0.5)) / n), o.gm);
      a += q[0] / n; e += Math.hypot(q[1], q[2]) / n;
    }
    return { a, e };
  };
  const day = await mean(t0, t0 + DAY, 1440);
  const period = 2 * Math.PI * Math.sqrt(day.a ** 3 / o.gm);
  // The largest step in orbit-mean semi-major axis from one orbit to the next
  // across the window: a burn shows as a step far above the natural wander.
  const wander = async (ta, tb) => {
    let prev = null, worst = 0;
    for (let t = ta; t + period <= tb; t += period) {
      const m = (await mean(t, t + period, 120)).a;
      if (prev !== null) worst = Math.max(worst, Math.abs(m - prev));
      prev = m;
    }
    return worst;
  };
  const span = (o.spanDays ?? 6) * DAY;
  const step = await wander(t0, t0 + span);
  // Seams: a reconstructed kernel is a chain of separate orbit solutions, and
  // the position can step where one hands over to the next. Found by walking
  // the span in 5 s steps and comparing each step in position with what the
  // two velocities and the point-mass accelerations at its ends predict (a
  // Hermite step, good to centimeters here); a mismatch over 0.2 m is a seam.
  const accel = (s) => { const r = Math.hypot(s[0], s[1], s[2]); return [0, 1, 2].map((k) => (-o.gm * s[k]) / r ** 3); };
  const seams = async (ta, tb) => {
    const h = 5;
    let prev = await state(ta), ap = accel(prev), worst = 0, count = 0;
    for (let t = ta + h; t <= tb; t += h) {
      const s = await state(t), a = accel(s);
      const d = Math.hypot(...[0, 1, 2].map((k) => s[k] - prev[k] - (h / 2) * (s[k + 3] + prev[k + 3]) + ((h * h) / 12) * (a[k] - ap[k])));
      if (d > 2e-4) { count++; worst = Math.max(worst, d); }
      prev = s; ap = a;
    }
    return { count, worst };
  };
  const inside = await seams(t0, t0 + span);
  const around = await seams(t0 - 3 * DAY, t0 + span + 3 * DAY);
  const seamText = inside.count ? `the kernel itself steps in position at ${inside.count} seams inside the window, by up to ${dist(inside.worst)}`
    : around.count ? `the window was placed between the seams of the kernel, which steps in position by up to ${dist(around.worst)} where one orbit solution hands over to the next (${around.count} such seams within three days of the window)`
      : 'the kernel has no seam (a step in position between orbit solutions) within three days of the window';
  let burn = '';
  if (o.burn) {
    const tb = await spice.str2et(o.burn);
    const seg = await sliceOrbit(spice, { id: o.body, interval: DAY }, [tb, tb + DAY], o.center);
    burn = ` For contrast, the day from ${o.burn.slice(0, 10)} holds a station-keeping maneuver (the orbit-mean semi-major axis steps by ${dist(await wander(tb, tb + DAY))}), and one record across it fits to ${dist(seg.maxPosErr)}.`;
  }
  const days = span / DAY;
  const head = ({ best, finest }) => `**${o.label}** (real; ${days === 1 ? 'one day' : `${days} days`} from ${o.start.replace('T', ' ').slice(0, 16)} UTC, mean a = ${day.a.toFixed(1)} km, mean e = ${day.e.toFixed(4)}, period ${(period / 60).toFixed(1)} min). The orbit-mean semi-major axis moves by at most ${dist(step)} from one orbit to the next, so the window holds no maneuver; ${seamText}. ` +
    (best ? `The smallest kind 1 segment on the grid with error under a millimeter is ${best}.` : `No kind 1 segment on the grid reaches a millimeter; the most accurate is ${finest}.`) + burn;
  tables[`tradeoff-real-${o.key}`] = await tradeoffTable(spice, { id: o.body, center: o.center, period, t0, head, span });
  console.log(tables[`tradeoff-real-${o.key}`] + '\n');
}

// ---- a maneuver, with and without breaks ---------------------------------------

// The day named by "burn", cut as one stretch and as the stretches between
// "burnBreaks", the way the slicer cuts a body that has "breaks".
for (const o of only && only !== '--burn' ? [] : config.orbiters.filter((q) => q.burnBreaks)) {
  const spice = await engine(o.kernels);
  const t0 = await spice.str2et(o.burn);
  const edges = [t0];
  for (const utc of o.burnBreaks) edges.push(await spice.str2et(utc));
  edges.push(t0 + DAY);
  const rows = [];
  for (const want of [1800, 3600, 3 * 3600, 6 * 3600]) {
    const whole = await sliceOrbit(spice, { id: o.body, interval: want }, [t0, t0 + DAY], o.center);
    let worst = 0, records = 0;
    for (let i = 0; i + 1 < edges.length; i++) {
      const [a, z] = [edges[i], edges[i + 1]];
      const n = Math.max(1, Math.round((z - a) / want));
      let interval = (z - a) / n;
      while (a + n * interval < z) interval += interval * Number.EPSILON;
      const seg = await sliceOrbit(spice, { id: o.body, interval }, [a, a + n * interval], o.center);
      worst = Math.max(worst, seg.maxPosErr);
      records += seg.recordCount;
    }
    rows.push(`| ${want >= 3600 ? `${want / 3600} h` : `${want / 60} min`} | ${whole.recordCount} | ${dist(whole.maxPosErr)} | ${records} | ${dist(worst)} |`);
  }
  tables['burn-real'] = [`**${o.label}, the day from ${o.burn.slice(0, 10)}**, which holds two burns of about 110 seconds each (${o.burnBreaks.map((b) => b.slice(11)).join(', ')} UTC are their starts and ends).`, '',
    '| Record length asked for | Records, unbroken | Worst position error, unbroken | Records, with breaks | Worst position error, with breaks |', '| --- | --- | --- | --- | --- |', ...rows].join('\n');
  console.log(tables['burn-real'] + '\n');
}

// ---- clocks -------------------------------------------------------------------

const rows = [];
for (const c of only && only !== '--clocks' ? [] : config.clocks) {
  const spice = await engine(c.kernels);
  const t0 = await spice.str2et(c.start);
  const clock = await readSclk(spice, c.sclk);
  for (const days of [1, 30]) {
    for (const tol of [1e-6, 1e-3]) {
      const window = [t0, t0 + days * DAY];
      const { fit } = await sclkTimePieces(spice, { base: 3, sclk: c.sclk, maxErrorSeconds: tol, maxPieces: 4096 }, window);
      const merged = (await sclkTimePieces(spice, { base: 3, sclk: c.sclk, maxErrorSeconds: tol, maxPieces: 4096, mergeRecords: true }, window)).fit;
      // coefficient records of the kernel that begin inside the window
      const e0 = await spice.sce2c(c.sclk, t0), e1 = await spice.sce2c(c.sclk, t0 + days * DAY);
      const inside = clock.recordStarts.filter((r) => r > e0 && r <= e1).length;
      rows.push(`| ${c.label} | ${days} d from ${c.start.slice(0, 10)} | ${tol === 1e-6 ? '1 microsecond' : '1 millisecond'} | ${inside} | ${fit.pieces} | ${fit.pieces * 32} | ${(fit.maxErrSeconds * 1e6).toFixed(2)} microseconds | ${merged.pieces} | ${(merged.maxErrSeconds * 1e6).toFixed(2)} microseconds |`);
    }
  }
  console.log(`${c.label}: 1/${clock.ticksPerCount} s ticks, ${clock.partitions.length} partitions, ${clock.recordStarts.length} coefficient records, on ${clock.timeSystem === 2 ? 'TT' : 'TDB'}`);
}
if (rows.length) clockTables['clocks-real'] = ['| Clock | Window | Tolerance asked | Kernel records that begin inside | Pieces | TIME bytes | Worst error against CSPICE | Pieces with `mergeRecords` | Worst error with it |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |', ...rows].join('\n');
if (rows.length) console.log(clockTables['clocks-real']);

if (process.argv.includes('--update-doc')) {
  if (Object.keys(tables).length) updateDoc(tables);
  if (Object.keys(clockTables).length) updateDoc(clockTables, 'docs/real-kernels.md');
}
process.exit(0);
