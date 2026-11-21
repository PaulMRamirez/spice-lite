// The compact orbit segment, EPHEM kind 4, on the synthetic orbiter blob: the
// same tiers the other blobs get. Exactness against committed vectors in both
// builds; accuracy against CSPICE within the bounds the blob declares; and
// robustness over corrupted blobs and damaged records.
//
// The orbiters are synthetic (tools/synth-orbiter.mjs): a point mass plus J2,
// integrated and handed to CSPICE as an SPK type 13 segment, regenerated here
// from the blob's configuration. No real orbiter kernel is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { load, runAll, prng, root } from './harness.mjs';
import { integrate, energy, furnishSynthetic } from '../tools/synth-orbiter.mjs';
import { orbitEval, keplerOffset, unpackRecord, RECORD_BYTES, E_MAX } from '../tools/orbit-model.mjs';

const name = 'orbiter';
const blobPath = resolve(root, `test/blobs/${name}.slb`);
const blob = new Uint8Array(readFileSync(blobPath));
const config = JSON.parse(readFileSync(resolve(root, `test/blobs/${name}.json`), 'utf8'));
const report = JSON.parse(readFileSync(resolve(root, `test/blobs/${name}.report.json`), 'utf8'));
const queries = readFileSync(resolve(root, `test/vectors/${name}.queries`), 'utf8');
const expected = readFileSync(resolve(root, `test/vectors/${name}.expected`), 'utf8');
const kernelDir = process.env.SPICE_LITE_KERNELS;
const have = kernelDir && config.kernels.every((k) => existsSync(resolve(kernelDir, k)));
const skip = !have && 'SPICE_LITE_KERNELS is not set or lacks the kernels';
const san = resolve(root, 'build/driver-san');
const scan = resolve(root, 'build/kepler-scan');

const [w0, w1] = report.windowEt;
const orbiters = report.ephem.filter((s) => s.kind === 4);
const SLACK = 1.5; // the slicer's error grid and this test's times differ

// Where a body's EPHEM entry and its records sit in the blob.
function segmentOf(bytes, target) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  for (let i = 0; i < v.getUint16(20, true); i++) {
    const d = 64 + 16 * i;
    if (v.getUint16(d, true) !== 3) continue;
    for (let k = 0; k < v.getUint32(d + 12, true); k++) {
      const e = v.getUint32(d + 4, true) + 48 * k;
      if (v.getInt32(e, true) === target) return { entry: e, data: v.getUint32(e + 32, true), count: v.getUint32(e + 12, true), view: v };
    }
  }
  throw new Error(`no segment for ${target}`);
}

test('the blob holds three kind 4 segments of 160-byte records', () => {
  assert.equal(RECORD_BYTES, 160);
  assert.equal(orbiters.length, 3);
  for (const s of orbiters) {
    assert.equal(s.bytes, s.recordCount * RECORD_BYTES);
    assert.equal(segmentOf(blob, s.target).view.getUint8(segmentOf(blob, s.target).entry + 8), 4);
  }
});

test('the WebAssembly build reproduces the committed orbiter vectors bit for bit', async () => {
  assert.equal(runAll(await load(blob), queries), expected);
});

test('the native build reproduces the same bits', { skip: !existsSync(resolve(root, 'build/driver')) && 'build/driver not built' }, () => {
  const out = execFileSync(resolve(root, 'build/driver'), ['run', blobPath], { input: queries, encoding: 'utf8' });
  assert.equal(out, expected);
});

test('the synthetic trajectories conserve energy and are reproducible', () => {
  for (const spec of config.synthetic) {
    const { epochs, states, field } = integrate(spec, 0, 86400);
    const e0 = energy(states.subarray(0, 6), field), e1 = energy(states.subarray(6 * (epochs.length - 1)), field);
    assert.ok(Math.abs((e1 - e0) / e0) < 1e-11, `${spec.name}: relative energy drift ${(e1 - e0) / e0}`);
    const again = integrate(spec, 0, 86400);
    assert.deepEqual(again.states, states);
  }
});

