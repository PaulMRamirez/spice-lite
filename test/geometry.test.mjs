// Sub-points and occultation (lite_sub_point, lite_occulted), checked five ways:
// against full CSPICE (subpnt_c with NEAR POINT/ELLIPSOID and occult_c with
// ELLIPSOID shapes, both with no aberration correction), against the geometry
// itself with no kernels at all (for occultation, a brute-force model that
// shares no method with the library), bit for bit between the WebAssembly and
// native builds, and for status codes on requests that cannot be served.
//
// Two blobs carry the geometry. `eclipses` holds the Sun, Earth, and Moon across
// the partial solar eclipse of 2004-10-14 and the total lunar eclipse of
// 2004-10-28, a triaxial stand-in (the Mars barycenter with the radii and
// orientation of Phobos, because the kernels have no ephemeris for a triaxial
// body), and a spacecraft with no trajectory that the tests place with
// lite_set_state. `saturn-soi` holds Saturn and Cassini's predicted trajectory
// for the day of orbit insertion, when Saturn hid the Sun and the Earth from
// the spacecraft.
//
// An occultation answer may differ from CSPICE's only where the blob's declared
// errors leave the answer unsettled; `judge` below computes that from the
// report, case by case, and nothing in it is fitted to the results.
//
// The CSPICE tests need the kernels: set SPICE_LITE_KERNELS to their directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { load, runAll, prng, root } from './harness.mjs';

const kernelDir = process.env.SPICE_LITE_KERNELS;
const read = (name) => ({
  config: JSON.parse(readFileSync(resolve(root, `test/blobs/${name}.json`), 'utf8')),
  report: JSON.parse(readFileSync(resolve(root, `test/blobs/${name}.report.json`), 'utf8')),
  blob: new Uint8Array(readFileSync(resolve(root, `test/blobs/${name}.slb`))),
  path: resolve(root, `test/blobs/${name}.slb`),
});
const ecl = read('eclipses');
const soi = read('saturn-soi');
const have = kernelDir && [...ecl.config.kernels, ...soi.config.kernels].every((k) => existsSync(resolve(kernelDir, k)));
const skip = !have && 'SPICE_LITE_KERNELS is not set or lacks the kernels';

const SLACK = 1.5; // as in the accuracy tier: the slicer's error grid and these times differ
const SC = -900; // the spacecraft of the eclipses blob
const STANDIN = 4; // the Mars barycenter, carrying the shape of Phobos

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vec = (p) => [p.x, p.y, p.z];
const mean = (r) => (r[0] + r[1] + r[2]) / 3;

// What each blob body is called on the CSPICE side.
const NAMES = { 10: ['SUN', 'IAU_SUN'], 301: ['MOON', 'IAU_MOON'], 399: ['EARTH', 'IAU_EARTH'], 4: ['PHOBOS', 'IAU_PHOBOS'], 699: ['SATURN', 'IAU_SATURN'] };

function boundsOf({ config, report }) {
  const parentOf = new Map(config.bodies.map((b) => [b.id, b.parent]));
  const posErr = new Map(report.ephem.map((s) => [s.target, s.maxPosErr]));
  const chain = (a, b) => {
    let sum = 0;
    for (const start of [a, b]) for (let id = start; parentOf.get(id) != null; id = parentOf.get(id)) sum += posErr.get(id) ?? 0;
    return SLACK * sum;
  };
  const orientErr = (body) => SLACK * report.orient.find((s) => s.body === body).maxErr;
  return { chain, orientErr };
}

// The BODY entry of a body inside a blob, for tests that change its radii.
function bodyEntry(blob, naif) {
  const v = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  for (let i = 0; i < v.getUint16(20, true); i++) {
    const e = 64 + 16 * i;
    if (v.getUint16(e, true) !== 2) continue;
    const off = v.getUint32(e + 4, true), count = v.getUint32(e + 12, true);
    for (let k = 0; k < count; k++) if (v.getInt32(off + 32 * k, true) === naif) return off + 32 * k;
  }
  throw new Error(`body ${naif} is not in the blob`);
}
function withRadii(blob, naif, radii, flags) {
  const copy = blob.slice();
  const v = new DataView(copy.buffer);
  const e = bodyEntry(copy, naif);
  if (flags !== undefined) v.setUint16(e + 6, flags, true);
  radii.forEach((r, k) => v.setFloat64(e + 8 + 8 * k, r, true));
  return copy;
}
const radiiIn = (blob, naif) => { const v = new DataView(blob.buffer, blob.byteOffset), e = bodyEntry(blob, naif); return [0, 1, 2].map((k) => v.getFloat64(e + 8 + 8 * k, true)); };

// ---- CSPICE side ------------------------------------------------------------

let spiceEcl, spiceSoi, serial = 0;
async function engine(config, standIn) {
  const { createSpiceEngine } = await import('cspice-wasm');
  const spice = await createSpiceEngine();
  for (const k of config.kernels) await spice.furnsh(k, new Uint8Array(readFileSync(resolve(kernelDir, k))));
  if (standIn) {
    // Phobos, at rest at the Mars barycenter for the year the planetary kernel covers.
    const t = [await spice.str2et('2004-01-02T00:00:00'), await spice.str2et('2004-12-30T00:00:00')];
    await spice.writeSpkType13('standin.bsp', 401, 4, 'J2000', 'stand-in', 1, Float64Array.from(t), new Float64Array(12));
  }
  return spice;
}
async function setup() {
  if (spiceEcl) return;
  spiceEcl = await engine(ecl.config, true);
  spiceSoi = await engine(soi.config, false);
}

// Gives CSPICE a spacecraft that sits at positions[i] relative to center at
// times[i]: one SPK type 13 segment whose states are those positions at rest.
// The library gets the same positions through lite_set_state.
async function placeSpacecraft(spice, center, times, positions) {
  const id = -901 - serial++;
  const states = new Float64Array(6 * times.length);
  positions.forEach((p, i) => states.set(p, 6 * i));
  await spice.writeSpkType13(`sc${-id}.bsp`, id, center, 'J2000', 'placed', 1, Float64Array.from(times), states);
  const back = vec((await spice.spkpos(String(id), times[1], 'J2000', 'NONE', String(center))).position);
  assert.deepEqual(back, positions[1], 'CSPICE returns the placed position exactly');
  return String(id);
}

