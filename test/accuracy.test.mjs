// Tier B, accuracy: every answer is compared with full CSPICE (through
// cspice-wasm, using the same kernels the slicer read) and must fall within
// the error the blob declares for the segments involved. The slicer measured
// those errors on its own grid; this test samples different times, so it is an
// independent check on the slicer as well as on the library.
//
// Needs the kernels: set SPICE_LITE_KERNELS to a directory holding them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { load, prng, root } from './harness.mjs';

const kernelDir = process.env.SPICE_LITE_KERNELS;
const config = JSON.parse(readFileSync(resolve(root, 'test/blobs/cassini-soi.json'), 'utf8'));
const report = JSON.parse(readFileSync(resolve(root, 'test/blobs/cassini-soi.report.json'), 'utf8'));
const blob = new Uint8Array(readFileSync(resolve(root, 'test/blobs/cassini-soi.slb')));
const have = kernelDir && config.kernels.every((k) => existsSync(resolve(kernelDir, k)));
const skip = !have && 'SPICE_LITE_KERNELS is not set or lacks the kernels';

const SLACK = 1.5; // the slicer's error grid and this test's times differ
const parentOf = new Map(config.bodies.map((b) => [b.id, b.parent]));
const posErr = new Map(report.ephem.map((s) => [s.target, s.maxPosErr]));
const velErr = new Map(report.ephem.map((s) => [s.target, s.maxVelErr]));
const chainBound = (errs, a, b) => {
  let sum = 0;
  for (const start of [a, b]) for (let id = start; parentOf.get(id) != null; id = parentOf.get(id)) sum += errs.get(id);
  return sum;
};
const vec = (p) => [p.x, p.y, p.z];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const CORR = ['NONE', 'LT', 'LT+S'];

let spice, api;
async function setup() {
  if (spice) return;
  const { createSpiceEngine } = await import('cspice-wasm');
  spice = await createSpiceEngine();
  for (const k of config.kernels) await spice.furnsh(k, new Uint8Array(readFileSync(resolve(kernelDir, k))));
  api = await load(blob);
  assert.equal(api.initStatus, 0);
}
const truth = async (t, o, et, corr) => {
  const s = await spice.spkezr(String(t), et, 'J2000', CORR[corr], String(o));
  return { pos: vec(s.position), vel: vec(s.velocity), lt: s.lightTime };
};

const [w0, w1] = report.windowEt;
const sc = report.ephem.find((s) => s.target === -82);
const [s0, s1] = [sc.tStart, sc.tStart + sc.recordCount * sc.interval];
const natural = [0, 3, 6, 10, 301, 399];

test('states match CSPICE within the declared bounds, all three corrections', { skip }, async () => {
  await setup();
  const rnd = prng(4242);
  let worstPos = 0, worstVel = 0, n = 0;
  for (let i = 0; i < 600; i++) {
    const withSc = i % 4 === 0;
    let t = natural[Math.floor(rnd() * natural.length)], o = natural[Math.floor(rnd() * natural.length)];
    if (withSc) { if (i % 8 === 0) t = -82; else o = -82; }
    if (t === o) continue;
    // Light from the spacecraft takes over an hour to reach the inner bodies, so a
    // corrected query needs the trajectory to reach back that far; stay clear of its start.
    const et = withSc ? s0 + 7200 + (s1 - s0 - 7204) * rnd() : w0 + 2 + (w1 - w0 - 4) * rnd();
    const corr = i % 3;
    const got = api.state(t, o, et, corr);
    assert.equal(got.status, 0, `state ${t} ${o} ${corr}`);
    const want = await truth(t, o, et, corr);
    const range = Math.hypot(...want.pos);
    let pb = SLACK * chainBound(posErr, t, o) + 1e-12 * range + 1e-9;
    // Stellar aberration turns the direction by (observer speed / c), so an error in the
    // observer's velocity moves the apparent position by range * (velocity error / c).
    if (corr === 2) pb += (range * SLACK * chainBound(velErr, o, 0)) / 299792.458;
    const dp = dist(got.state, want.pos);
    assert.ok(dp <= pb, `position ${t} wrt ${o} corr ${corr}: off by ${dp} km, bound ${pb}`);
    assert.ok(Math.abs(got.lt - want.lt) <= pb / 299792.458 + 1e-12, 'light time');
    worstPos = Math.max(worstPos, dp / pb);
    if (corr === 0) {
      const vb = SLACK * chainBound(velErr, t, o) + 1e-13 * Math.hypot(...want.vel) + 1e-12;
      const dv = dist(got.state.slice(3), want.vel);
      assert.ok(dv <= vb, `velocity ${t} wrt ${o}: off by ${dv} km/s, bound ${vb}`);
      worstVel = Math.max(worstVel, dv / vb);
    }
    assert.equal(got.source, t === -82 || o === -82 ? 1 : 0);
    n++;
  }
  console.log(`  ${n} states; worst position error is ${(100 * worstPos).toFixed(1)}% of its bound, worst velocity ${(100 * worstVel).toFixed(1)}%`);
});