test('the ground mirror of the evaluation agrees with the flight library', async () => {
  const api = await load(blob);
  const rnd = prng(8);
  let worst = 0;
  for (const s of orbiters) {
    const seg = segmentOf(blob, s.target);
    for (let i = 0; i < 300; i++) {
      const et = w0 + (w1 - w0) * rnd();
      const k = Math.min(s.recordCount - 1, Math.floor((et - s.tStart) / s.interval));
      const want = orbitEval(unpackRecord(seg.view, seg.data + k * RECORD_BYTES), et - (s.tStart + (k + 0.5) * s.interval));
      const got = api.state(s.target, s.center, et, 0);
      assert.equal(got.status, 0);
      const d = Math.hypot(got.state[0] - want[0], got.state[1] - want[1], got.state[2] - want[2]);
      const dv = Math.hypot(got.state[3] - want[3], got.state[4] - want[4], got.state[5] - want[5]);
      assert.ok(d < 1e-7 && dv < 1e-10, `${s.target}: mirror differs by ${d} km, ${dv} km/s`);
      worst = Math.max(worst, d);
    }
  }
  console.log(`  900 states; the mirror and the library differ by at most ${worst.toExponential(1)} km`);
});

test('the Kepler solve as compiled converges in at most three steps up to the eccentricity limit', { skip: !existsSync(scan) && 'build/kepler-scan not built' }, () => {
  // 181 eccentricities from 0 to 0.9, 8,000 mean anomalies each (half of them packed near periapsis)
  const r = JSON.parse(execFileSync(scan, ['180', '4000'], { encoding: 'utf8' }));
  assert.equal(r.topEccentricity, E_MAX);
  assert.equal(r.failures, 0);
  assert.ok(r.mostSteps <= 3, `${r.mostSteps} steps`);
  assert.ok(r.mostSteps < r.cap);
  assert.ok(r.worstError < 2e-15, `sine or cosine off by ${r.worstError}`);
  console.log(`  ${r.cases.toLocaleString('en-US')} solves: at most ${r.mostSteps} steps (cap ${r.cap}); sine and cosine within ${r.worstError.toExponential(1)} of a long double solve`);
});

test('the WebAssembly build answers at every eccentricity up to the limit and agrees with the mirror', async () => {
  const s = orbiters.find((o) => o.target === -9001);
  const copy = blob.slice();
  const api = await load(copy, { skipCrc: true });
  const seg = segmentOf(copy, s.target);
  const base = (api.exports.__heap_base.value + 7) & ~7;
  const guest = () => new DataView(api.exports.memory.buffer, base, copy.length);
  let most = 0, worst = 0, n = 0;
  for (let ie = 0; ie <= 90; ie++) {
    const e = (E_MAX * ie) / 90, w = 0.7 * ie;
    const v = guest();
    v.setFloat64(seg.data + 8, e * Math.cos(w), true);
    v.setFloat64(seg.data + 16, e * Math.sin(w), true);
    v.setFloat32(seg.data + 60, 0, true);
    v.setFloat32(seg.data + 64, 0, true);
    const rec = unpackRecord(guest(), seg.data);
    for (let i = 0; i < 300; i++) {
      // about two revolutions of the record, in steps that do not repeat the phase
      const et = s.tStart + 0.5 * s.interval + (i - 150) * 37.7;
      const tau = et - (s.tStart + 0.5 * s.interval);
      const got = api.state(-9001, 399, et, 0);
      assert.equal(got.status, 0, `e = ${e}, tau = ${tau}`);
      const want = orbitEval(rec, tau);
      const d = Math.hypot(got.state[0] - want[0], got.state[1] - want[1], got.state[2] - want[2]);
      assert.ok(d < 1e-7, `e = ${e}: mirror differs by ${d} km`);
      worst = Math.max(worst, d); n++;
      const lam = rec[5] + (rec[6] + rec[12] * tau) * tau;
      most = Math.max(most, keplerOffset(rec[1] * Math.sin(lam) - rec[2] * Math.cos(lam), rec[1] * Math.cos(lam) + rec[2] * Math.sin(lam)).steps);
    }
  }
  assert.ok(most <= 3, `${most} Kepler steps in the mirror`);
  console.log(`  ${n.toLocaleString('en-US')} states at eccentricities 0 to ${E_MAX}: all answered; at most ${most} Kepler steps; the mirror and the library differ by at most ${worst.toExponential(1)} km`);
});