async function truthSubPoint(spice, body, observer, et) {
  const [name, frame] = NAMES[body];
  const r = await spice.subpnt('NEAR POINT/ELLIPSOID', name, et, frame, 'NONE', String(observer));
  const q = vec(r.point);
  return { q, lon: Math.atan2(q[1], q[0]), lat: Math.atan2(q[2], Math.hypot(q[0], q[1])), alt: norm(vec(r.srfvec)) };
}
// The surface point a planetocentric longitude and latitude name.
function surfacePoint(radii, lon, lat) {
  const d = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  const rho = 1 / Math.hypot(d[0] / radii[0], d[1] / radii[1], d[2] / radii[2]);
  return d.map((v) => v * rho);
}
// The code lite_occulted should give for target hidden by `by`, from CSPICE.
async function truthOcculted(spice, target, by, observer, et) {
  const [n1, f1] = NAMES[target], [n2, f2] = NAMES[by];
  const c = await spice.occult(n1, 'ELLIPSOID', f1, n2, 'ELLIPSOID', f2, 'NONE', String(observer), et);
  return c < 0 ? -c : 0;
}
// An independent model of what the observer sees, by brute force: the front
// body's limb is traced point by point and each point's angle from the target's
// center is compared with the target's angular radius, in the space where the
// target is the unit sphere (a linear map keeps lines through the observer
// straight, so who hides whom is unchanged). The library decides the same
// question algebraically, so the two share no method. A shape is
// { r: three semi-axes, rot: J2000 to body-fixed, row-major, or null for a sphere }.
// f and b are the centers of the front body and the target relative to the
// observer. Returns the code, or -1 when the observer is inside a body.
function limbModel(f, b, F, T) {
  const toUnit = (E, x) => (E.rot ? [0, 1, 2].map((k) => E.rot[3 * k] * x[0] + E.rot[3 * k + 1] * x[1] + E.rot[3 * k + 2] * x[2]) : x).map((v, k) => v / E.r[k]);
  const fromUnit = (E, y) => { const t = y.map((v, k) => v * E.r[k]); return E.rot ? [0, 1, 2].map((k) => E.rot[k] * t[0] + E.rot[3 + k] * t[1] + E.rot[6 + k] * t[2]) : t; };
  const c = toUnit(F, f), bt = toUnit(T, b), t = toUnit(F, b);
  const n2 = dot(c, c), m2 = dot(bt, bt);
  if (!(n2 > 1) || !(m2 > 1)) return -1;
  if (!(n2 - 1 < dot(t, t) * (1 - 1 / m2))) return 0; // the front body's tangent is not the shorter one: it is not in front
  let e1 = cross(c, [0.3, -0.5, 0.8]); e1 = e1.map((v) => v / norm(e1));
  let e2 = cross(c, e1); e2 = e2.map((v) => v / norm(e2));
  const [l0, l1, l2] = [c.map((v) => v * Math.sqrt((n2 - 1) / n2)), e1, e2].map((d) => toUnit(T, fromUnit(F, d)));
  const angle = (phi) => {
    const cp = Math.cos(phi), sp = Math.sin(phi);
    const y = [l0[0] + cp * l1[0] + sp * l2[0], l0[1] + cp * l1[1] + sp * l2[1], l0[2] + cp * l1[2] + sp * l2[2]];
    return Math.atan2(norm(cross(bt, y)), dot(bt, y));
  };
  const N = 240, step = (2 * Math.PI) / N, a = [];
  for (let i = 0; i < N; i++) a.push(angle(i * step));
  const refine = (lo, hi, sign) => { // golden section for the least (sign 1) or greatest (sign -1) angle in [lo, hi]
    const G = 0.3819660112501051;
    let x1 = lo + G * (hi - lo), x2 = hi - G * (hi - lo), f1 = sign * angle(x1), f2 = sign * angle(x2);
    for (let i = 0; i < 44; i++) {
      if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = lo + G * (hi - lo); f1 = sign * angle(x1); } else { lo = x1; x1 = x2; f1 = f2; x2 = hi - G * (hi - lo); f2 = sign * angle(x2); }
    }
    return sign * Math.min(f1, f2);
  };
  let least = Infinity, greatest = -Infinity;
  for (let i = 0; i < N; i++) {
    const p = a[(i + N - 1) % N], q = a[(i + 1) % N];
    if (a[i] <= p && a[i] <= q) least = Math.min(least, refine((i - 1) * step, (i + 1) * step, 1));
    if (a[i] >= p && a[i] >= q) greatest = Math.max(greatest, refine((i - 1) * step, (i + 1) * step, -1));
  }
  const size = Math.asin(1 / Math.sqrt(m2));
  if (least >= size) return dot(t, c) > Math.sqrt((n2 - 1) * dot(t, t)) ? 3 : 0; // the limb stays clear of the target: all of it hidden, or none
  return greatest <= size ? 2 : 1;
}
const scaled = (E, factor) => ({ r: E.r.map((v) => v * factor), rot: E.rot });
const sphereOf = (radii) => ({ r: [mean(radii), mean(radii), mean(radii)], rot: null });
const isRound = (radii) => radii[0] === radii[1] && radii[1] === radii[2];
// Whether the model's answer is unsettled by errors of size errF and errT (km,
// any direction, any small turn) in where the two bodies' surfaces are: grow
// and shrink each body by its error (scaling by 1 +- err / least radius covers
// every surface within err of the nominal one) and see whether any of the four
// combinations changes the code. Each code is monotonic in each body's extent,
// so a code that survives all four survives everything in between.
function unsettled(f, b, F, T, errF, errT, code = limbModel(f, b, F, T)) {
  const eF = errF / Math.min(...F.r), eT = errT / Math.min(...T.r);
  if (!(eF < 1) || !(eT < 1)) return true;
  for (const sF of [1 - eF, 1 + eF]) for (const sT of [1 - eT, 1 + eT]) if (limbModel(f, b, scaled(F, sF), scaled(T, sT)) !== code) return true;
  return false;
}

// A third opinion that shares nothing with the model above but the two frame
// maps: 3,000 lines of sight to the target's limb, each tested against the front
// body as a ray against a sphere in the space where that body is the unit
// sphere. It tells none, partial, and full apart (it does not look for a
// transit), to the resolution of its sampling.
function raySample(f, b, F, T) {
  const toUnit = (E, x) => (E.rot ? [0, 1, 2].map((k) => E.rot[3 * k] * x[0] + E.rot[3 * k + 1] * x[1] + E.rot[3 * k + 2] * x[2]) : x).map((v, k) => v / E.r[k]);
  const fromUnit = (E, y) => { const t = y.map((v, k) => v * E.r[k]); return E.rot ? [0, 1, 2].map((k) => E.rot[k] * t[0] + E.rot[3 + k] * t[1] + E.rot[6 + k] * t[2]) : t; };
  const c = toUnit(F, f), bt = toUnit(T, b), n2 = dot(c, c), m2 = dot(bt, bt);
  const blocked = (x) => { const d = toUnit(F, x), dc = dot(d, c); return dc > 0 && dc * dc > dot(d, d) * (n2 - 1); };
  let a1 = cross(bt, [0.3, -0.5, 0.8]); a1 = a1.map((v) => v / norm(a1));
  let a2 = cross(bt, a1); a2 = a2.map((v) => v / norm(a2));
  const reach = Math.sqrt((m2 - 1) / m2);
  let hits = 0;
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const th = (2 * Math.PI * i) / N;
    if (blocked(fromUnit(T, bt.map((v, k) => v * reach + Math.cos(th) * a1[k] + Math.sin(th) * a2[k])))) hits++;
  }
  return hits === N ? 3 : hits > 0 ? 1 : blocked(b) ? 3 : 0;
}

// ---- sub-points -------------------------------------------------------------

