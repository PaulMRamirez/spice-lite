// Two follow-up studies on the real orbiters of tools/real-kernels.json, after
// tools/real-kernels.mjs showed that the compact orbit segment (EPHEM kind 4)
// holds kilometers, not meters, on a real orbit:
//
//   1. What a Chebyshev segment (kind 1) costs in bytes at a given accuracy when
//      its degree is kept at 22 or below, the highest degree whose evaluation
//      stays inside the one-segment cost ceiling (scripts/measure-cost-degree.mjs).
//   2. A prototype of what terms at the central body's rotation would add to
//      kind 4. It changes nothing in the format or the library: the extra terms
//      are fitted on the ground only, to see what they would buy.
//
//   node tools/real-orbit-study.mjs [--update-doc]
//
// Needs the kernels fetched by `node tools/real-kernels.mjs --fetch`. With
// --update-doc, rewrites the two tables of docs/orbit-segment.md.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSpiceEngine } from 'cspice-wasm';
import { sliceEphem } from './slicer.mjs';
import { sliceOrbit, fitRecord, orbitEval, osculating, RECORD_BYTES } from './orbit-model.mjs';
import { updateDoc, dist } from './orbit-tradeoff.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.env.SPICE_LITE_REAL_KERNELS ?? resolve(root, 'kernels/real');
const config = JSON.parse(readFileSync(resolve(root, 'tools/real-kernels.json'), 'utf8'));
const DAY = 86400;
// The highest degree of kind 1 tried: a one-segment state at degree 22 costs
// 2,234 instructions in a blob of two bodies (scripts/measure-cost-degree.mjs)
// and about 180 more in the largest test blob, inside the ceiling of 2,500;
// degree 24 would not be.
const MAX_DEGREE = 22;
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const mins = (s) => (s >= 3600 && s % 3600 === 0 ? `${s / 3600} h` : `${Math.round(s / 60)} min`);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const n = Math.hypot(...a); return a.map((v) => v / n); };

// Solves M x = b by Gaussian elimination with partial pivoting.
function solve(M, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k < n; k++) M[r][k] -= f * M[c][k]; b[r] -= f * b[c]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = b[r]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}

// Extra terms tried on top of a kind 4 record: displacements along the radial,
// along-track, and cross-track directions, each a cosine and a sine of
// k u + m theta, with u the argument of latitude and theta the angle the body
// has turned since the record's mid epoch. k = 0 gives the "daily" terms.
const mixed = (ms, ks) => [].concat(...ms.map((m) => [[0, m], ...[].concat(...ks.map((k) => [[k, m], [k, -m]]))]));
const SETS = [
  ['kind 4 as it is', []],
  ['with daily terms at one and two turns of the body', [[0, 1], [0, 2]]],
  ['with those and mixed terms, k to 2 and m to 2', mixed([1, 2], [1, 2])],
  ['with daily and mixed terms, k to 3 and m to 4', mixed([1, 2, 3, 4], [1, 2, 3])],
];

