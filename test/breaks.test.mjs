// The break finder (tools/find-breaks.mjs) on trajectories with known events.
// No kernels: the engine is a stand-in that answers from a formula, so the
// time and size of every event are known exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBreaks, BREAK_DEFAULTS } from '../tools/find-breaks.mjs';

const GM = 398600.4418, A = 7000, N = Math.sqrt(GM / A ** 3);
const T0 = 1.5e8, T1 = T0 + 86400;

// A circular orbit plus a displacement c(t) = [position, velocity] along x.
const engine = (c = () => [0, 0]) => ({
  calls: 0,
  async spkezr(_target, t) {
    this.calls++;
    // The angle is taken from the difference in time, which is exact, as an SPK
    // reader takes its polynomial argument; N * t would round at 1.5e8 s.
    const [dp, dv] = c(t), th = N * (t - T0);
    return { position: { x: A * Math.cos(th) + dp, y: A * Math.sin(th), z: 0 }, velocity: { x: -A * N * Math.sin(th) + dv, y: A * N * Math.cos(th), z: 0 } };
  },
  async et2utc(t) { return `et ${t}`; },
});

test('a smooth orbit has no breaks', async () => {
  assert.deepEqual(await findBreaks(engine(), -1, 399, [T0, T1]), []);
});

test('a seam in position is found at the exact instant it happens', async () => {
  const at = T0 + 12345.678901;
  for (const meters of [0.5, 5, 90]) {
    const found = await findBreaks(engine((t) => (t >= at ? [meters * 1e-3, 0] : [0, 0])), -1, 399, [T0, T1]);
    assert.equal(found.length, 1, `${meters} m`);
    assert.equal(found[0].kind, 'step');
    assert.equal(found[0].et, at, 'the first instant on the far side of the seam');
  }
});

test('a step in velocity is found at the exact instant it happens', async () => {
  const at = T0 + 40000.25;
  for (const mmPerS of [5, 50]) {
    const dv = mmPerS * 1e-6;
    const found = await findBreaks(engine((t) => (t >= at ? [dv * (t - at), dv] : [0, 0])), -1, 399, [T0, T1]);
    assert.equal(found.length, 1, `${mmPerS} mm/s`);
    assert.equal(found[0].kind, 'step');
    assert.equal(found[0].et, at);
  }
});

const burnOf = (start, length, acc) => (t) => (t < start ? [0, 0] : t < start + length ? [0.5 * acc * (t - start) ** 2, acc * (t - start)] : [acc * length * (t - start - length / 2), acc * length]);

test('a short burn gets a break before it, after it, and often enough inside it', async () => {
  // 4 cm/s^2 for 100 s, about what a small chemical thruster set gives.
  const start = T0 + 30003, length = 100;
  const found = await findBreaks(engine(burnOf(start, length, 4e-5)), -1, 399, [T0, T1], { burnSeconds: 60 });
  const h = BREAK_DEFAULTS.stepSeconds;
  assert.ok(found.length >= 3);
  assert.deepEqual(found.map((f) => f.kind), ['start', ...Array(found.length - 2).fill('during'), 'end']);
  assert.ok(found[0].et <= start && start - found[0].et <= 2 * h, 'the first break is just before the burn');
  assert.ok(found.at(-1).et >= start + length && found.at(-1).et - (start + length) <= 2 * h, 'the last is just after it');
  for (let i = 1; i < found.length; i++) assert.ok(found[i].et > found[i - 1].et && found[i].et - found[i - 1].et <= 60, 'no record under thrust longer than burnSeconds');
});

test('a long steady burn shows only where the thrust turns on and off', async () => {
  // Under constant thrust the trajectory is smooth, so the middle of a burn
  // longer than mergeSeconds is not flagged: it becomes a stretch between two
  // steps, cut at the body's own record length.
  const start = T0 + 30003, length = 400;
  const found = await findBreaks(engine(burnOf(start, length, 4e-5)), -1, 399, [T0, T1]);
  assert.deepEqual(found.map((f) => f.kind), ['step', 'step']);
  const h = BREAK_DEFAULTS.stepSeconds;
  assert.ok(Math.abs(found[0].et - start) <= h && Math.abs(found[1].et - (start + length)) <= h, `off by ${found[0].et - start} s and ${found[1].et - (start + length)} s`);
  // And thrust too gentle for the thresholds is not seen at all.
  assert.deepEqual(await findBreaks(engine(burnOf(start, length, 2e-7)), -1, 399, [T0, T1]), []);
});

test('two events are two sets of breaks, in time order, and thresholds can be raised past an event', async () => {
  const seam = T0 + 20000.5, kick = T0 + 60000.125;
  const both = (t) => [(t >= seam ? 0.002 : 0) + (t >= kick ? 1e-5 * (t - kick) : 0), t >= kick ? 1e-5 : 0];
  const found = await findBreaks(engine(both), -1, 399, [T0, T1]);
  assert.deepEqual(found.map((f) => f.et), [seam, kick]);
  assert.ok(Math.abs(found[0].positionKm - 0.001) < 5e-5, 'the report carries what was seen: half the step, at the sample beside it');
  const coarse = await findBreaks(engine(both), -1, 399, [T0, T1], { positionKm: 0.01, velocityKmS: 1e-6 });
  assert.deepEqual(coarse.map((f) => f.et), [kick], 'a 2 m seam is under a 10 m threshold');
});

test('bad options are refused', async () => {
  await assert.rejects(findBreaks(engine(), -1, 399, [T0, T1], { step: 5 }), /unknown option "step"/);
  await assert.rejects(findBreaks(engine(), -1, 399, [T0, T1], { stepSeconds: 0 }), /"stepSeconds" must be a positive number/);
});