test('sub-points seen from natural bodies match CSPICE within the declared bounds', { skip }, async () => {
  await setup();
  const api = await load(ecl.blob);
  assert.equal(api.initStatus, 0);
  const { chain, orientErr } = boundsOf(ecl);
  const [w0, w1] = ecl.report.windowEt;
  const rnd = prng(808);
  let worstKm = 0, worstAlt = 0, n = 0;
  for (const [body, observer] of [[399, 301], [399, 10], [301, 399], [301, 10], [STANDIN, 399], [STANDIN, 10], [399, STANDIN]]) {
    const radii = radiiIn(ecl.blob, body);
    for (let i = 0; i < 60; i++) {
      const et = w0 + 2 + (w1 - w0 - 4) * rnd();
      const got = api.subPoint(body, observer, et);
      assert.equal(got.status, 0, `sub-point on ${body} from ${observer}`);
      const want = await truthSubPoint(spiceEcl, body, observer, et);
      // A position error moves the point by less than itself; an orientation error
      // turns the observer's direction, and the point with it, at most as the
      // ellipsoid's axis ratio squared allows.
      const shape = (Math.max(...radii) / Math.min(...radii)) ** 2;
      const kmBound = chain(body, observer) + 4 * orientErr(body) * Math.max(...radii) * shape + 1e-9;
      const dq = norm(sub(surfacePoint(radii, got.lon, got.lat), want.q));
      assert.ok(dq <= kmBound, `point on ${body} from ${observer}: off by ${dq} km, bound ${kmBound}`);
      const altBound = chain(body, observer) + 1e-13 * want.alt + 1e-9;
      assert.ok(Math.abs(got.alt - want.alt) <= altBound, `altitude above ${body} from ${observer}: off by ${Math.abs(got.alt - want.alt)} km`);
      worstKm = Math.max(worstKm, dq); worstAlt = Math.max(worstAlt, Math.abs(got.alt - want.alt)); n++;
    }
  }
  console.log(`  ${n} sub-points; worst surface point error ${worstKm.toExponential(2)} km, worst altitude error ${worstAlt.toExponential(2)} km`);
});

const radiiKernel = (radii) => new TextEncoder().encode(`KPL/PCK\n\\begindata\nBODY401_RADII = ( ${radii.map((v) => v.toFixed(1)).join(' ')} )\n\\begintext\n`);

// Shapes for the stand-in body: its own (Phobos), then others written over its
// radii in a copy of the blob and given to CSPICE as a text kernel.
const SHAPES = [null, [1, 1, 1], [60268, 60268, 54364], [50, 50, 10], [10, 10, 40], [1000, 600, 200], [30, 200, 90], [900, 3, 1]];

test('sub-points from a supplied spacecraft state match CSPICE to the solver tolerance, for eight shapes', { skip }, async () => {
  await setup();
  const [w0] = ecl.report.windowEt;
  const rnd = prng(2718);
  const N = 240;
  const rows = [];
  for (const shape of SHAPES) {
    const radii = shape ?? radiiIn(ecl.blob, STANDIN);
    const api = await load(shape ? withRadii(ecl.blob, STANDIN, shape) : ecl.blob, { skipCrc: true });
    assert.equal(api.initStatus, 0);
    await spiceEcl.furnsh(`shape${serial++}.tpc`, radiiKernel(radii));
    // The same body-fixed position goes to both sides, each through its own
    // rotation, so the blob's orientation error (covered by the tests around this
    // one) stays out and what is left is the nearest-point solution itself.
    const times = [], fixed = [], forSpice = [], forLite = [];
    for (let i = 0; i < N; i++) {
      // a random direction in the body's frame (every twelfth along an axis), and a
      // height from a millionth of the largest radius to ten thousand times it
      const z = 2 * rnd() - 1, az = 2 * Math.PI * rnd(), c = Math.sqrt(1 - z * z);
      const d = i % 12 === 0 ? [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]][(i / 12) % 4] : [c * Math.cos(az), c * Math.sin(az), z];
      const height = Math.max(...radii) * 10 ** (-6 + 10 * rnd());
      const rho = 1 / Math.hypot(d[0] / radii[0], d[1] / radii[1], d[2] / radii[2]);
      const p = d.map((v) => v * (rho + height));
      const t = w0 + 1000 + 600 * i;
      const toJ2000 = (rot) => [0, 1, 2].map((k) => rot[k] * p[0] + rot[3 + k] * p[1] + rot[6 + k] * p[2]);
      times.push(t);
      fixed.push(p);
      forLite.push(toJ2000(api.orient(STANDIN, t).rot));
      forSpice.push(toJ2000(await spiceEcl.pxform('J2000', NAMES[STANDIN][1], t)));
    }
    const sc = await placeSpacecraft(spiceEcl, STANDIN, times, forSpice);
    const big = Math.max(...radii), ratio = big / Math.min(...radii);
    let worstKm = 0, worstAlt = 0;
    for (let i = 0; i < N; i++) {
      assert.equal(api.setState(SC, STANDIN, times[i], [...forLite[i], 0, 0, 0], 30), 0);
      const got = api.subPoint(STANDIN, SC, times[i]);
      assert.equal(got.status, 0);
      const want = await truthSubPoint(spiceEcl, STANDIN, sc, times[i]);
      const range = norm(fixed[i]);
      const dq = norm(sub(surfacePoint(radii, got.lon, got.lat), want.q));
      assert.ok(dq <= 4e-15 * big * ratio, `shape ${radii}: point off by ${dq} km at range ${range}`);
      const da = Math.abs(got.alt - want.alt);
      assert.ok(da <= 4e-15 * (range + big), `shape ${radii}: altitude off by ${da} km at range ${range}`);
      worstKm = Math.max(worstKm, dq); worstAlt = Math.max(worstAlt, da / (range + big));
    }
    await spiceEcl.furnsh(`shape${serial++}.tpc`, radiiKernel(radiiIn(ecl.blob, STANDIN))); // put Phobos back
    rows.push(`${radii.join(' x ')} km: point ${worstKm.toExponential(1)} km (${(worstKm / big).toExponential(1)} of the largest radius), altitude ${worstAlt.toExponential(1)} of the range`);
  }
  console.log('  worst difference from CSPICE over ' + N + ' placements per shape:\n    ' + rows.join('\n    '));
});

test('the sub-spacecraft point on Saturn along Cassini\'s trajectory matches CSPICE within the declared bounds', { skip }, async () => {
  await setup();
  const api = await load(soi.blob);
  assert.equal(api.initStatus, 0);
  const { chain, orientErr } = boundsOf(soi);
  const [w0, w1] = soi.report.windowEt;
  const radii = radiiIn(soi.blob, 699);
  const rnd = prng(699);
  let worstKm = 0, worstAlt = 0, lowest = Infinity;
  for (let i = 0; i < 300; i++) {
    const observer = i % 5 === 4 ? [399, 10][i % 2] : -82;
    const et = w0 + 2 + (w1 - w0 - 4) * rnd();
    const got = api.subPoint(699, observer, et);
    assert.equal(got.status, 0);
    const want = await truthSubPoint(spiceSoi, 699, observer, et);
    const dq = norm(sub(surfacePoint(radii, got.lon, got.lat), want.q));
    const kmBound = chain(699, observer) + 4 * orientErr(699) * radii[0] * (radii[0] / radii[2]) ** 2 + 1e-9;
    assert.ok(dq <= kmBound, `point from ${observer}: off by ${dq} km, bound ${kmBound}`);
    assert.ok(Math.abs(got.alt - want.alt) <= chain(699, observer) + 1e-13 * want.alt + 1e-9, `altitude from ${observer}`);
    if (observer === -82) { worstKm = Math.max(worstKm, dq); worstAlt = Math.max(worstAlt, Math.abs(got.alt - want.alt)); lowest = Math.min(lowest, want.alt); }
  }
  console.log(`  from Cassini (lowest altitude ${lowest.toFixed(0)} km): worst surface point error ${worstKm.toExponential(2)} km, worst altitude error ${worstAlt.toExponential(2)} km; the trajectory's own declared error is ${soi.report.ephem.find((s) => s.target === -82).maxPosErr.toExponential(2)} km`);
});