test('kind 4 states match CSPICE on the synthetic kernels within the declared bounds', { skip }, async () => {
  const { createSpiceEngine } = await import('cspice-wasm');
  const spice = await createSpiceEngine();
  for (const k of config.kernels) await spice.furnsh(k, new Uint8Array(readFileSync(resolve(kernelDir, k))));
  for (const spec of config.synthetic) {
    const made = await furnishSynthetic(spice, spec, report.windowEt);
    assert.equal(made.sha256, report.kernels.find((k) => k.name === spec.name).sha256, `${spec.name} regenerates to the states the slicer fitted`);
  }
  const api = await load(blob);
  assert.equal(api.initStatus, 0);
  const parentOf = new Map(config.bodies.map((b) => [b.id, b.parent]));
  const posErr = new Map(report.ephem.map((s) => [s.target, s.maxPosErr]));
  const velErr = new Map(report.ephem.map((s) => [s.target, s.maxVelErr]));
  const chain = (errs, a, b) => { let sum = 0; for (const start of [a, b]) for (let id = start; parentOf.get(id) != null; id = parentOf.get(id)) sum += errs.get(id); return sum; };
  const rnd = prng(515);
  const ids = [3, 301, 399, ...orbiters.map((s) => s.target)];
  const check = async (t, o, et, tally) => {
    const got = api.state(t, o, et, 0);
    assert.equal(got.status, 0, `state ${t} ${o} at ${et}`);
    const want = await spice.spkezr(String(t), et, 'J2000', 'NONE', String(o));
    const range = Math.hypot(want.position.x, want.position.y, want.position.z);
    const speed = Math.hypot(want.velocity.x, want.velocity.y, want.velocity.z);
    const dp = Math.hypot(got.state[0] - want.position.x, got.state[1] - want.position.y, got.state[2] - want.position.z);
    const dv = Math.hypot(got.state[3] - want.velocity.x, got.state[4] - want.velocity.y, got.state[5] - want.velocity.z);
    const pb = SLACK * chain(posErr, t, o) + 1e-12 * range + 1e-9;
    const vb = SLACK * chain(velErr, t, o) + 1e-13 * speed + 1e-12;
    assert.ok(dp <= pb, `position ${t} wrt ${o}: off by ${dp} km, bound ${pb}`);
    assert.ok(dv <= vb, `velocity ${t} wrt ${o}: off by ${dv} km/s, bound ${vb}`);
    assert.equal(got.source, 1, 'a path through an orbiter is predicted');
    tally.pos = Math.max(tally.pos, dp / pb); tally.vel = Math.max(tally.vel, dv / vb); tally.n++;
  };
  for (const s of orbiters) {
    const tally = { pos: 0, vel: 0, n: 0 };
    for (let i = 0; i < 400; i++) await check(s.target, s.center, w0 + (w1 - w0) * rnd(), tally);
    // both sides of every record boundary, where neighboring fits meet
    for (let k = 0; k <= s.recordCount; k++) {
      const t = s.tStart + k * s.interval;
      if (k > 0) await check(s.target, s.center, t - 1e-3, tally);
      if (k < s.recordCount) await check(s.target, s.center, t + 1e-3, tally);
    }
    console.log(`  ${s.target} wrt ${s.center}: ${tally.n} states; declared ${(1000 * s.maxPosErr).toFixed(1)} m and ${(1e6 * s.maxVelErr).toFixed(1)} mm/s; worst error is ${(100 * tally.pos).toFixed(1)}% of the position bound and ${(100 * tally.vel).toFixed(1)}% of the velocity bound`);
  }
  const tally = { pos: 0, vel: 0, n: 0 };
  for (let i = 0; i < 300; i++) {
    const t = orbiters[i % 3].target, o = ids[Math.floor(rnd() * ids.length)];
    if (t === o) continue;
    await check(i % 2 ? t : o, i % 2 ? o : t, w0 + (w1 - w0) * rnd(), tally);
  }
  console.log(`  ${tally.n} states across the tree; worst position error is ${(100 * tally.pos).toFixed(1)}% of its bound`);
});