test('orientation matches CSPICE within the declared bounds', { skip }, async () => {
  await setup();
  const rnd = prng(77);
  for (const o of config.orient) {
    const bound = SLACK * report.orient.find((s) => s.body === o.body).maxErr + 1e-12;
    for (let i = 0; i < 100; i++) {
      const et = w0 + 2 + (w1 - w0 - 4) * rnd();
      const got = api.orient(o.body, et);
      assert.equal(got.status, 0);
      const want = await spice.pxform('J2000', o.frame, et);
      for (let k = 0; k < 9; k++) assert.ok(Math.abs(got.rot[k] - want[k]) <= bound, `${o.frame} element ${k}: off by ${Math.abs(got.rot[k] - want[k])}`);
    }
  }
});

test('site views match a computation from CSPICE states and rotations', { skip }, async () => {
  await setup();
  const rnd = prng(99);
  for (const site of report.sites) {
    const frame = config.orient.find((o) => o.body === site.body).frame;
    const s = site.position, rs = Math.hypot(...s), up = s.map((v) => v / rs);
    let north = [-up[2] * up[0], -up[2] * up[1], 1 - up[2] * up[2]];
    const rn = Math.hypot(...north); north = north.map((v) => v / rn);
    const east = [north[1] * up[2] - north[2] * up[1], north[2] * up[0] - north[0] * up[2], north[0] * up[1] - north[1] * up[0]];
    for (let i = 0; i < 60; i++) {
      const target = [10, 301, 399, 6].filter((b) => b !== site.body)[i % 3];
      const et = w0 + 2 + (w1 - w0 - 4) * rnd();
      const got = api.siteView(site.id, target, et, 0);
      assert.equal(got.status, 0);
      const r = (await truth(target, site.body, et, 0)).pos;
      const m = await spice.pxform('J2000', frame, et);
      const bf = [0, 1, 2].map((k) => m[3 * k] * r[0] + m[3 * k + 1] * r[1] + m[3 * k + 2] * r[2]);
      const d = bf.map((v, k) => v - s[k]), range = Math.hypot(...d);
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const el = Math.asin(dot(d, up) / range);
      let az = Math.atan2(dot(d, east), dot(d, north)); if (az < 0) az += 2 * Math.PI;
      const pb = SLACK * chainBound(posErr, target, site.body) + 1e-9;
      const ab = pb / range + 4 * report.orient.find((o) => o.body === site.body).maxErr + 1e-11;
      assert.ok(Math.abs(got.range - range) <= pb + 1e-12 * range, 'range');
      assert.ok(Math.abs(got.el - el) <= ab, `elevation off by ${Math.abs(got.el - el)}`);
      const daz = Math.abs(got.az - az);
      assert.ok(Math.min(daz, 2 * Math.PI - daz) <= ab / Math.max(Math.cos(el), 1e-6), `azimuth off by ${daz}`);
    }
  }
});

test('the host clock converts exactly as the TIME pieces say', { skip }, async () => {
  await setup();
  for (const [sec, usec] of [[0, 0], [100, 500000], [999999, 999999], [1000000, 0], [2500000, 250000]]) {
    const host = sec + usec * 1e-6;
    const piece = [...report.time].reverse().find((p) => p.base === 3 && p.hostStart <= host);
    assert.equal(api.host2et(3, sec, usec).et, piece.etStart + piece.rate * (host - piece.hostStart));
  }
  assert.equal(api.host2et(2, 5, 0).status, 1);
  assert.equal(api.fwtime(Uint8Array.from([0, 3, 0, 0, 0, 0, 100, 0, 7, 0xa1, 0x20])).et, api.host2et(3, 100, 500000).et);
});