// No kernels: the answer must satisfy the definition. With q the returned
// surface point and n the outward unit normal there, the observer must sit at
// q + alt * n. Shapes run to axis ratios of a thousand and heights from a
// billionth of the largest radius to a million times it.
test('the nearest point is where the surface normal passes through the observer, for random ellipsoids', async () => {
  const rnd = prng(31337);
  const t = ecl.report.windowEt[0] + 5000;
  let worst = 0, n = 0;
  for (let s = 0; s < 250; s++) {
    const scale = 10 ** (-1 + 6 * rnd());
    const radii = s % 5 === 0 ? [scale, scale, scale * 10 ** (-3 * rnd())] : [scale * 10 ** (-3 * rnd()), scale * 10 ** (-3 * rnd()), scale * 10 ** (-3 * rnd())];
    const api = await load(withRadii(ecl.blob, STANDIN, radii), { skipCrc: true });
    const rot = api.orient(STANDIN, t).rot;
    const big = Math.max(...radii);
    for (let i = 0; i < 80; i++) {
      const z = 2 * rnd() - 1, az = 2 * Math.PI * rnd(), c = Math.sqrt(1 - z * z);
      const d = [c * Math.cos(az), c * Math.sin(az), z];
      if (i % 10 === 0) d[i % 3] = 0; // on a plane of symmetry
      if (i % 16 === 1) { d[0] = 0; d[1] = 0; d[2] = 1; } // on an axis
      const rho = 1 / Math.hypot(d[0] / radii[0], d[1] / radii[1], d[2] / radii[2]);
      const p = d.map((v) => v * (rho + big * 10 ** (-9 + 15 * rnd()))); // body-fixed
      const j2000 = [0, 1, 2].map((k) => rot[k] * p[0] + rot[3 + k] * p[1] + rot[6 + k] * p[2]);
      assert.equal(api.setState(SC, STANDIN, t, [...j2000, 0, 0, 0], 30), 0);
      const got = api.subPoint(STANDIN, SC, t);
      assert.equal(got.status, 0, `radii ${radii}, observer ${p}`);
      const q = surfacePoint(radii, got.lon, got.lat);
      const g = q.map((v, k) => v / (radii[k] * radii[k])), gn = norm(g);
      const back = q.map((v, k) => v + (got.alt * g[k]) / gn);
      const err = norm(sub(back, p)) / (norm(p) + big);
      assert.ok(err <= 1e-9, `radii ${radii}, observer ${p}: the normal misses the observer by ${err} of its distance`);
      worst = Math.max(worst, err); n++;
    }
  }
  console.log(`  ${n} cases over 250 shapes; worst miss ${worst.toExponential(2)} of the observer's distance`);
});

test('sub-point requests that cannot be served get status codes', async () => {
  const api = await load(ecl.blob);
  const [w0, w1] = ecl.report.windowEt;
  const t = w0 + 5000;
  assert.equal(api.subPoint(3, 10, t).status, 5, 'the Earth-Moon barycenter has no radii');
  assert.equal(api.subPoint(10, 399, t).status, 2, 'the Sun has radii but no orientation in this blob');
  assert.equal(api.subPoint(399, 399, t).status, 6, 'the body cannot observe itself');
  assert.equal(api.subPoint(399, 3, t).status, 6, 'the Earth-Moon barycenter is inside the Earth');
  assert.equal(api.subPoint(499, 10, t).status, 2, 'unknown body');
  assert.equal(api.subPoint(399, 5, t).status, 2, 'unknown observer');
  assert.equal(api.subPoint(399, 301, w0 - 10).status, 1);
  assert.equal(api.subPoint(399, 301, w1 + 86400).status, 1);
  assert.equal(api.subPoint(399, 301, NaN).status, 6);
  assert.equal(api.subPoint(399, SC, t).status, 2, 'the spacecraft has neither a trajectory nor a supplied state');
  assert.equal(api.exports.lite_sub_point(399, 301, t, 0, 0, 0), 6, 'null outputs');
  for (const [pos, status] of [[[0, 0, 0], 6], [[5000, 0, 0], 6], [[0, 0, 6356], 6], [[0, 0, 6357], 0], [[6379, 0, 0], 0]]) {
    // IAU_EARTH's pole is not J2000's, so turn the body-fixed position into J2000 first
    const rot = api.orient(399, t).rot;
    const j = [0, 1, 2].map((k) => rot[k] * pos[0] + rot[3 + k] * pos[1] + rot[6 + k] * pos[2]);
    assert.equal(api.setState(SC, 399, t, [...j, 0, 0, 0], 30), 0);
    assert.equal(api.subPoint(399, SC, t).status, status, `spacecraft at ${pos} in the Earth's frame`);
  }
  for (const radii of [[0, 0, 0], [6378, -6378, 6356], [6378, 6378, 0], [1e-320, 1, 1], [1e200, 1e200, 1e200], [1e-200, 1e-200, 1e-200]]) {
    const odd = await load(withRadii(ecl.blob, 399, radii), { skipCrc: true });
    assert.equal(odd.initStatus, 0);
    const st = odd.subPoint(399, 301, t).status;
    assert.ok(radii.every((r) => r > 0) ? [0, 5, 6].includes(st) : st === 5, `radii ${radii}: status ${st}`);
    const occ = odd.occulted(10, 399, 301, t);
    assert.ok(radii.every((r) => r > 0) ? [0, 5, 6].includes(occ.status) : occ.status === 5, `radii ${radii}: occultation status ${occ.status}`);
  }
  const noFlag = await load(withRadii(ecl.blob, 399, [6378, 6378, 6356], 0), { skipCrc: true });
  assert.equal(noFlag.subPoint(399, 301, t).status, 5, 'radii present but the flag is clear');
  assert.equal(noFlag.occulted(10, 399, 301, t).status, 5);
  const none = await load(new Uint8Array(8));
  assert.equal(none.subPoint(399, 301, t).status, 4);
  assert.equal(none.occulted(10, 399, 301, t).status, 4);
});

// ---- occultation ------------------------------------------------------------

// The shape CSPICE gives a body at et: its radii, and its orientation unless it is round.
async function shapeAt(spice, radii, id, et) {
  const r = radii(id);
  return { r, rot: isRound(r) ? null : await spice.pxform('J2000', NAMES[id][1], et) };
}
// ARITH is the rounding both sides are allowed, as a fraction of the range.
const ARITH = 1e-12;