test('breaks: a body cut into one segment per stretch, with no record across a break and no gap at one', { skip }, async () => {
  const { slice } = await import('../tools/slicer.mjs');
  const { createSpiceEngine } = await import('cspice-wasm');
  // The low Earth orbiter with two breaks, one of them at no round time: three
  // segments, whose record lengths are the nearest to a day that divide each stretch.
  const breaks = ['2004-06-28T07:13:21.5', '2004-07-01T00:00:00'];
  const cfg = structuredClone(config);
  cfg.name = 'orbiter-breaks';
  cfg.bodies.find((b) => b.id === -9001).breaks = breaks;
  const cut = await slice(cfg, kernelDir, resolve(root, 'test/blobs'));
  const segs = cut.report.ephem.filter((s) => s.target === -9001);
  assert.deepEqual(segs.map((s) => s.recordCount), [1, 3, 2]);
  const spice = await createSpiceEngine();
  for (const k of config.kernels) await spice.furnsh(k, new Uint8Array(readFileSync(resolve(kernelDir, k))));
  await furnishSynthetic(spice, config.synthetic.find((q) => q.body === -9001), report.windowEt);
  const edges = [w0, await spice.str2et(breaks[0]), await spice.str2et(breaks[1]), w1];
  segs.forEach((s, i) => {
    assert.equal(s.tStart, edges[i], 'each segment starts at a break');
    const end = s.tStart + s.recordCount * s.interval;
    assert.ok(end >= edges[i + 1] && end - edges[i + 1] < 1e-6, 'and ends at the next, never short of it');
  });
  assert.deepEqual(cut.report.coverageEt, [w0, w1], 'the blob covers the whole window');
  // The other bodies' segments are untouched by one body's breaks.
  const rest = (r) => r.ephem.filter((s) => s.target !== -9001).map((s) => [s.target, s.recordCount, s.interval, s.maxPosErr]);
  assert.deepEqual(rest(cut.report), rest(report));
  const api = await load(cut.blob);
  assert.equal(api.initStatus, 0);
  // Every instant is answered, the breaks themselves and the nearest times to
  // either side included, each within the bound of the segment that answers.
  const bound = Math.max(...segs.map((s) => s.maxPosErr)), vbound = Math.max(...segs.map((s) => s.maxVelErr));
  const times = [];
  for (const e of edges.slice(1, 3)) for (const d of [-1, -1e-3, -6e-8, 0, 6e-8, 1e-3, 1]) times.push(e + d);
  const rnd = prng(88);
  for (let i = 0; i < 300; i++) times.push(w0 + rnd() * (w1 - w0));
  let worst = 0;
  for (const t of times) {
    const got = api.state(-9001, 399, t, 0);
    assert.equal(got.status, 0, `no answer ${t - edges[1]} s from the first break`);
    const want = await spice.spkezr('-9001', t, 'J2000', 'NONE', '399');
    const dp = Math.hypot(got.state[0] - want.position.x, got.state[1] - want.position.y, got.state[2] - want.position.z);
    const dv = Math.hypot(got.state[3] - want.velocity.x, got.state[4] - want.velocity.y, got.state[5] - want.velocity.z);
    assert.ok(dp <= SLACK * bound && dv <= SLACK * vbound, `off by ${dp} km and ${dv} km/s at ${t}`);
    worst = Math.max(worst, dp / bound);
  }
  console.log(`  ${segs.length} segments of ${segs.map((s) => s.recordCount).join(', ')} records; ${times.length} states, worst ${(100 * worst).toFixed(1)}% of the position bound`);
  // Breaks outside the window, or repeated, are refused.
  for (const bad of [['2004-06-20T00:00:00'], [breaks[0], breaks[0]], [config.window.start]]) {
    const c = structuredClone(config);
    c.bodies.find((b) => b.id === -9001).breaks = bad;
    await assert.rejects(slice(c, kernelDir, resolve(root, 'test/blobs')), /every break must be a distinct time inside/);
  }
});

test('200,000 corrupted orbiter blobs under the sanitizers: no faults', { skip: !existsSync(san) && 'build/driver-san not built' }, () => {
  const out = execFileSync(san, ['fuzz', blobPath, '200000', '20261121'], { encoding: 'utf8' });
  assert.match(out, /no faults/);
  console.log('  ' + out.trim());
});