test('a supplied state is used while fresh, extrapolated in a straight line, then dropped', { skip }, async () => {
  await setup();
  const t = s0 + 40000.5;
  const want = await truth(-82, 6, t, 0);
  const pb = SLACK * posErr.get(-82) + 1e-9;
  assert.equal(api.gap(t).status, 2, 'no supplied state yet');
  assert.equal(api.setState(-82, 6, t, [...want.pos, ...want.vel], 30), 0);
  const gap = api.gap(t);
  assert.equal(gap.status, 0);
  assert.ok(gap.dpos <= pb, `gap between supplied truth and the predicted fit is ${gap.dpos} km`);
  for (const dt of [0, 1, 5, 20]) {
    const got = api.state(-82, 6, t + dt, 0);
    assert.equal(got.source, 2);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(got.state[k] - (want.pos[k] + want.vel[k] * dt)) < 1e-9);
    // straight-line error against the true curved path: half the acceleration times dt squared
    const real = await truth(-82, 6, t + dt, 0);
    const a = dist((await truth(-82, 6, t + 1, 0)).vel, want.vel);
    assert.ok(dist(got.state, real.pos) <= 0.5 * a * dt * dt * 1.2 + 1e-6, `extrapolation error at ${dt} s`);
    const viaEarth = api.state(-82, 399, t + dt, 0);
    assert.equal(viaEarth.source, 2);
    const realEarth = await truth(-82, 399, t + dt, 0);
    assert.ok(dist(viaEarth.state, realEarth.pos) <= 0.5 * a * dt * dt * 1.2 + SLACK * chainBound(posErr, 6, 399) + 1e-6);
  }
  const stale = api.state(-82, 6, t + 31, 0);
  assert.equal(stale.status, 0);
  assert.equal(stale.source, 1, 'past max age the predicted segment answers');
  assert.equal(api.gap(t + 31).status, 3);
  assert.equal(api.setState(301, 399, t, [1, 2, 3, 4, 5, 6], 30), 6, 'only the spacecraft may be supplied');
  assert.equal(api.clearState(), 0);
  assert.equal(api.state(-82, 6, t, 0).source, 1);
});

test('requests outside the blob get status codes, not answers', { skip }, async () => {
  await setup();
  assert.equal(api.state(301, 399, w0 - 10, 0).status, 1);
  assert.equal(api.state(-82, 6, s1 + 10, 0).status, 1);
  assert.equal(api.state(5, 399, w0 + 10, 0).status, 2);
  assert.equal(api.state(301, 399, w0 + 10, 3).status, 6);
  assert.equal(api.orient(10, w0 + 10).status, 2);
  assert.equal(api.siteView(1, 10, w0 + 10, 1).status, 5);
  assert.equal(api.exports.lite_sub_point(301, 399, w0, 0, 0, 0), 6);
});