// Compares one answer with CSPICE and files it. A difference is allowed only
// where the blob's own declared errors leave the answer unsettled: err(id) is
// how far (km) the library's idea of a body's surface may lie from CSPICE's,
// from the position errors on the way to the observer and the orientation
// error times the largest radius (and, for a body the library must treat as a
// sphere, the spread of its radii). The brute-force model, on CSPICE's own
// positions and orientations, says whether errors of that size can change the
// code. The model must itself agree with CSPICE wherever the answer is settled.
async function judge(tally, spice, api, radii, target, by, observer, obsName, et, err) {
  const got = api.occulted(target, by, observer, et);
  assert.equal(got.status, 0, `occulted ${target} by ${by} from ${observer}`);
  const want = await truthOcculted(spice, target, by, obsName, et);
  const f = vec((await spice.spkpos(NAMES[by][0], et, 'J2000', 'NONE', obsName)).position);
  const b = vec((await spice.spkpos(NAMES[target][0], et, 'J2000', 'NONE', obsName)).position);
  const F = await shapeAt(spice, radii, by, et), T = await shapeAt(spice, radii, target, et);
  const model = limbModel(f, b, F, T);
  const inBand = unsettled(f, b, F, T, err(by) + ARITH * norm(f), err(target) + ARITH * norm(b), model);
  if (model !== want && !inBand && tally.arbiter) {
    // CSPICE and the model disagree where the answer is settled: direct lines of
    // sight decide, and the library must then stand with them.
    assert.equal(raySample(f, b, F, T), model, `lines of sight side with CSPICE (${want}), not the model (${model}), for ${target} behind ${by} from ${obsName} at ${et}`);
    assert.equal(got.code, model, `the library gives ${got.code} where the model and lines of sight give ${model} and CSPICE ${want}`);
    tally.cspiceAlone++;
    assert.ok(norm(f) < Math.max(...F.r), 'CSPICE stands alone only where the observer is inside the sphere of the front body\'s largest radius');
    return { got: got.code, want };
  }
  tally.n++; tally.codes[want]++;
  if (inBand) tally.inBand++;
  assert.ok(model === want || inBand, `the brute-force model gives ${model} and CSPICE ${want} for ${target} behind ${by} from ${obsName} at ${et}, where the answer is settled (the library gives ${got.code})`);
  if (got.code !== want) {
    assert.ok(inBand, `occulted ${target} by ${by} from ${obsName} at ${et}: got ${got.code}, CSPICE ${want}, and the declared errors (${err(by)} and ${err(target)} km) do not unsettle the answer`);
    tally.differ++;
  }
  return { got: got.code, want };
}
const newTally = (arbiter = false) => ({ n: 0, inBand: 0, differ: 0, codes: [0, 0, 0, 0], arbiter, cspiceAlone: 0 });
const say = (label, t) => console.log(`  ${label}: ${t.n} cases (CSPICE: ${t.codes[0]} none, ${t.codes[1]} partial, ${t.codes[2]} annular, ${t.codes[3]} full); ${t.n - t.differ} agree; ${t.differ} differ, all among the ${t.inBand} whose answer the declared errors leave unsettled`);
// The error allowance for a body: position errors between it and `from`, and its orientation error at its largest radius.
const allowance = ({ chain, orientErr }, radii, from, unoriented = []) => (id) => chain(id, from) + (isRound(radii(id)) || unoriented.includes(id) ? 0 : orientErr(id) * Math.max(...radii(id)));

test('the eclipses of October 2004 are classified as CSPICE classifies them', { skip }, async () => {
  await setup();
  const api = await load(ecl.blob);
  const radii = (id) => radiiIn(ecl.blob, id);
  const [w0, w1] = ecl.report.windowEt;
  const solar = await spiceEcl.str2et('2004-10-14T03:00:00'), lunar = await spiceEcl.str2et('2004-10-28T03:10:00');
  const times = [];
  for (let t = w0 + 60; t < w1; t += 3600) times.push(t);
  for (let t = solar - 7200; t <= solar + 7200; t += 20) times.push(t);
  for (let t = lunar - 10800; t <= lunar + 10800; t += 20) times.push(t);
  const tally = newTally();
  for (const [target, by, observer] of [[301, 399, 10], [399, 301, 10], [10, 399, 301], [10, 301, 399], [301, 10, 399], [399, 10, 301]]) {
    const err = allowance(boundsOf(ecl), radii, observer);
    const seen = new Set();
    for (const et of times) seen.add((await judge(tally, spiceEcl, api, radii, target, by, observer, String(observer), et, err)).want);
    if (target === 301 && observer === 10) assert.deepEqual([...seen].sort(), [0, 1, 3], 'from the Sun, the Earth hides the Moon partly and then fully on October 28');
    if (target === 399 && observer === 10) assert.deepEqual([...seen].sort(), [0, 1], 'from the Sun, the Moon crosses the limb of the Earth on October 14');
    if (target === 10 && observer === 301) assert.deepEqual([...seen].sort(), [0, 1, 3], 'from the Moon, the Earth hides the Sun on October 28');
    if (by === 10) assert.deepEqual([...seen], [0], 'the Sun is never in front');
  }
  say('natural observers', tally);
  assert.ok(tally.inBand <= 0.01 * tally.n, 'the unsettled band is a small part of the cases');
});

// Where to put a spacecraft so that the geometry sits at, beside, and between
// the changes of code. The spacecraft is D from the front body, an angle phi
// off the line from the back body through the front one (phi = 0 puts the two
// centers in line); the changes of code along phi are found with the
// brute-force model, by a scan and then bisection.
function placements(pf, pb, F, T, D, hint) {
  const axis = sub(pf, pb), u = axis.map((v) => v / norm(axis));
  let w = cross(u, [0.3, -0.5, 0.8]); w = w.map((v) => v / norm(w));
  const at = (phi) => pf.map((v, k) => v + D * (Math.cos(phi) * u[k] + Math.sin(phi) * w[k]));
  const code = (phi) => { const o = at(phi); return limbModel(sub(pf, o), sub(pb, o), F, T); };
  const bisect = (lo, hi) => { const c = code(lo); for (let i = 0; i < 80; i++) { const mid = 0.5 * (lo + hi); if (code(mid) === c) lo = mid; else hi = mid; } return lo; };
  let changes = [];
  // the changes found for an earlier time are close: look around each first
  if (hint) for (const h of hint) if (code(h * 0.99) !== code(h * 1.01)) changes.push(bisect(h * 0.99, h * 1.01));
  if (!hint || changes.length !== hint.length) {
    changes = [];
    let prev = 0, cPrev = code(0);
    for (let i = 0; i <= 420; i++) {
      const phi = 1e-9 * 1.5e9 ** (i / 420), c = code(phi);
      if (c !== cPrev) changes.push(bisect(prev, phi));
      prev = phi; cPrev = c;
    }
  }
  const list = [0];
  changes.forEach((c, i) => list.push(0.5 * ((changes[i - 1] ?? 0) + c)));
  if (changes.length) list.push(Math.min(1.5, 2 * changes[changes.length - 1]));
  for (const rel of [1e-9, 1e-7, 1e-5, 1e-3, 3e-2, 0.3]) for (const c of changes) list.push(c * (1 - rel), c * (1 + rel));
  return { changes, positions: list.map(at) };
}

