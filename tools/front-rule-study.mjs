// How good is the rule lite_occulted uses to say which of two bodies is in
// front? The rule (src/spice_lite.c, occ_ellipsoids): `by` is in front when its
// tangent from the observer is shorter than the target's, both lengths taken
// in the space where `by` is the unit sphere and the target's along the line
// to its center. It is exact for two spheres and, SPEC.md says, a rule of
// thumb when two bodies that are not round nearly touch. This measures it.
//
// The truth needs no rule. Two convex bodies that do not intersect have a
// plane between them, so every line of sight that meets both meets the same
// one first: the one on the observer's side of the plane. The study finds
// lines of sight that meet both bodies by sampling, takes the distance along
// each to both surfaces, and compares what they say with the rule. It needs no
// kernels and no build:
//
//   node tools/front-rule-study.mjs [--update-doc]
//
// Random pairs of triaxial ellipsoids (axis ratios up to `ratio`) are set a
// given gap apart, as a fraction of the smaller body's mean radius, and seen
// from random directions and distances. A case counts when some line of sight
// meets both bodies (otherwise the answer is "none" whatever the rule says).

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let seed = 20261122;
const rnd = () => { seed = (Math.imul(seed ^ (seed >>> 15), 2246822519) + 0x9e3779b9) | 0; const t = Math.imul(seed ^ (seed >>> 13), 3266489917); return ((t ^ (t >>> 16)) >>> 0) / 4294967296; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = () => { for (;;) { const v = [2 * rnd() - 1, 2 * rnd() - 1, 2 * rnd() - 1], n = dot(v, v); if (n > 1e-3 && n <= 1) return v.map((x) => x / Math.sqrt(n)); } };
function rotation() { // a random rotation, rows orthonormal
  const a = unit(); let b = unit(); const d = dot(a, b); b = b.map((v, i) => v - d * a[i]); const n = Math.hypot(...b); b = b.map((v) => v / n);
  return [...a, ...b, a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export const toUnit = (E, x) => [0, 1, 2].map((k) => (E.rot[3 * k] * x[0] + E.rot[3 * k + 1] * x[1] + E.rot[3 * k + 2] * x[2]) / E.r[k]);
export const fromUnit = (E, y) => { const t = y.map((v, k) => v * E.r[k]); return [0, 1, 2].map((k) => E.rot[k] * t[0] + E.rot[3 + k] * t[1] + E.rot[6 + k] * t[2]); };
const shape = (size, ratio) => ({ r: [1, 2, 3].map(() => size * ratio ** -rnd()), rot: rotation() });

// Whether ellipsoid A at a and ellipsoid B at b share a point: the least value
// over A's surface of B's defining function, by sampling and local descent.
export function apart(A, a, B, b) {
  let best = Infinity, at = null;
  for (let i = 0; i < 400; i++) {
    const u = unit(), p = fromUnit(A, u).map((v, k) => v + a[k]), q = toUnit(B, sub(p, b)), val = dot(q, q);
    if (val < best) { best = val; at = u; }
  }
  for (let step = 0.2; step > 1e-6; step *= 0.7) {
    for (let i = 0; i < 8; i++) {
      const w = unit(); let u = at.map((v, k) => v + step * w[k]); const n = Math.hypot(...u); u = u.map((v) => v / n);
      const q = toUnit(B, sub(fromUnit(A, u).map((v, k) => v + a[k]), b)), val = dot(q, q);
      if (val < best) { best = val; at = u; }
    }
  }
  return best > 1;
}
// Distance along direction d (from the observer at the origin) to the surface of E at center c, or null.
export function reach(E, c, d) {
  const dc = toUnit(E, d), cc = toUnit(E, c), a = dot(dc, dc), h = dot(dc, cc), disc = h * h - a * (dot(cc, cc) - 1);
  return h > 0 && disc > 0 ? (h - Math.sqrt(disc)) / a : null;
}

// The exact test, as occ_front in src/spice_lite.c makes it: look for a plane
// with the two bodies on opposite sides, and see which side the observer is
// on. n is the plane's normal, from `by` toward the target; each body's
// farthest point along n (or against it) is its support point, in closed
// form. Start with the line of centers; while that fails, take the line
// between the two support points. Returns 1 (`by` is in front), 0 (it is not),
// or -1 (no plane found in `limit` tries), and the number of tries.
function support(E, n) { // the point of E, relative to its center, farthest along n
  const v = [0, 1, 2].map((k) => (E.rot[3 * k] * n[0] + E.rot[3 * k + 1] * n[1] + E.rot[3 * k + 2] * n[2]) * E.r[k]);
  const h = Math.hypot(...v);
  return fromUnit(E, v).map((x) => x / h);
}
export function frontByPlane(f, b, F, T, limit) {
  let n = sub(b, f);
  for (let it = 1; it <= limit; it++) {
    const sf = support(F, n), st = support(T, n);
    const pf = f.map((v, k) => v + sf[k]), pt = b.map((v, k) => v - st[k]);
    const d = sub(pt, pf);
    if (dot(n, d) > 0) return { front: dot(n, pt) > 0 && dot(n, pf) >= 0 ? 1 : 0, tries: it };
    // n and d are both differences of a point of the target and a point of
    // `by`; so is every point between them. Move to the shortest of those.
    const e = sub(n, d), lam = Math.min(1, dot(n, e) / dot(e, e));
    n = n.map((v, k) => v - lam * e[k]);
  }
  return { front: -1, tries: limit };
}

function study(gap, ratio, cases) {
  let n = 0, wrong = 0, mixed = 0, planeWrong = 0, undecided = 0, tries = 0, most = 0;
  while (n < cases) {
    const T = shape(1, ratio), F = shape(10 ** (-rnd()), ratio), small = (F.r[0] + F.r[1] + F.r[2]) / 3;
    // Put F beside T along a random line: slide it in until they touch, then back off by the gap.
    const u = unit();
    let lo = 0, hi = 8;
    for (let i = 0; i < 22; i++) { const mid = 0.5 * (lo + hi); if (apart(F, u.map((v) => v * mid), T, [0, 0, 0])) hi = mid; else lo = mid; }
    const centerF = u.map((v) => v * (hi + gap * small));
    for (let look = 0; look < 40 && n < cases; look++) {
      const dir = unit(), o = dir.map((v, k) => v * 10 ** (0.3 + 1.7 * rnd()) + 0.5 * centerF[k]);
      const f = sub(centerF, o), b = sub([0, 0, 0], o);
      const c = toUnit(F, f), bt = toUnit(T, b), t = toUnit(F, b);
      const n2 = dot(c, c), m2 = dot(bt, bt);
      if (!(n2 > 1.0001) || !(m2 > 1.0001)) continue;
      const rule = n2 - 1 < dot(t, t) * (1 - 1 / m2); // the library's test, as written there
      // Lines of sight that meet both: directions to random points inside F.
      let frontF = 0, frontT = 0;
      for (let i = 0; i < 600; i++) {
        const w = unit(), s = Math.cbrt(rnd()), d = fromUnit(F, c.map((v, k) => v + s * w[k]));
        const sf = reach(F, f, d), st = reach(T, b, d);
        if (sf === null || st === null) continue;
        if (sf < st) frontF++; else frontT++;
      }
      if (frontF + frontT === 0) continue;
      n++;
      if (frontF && frontT) { mixed++; continue; }
      if ((frontF > 0) !== rule) wrong++;
      const plane = frontByPlane(f, b, F, T, LIMIT);
      if (plane.front < 0) undecided++;
      else if ((plane.front === 1) !== (frontF > 0)) planeWrong++;
      tries += plane.tries; most = Math.max(most, plane.tries);
    }
  }
  return { n, wrong, mixed, planeWrong, undecided, tries: tries / n, most };
}

export const LIMIT = 16; // OCC_FRONT_MAX in src/spice_lite.c
if (import.meta.url === `file://${process.argv[1]}`) {
  const gaps = [3, 1, 0.3, 0.1, 0.03, 0.01];
  const ratios = [1, 1.2, 2, 5];
  const rows = [], planeRows = [];
  let impossible = 0;
  for (const gap of gaps) {
    const cells = [], planeCells = [];
    for (const ratio of ratios) {
      const r = study(gap, ratio, 2000);
      impossible += r.mixed;
      cells.push(`${r.wrong} of ${r.n}`);
      planeCells.push(`${r.planeWrong} wrong, ${r.undecided} undecided; ${r.tries.toFixed(2)} tries, at most ${r.most}`);
    }
    rows.push(`| ${gap} | ${cells.join(' | ')} |`);
    planeRows.push(`| ${gap} | ${planeCells.join(' | ')} |`);
  }
  const table = ['| Gap between the surfaces, as a fraction of the smaller body\'s mean radius | Spheres | Axis ratios to 1.2 | To 2 | To 5 |', '| --- | --- | --- | --- | --- |', ...rows].join('\n');
  const planeTable = ['| Gap | Spheres | Axis ratios to 1.2 | To 2 | To 5 |', '| --- | --- | --- | --- | --- |', ...planeRows].join('\n');
  console.log(table + '\n\n' + planeTable);
  console.log(`\n${impossible} cases in which lines of sight disagreed with one another (there should be none: the bodies do not intersect)`);
  if (process.argv.includes('--update-doc')) {
    const path = resolve(root, 'docs/cost-measurements.md');
    const doc = readFileSync(path, 'utf8'), [a, b] = ['<!-- front-rule-table:start -->', '<!-- front-rule-table:end -->'];
    if (!doc.includes(a) || !doc.includes(b)) throw new Error('docs/cost-measurements.md lacks the front-rule table markers');
    writeFileSync(path, doc.slice(0, doc.indexOf(a) + a.length) + '\n' + table + '\n' + doc.slice(doc.indexOf(b)));
  }
}