const kind1Rows = [], rotationRows = [];
for (const o of config.orbiters) {
  const spice = await createSpiceEngine();
  for (const name of o.kernels) {
    const path = resolve(dir, name);
    if (!existsSync(path)) throw new Error(`${path} is missing; run node tools/real-kernels.mjs --fetch`);
    await spice.furnsh(name, new Uint8Array(readFileSync(path)));
  }
  const t0 = await spice.str2et(o.start);
  const state = async (t) => {
    const s = await spice.spkezr(String(o.body), t, 'J2000', 'NONE', String(o.center));
    return [s.position.x, s.position.y, s.position.z, s.velocity.x, s.velocity.y, s.velocity.z];
  };
  let a = 0;
  for (let j = 0; j < 720; j++) a += osculating(await state(t0 + (DAY * (j + 0.5)) / 720), o.gm)[0] / 720;
  const period = 2 * Math.PI * Math.sqrt(a ** 3 / o.gm);

  // ---- 1. kind 1 within the degree cap, over the first day of the window ----
  const cheb = [];
  for (const frac of [1 / 32, 1 / 24, 1 / 16, 1 / 12, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 1]) {
    const interval = Math.max(60, Math.round((frac * period) / 30) * 30);
    for (let degree = 4; degree <= MAX_DEGREE; degree += 2) {
      const seg = await sliceEphem(spice, { id: o.body, interval, degree, checks: 4 * (degree + 1) }, [t0, t0 + DAY], o.center);
      cheb.push({ interval, degree, err: seg.maxPosErr, perDay: (24 * (degree + 1) * DAY) / interval });
    }
  }
  const orbit = [];
  for (const interval of [1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, DAY]) {
    const seg = await sliceOrbit(spice, { id: o.body, interval }, [t0, t0 + DAY], o.center);
    orbit.push({ interval, err: seg.maxPosErr, perDay: (RECORD_BYTES * DAY) / interval });
  }
  for (const [label, target] of [['1 km', 1], ['100 m', 0.1], ['10 m', 0.01], ['1 m', 1e-3], ['0.1 m', 1e-4]]) {
    const c = cheb.filter((x) => x.err <= target).sort((x, y) => x.perDay - y.perDay)[0];
    const k = orbit.filter((x) => x.err <= target).sort((x, y) => x.perDay - y.perDay)[0];
    kind1Rows.push(`| ${o.label} | ${label} | ${c ? `${fmt(c.perDay)} (degree ${c.degree}, ${mins(c.interval)} records, ${dist(c.err)})` : 'none on the grid'} | ${k ? `${fmt(k.perDay)} (${mins(k.interval)} records, ${dist(k.err)})` : 'not reached at any record length'} |`);
  }

  // ---- 2. terms at the body's rotation, on the first record of the window ----
  for (const hours of [6, 24]) {
    const dt = hours * 3600, tm = t0 + dt / 2;
    const nFit = Math.min(720, Math.max(48, Math.ceil(dt / 60)));
    const sample = async (n) => {
      const out = [];
      for (let j = 0; j <= n; j++) {
        const tau = (j / n - 0.5) * dt, s = await state(tm + tau);
        const r = s.slice(0, 3), rh = unit(r), wh = unit(cross(r, s.slice(3))), th = cross(wh, rh), nh = unit(cross([0, 0, 1], wh));
        out.push({ tau, s, dirs: [rh, th, wh], u: Math.atan2(dot(r, cross(wh, nh)), dot(r, nh)) });
      }
      return out;
    };
    const fitS = await sample(nFit), check = await sample(4 * nFit);
    const basis = (q, set) => { const b = []; for (const [k, m] of set) { const ang = k * q.u + m * o.rotation * q.tau; b.push(Math.cos(ang), Math.sin(ang)); } return b; };
    const cells = [];
    for (const [, set] of SETS) {
      // Alternate: the record is fitted to the trajectory less the extra terms,
      // then the extra terms, which enter linearly, to what the record leaves.
      const nb = 2 * set.length;
      let coef = null, p = null;
      const extra = (q) => {
        const d = [0, 0, 0];
        if (!coef) return d;
        const b = basis(q, set);
        for (let c = 0; c < 3; c++) { let v = 0; for (let i = 0; i < nb; i++) v += coef[c][i] * b[i]; for (let k = 0; k < 3; k++) d[k] += v * q.dirs[c][k]; }
        return d;
      };
      for (let round = 0; round < (set.length ? 8 : 1); round++) {
        p = fitRecord(fitS.map((q) => { const e = extra(q); return { tau: q.tau, s: [q.s[0] - e[0], q.s[1] - e[1], q.s[2] - e[2], q.s[3], q.s[4], q.s[5]] }; }), o.gm, dt / 2, { iterations: round ? 15 : 40 });
        if (!set.length) break;
        coef = [];
        for (let c = 0; c < 3; c++) {
          const M = Array.from({ length: nb }, () => new Array(nb).fill(0)), bv = new Array(nb).fill(0);
          for (const q of fitS) {
            const m = orbitEval(p, q.tau), res = dot([q.s[0] - m[0], q.s[1] - m[1], q.s[2] - m[2]], q.dirs[c]), b = basis(q, set);
            for (let i = 0; i < nb; i++) { bv[i] += b[i] * res; for (let j = 0; j < nb; j++) M[i][j] += b[i] * b[j]; }
          }
          for (let i = 0; i < nb; i++) M[i][i] *= 1 + 1e-9;
          coef.push(solve(M, bv));
        }
      }
      let worst = 0;
      for (const q of check) { const m = orbitEval(p, q.tau), e = extra(q); worst = Math.max(worst, Math.hypot(m[0] + e[0] - q.s[0], m[1] + e[1] - q.s[1], m[2] + e[2] - q.s[2])); }
      cells.push(dist(worst));
    }
    rotationRows.push(`| ${o.label} | ${hours} h | ${cells.join(' | ')} |`);
  }
}

const tables = {
  'kind1-real': [`| Orbiter | Worst position error wanted | Smallest kind 1 at degree ${MAX_DEGREE} or below, bytes per day | Smallest kind 4, bytes per day |`, '| --- | --- | --- | --- |', ...kind1Rows].join('\n'),
  'rotation-terms': [`| Orbiter | One record of | ${SETS.map(([label, set]) => (set.length ? `${label} (${6 * set.length} more numbers)` : label)).join(' | ')} |`, `| --- | --- |${SETS.map(() => ' --- |').join('')}`, ...rotationRows].join('\n'),
};
console.log(tables['kind1-real'] + '\n\n' + tables['rotation-terms']);
if (process.argv.includes('--update-doc')) updateDoc(tables);
process.exit(0);