test('near-limb geometry from a placed spacecraft: every code, a hair to either side of each change, for round, oblate, and triaxial bodies', { skip }, async () => {
  await setup();
  const api = await load(ecl.blob);
  const radii = (id) => radiiIn(ecl.blob, id);
  const err = allowance(boundsOf(ecl), radii, 0); // the spacecraft is placed relative to the barycenter
  const [w0] = ecl.report.windowEt;
  const round = newTally(), oblate = newTally();
  let slot = 0;
  // [front, back, distances of the spacecraft from the front body, in units of its mean radius]
  const pairs = [
    [301, 10, [3, 60, 200, 215.9, 240, 3000]],   // the Moon over the Sun: full nearby, annular beyond 216 radii
    [399, 10, [1.5, 20, 215, 230, 2000]],        // the Earth over the Sun
    [399, 301, [1.2, 5, 30, 300]],               // the Earth over the Moon
    [301, 399, [2, 20, 100, 1000]],              // the Moon over the Earth: partial or annular
    [STANDIN, 10, [3, 100, 1e4, 1e6]],           // the triaxial stand-in over the Sun
    [STANDIN, 399, [5, 1e3, 1e6]],
    [399, STANDIN, [1.2, 3]],                    // the Earth over the stand-in: two bodies that are not round
  ];
  for (const [front, back, distances] of pairs) {
    const tally = isRound(radii(front)) && isRound(radii(back)) ? round : oblate;
    const times = [], positions = [];
    for (const dist of distances) {
      const D = dist * mean(radii(front));
      // One time per placement, since each is a state in the spacecraft's kernel.
      // The changes of code are found afresh at each time: the bodies move and turn.
      let hint = null;
      for (let n = 0; ; n++) {
        const et = w0 + 3000 + 977 * slot++;
        const pf = vec((await spiceEcl.spkpos(NAMES[front][0], et, 'J2000', 'NONE', '0')).position);
        const pb = vec((await spiceEcl.spkpos(NAMES[back][0], et, 'J2000', 'NONE', '0')).position);
        const p = placements(pf, pb, await shapeAt(spiceEcl, radii, front, et), await shapeAt(spiceEcl, radii, back, et), D, hint);
        hint = p.changes;
        if (n >= p.positions.length) break;
        times.push(et);
        positions.push(p.positions[n]);
      }
    }
    const sc = await placeSpacecraft(spiceEcl, 0, times, positions);
    for (let i = 0; i < times.length; i++) {
      assert.equal(api.setState(SC, 0, times[i], [...positions[i], 0, 0, 0], 30), 0);
      await judge(tally, spiceEcl, api, radii, back, front, SC, sc, times[i], err);
      await judge(tally, spiceEcl, api, radii, front, back, SC, sc, times[i], err); // the far body hides nothing
    }
  }
  say('round bodies (the Moon over the Sun)', round);
  say('with an oblate or triaxial body', oblate);
  assert.ok(round.codes[1] > 0 && round.codes[2] > 0 && round.codes[3] > 0, 'partial, annular, and full all occur');
  assert.ok(oblate.codes[1] > 0 && oblate.codes[2] > 0 && oblate.codes[3] > 0);
});

const radiiKernelFor = (naif, radii) => new TextEncoder().encode(`KPL/PCK\n\\begindata\nBODY${naif}_RADII = ( ${radii.map((v) => v.toFixed(1)).join(' ')} )\n\\begintext\n`);

test('a body that is not round and has no orientation in the blob is a sphere of its mean radius', { skip }, async () => {
  await setup();
  // The Sun has no ORIENT segment in this blob. Flatten it by a tenth on both
  // sides: CSPICE then turns an ellipsoid with IAU_SUN, the library has only a sphere.
  const flat = [695700, 695700, 626130];
  const blob = withRadii(ecl.blob, 10, flat);
  const api = await load(blob, { skipCrc: true });
  assert.equal(api.initStatus, 0);
  await spiceEcl.furnsh(`shape${serial++}.tpc`, radiiKernelFor(10, flat));
  const radii = (id) => radiiIn(blob, id);
  const bounds = boundsOf(ecl), base = allowance(bounds, radii, 0, [10]);
  const position = (id) => bounds.chain(id, 0);
  const spread = (id) => (id === 10 ? Math.max(...flat) - Math.min(...flat) : 0);
  const [w0] = ecl.report.windowEt;
  const vsCspice = newTally();
  let slot = 0, vsSphere = 0, n = 0;
  try {
    for (const [front, back, dist] of [[301, 10, 100], [301, 10, 230], [399, 10, 150], [10, 301, 3]]) {
      const D = dist * mean(radii(front));
      const times = [], positions = [];
      for (let k = 0; k <= 60; k++) {
        const et = w0 + 400000 + 977 * slot++;
        const pf = vec((await spiceEcl.spkpos(NAMES[front][0], et, 'J2000', 'NONE', '0')).position);
        const pb = vec((await spiceEcl.spkpos(NAMES[back][0], et, 'J2000', 'NONE', '0')).position);
        const axis = sub(pf, pb), u = axis.map((v) => v / norm(axis));
        let w = cross(u, [0.3, -0.5, 0.8]); w = w.map((v) => v / norm(w));
        // from the line of centers out to twice the angle at which mean spheres part
        const reach = 2 * (Math.asin(mean(radii(front)) / D) + mean(radii(back)) / norm(axis));
        const phi = (reach * k) / 60;
        times.push(et);
        positions.push(pf.map((v, i) => v + D * (Math.cos(phi) * u[i] + Math.sin(phi) * w[i])));
      }
      const sc = await placeSpacecraft(spiceEcl, 0, times, positions);
      for (let i = 0; i < times.length; i++) {
        assert.equal(api.setState(SC, 0, times[i], [...positions[i], 0, 0, 0], 30), 0);
        // against CSPICE, the allowance is the spread of the Sun's radii on top of the declared errors
        const r = await judge(vsCspice, spiceEcl, api, radii, back, front, SC, sc, times[i], (id) => base(id) + spread(id));
        // against the model with the Sun as its mean sphere, the declared position errors alone
        const f = sub(vec((await spiceEcl.spkpos(NAMES[front][0], times[i], 'J2000', 'NONE', '0')).position), positions[i]);
        const b = sub(vec((await spiceEcl.spkpos(NAMES[back][0], times[i], 'J2000', 'NONE', '0')).position), positions[i]);
        const shape = async (id) => (id === 10 ? sphereOf(flat) : shapeAt(spiceEcl, radii, id, times[i]));
        const F = await shape(front), T = await shape(back);
        const model = limbModel(f, b, F, T);
        if (r.got !== model) {
          assert.ok(unsettled(f, b, F, T, base(front) + ARITH * norm(f), base(back) + ARITH * norm(b), model), `with the Sun as its mean sphere the model gives ${model}, the library ${r.got}`);
          vsSphere++;
        }
        n++;
      }
    }
  } finally {
    await spiceEcl.furnsh(`shape${serial++}.tpc`, radiiKernelFor(10, radiiIn(ecl.blob, 10))); // put the Sun back
  }
  assert.ok(position(10) < 1, 'the position allowance is far below the spread, so the two comparisons differ in kind');
  say('a flattened Sun the blob cannot orient, against CSPICE\'s ellipsoid', vsCspice);
  console.log(`    against the model with that Sun as a sphere of its mean radius: ${n - vsSphere} of ${n} agree, the rest unsettled by the declared position errors`);
  assert.ok(vsCspice.differ > 0, 'the sphere does differ from the ellipsoid somewhere: the limit is real');
});