test('a record that is not an ellipse the model accepts answers unsupported', async () => {
  const s = orbiters.find((o) => o.target === -9001);
  const at = (k) => s.tStart + (k + 0.3) * s.interval;
  const damaged = async (edit) => {
    const copy = blob.slice();
    const seg = segmentOf(copy, s.target);
    edit(seg.view, seg.data, seg.entry);
    return load(copy, { skipCrc: true });
  };
  const cases = [
    ['eccentricity over 0.9', (v, d) => v.setFloat64(d + 8, 0.95, true)],
    ['a hyperbola in the eccentricity vector', (v, d) => { v.setFloat64(d + 8, 1.2, true); v.setFloat64(d + 16, -0.7, true); }],
    ['zero semi-major axis', (v, d) => v.setFloat64(d, 0, true)],
    ['negative semi-major axis', (v, d) => v.setFloat64(d, -7000, true)],
    ['infinite semi-major axis', (v, d) => v.setFloat64(d, Infinity, true)],
    ['not-a-number eccentricity', (v, d) => v.setFloat64(d + 16, NaN, true)],
    ['an angle beyond the trigonometry limit', (v, d) => v.setFloat64(d + 40, 3e6, true)],
    ['not-a-number node', (v, d) => v.setFloat64(d + 32, NaN, true)],
    ['an eccentricity rate that leaves the ellipse', (v, d) => v.setFloat32(d + 60, 1e-4, true)],
    ['an infinite harmonic', (v, d) => v.setFloat32(d + 84, Infinity, true)],
    ['a not-a-number constant across the track', (v, d) => v.setFloat32(d + 156, NaN, true)],
    ['an infinite quadratic term of the eccentricity vector', (v, d) => v.setFloat32(d + 80, Infinity, true)],
  ];
  for (const [label, edit] of cases) {
    const api = await damaged(edit);
    assert.equal(api.initStatus, 0, label);
    assert.equal(api.state(-9001, 399, at(0), 0).status, 5, label);
    assert.equal(api.state(301, -9001, at(0), 0).status, 5, label + ', as observer');
    assert.equal(api.state(-9001, 399, at(1), 0).status, 0, label + ': the next record still answers');
  }
  // structural damage is refused at lite_init
  assert.equal((await damaged((v, d, e) => v.setUint8(e + 10, 1))).initStatus, 4, 'a nonzero degree on a kind 4 segment');
  assert.equal((await damaged((v, d, e) => v.setUint32(e + 12, 0, true))).initStatus, 4, 'no records');
  assert.equal((await damaged((v, d, e) => v.setUint32(e + 12, 70000, true))).initStatus, 4, 'records past the end of the blob');
  assert.equal((await damaged((v, d, e) => v.setUint32(e + 32, d + 4, true))).initStatus, 4, 'misaligned records');
  assert.equal((await damaged((v, d, e) => v.setFloat64(e + 24, 0, true))).initStatus, 4, 'zero interval');
});

test('random bits in a kind 4 record never trap the WebAssembly build', async () => {
  const rnd = prng(77);
  const s = orbiters.find((o) => o.target === -9003);
  const seg = segmentOf(blob, s.target);
  const copy = blob.slice();
  const api = await load(copy, { skipCrc: true });
  const base = (api.exports.__heap_base.value + 7) & ~7;
  const mem = () => new Uint8Array(api.exports.memory.buffer);
  const counts = new Map();
  for (let i = 0; i < 20000; i++) {
    // overwrite the first record in guest memory: all random, or a valid record with a few fields hit
    const rec = blob.slice(seg.data, seg.data + RECORD_BYTES);
    if (i % 2) for (let j = 0; j < RECORD_BYTES; j++) rec[j] = Math.floor(rnd() * 256);
    else for (let e = 0; e < 3; e++) rec[Math.floor(rnd() * RECORD_BYTES)] = Math.floor(rnd() * 256);
    mem().set(rec, base + seg.data);
    const st = api.state(-9003, 399, s.tStart + s.interval * rnd(), 0).status;
    assert.ok(st === 0 || st === 5, `status ${st}`);
    counts.set(st, (counts.get(st) ?? 0) + 1);
  }
  console.log(`  20,000 damaged records: ${counts.get(0) ?? 0} answered, ${counts.get(5) ?? 0} unsupported, no traps`);
});

test('outside a kind 4 segment the answer is out of coverage', async () => {
  const api = await load(blob);
  for (const s of orbiters) {
    assert.equal(api.state(s.target, s.center, s.tStart - 0.5, 0).status, 1);
    assert.equal(api.state(s.target, s.center, s.tStart + s.recordCount * s.interval + 0.5, 0).status, 1);
    assert.equal(api.state(s.target, s.center, s.tStart, 0).status, 0);
    assert.equal(api.state(s.target, s.center, s.tStart + s.recordCount * s.interval, 0).status, 0);
  }
});