test('geodetic sites: up is the ellipsoid normal, as a header flag says, and matches CSPICE', { skip }, async () => {
  await setup();
  const { slice } = await import('../tools/slicer.mjs');
  const { load } = await import('./harness.mjs');
  const base = JSON.parse(readFileSync(resolve(root, 'test/blobs/sun-earth-moon.json'), 'utf8'));
  const sites = [
    { id: 1, body: 301, lonDeg: 23.47, latDeg: 0.67 },                      // the Moon is a sphere here: nothing changes
    { id: 2, body: 399, lonDeg: -116.89, latDeg: 35.43, altKm: 1.0 },       // a kilometer above the spheroid
    { id: 3, body: 399, lonDeg: 35.5, latDeg: 31.5, altKm: -0.43 },         // below it
    { id: 4, body: 399, lonDeg: 149.0, latDeg: -35.4 },                     // on it
    { id: 5, body: 399, lonDeg: 10.0, latDeg: 78.9, altKm: 0.02 },          // far north
  ];
  const cut = async (geodeticSites) => slice({ ...structuredClone(base), name: 'geodetic', sites, geodeticSites }, kernelDir, resolve(root, 'test/blobs'));
  const geo = await cut(true), plain = await cut(false);
  // the geodetic blob with its flag cleared: the same site positions, read the planetocentric way
  const cleared = Uint8Array.from(geo.blob); new DataView(cleared.buffer).setUint32(16, 1, true);
  const flagsOf = (b) => new DataView(b.buffer, b.byteOffset).getUint32(16, true);
  assert.equal(flagsOf(geo.blob), 3, 'rooted at the barycenter, and geodetic sites');
  assert.equal(flagsOf(plain.blob), 1);
  const lib = await load(geo.blob), old = await load(cleared, { skipCrc: true });
  assert.equal(lib.initStatus, 0);
  const radii = await spice.bodvrd('EARTH', 'RADII');
  const f = (radii[0] - radii[2]) / radii[0];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const [g0, g1] = geo.report.windowEt;
  const rnd = prng(2026);
  const gPos = new Map(geo.report.ephem.map((q) => [q.target, q.maxPosErr]));
  let worst = 0, shift = 0, n = 0;
  for (const cfg of sites) {
    const site = geo.report.sites.find((q) => q.id === cfg.id), p = site.position;
    let up;
    if (cfg.body === 399) {
      // The slicer's position is the one CSPICE reads back as these geodetic coordinates.
      const back = await spice.recgeo({ x: p[0], y: p[1], z: p[2] }, radii[0], f);
      assert.ok(Math.abs(back.lat - (cfg.latDeg * Math.PI) / 180) < 1e-12 && Math.abs(back.lon - (cfg.lonDeg * Math.PI) / 180) < 1e-12, 'recgeo gives the latitude and longitude back');
      assert.ok(Math.abs(back.alt - (cfg.altKm ?? 0)) < 1e-8, `recgeo gives the altitude back (${back.alt})`);
      up = [Math.cos(back.lat) * Math.cos(back.lon), Math.cos(back.lat) * Math.sin(back.lon), Math.sin(back.lat)];
    } else {
      const r = Math.hypot(...p); up = p.map((v) => v / r);
    }
    let north = [-up[2] * up[0], -up[2] * up[1], 1 - up[2] * up[2]];
    const rn = Math.hypot(...north); north = north.map((v) => v / rn);
    const east = [north[1] * up[2] - north[2] * up[1], north[2] * up[0] - north[0] * up[2], north[0] * up[1] - north[1] * up[0]];
    const frame = base.orient.find((o) => o.body === cfg.body).frame;
    const orientErr = geo.report.orient.find((o) => o.body === cfg.body).maxErr;
    // below the spheroid the library's normal is the gradient at the site: off by about f |h| / R
    const below = (cfg.altKm ?? 0) < 0 ? (2 * f * -cfg.altKm) / radii[0] : 0;
    for (let i = 0; i < 40; i++) {
      const target = [10, 301, 399].filter((b) => b !== cfg.body)[i % 2];
      const et = g0 + 2 + (g1 - g0 - 4) * rnd();
      const got = lib.siteView(cfg.id, target, et, 0);
      assert.equal(got.status, 0);
      const r = (await truth(target, cfg.body, et, 0)).pos;
      const m = await spice.pxform('J2000', frame, et);
      const bf = [0, 1, 2].map((k) => m[3 * k] * r[0] + m[3 * k + 1] * r[1] + m[3 * k + 2] * r[2]);
      const d = bf.map((v, k) => v - p[k]), range = Math.hypot(...d);
      const el = Math.asin(dot(d, up) / range);
      let az = Math.atan2(dot(d, east), dot(d, north)); if (az < 0) az += 2 * Math.PI;
      const chain = (a, b) => { let sum = 0; const par = new Map(base.bodies.map((q) => [q.id, q.parent])); for (const start of [a, b]) for (let id = start; par.get(id) != null; id = par.get(id)) sum += gPos.get(id); return sum; };
      const ab = (SLACK * chain(target, cfg.body) + 1e-9) / range + 4 * orientErr + 1e-11 + below;
      assert.ok(Math.abs(got.el - el) <= ab, `site ${cfg.id}: elevation off by ${Math.abs(got.el - el)}, bound ${ab}`);
      const daz = Math.abs(got.az - az);
      assert.ok(Math.min(daz, 2 * Math.PI - daz) <= ab / Math.max(Math.cos(el), 1e-3) + 1e-9, `site ${cfg.id}: azimuth off by ${daz}`);
      worst = Math.max(worst, Math.abs(got.el - el));
      // the same site position without the flag is answered the planetocentric way
      const was = old.siteView(cfg.id, target, et, 0);
      if (cfg.body === 399) shift = Math.max(shift, Math.abs(was.el - got.el));
      else assert.ok(Math.abs(was.el - got.el) < 1e-12, 'a sphere has one up');
      n++;
    }
  }
  assert.ok(shift > 1e-3 && shift < 4e-3, `planetocentric and geodetic elevations differ by up to ${shift} rad on the Earth (about the flattening)`);
  console.log(`  ${n} views from ${sites.length} geodetic sites; worst elevation error ${worst.toExponential(2)} rad; the planetocentric answer would differ by up to ${(shift * 180 / Math.PI).toFixed(3)} degrees`);
  // A geodetic site on a body with no radii, or with unequal equatorial radii, is refused by the slicer.
  const bad = structuredClone(base); bad.geodeticSites = true; bad.bodies.find((b) => b.id === 399).radiiFrom = undefined;
  await assert.rejects(slice(bad, kernelDir, resolve(root, 'test/blobs')), /geodetic sites need radii/);
  // A header flag bit this library does not know is still refused.
  const unknown = Uint8Array.from(geo.blob); new DataView(unknown.buffer).setUint32(16, 0x80000003, true);
  assert.equal((await load(unknown, { skipCrc: true })).initStatus, 4);
});