test('an observer just above the surface, with the Sun crossing the horizon', { skip }, async () => {
  await setup();
  const api = await load(ecl.blob);
  const radii = (id) => radiiIn(ecl.blob, id);
  const bounds = boundsOf(ecl);
  const [w0] = ecl.report.windowEt;
  // CSPICE's occultation routine notes that it can misclassify unusual geometry.
  // It does here, and only where the observer is outside the front body but
  // inside the sphere of its largest radius (39 of the 40 cases are 1 m to 2 km
  // above the 13 by 11.4 by 9.1 km stand-in, where it reports nothing hidden with
  // the Sun below the horizon). So in this test a disagreement between CSPICE
  // and the model goes to a third method, direct lines of sight, and the library
  // must match the two that agree.
  const tally = newTally(true);
  let slot = 0;
  for (const [front, heights] of [[399, [0.002, 0.1, 5, 400]], [STANDIN, [0.001, 0.05, 2]]]) {
    const r = radii(front);
    // the spacecraft is placed relative to the front body, so that body's allowance is its orientation error alone
    const err = (id) => (id === front ? bounds.orientErr(id) * Math.max(...r) : bounds.chain(id, front));
    const times = [], positions = [];
    for (const h of heights) {
      const dip = Math.acos(mean(r) / (mean(r) + h)); // roughly how far below the horizontal the horizon lies
      for (let k = -30; k <= 30; k++) {
        const et = w0 + 700000 + 977 * slot++;
        const rot = await spiceEcl.pxform('J2000', NAMES[front][1], et);
        const sunJ = vec((await spiceEcl.spkpos('SUN', et, 'J2000', 'NONE', NAMES[front][0])).position);
        const s = [0, 1, 2].map((i) => rot[3 * i] * sunJ[0] + rot[3 * i + 1] * sunJ[1] + rot[3 * i + 2] * sunJ[2]).map((v) => v / norm(sunJ));
        // a surface normal at right angles to the Sun (the terminator), then tipped by
        // beta toward the Sun: beta is the Sun's elevation above the local horizontal
        let n0 = cross(s, [0.2, 0.5, 0.84]); n0 = n0.map((v) => v / norm(n0));
        const beta = -dip + (k / 30) * 0.012; // the Sun's angular radius is 0.0047
        const nrm = n0.map((v, i) => Math.cos(beta) * v + Math.sin(beta) * s[i]);
        const scale = Math.hypot(r[0] * nrm[0], r[1] * nrm[1], r[2] * nrm[2]);
        const p = nrm.map((v, i) => (r[i] * r[i] * v) / scale + h * v); // body-fixed: the surface point with that normal, raised h
        times.push(et);
        positions.push([0, 1, 2].map((i) => rot[i] * p[0] + rot[3 + i] * p[1] + rot[6 + i] * p[2]));
      }
    }
    const sc = await placeSpacecraft(spiceEcl, front, times, positions);
    for (let i = 0; i < times.length; i++) {
      assert.equal(api.setState(SC, front, times[i], [...positions[i], 0, 0, 0], 30), 0);
      await judge(tally, spiceEcl, api, radii, 10, front, SC, sc, times[i], err);
    }
  }
  say('2 m to 400 km above the Earth and 1 m to 2 km above the triaxial stand-in', tally);
  console.log(`    in ${tally.cspiceAlone} further cases CSPICE stands alone against the library, the brute-force model, and direct lines of sight`);
  assert.ok(tally.codes[0] > 0 && tally.codes[1] > 0 && tally.codes[3] > 0, 'none, partial, and full all occur');
});

test('Saturn hiding the Sun and the Earth from Cassini at orbit insertion', { skip }, async () => {
  await setup();
  const api = await load(soi.blob);
  const radii = (id) => radiiIn(soi.blob, id);
  const bounds = boundsOf(soi), err = allowance(bounds, radii, -82);
  const [w0, w1] = soi.report.windowEt;
  const tally = newTally();
  const lines = [];
  for (const target of [10, 399]) {
    // When any occultation starts and ends, for CSPICE and for the library,
    // refined from the 15 s grid to a quarter of a microsecond.
    let prev = null;
    const edges = { got: [], want: [] };
    for (let et = w0 + 30; et < w1 - 30; et += 15) {
      const r = await judge(tally, spiceSoi, api, radii, target, 699, -82, '-82', et, err);
      for (const side of ['got', 'want']) if (prev && (r[side] !== 0) !== (prev[side] !== 0)) edges[side].push(et);
      prev = r;
    }
    const refine = async (hi, hidden) => {
      let lo = hi - 15;
      const before = await hidden(lo);
      for (let i = 0; i < 26; i++) { const mid = 0.5 * (lo + hi); if ((await hidden(mid)) === before) lo = mid; else hi = mid; }
      return hi;
    };
    const lite = [], spice = [];
    for (const t of edges.got) lite.push(await refine(t, async (x) => api.occulted(target, 699, -82, x).code !== 0));
    for (const t of edges.want) spice.push(await refine(t, async (x) => (await truthOcculted(spiceSoi, target, 699, '-82', x)) !== 0));
    assert.equal(spice.length, 2, 'one occultation inside the window');
    assert.equal(lite.length, 2);
    // The declared errors (a few meters of trajectory, Saturn's orientation at
    // its largest radius) move the limb by that much across the line of sight;
    // the spacecraft crosses it at no less than a tenth of its speed, so the
    // times may differ by ten times the error over the speed, plus the grid.
    for (let i = 0; i < 2; i++) {
      const v = await spiceSoi.spkezr('-82', spice[i], 'J2000', 'NONE', 'SATURN');
      const speed = norm(vec(v.velocity));
      const bound = (10 * (err(699) + err(target))) / speed + 2 * (15 / 2 ** 26);
      assert.ok(Math.abs(lite[i] - spice[i]) <= bound, `${NAMES[target][0]} behind Saturn: edge ${i} differs from CSPICE by ${lite[i] - spice[i]} s, allowed ${bound}`);
    }
    lines.push(`${NAMES[target][0]} behind Saturn from ${await spiceSoi.et2utc(spice[0], 'ISOC', 0)} to ${await spiceSoi.et2utc(spice[1], 'ISOC', 0)}; the library's start and end come ${lite.map((t, i) => ((t - spice[i]) * 1e6).toFixed(1)).join(' and ')} microseconds after CSPICE's`);
  }
  say('Cassini, every 15 s for a day', tally);
  console.log('    ' + lines.join('\n    '));
});

// No kernels: the library against the brute-force model, each using the blob's
// own positions and orientations, for random shapes of the stand-in body in
// front of the Sun (round) and behind and in front of the Earth (oblate).
test('random triaxial shapes: the library and the brute-force model agree away from changes of code', async () => {
  const rnd = prng(4242);
  const t = ecl.report.windowEt[0] + 5000;
  const counts = [0, 0, 0, 0];
  let n = 0, near = 0;
  for (let s = 0; s < 120; s++) {
    const size = 10 ** (1 + 3 * rnd());
    const shape = s % 4 === 0 ? [size, size, size * 10 ** (-rnd())] : [size * 10 ** (-rnd()), size * 10 ** (-rnd()), size * 10 ** (-rnd())];
    const blob = withRadii(ecl.blob, STANDIN, shape);
    const api = await load(blob, { skipCrc: true });
    const radii = (id) => radiiIn(blob, id);
    const shapeOfBody = (id) => ({ r: radii(id), rot: isRound(radii(id)) ? null : api.orient(id, t).rot });
    for (const [front, back] of [[STANDIN, 10], [STANDIN, 399], [399, STANDIN]]) {
      const pf = api.state(front, 0, t, 0).state.slice(0, 3), pb = api.state(back, 0, t, 0).state.slice(0, 3);
      const F = shapeOfBody(front), T = shapeOfBody(back);
      const axis = sub(pf, pb), u = axis.map((v) => v / norm(axis));
      let w = cross(u, [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]); w = w.map((v) => v / norm(w));
      for (let i = 0; i < 24; i++) {
        // from just above the front body to far from it, off the line of centers by up to
        // a little more than the angle the two bodies span
        const D = Math.max(...F.r) * (1 + 10 ** (-3 + 7 * rnd()));
        const span = Math.asin(Math.min(1, Math.max(...F.r) / D)) + Math.max(...T.r) / norm(axis);
        const phi = 1.3 * span * rnd();
        const o = pf.map((v, k) => v + D * (Math.cos(phi) * u[k] + Math.sin(phi) * w[k]));
        assert.equal(api.setState(SC, 0, t, [...o, 0, 0, 0], 30), 0);
        const got = api.occulted(back, front, SC, t);
        const f = sub(pf, o), b = sub(pb, o);
        const model = limbModel(f, b, F, T);
        if (model < 0) { assert.equal(got.status, 6, 'inside a body'); continue; }
        assert.equal(got.status, 0);
        n++; counts[model]++;
        if (got.code !== model) {
          // only where a change of a billionth in either body's size changes the model's answer
          assert.ok(unsettled(f, b, F, T, 1e-9 * Math.min(...F.r), 1e-9 * Math.min(...T.r), model), `radii ${shape}, ${back} behind ${front}: library ${got.code}, model ${model}`);
          near++;
        }
      }
    }
  }
  console.log(`  ${n} cases over 120 shapes (model: ${counts[0]} none, ${counts[1]} partial, ${counts[2]} annular, ${counts[3]} full); ${n - near} agree, ${near} within a billionth of a change of code`);
  assert.ok(counts.every((c) => c > 0));
});

test('occultation requests that cannot be served get status codes', async () => {
  const api = await load(ecl.blob);
  const [w0, w1] = ecl.report.windowEt;
  const t = w0 + 5000;
  assert.equal(api.occulted(10, 3, 399, t).status, 5, 'the Earth-Moon barycenter has no radii');
  assert.equal(api.occulted(3, 301, 399, t).status, 5);
  assert.equal(api.occulted(10, 10, 399, t).status, 6, 'a body cannot hide itself');
  assert.equal(api.occulted(10, 301, 301, t).status, 6, 'the observer is one of the bodies');
  assert.equal(api.occulted(399, 301, 399, t).status, 6);
  assert.equal(api.occulted(10, 301, 3, t).status, 0, 'the Earth-Moon barycenter is inside the Earth, but the Earth is not one of the two bodies');
  assert.equal(api.occulted(10, 399, 3, t).status, 6, 'the observer is inside the front body');
  assert.equal(api.occulted(10, 499, 399, t).status, 2);
  assert.equal(api.occulted(10, 301, 5, t).status, 2);
  assert.equal(api.occulted(10, 301, 399, w0 - 10).status, 1);
  assert.equal(api.occulted(10, 301, 399, w1 + 86400).status, 1);
  assert.equal(api.occulted(10, 301, 399, Infinity).status, 6);
  assert.equal(api.occulted(10, 301, SC, t).status, 2, 'the spacecraft has no state yet');
  assert.equal(api.exports.lite_occulted(10, 301, 399, t, 0), 6, 'null output');
  assert.deepEqual(api.occulted(10, 301, 399, t), { status: 0, code: 0 });
  // The Earth is its ellipsoid: 5 km above the pole is outside it, though inside
  // the sphere of its mean radius, and 5 km above the equator is still inside
  // the sphere of its largest radius plus 5 km; inside the ellipsoid is refused.
  const rot = api.orient(399, t).rot;
  for (const [pos, status] of [[[0, 0, 6361.75], 0], [[6383.14, 0, 0], 0], [[0, 0, 6356], 6], [[6378, 0, 0], 6], [[0, 0, 0], 6]]) {
    const j = [0, 1, 2].map((k) => rot[k] * pos[0] + rot[3 + k] * pos[1] + rot[6 + k] * pos[2]);
    assert.equal(api.setState(SC, 399, t, [...j, 0, 0, 0], 30), 0);
    assert.equal(api.occulted(10, 399, SC, t).status, status, `spacecraft at ${pos} in the Earth's frame`);
    assert.equal(api.occulted(399, 301, SC, t).status, status, `the same with the Earth as the target`);
  }
});

// ---- exactness and robustness -----------------------------------------------

for (const name of ['eclipses', 'saturn-soi']) {
  const { blob, path } = name === 'eclipses' ? ecl : soi;
  const queries = readFileSync(resolve(root, `test/vectors/${name}.queries`), 'utf8');
  const expected = readFileSync(resolve(root, `test/vectors/${name}.expected`), 'utf8');
  test(`${name}: the WebAssembly build reproduces the committed geometry vectors bit for bit`, async () => {
    assert.equal(runAll(await load(blob), queries), expected);
  });
  test(`${name}: the native build reproduces the same bits`, { skip: !existsSync(resolve(root, 'build/driver')) && 'build/driver not built' }, () => {
    assert.equal(execFileSync(resolve(root, 'build/driver'), ['run', path], { input: queries, encoding: 'utf8' }), expected);
  });
}

const san = resolve(root, 'build/driver-san');
test('100,000 corrupted geometry blobs under the sanitizers: no faults', { skip: !existsSync(san) && 'build/driver-san not built' }, () => {
  const out = execFileSync(san, ['fuzz', ecl.path, '100000', '20261121'], { encoding: 'utf8' });
  assert.match(out, /no faults/);
  console.log('  ' + out.trim());
});

test('corrupted blobs never trap the two calls in the WebAssembly build', async () => {
  const rnd = prng(23);
  const t = ecl.report.windowEt[0] + 86400;
  const ids = [0, 3, 4, 10, 301, 399, SC, 7];
  let accepted = 0, answered = 0;
  for (let i = 0; i < 400; i++) {
    let copy = ecl.blob.slice();
    if (i % 10 === 0) copy = copy.slice(0, Math.floor(rnd() * copy.length));
    // most edits land in the BODY table, where the radii and flags are
    const lo = bodyEntry(ecl.blob, SC), span = 7 * 32;
    for (let e = 0; e < 3 && copy.length; e++) {
      const pos = e === 0 ? Math.floor(rnd() * Math.min(copy.length, 2048)) : lo + Math.floor(rnd() * span);
      if (pos < copy.length) copy[pos] = Math.floor(rnd() * 256);
    }
    const api = await load(copy, { skipCrc: true });
    if (api.initStatus === 0) accepted++;
    api.setState(SC, 399, t, [7000, 100, -200, 0, 0, 0], 30);
    for (const a of ids) for (const b of ids) {
      const s = api.subPoint(a, b, t);
      const o = api.occulted(a, b, ids[(ids.indexOf(a) + 3) % ids.length], t);
      if (s.status === 0) { answered++; assert.ok(Number.isFinite(s.lon) && Number.isFinite(s.lat) && Number.isFinite(s.alt), 'finite answers'); }
      if (o.status === 0) { answered++; assert.ok(o.code >= 0 && o.code <= 3); }
    }
  }
  console.log(`  400 corrupted blobs, ${accepted} accepted with the checksum skipped, ${answered} calls answered, no traps`);
});
